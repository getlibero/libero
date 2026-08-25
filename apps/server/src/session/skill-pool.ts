// The retrieved half of the shared library, and the one place a fused candidate
// is resolved to the file it addresses (#436).
//
// `[[shared_skill]] load = "retrieved"` is the other of #373's two modes. Where
// the standing region shapes every reply whatever the question was, these join
// the channel's own playbooks in one pool and arrive when the request looks like
// them — the summaries' standing, where `always` has `MEMORY.md`'s. One
// canonical operator-authored file, and which channels get it is each sheet's
// list: **scoping is the sheet, never the root.** A file nobody named is nobody's
// skill.
//
// ## One pool with two halves, each addressable or not
//
// The passes that use this — ./skill-recall.ts and ./skill-embed.ts — are not
// "the channel's skills pass with a shared bolt-on". They walk one pool whose
// two halves are independently addressable, which is what
// `packages/schema/src/team-sheet.ts` settled when the entries landed and wrote
// down so nobody would re-derive it: `[skills] enabled` gates **the channel leg
// of the pool and never the pool**, so a channel with the switch off and a
// `retrieved` entry still resolves that entry, bounded by `top_k` and
// `max_skill_chars` exactly as it would be with the switch on.
//
// So membership is decided here, and the ranker only orders members. A candidate
// this channel cannot address is not a pool member: it must not resolve, and it
// must not spend one of `top_k`'s slots on the way to not resolving.
//
// ## Resolution is a lookup, and never a parse
//
// `sharedSkillRef`'s header forbids a parser for the qualified form, and this is
// the caller it names. `shared/<name>` is an address rather than a filename:
// which half a row came from is the index's `origin` column (#434), not a prefix
// to split back apart. So `membershipOf` asks the pool whether it holds the
// address — a `Map` lookup over what the sheet named — and never inspects the
// string. No `split`, no `startsWith`, nothing that would become the parser the
// schema says should not exist until something outside this process produces one.
//
// **That costs exactly one slot, once, and it is worth naming.** The lookup is
// positive-first: shared if the pool holds it, else channel if there is a channel
// opener, else neither. On a pass whose pool failed to open, a stale `shared/x`
// left in the index therefore reads as a *channel* candidate — and resolves to
// null through `SkillFiles.read`'s own `SkillName` guard, because `/` is outside
// `SKILL_NAME_PATTERN`. One wasted slot, logged `unresolved`, and no decision
// anywhere depends on the shape of the string. A parser would buy back the slot
// and cost the rule.
//
// ## Why this is not ./shared-skills.ts
//
// The two read the same root and want different things from it. The standing
// reader filters `always`, reads and weighs every entry in one shot, and holds
// nothing afterwards. This one filters `retrieved` and has to *survive* as a
// handle: the pass reconciles the index against it, asks two legs, and then reads
// the members that came back — three separate acts over one opening. A task that
// uses both opens the root twice, which is two `existsSync` calls and two
// closures. Folding them into one per-task opening shared by both is a real
// simplification and it is not this issue's: the standing region is composed
// outside the session lock and this is inside it, so the shared handle would have
// to cross that line.

import { openSharedSkillFiles } from "@getlibero/memory";
import { sharedSkillRef } from "@getlibero/schema";
import type { SharedSkillFiles, SkillFiles } from "@getlibero/memory";
import type { SharedSkillEntry, SkillFile } from "@getlibero/schema";
import { createSilentLogger } from "@getlibero/gateway";
import type { Logger } from "@getlibero/gateway";

/** The retrieved-mode shared skills one channel's sheet named, opened. */
export interface SharedSkillPool {
  /**
   * The root, read-only.
   *
   * Handed to `reconcileSharedSkillIndex` and nowhere else — every read on this
   * side goes through `read` below, which takes the address rather than the
   * filename.
   */
  readonly files: SharedSkillFiles;
  /**
   * What this channel's sheet asked for, by **bare** name, in sheet order.
   *
   * Reconciliation's set. Never empty: a pool with nothing in it is `null`.
   */
  readonly names: readonly string[];
  /** Is this fused candidate one of ours? A `Map` lookup, and it opens nothing. */
  has(ref: string): boolean;
  /** One member by its `shared/<name>` address, or null. */
  read(ref: string): SkillFile | null;
}

/**
 * How a pass gets the pool for a channel, given the sheet's entries.
 *
 * `SkillFilesOpener`'s shape, and `null` for the same kind of reason: there is
 * nothing here for this channel, and the caller does not have to know which of
 * the three reasons it was.
 */
export type SharedSkillPoolOpener = (
  channel: string,
  entries: readonly SharedSkillEntry[]
) => SharedSkillPool | null;

export interface SharedSkillPoolOptions {
  /** `AGENT_SHARED_SKILLS_ROOT`, or null where no third root is configured. */
  readonly root: string | null;
  logger?: Logger;
}

/** Which half of the pool a candidate belongs to, or null for neither. */
export type SkillCandidateOrigin = "channel" | "shared";

export function createSharedSkillPoolOpener(
  options: SharedSkillPoolOptions
): SharedSkillPoolOpener {
  const logger = options.logger ?? createSilentLogger();
  const { root } = options;

  return (channel, entries) => {
    // Before the filesystem, and that ordering is the point: the ordinary
    // deployment configures no third root and names no shared skill, and it pays
    // one `.some()` per pass for the whole feature. No `existsSync`, and no
    // `shared_skills_opened` line per task in an operator's log.
    const names = entries.filter(entry => entry.load === "retrieved").map(entry => entry.name);
    if (names.length === 0) return null;

    // The same three words the standing region uses, on purpose: one grep spans
    // both regions, and an operator debugging a mount is not asked to learn that
    // the same failure has two vocabularies.
    if (root === null) {
      logger.log("warn", {
        event: "shared_skills_unavailable",
        channel,
        reason: "shared_skills_root_unset"
      });
      return null;
    }

    // Opened per pass, for ./shared-skills.ts's reason: publishing a skill or
    // fixing a mount should not need a restart to take effect.
    const files = openSharedSkillFiles({ root, logger });
    if (files === null) {
      logger.log("warn", {
        event: "shared_skills_unavailable",
        channel,
        reason: "shared_skills_root_missing",
        file: root
      });
      return null;
    }

    // Address to filename, built once per pass. This is the whole of what stands
    // in for a parser, and it is built from the sheet rather than from the index
    // — so a row the sheet no longer names is not a member, whatever the index
    // still holds of it.
    const byRef = new Map(names.map(name => [sharedSkillRef(name), name]));

    return {
      files,
      names,
      has: ref => byRef.has(ref),
      read: ref => {
        const name = byRef.get(ref);
        if (name === undefined) return null;
        // Read by the bare name, because that is the filename. The file layer
        // logs an unparseable or misnamed file; a name that resolves to nothing
        // is the caller's to report, which is where the disposition is decided.
        return files.read(name);
      }
    };
  };
}

/**
 * Which half of the pool this candidate belongs to, or null for neither.
 *
 * Positive-first and with no string inspection at all — see the header. A
 * candidate that belongs to neither half is one this channel cannot address, and
 * the passes drop it before it is fused rather than after it has spent a slot.
 */
export function membershipOf(
  name: string,
  channel: SkillFiles | null,
  shared: SharedSkillPool | null
): SkillCandidateOrigin | null {
  if (shared !== null && shared.has(name)) return "shared";
  if (channel !== null) return "channel";
  return null;
}

/** The candidate resolved to its file, through whichever opener addresses it. */
export function readCandidate(
  name: string,
  channel: SkillFiles | null,
  shared: SharedSkillPool | null
): { readonly origin: SkillCandidateOrigin; readonly file: SkillFile } | null {
  const origin = membershipOf(name, channel, shared);
  if (origin === null) return null;

  const file = origin === "shared" ? shared?.read(name) : channel?.read(name);
  return file === null || file === undefined ? null : { origin, file };
}
