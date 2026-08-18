// Which channels this deployment has, as a directory listing (#317).
//
// The sibling of ./sheet.ts and ./store.ts, and the third thing built over a
// root: that one resolves `<channelsRoot>/<channel>/channel.toml`, this one
// answers what `<channel>` can be. It is a separate module for their reason —
// composition takes constructed openers and holds no environment — and so the
// scheduler above it can be driven in a test with no filesystem at all.
//
// **Read only, and only names.** The channels root is the tool proxy service's
// authorization source; this process must never write there, and nothing here
// opens a file. What comes back is what an operator provisioned, which is the
// only honest answer to "which channels exist" — a live session means a channel
// that has had traffic, and the whole point of ambient is the channel that has
// not.

import { readdir } from "node:fs/promises";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { ChannelId } from "@getlibero/schema";

/**
 * The channel ids this deployment has, in name order.
 *
 * **Never rejects.** The one caller runs on a clock with nobody waiting on it,
 * and a wrong mount should cost a scan rather than take a process down: an
 * unreadable root is one log line and an empty list, and the next scan asks
 * again.
 */
export type ChannelLister = () => Promise<string[]>;

export interface ChannelListerOptions {
  /** `AGENT_CHANNELS_ROOT` — read only, and only to learn which channels exist. */
  channelsRoot: string;
  logger?: Logger;
}

/** The errno of a failed read, or `undefined` when it was not a filesystem error. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds the lister.
 *
 * Directories only, and only those whose name is a `ChannelId` — the gate
 * `doctor`'s enumerator applies and the one ./sheet.ts applies before an id
 * becomes a path segment, asked of the schema rather than reimplemented. A stray
 * file, an editor's backup, or a directory named something that could never be a
 * channel is not a channel.
 *
 * Whether a channel has a *sheet* is deliberately not checked. One with none
 * resolves to the built-in defaults, where every optional feature is off, so it
 * is skipped by the same branch that skips a channel which wrote
 * `enabled = false` — and a second existence check here would be a second answer
 * to a question ./sheet.ts already answers.
 */
export function createChannelLister(options: ChannelListerOptions): ChannelLister {
  const logger = options.logger ?? createSilentLogger();

  return async (): Promise<string[]> => {
    try {
      const entries = await readdir(options.channelsRoot, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory() && ChannelId.safeParse(entry.name).success)
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      logger.log("error", {
        event: "channels_unreadable",
        // The errno and nothing else, which is ./sheet.ts's rule: a code from
        // someone else's closed vocabulary, carrying no path.
        reason: errnoOf(error) ?? "unknown"
      });
      return [];
    }
  };
}
