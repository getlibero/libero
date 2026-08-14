// A channel's `MEMORY.md`, gated the way its message store is.
//
// The third sibling of ./sheet.ts and ./store.ts, and symmetric with the second:
// the same two roots, the same team-sheet gate, the same `null` rather than a
// throw. `MEMORY.md` lives beside `store.db` under `AGENT_STORE_ROOT`, because it
// is something the agent writes and the channels root is where the proxy reads
// authorization from.
//
// ## Why this exists rather than calling `openMemoryFile` directly
//
// Two reasons, and the second is the one that would bite.
//
// **The sheet gate.** `packages/memory` creates no directory and asks no
// question about whether a channel is real, deliberately — so the check that the
// operator provisioned this channel lives out here, exactly as it does for the
// store. Without it a curation turn would file a channel nobody authorized.
//
// **`openMemoryFile` throws, and nothing above here may.** It throws on an
// invalid channel id, on a cap below one operation's ceiling, and on a missing
// state directory. Its own README says a caller needs `createMessageStoreOpener`'s
// never-throw shape, and this is that caller. The path a mention takes is
// synchronous and uncaught through `registry.open` and `router.ts`, so a channel
// whose sheet has a mistyped `[memory] max_file_chars` must lose its memory
// rather than stop answering.
//
// ## Opened per task, not per session
//
// Unlike the store, which the registry opens once and hangs off the session. The
// cap comes from the channel's team sheet, and the sheet is read per task inside
// the session's lock — the registry never sees one. Reopening is close to free:
// `MemoryFile` holds a validated id, a path and a number, opens no handle, and
// has no `close`. Doing it per task also means an operator's edit to
// `max_file_chars` lands on the next task, which is the same freshness every
// other sheet value gets.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MemoryFile } from "@getlibero/memory";
import { openMemoryFile } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { SHEET_FILENAME } from "./sheet.js";

/**
 * A channel's `MEMORY.md`, or `null` when it has none it may write.
 *
 * `null` rather than a throw, for `MessageStoreOpener`'s reason. A channel with
 * no memory file answers exactly as it did before phase 2; a channel that
 * stopped answering because a number in its sheet was wrong is an outage.
 *
 * Takes the cap because the file cannot be opened without one and the sheet is
 * the only thing that knows it — see the header on why that means per task.
 */
export type MemoryFileOpener = (channel: string, maxFileChars: number) => MemoryFile | null;

export interface MemoryFileOpenerOptions {
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
 * One event word, `memory_unavailable`, with a reason — `store.ts`'s shape, so
 * an operator greps one pattern for both files. `no_team_sheet` is `info` for
 * the same reason it is there: an unprovisioned channel is expected, and a line
 * that alarms about the expected case is a line people stop reading.
 *
 * **This creates no directory, unlike the store's opener.** The store's `mkdir`
 * is what makes a channel's state directory exist at all, and it runs first —
 * every mention goes through `registry.open` before any task runs. Repeating it
 * here would be a second place that decides a channel is real, and the failure
 * it would paper over is one worth seeing: no state directory means no store
 * either, which is a deployment to look at rather than a file to create.
 */
export function createMemoryFileOpener(options: MemoryFileOpenerOptions): MemoryFileOpener {
  const logger = options.logger ?? createSilentLogger();

  return (channel: string, maxFileChars: number): MemoryFile | null => {
    if (!ChannelId.safeParse(channel).success) {
      logger.log("error", { event: "memory_unavailable", channel, reason: "channel_id" });
      return null;
    }

    if (!existsSync(join(options.channelsRoot, channel, SHEET_FILENAME))) {
      logger.log("info", { event: "memory_unavailable", channel, reason: "no_team_sheet" });
      return null;
    }

    try {
      return openMemoryFile({ channel, root: options.storeRoot, maxFileChars, logger });
    } catch (error) {
      // A reason code and never the message: `openMemoryFile` puts the file path
      // and the cap in its errors, and `LogFields` has a declared place for a
      // path and none for a number.
      logger.log("error", {
        event: "memory_unavailable",
        channel,
        reason: errnoOf(error) ?? (error instanceof Error ? error.name : "unknown")
      });
      return null;
    }
  };
}
