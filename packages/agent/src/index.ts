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

export { EmbeddingError } from "./embedding/types.js";
export type {
  EmbeddingClient,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingUsage
} from "./embedding/types.js";

export { createEmbeddingClient } from "./embedding/factory.js";
export type { EmbeddingConfig, EmbeddingTransport } from "./embedding/factory.js";

export {
  createOpenAICompatibleEmbeddingClient,
  OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS
} from "./embedding/openai.js";
export type { OpenAICompatibleEmbeddingOptions } from "./embedding/openai.js";

export { runAgentTask } from "./loop/loop.js";
export { totalTokens } from "./loop/caps.js";
export { DEFAULT_AGENT_LOOP_CAPS } from "./loop/types.js";
export type {
  AgentLoopCaps,
  AgentStopReason,
  AgentTaskOptions,
  AgentTaskResult,
  CompletedTurn,
  ToolCallAttribution,
  ToolCallState,
  ToolCallStep,
  ToolExecutor,
  ToolResult,
  ToolSource
} from "./loop/types.js";

export { createStubToolSource, createUnavailableToolExecutor } from "./loop/stub-tools.js";

export {
  CURATION_SYSTEM_PROMPT,
  curationTranscript,
  memoryToolDefinitions,
  runCurationTurn
} from "./curation/turn.js";
export type {
  CurationOpOutcome,
  CurationTurnOptions,
  CurationTurnResult,
  MemoryOpHandler
} from "./curation/turn.js";

export {
  SKILL_AUTHOR_SYSTEM_PROMPT,
  SKILL_STEP_MAX_CHARS,
  runSkillAuthorTurn,
  skillToolDefinitions,
  skillTranscript
} from "./skill/turn.js";
export type {
  NearbySkill,
  SkillAuthorTurnOptions,
  SkillAuthorTurnResult,
  SkillOpHandler,
  SkillOpOutcome
} from "./skill/turn.js";

export {
  SKILL_MERGE_SYSTEM_PROMPT,
  runSkillMergeTurn,
  skillMergeToolDefinition
} from "./skill/merge.js";
export type {
  MergeCandidate,
  SkillMergeTurnOptions,
  SkillMergeTurnResult
} from "./skill/merge.js";

export {
  AMBIENT_HEARTBEAT_SYSTEM_PROMPT,
  ambientFindingToolDefinition,
  runHeartbeatTurn
} from "./ambient/turn.js";
export type {
  HeartbeatMessage,
  HeartbeatTurnOptions,
  HeartbeatTurnResult
} from "./ambient/turn.js";

export {
  SUMMARIZATION_SYSTEM_PROMPT,
  runSummarizationTurn
} from "./summarize/turn.js";
export type {
  SummarizationMessage,
  SummarizationTurnOptions,
  SummarizationTurnResult
} from "./summarize/turn.js";

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

export { DEFAULT_BUDGET_TIMEOUT_MS, createProxyBudgetClient } from "./proxy/budget.js";
export type { ProxyBudgetClient, ProxyBudgetClientOptions } from "./proxy/budget.js";

export { createProxyApprovalsClient } from "./proxy/approvals.js";
export type { ProxyApprovalsClient, ProxyApprovalsClientOptions } from "./proxy/approvals.js";
