// A channel's `skills/` directory, gated the way its `MEMORY.md` is.
//
// The fourth sibling of ./sheet.ts, ./store.ts and ./memory.ts, and symmetric
// with the third in every respect that matters: the same two roots, the same
// team-sheet gate, the same `null` rather than a throw. `skills/` lives beside
// `MEMORY.md` and `store.db` under `AGENT_STORE_ROOT`, because it is something
// the agent writes and the channels root is where the proxy reads authorization
// from.
//
// ## Why this exists rather than calling `openSkillFiles` directly
//
// ./memory.ts's two reasons, unchanged.
//
// **The sheet gate.** `packages/memory` creates no channel state directory and
// asks no question about whether a channel is real. Without the check out here,
// retrieval would file a channel nobody authorized — and, once #291 lands, write
// into it.
//
// **`openSkillFiles` throws, and nothing above here may.** It throws on an
// invalid channel id, on a `maxSkills` that is not a positive integer, and on a
// missing state directory. The path a mention takes is uncaught through
// `registry.open` and `router.ts`, so a channel whose sheet has a mistyped
// `[skills] max_skills` must lose its skills rather than stop answering.
//
// ## Opened per task, not per session
//
// ./memory.ts's reason again: the cap comes from the team sheet, the sheet is
// read per task inside the session's lock, and the registry never sees one.
// Reopening is close to free — `SkillFiles` holds a validated id, a path and a
// number, opens no handle, and has no `close` — and it means an operator's edit
// to `max_skills` lands on the next task.
//
// ## What this does *not* do, and the difference from ./memory.ts is deliberate
//
// **It creates no `skills/` directory.** `openSkillFiles` creates one lazily, on
// the first successful write and never on a read, which is what keeps a channel
// whose sheet says `enabled = false` from acquiring an empty directory it never
// asked for. Doing it eagerly here would undo that, and #300 says so explicitly.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { SkillFiles } from "@getlibero/memory";
import { openSkillFiles } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { SHEET_FILENAME } from "./sheet.js";

/**
 * A channel's skills directory, or `null` when it has none it may reach.
 *
 * `null` rather than a throw, for `MemoryFileOpener`'s reason. A channel with no
 * skills answers exactly as it did before phase 3; a channel that stopped
 * answering because a number in its sheet was wrong is an outage.
 *
 * Takes the cap because the directory cannot be opened without one and the sheet
 * is the only thing that knows it — see the header on why that means per task.
 */
export type SkillFilesOpener = (channel: string, maxSkills: number) => SkillFiles | null;

export interface SkillFilesOpenerOptions {
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
 * One event word, `skills_unavailable`, with a reason — ./memory.ts's and
 * ./store.ts's shape, so an operator greps one pattern across all three.
 * `no_team_sheet` is `info` for the reason it is there: an unprovisioned channel
 * is expected, and a line that alarms about the expected case is a line people
 * stop reading.
 *
 * **This creates no directory**, unlike the store's opener and like
 * ./memory.ts's. The store's `mkdir` is what makes a channel's state directory
 * exist at all and it runs first, on every mention, through `registry.open`.
 * `ENOENT` from `openSkillFiles` therefore means no state directory, which is a
 * deployment to look at rather than a directory to create.
 */
export function createSkillFilesOpener(options: SkillFilesOpenerOptions): SkillFilesOpener {
  const logger = options.logger ?? createSilentLogger();

  return (channel: string, maxSkills: number): SkillFiles | null => {
    if (!ChannelId.safeParse(channel).success) {
      logger.log("error", { event: "skills_unavailable", channel, reason: "channel_id" });
      return null;
    }

    if (!existsSync(join(options.channelsRoot, channel, SHEET_FILENAME))) {
      logger.log("info", { event: "skills_unavailable", channel, reason: "no_team_sheet" });
      return null;
    }

    try {
      return openSkillFiles({ channel, root: options.storeRoot, maxSkills, logger });
    } catch (error) {
      // A reason code and never the message: `openSkillFiles` puts the directory
      // path and the cap in its errors, and `LogFields` has a declared place for
      // a path and none for a number.
      logger.log("error", {
        event: "skills_unavailable",
        channel,
        reason: errnoOf(error) ?? (error instanceof Error ? error.name : "unknown")
      });
      return null;
    }
  };
}
