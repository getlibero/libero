// The heartbeat evaluation: is anything in this channel worth saying (#319).
//
// The fifth turn in this package that is not the ReAct loop, and the first one
// whose output is addressed to *people who did not ask*. Curation, the skill
// author and the merge curator all write into a team's own files; the
// summarization turn writes a row. This one produces a sentence that will appear
// in a channel unprompted, and everything about its shape follows from that.
//
// ## It is not triggered by a person, and its ordinary answer is nothing
//
// `runSummarizationTurn`'s first sentence and one step further. That turn runs
// when a thread has gone quiet, in a channel whose members may never have
// addressed the agent. This one runs on a clock, and the honest answer almost
// every time is that nothing has changed. `[ambient] enabled` is where a channel
// says no to it at all, and it is off unless a sheet wrote otherwise.
//
// **Silence is calling no tool.** There is no sentinel to emit and no `silent`
// member to parse, which is `parseAmbientFinding`'s rule — so a malformed call,
// an invented tool name and a paragraph of prose all come back as no finding, by
// construction rather than by a branch. The alternative would need a rule for
// "neither the sentinel nor a finding", and the only safe answer to that is
// silence anyway.
//
// ## What governs it is not the prompt
//
// `AMBIENT_HEARTBEAT_SYSTEM_PROMPT` below asks for restraint, and a model that
// ignores every word of it is still bounded — by things it cannot reach:
//
//   - **One tool, which writes nothing.** This turn takes no handler, which is
//     `runSkillMergeTurn`'s guarantee in its strongest form: nothing in this
//     package can post to a channel, so "the model cannot make itself heard by
//     calling something" is a shape rather than a promise. What posts is
//     `apps/server`'s rate-limited surface, and it is the caller's to hold.
//   - **The rate window.** At most one heartbeat post per channel per window,
//     enforced where the post is made. The model is never told it has been
//     refused, and cannot ask.
//   - **The pregate.** The caller decides there is something to weigh before
//     paying for this turn at all, so a quiet channel never reaches here.
//   - **The meter.** Its tokens report through the same `SpendReport` path every
//     other turn takes.
//
// ## What it is shown
//
// Recent activity, already bounded by the caller — `runSummarizationTurn`'s
// division, where the turn renders and the pass decides how much. Attribution is
// by name so the model can tell speakers apart, which is what makes "nobody has
// answered Priya" a thing it can notice at all.
//
// It is **not** told which threads the pregate found idle, and that is
// deliberate. Handing it the answer would make the finding a formality — the
// model would report what the SQL already decided, and the case the design
// actually wants (a deadline nobody picked up, a thread stalled on something
// answerable) would be the one it stopped looking for.

import { AMBIENT_FINDING_TOOL, AMBIENT_FINDING_TOOL_DEFINITION, parseAmbientFinding } from "@getlibero/schema";
import type { AmbientFinding, AmbientFindingFailure } from "@getlibero/schema";
import type { CompletionClient, ToolDefinition, TokenUsage } from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";

/** One message of the activity the turn weighs. `SummarizationMessage`'s shape. */
export interface HeartbeatMessage {
  readonly author: string;
  readonly text: string;
}

export interface HeartbeatTurnOptions {
  completion: CompletionClient;
  model: string;
  /**
   * The channel's recent activity, oldest first, already capped by the caller.
   *
   * Empty is not something this turn defends against, because the caller's
   * pregate is what decides there is anything here at all — and a heartbeat
   * asking a model to weigh nothing is a bug in the pass rather than an input
   * this turn should quietly absorb.
   */
  messages: readonly HeartbeatMessage[];
  maxTokens: number;
  turn: number;
  signal?: AbortSignal;
  /**
   * What the turn cost, reported before the answer is read.
   *
   * Required rather than optional, `SummarizationTurnOptions`' rule and its
   * reason, which is at its sharpest here: this is spend that follows no mention
   * *and* produces no artefact a person would notice missing, so a caller that
   * forgot to meter it would be a caller spending a channel's budget on a clock
   * with nothing to show for it.
   */
  onTurn: (turn: CompletedTurn) => void | Promise<void>;
}

export interface HeartbeatTurnResult {
  /**
   * What to post, or `null`.
   *
   * `null` with no `unusable` beside it is **the model saying nothing**, which
   * is the ordinary outcome and the one most heartbeats produce.
   */
  readonly finding: AmbientFinding | null;
  /**
   * Why a call that *was* made produced no finding.
   *
   * Absent when the model simply called nothing. `SkillMergeTurnResult`'s split
   * and its reason: "the channel is quiet" and "the model could not follow a
   * one-field schema" want different answers from whoever reads the log, and
   * collapsing them would hide a broken prompt inside the expected silence.
   */
  readonly unusable?: AmbientFindingFailure;
  readonly usage: TokenUsage;
  readonly model?: string;
}

/**
 * The one tool this turn offers.
 *
 * A function rather than a constant, `skillMergeToolDefinition()`'s shape: built
 * from the schema package's definition so there is one description and one input
 * schema, and a caller cannot hold a mutable one.
 */
export function ambientFindingToolDefinition(): ToolDefinition {
  return {
    name: AMBIENT_FINDING_TOOL,
    description: AMBIENT_FINDING_TOOL_DEFINITION.description,
    inputSchema: { ...AMBIENT_FINDING_TOOL_DEFINITION.inputSchema }
  };
}

/**
 * What the model is told about the job, above the activity.
 *
 * Three things, each of which a model would otherwise assume the other way, and
 * each of which the tool description also carries — deliberately, on
 * `SKILL_MERGE_SYSTEM_PROMPT`'s reasoning: a system prompt frames the task and a
 * tool description is attached to the act, and a model that skims one should
 * still meet the other.
 *
 * The one that is only here is **who the agent is in this channel**. Every other
 * turn in this system runs because somebody addressed the agent, so the model
 * arrives with the framing that it has been asked. Here it has not, and a model
 * that does not know that will answer the most recent question it can find.
 */
export const AMBIENT_HEARTBEAT_SYSTEM_PROMPT = [
  "You are looking over a team's channel on a timer. Nobody has asked you anything.",
  "",
  "Your job is to decide one thing: is there something here worth interrupting these people",
  "about? Almost always there is not, and saying nothing is the right answer. A quiet channel,",
  "a conversation that is going fine without you, a question somebody has already answered —",
  "none of those need you.",
  "",
  "Say something only when it would genuinely help: a question that has sat unanswered long",
  "enough that the people it was addressed to have plainly not seen it, a deadline or a",
  "commitment nobody has picked up, a thread that stalled on something you can unblock. If you",
  "are weighing whether it is worth it, it is not.",
  "",
  "Do not answer a question that was asked a moment ago. The people it was addressed to should",
  "get to answer it first — if somebody wants you, they will address you directly, and that is",
  "the designed path.",
  "",
  "If nothing merits it, call no tool and write nothing. That is the expected outcome and it is",
  "not a failure.",
  "",
  "If something does, call post_finding with what you want to say. It goes into the channel as a",
  "message from you, unprompted, so write it for the people there: say what you noticed and what",
  "you think should happen. Keep it short."
].join("\n");

/**
 * One evaluation. Rejects only if the provider does.
 *
 * A rejection propagates, `runSkillMergeTurn`'s rule: this file has no logger,
 * and swallowing here would make a broken provider indistinguishable from the
 * silence that is the ordinary answer — which is the one failure this turn is
 * least able to notice, because silence is what it produces almost every time.
 */
export async function runHeartbeatTurn(
  options: HeartbeatTurnOptions
): Promise<HeartbeatTurnResult> {
  const response = await options.completion.complete({
    model: options.model,
    system: AMBIENT_HEARTBEAT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: activityMessage(options.messages) }],
    tools: [ambientFindingToolDefinition()],
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  // Before the answer is read, which is every other turn's ordering: what was
  // paid for is counted even if what it bought turns out to be unusable.
  await options.onTurn({
    usage: response.usage,
    turn: options.turn,
    ...(response.model === undefined ? {} : { model: response.model })
  });

  const spend = {
    usage: response.usage,
    ...(response.model === undefined ? {} : { model: response.model })
  };

  // The first call by this name, and any other name is ignored rather than
  // reported — `runSummarizationTurn`'s rule: there is no executor here that a
  // second tool could reach, so an invented name is a model talking to itself.
  const call = response.toolCalls.find(candidate => candidate.name === AMBIENT_FINDING_TOOL);
  if (call === undefined) return { finding: null, ...spend };

  const parsed = parseAmbientFinding(call.name, call.arguments);
  if (!parsed.ok) return { finding: null, unusable: parsed.reason, ...spend };

  return { finding: parsed.finding, ...spend };
}

/**
 * The activity, as the one message this turn sends.
 *
 * Untrusted text, in a `user` message, inside a block that says what it is —
 * `assembleContext`'s rule in `apps/server`. The ask comes last, after the
 * transcript, so what it refers to is above it.
 */
function activityMessage(messages: readonly HeartbeatMessage[]): string {
  return [
    "Recent activity in this channel, oldest first:",
    "",
    ...messages.map(line => `${line.author}: ${line.text}`),
    "",
    "Is there anything here worth saying something about, unprompted? If not, call no tool."
  ].join("\n");
}
