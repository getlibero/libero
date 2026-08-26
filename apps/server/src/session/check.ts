// Firing a scheduled check: what a due ticket actually does (#324).
//
// `./ambient.ts` decides when to look and where; `./heartbeat.ts` is what happens
// when a channel's cadence comes due. This is what happens when a *ticket* comes
// due, and it is a different act from both. A heartbeat asks whether anything
// merits saying; this runs a question somebody already decided was worth asking
// and approved through the tool proxy service, minutes or days ago.
//
// ## One firing, one outcome
//
// **A due check reaches a terminal state on its first wake, always.** It posts,
// or it runs and has nothing to say, or it could not run and the channel is told
// so — and in every one of those the row gets its fire stamp and is never looked
// at again.
//
// That rule replaced a queue, and what it removed is worth recording so nobody
// rebuilds it. A due check that stayed pending would keep contributing an entry
// to a plan whose loop sleeps until the next due instant — and an instant already
// in the past makes that sleep zero, so a channel over its budget would spin the
// scan at whatever rate the event loop allows until midnight. Fixing that needs a
// backoff, and a backoff needs a retry stamp, and a stamp needs a rule for how
// stale is too stale, and by then a reminder can arrive four days late, which is
// worse than not arriving.
//
// What the queue was protecting was real, and this keeps it by a different route:
// **the team is told.** A check that could not run says so in the channel, from a
// closed set of reasons, so the people who set it up can act on the timer even
// though the agent could not do its part. That is the whole trade — no queue, no
// backoff, no grace window, no `abandoned` state, and nothing silently lost.
//
// **The `[ambient]` block is the one silence.** Switched off between the approved
// create and the due time, the clock never enumerates the channel, so nothing
// fires and nothing is said. That is correct rather than a gap: that switch means
// *do not speak here*, and a failure notice would be the agent speaking after
// being told not to. The row waits, and fires once — late, because its time is
// absolute — if the channel turns ambient back on.
//
// ## Why the stamp is written after the attempt and not before
//
// A crash between the model call and the stamp re-fires the check on the next
// scan, which costs one more turn. A stamp written first would lose the check
// entirely on the same crash. One is a cost and the other is a silent failure,
// and this is the cheap direction to be wrong in — `./ambient.ts`'s argument for
// an in-memory schedule, one file over.
//
// The post is not what the stamp waits for either, and that differs from the
// proposal notice in `./heartbeat.ts` deliberately. There, nothing had been spent
// when the post failed, so leaving the row absent cost a retry and no tokens.
// Here the turn has already run, so a stamp that waited for Slack would buy a
// repeat of the *model call* every scan against a channel the app cannot post in
// — and `ProactivePoster` already refuses to refund its window for exactly that
// reason.
//
// ## What bounds it
//
//   - **The governed create.** Allowlisted, held for a human by default, capped
//     and audited. That is where a check is authorized; nothing here re-decides
//     it, and nothing here could.
//   - **One post per firing**, through the same surface, with `source: "task"` —
//     which does not draw on `HEARTBEAT_POST_WINDOW_MS` and is not blocked by it.
//     A reminder is not late because a heartbeat spoke first.
//   - **`maySpend`**, asked before the turn, so a channel over its caps spends
//     nothing (#335).
//   - **`MAX_CHECK_MESSAGES`**, what one check may read.
//   - **The meter**, through the same `SpendReport` path as every other turn.
//
// ## What a fired check cannot do
//
// It has no `ToolExecutor` and no tool proxy client — `runScheduledCheckTurn` is
// handed a completion client and a list of messages. So a fired check induces no
// served calls at all, and "every call it induces meets the same gates a
// mention's does" is true by there being none. Giving a check the ReAct loop
// would be a real widening of what unattended work can do, and it is a decision
// somebody should have to make on purpose rather than inherit from this file.
//
// Since #461 that turn lives in `./fired-turn.ts`, because a standing rule fires
// the same one. What stayed here is what a *check* does either side of it: the
// row it stamps, and the notice that says this one is done.

import { runFiredTurn } from "./fired-turn.js";
import type { FiredTurnSettings } from "./fired-turn.js";
import type { StandingInputs } from "./task.js";
import type { SharedSkillReader } from "./shared-skills.js";
import type { CompletedTurn, CompletionClient } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore, ScheduledTaskOutcome, StoredScheduledTask } from "@getlibero/memory";
import type { AmbientTaskFire } from "./ambient.js";
import type { ProactivePoster } from "../proactive/proactive.js";

export { MAX_FIRED_TURN_MESSAGES as MAX_CHECK_MESSAGES } from "./fired-turn.js";

/** What the fire path needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface CheckSettings extends FiredTurnSettings {
  /**
   * What this channel's standing region is composed from (#450).
   *
   * The operator's own text, resolved per invocation because their files can
   * change between two of them. See `systemPromptFor` for why this turn composes
   * a region at all and which two turns deliberately do not.
   */
  readonly standing: StandingInputs;
  /** `[ambient] enabled`. False and nothing here runs. Defence, not a path. */
  readonly enabled: boolean;
  /** The channel's model, from `[llm] model` or the process default. */
  readonly model: string;
  /** `[llm] max_tokens_per_turn`. `HeartbeatSettings`' reason: there is no task here. */
  readonly maxTokens: number;
}

/**
 * Why a check did not produce an answer, in the words a channel reads.
 *
 * **Local to this file rather than members on `ToolRefusal`**, which is
 * `AmbientFindingFailure`'s reason: nothing here reaches the tool proxy service,
 * is decided by a gate, or writes an audit row. A refusal is that service's
 * answer to a call; this is this process saying it could not do a thing it was
 * asked to do.
 *
 * Two members, and they stay two because they send a reader to different places.
 * One is a budget an admin can raise or a day that will end; the other is
 * something broken that somebody has to look at. Collapsing them would tell a
 * team its check failed and give them no idea which.
 */
type CheckFailure = "over_budget" | "failed";

/**
 * What a channel is told when a check could not run.
 *
 * **Composed here and never by a model**, `renderProposalNotice`'s rule and one
 * more of its own: the whole point of this path is that nothing was spent, so a
 * notice that needed a model call would defeat the case it exists for. It is a
 * template over the check's own question and one of two reasons.
 *
 * It quotes the question because a notice that does not say *which* check failed
 * is no use to anyone trying to act on it — and the question is the one part the
 * team can recognize. That is model-authored text going into a channel, and it is
 * the safest instance of it here: a person read that exact string on an approval
 * card before the ticket existed, and `renderProactivePost` escapes and caps it.
 *
 * It says what the team's move is, because the whole reason this posts rather
 * than staying quiet is that they can still act on the timer themselves.
 */
export function renderCheckFailureNotice(prompt: string, reason: CheckFailure): string {
  const why =
    reason === "over_budget"
      ? "this channel has spent its daily budget, so nothing was run"
      : "the check could not be run";
  return [
    `A scheduled check came due and did not happen: ${why}.`,
    "",
    `It was: ${prompt}`,
    "",
    "Nothing else will happen about it — a check runs once, and this one is done. If it still",
    "matters, someone here can do it or ask for it to be scheduled again."
  ].join("\n");
}

export interface CheckOptions {
  /**
   * How this channel's `load = "always"` shared skills are read (#450).
   *
   * Absent composes no region, which is every deployment with no third root —
   * and is why this is optional where `standing` on the settings is not: the
   * sheet always says something, and whether there is a root to read is the
   * composition's business rather than the channel's.
   */
  sharedSkills?: SharedSkillReader;
  completion: CompletionClient;
  /** Where an answer goes, and the only posting capability in this process. */
  post: ProactivePoster;
  /** The channel's `[ambient]` block and its model. `null` skips the channel. */
  settings: (channel: string) => Promise<CheckSettings | null>;
  /** Reports the turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /** Whether this channel may be spent for at all (#335). Must not throw. */
  maySpend: (channel: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
  signal?: AbortSignal;
}

/** A reason code from an error, and never its message. The passes' rule. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function createAmbientTaskFire(options: CheckOptions): AmbientTaskFire {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  return async (channel: string, store: MessageStore, task: StoredScheduledTask): Promise<void> => {
    let settings: CheckSettings | null;
    try {
      settings = await options.settings(channel);
    } catch (error) {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read says nothing and fires nothing, which
      // leaves the ticket for a scan that can read it.
      logger.log("warn", { event: "check_failed", channel, reason: reasonOf(error) });
      return;
    }
    // The scheduler enumerates from a sheet read of its own, so reaching here
    // with ambient off is a race rather than a path — and the answer is the same
    // one the block's own switch gives: say nothing, and leave the row.
    if (settings === null || !settings.enabled) return;

    const outcome = await run(channel, store, task, settings);
    if (outcome === null) return;

    // Written after the attempt and whatever it produced. See the header: a crash
    // before this costs one more turn, where a stamp written first would lose the
    // check.
    try {
      store.markScheduledTaskFired(task.id, now(), outcome);
    } catch (error) {
      // The check has already run and already spoken. Failing to record that is
      // a repeat on the next scan, which is the cheap direction — and loud,
      // because a channel that repeats a check is a channel with a broken store.
      logger.log("error", { event: "check_failed", channel, reason: reasonOf(error) });
    }
  };

  /**
   * One firing, and what to record for it. `null` leaves the ticket pending.
   *
   * The only `null` is an abort — the process is stopping, so the check has not
   * happened and must not be marked as though it had.
   */
  async function run(
    channel: string,
    store: MessageStore,
    task: StoredScheduledTask,
    settings: CheckSettings
  ): Promise<ScheduledTaskOutcome | null> {
    const outcome = await runFiredTurn(
      {
        completion: options.completion,
        ...(options.sharedSkills !== undefined ? { sharedSkills: options.sharedSkills } : {}),
        reportTurn: options.reportTurn,
        maySpend: options.maySpend,
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      },
      {
        channel,
        store,
        question: task.prompt,
        // The id the meter dedupes on. The ticket's own id, which is minted once
        // by the tool proxy service and fires once — so a retry after a crash is
        // the same id and is counted once, and there is no later firing of this
        // check to collide with.
        turnId: `check-${task.id}`,
        settings
      }
    );

    switch (outcome.kind) {
      case "over_budget":
        // The meter was asked before anything was spent (#335). A channel over
        // its caps runs no turn — and is *told*, because a notice costs nothing
        // and a check that vanishes is the thing this design refused to build.
        logger.log("info", { event: "check_declined", channel, reason: "over_budget" });
        await tell(channel, task, "over_budget");
        return "over_budget";

      case "failed":
        logger.log("warn", { event: "check_failed", channel, reason: outcome.reason });
        await tell(channel, task, "failed");
        return "failed";

      case "silent":
        // The check ran and the answer was that there is nothing to say. Not a
        // failure and not a notice: recorded apart from `posted` so an operator
        // can see a check that has never once had anything to say.
        logger.log("info", { event: "check_silent", channel });
        return "silent";

      case "aborted":
        return null;

      case "answer": {
        const posted = await options.post.post({ channel, text: outcome.text, source: "task" });
        logger.log("info", { event: posted ? "check_posted" : "check_unposted", channel });
        // `posted` either way. A Slack failure is not a reason to run the check
        // again — see the header, and `ProactivePoster`'s refusal to refund.
        return "posted";
      }
    }
  }

  /** The one post a firing that produced no check is allowed. Never throws. */
  async function tell(
    channel: string,
    task: StoredScheduledTask,
    reason: CheckFailure
  ): Promise<void> {
    await options.post.post({
      channel,
      text: renderCheckFailureNotice(task.prompt, reason),
      // A notice is the firing's one post, not an extra one — and it carries the
      // wake reason it belongs to, so the window still does not govern it.
      source: "task"
    });
  }
}
