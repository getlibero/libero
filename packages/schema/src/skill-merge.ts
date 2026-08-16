// The one operation the merge curator may perform, which is to draft — and
// deliberately not to write (#295).
//
// Two playbooks for one procedure land eventually: the author turn sees only the
// skills retrieval had already loaded, so near-copies are written by a turn that
// could not see the copy. The curator's answer is a **proposal a person reads**,
// never a rewrite, because a skill library is institutional knowledge and the
// team owns what it says.
//
// ## What is not here, and why the list is the point
//
// **No handler, no path, no filename, no delete field.** This operation carries
// three bounded strings and nothing else. What applies a merge is a person with
// an editor; what this produces is a document, and the only thing on the far end
// of it is `renderMergeProposal` in `packages/memory`, which builds the filename
// from the *nominated pair* rather than from anything below. So the worst a
// poisoned skill body can talk this turn into is three strings of bounded length
// in a file nothing reads back.
//
// **No second operation for "these do not overlap".** Declining is calling no
// tool at all, which is `skill-op.ts`'s rule and is stronger here: the curator
// records the pair as considered whether or not a draft came back, so absence
// already has a place to be written down and a member for it would be a second
// spelling of the same fact.
//
// **No `skillMergeMessage`.** `skillOpMessage` exists because the author turn
// hands a result back to the model on the same conversation. This turn is one
// call with no tool-result round trip and nobody to answer, so a sentence for the
// model would be a sentence nothing reads.
//
// ## Why this is a separate file, and not a third `SkillToolName`
//
// `SkillToolName` is a `z.enum` whose totality drives `SKILL_TOOLS`, and
// `skillToolDefinitions()` in `packages/agent` maps over its options to build the
// tool list the **author** turn is offered. A third member would therefore hand
// the author turn a tool that writes nothing and names a pair it was never given
// — a behaviour change wearing a definition's clothes. The vocabularies stay
// apart, and `skill-merge.test.ts` asserts `SkillToolName.options` is still
// exactly the two.
//
// ## `keep` is checked against the pair here rather than in the turn
//
// `parseSkillMerge` takes the two names that were nominated, for `parseSkillOp`'s
// reason: without it the turn writes its own comparison and its own reading of
// zod's issues, and the vocabulary the caller answers in stops matching the one
// the parser speaks on the first edit to either. It also puts the design decision
// — a merged skill keeps one of the two source names, so that the survivor's use
// counts and the date it first appeared survive the merge — somewhere executable
// rather than only in prose.

// Type-only, and load-bearing rather than tidy — ./skill-op.ts's import and its
// reason: a value import from ./tool-listing.js makes this package's module graph
// circular.
import { z } from "zod";
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS, SkillName } from "./skill.js";
import type { SkillToolDefinition } from "./skill-op.js";
import type { ToolInputSchema } from "./tool-listing.js";

/**
 * The tool's name.
 *
 * A bare constant rather than a `z.enum`, because there is one of them and an
 * enum of one is a totality check over a `Record` with a single key. The moment
 * there are two, this becomes an enum and gets a `Record` — see ./skill-op.ts.
 */
export const SKILL_MERGE_TOOL = "propose_skill_merge";

/**
 * What the model may send, parsed strictly.
 *
 * `.strict()` for `SkillOpArguments`' reason and one of its own: an unknown key
 * here is not a field nobody bounded but a field somebody *tried* — this turn
 * runs over two skill bodies that may have been written by anyone, so the shape
 * is the boundary and it refuses rather than strips.
 */
export const SkillMergeArguments = z
  .object({
    /**
     * Which of the two nominated names the merged playbook keeps.
     *
     * A `SkillName` first and one of the two second, in that order, so a value
     * that could never be a filename is reported as a bad name rather than as a
     * bad choice. Nothing downstream builds a path from this — see the header —
     * so the alphabet is a courtesy to the model rather than a defence.
     */
    keep: SkillName,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
    body: z.string().min(1).max(SKILL_BODY_MAX_CHARS)
  })
  .strict();

export type SkillMergeArguments = z.infer<typeof SkillMergeArguments>;

/**
 * One drafted merge.
 *
 * A type rather than a zod object, for `SkillOp`'s reason: it is built by the
 * parser below and handed to the renderer, both inside the agent process, and
 * there is no boundary at which untrusted bytes become one without going through
 * `parseSkillMerge`.
 *
 * **`drop` is derived here rather than by the caller.** It is the other one of a
 * two-element set, which is a thing every caller could work out and one of them
 * would eventually work out backwards.
 */
export interface SkillMergeDraft {
  /** The name the merged skill keeps. One of the two that were nominated. */
  readonly keep: string;
  /** The other one. The file a person deletes when they apply the proposal. */
  readonly drop: string;
  readonly description: string;
  readonly body: string;
}

/**
 * Why a call produced no draft.
 *
 * Skill-local rather than members on `RefusalReason`, for ./skill-op.ts's stated
 * reason: nothing here reaches a proxy, is decided by a gate, or writes an audit
 * row, so a reason over there would be a member no row could carry.
 *
 * The first five are `SkillOpFailure`'s first five, spelled the same on purpose —
 * an operator grepping one vocabulary should not find two words for one thing.
 * `keep_not_nominated` is this operation's own, and it is the only member that
 * describes a *choice* rather than a shape.
 */
export const SkillMergeFailure = z.enum([
  /** The model called something other than `propose_skill_merge`. */
  "unknown_tool",
  /** The arguments did not parse: a missing field, a wrong type, an unknown key. */
  "malformed_arguments",
  /** `keep` is not lowercase words joined by single dashes. */
  "name_invalid",
  /** The description was longer than `SKILL_DESCRIPTION_MAX_CHARS`. */
  "description_too_long",
  /** The body was longer than `SKILL_BODY_MAX_CHARS`. */
  "body_too_long",
  /** `keep` parses as a name, but is neither of the two skills the turn was given. */
  "keep_not_nominated"
]);

export type SkillMergeFailure = z.infer<typeof SkillMergeFailure>;

/**
 * What `parseSkillMerge` answers. Never an exception.
 */
export type SkillMergeParse =
  | { readonly ok: true; readonly draft: SkillMergeDraft }
  | { readonly ok: false; readonly reason: SkillMergeFailure };

/**
 * One tool call and the pair it was asked about, into a draft or the reason it is
 * not one.
 *
 * Three gates in order, and the order is the contract: an unrecognized tool, then
 * the shape, then the choice. A `keep` of `../../etc/passwd` therefore reports as
 * `name_invalid` rather than as `keep_not_nominated`, because "that is not a
 * name" is the more specific and more actionable of the two true statements.
 *
 * Never throws. A model emitting nonsense is an ordinary outcome of asking a
 * model for something.
 */
export function parseSkillMerge(
  tool: string,
  args: unknown,
  nominated: readonly [string, string]
): SkillMergeParse {
  if (tool !== SKILL_MERGE_TOOL) return { ok: false, reason: "unknown_tool" };

  const parsed = SkillMergeArguments.safeParse(args);
  if (!parsed.success) return { ok: false, reason: failureOf(parsed.error) };

  const [first, second] = nominated;
  const keep = parsed.data.keep;
  if (keep !== first && keep !== second) return { ok: false, reason: "keep_not_nominated" };

  return {
    ok: true,
    draft: {
      keep,
      drop: keep === first ? second : first,
      description: parsed.data.description,
      body: parsed.data.body
    }
  };
}

/**
 * Which of the four shape failures a failed parse was.
 *
 * `skill-op.ts`'s `failureOf`, copied rather than shared, and the copy is the
 * decision: that one discriminates on a `name` field and this one on `keep`, so a
 * shared helper would have to take the field name as an argument and would then
 * be a helper that cannot be read without knowing its caller. Both are pinned by
 * their own tests, which is what keeps a zod major from quietly telling every
 * model it sent the wrong keys.
 */
function failureOf(
  error: z.ZodError
): "malformed_arguments" | "name_invalid" | "description_too_long" | "body_too_long" {
  if (error.issues.some(issue => issue.path[0] === "keep")) return "name_invalid";

  const allTooBig = error.issues.every(issue => issue.code === "too_big");
  if (allTooBig && error.issues.every(issue => issue.path[0] === "description")) {
    return "description_too_long";
  }
  if (allTooBig && error.issues.every(issue => issue.path[0] === "body")) {
    return "body_too_long";
  }
  return "malformed_arguments";
}

const SKILL_MERGE_SCHEMA = {
  type: "object",
  properties: {
    keep: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "Which of the two playbook names the merged skill keeps. Must be exactly one of the two names you were shown, and nothing else."
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: SKILL_DESCRIPTION_MAX_CHARS,
      description:
        "One or two sentences saying when to reach for the merged playbook. This is what a later task is matched against, so write the situation it covers, not a summary of its steps."
    },
    body: {
      type: "string",
      minLength: 1,
      maxLength: SKILL_BODY_MAX_CHARS,
      description:
        "The merged playbook, as markdown. It replaces the kept skill's body outright, so it must carry everything worth keeping from BOTH — not only the parts that differ. Not two playbooks one after the other."
    }
  },
  required: ["keep", "description", "body"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

/**
 * The tool the merge turn is offered, and the only one.
 *
 * ## This text enters a model's context on every merge turn
 *
 * It is ours, it cannot change without a commit, and there is no tool-poisoning
 * surface — so it is bounded by review in the diff, exactly as `SKILL_TOOLS` is.
 * What it has to be is *accurate*, and four clauses here are load-bearing because
 * a model would otherwise assume each of them the other way.
 *
 * **That this writes nothing.** Every other tool a model in this system is handed
 * does something when called. A model that believes this one merges files will
 * write a body meant to be applied silently rather than read by a person.
 *
 * **That declining is the ordinary answer.** The pair was chosen as the closest
 * two in the library, which on a small library means the closest two of three —
 * so most pairs are not one playbook, and a model asked to merge will merge.
 *
 * **That overlap is not the test.** Two playbooks about the same system answering
 * different questions must stay two; that is the distinction between a library
 * and a pile.
 *
 * **That the body replaces the kept skill outright.** A merged body that carries
 * only the differences leaves a playbook with its middle removed, and a person
 * applying the proposal would not necessarily notice.
 */
export const SKILL_MERGE_TOOL_DEFINITION: SkillToolDefinition = {
  description:
    "Draft a merge of the two playbooks you have been shown into one. " +
    "THIS WRITES NOTHING. It produces a proposal that a person on this team reads " +
    "and then applies by hand, or deletes. No file changes because you called it, " +
    "and nothing is applied without a human doing it. " +
    "Call this only if the two really are one playbook written twice. Overlapping " +
    "subject matter is not enough: two playbooks that touch the same system while " +
    "answering different questions must stay two. The two you were shown are " +
    "simply the closest pair in this channel's library, which on a small library " +
    "means they may be unrelated. " +
    "If they are not one playbook, call no tool at all. That is the ordinary " +
    "answer and it costs nothing. " +
    "The merged skill keeps one of the two existing names so that its history — " +
    "how often it has been used, and when it first appeared — survives the merge. " +
    "Choose whichever of the two names reads correctly for the merged subject.",
  inputSchema: SKILL_MERGE_SCHEMA
};
