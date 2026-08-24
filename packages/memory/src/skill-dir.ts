// Reading a directory of skill files, for the two openers that do it.
//
// Module-private, and not exported from ./index.ts. There are two directories of
// `<name>.md` in this tree now — a channel's own `skills/` (./skill-file.ts) and
// the operator's shared root (./shared-skill-file.ts, #434) — and the three
// read-only acts are the same in both: list the entries whose stem is a
// `SkillName`, `stat` each one, parse one on demand. What differs is everything
// *around* them, which is why this is a helper the two openers compose rather
// than one opener with a mode.
//
// It exists because a copy is what this repository's own rule forbids when there
// is somewhere for the shared thing to go — the durable-replace recipe is the
// worked example (#272), and here the somewhere is one file down the leaf.
//
// **It reads and it does not write.** No `mkdir`, no rename, no path handed back
// out. `openSkillFiles` builds its own paths for `apply` and `setStatus`, which
// is the half of that module this one deliberately does not reach into: a shared
// skill's directory has no writer at all, and a helper that could write would be
// one the shared opener had to be trusted not to call.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SkillName, parseSkillFile } from "@getlibero/schema";
import type { SkillFile } from "@getlibero/schema";
import type { SkillFingerprint } from "./store-db.js";
import type { Logger } from "./log.js";

/** The suffix a skill file carries. Not part of the name — see `SkillName`. */
export const SKILL_SUFFIX = ".md";

export interface SkillDirectoryOptions {
  /** The directory holding `<name>.md`. Built by the caller, never from a name. */
  readonly directory: string;
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
  const { directory, channel, logger } = options;
  const scope = channel === undefined ? {} : { channel };

  const fileFor = (name: string): string => join(directory, `${name}${SKILL_SUFFIX}`);

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
   * The filter is a `SkillName` round-trip on the filename stem, not a `.md`
   * suffix check. `Deploy-Runbook.md`, `deploy_runbook.md`, `.hidden.md`,
   * `deploy.md.md` and the temporary files `@getlibero/atomic-write` plants
   * mid-write are all the same refusal, and a suffix check would admit the last
   * one during the window it exists.
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
     * file whose frontmatter names a different skill. The stem is the identity
     * and it wins; a disagreeing file is not re-keyed and not repaired.
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
        throw error;
      }

      const parsed = parseSkillFile(text);
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
