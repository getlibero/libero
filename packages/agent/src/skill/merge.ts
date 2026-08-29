// The merge turn: one model call that drafts a merge of two playbooks, and
// writes nothing (#295).
//
// Authoring grows a library and near-copies land in it, because the author turn
// sees only the skills retrieval had already loaded — so a playbook can be
// written twice by a turn that could not see the first one. The curator's answer
// is a **proposal a person reads**, never a rewrite, because a skill library is
// institutional knowledge and the team owns what it says.
//
// ## It takes no handler, and that is where the guarantee lives
//
// `runSkillAuthorTurn` beside this takes an `applyOp` callback, because authoring
// writes. This takes none: it produces a value and the caller decides what to do
// with it. So "the curator writes no skill file" is not a promise this package
// makes but a shape it has — there is no handler here to be wired to one, and
// `packages/agent` still writes nothing at all. What the caller does with the
// draft is render it into a file nothing ever reads back; the skill files are
// touched by a person or by nobody.
//
// That makes this structurally `runSummarizationTurn` rather than
// `runSkillAuthorTurn`, and the resemblance runs the rest of the way: one
// `complete()`, no loop, no reachable proxied tool, spend reported through
// `onTurn` before the response is read, and a provider failure that propagates
// because this file has no logger.
//
// ## Declining is calling nothing
//
// There is no `merge_none`, for `skill-op.ts`'s reason and one of its own: the
// curator records the pair as *considered* whether or not a draft came back, so
// absence already has somewhere to be written down and a member for it would be
// a second spelling of one fact.
//
// ## The pair is shown in full, and both bodies
//
// A merge replaces the kept skill's body outright, so a model that cannot see
// the body it is replacing can only overwrite it blind — the argument `nearby`
// makes in the author turn, sharper here because there are exactly two documents
// and the whole question is what is in both. `created` and `status` are not
// shown: they are not the model's, they play no part in whether two playbooks are
// one, and the merged skill inherits them from whichever name survives.

import { parseSkillMerge, SKILL_MERGE_TOOL, SKILL_MERGE_TOOL_DEFINITION } from "@getlibero/schema";
import type { SkillMergeDraft, SkillMergeFailure } from "@getlibero/schema";
import type { CompletionClient, TokenUsage, ToolDefinition } from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";

/** One of the two skills, as much of it as this turn shows the model. */
export interface MergeCandidate {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillMergeTurnOptions {
  /**
   * The standing region, when this channel has one (#450).
   *
   * The operator's own text — `[channel] description` and the `load = "always"`
   * shared skills — already composed and already bounded by `apps/server`, with
   * this turn's own prompt as its base. Absent leaves the prompt below exactly
   * as it is, which is every deployment that publishes no shared skill and every
   * channel whose sheet describes itself in no words.
   *
   * **It replaces rather than extends**, because the caller composed the base
   * from the constant this module exports: one composition in one place, rather
   * than a framing sentence written here and again there. The only caller is
   * `apps/server`, and what it may put here is the operator's text — never a
   * model's, which is what keeps a published playbook distinguishable from an
   * instruction this build wrote.
   */
  system?: string;
  completion: CompletionClient;
  model: string;
  /** The nominated pair, in name order. Both are rendered in full. */
  pair: readonly [MergeCandidate, MergeCandidate];
  maxTokens: number;
  turn: number;
  signal?: AbortSignal;
  /**
   * What the turn cost, reported before the draft is read.
   *
   * Required rather than optional, `SummarizationTurnOptions`' rule and its
   * reason: this is spend that follows no mention, so a caller that forgot to
   * meter it would be a caller spending a channel's budget invisibly.
   */
  onTurn: (turn: CompletedTurn) => void | Promise<void>;
}

export interface SkillMergeTurnResult {
  /**
   * The drafted merge, or `null`.
   *
   * `null` with no `unusable` beside it is **the model declining**, which is the
   * ordinary outcome: the pair is the closest two in a library, not two the model
   * agreed were one playbook.
   */
  readonly draft: SkillMergeDraft | null;
  /**
   * Why a call that *was* made produced no draft.
   *
   * Absent when the model simply called nothing. The distinction matters to the
   * caller's log — "the model declined" and "the model could not follow a
   * two-element enum" want different answers from whoever reads it — and it is
   * the same split `summary_failed`/`summary_unusable` already keeps.
   */
  readonly unusable?: SkillMergeFailure;
  readonly usage: TokenUsage;
  readonly model?: string;
}

/**
 * The one tool this turn offers.
 *
 * A function rather than a constant, `skillToolDefinitions()`'s shape: the
 * definition is built from `@getlibero/schema`'s so there is one description and
 * one input schema, and a caller cannot hold a mutable array of them.
 */
export function skillMergeToolDefinition(): ToolDefinition {
  return {
    name: SKILL_MERGE_TOOL,
    description: SKILL_MERGE_TOOL_DEFINITION.description,
    inputSchema: SKILL_MERGE_TOOL_DEFINITION.inputSchema
  };
}

/**
 * What the model is told about the job, above the two playbooks.
 *
 * Four things, each of which a model would otherwise assume the other way, and
 * each of which the tool description also carries — deliberately, because a
 * system prompt frames the task and a tool description is attached to the act,
 * and a model that skims one should still meet the other.
 *
 * The one that is only here is the framing of *why the pair is in front of it*.
 * The nomination rule is "these two are each other's nearest", which on a library
 * of three is a statement about the library rather than about the pair — and a
 * model that believes two playbooks were selected *because they overlap* will
 * find the overlap.
 */
export const SKILL_MERGE_SYSTEM_PROMPT = [
  "You are reviewing two of a team's playbooks to see whether they are one playbook written twice.",
  "",
  "These two were not chosen because anybody judged them similar. They are simply the two",
  "closest to each other in this channel's library, which on a small library means they may be",
  "about entirely different things. Read them and decide.",
  "",
  "Merge them only if they are genuinely one procedure. Two playbooks that touch the same system",
  "while answering different questions must stay two — that distinction is what makes a library",
  "more useful than a pile. If you are not sure, they stay two.",
  "",
  "If they should stay two, call no tool at all. That is the ordinary answer here and it is not a",
  "failure.",
  "",
  "If they are one, draft the merge. You are writing for a person on this team who will read your",
  "draft beside both originals and then apply it by hand, or throw it away. Nothing you do changes",
  "any file. Write the merged playbook as it should read — not a note about how to merge them, and",
  "not one playbook followed by the other. It replaces the kept playbook outright, so everything",
  "worth keeping from either one has to be in it."
].join("\n");

/**
 * One call, and what it drafted.
 *
 * Rejects when the provider does, `runSummarizationTurn`'s rule: this file has no
 * logger, and swallowing here would make a broken provider indistinguishable from
 * a library with no overlaps in it. The caller catches — nothing is waiting on
 * this, and a failure must not reach a person.
 */
export async function runSkillMergeTurn(
  options: SkillMergeTurnOptions
): Promise<SkillMergeTurnResult> {
  const [first, second] = options.pair;

  const response = await options.completion.complete({
    model: options.model,
    system: options.system ?? SKILL_MERGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: pairMessage(first, second) }],
    tools: [skillMergeToolDefinition()],
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  // Before the draft is read, which is every other turn's ordering: what was paid
  // for is counted even if what it bought turns out to be unusable.
  await options.onTurn({
    usage: response.usage,
    turn: options.turn,
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.costNanoUsd === undefined ? {} : { costNanoUsd: response.costNanoUsd })
  });

  const spend = {
    usage: response.usage,
    ...(response.model === undefined ? {} : { model: response.model })
  };

  // The first call by this name, and any other name is ignored rather than
  // reported — `runSummarizationTurn`'s rule: there is no executor here that a
  // second tool could reach, so an invented name is a model talking to itself.
  const call = response.toolCalls.find(candidate => candidate.name === SKILL_MERGE_TOOL);
  if (call === undefined) return { draft: null, ...spend };

  const parsed = parseSkillMerge(call.name, call.arguments, [first.name, second.name]);
  if (!parsed.ok) return { draft: null, unusable: parsed.reason, ...spend };

  return { draft: parsed.draft, ...spend };
}

/**
 * The two playbooks, as the one message this turn sends.
 *
 * Headed by their names because `keep` has to be one of them and a model choosing
 * between two names it was shown a paragraph ago is a model choosing badly. The
 * ask comes last, after both documents, so what it refers to is above it.
 */
function pairMessage(first: MergeCandidate, second: MergeCandidate): string {
  return [
    renderCandidate(first),
    "",
    renderCandidate(second),
    "",
    `The two names are \`${first.name}\` and \`${second.name}\`. If these are one playbook, draft`,
    "the merge and keep whichever of the two names reads correctly for it. If they are not, call",
    "no tool."
  ].join("\n");
}

function renderCandidate(candidate: MergeCandidate): string {
  return [`## \`${candidate.name}\``, "", candidate.description, "", candidate.body].join("\n");
}
