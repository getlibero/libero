// The one shape an unattended turn takes, shared by the two things that fire on
// a clock (#461).
//
// `./check.ts` runs a ticket somebody approved through the tool proxy service.
// `./rule.ts` runs a standing rule an operator wrote into the team sheet. They
// are governed in different places and they say different things when they fail,
// and in between those two ends they are **the same turn**: ask the meter, read
// the channel's recent messages, run `runScheduledCheckTurn`, and come back with
// one of five outcomes.
//
// ## Why this is a module rather than a flag
//
// #461's claim is that a rule fires `runScheduledCheckTurn`'s *exact* shape, so
// that #348's containment argument — a fired turn induces no served tool calls at
// all — stays true for rules by construction rather than by a second file
// remembering to. A boolean on `./check.ts` would make that claim depend on
// nobody adding a branch under it later; two callers of one function makes it a
// fact about the code.
//
// What is deliberately *not* here is the ends. Posting, the wording of a failure
// notice, and what gets recorded afterwards are the callers', because that is
// exactly where a check and a rule differ: a check has a row to stamp and says
// "this one is done", and a rule has no row and says "the next one is still
// coming". Folding those in would need the flag this module exists to avoid.
//
// ## What a fired turn may do, and what it may not (#348)
//
// **Two shapes, and the channel's sheet picks.** Left alone, a fired turn is
// exactly what it has always been: one bounded model call handed a completion
// client and a list of messages, with one tool that writes nothing, inducing no
// served calls at all. A channel that writes `[ambient] tools = true` gets the
// ReAct loop instead, over the allowlist that sheet already carries.
//
// That was #348, and the decision it turned on is worth having here rather than
// only in the issue. Both of its blocking questions resolved against machinery
// that already existed:
//
//   - **An approval card with nobody to click it.** An unattended turn is handed
//     no prompter, so a held call comes back to the model as the refusal it
//     already is. Because `resolveApproval` holds a destructive *name* by
//     default, the line that draws is read-yes-write-no without anything here
//     deciding what destructive means.
//   - **A pending cap sized against a cheaper unit of work.**
//     `SCHEDULED_TASK_MAX_PENDING` stops being the relevant bound and
//     `[budget] daily_tool_calls` becomes it — which is stronger rather than
//     weaker, since the proxy counts that one from calls it actually served and
//     it therefore holds against a compromised agent process.
//
// **The opt-in is the third answer, and it is the one the issue did not ask
// for.** By the time this landed the turn had two callers, so widening it
// silently would have given every existing channel's checks *and* its standing
// rules a capability their sheets never mentioned. The switch is off by default
// and grants nothing new when it is on: an opted-in turn reaches the same
// allowlist a mention reaches, resolved per call in the proxy from the same file.

import {
  SCHEDULED_CHECK_SYSTEM_PROMPT,
  checkMessage,
  runAgentTask,
  runScheduledCheckTurn
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
import type { MessageStore } from "@getlibero/memory";

/**
 * How much of a channel's recent conversation one fired turn reads.
 *
 * `MAX_HEARTBEAT_MESSAGES`' counterpart and the same figure, because what it
 * bounds is the same thing: a channel skimmed for whether something is the case.
 * A fired turn asks a narrower question than a heartbeat does, but it asks it of
 * the same material, and two numbers for one quantity is how one of them gets
 * read as the other.
 */
export const MAX_FIRED_TURN_MESSAGES = 40;

/**
 * What one firing produced.
 *
 * Five members, and the split is by **what the caller must do next** rather than
 * by what went wrong. `over_budget` and `failed` both mean the channel should be
 * told something, and they stay apart because they send a reader to different
 * places: one is a budget an admin can raise or a day that will end, the other is
 * something broken somebody has to look at. `aborted` is the one member that is
 * not an outcome at all — the process is stopping, so nothing happened and
 * nothing may be recorded as though it had.
 */
export type FiredTurnOutcome =
  | { readonly kind: "over_budget" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "silent" }
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "aborted" };

/** What a fired turn needs from a channel's sheet, whichever caller resolved it. */
export interface FiredTurnSettings {
  /**
   * What this channel's standing region is composed from (#450).
   *
   * The operator's own text, resolved per invocation because their files can
   * change between two of them. See `systemPromptFor` for why a turn that
   * composes something gets a region and one that keeps a record does not.
   */
  readonly standing: StandingInputs;
  /** The channel's model, from `[llm] model` or the process default. */
  readonly model: string;
  /** `[llm] max_tokens_per_turn`. There is no task here to draw a per-task cap from. */
  readonly maxTokens: number;
  /**
   * `[ambient] tools`. Whether this turn runs the loop over the channel's tools
   * (#348).
   *
   * False — the default, and every sheet that has not said otherwise — keeps the
   * single bounded call this always was. What it selects is the *shape of the
   * turn*, not what may be called: the allowlist is the sheet's either way, and
   * the proxy resolves it per call regardless of which shape asked.
   */
  readonly tools: boolean;
  /**
   * The caps a tool-using firing runs under, from `[llm]`.
   *
   * The channel's own, unmodified. A fired turn is not a cheaper kind of task and
   * should not get a second set of numbers to drift from the first — what makes
   * it bounded differently is that nobody is waiting on it, which the caps do not
   * express and the meter does.
   */
  readonly caps: AgentLoopCaps;
}

export interface FiredTurnDeps {
  completion: CompletionClient;
  /**
   * The channel's tool client, built with **no prompter** (#348).
   *
   * A factory rather than a client, because one is pinned to a channel and this
   * module serves every channel — `runTask` builds one per task for the same
   * reason. Absent, a sheet that says `tools = true` gets the single-call shape
   * anyway and says so in the log: a deployment with no transport is not a
   * channel's mistake to be silent about.
   */
  firedTools?: (channel: string) => ToolSource & ToolExecutor;
  /**
   * How this channel's `load = "always"` shared skills are read (#450).
   *
   * Absent composes no region, which is every deployment with no third root.
   */
  sharedSkills?: SharedSkillReader;
  /** Reports the turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /** Whether this channel may be spent for at all (#335). Must not throw. */
  maySpend: (channel: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface FiredTurnRequest {
  readonly channel: string;
  readonly store: MessageStore;
  /** What the turn is asked. A ticket's prompt, or a rule's question. */
  readonly question: string;
  /**
   * The id the meter dedupes on.
   *
   * The caller's, because what makes an id safe differs between them: a ticket
   * has one that was minted once and fires once, and a rule has to build one that
   * is stable across a retry of the same firing and distinct from the next one.
   */
  readonly turnId: string;
  readonly settings: FiredTurnSettings;
}

/** A reason code from an error, and never its message. The passes' rule. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Runs one fired turn. Never rejects.
 *
 * Nothing is posted and nothing is recorded — both are the caller's, for the
 * reason in the header. The meter is asked *before* anything is spent (#335), so
 * a channel over its caps runs no turn and comes back `over_budget` with nothing
 * charged to it.
 */
export async function runFiredTurn(
  deps: FiredTurnDeps,
  request: FiredTurnRequest
): Promise<FiredTurnOutcome> {
  if (!(await deps.maySpend(request.channel))) return { kind: "over_budget" };

  let recent;
  try {
    recent = request.store.recent(MAX_FIRED_TURN_MESSAGES);
  } catch (error) {
    return { kind: "failed", reason: reasonOf(error) };
  }

  const messages: HeartbeatMessage[] = recent.map(row => ({
    // The name captured when the message was stored, falling back to the id:
    // this pass holds no Slack token. `summarize.ts`'s choice.
    author: row.displayName ?? row.userId,
    text: row.text
  }));

  // The opted-in shape (#348). Selected here rather than by two callers, so the
  // two firings stay one turn — which is what makes "a rule fires the check's
  // exact shape" survive this becoming two shapes.
  if (request.settings.tools && deps.firedTools !== undefined) {
    return runToolTurn(deps, request, messages, deps.firedTools(request.channel));
  }

  let result;
  try {
    result = await runScheduledCheckTurn({
      completion: deps.completion,
      model: request.settings.model,
      // The operator's standing region over this turn's own prompt (#450). A
      // fired turn composes a message a channel reads, so what is left for
      // standing text to shape is how it reads.
      system: systemPromptFor(
        {
          description: request.settings.standing.description,
          sharedSkills: standingSkillsFor(
            deps.sharedSkills,
            request.channel,
            request.settings.standing
          )
        },
        SCHEDULED_CHECK_SYSTEM_PROMPT
      ),
      prompt: request.question,
      messages,
      maxTokens: request.settings.maxTokens,
      turn: 1,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      onTurn: async completed => {
        await deps.reportTurn(request.channel, { ...completed, id: request.turnId });
      }
    });
  } catch (error) {
    if (deps.signal?.aborted === true) return { kind: "aborted" };
    return { kind: "failed", reason: reasonOf(error) };
  }

  if (deps.signal?.aborted === true) return { kind: "aborted" };

  // A call that could not be used is a turn that did not happen, so the caller
  // tells the channel — unlike the heartbeat, where the same outcome is a log
  // line, because there nobody was waiting on an answer.
  if (result.unusable !== undefined) return { kind: "failed", reason: result.unusable };

  // The turn ran and the answer was that there is nothing to say. Not a failure
  // and not a notice.
  if (result.finding === null) return { kind: "silent" };

  return { kind: "answer", text: result.finding.text };
}

/**
 * The opted-in shape: the ReAct loop over the channel's own tools (#348).
 *
 * The same five outcomes, arrived at differently. What replaces "the model
 * called the one tool or it did not" is `createFiredTools`' interceptor, which
 * records a `post_finding` call rather than serving it — so silence is still
 * calling no tool, and one post per firing is still structural.
 *
 * **The loop's final text is deliberately discarded.** A mention's task answers
 * in a thread somebody is reading, so its last message is the reply. Nothing is
 * reading this one, and a turn that posted whatever it happened to end on would
 * make every run speak — which is the opposite of an ambient turn's rule. The
 * only way to reach a channel from here is the tool, and not calling it is
 * silence.
 *
 * **Caps end a run rather than failing it.** A firing that hit the tool-call
 * ceiling still posts whatever it recorded before it got there; one that hit it
 * with nothing recorded is silent, not broken. The alternative — treating a cap
 * as a failure and telling the channel — would put a notice in front of a team
 * every time a check was ambitious, which is noise about this process rather
 * than news about their work.
 */
async function runToolTurn(
  deps: FiredTurnDeps,
  request: FiredTurnRequest,
  messages: readonly HeartbeatMessage[],
  client: ToolSource & ToolExecutor
): Promise<FiredTurnOutcome> {
  const tools = createFiredTools({ tools: client });

  try {
    await runAgentTask({
      completion: deps.completion,
      toolSource: tools.source,
      toolExecutor: tools.executor,
      model: request.settings.model,
      // No person asked, and the audit log says so in one word. The task id
      // beside it is the caller's, so a row can still be traced to the firing.
      requestingUser: AMBIENT_REQUESTING_USER,
      taskId: request.turnId,
      system: systemPromptFor(
        {
          description: request.settings.standing.description,
          sharedSkills: standingSkillsFor(
            deps.sharedSkills,
            request.channel,
            request.settings.standing
          )
        },
        SCHEDULED_CHECK_SYSTEM_PROMPT
      ),
      messages: [{ role: "user", content: checkMessage(request.question, messages) }],
      caps: request.settings.caps,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      onTurn: async completed => {
        // Per turn, so a long firing meters as it goes rather than all at the
        // end — `AgentTaskOptions.onTurn`'s own argument, and the reason a
        // channel over its cap is refused starting with the next call.
        await deps.reportTurn(request.channel, {
          ...completed,
          id: `${request.turnId}.${completed.turn}`
        });
      }
    });
  } catch (error) {
    if (deps.signal?.aborted === true) return { kind: "aborted" };
    return { kind: "failed", reason: reasonOf(error) };
  }

  if (deps.signal?.aborted === true) return { kind: "aborted" };

  const outcome = tools.outcome();
  if (outcome.unusable !== undefined) return { kind: "failed", reason: outcome.unusable };
  if (outcome.finding === null) return { kind: "silent" };
  return { kind: "answer", text: outcome.finding.text };
}
