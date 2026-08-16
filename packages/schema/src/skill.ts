// What a skill file is: the frontmatter a channel's `skills/*.md` carries, the
// name that becomes its filename, and the grammar both halves of that file are
// read and written by (#289).
//
// **This lives here for `memory-op.ts`'s reason, and the shape of the problem is
// the same.** The author is `packages/agent`, which runs the turn, and the
// executor is `packages/memory`, which writes the file and indexes it — and
// those two must not import each other, because the memory package is an
// ESLint-enforced leaf that both services open. The only module both ends
// already see is this one. The architecture diagram has promised `skills/` a
// place in the agent state root since phase 1, beside `MEMORY.md` and
// `store.db`.
//
// ## The file is not the whole truth about a skill, and the split is a rule
//
// A skill has two kinds of fact attached to it and they live in two places:
//
// - **The file is the source of truth for everything a human authored**: what
//   the skill says, what it is called, what it is for, and what status the team
//   wants it in.
// - **The index is the source of truth for everything the runtime observed**
//   about that file: when it was last retrieved, how often, when this store
//   first saw it, and its vector.
//
// Reconciliation reads files and never writes them. That is the same split
// `thread_summary` already keeps against `message`, and it is why `uses` is
// **not** in the frontmatter below even though the architecture page named it
// there.
//
// **The argument is write rate, and only write rate.** Retrieval records a use
// at the head of every task, for every skill it loaded. In frontmatter that is
// `top_k` rename-over-file writes to team-owned markdown per task, each one a
// read-compute-rename with a documented cross-process lost-update window and
// deliberately no lock (`packages/memory/src/memory-file.ts`). Say *rate*,
// because the lifecycle job does write `status` into these same files — through
// `SkillFiles.setStatus`, and only where a clock moved — so the principle
// version of this ("machinery does not rewrite the team's files") is not the
// rule and is false as of #294.
//
// Two arguments that look like they support the same conclusion are wrong and
// should not be reached for. That a hand-editable counter would be *falsifiable*
// is not a hazard: a team pinning a skill by hand is a feature the lifecycle job
// is required to respect, so the team influencing the clocks is the design.
// And this is not the "one fact stored N times is N-1 chances to disagree" rule
// that kept the embedding model out of every vector row — that is about one fact
// in N rows, not about a file and an index holding different kinds of thing.
//
// ## No lifecycle clock reads this file
//
// `created` below is model-authored, hand-editable text. A model writing
// `created: 2099-01-01`, or somebody correcting what they took for a typo, must
// not be able to move an archival clock. So `created` is **documentation** — it
// is here because the spec names it and because a human opening the directory
// wants it, and nothing reads it to decide anything. The index stamps its own
// `first_seen_at` when it first sees a file, in the shape `embedding_source.at`
// already uses, and a never-used skill clocks from that.
//
// The corollary for whoever writes the index: a body edit re-embeds the skill,
// because the vector is derived from its text, but it does **not** reset the use
// counters. Those are observations about the skill, not about its current
// wording, and resetting them would silently un-archive every skill the team
// touched.
//
// ## Not a tool, and not proxied
//
// Nothing here is a `BuiltinToolName` and nothing crosses the mTLS boundary, for
// `memory-op.ts`'s reasons: the turn runs in the agent process against the store
// the agent already owns, no credential is involved, and no upstream is dialled.
// What governs it is the caps in ./skill-op.ts, the `[skills]` block in
// ./team-sheet.ts, and the meter on the turn that emitted it — all deterministic;
// none of it an instruction to a model.

import { z } from "zod";

/**
 * The alphabet a skill's name is written in.
 *
 * Lowercase letters and digits in groups, joined by single hyphens. Stricter
 * than `ChannelId` in ./names.ts on purpose, and each exclusion earns its place
 * against a hazard that one does not have.
 *
 * **Lowercase only, because the name becomes a filename and half the world's
 * filesystems fold case.** `Deploy-Runbook.md` and `deploy-runbook.md` are one
 * file on macOS's default filesystem and two on ext4, so a create that "already
 * exists" on a maintainer's laptop would succeed in the container — by silently
 * overwriting a different skill. `ChannelId` permits mixed case and gets away
 * with it because a channel id is provisioned once by an operator; this name is
 * chosen by a model, semantically, from the subject of a task, so both spellings
 * genuinely will be proposed.
 *
 * **One separator, because two spellings of one name is what the storage layer
 * would then have to detect and refuse.** Admit `_` alongside `-` and
 * `deploy_runbook` and `deploy-runbook` are two files that read as one skill to
 * a person, to retrieval, and to anything looking for near-duplicates.
 *
 * **No dot**, which is not about `.hidden` or `..` — the leading-character rule
 * excludes both, exactly as `CHANNEL_ID_PATTERN` does. It is that a model
 * allowed a dot will write `deploy.md`, and the mapping adds `.md` of its own.
 *
 * What this buys is worth more than the sum of the three: **a name that parses
 * is already canonical**, so it is the filename stem on every filesystem, there
 * is no slug function and no normalized form for a real name to collide with,
 * and nothing can drift between the two. `normalizeCertificateSha256` exists
 * next door only because two written forms of a fingerprint were already in the
 * world before this repo was; nothing forces that here, so nothing here folds.
 *
 * Rejecting rather than folding is also what keeps the model's own vocabulary
 * consistent: silently slugging `Deploy Runbook` on the way in means the model's
 * next call, naming the skill it thinks it created, matches nothing.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What a skill is called — the one name here that is also a path segment and an
 * index key.
 *
 * Load-bearing rather than hygiene, for `ChannelId`'s reason and in its shape.
 * It lives in this package because two places need the same answer: the turn
 * that offers the operation and the store that maps a name to
 * `skills/<name>.md`. The store asks rather than reimplements, the way the
 * server's sheet resolver asks `ChannelId` before it joins a path.
 *
 * **The `.md` is not part of the name.** The name is what every failure sentence
 * says, what the model uses to revise what it wrote, and what the index keys on;
 * an extension in that vocabulary makes `deploy` and `deploy.md` two names for
 * one skill. The filename is the storage layer's business and belongs to it
 * privately, the rule `MEMORY.md`'s own filename already keeps.
 *
 * Bounded at 64, matching the identifiers next door. A name is a subject, not a
 * sentence: the sentence is `description`.
 */
export const SkillName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    SKILL_NAME_PATTERN,
    "must be lowercase words joined by single dashes: letters and digits only"
  );

export type SkillName = z.infer<typeof SkillName>;

/**
 * The most text one skill's body may hold, in characters.
 *
 * A constant rather than a team-sheet field, following `MEMORY_OP_MAX_TEXT_CHARS`
 * and `SUMMARY_MAX_TEXT_CHARS`: it bounds what the *model* may write, not what a
 * channel may spend, and that class lives in constants here. The figure an
 * operator does hold an opinion about — how long a body may be once a human has
 * written one — is `[skills] max_skill_chars` in ./team-sheet.ts, and it may
 * only be larger.
 *
 * 4096 characters: one memory operation, twice a thread summary. The lower bound
 * is that a playbook is *steps* where a summary is a conclusion, so it needs the
 * room a summary does not. The upper bound is retrieval, and it is
 * `SUMMARY_MAX_TEXT_CHARS`'s argument unchanged — one vector stands for the
 * whole skill, so a longer skill is a vector averaged over more procedures, and
 * past a point it is retrieved by everything and answers nothing. A playbook that
 * does not fit is two playbooks.
 *
 * Characters rather than bytes, continuing every other bound in this package:
 * checkable on a JS string before anything is encoded, which is what lets the
 * published JSON Schema state the same figure to the model.
 */
export const SKILL_BODY_MAX_CHARS = 4_096;

/**
 * The most text a skill's description may hold, in characters.
 *
 * **This is the retrieval surface**, which is why it is bounded here rather than
 * left to whatever a model felt like writing. The description says when to reach
 * for a skill, which is what an incoming request is matched against; the body
 * holds the specific strings — a command, an error message — that lexical search
 * is better at than a vector averaged over a procedure. So the description is
 * what is embedded, and the body joins it only in the full-text index.
 *
 * 512 characters is one or two sentences. Longer and it stops being a statement
 * of when this skill applies and starts being a summary of the skill, which is
 * what the body is for and what makes a vector unselective.
 */
export const SKILL_DESCRIPTION_MAX_CHARS = 512;

/**
 * Where a skill is in its life.
 *
 * A closed set, and a short one on `SummaryShape`'s admission test: a member has
 * to be a state something *does something different about*. `deprecated` was
 * considered and rejected on it — it is `archived` said in the team's voice, and
 * retrieval treats the two identically, so it would add a distinction a model
 * and a team can disagree about without adding anything a query can reach.
 *
 * There is no `pinned`. A team pinning a skill against the clock is real and the
 * lifecycle job is required to honour it, but it is not a *state* — it is the
 * job knowing which of them last spoke, which is a fact about the job and lives
 * where the job's other observations live. That is `skill_use.status_by_job` and
 * `status_by_job_at`, and the rule they encode, as #294 landed it:
 *
 * - **The job compares values, not timestamps.** A file whose `status` differs
 *   from `status_by_job` is a status somebody else wrote, and a missing row is
 *   the job having never spoken here. In both cases it *adopts* — it records the
 *   file's status as its new baseline and changes no file that run.
 * - **Adopting restamps `status_by_job_at`, and that stamp is part of the
 *   clock.** The origin a skill ages from is
 *   `max(last_used_at ?? first_seen_at, status_by_job_at)`, so a hand edit buys
 *   a full stale window before the clock speaks again. Without it, a team
 *   un-archiving a long-unused skill would watch the job re-archive it a cycle
 *   later, which is fighting the team rather than respecting them.
 * - **The job's own move does not restamp `status_by_job_at`.** That asymmetry
 *   is load-bearing: the clock is what its decisions are made against, so a job
 *   that reset the clock every time it acted could never reach its second
 *   threshold — a skill marked stale at thirty days would archive at a hundred
 *   and twenty rather than ninety.
 * - **Ageing needs only time; freshening needs a use.** The clock alone may move
 *   a skill toward `archived`, because idle time is evidence it has gone quiet.
 *   It may not move one back the same way, because "not idle" is evidence of
 *   nothing — a skill somebody archived by hand this morning is not idle. A move
 *   toward `active` also requires that the most recent thing that happened to
 *   the skill was a task loading it, which is what makes `archived` **terminal**
 *   without a rule saying so: an archived skill is out of retrieval, so it can
 *   never record the use that is the only road back.
 *
 * This is a **deliberate widening of what an earlier draft of this comment
 * said**, and the difference is worth naming because the old sentence is easy to
 * reach for again. It said a lost index costs *one cycle of no-ops*; including
 * the stamp in the clock makes it cost *one full stale window*. That is the
 * better failure — an operator restoring a store should not have their whole
 * library archived on the next message — and it is the same mechanism that makes
 * a hand-set status survive, so the two cannot be separated.
 */
export const SkillStatus = z.enum([
  /** Retrievable, and the clocks are running. What a new skill is. */
  "active",
  /**
   * Unused long enough to be doubted, and one step from `archived`.
   *
   * **It means nothing to retrieval**, which is #294's call: a stale skill is
   * loaded exactly as an active one is. Deprioritizing it would need a weight,
   * and the fusion it would go in is a round-robin interleave with no weights
   * and no RRF constant — there is nothing to express it in. What `stale` is for
   * is the team: a line that changed in their own directory and their own git
   * history, before anything leaves retrieval.
   */
  "stale",
  /**
   * Out of retrieval entirely. A status, never a deletion — the file stays.
   *
   * Terminal as far as the lifecycle job is concerned, and by consequence rather
   * than by rule: what would move a skill back is a task loading it, and nothing
   * archived is ever loaded. A person editing the file is the road back.
   */
  "archived"
]);

export type SkillStatus = z.infer<typeof SkillStatus>;

const CREATED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day a skill was first written, as a UTC calendar date.
 *
 * **Parsed by rule rather than by `Date.parse`**, which is already this tree's
 * answer to the same question on the audit log's read path. `Date.parse` accepts
 * `04/08/2026` and reads it in whichever order the runtime prefers, and it
 * *rolls over* an impossible date rather than refusing it, so `2026-02-30`
 * silently becomes March. The shape is checked first and the calendar date is
 * then validated by round-trip, which is what catches the roll-over — `Date.UTC`
 * absorbs a 30th of February just as happily.
 *
 * A date rather than an instant because the clocks that will read a skill's age
 * measure days, and because this is a line in a file a team reads and edits. It
 * is deliberately the *only* time in the file: everything the runtime observed —
 * when this store first saw the skill, when it was last retrieved — is a column
 * in the index, in milliseconds, and this is not a second copy of any of it. See
 * the header: nothing decides anything by reading this field.
 */
export const SkillCreated = z
  .string()
  .regex(CREATED_DATE, "must be a UTC calendar date, YYYY-MM-DD")
  .check(ctx => {
    const parts = CREATED_DATE.exec(ctx.value);
    // The regex already failed and said so; a second issue naming the calendar
    // would be one mistake reported as two.
    if (parts === null) return;

    const [, year, month, day] = parts;
    const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (new Date(midnight).toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "must be a date that exists"
      });
    }
  });

export type SkillCreated = z.infer<typeof SkillCreated>;

/**
 * A skill file's frontmatter.
 *
 * **Not `.strict()`, and that is the deliberate departure from every other shape
 * in this package that is parsed out of text.** The rule those follow is that
 * wire and model-input shapes are strict, because a field nobody declared is a
 * field nobody bounded. This is neither: it is an operator-authored file, in the
 * class the team sheet's own blocks sit in, where an unknown key is stripped
 * rather than fatal because losing a channel's whole skill over a stray line is
 * a worse failure than ignoring the line.
 *
 * It is also concretely load-bearing rather than a matter of taste. The
 * architecture page documents `uses` as a frontmatter key; a team following it
 * writes one, and under a strict parse every such file is refused and drops out
 * of the index. That page is being corrected in the same change, but files
 * written against it will outlive the correction.
 *
 * The *operations* in ./skill-op.ts stay strict. Those are model input.
 *
 * `status` is optional and defaults to `active`, so a skill somebody wrote by
 * hand — which the storage layer is required to accept — parses without them
 * having to know the vocabulary. `name`, `description` and `created` are
 * required: a skill with no name cannot be addressed, one with no description
 * cannot be retrieved, and one with no date has nothing for a clock to start
 * from.
 */
export const SkillFrontmatter = z.object({
  name: SkillName,
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
  created: SkillCreated,
  status: SkillStatus.default("active")
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

/**
 * One skill file, as its two halves.
 *
 * An interface rather than a zod object, for the reason `MemoryOp` is one: it is
 * built by the parser below and handed to the store, and there is no boundary at
 * which untrusted bytes become one without going through `parseSkillFile`.
 *
 * **The body is not bounded here.** `SKILL_BODY_MAX_CHARS` bounds what a model
 * may write in one operation, and `[skills] max_skill_chars` bounds what a body
 * may be once a human has one — and the second is at least the first, so a file
 * on disk may legitimately be longer than any operation could have produced. A
 * parser that refused it would be refusing the team's own writing on the
 * model's budget. Deciding what to do with an over-cap body belongs to whatever
 * indexes it.
 */
export interface SkillFile {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

/** One reason a skill file did not parse, at the position it was found. */
export interface SkillFileIssue {
  /** Dotted path into the frontmatter, e.g. `status`. Empty at root. */
  readonly path: string;
  /** Zod's issue code — a closed vocabulary, not prose. */
  readonly code: string;
}

/**
 * What `parseSkillFile` answers. Never an exception.
 *
 * The failure side carries **positions and codes, never file content**, which is
 * `parseTeamSheet`'s discipline and holds here for a sharper reason: this file
 * is written by a model, so anything the failure interpolated would be text the
 * model chose, arriving in whatever log or channel the caller reports to.
 * `line` is 1-based and counts from the start of the file.
 */
export type SkillFileParse =
  | { readonly ok: true; readonly skill: SkillFile }
  | { readonly ok: false; readonly reason: "no_frontmatter" }
  | { readonly ok: false; readonly reason: "malformed_line"; readonly line: number }
  | { readonly ok: false; readonly reason: "duplicate_key"; readonly line: number }
  | { readonly ok: false; readonly reason: "empty_body" }
  | { readonly ok: false; readonly reason: "schema_invalid"; readonly issues: readonly SkillFileIssue[] };

const FENCE = "---";

/** `key: value`, splitting on the first colon so a description may contain one. */
const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Text on disk to a skill, or a structured account of why not.
 *
 * The format lives with the schema rather than with the process that reads the
 * file, for `parseTeamSheet`'s reason: a skill is a *format* and a *shape*, and
 * splitting those across two packages is two definitions of "is this a valid
 * skill" that disagree the first time either is edited.
 *
 * ## The grammar is hand-written, and not YAML
 *
 * Three `---`-fenced scalar lines and a markdown body. Nothing in this workspace
 * depends on a YAML parser and this is not the reason to add one: the CLI
 * bundles this package with esbuild and publishes a manifest declaring no
 * dependencies at all, so a parser here grows that tarball and adds a surface to
 * the licence gate — to read four short lines.
 *
 * YAML would also be actively worse at this. Its implicit typing reads
 * `description: no` as `false` and `created: 2026-08-15` as a `Date` in whatever
 * zone the runtime feels like, both of which are exactly the fields below.
 *
 * So: a value is the rest of its line, verbatim and trimmed. There is no
 * quoting, no escaping, no multi-line value, and no comment syntax — a
 * description that needs any of those is a description that should be shorter,
 * and the body underneath has no format imposed on it at all.
 *
 * ## What it refuses, and what it lets through
 *
 * An unknown key is **ignored**, per `SkillFrontmatter`. A key given twice is
 * **refused**, because there is no answer to which one the team meant and
 * silently taking the last is how a status a human set gets dropped. A line
 * inside the fences that is not `key: value` is refused rather than skipped, for
 * the same reason. Blank lines are fine.
 *
 * Never throws. A skill file failing to parse is an ordinary outcome — a model
 * wrote it, or a person edited it — on a path where an exception would be caught
 * somewhere that treats it as "no skills".
 */
export function parseSkillFile(text: string): SkillFileParse {
  // Normalized so a file edited on Windows is not a file with four unparseable
  // lines. Nothing downstream can tell the difference, and `\r` on the end of a
  // value would otherwise reach a name, a date, and the index.
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines[0]?.trim() !== FENCE) return { ok: false, reason: "no_frontmatter" };

  const fields: Record<string, string> = {};
  let close = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === FENCE) {
      close = index;
      break;
    }
    if (line.trim() === "") continue;

    const match = FRONTMATTER_LINE.exec(line);
    if (match === null) return { ok: false, reason: "malformed_line", line: index + 1 };

    const [, key, value] = match;
    // `key` and `value` are the regex's own capture groups and cannot be
    // undefined here; the assertion is for `noUncheckedIndexedAccess`.
    if (key === undefined || value === undefined) {
      return { ok: false, reason: "malformed_line", line: index + 1 };
    }
    if (Object.hasOwn(fields, key)) return { ok: false, reason: "duplicate_key", line: index + 1 };
    fields[key] = value.trim();
  }

  if (close === -1) return { ok: false, reason: "no_frontmatter" };

  const parsed = SkillFrontmatter.safeParse(fields);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.join("."),
        code: issue.code
      }))
    };
  }

  // Trimmed, which is what makes `serializeSkillFile(parseSkillFile(x))` a fixed
  // point rather than a function that grows a blank line every time the
  // lifecycle job rewrites a status. The cost is that trailing whitespace
  // somebody typed does not survive a rewrite, which is not a cost.
  const body = lines.slice(close + 1).join("\n").trim();
  if (body === "") return { ok: false, reason: "empty_body" };

  return { ok: true, skill: { frontmatter: parsed.data, body } };
}

/**
 * A skill back to the text on disk.
 *
 * **Exported beside the parser, and round-tripped by a test rather than
 * generated from it.** That is this package's existing answer to one contract
 * with two spellings — the memory tools' JSON Schemas sit beside their zod
 * parsers and a test holds the two together. Without this the storage layer
 * would write these files by string concatenation, which is a second definition
 * of the format with nothing checking it against the first.
 *
 * The field order is fixed and is the order they are declared in: identity, then
 * what the skill is for, then when it appeared, then where it is in its life. A
 * stable order is what makes the lifecycle job's status change a one-line diff
 * in the team's git history rather than a reordering of the whole header.
 */
export function serializeSkillFile(skill: SkillFile): string {
  const { name, description, created, status } = skill.frontmatter;
  return [
    FENCE,
    `name: ${name}`,
    `description: ${description}`,
    `created: ${created}`,
    `status: ${status}`,
    FENCE,
    "",
    skill.body,
    ""
  ].join("\n");
}
