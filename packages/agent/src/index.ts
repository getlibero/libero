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

export { runAgentTask } from "./loop/loop.js";
export { totalTokens } from "./loop/caps.js";
export { DEFAULT_AGENT_LOOP_CAPS } from "./loop/types.js";
export type {
  AgentLoopCaps,
  AgentStopReason,
  AgentTaskOptions,
  AgentTaskResult,
  ToolCallAttribution,
  ToolCallState,
  ToolCallStep,
  ToolExecutor,
  ToolResult,
  ToolSource
} from "./loop/types.js";

export { createStubToolSource, createUnavailableToolExecutor } from "./loop/stub-tools.js";

export { createProxyTransport, ProxyClientError } from "./proxy/transport.js";
export type {
  ProxyFailure,
  ProxyRequest,
  ProxyResponse,
  ProxyTransport,
  ProxyTransportOptions
} from "./proxy/transport.js";

export { createProxyToolClient } from "./proxy/tools.js";
export type {
  HeldCallCompletion,
  HeldCallOutcome,
  HeldCallPrompter,
  HeldToolCall,
  ProxyToolClient,
  ProxyToolClientOptions,
  UnmappedToolCall
} from "./proxy/tools.js";

export { createProxySpendClient } from "./proxy/spend.js";
export type { ProxySpendClient, ProxySpendClientOptions, SpendOutcome } from "./proxy/spend.js";

export { createProxyApprovalsClient } from "./proxy/approvals.js";
export type { ProxyApprovalsClient, ProxyApprovalsClientOptions } from "./proxy/approvals.js";
