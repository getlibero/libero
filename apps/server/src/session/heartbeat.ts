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
//     offered again — which matters because *what this reads is the one-sided
//     view*. `store.recent` answers with what people said, so nothing in front
//     of this turn records that the agent answered, and without the watermark a
//     question it had already spoken about would look unanswered forever and be
//     raised every window until somebody replied to it.
//
//     #523 stored the agent's replies and **did not retire this**, deliberately.
//     `recent` names `message` alone and `agent_message` is a table of its own,
//     so nothing about what this turn sees has changed. Retiring the watermark
//     would mean giving the heartbeat a second read and a new question — "did I
//     already speak about this thread" — where what it has costs one Slack ts.
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

import {
  AMBIENT_HEARTBEAT_SYSTEM_PROMPT,
  activityMessage,
  runAgentTask,
  runHeartbeatTurn
} from "@getlibero/agent";
import { AMBIENT_REQUESTING_USER } from "@getlibero/schema";
import { createFiredTools } from "./fired-tools.js";
import { standingSkillsFor, systemPromptFor } from "./task.js";
import type { StandingInputs } from "./task.js";
import type { SharedSkillReader } from "./shared-skills.js";
import type {
  AgentLoopCaps,
  CompletedTurn,
  CompletionClient,
  HeartbeatMessage,
  ToolExecutor,
  ToolSource
} from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { PROPOSALS_DIRNAME, skillProposalFilename } from "@getlibero/memory";
import type { MessageStore, SkillPairKey } from "@getlibero/memory";
import type { AmbientHeartbeat } from "./ambient.js";
import { toSlackTs } from "./summarize.js";
import type { ProactivePoster } from "../proactive/proactive.js";
import type { SkillProposalsOpener } from "./proposals.js";

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
  /**
   * What this channel's standing region is composed from (#450).
   *
   * The operator's own text, resolved per invocation because their files can
   * change between two of them. See `systemPromptFor` for why this turn composes
   * a region at all and which two turns deliberately do not.
   */
  readonly standing: StandingInputs;
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
  /**
   * `[ambient] tools`. Whether this evaluation runs the loop over the channel's
   * tools (#471).
   *
   * The **same switch** a fired check and a standing rule read, not one of its
   * own. All three are turns this block fires, and a channel that decided
   * unattended work may look things up did not decide it three times — a second
   * field would be an operator being asked the same question twice and getting
   * to answer it differently by accident.
   *
   * What it selects is the shape of the turn, never what may be called: the
   * allowlist is the sheet's either way, and the proxy resolves it per call.
   */
  readonly tools: boolean;
  /**
   * The caps a tool-using evaluation runs under, from `[llm]`.
   *
   * The channel's own, unmodified — `FiredTurnSettings.caps`' reason: a
   * heartbeat is not a cheaper kind of task and should not get a second set of
   * numbers to drift from the first.
   */
  readonly caps: AgentLoopCaps;
}

export interface HeartbeatOptions {
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
  /**
   * The channel's tool client, built with **no prompter** (#471).
   *
   * `FiredTurnDeps.firedTools`' contract exactly, and the same client: a
   * heartbeat that may look things up is unattended in precisely the way a fired
   * check is, so it is handed the same capability with the same thing left out.
   * Absent, a sheet that opted in gets the single-call shape anyway.
   */
  firedTools?: (channel: string) => ToolSource & ToolExecutor;
  /**
   * How a channel's `proposals/` directory is opened (#320).
   *
   * Optional, and its absence is a deployment whose merge proposals stay a file
   * nobody is told about — which is exactly how phase 3 shipped, and still a
   * real deployment rather than a misconfiguration.
   *
   * It is the *directory* that is consulted and not the index, which is what
   * makes deleting a proposal both the decline and the thing that stops it being
   * announced.
   */
  proposals?: SkillProposalsOpener;
  logger?: Logger;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * What a channel is told about a waiting merge proposal (#320).
 *
 * **Composed here and never by the model**, and that is the load-bearing part.
 * `packages/memory`'s proposal module states as its central decision that no
 * model-authored text in that directory re-enters a model's context — and a
 * notice the model wrote would need the proposal in front of it to write. So
 * this is a template over two skill names, and the heartbeat turn is never shown
 * that a proposal exists at all.
 *
 * It **names the file and the two acts** and reproduces none of the document,
 * which is the review surface staying where it is: the file is what a person
 * reads, and this is a pointer to it. Not a card either — a card is the tool
 * proxy service's mechanic for a held call, and this is not a call.
 *
 * The filename comes from the module that owns the layout rather than being
 * spelled again here.
 */
export function renderProposalNotice(pair: SkillPairKey): string {
  return [
    `A merge proposal is waiting: \`${PROPOSALS_DIRNAME}/${skillProposalFilename(pair)}\``,
    `It suggests folding \`${pair.a}\` and \`${pair.b}\` into one playbook. To apply it, follow`,
    "the steps in the file. To decline, delete the file — nothing else happens either way, and",
    "this is the only time it will be mentioned."
  ].join("\n");
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

    // A proposal nobody has been told about is material in its own right (#320):
    // a tick with no new messages still has something to say. Free — a readdir
    // and one indexed lookup per waiting file, of which there are at most a
    // handful.
    const waiting = firstUnnoticed(channel, store);

    let material;
    let recent;
    try {
      // One row is all the pregate needs: whether anything is there.
      material = store.idleThreads(idleBefore, since, 1);
      recent = material.length === 0 ? [] : store.recent(MAX_HEARTBEAT_MESSAGES);
    } catch (error) {
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      return;
    }

    const weighable = material.length > 0 && recent.length > 0;
    if (!weighable && waiting === null) return;

    let finding: string | null = null;
    if (weighable) {
      // Last of the four, because it is the only one that costs a round trip and
      // everything above it is free. A capped channel evaluates nothing — and
      // does not advance its watermark either, so it weighs the same material
      // once it can afford to.
      //
      // A waiting proposal is *not* gated on this: telling a channel about a
      // file costs nothing, so a channel over its caps still hears about one.
      if (await options.maySpend(channel)) {
        finding = await evaluate(channel, settings, recent);
      }
    }
    if (options.signal?.aborted === true) return;

    // One post, whatever it carries. The window permits one, so a finding and a
    // notice in the same evaluation must not be two — folded, finding first,
    // because that is the timely half and the notice is housekeeping.
    const text = [finding, waiting === null ? null : renderProposalNotice(waiting)]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    // Nothing to say. Whichever branch produced that has already said so — the
    // evaluation logs its own outcome, and a tick that never reached one had no
    // material to reach it with.
    if (text === "") return;

    const posted = await options.post.post({ channel, text, source: "heartbeat" });
    if (posted && waiting !== null) {
      // After the post landed and never before: a notice nobody saw must not
      // count as one. A refused or failed post leaves the row absent, so the
      // proposal is offered again next time the window is open.
      try {
        store.recordSkillMergeNotice(waiting, at);
      } catch (error) {
        logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      }
    }
    logger.log("info", { event: posted ? "heartbeat_posted" : "heartbeat_unposted", channel });
  };

  /**
   * The first waiting proposal this channel has not been told about, or `null`.
   *
   * The **directory** is what is listed, not the index — which is what makes
   * deleting a proposal both the decline and the thing that stops it being
   * announced. A proposal deleted before the notice fires surfaces nothing,
   * because it is not in the listing to be found.
   *
   * Never throws: a directory this process cannot read is a deployment with no
   * proposals to announce, which is the quiet direction.
   */
  function firstUnnoticed(channel: string, store: MessageStore): SkillPairKey | null {
    const open = options.proposals?.(channel);
    if (open === undefined || open === null) return null;

    try {
      for (const pair of open.list()) {
        if (!store.skillMergeNoticed(pair)) return pair;
      }
    } catch (error) {
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
    }
    return null;
  }

  /**
   * One evaluation, over the channel's tools (#471).
   *
   * `evaluate`'s second half, and it keeps that one's two commitments rather
   * than restating them. **The watermark advances exactly once**, on the same
   * rule — whatever the loop produced, including a cap that ended it — because
   * the question the watermark answers is "has this material been weighed", and
   * running the loop answered it. **Silence is still calling no tool**, which
   * `createFiredTools` keeps structural: `post_finding` sits on the list beside
   * the channel's real tools and the model either calls it before stopping or
   * does not.
   *
   * The message is `activityMessage`'s, imported rather than restated, so this
   * shape and the single call put the same question to the model. A heartbeat
   * that weighed differently with tools on would be a channel's behaviour
   * changing for a reason its sheet does not describe.
   */
  async function evaluateWithTools(
    channel: string,
    settings: HeartbeatSettings,
    messages: readonly HeartbeatMessage[],
    turnId: string,
    newest: string | undefined
  ): Promise<string | null> {
    const client = options.firedTools?.(channel);
    if (client === undefined) return null;
    const tools = createFiredTools({ tools: client });

    try {
      await runAgentTask({
        completion: options.completion,
        toolSource: tools.source,
        toolExecutor: tools.executor,
        model: settings.model,
        // No person asked, and the audit log says so in one word (#348).
        requestingUser: AMBIENT_REQUESTING_USER,
        taskId: turnId,
        system: systemPromptFor(
          {
            description: settings.standing.description,
            sharedSkills: standingSkillsFor(options.sharedSkills, channel, settings.standing)
          },
          AMBIENT_HEARTBEAT_SYSTEM_PROMPT
        ),
        messages: [{ role: "user", content: activityMessage(messages) }],
        caps: settings.caps,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onTurn: async completed => {
          await options.reportTurn(channel, { ...completed, id: `${turnId}.${completed.turn}` });
        }
      });
    } catch (error) {
      // The watermark stays put, exactly as it does for a failed single call, so
      // the same material is weighed again rather than skipped because a provider
      // was down.
      logger.log("warn", { event: "heartbeat_failed", channel, reason: reasonOf(error) });
      return null;
    }

    if (newest !== undefined) watermark.set(channel, newest);

    const outcome = tools.outcome();
    if (outcome.unusable !== undefined) {
      logger.log("warn", { event: "heartbeat_unusable", channel, reason: outcome.unusable });
      return null;
    }
    if (outcome.finding === null) {
      logger.log("info", { event: "heartbeat_silent", channel });
      return null;
    }
    return outcome.finding.text;
  }

  /**
   * One evaluation: the model call, the meter, and the watermark.
   *
   * Answers the finding's text, or `null` for silence and for an answer that
   * could not be used — the caller does the same thing with both, which is
   * nothing, and the two are told apart in the log rather than in the type.
   */
  async function evaluate(
    channel: string,
    settings: HeartbeatSettings,
    recent: ReturnType<MessageStore["recent"]>
  ): Promise<string | null> {
    const at = now();
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

    // The opted-in shape (#471). Chosen *here*, after the pregate has already
    // decided there is material and the window is open and the channel can
    // afford it — so a quiet channel still costs a map lookup and a `LIMIT 1`,
    // and never a tool listing. That ordering is the whole reason a brisk cadence
    // is affordable, and it is the one thing this addition must not disturb.
    if (settings.tools && options.firedTools !== undefined) {
      return evaluateWithTools(channel, settings, messages, turnId, newest);
    }

    let result;
    try {
      result = await runHeartbeatTurn({
        completion: options.completion,
        model: settings.model,
        // The operator's standing region over this turn's own prompt (#450).
        // This turn both decides and composes, so the region is present while it
        // weighs whether to speak — which is the operator's own text influencing
        // the operator's own channel, and is the same standing `[ambient]
        // enabled` and `heartbeat_every_minutes` already have.
        system: systemPromptFor(
          {
            description: settings.standing.description,
            sharedSkills: standingSkillsFor(options.sharedSkills, channel, settings.standing)
          },
          AMBIENT_HEARTBEAT_SYSTEM_PROMPT
        ),
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
      return null;
    }

    // Advanced whatever the answer was, including silence: the question "has
    // this been weighed" was answered by running the turn, and a watermark that
    // moved only on a finding would ask the model about the same quiet thread
    // every window forever.
    if (newest !== undefined) watermark.set(channel, newest);

    if (result.unusable !== undefined) {
      // Said apart from silence, which is the split `runHeartbeatTurn` keeps: a
      // broken prompt must not hide inside the outcome that is expected almost
      // every time.
      logger.log("warn", { event: "heartbeat_unusable", channel, reason: result.unusable });
      return null;
    }
    if (result.finding === null) {
      // The ordinary outcome, and the one most heartbeats produce. Logged here
      // rather than by the caller so that a tick has one word for what the turn
      // did — a failed turn that also reported silence would be two claims about
      // one evaluation.
      logger.log("info", { event: "heartbeat_silent", channel });
      return null;
    }
    return result.finding.text;
  }
}
