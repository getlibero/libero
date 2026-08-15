// One channel's skills on disk: `skills/*.md`, and every rule about what may be
// written there.
//
// Phase 3's file half (#290). `./memory-file.ts` is the template and most of its
// header applies here word for word — the isolation invariant, no lock, refuse
// rather than truncate, a result is for the model and an exception is for the
// operator. What follows is only what differs, because a reader who has met that
// file should not have to read the same paragraphs twice to find the two
// sentences that are new.
//
// ## A directory rather than a file, and what that changes
//
// `MEMORY.md` is one path known at open. This is a directory whose entries are
// named by the model, so three things arrive that memory never had.
//
//   - **A name becomes a path segment.** `SkillName` in `@getlibero/schema` is
//     the one rule about that, exactly as `ChannelId` is the one rule about a
//     channel id, and this module asks rather than reimplements. A name that
//     parses is already canonical — lowercase, single dashes — so it *is* the
//     filename stem on every filesystem and there is no slug function here and
//     no normalized form for a real name to collide with.
//   - **The directory has to be enumerated.** `list()` is a `readdir`, which
//     nothing else in this package does. It is not the cross-channel iteration
//     the proxy's sheet store refuses: this factory closed over one directory,
//     no method takes a channel id, and enumerating one channel's own skills is
//     the class of act `recent(limit)` in ./store-db.ts already is.
//   - **Not everything in the directory is a skill.** The filter is a `SkillName`
//     round-trip on the filename stem, not a `.md` suffix check.
//     `Deploy-Runbook.md`, `deploy_runbook.md`, `.hidden.md`, `deploy.md.md` and
//     the temporary files `./atomic-write.ts` plants mid-write are all the same
//     refusal, and a suffix check would admit the last one during the window it
//     exists.
//
// ## The filename is the identity, and the frontmatter is not
//
// A `skills/deploy.md` whose frontmatter says `name: rollback` is a hand edit
// somebody will make. The stem wins: it is what a revision addresses, what the
// index keys on, and what every failure sentence names. A file whose frontmatter
// disagrees is not re-keyed and not repaired — `read` answers `null` and the
// team's own file is left exactly as they wrote it.
//
// Existence, therefore, is a fact about the *file* and not about its contents. A
// `skill_create` on a name whose file is unparseable is `name_taken`, because the
// name is taken — by a file the team owns. A `skill_revise` on it succeeds,
// because a revision replaces the whole document and replacing a broken file with
// a valid one is a repair. Deciding it the other way would leave a name on which
// neither operation could run.
//
// ## What a revision does not get to change
//
// `created` and `status` are not the model's: the operation shapes in
// `@getlibero/schema` have no field for either, deliberately. So a revision reads
// the file it is replacing and carries both forward, and only a file that cannot
// be parsed falls back to today and `active`. Without that a revision would
// silently reset a `created` date the team can see and un-archive a skill the
// lifecycle job had retired.
//
// ## No `max_skill_chars` here
//
// The sheet's per-body cap is deliberately absent from this module's options, and
// its absence is the honest reading of what that field bounds. `SKILL_BODY_MAX_CHARS`
// bounds what one *operation* may carry and is checked below, so no operation can
// produce a file over the sheet's figure — the sheet's number is at least the
// constant, by the schema's own floor. What `max_skill_chars` bounds is what a
// body may *be* once a person has hand-written one, which is a fact about a file
// nothing here wrote, discovered by whatever indexes the directory. A cap taken
// as an option and never compared against anything would be a mechanism implying
// it guards a hazard it cannot reach.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelId,
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SkillName,
  parseSkillFile,
  serializeSkillFile
} from "@getlibero/schema";
import type { SkillFile, SkillOp, SkillOpResult, SkillStatus } from "@getlibero/schema";
import { replaceFileAtomically } from "./atomic-write.js";
import type { SkillFingerprint } from "./store-db.js";
import type { Logger } from "./log.js";

/**
 * The directory's name inside the channel's state directory.
 *
 * Module-private, and there is deliberately no exported helper that builds a
 * skill's path — `MEMORY_FILENAME`'s reason in ./memory-file.ts: a test that
 * computes `join(root, channel, "skills", "x.md")` itself is asserting the
 * layout, and one that called our own helper would assert nothing.
 */
const SKILLS_DIRNAME = "skills";

/** The suffix a skill file carries. Not part of the name — see `SkillName`. */
const SKILL_SUFFIX = ".md";

export interface SkillFilesOptions {
  /**
   * The channel these skills belong to. Validated as a `ChannelId`, which is what
   * makes it safe as a path segment.
   */
  readonly channel: string;
  /**
   * The directory holding the per-channel state directories. Skills live at
   * `<root>/<channel>/skills/<name>.md`, and `<root>/<channel>` must already
   * exist — see `openSkillFiles` on which of those two this module will create.
   */
  readonly root: string;
  /**
   * This channel's `[skills] max_skills`.
   *
   * Required, and deliberately not defaulted, for `maxFileChars`' reason in
   * ./memory-file.ts: a default here would be a second copy of the schema's
   * figure living in a package that cannot see a team sheet, and the two would
   * disagree the first time an operator's number moved.
   */
  readonly maxSkills: number;
  /**
   * The clock, injectable so a test can pin the date a skill is stamped with.
   * Milliseconds, as everywhere else in this tree.
   */
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * One channel's skills, as three named operations rather than a handle.
 *
 * **No method takes a channel id, and none returns one**, which is
 * `MemoryFile`'s and `MessageStore`'s rule: the factory closed over exactly one
 * directory, so reaching another channel's skills is not something this
 * interface can express.
 *
 * **There is no `close`**, for `MemoryFile`'s reason: this holds a path string
 * and a number, and every descriptor it opens is closed inside the operation
 * that opened it.
 *
 * **There is no delete.** Archiving is a status the lifecycle job writes and
 * removing a file is the team's own act on their own directory; an operation
 * that erased a playbook after one task is not something the author turn should
 * be able to reach for.
 */
export interface SkillFiles {
  /**
   * Every skill this directory holds, by name, sorted.
   *
   * Names only. A caller wanting a skill's text asks `read`, which is the
   * two-step shape `nearest` and `readThreadSummary` already keep in
   * ./store-db.ts — and here it is also what keeps `list` cheap enough to be the
   * count an operation is bounded against.
   *
   * `[]` for a directory that does not exist yet, which is the ordinary state of
   * a channel nobody has authored a skill in.
   */
  list(): readonly string[];
  /**
   * Every skill this directory holds, with what tells an index whether its file
   * has moved since it last looked.
   *
   * `list()` with a `stat` per entry, which is the whole steady-state cost of
   * keeping an index honest — no file is opened and nothing is parsed. It lives
   * here rather than in the caller because this module owns the paths, and the
   * one thing these openers exist to be is the only way to reach them.
   *
   * An entry that vanishes between the listing and its `stat` is dropped rather
   * than throwing: a skill deleted mid-pass is a skill that is gone, which is
   * exactly what the caller is about to conclude anyway.
   */
  fingerprints(): readonly SkillFingerprint[];
  /**
   * One skill as it is on disk right now, or `null`.
   *
   * `null` for three cases a caller cannot usefully tell apart: no such file, a
   * file that does not parse, and a file whose frontmatter names a different
   * skill. All three mean "there is no skill here I can hand you", and the
   * second and third are logged so an operator can see a file being skipped.
   *
   * Read fresh every time. There is no cache and no watcher: a team member
   * editing a skill in an editor is a first-class writer here.
   */
  read(name: string): SkillFile | null;
  /** Run one operation, and answer what it did. */
  apply(op: SkillOp): SkillOpResult;
}

/**
 * What the directory looks like to `planSkillOp`.
 *
 * The two facts an operation is decided against, gathered once by `apply` so the
 * planner touches no disk. `count` is the whole directory rather than a boolean,
 * because `library_full` has to report the figure it refused on.
 */
export interface SkillDirectoryState {
  readonly exists: boolean;
  readonly count: number;
}

export type SkillOpPlan =
  | { readonly write: true; readonly result: SkillOpResult }
  | { readonly write: false; readonly result: SkillOpResult };

/**
 * What an operation would do to this directory, decided without touching a disk.
 *
 * Every rule about a skill operation lives here, on two small facts and two
 * numbers: which world the operation expects to find, the library's ceiling, and
 * the bounds on what the model may write. That keeps `apply` down to a listing,
 * this, and at most one write — and it means there is exactly one call site of
 * the writer, inside `if (plan.write)`, so "an operation that is refused leaves
 * the directory unchanged" is a shape rather than a branch a reviewer has to
 * trace.
 *
 * Exported for its own test and absent from the barrel, the way `planMemoryOp`
 * is: a caller holding this would be a caller deciding for itself what a skill
 * operation means.
 */
export function planSkillOp(
  state: SkillDirectoryState,
  op: SkillOp,
  maxSkills: number
): SkillOpPlan {
  const invalid = precheck(op);
  if (invalid !== null) return { write: false, result: { outcome: "failed", reason: invalid } };

  if (op.op === "skill_create") {
    if (state.exists) {
      return { write: false, result: { outcome: "failed", reason: "name_taken", name: op.name } };
    }
    // Checked on create only. A revision replaces a file that is already counted,
    // so refusing one at the cap would leave a full library unable to correct
    // itself — the same trap `planMemoryOp` avoids by letting a shrinking rewrite
    // through above the cap.
    if (state.count >= maxSkills) {
      return {
        write: false,
        result: { outcome: "failed", reason: "library_full", skills: state.count, limit: maxSkills }
      };
    }
    return {
      write: true,
      result: { outcome: "written", skills: state.count + 1, limit: maxSkills }
    };
  }

  if (!state.exists) {
    return { write: false, result: { outcome: "failed", reason: "skill_not_found", name: op.name } };
  }
  return { write: true, result: { outcome: "written", skills: state.count, limit: maxSkills } };
}

/**
 * The bounds an operation has to clear before the directory is even consulted.
 *
 * The schema's `parseSkillOp` checks the same three things, and the two owners
 * are different rather than redundant — `planMemoryOp`'s `precheck` states the
 * argument and it holds here unchanged. **The parser owns them as the model's
 * contract**: they are the figures the published JSON Schema states, and they
 * turn a bad argument into a sentence the model can act on before anything opens
 * a file. **This module owns them as preconditions of its own**: `SkillOp` is a
 * plain type with no zod object, by its own doc's decision, so nothing
 * structurally forces a caller through the parser, and a hand-built operation
 * carrying a traversal in its name would otherwise be joined onto a path. They
 * cannot drift: both sides import the same constants and the same `SkillName`.
 */
function precheck(
  op: SkillOp
): "name_invalid" | "description_too_long" | "body_too_long" | "malformed_arguments" | null {
  if (!SkillName.safeParse(op.name).success) return "name_invalid";
  if (op.description === "" || op.body === "") return "malformed_arguments";
  if (op.description.length > SKILL_DESCRIPTION_MAX_CHARS) return "description_too_long";
  if (op.body.length > SKILL_BODY_MAX_CHARS) return "body_too_long";
  return null;
}

/** True when `error` is a Node system error carrying this errno. */
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** The UTC calendar date an instant falls on, in the form `SkillCreated` takes. */
function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function openSkillFiles(options: SkillFilesOptions): SkillFiles {
  const { channel, root, maxSkills, logger } = options;
  const now = options.now ?? Date.now;

  // `ChannelId` rather than the raw pattern, for ./memory-file.ts's reason:
  // anything that stores on an id validates with the schema. It is what makes
  // the join below safe.
  if (!ChannelId.safeParse(channel).success) {
    throw new Error(`memory store: ${JSON.stringify(channel)} is not a valid channel id`);
  }

  if (!Number.isInteger(maxSkills) || maxSkills < 1) {
    throw new Error(
      `memory store: skills for ${channel} were opened with a library cap of ${String(maxSkills)}, ` +
        `and a channel that may hold no skills is one where every legal operation is unwritable. ` +
        `Set [skills] max_skills to at least 1 in this channel's team sheet.`
    );
  }

  const stateDirectory = join(root, channel);
  const directory = join(stateDirectory, SKILLS_DIRNAME);

  // The channel's state directory is not created here, for ./memory-file.ts's
  // reason exactly: its existence is the operator's statement that the channel
  // exists, and `apps/server` is where the team sheet is checked before one is
  // made. `skills/` beneath it is a different question and is answered in
  // `ensureDirectory` below.
  if (!existsSync(stateDirectory)) {
    throw new Error(
      `memory store: ${stateDirectory} has no state directory, so this channel has nowhere to ` +
        `keep a skill. The agent creates one after checking the channel has a team sheet.`
    );
  }

  /**
   * `skills/` on the first successful write, and never before.
   *
   * **Non-recursive, and that is the whole safety argument.** The rule this
   * package keeps is that it never creates a channel's state directory, because
   * doing so would invent a channel with no team sheet behind it. One level
   * down that hazard is unreachable — the channel is already real — and
   * `mkdirSync` without `recursive` makes it structural rather than promised: a
   * `<channel>/` that vanished throws `ENOENT` here instead of being recreated
   * underneath us.
   *
   * Deliberately not done by `apps/server`'s opener alongside its own `mkdir`,
   * which would create the directory for every channel including those whose
   * sheet says `[skills] enabled = false`.
   */
  const ensureDirectory = (): void => {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  };

  const fileFor = (name: string): string => join(directory, `${name}${SKILL_SUFFIX}`);

  /**
   * The directory's entries, or `[]` when there is no directory yet.
   *
   * **Only `ENOENT` reads as empty.** Every other errno throws, and the
   * distinction is load-bearing for ./memory-file.ts's reason made sharper: this
   * listing is what an operation is decided against and what a reconciliation
   * would diff an index against, so answering "no skills" to a directory we
   * could not read is how a channel's whole library gets treated as deleted.
   * `EACCES` is the live case.
   */
  const names = (): string[] => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(SKILL_SUFFIX)) continue;
      const stem = entry.name.slice(0, -SKILL_SUFFIX.length);
      // The filter, and it is a name rule rather than a suffix rule. A stem that
      // does not parse is not a skill this store can address, so it is not one
      // it will count, list, or index.
      if (!SkillName.safeParse(stem).success) continue;
      found.push(stem);
    }
    return found.sort();
  };

  const readFile = (name: string): SkillFile | null => {
    let text: string;
    try {
      text = readFileSync(fileFor(name), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }

    const parsed = parseSkillFile(text);
    if (!parsed.ok) {
      logger?.log("warn", { event: "skill_file_unusable", channel, file: fileFor(name) });
      return null;
    }
    if (parsed.skill.frontmatter.name !== name) {
      // The stem wins and the file is left alone — see the header. Logged
      // distinctly from a parse failure, because the fix is different: one is a
      // broken file, the other is two names for one skill.
      logger?.log("warn", { event: "skill_file_misnamed", channel, file: fileFor(name) });
      return null;
    }
    return parsed.skill;
  };

  logger?.log("info", { event: "skills_opened", channel, file: directory });

  return {
    list() {
      return names();
    },

    fingerprints() {
      const found: SkillFingerprint[] = [];
      for (const name of names()) {
        let stat;
        try {
          stat = statSync(fileFor(name));
        } catch (error) {
          // Gone between the listing and the stat. Dropping it says the same
          // thing the next listing would.
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        found.push({ name, mtimeMs: stat.mtimeMs, size: stat.size, ino: Number(stat.ino) });
      }
      return found;
    },

    read(name) {
      // A name that could never be a filename is not a lookup miss, but there is
      // nothing else to answer: `read` has no failure vocabulary, and inventing
      // one for a caller that built an invalid name would be a second way to say
      // what `SkillName` already says.
      if (!SkillName.safeParse(name).success) return null;
      return readFile(name);
    },

    apply(op) {
      const existing = names();
      const plan = planSkillOp(
        { exists: existing.includes(op.name), count: existing.length },
        op,
        maxSkills
      );
      if (!plan.write) return plan.result;

      // Carried forward rather than restamped — see the header. A revision of a
      // file that cannot be parsed falls back to today and `active`, which is
      // the same answer a create gets, because there is nothing to carry.
      const previous = op.op === "skill_revise" ? readFile(op.name) : null;
      const created = previous?.frontmatter.created ?? utcDate(now());
      const status: SkillStatus = previous?.frontmatter.status ?? "active";

      const text = serializeSkillFile({
        frontmatter: { name: op.name, description: op.description, created, status },
        body: op.body
      });

      ensureDirectory();
      replaceFileAtomically(fileFor(op.name), Buffer.from(text, "utf8"));
      return plan.result;
    }
  };
}
