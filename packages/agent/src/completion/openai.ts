import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  CompletionError,
  type CompletionClient,
  type CompletionMessage,
  type CompletionRequest,
  type CompletionResponse,
  type StopReason,
  type ToolCall,
  type TokenUsage
} from "./types.js";
import { reportedCost } from "./reported-cost.js";
import { servedModel } from "./served-model.js";

const PROVIDER = "openai-compatible";

/**
 * Endpoints that speak the OpenAI chat-completions wire format. Pointing the
 * adapter at one of these is the whole configuration — there is no per-vendor
 * code. Anything not listed works too, including a self-hosted gateway.
 */
export const OPENAI_COMPATIBLE_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  baseten: "https://inference.baseten.co/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  ollama: "http://localhost:11434/v1"
} as const;

export interface OpenAICompatibleCompletionOptions {
  apiKey: string;
  /** Defaults to OpenAI itself. See OPENAI_COMPATIBLE_BASE_URLS. */
  baseUrl?: string;
  /** Injected transport. Tests pass a stub; nothing here reaches the network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Completions against any OpenAI-compatible endpoint. Uses chat-completions
 * rather than the Responses API because chat-completions is what the compatible
 * endpoints actually implement.
 */
export function createOpenAICompatibleCompletionClient(
  options: OpenAICompatibleCompletionOptions
): CompletionClient {
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
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      let completion: ChatCompletion;
      // The headers, not just the body: a router reports what the call cost in
      // one (#239), and `create()` alone resolves to the parsed body with no way
      // back to the response it came out of. `withResponse()` is the SDK's own
      // seam for that and costs nothing when nothing sends the header.
      let headers: Headers | undefined;
      try {
        const received = await openai().chat.completions.create(
          {
            model: request.model,
            // max_tokens, not max_completion_tokens: the compatible endpoints
            // implement the older field, and this adapter exists for them.
            max_tokens: request.maxTokens,
            messages: toOpenAIMessages(request.system, request.messages),
            ...(request.tools !== undefined
              ? {
                  tools: request.tools.map((tool) => ({
                    type: "function" as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema
                    }
                  }))
                }
              : {})
          },
          request.signal !== undefined ? { signal: request.signal } : {}
        ).withResponse();
        completion = received.data;
        headers = received.response.headers;
      } catch (cause) {
        if (cause instanceof CompletionError) throw cause;
        throw new CompletionError("completion request failed", PROVIDER, { cause });
      }

      return fromOpenAICompletion(completion, headers);
    }
  };
}

function toOpenAIMessages(
  system: string | undefined,
  messages: CompletionMessage[]
): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [];
  if (system !== undefined) converted.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "tool") {
      // This wire format has no error flag on a tool result; the loop marks
      // failures in the content it passes down.
      converted.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      });
      continue;
    }

    converted.push({
      role: "assistant",
      content: message.content,
      ...(message.toolCalls !== undefined && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }))
          }
        : {})
    });
  }

  return converted;
}

function fromOpenAICompletion(
  completion: ChatCompletion,
  headers: Headers | undefined
): CompletionResponse {
  const choice = completion.choices[0];
  if (choice === undefined) {
    throw new CompletionError("response contained no choices", PROVIDER);
  }

  const toolCalls: ToolCall[] = [];
  for (const call of choice.message.tool_calls ?? []) {
    // Custom (non-function) tool calls are not something the agent requests.
    if (call.type !== "function") continue;
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments, call.function.name)
    });
  }

  return {
    text: choice.message.content ?? "",
    toolCalls,
    stopReason: toStopReason(choice.finish_reason),
    usage: toUsage(completion.usage),
    // The adapter this matters most for: a LiteLLM sidecar echoes the model it
    // *resolved* here, which is the number a dollar cap has to be priced by and
    // the one the team sheet cannot know.
    ...servedModel(completion.model),
    // And what that router says the call cost, when it says anything (#239).
    // Read off the headers rather than the body: LiteLLM puts it there and
    // nowhere else over this wire format.
    ...reportedCost(headers)
  };
}

function toStopReason(reason: ChatCompletion.Choice["finish_reason"]): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      // function_call is the deprecated path, and servers send reasons of their own.
      return "other";
  }
}

/**
 * Where a cache-write count hides in an OpenAI-shaped envelope (#480).
 *
 * Stock OpenAI has no such field: its caching is implicit and a write is not
 * billed, so there is nothing to report. A LiteLLM sidecar in front of a
 * provider that *does* bill writes has to put the number somewhere, and it
 * emits it three times over — measured against `main-stable` with an Anthropic
 * upstream reporting `cache_creation_input_tokens: 13`:
 *
 *   "prompt_tokens_details": { "cached_tokens": 7, "text_tokens": 11,
 *                              "cache_write_tokens": 13, "cache_creation_tokens": 13 },
 *   "cache_creation_input_tokens": 13,
 *   "cache_read_input_tokens": 7
 *
 * All three spellings are read, first one wins, because which of them a version
 * keeps is not ours to decide and a missing count is billed at the input rate —
 * the expensive direction. None of them is in the SDK's `ChatCompletion` type,
 * so they are read off a loose view rather than through it.
 */
const CACHE_WRITE_KEYS = ["cache_creation_tokens", "cache_write_tokens"] as const;

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function cacheWriteTokens(usage: NonNullable<ChatCompletion["usage"]>): number | undefined {
  for (const key of CACHE_WRITE_KEYS) {
    const found = readNumber(usage.prompt_tokens_details, key);
    if (found !== undefined) return found;
  }
  return readNumber(usage, "cache_creation_input_tokens");
}

/**
 * The four counts, converted from OpenAI's convention to `TokenUsage`'s.
 *
 * **`prompt_tokens` is inclusive and `TokenUsage.inputTokens` is exclusive**,
 * and that difference is the whole of this function. OpenAI counts every prompt
 * token in `prompt_tokens` and then says how many of them were a cache hit;
 * Anthropic reports the three tiers disjointly, and `TokenUsage` follows
 * Anthropic because `costMicroUsd` in `@getlibero/schema` prices the four counts
 * by adding four independent terms. Handing it an inclusive input count charges
 * every cached token twice — once at the input rate and again at the cache rate
 * — which on a cache-heavy agent, meaning every agent here, is the order-of-
 * magnitude error the four tiers exist to prevent. Verified against a live
 * sidecar: an upstream reporting 11 fresh, 7 read and 13 written arrives here as
 * `prompt_tokens: 31`.
 *
 * **Subtracting is clamped at zero rather than trusted.** The arithmetic assumes
 * a relationship between fields that a compatible server states nowhere, and a
 * server whose details exceed its own total would otherwise produce a negative
 * count that the meter would store and the price table would multiply. Zero is
 * the safe reading of an envelope that does not add up: the cache tiers are
 * still billed, and only the fresh-input term is lost.
 */
function toUsage(usage: ChatCompletion["usage"]): TokenUsage {
  // The budget meter is authoritative for the channel, so a server that reports
  // no usage is a failure rather than a call metered as zero.
  if (usage === undefined) {
    throw new CompletionError("response reported no token usage", PROVIDER);
  }

  const cacheRead = usage.prompt_tokens_details?.cached_tokens;
  const cacheWrite = cacheWriteTokens(usage);

  return {
    inputTokens: Math.max(0, usage.prompt_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    outputTokens: usage.completion_tokens,
    ...(typeof cacheRead === "number" ? { cacheReadInputTokens: cacheRead } : {}),
    ...(typeof cacheWrite === "number" ? { cacheCreationInputTokens: cacheWrite } : {})
  };
}

function parseArguments(raw: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CompletionError(`tool call ${toolName} had unparseable arguments`, PROVIDER, {
      cause
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CompletionError(`tool call ${toolName} returned non-object arguments`, PROVIDER);
  }
  return parsed as Record<string, unknown>;
}
