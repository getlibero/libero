// The two operations the skill-author turn may perform on a channel's `skills/`
// directory, and what each of them tells the model about itself (#289).
//
// **These are not proxied tool calls, and they must never become built-ins.**
// The author turn runs in the agent process and writes through `packages/memory`
// to `AGENT_STORE_ROOT/<channel>/skills/`, the root only the agent writes. No
// credential is involved, no upstream is dialled, and nothing crosses the mTLS
// boundary, so there is no `BuiltinToolName` member for either of these and
// nothing in the proxy's built-ins. What governs a skill operation is the caps
// below, the `[skills]` block, and the meter on the turn that emitted it — all
// deterministic; none of it an instruction to the model.
//
// They live in this package for ./skill.ts's reason, which is `memory-op.ts`'s
// reason: the offerer and the executor are two packages that must not see each
// other, so the definitions go to the one they share. The pattern is otherwise
// copied from the memory tools — a zod parser beside a hand-written JSON Schema,
// a round-trip test rather than a generator, and a `Record` over the name enum
// so a third operation cannot be named without being described.
//
// ## Two operations, because a skill is written whole
//
// `MEMORY.md` accretes: an append adds a line and a replace edits one, and there
// is deliberately no operation that rewrites the file. A skill is the opposite
// shape — it is one document, authored in one go — so the natural single
// operation would be a create-or-replace, and that is exactly what must not
// exist. These files are the team's, hand-editable by design, and a lone
// `skill_write` makes silently flattening a playbook somebody rewrote the
// cheapest thing a model can do.
//
// So the model declares which world it expects to find and a mismatch writes
// nothing: `skill_create` fails if the name is taken, `skill_revise` fails if it
// is not. That is `memory_replace`'s exactly-once discipline applied to a whole
// file rather than to a substring.
//
// **Not a discriminated union with an `expect` field**, and the argument is the
// one already made for the memory operations: the discriminant is the tool name
// in the provider's tool-use block, not a field inside the arguments. An inner
// discriminant makes the model write the operation twice with no right answer
// when the two disagree, and each tool is published with its own `inputSchema`,
// which a union's schema describes neither of.
//
// ## What is deliberately not here
//
// **No delete operation and no status operation.** Archiving is the lifecycle
// job's, deleting is the team's act on their own files, and neither is something
// an author turn should be able to reach for after one task.
//
// **No `skill_none`, and declining writes no operation at all.** A thread
// summary has a first-class `nothing` because a row records that the thread was
// *assessed*, and without it the sweep would re-pay for the same thread forever.
// Nothing re-triggers the author turn — it fires once, after a task — so absence
// is the decline, and a member for it would be a row nothing reads.
//
// **No member for a body over `[skills] max_skill_chars`.** That field is at
// least `SKILL_BODY_MAX_CHARS`, so an operation bounded here always fits a
// channel that has not tightened it, and a file that *is* over the cap got there
// by somebody's hand rather than through an operation. Refusing it is the
// indexer's outcome to name, not this vocabulary's.
//
// ## The result vocabulary is skill-local, deliberately
//
// Not new members on `RefusalReason`. A `ToolRefusal` is the sentence a channel
// reads *and* a row's columns rebuilt on the operator's path. A skill operation
// reaches no proxy, is decided by no gate, and writes no audit row, so a reason
// over there would be a member no row could carry. Per CLAUDE.md: nothing merely
// broken should be spelled as a refusal, and this is the third thing again — an
// operation on the agent's own state failing its own bounds.

// **Type-only, and load-bearing rather than tidy** — see the same import in
// ./memory-op.ts. A value import from ./tool-listing.js makes this package's
// module graph circular, and it resolves in an order that leaves `PermittedTool`
// built against an undefined `approval`.
import { z } from "zod";
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SkillName
} from "./skill.js";
import type { ToolInputSchema } from "./tool-listing.js";

/**
 * The two operations, as a closed set.
 *
 * A `z.enum` for `MemoryToolName`'s reason: it makes `SKILL_TOOLS` below a
 * totality check, so a third operation cannot be named without being described
 * to the model.
 *
 * **Not members of `BuiltinToolName` and never to become ones** — see the
 * header. A built-in is a proxied call a team sheet grants and the audit log
 * records; these are neither.
 */
export const SkillToolName = z.enum(["skill_create", "skill_revise"]);

export type SkillToolName = z.infer<typeof SkillToolName>;

/**
 * What the model may send to either operation, parsed strictly.
 *
 * **One shape for both, because the two operations differ in what they expect to
 * find on disk and not in what they carry.** Two structurally identical objects
 * would be two things to keep in step for no gain; the descriptions the model
 * reads do differ, and those live on the two JSON Schemas below.
 *
 * **`.strict()` is the acceptance criterion in executable form**, the way the
 * memory operations' is. "No argument the model controls can reach another
 * channel's skills, or any other file" is true here because there is no `path`,
 * no `file` and no `channel` field to send, and an unknown key is a rejection
 * naming the key rather than one silently dropped. The directory is resolved
 * from the channel the session already is.
 *
 * Strict also enforces the split ./skill.ts's header argues for: there is no
 * `uses`, no `created` and no `status` field, so a model cannot set a clock, mint
 * a date, or archive a skill by writing one. The store stamps `created` and a new
 * skill is `active`; everything else is observation, and observation belongs to
 * whatever did the observing.
 */
export const SkillOpArguments = z
  .object({
    name: SkillName,
    /**
     * What this skill is for, and it is the retrieval surface — see
     * `SKILL_DESCRIPTION_MAX_CHARS`. Required on a revision as well as on a
     * creation, and not for symmetry: a revision that changed the body and kept
     * the old description leaves the index pointing at a skill that no longer
     * exists.
     */
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
    body: z.string().min(1).max(SKILL_BODY_MAX_CHARS)
  })
  .strict();

export type SkillOpArguments = z.infer<typeof SkillOpArguments>;

/**
 * One operation, tagged, as the store executes it.
 *
 * A type with no zod object, for the reason `MemoryOp` has none: it is
 * constructed in-process by `parseSkillOp` and handed straight to the store.
 * There is no boundary at which untrusted bytes become one, and a `.parse()` on
 * this shape would be an invitation to build one.
 *
 * **`name` on a revision is the target, and is never a rename.** A revision
 * names the skill it is revising; changing what a skill is called is a move,
 * which through the index is a change of key that orphans a vector, and it is
 * not something an author turn does. If a skill is misnamed the team renames the
 * file.
 */
export type SkillOp =
  | {
      readonly op: "skill_create";
      readonly name: string;
      readonly description: string;
      readonly body: string;
    }
  | {
      readonly op: "skill_revise";
      readonly name: string;
      readonly description: string;
      readonly body: string;
    };

/**
 * What `parseSkillOp` answers. Never an exception.
 *
 * The four failure reasons are kept apart because they send the model to four
 * different fixes — rename this, shorten the description, shorten the body,
 * you sent the wrong shape — and a model told the wrong one wastes the channel's
 * only author turn for that task.
 */
export type SkillOpParse =
  | { readonly ok: true; readonly op: SkillOp }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown_tool"
        | "malformed_arguments"
        | "name_invalid"
        | "description_too_long"
        | "body_too_long";
    };

/**
 * Turn a tool name and whatever the model put in the arguments into an
 * operation, or into the reason it is not one.
 *
 * Here rather than in `packages/agent` for `parseMemoryOp`'s reason: without it
 * the turn writes its own `switch (name)` and its own reading of zod's issues,
 * and the vocabulary the store answers in stops matching the one the turn speaks
 * on the first edit to either.
 *
 * Never throws. A model emitting nonsense is an ordinary outcome of asking a
 * model for something.
 */
export function parseSkillOp(name: string, args: unknown): SkillOpParse {
  const tool = SkillToolName.safeParse(name);
  if (!tool.success) return { ok: false, reason: "unknown_tool" };

  const parsed = SkillOpArguments.safeParse(args);
  if (!parsed.success) return { ok: false, reason: failureOf(parsed.error) };

  return {
    ok: true,
    op: {
      op: tool.data,
      name: parsed.data.name,
      description: parsed.data.description,
      body: parsed.data.body
    }
  };
}

/**
 * Which of the four a failed parse was.
 *
 * The one piece of cleverness in this module, and it is pinned by tests rather
 * than trusted — `skill-op.test.ts` asserts each distinction directly, so a zod
 * major that renames `too_big` or `invalid_format` fails the suite here instead
 * of quietly telling every model it sent the wrong keys.
 *
 * The name is checked first because it is the most specific fix available and
 * the one a model is least likely to guess: everything else is "that string is
 * too long", where a name is wrong in a way that has an alphabet. A length
 * failure only reports as such when *every* issue is a length failure on the
 * same field, so an oversize body sent alongside a missing description is
 * reported as the shape problem it is.
 */
function failureOf(
  error: z.ZodError
): "malformed_arguments" | "name_invalid" | "description_too_long" | "body_too_long" {
  if (error.issues.some(issue => issue.path[0] === "name")) return "name_invalid";

  const allTooBig = error.issues.every(issue => issue.code === "too_big");
  if (allTooBig && error.issues.every(issue => issue.path[0] === "description")) {
    return "description_too_long";
  }
  if (allTooBig && error.issues.every(issue => issue.path[0] === "body")) {
    return "body_too_long";
  }
  return "malformed_arguments";
}

/**
 * Why an operation did not happen.
 *
 * A skill-local vocabulary rather than members on `RefusalReason` — the header
 * has the argument. The first five are this module's, decided before anything
 * opens a file; the last three are the store's, decided against the directory
 * itself.
 *
 * `name_invalid` is the member the memory operations have no counterpart for,
 * because memory has no model-authored name: there is one `MEMORY.md` per
 * channel and no argument names it.
 */
export const SkillOpFailure = z.enum([
  /** The model called something that is not one of the two operations. */
  "unknown_tool",
  /** The arguments did not parse: a missing field, a wrong type, an unknown key. */
  "malformed_arguments",
  /** The name is not lowercase words joined by single dashes. */
  "name_invalid",
  /** The description was longer than `SKILL_DESCRIPTION_MAX_CHARS`. */
  "description_too_long",
  /** The body was longer than `SKILL_BODY_MAX_CHARS`. */
  "body_too_long",
  /** `skill_create` on a name that already exists. Nothing was written. */
  "name_taken",
  /** `skill_revise` on a name that does not exist. Nothing was written. */
  "skill_not_found",
  /** The channel already holds `[skills] max_skills` skills. Nothing was written. */
  "library_full"
]);

export type SkillOpFailure = z.infer<typeof SkillOpFailure>;

/**
 * What one operation did.
 *
 * A type rather than a zod object, for the reason `SkillOp` is one: the store
 * builds it and the turn reads it, both inside the agent process, and nothing
 * parses it off a wire.
 *
 * Each variant carries exactly the facts its sentence needs, which is
 * `ToolRefusal`'s discipline — the sentence cannot disagree with the outcome if
 * there is nothing in it that was not enumerated here.
 */
export type SkillOpResult =
  | { readonly outcome: "written"; readonly skills: number; readonly limit: number }
  | { readonly outcome: "failed"; readonly reason: "name_taken"; readonly name: string }
  | { readonly outcome: "failed"; readonly reason: "skill_not_found"; readonly name: string }
  | {
      readonly outcome: "failed";
      readonly reason: "library_full";
      readonly skills: number;
      readonly limit: number;
    }
  | {
      readonly outcome: "failed";
      readonly reason: Exclude<
        SkillOpFailure,
        "name_taken" | "skill_not_found" | "library_full"
      >;
    };

/**
 * The sentence the author turn hands back to the model.
 *
 * Total over the union, so a new outcome cannot be added without deciding what
 * the model is told about it — `refusalMessage`'s rule and `memoryOpMessage`'s.
 *
 * **It quotes figures, and `refusalMessage` deliberately does not**, for
 * `memoryOpMessage`'s reason: the reader is the model rather than a person, the
 * number arrives on the same result object rather than from a second read of
 * anything, and knowing how much room is left is what lets a model do something
 * other than retry.
 *
 * **`name_taken`'s sentence names the fix, and that clause is load-bearing.**
 * A model told only that the name exists will try again as `deploy-runbook-2`,
 * which is the near-duplicate proliferation the whole design is trying to
 * prevent, arriving through the failure path. Telling it to revise instead is
 * the difference between a library and a pile.
 *
 * **No file content in any sentence** — not a body, not a description, not a line
 * from an existing skill. A name is echoed because the model just sent it and
 * the sentence is useless without it; nothing that was read off disk is.
 */
export function skillOpMessage(result: SkillOpResult): string {
  if (result.outcome === "written") {
    return `Written. This channel now holds ${result.skills} of ${result.limit} skills.`;
  }

  switch (result.reason) {
    case "unknown_tool":
      return "That is not one of this channel's skill operations. Nothing was written.";
    case "malformed_arguments":
      return "Those arguments do not match the operation's input schema. Nothing was written.";
    case "name_invalid":
      return "A skill's name must be lowercase words joined by single dashes, letters and digits only, such as `rotate-a-channel-certificate`. Nothing was written.";
    case "description_too_long":
      return `A skill's description may carry ${SKILL_DESCRIPTION_MAX_CHARS} characters and this one carried more. Nothing was written. It says when to reach for the skill; the detail belongs in the body.`;
    case "body_too_long":
      return `A skill's body may carry ${SKILL_BODY_MAX_CHARS} characters and this one carried more. Nothing was written. A playbook that does not fit is two playbooks.`;
    case "name_taken":
      return `A skill called ${result.name} already exists. Nothing was written. Read it and use skill_revise to extend it, rather than writing a second skill on the same subject under another name.`;
    case "skill_not_found":
      return `This channel has no skill called ${result.name}. Nothing was written. Use skill_create to write a new one.`;
    case "library_full":
      return `This channel already holds ${result.skills} skills and its cap is ${result.limit}. Nothing was written. Revise an existing skill instead, or ask the team to retire one.`;
  }
}

export interface SkillToolDefinition {
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * The JSON Schemas the model is given, beside the zod parser that enforces them.
 *
 * Two spellings of one contract, which is a drift hazard — `skill-op.test.ts`
 * closes it by asserting the bounds match, exactly as the memory tools' suite
 * does. Generating one from the other would pull a converter into the package
 * every other package imports, to save a test.
 *
 * `additionalProperties: false` mirrors `.strict()`, so a well-behaved model is
 * told the rule rather than only punished for breaking it.
 *
 * The two differ only in their per-field descriptions, because the fields are
 * the same and what changes is what the operation expects to find.
 */
const NAME_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description:
    "Lowercase words joined by single dashes, letters and digits only, naming the subject: `rotate-a-channel-certificate`. Not a title and not a sentence."
} as const;

const BODY_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: SKILL_BODY_MAX_CHARS,
  description:
    "The playbook itself, as markdown: the steps, in order, with the commands and the things that go wrong. Not a transcript of what just happened."
} as const;

const SKILL_CREATE_SCHEMA = {
  type: "object",
  properties: {
    name: NAME_PROPERTY,
    description: {
      type: "string",
      minLength: 1,
      maxLength: SKILL_DESCRIPTION_MAX_CHARS,
      description:
        "One or two sentences saying when to reach for this skill. This is what a later task is matched against, so write the situation, not a summary of the steps."
    },
    body: BODY_PROPERTY
  },
  required: ["name", "description", "body"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

const SKILL_REVISE_SCHEMA = {
  type: "object",
  properties: {
    name: NAME_PROPERTY,
    description: {
      type: "string",
      minLength: 1,
      maxLength: SKILL_DESCRIPTION_MAX_CHARS,
      description:
        "One or two sentences saying when to reach for this skill. Replaces the existing description outright, so restate it even if it has not changed."
    },
    body: BODY_PROPERTY
  },
  required: ["name", "description", "body"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

/**
 * Both operations, by name.
 *
 * A `Record` over `SkillToolName` rather than a `Map`, so adding a member to the
 * enum without describing it here is a type error.
 *
 * ## This text enters a model's context on every author turn
 *
 * It is ours, it cannot change without a commit, and there is no tool-poisoning
 * surface — so, as with the memory tools, it is bounded by review in the diff
 * rather than at runtime. What it has to be is *accurate*, because a description
 * is the only thing standing between a model and an operation it will get wrong.
 * Between them these say five things a model would otherwise assume the other
 * way: a create fails rather than overwrites, a revision replaces the body whole
 * rather than merging into it, the name is an alphabet rather than a title, a
 * revision cannot rename, and no argument names a file — because the alternative
 * to saying so is an author turn that spends itself discovering each one.
 *
 * The clause about writing a playbook rather than a transcript is the one that
 * shapes what a library is worth, and it is here rather than only in the turn's
 * system prompt because this is the text attached to the act itself.
 */
export const SKILL_TOOLS: Record<SkillToolName, SkillToolDefinition> = {
  skill_create: {
    description:
      "Write a new reusable playbook into this channel's skills. " +
      "Use this when the task you have just finished would go faster next time if " +
      "somebody had written down how it is done — a sequence of tool calls that " +
      "worked, in an order that matters, with the parts that are easy to get wrong. " +
      "Not for facts about the team, which belong in MEMORY.md, and not for what " +
      "happened in this particular task. " +
      "The name must not already be in use: this operation fails rather than " +
      "overwriting, and the fix is skill_revise rather than a second name for the " +
      "same subject. " +
      "Skills are markdown files the team can read, edit and delete, and there is " +
      "one directory per channel — no argument names a file, a path, or a channel. " +
      "Both the description and the body are size-capped: an operation past either " +
      "cap is refused and nothing is written, rather than being silently shortened. " +
      "Writing nothing at all is the right answer most of the time.",
    inputSchema: SKILL_CREATE_SCHEMA
  },
  skill_revise: {
    description:
      "Rewrite an existing skill in this channel, by name. " +
      "Use this when what you have just done adds to a playbook that already " +
      "exists — a step that was missing, a failure worth warning about, a command " +
      "that has changed — rather than writing a near-copy under a new name. " +
      "The name must already exist and is the skill being revised: this operation " +
      "cannot rename a skill and cannot create one. " +
      "Both the description and the body replace what was there outright; there is " +
      "no merging and no partial edit, so send the whole skill as it should now " +
      "read, including the parts you are keeping. " +
      "The team may have edited this file since it was written, so read it before " +
      "replacing it. " +
      "Both fields are capped, and an operation past the cap is refused rather than " +
      "truncated.",
    inputSchema: SKILL_REVISE_SCHEMA
  }
};

// **There is no module-load guard on these descriptions, unlike the built-ins'**,
// for the reason ./memory-op.ts states at the same place: that guard exists
// because an over-long built-in description fails `ToolListing.parse` on the
// agent's side and ends a task with "the tool proxy could not be reached". These
// tools never travel in a listing — they are offered directly to the author turn
// and never published by the proxy — so nothing parses them against
// `MAX_TOOL_DESCRIPTION` and an over-long one would cost context rather than a
// task. `skill-op.test.ts` holds them to it anyway, because the cost argument
// stands on its own: a description is re-sent on every turn.
