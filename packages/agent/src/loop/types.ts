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
 * Where one tool call has got to, as the loop dispatches it (#68).
 *
 * Four states rather than a boolean, because a reader watching a task wants to
 * tell "this one is in flight" from "this one came back an error" from "the cap
 * bit before this one ran" — and the third is not a failure of the call, which
 * never happened.
 */
export type ToolCallState =
  /** Dispatched, no answer yet. */
  | "running"
  /** Answered. */
  | "ok"
  /** Answered with `isError`, or threw. A refusal is one of these. */
  | "error"
  /** Never dispatched: a cap or an abort ended the batch first. */
  | "skipped";

/**
 * One tool call's progress, reported as it happens.
 *
 * `ordinal` is 1-based and task-global, allocated when the call is dispatched
 * and reused for that call's later states, so a consumer keyed on it sees a
 * step change rather than a second step. It counts skipped calls too: the
 * numbering is what the task attempted, not what it achieved.
 *
 * **`name` is model-authored text** — the flat name the model emitted, which
 * the tool client may not even be able to decode to a pair. It is a value here
 * rather than part of a sentence for `UnmappedToolCall.name`'s reason, and a
 * consumer that renders it on a human-facing surface has to escape it there.
 */
export interface ToolCallStep {
  readonly ordinal: number;
  readonly name: string;
  readonly state: ToolCallState;
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

/**
 * What one model turn cost, as `onTurn` reports it.
 *
 * An object rather than positional arguments, because #62 added a third field
 * and it is optional: `onTurn(usage, 3, undefined)` reads as nothing at a call
 * site, and the next field would read as less. The two that were already here
 * keep their meaning exactly.
 */
export interface CompletedTurn {
  usage: TokenUsage;
  /** Which turn of this task, from 1. Makes a per-turn id `<task>.<n>`. */
  turn: number;
  /**
   * The model that served it, when the provider echoed one (#62).
   *
   * Passed through from `CompletionResponse.model` without interpretation — in
   * particular **not** defaulted to the model that was requested, which under a
   * router is a different thing and is the reason this exists. See that field
   * for the whole argument.
   */
  model?: string;
}

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
  /**
   * What the turn that just finished cost, as the provider reported it.
   *
   * Called once per model turn, after the turn is counted against the caps and
   * before anything is done with what the model said. `turn` is 1 for the first
   * and increments — the same number `AgentTaskResult.turns` ends on.
   *
   * **Per turn rather than per task, because a task is not the unit that gets
   * paid for.** The caller's meter is what a channel's budget is enforced from,
   * and a report that only arrives when the task ends means a long task spends
   * its whole cost before the meter hears about any of it — so a channel over
   * its cap is refused starting with the *next* task rather than the next tool
   * call. It also means tokens spent by a task that dies mid-flight are spent
   * silently: `runAgentTask` rejects when the provider fails non-cancellably,
   * and everything counted so far goes with the rejection. Reporting as the
   * turns happen fixes both without this file knowing what a meter is.
   *
   * **Awaited.** A detached call would let the next turn start before this one
   * is recorded, which is the ordering the meter is being told about. The cost
   * is that a slow hook slows the task, and that is the caller's to bound — see
   * the deadline the spend client carries.
   *
   * **It must not throw.** Nothing here catches it, and a rejection would end
   * the task: the loop would rethrow, the reply would be lost, and a channel
   * would go unanswered because a *counter* could not be written. Catching it
   * here would be worse — this file has no way to log, so the failure would
   * vanish. A caller that can fail swallows its own failure and says so where
   * it has a logger.
   */
  onTurn?: (turn: CompletedTurn) => void | Promise<void>;
  /**
   * Where each tool call has got to, called as the loop dispatches them (#68).
   *
   * **Synchronous and not awaited**, which is the opposite of `onTurn` and is
   * the decision rather than an oversight. `onTurn` is awaited because the
   * meter is being told about an ordering it has to see; this is a progress
   * report, and its consumer edits a Slack message — awaiting that would put a
   * network round trip between every tool call and the next, making a task as
   * slow as the surface watching it. A consumer that writes anywhere coalesces
   * and rate-limits behind this callback, where it can, rather than here, where
   * it would cost the task.
   *
   * **It must not throw.** Nothing catches it: a rejection would end the task
   * and lose the answer because a *checklist* could not be drawn. Catching here
   * would be worse, for the reason `onTurn` gives — this file has no way to log,
   * so a swallowed failure vanishes rather than being reported.
   *
   * The loop reports nothing else. A task's terminal state is its
   * `AgentTaskResult`, which the caller already has, and reporting it twice
   * would give a consumer two sources for one fact that can disagree — and the
   * loop cannot report the case where it *throws* at all, which is exactly the
   * one a checklist must still close.
   */
  onToolCall?: (step: ToolCallStep) => void;
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
