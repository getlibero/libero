// The completion layer the agent loop talks to. The loop never knows which
// provider answered: it sees messages in, text and tool calls out, tokens
// counted. Adapters own every provider-specific shape.
//
// Most of these types live here rather than in @getlibero/schema because they
// are not the wire's. ToolCall is what the *model* emitted and ToolDefinition is
// what a *provider* is handed, so neither became a shared shape when the
// tool-call wire format landed in #109 -- an earlier version of this comment
// predicted they would, and they did not, for that reason.
//
// The one exception is the tool arm's content below, which is imported. A tool
// result is not authored here: it arrives from the tool proxy service and this
// package only relays it, so restating its shape would be two declarations of
// one thing and a mapping function whose whole job is to prove they agree.
// Importing it also means a block type added to the wire is a compile error in
// every adapter, which is where that question should be asked.

import type { ToolResultBlock } from "@getlibero/schema";

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
  | {
      role: "tool";
      toolCallId: string;
      /**
       * What the tool produced, as the blocks it produced (#160).
       *
       * Adapters relay what their provider takes and render the rest as the
       * placeholder sentence `resultText` writes — which is why that sentence
       * lives in the schema rather than in either adapter. What a provider can
       * be handed differs, and the closed union is the ceiling on what any of
       * them can relay: a block type earns membership when a provider can take
       * it, not when a server can emit it.
       */
      content: ToolResultBlock[];
      isError?: boolean;
    };

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
  /**
   * What the gateway that served this call says it cost, in nano-USD (#239).
   *
   * Only a router reports one — `x-litellm-response-cost`, read by
   * ./reported-cost.ts — so a direct provider call leaves this absent, and
   * absent is the ordinary case rather than a degradation. The tool proxy
   * service records it beside its own computed figure so a stale price table is
   * visible before the invoice is; it is never metered on and never enforced
   * against, because a number a gateway computed is not a number the proxy can
   * make a decision from.
   *
   * **Absent is not zero.** A gateway that cannot price a model sends no header
   * at all, and one that prices a call at nothing sends `0` — the same
   * distinction `PriceTable` draws between a missing row and a row of zeros.
   */
  costNanoUsd?: number;
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
