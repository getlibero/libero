import { createAnthropicCompletionClient } from "./anthropic.js";
import { createOpenAICompatibleCompletionClient } from "./openai.js";
import type { CompletionClient } from "./types.js";

/**
 * Every provider the agent can complete against. Adding one is a new arm here,
 * a new adapter, and an entry in the conformance suite — the loop is untouched,
 * because it only ever holds a CompletionClient.
 *
 * The openai-compatible arm covers OpenAI, Together, Fireworks, Baseten, Groq,
 * Ollama, Gemini's compatibility endpoint, and a LiteLLM sidecar, by base URL
 * alone. Azure Foundry, Bedrock, and Gemini's native API need their own arms:
 * they differ in auth or wire format, not just endpoint.
 */
export type CompletionConfig =
  | { provider: "anthropic"; apiKey: string; baseUrl?: string }
  | { provider: "openai-compatible"; apiKey: string; baseUrl?: string };

export interface CompletionTransport {
  /** Injected for tests. Omitted in production, where the SDK default is used. */
  fetch?: typeof globalThis.fetch;
}

export function createCompletionClient(
  config: CompletionConfig,
  transport: CompletionTransport = {}
): CompletionClient {
  const shared = {
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(transport.fetch !== undefined ? { fetch: transport.fetch } : {})
  };

  switch (config.provider) {
    case "anthropic":
      return createAnthropicCompletionClient(shared);
    case "openai-compatible":
      return createOpenAICompatibleCompletionClient(shared);
  }
}
