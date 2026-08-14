import {
  createOpenAICompatibleEmbeddingClient,
  type OpenAICompatibleEmbeddingOptions
} from "./openai.js";
import type { EmbeddingClient } from "./types.js";

/**
 * Every provider the agent can embed against.
 *
 * One arm today, and the list is shorter than the completion layer's on
 * purpose: `createCompletionClient` has an `anthropic` arm because that is what
 * the deployment completes against, and Anthropic publishes no embeddings
 * endpoint at all. See `createOpenAICompatibleEmbeddingClient` for why the
 * OpenAI-compatible dialect is the one that ships first.
 *
 * Adding a provider is a new arm here, a new adapter, and an entry in the
 * conformance suite. Nothing that holds an `EmbeddingClient` changes.
 */
export type EmbeddingConfig = { provider: "openai-compatible"; apiKey: string; baseUrl?: string };

export interface EmbeddingTransport {
  /** Injected for tests. Omitted in production, where the SDK default is used. */
  fetch?: typeof globalThis.fetch;
}

export function createEmbeddingClient(
  config: EmbeddingConfig,
  transport: EmbeddingTransport = {}
): EmbeddingClient {
  const shared: OpenAICompatibleEmbeddingOptions = {
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(transport.fetch !== undefined ? { fetch: transport.fetch } : {})
  };

  switch (config.provider) {
    case "openai-compatible":
      return createOpenAICompatibleEmbeddingClient(shared);
  }
}
