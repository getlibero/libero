// Firing a standing rule: what a due `[[ambient.rule]]` actually does (#461).
//
// `./ambient.ts` decides when to look and where; `./heartbeat.ts` is what happens
// when a channel's cadence comes due, and `./check.ts` is what happens when a
// *ticket* does. This is the third, and what separates it from the second is
// **who authorized it and whether it recurs**.
//
// A check was created by the model through a governed, approved `schedule_task`
// call, minutes or days ago, and fires once. A rule was written into the team
// sheet by an operator, reviewed the way their code is, and stands until the
// sheet changes. Everything between those two facts is the same turn, which is
// `./fired-turn.ts`.
//
// ## One firing, one post, and no row
//
// A check has a database row and reaches a terminal state on it. A rule has
// nothing to stamp: the schedule is in memory, recomputed from the instant it
// fired at, so there is no state that could get out of step and nothing to mark
// as done. That is not an omission — it is the same decision `./ambient.ts` makes
// for the heartbeat, one file over, and it is what makes a restart unable to
// double-fire.
//
// The consequence a channel sees is the difference in the failure notice below.
// A check that could not run says the timer is spent and the team should act. A
// rule that could not run says the rule still stands, because it does: the next
// occurrence is already coming, and telling a team otherwise would send them to
// re-create something that was never lost.
//
// ## Why a failed firing is not retried
//
// It is not retried for the reason a check is not, and one more of its own. A
// rule that came due while the channel was over budget has a next occurrence —
// tomorrow, or Monday — and retrying inside this one would post an answer about
// the wrong window under a label saying otherwise. The right recovery for a
// missed Monday digest is Tuesday's, or a person.
//
// ## What bounds it
//
//   - **The sheet, and nothing else.** A rule exists because an operator wrote
//     it into a file the model cannot write. There is no create to govern, no
//     approval to broker and no ticket to cap, because the reviewed edit is all
//     three.
//   - **One post per firing**, through the same surface, with `source: "rule"` —
//     which does not draw on `HEARTBEAT_POST_WINDOW_MS` and is not blocked by
//     it. The post was bidden; the window governs unbidden speech.
//   - **The grammar.** Occurrences are bounded by `at` and `days`, and rules per
//     sheet by the schema's cap, so a channel's rules cannot exceed 32 posts a
//     day however they are arranged.
//   - **`maySpend`**, asked before the turn, so a channel over its caps spends
//     nothing and is still told (#335).
//   - **The meter**, through the same `SpendReport` path as every other turn.

import { runFiredTurn } from "./fired-turn.js";
import type { FiredTurnSettings } from "./fired-turn.js";
import type { StandingInputs } from "./task.js";
import type { SharedSkillReader } from "./shared-skills.js";
import type { AmbientRule } from "@getlibero/schema";
import type { CompletedTurn, CompletionClient } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import type { AmbientRuleFire } from "./ambient.js";
import type { ProactivePoster } from "../proactive/proactive.js";

/** What the rule fire path needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface RuleSettings extends FiredTurnSettings {
  /**
   * What this channel's standing region is composed from (#450).
   *
   * A rule's turn composes a message a channel reads, so it gets a region for
   * the reason a fired check does: the operator's voice shapes how it reads.
   */
  readonly standing: StandingInputs;
  /** `[ambient] enabled`. False and nothing here runs. Defence, not a path. */
  readonly enabled: boolean;
  /** The channel's model, from `[llm] model` or the process default. */
  readonly model: string;
  /** `[llm] max_tokens_per_turn`. There is no task here to draw a per-task cap from. */
  readonly maxTokens: number;
}

/**
 * Why a rule produced no answer, in the words a channel reads.
 *
 * `CheckFailure`'s two members and its reason for having exactly two: one is a
 * budget an admin can raise or a day that will end, and the other is something
 * broken somebody has to look at. Collapsing them would tell a team its rule
 * failed and give them no idea which.
 *
 * A separate type from `CheckFailure` rather than a shared one, because the two
 * are read in different sentences below and a shared type would invite a shared
 * renderer — which is exactly the thing that must not be shared, since what a
 * team should do next is where a check and a rule differ most.
 */
type RuleFailure = "over_budget" | "failed";

/**
 * What a channel is told when a rule could not run.
 *
 * **Composed here and never by a model**, `renderCheckFailureNotice`'s rule and
 * for its reason: the whole point of this path is that nothing was spent, so a
 * notice needing a model call would defeat the case it exists for.
 *
 * It names the rule, which the check's notice cannot do because a ticket has no
 * name — and here it is the useful half: `standup-digest` is the string an
 * operator greps their sheet for. It quotes the question for the same reason the
 * check's does, and that text is safe in the same way: an operator wrote it into
 * a reviewed file, and `renderProactivePost` escapes and caps it regardless.
 *
 * **The last line is where this differs from a check's notice, and it is the
 * whole point of the separate renderer.** A check says the timer is spent. A rule
 * says it still stands, because it does.
 */
export function renderRuleFailureNotice(rule: AmbientRule, reason: RuleFailure): string {
  const why =
    reason === "over_budget"
      ? "this channel has spent its daily budget, so nothing was run"
      : "it could not be run";
  return [
    `The scheduled rule ${rule.name} came due and did not happen: ${why}.`,
    "",
    `It asks: ${rule.question}`,
    "",
    "The rule still stands and will run again at its next time. If this one mattered,",
    "someone here can do it now."
  ].join("\n");
}

export interface RuleOptions {
  /**
   * How this channel's `load = "always"` shared skills are read (#450).
   *
   * Absent composes no region, which is every deployment with no third root.
   */
  sharedSkills?: SharedSkillReader;
  completion: CompletionClient;
  /** Where an answer goes, and the only posting capability in this process. */
  post: ProactivePoster;
  /** The channel's `[ambient]` block and its model. `null` skips the channel. */
  settings: (channel: string) => Promise<RuleSettings | null>;
  /** Reports the turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /** Whether this channel may be spent for at all (#335). Must not throw. */
  maySpend: (channel: string) => Promise<boolean>;
  logger?: Logger;
  signal?: AbortSignal;
}

/** A reason code from an error, and never its message. The passes' rule. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function createAmbientRuleFire(options: RuleOptions): AmbientRuleFire {
  const logger = options.logger ?? createSilentLogger();

  return async (
    channel: string,
    store: MessageStore,
    rule: AmbientRule,
    dueAt: number
  ): Promise<void> => {
    let settings: RuleSettings | null;
    try {
      settings = await options.settings(channel);
    } catch (error) {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read says nothing and fires nothing, and
      // the rule comes round again at its next occurrence.
      logger.log("warn", { event: "rule_failed", channel, rule: rule.name, reason: reasonOf(error) });
      return;
    }
    // The scheduler enumerates from a sheet read of its own, so reaching here
    // with ambient off is a race rather than a path — and the answer is the same
    // one the block's own switch gives: say nothing.
    if (settings === null || !settings.enabled) return;

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
        question: rule.question,
        // The occurrence rather than the instant the scan reached it, so the id
        // is the same whichever scan fires it and different for the next one.
        // A ticket's id is minted once and this is not, so it is built out of the
        // two things that identify a firing: which rule, and which occurrence.
        turnId: `rule-${rule.name}-${dueAt}`,
        settings
      }
    );

    switch (outcome.kind) {
      case "over_budget":
        // Nothing was spent (#335), and the channel is told anyway — a rule that
        // vanishes silently is the failure this design refused to build, and the
        // notice costs nothing.
        logger.log("info", { event: "rule_declined", channel, rule: rule.name, reason: "over_budget" });
        await tell(channel, rule, "over_budget");
        return;

      case "failed":
        logger.log("warn", { event: "rule_failed", channel, rule: rule.name, reason: outcome.reason });
        await tell(channel, rule, "failed");
        return;

      case "silent":
        // The rule ran and the answer was that there is nothing to say. Not a
        // failure and not a notice — a digest on a quiet week is silence, and
        // saying "nothing happened" every Monday is the noise this avoids.
        logger.log("info", { event: "rule_silent", channel, rule: rule.name });
        return;

      case "aborted":
        return;

      case "answer": {
        const posted = await options.post.post({ channel, text: outcome.text, source: "rule" });
        logger.log("info", {
          event: posted ? "rule_posted" : "rule_unposted",
          channel,
          rule: rule.name
        });
        return;
      }
    }
  };

  /** The one post a firing that produced no answer is allowed. Never throws. */
  async function tell(channel: string, rule: AmbientRule, reason: RuleFailure): Promise<void> {
    await options.post.post({
      channel,
      text: renderRuleFailureNotice(rule, reason),
      // A notice is the firing's one post, not an extra one — and it carries the
      // wake reason it belongs to, so the window still does not govern it.
      source: "rule"
    });
  }
}
