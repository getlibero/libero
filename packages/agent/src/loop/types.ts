// The agent loop's own types: where tools come from, how they run, and the
// caps that bound a task.
//
// Tools arrive as injected interfaces. The real implementations talk to the
// tool proxy service over the network at session start — the agent never
// constructs tool clients itself, so compromising this process yields no
// credentials and no way to reach a tool that the channel's team sheet does
// not permit.

import type { CompletionClient, CompletionMessage, TokenUsage, ToolCall, ToolDefinition } from "../completion/types.js";

/**
 * Where tool definitions come from. Listed once per task, before the first
 * model turn. The real implementation fetches the channel's permitted tools
 * from the tool proxy service; the agent does not decide what is on the list.
 */
export interface ToolSource {
  list(signal?: AbortSignal): Promise<ToolDefinition[]>;
}

/**
 * What one tool call produced. `isError` marks a failure the model should see
 * and may recover from — a refusal from the tool service, a 404, a bad
 * argument. It is not a loop failure.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * Who asked, and which task the call belongs to.
 *
 * Sent with every call so the tool proxy service can write an audit record that
 * a human can read back. It is deliberately *not* part of `ToolCall`: that
 * shape is what the model emitted, and these two fields are what this process
 * knows about the request the model is serving. Keeping them apart is what
 * stops a model-authored field ever being mistaken for one of these.
 *
 * **Attribution, not authentication.** Nothing in the proxy authorizes on
 * either — the channel comes from the client certificate and is the only proved
 * identity on the wire. The full argument lives on the fields themselves, in
 * `ToolCall` in packages/schema/src/tool-call.ts.
 */
export interface ToolCallAttribution {
  /** The Slack user behind the mention. Asserted by this process. */
  readonly requestingUser: string;
  /** Minted by the loop, once per task, stable across that task's calls. */
  readonly taskId: string;
}

/**
 * Runs one tool call. The real implementation is a network call to the tool
 * proxy service, which owns every credential and resolves every allowlist,
 * approval, and budget decision without this process's cooperation.
 */
export interface ToolExecutor {
  execute(call: ToolCall, attribution: ToolCallAttribution, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * Per-task hard caps.
 *
 * Defense in depth only. The tool proxy service's meter is authoritative and
 * enforces the channel's real budget; these caps exist so a task that runs
 * away — a model that will not stop calling tools, a provider that hangs —
 * terminates here too rather than relying on a single control.
 *
 * Every field is required. There are no defaults on this interface, so a
 * caller cannot leave a task uncapped by omission.
 */
export interface AgentLoopCaps {
  /** Tool calls dispatched across the whole task. */
  maxToolCalls: number;
  /** Wall time from the first tool listing to the last turn. */
  maxWallTimeMs: number;
  /** Input + output + cache tokens summed across every turn of the task. */
  maxTokens: number;
  /** Ceiling on one turn's output, clamped down by whatever `maxTokens` leaves. */
  maxOutputTokensPerTurn: number;
}

/**
 * A starting point for a single Slack-turnaround task. Real deployments read
 * these from the channel's team sheet; this is what a caller with no sheet
 * gets, not a recommendation.
 */
export const DEFAULT_AGENT_LOOP_CAPS: AgentLoopCaps = {
  maxToolCalls: 25,
  maxWallTimeMs: 300_000,
  maxTokens: 200_000,
  maxOutputTokensPerTurn: 8_192
};

/**
 * Why the loop stopped. Every variant is reportable to the channel as-is: a
 * task that ends without producing an answer must be able to say which limit
 * ended it.
 */
export type AgentStopReason =
  /** The model ended its turn. */
  | "completed"
  /** The model refused. */
  | "refusal"
  /** The model's response was truncated by the per-turn output ceiling. */
  | "max_tokens"
  /** A provider stop reason the loop has no distinct behaviour for, or a
   *  tool-use turn that carried no tool calls. Never treated as completion. */
  | "stopped_other"
  | "tool_call_cap"
  | "wall_time_cap"
  | "token_cap"
  /** The caller's signal aborted — shutdown, or a human cancelling the task. */
  | "cancelled";

export interface AgentTaskOptions {
  completion: CompletionClient;
  toolSource: ToolSource;
  toolExecutor: ToolExecutor;
  /** Model id, passed through verbatim. Per-channel override resolves upstream. */
  model: string;
  /**
   * The Slack user whose mention started this task, for the audit log.
   *
   * Required rather than optional: a call with no attribution is a call the
   * audit log cannot answer "who asked" for, and an optional field is one a
   * caller forgets. See `ToolCallAttribution` for what it is and is not.
   */
  requestingUser: string;
  /**
   * The task id, normally minted here. Supply one only to correlate this task
   * with something outside the loop — or to make a test deterministic, which is
   * the same need `now` covers for the clock.
   */
  taskId?: string;
  system?: string;
  /** Seed transcript. The loop appends to a copy and never mutates this array. */
  messages: CompletionMessage[];
  caps: AgentLoopCaps;
  /** Caller cancellation. Composed with the loop's own wall-time deadline. */
  signal?: AbortSignal;
  /** Clock, injected for tests. */
  now?: () => number;
}

export interface AgentTaskResult {
  stopReason: AgentStopReason;
  /**
   * The id every tool call this task made was attributed to. Returned so the
   * caller can log it next to the reply — an audit record is only reachable if
   * something on the outside knows which task to look for.
   */
  taskId: string;
  /**
   * The most recent non-empty assistant text — what a channel reply is built
   * from. A tool-calling turn usually carries none, so the last turn's text is
   * often empty while the task did produce an answer. Empty only when the task
   * produced no text at all.
   */
  text: string;
  /**
   * The full transcript including the seed. Well-formed: every tool call in it
   * has a matching tool result, even where a cap stopped the batch part-way, so
   * the transcript can seed a later turn.
   */
  messages: CompletionMessage[];
  /** Summed across turns. A field is absent when no provider reported it. */
  usage: TokenUsage;
  totalTokens: number;
  toolCalls: number;
  turns: number;
  elapsedMs: number;
}
