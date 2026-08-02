// Cap accounting for one task: tokens spent, tool calls dispatched, and the
// deadline that cancels in-flight work.
//
// Defense in depth. The tool proxy service meters the channel's real budget
// and is authoritative; nothing here is a substitute for that.

import type { TokenUsage } from "../completion/types.js";
import type { AgentLoopCaps } from "./types.js";

/** The two stop reasons a signal can produce. */
export type AbortStop = "cancelled" | "wall_time_cap";

/**
 * Everything a turn cost.
 *
 * Cache reads and cache writes are billed separately from ordinary input
 * tokens and are reported outside them, so a task that reads a large cache
 * would undercount badly against its cap if they were left out.
 */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}

export interface CapTracker {
  /** The caller's signal composed with the deadline. Passed to every awaited call. */
  readonly signal: AbortSignal;
  /**
   * The stop reason if the task may no longer proceed, checked in priority
   * order: an explicit cancel is never reported as a timeout. Undefined when
   * neither signal has fired.
   */
  abortStop(): AbortStop | undefined;
  tokensExhausted(): boolean;
  toolCallsExhausted(): boolean;
  /** The `maxTokens` for the next request: the per-turn ceiling, or whatever
   *  the task's total budget leaves, whichever is smaller. Never below 1. */
  outputCeiling(): number;
  recordTurn(usage: TokenUsage): void;
  recordToolCall(): void;
  snapshot(): { usage: TokenUsage; totalTokens: number; toolCalls: number; elapsedMs: number };
}

export function createCapTracker(
  caps: AgentLoopCaps,
  callerSignal: AbortSignal | undefined,
  now: () => number
): CapTracker {
  const startedAt = now();

  // A timeout signal cancels the in-flight request rather than only being
  // noticed at the top of the next iteration. Node's timeout timers do not
  // hold the event loop open, so there is nothing to clear.
  const deadline = AbortSignal.timeout(caps.maxWallTimeMs);
  const signal = callerSignal !== undefined ? AbortSignal.any([callerSignal, deadline]) : deadline;

  let inputTokens = 0;
  let outputTokens = 0;
  // Left undefined until a provider reports them, preserving the completion
  // layer's distinction between "not reported" and "reported as zero".
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let consumed = 0;
  let toolCalls = 0;

  return {
    signal,

    abortStop(): AbortStop | undefined {
      if (callerSignal?.aborted === true) return "cancelled";
      if (deadline.aborted) return "wall_time_cap";
      return undefined;
    },

    // Inclusive: landing exactly on the cap exhausts it. A turn can overshoot,
    // because what it cost is only known once it returns — which is why the
    // tool proxy service's meter, not this one, is authoritative.
    tokensExhausted: () => consumed >= caps.maxTokens,

    toolCallsExhausted: () => toolCalls >= caps.maxToolCalls,

    outputCeiling: () =>
      Math.max(1, Math.min(caps.maxOutputTokensPerTurn, caps.maxTokens - consumed)),

    recordTurn(usage: TokenUsage): void {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.cacheReadInputTokens !== undefined) {
        cacheReadInputTokens = (cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
      }
      if (usage.cacheCreationInputTokens !== undefined) {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
      }
      consumed += totalTokens(usage);
    },

    recordToolCall(): void {
      toolCalls += 1;
    },

    snapshot() {
      return {
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
          ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {})
        },
        totalTokens: consumed,
        toolCalls,
        elapsedMs: now() - startedAt
      };
    }
  };
}
