// The operator's shared skills on disk: `<root>/<name>.md`, read and never
// written (#434).
//
// The file half of #373's shared-skill shape. An enterprise publishes a handful
// of skills — brand voice, house style, a standard playbook — into one directory
// that every channel's agent may read and no channel's agent may write, and a
// channel's team sheet names which of them it wants. This module is how that
// directory is read; ./skill-store.ts is where the names it holds reach an index.
//
// ## Read-only is the shape, not a convention
//
// The interface has three methods and none of them writes. There is no `apply`,
// no `setStatus`, no `create`, and no lazily created directory — where
// ./skill-file.ts has all four.
//
// That is #373's blast-radius argument made structural. A compromised agent
// process that poisons a channel-authored skill poisons one channel's future
// tasks; a writable shared skill would be one file that poisons every channel at
// once, which is exactly the cross-channel amplification the per-channel layout
// exists to prevent. The mount is what enforces it — the root is bind-mounted
// `:ro` (#433) — and this interface is what makes a write not something the
// calling code can express in the first place. Neither alone would be enough:
// a mount an operator got wrong leaves the code as the only guard, and code in a
// process an attacker controls is no guard at all.
//
// **There is also no index-owned status here.** A channel skill has a lifecycle
// — the job moves it to `stale` and then `archived` — because machine-authored
// skills accumulate unattended. An operator's file is decreed: it stays until the
// sheet stops naming it or the file goes, and nothing in this package has an
// opinion about it. `status` in its frontmatter is the operator's word and is
// read like any other field; what is absent is anything that would write one.
//
// ## No channel, and that is the point
//
// Every other opener in this package closes over one channel's directory, and
// `MessageStore`'s rule — no method takes a channel id — is the isolation
// boundary. This one closes over a directory that belongs to no channel, so that
// rule has nothing to say about it, and the rule that replaces it is narrower:
// **it holds no channel state and answers with none.** What is per-channel about
// a shared skill is which ones a sheet named and what a channel's index and
// vectors hold, and both of those live on the channel's side of the seam.
//
// ## One flat directory, no nesting
//
// `<root>/brand-voice.md`, not `<root>/marketing/brand-voice.md`. `SkillName` has
// no separator that could become a path segment, and the addressing form
// `shared/<name>` is a namespace rather than a directory — `sharedSkillRef`'s
// header in the schema package is explicit that the qualified form is an address
// and never a filename. A subdirectory would be a second naming scheme with
// nothing to parse it.

import { existsSync } from "node:fs";
import { SkillName } from "@getlibero/schema";
import type { SkillFile } from "@getlibero/schema";
import { openSkillDirectory } from "./skill-dir.js";
import type { SkillFingerprint } from "./store-db.js";
import type { Logger } from "./log.js";

export interface SharedSkillFilesOptions {
  /**
   * The directory holding the operator's skill files, one `<name>.md` each.
   *
   * `AGENT_SHARED_SKILLS_ROOT` (#433), and deliberately neither of the other two
   * roots: not `AGENT_CHANNELS_ROOT`, which is where the proxy reads
   * authorization from, and not `AGENT_STORE_ROOT`, which the agent writes.
   */
  readonly root: string;
  readonly logger?: Logger;
}

/**
 * The operator's shared skills, as three reads and nothing else.
 *
 * A subset of `SkillFiles` rather than a variant of it, and the two are
 * deliberately not one interface with the writes made optional: a caller holding
 * one of these cannot write, cannot be handed the other by mistake, and cannot be
 * changed later into something that does either without the change being visible
 * in this file.
 *
 * **There is no `close`** and no `maxSkills`. The first is `SkillFiles`' reason —
 * this holds a path string. The second is because a channel's cap bounds a
 * channel's own library, and what bounds this set is the sheet: only skills a
 * `[[shared_skill]]` entry names are ever asked for, and `[skills]
 * max_always_skills` bounds the standing half of that.
 */
export interface SharedSkillFiles {
  /**
   * Every shared skill the root holds, by name, sorted. Bare names — the file's
   * stem — never the `shared/<name>` address.
   *
   * `[]` for a root that holds no skill files, which is an operator who has
   * scaffolded the directory and published nothing into it yet.
   */
  list(): readonly string[];
  /** Every shared skill with what tells an index whether its file has moved. */
  fingerprints(): readonly SkillFingerprint[];
  /**
   * One shared skill as it is on disk right now, or `null`.
   *
   * `SkillFiles.read`'s three nulls, for its reasons: no such file, a file that
   * does not parse, a file whose frontmatter names a different skill. A caller
   * does the same thing in all three, which is skip the skill; the second and
   * third are logged so an operator can see their file being passed over.
   *
   * Takes the **bare** name, because that is the filename. A caller holding a
   * `shared/<name>` address is holding the form the index keys on, and the two
   * are converted where the index is written and nowhere else.
   */
  read(name: string): SkillFile | null;
}

/**
 * Open the shared root, or `null` when there is nothing there to open.
 *
 * `null` rather than an empty listing, and `openMessageReader`'s shape: a root
 * that does not exist is a configuration an operator can fix, and a handle that
 * answered `[]` to it would make "the sheet names a skill nobody published" and
 * "the mount is missing" the same silence. #433's `doctor` check is the other end
 * of the same sentence, and the caller that gets a `null` here is what turns it
 * into something the channel sees.
 *
 * Checked with `existsSync` ahead of the reads rather than by catching `ENOENT`
 * later, because the listing treats a missing directory as empty on purpose —
 * that is right for a channel that has authored no skills and wrong for a root
 * that should be mounted.
 */
export function openSharedSkillFiles(options: SharedSkillFilesOptions): SharedSkillFiles | null {
  const { root, logger } = options;

  if (!existsSync(root)) return null;

  const reads = openSkillDirectory({ directory: root, ...(logger ? { logger } : {}) });

  logger?.log("info", { event: "shared_skills_opened", file: root });

  return {
    list() {
      return reads.names();
    },

    fingerprints() {
      return reads.fingerprints();
    },

    read(name) {
      // `SkillFiles.read`'s guard and its reason: a name that could never be a
      // filename is not a lookup miss, but there is no failure vocabulary here to
      // say so, and inventing one would be a second way to say what `SkillName`
      // already says.
      if (!SkillName.safeParse(name).success) return null;
      return reads.read(name);
    }
  };
}
