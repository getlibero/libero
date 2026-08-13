// The completion layer the agent loop talks to. The loop never knows which
// provider answered: it sees messages in, text and tool calls out, tokens
// counted. Adapters own every provider-specific shape.
//
// These types live here rather than in @getlibero/schema because nothing here
// crosses a service boundary yet. When the tool-call wire format between the
// agent and the tool service lands, ToolCall and ToolDefinition move to the
// schema package and both services import them from there.

/**
 * A tool the model may call. `inputSchema` is JSON Schema, passed through to
 * the provider unmodified — the agent does not author or validate it. Tool
 * definitions arrive over the network at session start; the agent never
 * constructs tool clients itself.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool call the model asked for. `arguments` is always parsed — adapters that
 * receive a JSON string on the wire parse it and fail loudly if it is
 * malformed, so the loop never has to.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type CompletionMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /**
       * Opaque provider-internal blocks from the response that produced this
       * turn. The loop stores it and hands it back untouched; only the adapter
       * that produced it may read it.
       *
       * Anthropic requires reasoning blocks be replayed unchanged when a
       * tool-use conversation continues on the same model, and reasoning is on
       * by default on current models — dropping them breaks the loop. Keeping
       * the field opaque means providers with their own replay requirements
       * need no change to these types.
       */
      providerState?: unknown;
    }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface CompletionRequest {
  /** Model id, passed through verbatim. The per-channel override resolves upstream. */
  model: string;
  /** System prompt. Adapters place it wherever the provider expects. */
  system?: string;
  messages: CompletionMessage[];
  tools?: ToolDefinition[];
  /** Required: Anthropic has no default, and the loop's caps supply it. */
  maxTokens: number;
  /** Cancels an in-flight request, so the loop can enforce its wall-time cap. */
  signal?: AbortSignal;
}

/**
 * Why the model stopped. `other` covers provider-specific reasons the loop has
 * no distinct behaviour for — it must never be silently treated as `end_turn`.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/**
 * Per-call token counts. Cache reads and cache writes bill differently from
 * ordinary input tokens, so the budget meter needs them separately; providers
 * that do not report them omit the fields rather than reporting zero.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CompletionResponse {
  /** Text blocks joined. Empty string when the model only called tools. */
  text: string;
  /** Empty unless the model called tools. May hold several — calls can be parallel. */
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage;
  /**
   * The model that actually served this turn, as the provider echoed it back.
   *
   * **Not `CompletionRequest.model`, and never filled in from it** (#62). What
   * was asked for is the channel's `[llm] model` or `AGENT_MODEL`; what served
   * it can differ, because a LiteLLM sidecar resolves an alias and Bedrock and
   * Vertex carry their own prefixes. The tool proxy service prices a channel's
   * spend by this value, so substituting the requested id would price a router's
   * `smart` as `smart` — silently wrong in exactly the deployment a dollar cap
   * exists for. A provider that echoes nothing leaves this absent, and absent is
   * an answer.
   *
   * Adapters omit anything that is not a well-formed `ModelId` rather than pass
   * it along. The spend report is a strict wire schema, so a malformed id would
   * fail the whole request and lose that turn's token counts — the degradation
   * has to be "unreported", never "lost".
   */
  model?: string;
  /** Echo back on the assistant message built from this response. */
  providerState?: unknown;
}

export interface CompletionClient {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Every adapter failure the loop sees. `provider` names the adapter, never a
 * credential or endpoint — errors are one of the paths a secret could leak.
 */
export class CompletionError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompletionError";
    this.provider = provider;
  }
}
