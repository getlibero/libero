// Making a channel's skill index match its skill directory (#290).
//
// The two halves this composes are deliberately unaware of each other:
// ./skill-file.ts owns the paths and knows nothing about SQL, ./store-db.ts owns
// every SQL string in this package and touches no filesystem. This is the seam,
// and it is one function rather than an object because it holds no state — every
// pass reads the world fresh.
//
// ## The rule this enforces, stated once
//
// **The file is the source of truth for everything a human authored; the index
// is the source of truth for everything the runtime observed about the file.
// Reconciliation reads files and never writes them.** That sentence is on
// `SkillFrontmatter` in the schema package, and this module is where it stops
// being a claim. Nothing here opens a file for writing, and the only thing that
// writes the skill tables is `store.reconcileSkills`.
//
// ## Detection is cheap and repair is not, so they are separated
//
// A steady-state pass is a `readdir` and a `stat` per entry — no file is opened
// and nothing is parsed. Only an entry whose fingerprint moved is read and
// parsed, and only a skill whose *description* moved costs an embedding later.
// That layering is what makes running this at the head of every task affordable:
// the common case is that nothing changed and the pass is syscalls.
//
// **It embeds nothing**, and that is not a gap. `packages/memory` has no model
// provider — `putThreadSummary` writes no vector for the same reason — so what
// this leaves behind is a set of rows with no vector standing for them, which
// `skillsNeedingEmbedding` is how a caller that *does* have a provider finds.
// The honest consequence: a just-edited skill is findable by full text on the
// very next task and semantically only after something has embedded it.
//
// ## Two failures that are not errors
//
// **A file that stops parsing keeps its last good row.** It is not dropped from
// the index and its new contents are not indexed, so a half-saved edit does not
// erase a skill's use counters and its clocks survive being briefly broken. What
// that costs is one parse attempt per pass until somebody fixes the file, which
// is bounded by the library's own cap. Nothing stale reaches a model either way:
// retrieval resolves a candidate through the file, so a row standing for a file
// that will not parse resolves to nothing and is skipped.
//
// **A directory holding more skills than the sheet allows is truncated, not
// refused.** The names are sorted and the first `maxSkills` are the library; the
// rest are logged once and left on disk untouched. Refusing the whole pass
// instead would mean a team that over-filled their directory loses retrieval
// entirely until they tidy it, which is a worse answer than a deterministic
// subset.

import type { Logger } from "./log.js";
import type { SkillFiles } from "./skill-file.js";
import type { MessageStore, SkillEntry, SkillReconcileResult } from "./store-db.js";

export interface SkillReconcileOptions {
  /** The channel's skill directory. */
  readonly files: SkillFiles;
  /** The channel's store, which holds the index. */
  readonly store: MessageStore;
  /**
   * This channel's `[skills] max_skills`. The library's ceiling, and what bounds
   * the work one pass may do.
   */
  readonly maxSkills: number;
  /** When this pass ran, in milliseconds. Stamped as a new skill's `first_seen_at`. */
  readonly at: number;
  /** The channel id, for the log line only. Nothing here resolves a path from it. */
  readonly channel?: string;
  readonly logger?: Logger;
}

/**
 * One reconciliation pass.
 *
 * Throws what the filesystem throws — an unreadable directory is an operator's
 * problem rather than a model's, and the file layer is careful that only a
 * genuinely absent directory reads as empty, because "empty" is the value this
 * function deletes the whole index against.
 */
export function reconcileSkillIndex(options: SkillReconcileOptions): SkillReconcileResult {
  const { files, store, maxSkills, at, channel, logger } = options;

  // Sorted by the file layer already, so the truncation below is deterministic
  // rather than dependent on directory order.
  const found = files.fingerprints();
  const kept = found.length > maxSkills ? found.slice(0, maxSkills) : found;
  if (kept.length < found.length) {
    logger?.log("warn", {
      event: "skills_over_cap",
      ...(channel === undefined ? {} : { channel })
    });
  }

  const stored = new Map(store.listSkills().map(skill => [skill.name, skill]));
  const changed: SkillEntry[] = [];

  for (const file of kept) {
    const was = stored.get(file.name);
    // All three, and `ino` is the one that earns its place: every write here
    // lands by rename, so the inode always moves — including on the rewrite that
    // changes neither the length nor the millisecond.
    if (
      was !== undefined &&
      was.mtimeMs === file.mtimeMs &&
      was.size === file.size &&
      was.ino === file.ino
    ) {
      continue;
    }

    const skill = files.read(file.name);
    // Unparseable, or its frontmatter names something else. The file layer has
    // already logged which; here it simply does not become an entry, so the row
    // that is already there stays as it is.
    if (skill === null) continue;

    changed.push({
      name: file.name,
      mtimeMs: file.mtimeMs,
      size: file.size,
      ino: file.ino,
      description: skill.frontmatter.description,
      body: skill.body,
      created: skill.frontmatter.created,
      status: skill.frontmatter.status
    });
  }

  // `present` is every name that is a skill, including the ones whose files did
  // not parse — so a broken file is not treated as a deleted one.
  return store.reconcileSkills({ present: kept.map(file => file.name), changed }, at);
}
