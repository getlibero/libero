// Reading a directory of skill files, for the two openers that do it.
//
// Module-private, and not exported from ./index.ts. There are two directories of
// skills in this tree — a channel's own `skills/` (./skill-file.ts) and the
// operator's shared root (./shared-skill-file.ts, #434) — and the three
// read-only acts are the same in both: list the entries whose name is a
// `SkillName`, `stat` each one, parse one on demand. What differs is everything
// *around* them, which is why this is a helper the two openers compose rather
// than one opener with a mode.
//
// It exists because a copy is what this repository's own rule forbids when there
// is somewhere for the shared thing to go — the durable-replace recipe is the
// worked example (#272), and here the somewhere is one file down the leaf.
//
// ## Two layouts, one `origin` (#567)
//
// A channel's skill is `<name>.md` and a shared one is `<name>/SKILL.md` with
// `scripts/`, `references/` and `assets/` beside it — the Agent Skills layout, so
// a skill an operator vendored at a SHA is copied in rather than flattened.
//
// **One option selects both, and that is deliberate.** `origin` says who writes
// the directory, and the layout, the filename and whether `created` is required
// all follow from that one fact. Two options that must always agree would be two
// spellings of one thing, and the first caller to set only one of them is a
// shared root parsed by a channel's rules.
//
// The channel side stays flat because **a model writes those one file at a
// time**: the author turn emits a name, a description and a body, and there is
// no operation that could produce a sidecar. A directory per skill there would
// be a directory with one file in it forever.
//
// **It reads and it does not write.** No `mkdir`, no rename, no path handed back
// out. `openSkillFiles` builds its own paths for `apply` and `setStatus`, which
// is the half of that module this one deliberately does not reach into: a shared
// skill's directory has no writer at all, and a helper that could write would be
// one the shared opener had to be trusted not to call.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHARED_SKILL_FILE, SkillName, parseSkillFile } from "@getlibero/schema";
import type { SkillFile } from "@getlibero/schema";
import type { SkillFingerprint, SkillOrigin } from "./store-db.js";
import type { Logger } from "./log.js";

/** The suffix a channel's skill file carries. Not part of the name — see `SkillName`. */
export const SKILL_SUFFIX = ".md";

export interface SkillDirectoryOptions {
  /** The directory holding the skills. Built by the caller, never from a name. */
  readonly directory: string;
  /**
   * Whose directory this is — which decides the layout and the parse.
   *
   * `channel`: `<name>.md`, and `created` is required, because the store stamps
   * one on every create. `shared`: `<name>/SKILL.md`, and `created` is optional,
   * because the Agent Skills spec does not define the key and a vendored file
   * has not got one.
   */
  readonly origin: SkillOrigin;
  /**
   * The channel, when there is one, for the log line only.
   *
   * Absent for the shared root, which belongs to no channel — that is the whole
   * of why it is a third root. `LogFields.channel` is optional for this.
   */
  readonly channel?: string;
  readonly logger?: Logger;
}

/** The three read-only acts, over one directory. */
export interface SkillDirectory {
  names(): string[];
  fingerprints(): SkillFingerprint[];
  read(name: string): SkillFile | null;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function openSkillDirectory(options: SkillDirectoryOptions): SkillDirectory {
  const { directory, origin, channel, logger } = options;
  const scope = channel === undefined ? {} : { channel };
  const shared = origin === "shared";

  const fileFor = (name: string): string =>
    shared ? join(directory, name, SHARED_SKILL_FILE) : join(directory, `${name}${SKILL_SUFFIX}`);

  /**
   * The directory's entries, or `[]` when there is no directory yet.
   *
   * **Only `ENOENT` reads as empty.** Every other errno throws, and the
   * distinction is load-bearing: this listing is what an operation is decided
   * against and what a reconciliation diffs an index against, so answering "no
   * skills" to a directory we could not read is how a whole library gets treated
   * as deleted. `EACCES` is the live case, and it is a likelier one on the shared
   * root than on a channel's own directory, because that root is somebody else's
   * mount.
   *
   * The filter is a `SkillName` round-trip on the entry's own name, not a `.md`
   * suffix check. `Deploy-Runbook.md`, `deploy_runbook.md`, `.hidden.md`,
   * `deploy.md.md` and the temporary files `@getlibero/atomic-write` plants
   * mid-write are all the same refusal, and a suffix check would admit the last
   * one during the window it exists.
   *
   * On the shared root the entry is a **directory** and it has to hold a
   * `SKILL.md` to count. Checking that here rather than leaving it to `read` is
   * what keeps an empty directory out of `present`, where it would hold an index
   * row open against a skill that has no file.
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
      if (shared) {
        if (!entry.isDirectory()) {
          // The layout this root had before #567. Logged rather than read,
          // because reading it would make one root hold two layouts and an
          // operator's half-finished migration look finished.
          if (entry.isFile() && entry.name.endsWith(SKILL_SUFFIX)) {
            logger?.log("warn", {
              event: "shared_skill_not_a_directory",
              file: join(directory, entry.name)
            });
          }
          continue;
        }
        if (!SkillName.safeParse(entry.name).success) continue;
        if (!existsSync(join(directory, entry.name, SHARED_SKILL_FILE))) {
          logger?.log("warn", {
            event: "shared_skill_file_missing",
            file: join(directory, entry.name)
          });
          continue;
        }
        found.push(entry.name);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(SKILL_SUFFIX)) continue;
      const stem = entry.name.slice(0, -SKILL_SUFFIX.length);
      if (!SkillName.safeParse(stem).success) continue;
      found.push(stem);
    }
    return found.sort();
  };

  return {
    names,

    /**
     * `names()` with a `stat` per entry, which is the whole steady-state cost of
     * keeping an index honest — no file is opened and nothing is parsed.
     *
     * An entry that vanishes between the listing and its `stat` is dropped rather
     * than throwing: a skill deleted mid-pass is a skill that is gone, which is
     * exactly what the caller is about to conclude anyway.
     */
    fingerprints() {
      const found: SkillFingerprint[] = [];
      for (const name of names()) {
        let stat;
        try {
          stat = statSync(fileFor(name));
        } catch (error) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        found.push({ name, mtimeMs: stat.mtimeMs, size: stat.size, ino: Number(stat.ino) });
      }
      return found;
    },

    /**
     * One skill as it is on disk right now, or `null` for three cases a caller
     * cannot usefully tell apart: no such file, a file that does not parse, and a
     * file whose frontmatter names a different skill. The entry's own name — the
     * stem, or the directory — is the identity and it wins; a disagreeing file is
     * not re-keyed and not repaired. The spec asks for the same agreement, so on
     * the shared root this check is the spec's rule as much as this store's.
     *
     * Read fresh every time. There is no cache and no watcher — a person editing
     * a skill in an editor is a first-class writer here, and on the shared root
     * an operator's deploy is.
     */
    read(name) {
      let text: string;
      try {
        text = readFileSync(fileFor(name), "utf8");
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        // A `<name>` that is a file rather than a directory on the shared root:
        // the flat layout again, reached through `read` rather than the listing.
        // Not a crash, for the same reason `ENOENT` is not.
        if (shared && isErrno(error, "ENOTDIR")) return null;
        throw error;
      }

      const parsed = parseSkillFile(text, { shared });
      if (!parsed.ok) {
        logger?.log("warn", { event: "skill_file_unusable", ...scope, file: fileFor(name) });
        return null;
      }
      if (parsed.skill.frontmatter.name !== name) {
        // Logged distinctly from a parse failure, because the fix is different:
        // one is a broken file, the other is two names for one skill.
        logger?.log("warn", { event: "skill_file_misnamed", ...scope, file: fileFor(name) });
        return null;
      }
      return parsed.skill;
    }
  };
}
