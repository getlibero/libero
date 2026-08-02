export { CompletionError } from "./completion/types.js";
export type {
  CompletionClient,
  CompletionMessage,
  CompletionRequest,
  CompletionResponse,
  StopReason,
  TokenUsage,
  ToolCall,
  ToolDefinition
} from "./completion/types.js";

export { createCompletionClient } from "./completion/factory.js";
export type { CompletionConfig, CompletionTransport } from "./completion/factory.js";

export { createAnthropicCompletionClient } from "./completion/anthropic.js";
export type { AnthropicCompletionOptions } from "./completion/anthropic.js";

export {
  createOpenAICompatibleCompletionClient,
  OPENAI_COMPATIBLE_BASE_URLS
} from "./completion/openai.js";
export type { OpenAICompatibleCompletionOptions } from "./completion/openai.js";
