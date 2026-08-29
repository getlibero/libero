import OpenAI from "openai";
import type { CreateEmbeddingResponse } from "openai/resources/embeddings";
import { reportedCost } from "../completion/reported-cost.js";
import { servedModel } from "../completion/served-model.js";
import {
  EmbeddingError,
  type EmbeddingClient,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingUsage
} from "./types.js";

const PROVIDER = "openai-compatible";

/**
 * Endpoints that speak the OpenAI **embeddings** wire format.
 *
 * `OPENAI_COMPATIBLE_BASE_URLS` in ../completion/openai.ts is the completions
 * list and this is deliberately not the same constant, because the two sets are
 * not the same set. Voyage embeds and does not complete; Groq completes and
 * does not embed. One constant serving both would be a list that is wrong for
 * whichever half you read it as.
 *
 * Anything not listed works too, including a self-hosted gateway — the base URL
 * is the whole configuration.
 */
export const OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  voyage: "https://api.voyageai.com/v1",
  together: "https://api.together.xyz/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  ollama: "http://localhost:11434/v1"
} as const;

export interface OpenAICompatibleEmbeddingOptions {
  apiKey: string;
  /** Defaults to OpenAI itself. See OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS. */
  baseUrl?: string;
  /** Injected transport. Tests pass a stub; nothing here reaches the network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Embeddings against any OpenAI-compatible endpoint.
 *
 * **The first embedding adapter, and the argument for it being this one rather
 * than a native one is that there is no incumbent to be native to.** Anthropic
 * publishes no embeddings endpoint, so unlike the completion layer — where the
 * Anthropic adapter exists because that is what the deployment completes
 * against — there is no vendor whose own dialect the agent must already speak.
 * What is left is coverage per adapter, and `/v1/embeddings` is the dialect
 * OpenAI, Voyage, Together, Gemini's compatibility endpoint, Ollama and a
 * LiteLLM sidecar all implement. One adapter reaches every one of them by base
 * URL, and BYO-model is the product's stance.
 *
 * A native Voyage or Cohere adapter is a separate argument for a later issue,
 * and it is the same argument Azure, Bedrock and Gemini's native API have on
 * the completion side: they differ in auth or wire format, not just endpoint.
 */
export function createOpenAICompatibleEmbeddingClient(
  options: OpenAICompatibleEmbeddingOptions
): EmbeddingClient {
  let client: OpenAI | undefined;

  const openai = (): OpenAI => {
    client ??= new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });
    return client;
  };

  return {
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      // An empty batch is answered without a request. Every endpoint rejects an
      // empty `input`, and a caller with nothing to embed has asked for nothing
      // rather than made a mistake — the same shape as `search` answering no
      // rows for a query with no terms.
      if (request.texts.length === 0) return { vectors: [] };

      let response: CreateEmbeddingResponse;
      // The headers as well as the body, for ../completion/openai.ts's reason:
      // a router reports what the call cost in one (#239), and the parsed body
      // has no way back to the response it came from.
      let headers: Headers | undefined;
      try {
        const received = await openai().embeddings.create(
          {
            model: request.model,
            input: request.texts,
            // float, explicitly. The API's other encoding is base64, several
            // compatible servers default to it, and a silent base64 body would
            // arrive as strings where this adapter expects numbers.
            encoding_format: "float"
          },
          request.signal !== undefined ? { signal: request.signal } : {}
        ).withResponse();
        response = received.data;
        headers = received.response.headers;
      } catch (cause) {
        if (cause instanceof EmbeddingError) throw cause;
        // The message says nothing about what was being embedded. See
        // `EmbeddingError`: the input here is a channel's conversation.
        throw new EmbeddingError("embedding request failed", PROVIDER, { cause });
      }

      return fromOpenAIEmbeddings(response, request.texts.length, headers);
    }
  };
}

function fromOpenAIEmbeddings(
  response: CreateEmbeddingResponse,
  asked: number,
  headers: Headers | undefined
): EmbeddingResponse {
  // **Sorted by index rather than trusted in arrival order.** The API documents
  // an `index` on every item precisely because the order is not guaranteed, and
  // a vector matched to the wrong text is the failure with no symptom: nothing
  // errors, recall just quietly answers with the wrong thing.
  const items = [...response.data].sort((left, right) => left.index - right.index);

  // A short batch is a bug in the endpoint, and it has to be loud. Silently
  // returning fewer vectors than texts would leave the caller pairing them up
  // positionally against a list that no longer lines up.
  if (items.length !== asked) {
    throw new EmbeddingError(
      `embedding response held ${items.length} vectors for ${asked} texts`,
      PROVIDER
    );
  }

  return {
    vectors: items.map((item, position) => {
      if (!Array.isArray(item.embedding)) {
        // Reached when a server ignored `encoding_format` and answered base64.
        // Named, because the alternative is `Float32Array.from` on a string
        // producing a vector of NaN that stores and never matches anything.
        throw new EmbeddingError(
          `embedding at index ${position} was not an array of numbers`,
          PROVIDER
        );
      }
      return Float32Array.from(item.embedding);
    }),
    ...servedModel(response.model),
    ...toUsage(response),
    ...reportedCost(headers)
  };
}

/**
 * `{ usage }` to spread, or nothing.
 *
 * A fragment for `servedModel`'s reason — `exactOptionalPropertyTypes` makes an
 * explicit `undefined` fail an optional property — and absent rather than zero
 * for `TokenUsage`'s reason: a provider that reports nothing has not told us the
 * call was free.
 */
function toUsage(response: CreateEmbeddingResponse): { usage?: EmbeddingUsage } {
  const prompt = response.usage?.prompt_tokens;
  if (typeof prompt !== "number" || !Number.isFinite(prompt)) return {};
  return { usage: { inputTokens: prompt } };
}
