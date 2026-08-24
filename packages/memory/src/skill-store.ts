// Making a channel's skill index match the directories behind it (#290, #434).
//
// The two halves this composes are deliberately unaware of each other:
// ./skill-file.ts and ./shared-skill-file.ts own the paths and know nothing about
// SQL, ./store-db.ts owns every SQL string in this package and touches no
// filesystem. This is the seam, and it is functions rather than an object because
// it holds no state — every pass reads the world fresh.
//
// **Two directories, two passes, one index.** A channel's own `skills/` is one
// half and the operator's shared root is the other, and each pass writes and
// deletes only within its own `origin` — the argument for that scoping is on
// `SkillReconciliation` in ./store-db.ts, and the short form is that a channel
// pass runs four times a task and knows nothing of the shared root. The passes
// are separate functions rather than one with a mode because almost nothing about
// them is shared: different bounds, different keys, different failure to report.
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

import { sharedSkillRef } from "@getlibero/schema";
import type { Logger } from "./log.js";
import type { SkillFiles } from "./skill-file.js";
import type { SharedSkillFiles } from "./shared-skill-file.js";
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

  const stored = new Map(store.listSkills("channel").map(skill => [skill.name, skill]));
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
  return store.reconcileSkills(
    { present: kept.map(file => file.name), changed, origin: "channel" },
    at
  );
}

export interface SharedSkillReconcileOptions {
  /** The operator's shared root, opened read-only. */
  readonly files: SharedSkillFiles;
  /** The channel's store, which holds the index — one per channel, as ever. */
  readonly store: MessageStore;
  /**
   * The shared skills this channel's sheet named in `retrieved` mode, by bare
   * name.
   *
   * The caller's, because `packages/memory` reads no team sheet: the sheet lives
   * under the channels root, which is the proxy's to read and this package's to
   * know nothing about. `apps/server` parses the sheet it already has and passes
   * the names.
   *
   * **Retrieved mode only.** An `always` entry is read from its file into the
   * standing region of the prompt and never indexed — indexing one would put it
   * in the retrieval pool as well, so a task near its subject would pay for it
   * twice in the same prompt. That is why this module never learns what a load
   * mode is: the caller has already spent it.
   */
  readonly names: readonly string[];
  /** When this pass ran, in milliseconds. Stamped as a new row's `first_seen_at`. */
  readonly at: number;
}

/**
 * One reconciliation pass over the shared half of a channel's index (#434).
 *
 * `reconcileSkillIndex`'s sibling, and the differences are the three things that
 * make a shared skill a different kind of thing:
 *
 *   - **The sheet bounds the set, not a cap.** A channel's own directory is
 *     truncated at `[skills] max_skills` because a channel authors into it
 *     unattended; the shared root holds whatever an operator published, and what
 *     this channel gets is the intersection with what its sheet named. A file in
 *     the root that no `[[shared_skill]]` entry names is not this channel's
 *     skill and never enters its index.
 *   - **A named skill the root does not hold is simply absent.** It is not an
 *     error here and not a row: the intersection drops it, and the next pass
 *     picks it up if the operator publishes it. Saying so out loud belongs where
 *     the prompt text is assembled, which is the one place that knows a channel
 *     asked for something and did not get it — and is why this pass takes no
 *     logger where the channel's takes one: it has nothing of its own to say.
 *   - **Rows are keyed by the address, not the filename.** `sharedSkillRef` is
 *     applied here and only here: the file is `<name>.md`, the row is
 *     `shared/<name>`. That is what keeps the two halves from colliding on
 *     `skill.name`'s UNIQUE when a channel grows a skill with the same name as a
 *     published one — `/` is not in `SKILL_NAME_PATTERN`, so no channel-authored
 *     name can ever spell the qualified form.
 *
 * Everything else is deliberately the same, including the two failures that are
 * not errors in the header above. A shared file that stops parsing keeps its last
 * good row, which matters more here than there: the file is one an operator is
 * mid-deploy on, and dropping the row would take the vector with it and cost
 * every channel that named the skill an embedding call to get it back.
 */
export function reconcileSharedSkillIndex(
  options: SharedSkillReconcileOptions
): SkillReconcileResult {
  const { files, store, names, at } = options;

  const wanted = new Set(names);
  // The intersection, in the file layer's sorted order. `fingerprints` is a
  // `stat` per file in the root rather than per name this channel wants, which
  // is the same steady-state cost the channel pass pays and is bounded by what
  // one operator publishes.
  const kept = files.fingerprints().filter(file => wanted.has(file.name));

  const stored = new Map(store.listSkills("shared").map(skill => [skill.name, skill]));
  const changed: SkillEntry[] = [];

  for (const file of kept) {
    const ref = sharedSkillRef(file.name);
    const was = stored.get(ref);
    if (
      was !== undefined &&
      was.mtimeMs === file.mtimeMs &&
      was.size === file.size &&
      was.ino === file.ino
    ) {
      continue;
    }

    // Read by the bare name, indexed under the address.
    const skill = files.read(file.name);
    if (skill === null) continue;

    changed.push({
      name: ref,
      mtimeMs: file.mtimeMs,
      size: file.size,
      ino: file.ino,
      description: skill.frontmatter.description,
      body: skill.body,
      created: skill.frontmatter.created,
      status: skill.frontmatter.status
    });
  }

  return store.reconcileSkills(
    { present: kept.map(file => sharedSkillRef(file.name)), changed, origin: "shared" },
    at
  );
}
