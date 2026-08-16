// A channel's `proposals/` directory, gated the way its `skills/` is.
//
// ./skills.ts's twin, and everything that file's header argues holds here word
// for word: the same two roots, the same team-sheet gate, the same `null` rather
// than a throw, and no directory created out here. What differs is two things,
// and neither changes the shape.
//
// **There is no cap to take.** `SkillFilesOpener` takes `maxSkills` because
// `openSkillFiles` cannot be opened without one; this directory enforces no cap
// of its own. What bounds how many proposals may be waiting is the curator's
// `MAX_OPEN_PROPOSALS`, compared against `count()` by the pass that would write
// the next one — and taking the figure as an option here, never to compare it
// against anything, would be a mechanism implying it guards a hazard it cannot
// reach. That is `max_skill_chars`'s argument in `packages/memory`, arriving at
// the same answer from the other side.
//
// **It is opened per pass rather than per task**, which follows from having no
// cap: there is nothing sheet-shaped inside it that could go stale, so the only
// reason to reopen is that reopening is free.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { SkillProposals } from "@getlibero/memory";
import { openSkillProposals } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { SHEET_FILENAME } from "./sheet.js";

/**
 * A channel's merge proposals, or `null` when it has none it may reach.
 *
 * `null` rather than a throw, `SkillFilesOpener`'s reason: a channel that stopped
 * answering mentions because its proposals directory could not be opened would be
 * an outage caused by a feature nobody is waiting on.
 */
export type SkillProposalsOpener = (channel: string) => SkillProposals | null;

export interface SkillProposalsOpenerOptions {
  /** `AGENT_STORE_ROOT` — the writable root, one directory per channel. */
  storeRoot: string;
  /** `AGENT_CHANNELS_ROOT` — read only, and only to ask whether a sheet is there. */
  channelsRoot: string;
  logger?: Logger;
}

/** The errno of a failed filesystem call, or `undefined` when it was not one. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds the opener. It never throws.
 *
 * One event word, `skill_proposals_unavailable`, with a reason — ./skills.ts's
 * shape, so an operator greps one pattern across all of them. `no_team_sheet` is
 * `info` for its reason there: an unprovisioned channel is expected, and a line
 * that alarms about the expected case is a line people stop reading.
 *
 * **This creates no directory**, ./skills.ts's rule and its reason: a channel
 * whose sheet says `curate = false` must never acquire an empty `proposals/` it
 * did not ask for, and `openSkillProposals` creates one lazily on the first write
 * for exactly that.
 */
export function createSkillProposalsOpener(
  options: SkillProposalsOpenerOptions
): SkillProposalsOpener {
  const logger = options.logger ?? createSilentLogger();

  return (channel: string): SkillProposals | null => {
    if (!ChannelId.safeParse(channel).success) {
      logger.log("error", { event: "skill_proposals_unavailable", channel, reason: "channel_id" });
      return null;
    }

    if (!existsSync(join(options.channelsRoot, channel, SHEET_FILENAME))) {
      logger.log("info", {
        event: "skill_proposals_unavailable",
        channel,
        reason: "no_team_sheet"
      });
      return null;
    }

    try {
      return openSkillProposals({ channel, root: options.storeRoot, logger });
    } catch (error) {
      // A reason code and never the message: `openSkillProposals` puts the
      // directory path in its errors, and `LogFields` has a declared place for a
      // path that this line is not using.
      logger.log("error", {
        event: "skill_proposals_unavailable",
        channel,
        reason: errnoOf(error) ?? (error instanceof Error ? error.name : "unknown")
      });
      return null;
    }
  };
}
