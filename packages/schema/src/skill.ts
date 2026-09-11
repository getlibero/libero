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
// is here because a human opening the directory wants it, and nothing reads it
// to decide anything. That is also why it is **optional on a shared skill**
// (#567): the Agent Skills spec does not define the key, so a vendored file
// simply has not got one, and a field nothing decides by is a poor reason to
// refuse the file. A channel's own skill still requires it, because the store
// stamps one on every create and a file missing one there is a damaged file.
//
// The index stamps its own `first_seen_at` when it first sees a file, in the
// shape `embedding_source.at` already uses, and a never-used skill clocks from
// that.
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
 * The namespace an operator-published skill is addressed under (#432).
 *
 * A shared skill is written `shared/<name>` everywhere it is rendered into a
 * prompt, keyed in an index, or named in a line a person reads. Never bare.
 *
 * **That is structural, and deliberately not a precedence rule.** There is no
 * contest between a channel's `brand-voice` and an operator's, because they are
 * not one name. A precedence rule would be a sentence three places have to apply
 * identically — the standing-text composer, the retrieval pool, and whatever
 * writes the index row — and the first of the three edited without it is a
 * channel whose own playbook was silently replaced by an operator's, with no
 * failure anywhere to notice.
 *
 * **The reservation holds at parse, by alphabet exclusion, and costs nothing to
 * keep.** `/` is not in `SKILL_NAME_PATTERN` — not by an exception carved for
 * this, but because that alphabet has always been lowercase words joined by
 * single dashes, chosen against a filename hazard that has nothing to do with
 * namespaces. So no name that parses can carry the separator, no channel-grown
 * skill can ever be called `shared/brand-voice`, and no code has to check. That
 * is `ModelId`'s mechanism in ./names.ts, where the meter's `(legacy)` and
 * `(unreported)` are reserved by a parenthesis the alphabet does not admit.
 *
 * It is **not** `BUILTIN_SERVER`'s mechanism, which `ModelId`'s comment runs
 * together with this one. `libero` is a perfectly ordinary `ResourceName`; that
 * reservation is a `.check()` on `McpServerList` in ./team-sheet.ts — code that
 * had to be written, has to be kept, and has to be remembered by the next person
 * who adds a list of server names. This one cannot be forgotten, because there is
 * nothing to remember. The only edit that could break it is widening
 * `SKILL_NAME_PATTERN` to admit a slash, and that edit breaks the mapping to
 * `skills/<name>.md` first and far more loudly.
 *
 * **The qualified form is an address, never a filename.** A shared skill's file
 * is `<name>.md` in the shared root, exactly as a channel's is `<name>.md` in its
 * own — so the rule that the `.md` is not part of the name, above, extends here
 * unchanged, and so does the rule that a name which parses is already canonical.
 * Which half of the library a row came from is an `origin` column in the index
 * (#434), not a prefix to split back apart: the column is the fact, the prefix is
 * how it is addressed.
 *
 * A function rather than a template literal at each site, for
 * `serializeSkillFile`'s reason: three callers build this string — the index row
 * (#434), the standing region (#435), and the retrieval pool's dedupe key (#436)
 * — and three spellings of one key is two of them going untested. It does not
 * validate, and that is boundary discipline rather than an omission: its input is
 * a `SkillName` the sheet already parsed, and a throw here would put an exception
 * on the composition path, where every other failure is a dropped skill and a log
 * line.
 *
 * There is no parser for the qualified form and there should not be one until
 * something outside this process produces one. Nothing does: a qualified name is
 * always built here and never read back. A parser with no feed is a second
 * definition of the vocabulary waiting to drift from this one, and worse, it is
 * an invitation — the moment one exists, somebody accepts `shared/brand-voice` as
 * an argument from the model, which is the surface the namespace exists to keep
 * closed.
 */
export const SHARED_SKILL_NAMESPACE = "shared";

/** How an operator-published skill is addressed: `shared/<name>`. */
export function sharedSkillRef(name: SkillName): string {
  return `${SHARED_SKILL_NAMESPACE}/${name}`;
}

/**
 * What a shared skill's own file is called, inside the directory named for it
 * (#567).
 *
 * `<root>/<name>/SKILL.md`, with `scripts/`, `references/` and `assets/` beside
 * it — the Agent Skills layout, so a skill an operator vendored at a SHA arrives
 * whole rather than flattened. The directory is the name, and the spec asks that
 * the frontmatter's `name` agree with it.
 *
 * **Here rather than in the storage layer, because this one is not private to
 * it.** `SkillName`'s header says the filename is the storage layer's business,
 * and that stands for a channel's own `<name>.md`: nothing outside
 * `packages/memory` ever names it. This is the opposite — `libero doctor` checks
 * the layout on the host, `deploy/README.md` documents it, and the vendor verb
 * writes it — so it is an operator-facing contract with three consumers, and a
 * constant in the one package all of them already import is what keeps it one
 * spelling.
 */
export const SHARED_SKILL_FILE = "SKILL.md";

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
 * The Agent Skills spec's designated place for client-defined keys (#567).
 *
 * A string→string map and nothing else. The spec puts `metadata` in the
 * frontmatter for exactly the keys a particular client cares about, which is the
 * one thing this format could not previously read at all — `FRONTMATTER_LINE` is
 * anchored at column 0, so every indented line under it was a malformed line and
 * a vendored skill that used the spec properly failed to parse.
 *
 * **Nothing here reads it**, and that is deliberate rather than provisional. It
 * is carried so the file survives a rewrite and so an operator can see their own
 * keys where they put them; the moment something in this tree decided anything
 * by a key in here, that key would want a declared field with a bound on it, and
 * this map would be the place a model got to name its own.
 *
 * Values are strings, because the grammar has no other scalar type — see
 * `parseSkillFile`. A map of maps is not admitted: one level is what the spec's
 * examples use and what a line-oriented parser can read without becoming YAML.
 */
export const SkillMetadata = z.record(z.string(), z.string());

export type SkillMetadata = z.infer<typeof SkillMetadata>;

/** One frontmatter key this format does not define, kept as the file wrote it. */
export const SkillExtraField = z.object({
  key: z.string().min(1),
  value: z.string()
});

export type SkillExtraField = z.infer<typeof SkillExtraField>;

/**
 * A skill file's frontmatter.
 *
 * **Not `.strict()`, and that is the deliberate departure from every other shape
 * in this package that is parsed out of text.** The rule those follow is that
 * wire and model-input shapes are strict, because a field nobody declared is a
 * field nobody bounded. This is neither: it is an operator-authored file, in the
 * class the team sheet's own blocks sit in, where an unknown key is not fatal
 * because losing a channel's whole skill over a stray line is a worse failure
 * than ignoring the line.
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
 * having to know the vocabulary. `name` and `description` are required: a skill
 * with no name cannot be addressed and one with no description cannot be
 * retrieved.
 *
 * **`created` is optional here and required by `ChannelSkillFrontmatter`**, and
 * the split is the file header's: the spec does not define the key, so a
 * vendored shared skill has not got one, and nothing decides anything by it. A
 * channel's own skill is stamped by the store on create, so a file without one
 * there is damaged rather than foreign.
 */
export const SkillFrontmatter = z.object({
  name: SkillName,
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
  created: SkillCreated.optional(),
  status: SkillStatus.default("active"),
  metadata: SkillMetadata.optional(),
  /**
   * Frontmatter keys this format does not define, in the order the file wrote
   * them.
   *
   * **A data-loss fix, not a feature** (#567). `serializeSkillFile` emits the
   * fields it knows and `SkillFiles.setStatus` rewrites a channel skill through
   * it, so before this a `license:` line somebody hand-added was erased the
   * first time the lifecycle clock moved the status — silently, in a file the
   * team owns.
   *
   * An array rather than a record, because the order is the team's and a record
   * would make "stable order" a fact about how the runtime happens to iterate
   * keys. Populated by `parseSkillFile` only; a caller building a `SkillFile`
   * from scratch has nothing to put here.
   */
  extra: z.array(SkillExtraField).optional()
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

/**
 * The same frontmatter with `created` required: a channel's own skill.
 *
 * A narrowing rather than a second shape, so there is one declaration of every
 * other field and no chance of the two drifting. `parseSkillFile` picks which of
 * the two it parses against from what the caller says the file is, and that is
 * the only place either is chosen between.
 */
export const ChannelSkillFrontmatter = SkillFrontmatter.extend({
  created: SkillCreated
});

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

/**
 * What the caller knows about the file that the bytes do not say.
 *
 * One field, and it exists because `created` is required of a channel's own
 * skill and absent from a vendored one — see `SkillFrontmatter`. The caller is
 * the opener that already knows which directory it is reading, so this is a fact
 * it holds rather than one it has to infer; a parser that guessed from the
 * content would be deciding whether a file is the operator's by whether it is
 * missing a field, which is the wrong way round.
 *
 * Absent means a channel skill, so every existing caller is unchanged and the
 * stricter reading is the default.
 */
export interface SkillFileParseOptions {
  /** The file is a shared skill: `created` is optional. */
  readonly shared?: boolean;
}

const FENCE = "---";

/** `key: value`, splitting on the first colon so a description may contain one. */
const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/** The same line indented: one entry of the map a bare key may carry. */
const INDENTED_LINE = /^[ \t]+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/** The keys this format defines as a scalar on its own line. */
const SCALAR_KEYS = new Set(["name", "description", "created", "status"]);

/**
 * Every key this format defines. Anything else that is a scalar is `extra`.
 *
 * A list rather than a walk of `SkillFrontmatter.shape`, because `extra` is in
 * that shape and is not a frontmatter key — the two differ by exactly the field
 * that holds the difference, which is the kind of thing a derivation gets subtly
 * wrong and a list does not.
 *
 * `metadata` is here and not in `SCALAR_KEYS` because **it is a map or it is
 * nothing**: it is read from the indented block below and never from the rest of
 * its own line, so `metadata: something` says nothing this format can read and
 * is dropped rather than refused.
 */
const DEFINED_KEYS = new Set([...SCALAR_KEYS, "metadata"]);

/**
 * Keys the format reads and deliberately keeps nothing of.
 *
 * `allowed-tools` is the Agent Skills spec's way of saying which tools a skill
 * may use, and **the team sheet is the allowlist here** — the proxy resolves
 * what a channel may call from the sheet, without the model's cooperation, and a
 * line in a file the model can retrieve is not a thing that may narrow or widen
 * that. Keeping it would put a second, inert statement of permission in front of
 * whoever reads the file next, which is worse than dropping it: the one that is
 * ignored looks exactly like the one that is not.
 *
 * Dropped rather than refused, because a spec-conformant skill that names its
 * tools is an ordinary file and refusing it would make the whole skill
 * unreadable over a line this format has an answer for.
 */
const DISCARDED_KEYS = new Set(["allowed-tools"]);

/**
 * A scalar as the file meant it: trimmed, with one matching pair of surrounding
 * quotes removed.
 *
 * The spec's examples quote descriptions, and an unstripped pair is two
 * characters that reach the embedding, the full-text index and every line a
 * person reads. One pair only and no escaping — `"` inside a value is a `"`,
 * because the alternative is an escape vocabulary nothing in this format needs.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

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
 * `---`-fenced `key: value` lines and a markdown body. Nothing in this workspace
 * depends on a YAML parser and this is not the reason to add one: the CLI
 * bundles this package with esbuild and publishes a manifest declaring no
 * dependencies at all, so a parser here grows that tarball and adds a surface to
 * the licence gate — to read a short header.
 *
 * YAML would also be actively worse at this, and the case got sharper rather
 * than weaker when #567 widened the grammar to read a spec `SKILL.md`. Its
 * implicit typing reads `description: no` as `false` and `created: 2026-09-07`
 * as a `Date` in whatever zone the runtime feels like — and the second is
 * exactly the roll-over hazard `SkillCreated` is parsed by rule to avoid, so
 * reaching for a library here would reintroduce the bug this file was written to
 * refuse.
 *
 * So: a value is the rest of its line, trimmed, with one matching pair of
 * surrounding quotes removed. There is no escaping, no folded or literal scalar,
 * and no comment syntax — the spec's own examples are single-line, and a
 * description that needs more is a description that should be shorter. The body
 * underneath has no format imposed on it at all.
 *
 * ## The one nested shape: an indented map
 *
 * A key whose value is empty may be followed by indented `key: value` lines, and
 * those are a string→string map. That is the whole of the nesting, and it exists
 * for one key: `metadata` is where the Agent Skills spec puts client-defined
 * keys, and `FRONTMATTER_LINE` being anchored at column 0 made the spec's own
 * designated extension point a malformed line.
 *
 * A map under any **other** key is read and then dropped — neither the map nor
 * the bare key it hung from survives. Reading it is what keeps a spec-conformant
 * file from failing outright over a key this format has no place for; dropping
 * the bare key too is the honest half, because emitting `license:` with its
 * value discarded would be writing back something the file did not say.
 *
 * ## What it refuses, and what it lets through
 *
 * An unknown scalar is **kept** — see `SkillFrontmatter.extra`. A key given
 * twice is **refused**, because there is no answer to which one the team meant
 * and silently taking the last is how a status a human set gets dropped. A line
 * inside the fences that is neither `key: value` nor an indented line under a
 * bare key is refused rather than skipped, for the same reason. Blank lines are
 * fine.
 *
 * Never throws. A skill file failing to parse is an ordinary outcome — a model
 * wrote it, or a person edited it — on a path where an exception would be caught
 * somewhere that treats it as "no skills".
 */
export function parseSkillFile(text: string, options?: SkillFileParseOptions): SkillFileParse {
  // Normalized so a file edited on Windows is not a file with four unparseable
  // lines. Nothing downstream can tell the difference, and `\r` on the end of a
  // value would otherwise reach a name, a date, and the index.
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines[0]?.trim() !== FENCE) return { ok: false, reason: "no_frontmatter" };

  // In file order, which is what `SkillFrontmatter.extra` preserves. The set is
  // what refuses a repeat; the array is what remembers where it was.
  const scalars: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  const maps = new Map<string, Record<string, string>>();
  // The bare key an indented line would belong to, or null when the last line at
  // column 0 carried a value of its own.
  let open: string | null = null;
  let close = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === FENCE) {
      close = index;
      break;
    }
    // A blank line neither closes a map nor ends the header: `metadata:` with a
    // blank line before its first entry is a file somebody formatted, not a
    // broken one.
    if (line.trim() === "") continue;

    if (/^[ \t]/.test(line)) {
      const indented = INDENTED_LINE.exec(line);
      if (indented === null || open === null) {
        return { ok: false, reason: "malformed_line", line: index + 1 };
      }
      const [, key, value] = indented;
      if (key === undefined || value === undefined) {
        return { ok: false, reason: "malformed_line", line: index + 1 };
      }
      const map = maps.get(open) ?? {};
      if (Object.hasOwn(map, key)) return { ok: false, reason: "duplicate_key", line: index + 1 };
      map[key] = unquote(value);
      maps.set(open, map);
      continue;
    }

    const match = FRONTMATTER_LINE.exec(line);
    if (match === null) return { ok: false, reason: "malformed_line", line: index + 1 };

    const [, key, value] = match;
    // `key` and `value` are the regex's own capture groups and cannot be
    // undefined here; the assertion is for `noUncheckedIndexedAccess`.
    if (key === undefined || value === undefined) {
      return { ok: false, reason: "malformed_line", line: index + 1 };
    }
    if (seen.has(key)) return { ok: false, reason: "duplicate_key", line: index + 1 };
    seen.add(key);
    const scalar = unquote(value);
    scalars.push({ key, value: scalar });
    open = scalar === "" ? key : null;
  }

  if (close === -1) return { ok: false, reason: "no_frontmatter" };

  const fields: Record<string, unknown> = {};
  const extra: SkillExtraField[] = [];
  for (const { key, value } of scalars) {
    if (DISCARDED_KEYS.has(key)) continue;
    // A bare key that turned out to carry a map. `metadata` becomes the field
    // below; anything else goes entirely, key included — see the header, because
    // writing the key back with its value dropped would be writing back
    // something the file did not say.
    if (maps.has(key)) continue;
    // Not `DEFINED_KEYS`: a `metadata` that reached here carried no block, so it
    // is a key that said nothing — see that constant.
    if (SCALAR_KEYS.has(key)) {
      fields[key] = value;
      continue;
    }
    if (DEFINED_KEYS.has(key)) continue;
    extra.push({ key, value });
  }

  const metadata = maps.get("metadata");
  // An empty map is a `metadata:` with nothing under it, which is a key that
  // said nothing rather than a map that is empty.
  if (metadata !== undefined && Object.keys(metadata).length > 0) fields["metadata"] = metadata;
  if (extra.length > 0) fields["extra"] = extra;

  const shape = options?.shared === true ? SkillFrontmatter : ChannelSkillFrontmatter;
  const parsed = shape.safeParse(fields);
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
 * what the skill is for, then when it appeared, then where it is in its life,
 * then every key this format does not define, then the map. A stable order is
 * what makes the lifecycle job's status change a one-line diff in the team's git
 * history rather than a reordering of the whole header.
 *
 * **The last two are what make a rewrite lossless** (#567). `setStatus` writes a
 * channel skill back through here, so a key the format does not define had to
 * either survive this function or be erased from a file the team owns; the
 * unknown scalars go after the four so the diff of a status change stays one
 * line, and the map goes last because it is the only shape that spans lines.
 */
export function serializeSkillFile(skill: SkillFile): string {
  const { name, description, created, status, metadata, extra } = skill.frontmatter;

  const lines = [FENCE, `name: ${name}`, `description: ${description}`];
  // Absent only on a shared skill, which nothing in this tree writes — so this
  // branch is what keeps a round trip honest rather than a case that fires.
  if (created !== undefined) lines.push(`created: ${created}`);
  lines.push(`status: ${status}`);

  for (const field of extra ?? []) {
    // A caller that put a defined key in `extra` would otherwise get a file with
    // that key twice, which is a `duplicate_key` on the way back in. The parser
    // cannot produce one; a hand-built `SkillFile` can.
    if (DEFINED_KEYS.has(field.key) || DISCARDED_KEYS.has(field.key)) continue;
    lines.push(`${field.key}: ${field.value}`);
  }

  const entries = Object.entries(metadata ?? {});
  if (entries.length > 0) {
    lines.push("metadata:");
    for (const [key, value] of entries) lines.push(`  ${key}: ${value}`);
  }

  lines.push(FENCE, "", skill.body, "");
  return lines.join("\n");
}
