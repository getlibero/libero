// The heartbeat evaluation: what a due channel actually does (#319).
//
// `./ambient.ts` decides *when to look and where*; this is what happens when it
// looks. It is the reader that file shipped without, and the first thing in this
// process that can speak into a channel — through `ProactivePoster`, which is
// handed to it and to nothing else.
//
// It is not one of the four background passes. Those fire from the message
// ingest, on channel activity; this one runs on the clock, which is the whole
// difference ambient mode exists for — the channel that has *not* had traffic is
// the one with the question sitting unanswered since Friday.
//
// ## The pregate, and why its order is the design
//
// Most heartbeats must cost nothing, or a brisk cadence is unaffordable and the
// feature ships turned off. So four questions run before any model call, in this
// order, cheapest and most decisive first:
//
//   1. **Is `[ambient]` on?** The scheduler checked, but it enumerates from a
//      sheet read of its own and this pass takes settings separately. Defence,
//      not a path.
//   2. **Is the rate window open?** (`post.mayPost`) A map lookup, and the most
//      decisive question there is: the only output of this turn is a post, so
//      evaluating with the window shut is spend whose result is already refused.
//      This is also what makes a shut window a *deferral* — see below.
//   3. **Is there anything new that has gone quiet?** (`store.idleThreads`) One
//      indexed query. This is where `[ambient] answer_after_idle_minutes` is
//      read at last, and where the watermark rules a thread in or out.
//   4. **Can the channel afford it?** (`maySpend`) A network round trip, so it
//      goes last: nothing above it costs anything, and a channel that was never
//      going to evaluate must not pay for a question about its budget.
//
// A tick that stops at any of the first three is silent and spends nothing at
// all, which is what the architecture means by "a tick with nothing to evaluate
// spends nothing".
//
// ## The watermark, and why a shut window loses nothing
//
// One Slack `ts` per channel, in memory, in this factory's closure — the four
// passes' convention, and `./ambient.ts`'s argument for why in-memory is right
// here: a process that starts empty simply weighs the channel once more, which
// is the cheap direction to be wrong in.
//
// It advances to the channel's newest message **when an evaluation runs**, and
// only then. Two properties fall out, and both are load-bearing:
//
//   - **A finding is offered at most once per silence.** A thread that was quiet
//     when the channel was last weighed sits below the watermark and is never
//     offered again — which matters because *the agent's own replies are not in
//     the store*. Nothing records that the agent answered, so without this a
//     question it had already spoken about would look unanswered forever and be
//     raised every window until somebody replied to it.
//   - **A shut window defers rather than loses.** The window is checked *before*
//     the evaluation, so a heartbeat that cannot post does not evaluate, does not
//     advance the watermark, and finds the same material again next time. That is
//     the decision `../proactive/proactive.ts` left to this issue.
//
// A thread that says something more rises back above the watermark, goes quiet
// again, and is eligible again. Say-once is per silence, not forever.
//
// ## What the model is shown, and what it is not
//
// Recent activity, capped — `runSummarizationTurn`'s division of labour, where
// the pass decides how much and the turn renders it. It is **not** told which
// threads the pregate found idle: handing it the answer would make the finding a
// formality, and the cases the design actually wants — a deadline nobody picked
// up, a thread stalled on something answerable — are the ones it would stop
// looking for.
//
// ## What bounds it
//
//   - **The sheet.** `[ambient] enabled` is off unless a channel wrote
//     otherwise, and `answer_after_idle_minutes` is what counts as unanswered.
//   - **The pregate**, above: three free questions, and most ticks stop there.
//   - **`HEARTBEAT_POST_WINDOW_MS`**, which since this issue bounds the *spend*
//     and not only the speech: at most one evaluation per channel per window,
//     whatever the cadence.
//   - **`MAX_HEARTBEAT_MESSAGES`**, what one turn may read.
//   - **`maySpend`**, so a channel over its caps evaluates nothing (#335).
//   - **The meter.** The turn reports through the same `SpendReport` path every
//     other turn takes. The backstop, not the mechanism.

import { runHeartbeatTurn } from "@getlibero/agent";
import type { CompletedTurn, CompletionClient, HeartbeatMessage } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import type { AmbientHeartbeat } from "./ambient.js";
import { toSlackTs } from "./summarize.js";
import type { ProactivePoster } from "../proactive/proactive.js";

/**
 * How much of a channel's recent conversation one evaluation reads.
 *
 * `MAX_THREAD_MESSAGES`' counterpart and a little smaller, because what it
 * bounds is different: that one is a whole thread being summarized, where this
 * is a channel being skimmed for whether anything stands out. Forty messages is
 * enough to see a question go unanswered across a working day and small enough
 * that a busy channel's heartbeat is not its most expensive turn.
 */
export const MAX_HEARTBEAT_MESSAGES = 40;

/** What the heartbeat needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface HeartbeatSettings {
  /** `[ambient] enabled`. False and nothing here runs. */
  readonly enabled: boolean;
  /** `[ambient] answer_after_idle_minutes`, in milliseconds. */
  readonly answerAfterIdleMs: number;
  /** The channel's model, from `[llm] model` or the process default. */
  readonly model: string;
  /**
   * `[llm] max_tokens_per_turn`.
   *
   * The per-*turn* cap rather than the per-task one, `SkillCurateSettings`'
   * reason: there is no task here and nobody waiting, so the figure that applies
   * is the one bounding a single answer.
   */
  readonly maxTokens: number;
}

export interface HeartbeatOptions {
  completion: CompletionClient;
  /**
   * Where a finding goes, and the only posting capability in this process.
   *
   * Handed in rather than built, because it is minted in `../compose.ts` and
   * reaches this and nothing else — which is what keeps the four background
   * passes unable to post. See `ProactivePoster`.
   */
  post: ProactivePoster;
  /** The channel's `[ambient]` block and its model. `null` skips the channel. */
  settings: (channel: string) => Promise<HeartbeatSettings | null>;
  /** Reports the turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /**
   * Whether this channel may be spent for at all (#335). Must not throw.
   *
   * Required for the reason the three on-activity passes take it: an option that
   * defaulted would default to unbounded, and this is the pass with the least
   * visible spend of any of them.
   */
  maySpend: (channel: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
  signal?: AbortSignal;
}

/** A reason code from an error, and never its message. The passes' rule. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function createAmbientHeartbeat(options: HeartbeatOptions): AmbientHeartbeat {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  /**
   * The newest message each channel had when it was last evaluated.
   *
   * A Slack `ts`, not a wall clock — the four passes hold clocks, and this holds
   * a position, because what it answers is "have I already weighed this" rather
   * than "how long since I looked". See the header.
   */
  const watermark = new Map<string, string>();

  return async (channel: string, store: MessageStore): Promise<void> => {
    let settings: HeartbeatSettings | null;
    try {
      settings = await options.settings(channel);
    } catch (error) {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read says nothing, which is the direction
      // `DEFAULT_AMBIENT_SETTINGS` already falls in.
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      return;
    }
    if (settings === null || !settings.enabled) return;

    // Free, and the most decisive: with the window shut this turn's only
    // possible output is already refused. Returning here leaves the watermark
    // where it is, which is what makes the material wait rather than evaporate.
    if (!options.post.mayPost(channel)) {
      logger.log("info", { event: "heartbeat_deferred", channel });
      return;
    }

    const at = now();
    const idleBefore = toSlackTs(at - settings.answerAfterIdleMs);
    const since = watermark.get(channel) ?? "";

    let material;
    let recent;
    try {
      // One row is all the pregate needs: whether anything is there.
      material = store.idleThreads(idleBefore, since, 1);
      if (material.length === 0) return;
      recent = store.recent(MAX_HEARTBEAT_MESSAGES);
    } catch (error) {
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      return;
    }
    if (recent.length === 0) return;

    // Last of the four, because it is the only one that costs a round trip and
    // everything above it is free. A capped channel evaluates nothing — and does
    // not advance its watermark either, so it weighs the same material once it
    // can afford to.
    if (!(await options.maySpend(channel))) return;
    if (options.signal?.aborted === true) return;

    const newest = recent[recent.length - 1]?.ts;
    const messages: HeartbeatMessage[] = recent.map(row => ({
      // The name captured when the message was stored, falling back to the id.
      // `summarize.ts`'s choice and its reason: this pass has no Slack token.
      author: row.displayName ?? row.userId,
      text: row.text
    }));

    // The id the meter dedupes on. `<channel>-<watermark>` rather than a
    // counter, so a retry after a crash is the same id and is counted once,
    // while a genuinely later evaluation — the channel said more — is a new one.
    const turnId = `ambient-${channel}-${newest ?? String(at)}`;

    let result;
    try {
      result = await runHeartbeatTurn({
        completion: options.completion,
        model: settings.model,
        messages,
        maxTokens: settings.maxTokens,
        turn: 1,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onTurn: async completed => {
          await options.reportTurn(channel, { ...completed, id: turnId });
        }
      });
    } catch (error) {
      // The turn was attempted and the watermark stays put, so the same material
      // is weighed again rather than skipped because a provider was down.
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      return;
    }

    // Advanced whatever the answer was, including silence: the question "has
    // this been weighed" was answered by running the turn, and a watermark that
    // moved only on a finding would ask the model about the same quiet thread
    // every window forever.
    if (newest !== undefined) watermark.set(channel, newest);

    if (result.unusable !== undefined) {
      logger.log("warn", { event: "heartbeat_unusable", channel, reason: result.unusable });
      return;
    }
    if (result.finding === null) {
      logger.log("info", { event: "heartbeat_silent", channel });
      return;
    }

    const posted = await options.post.post({
      channel,
      text: result.finding.text,
      source: "heartbeat"
    });
    // `false` here is a race the overrun rule already prevents, or a Slack
    // failure the surface has logged. Either way the finding is gone: the
    // watermark moved, because the turn ran and was paid for.
    logger.log("info", { event: posted ? "heartbeat_posted" : "heartbeat_unposted", channel });
  };
}
