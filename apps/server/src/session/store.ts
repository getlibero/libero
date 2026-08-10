// The channel's message store: one SQLite file, opened once per session.
//
// The sibling of sheet.ts, and symmetric with it. That file resolves a model
// and four caps from `<channelsRoot>/<channel>/channel.toml`; this one resolves
// a handle to `<storeRoot>/<channel>/store.db`. Both take a channel id and both
// are total — they answer with a fallback rather than throwing, because the
// caller is `registry.open`, which is synchronous, uncaught, and on the path a
// mention takes.
//
// ### Why this is where the authorization gate is
//
// `packages/memory` does not create directories, and the argument in its header
// used to be that `channels/<id>/` is where the operator wrote `channel.toml` —
// the directory existing *was* the statement that the channel exists. That
// argument does not survive the store moving to its own root: nothing an
// operator does creates `<storeRoot>/<channel>/`, so a store that refused to
// mkdir would simply never open, and one that mkdir'd unconditionally would
// invent a channel with no team sheet and quietly log a conversation into it.
//
// So the rule is unchanged and its justification moved out one layer: this file
// checks the channel has a sheet, and only then creates the directory the store
// opens in. The gate is explicit here instead of implicit there, which is
// strictly better — it is a line of code with a test rather than a property of
// a filesystem layout.
//
// The sheet only has to *exist*. It is not read, not parsed, and a malformed
// one still counts: this is not the authorization decision, which the proxy
// makes from its own copy. It is the answer to "is this a channel the operator
// provisioned", and a broken sheet is a provisioned channel with a mistake in
// it.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { SHEET_FILENAME } from "./sheet.js";

/**
 * A channel's store, or `null` when it has none.
 *
 * `null` rather than a throw, and that is the whole contract. `registry.open`
 * is synchronous with no `await` between finding a session and queueing on it,
 * and `router.ts` calls it outside any `try` — so an opener that threw would
 * turn an unwritable disk into a mention that goes unanswered. A channel with
 * no store is a channel nothing is recorded for, which is a degradation the
 * next mention does not notice.
 */
export type MessageStoreOpener = (channel: string) => MessageStore | null;

export interface MessageStoreOpenerOptions {
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
 * Everything below is synchronous, because everything above it is:
 * `DatabaseSync` is, `registry.open` is, and an `existsSync` next to a file
 * open on a path that is about to be opened anyway is not the cost worth an
 * async seam.
 *
 * The failure is logged once per session rather than once per message, because
 * that is how often this runs — the session holds the result, `null` included,
 * so a channel with no sheet costs one line and then silence.
 */
export function createMessageStoreOpener(
  options: MessageStoreOpenerOptions
): MessageStoreOpener {
  const logger = options.logger ?? createSilentLogger();

  return (channel: string): MessageStore | null => {
    // Before either join, not after. This id becomes two path segments, and the
    // rule for what may be one is stated once in the schema's `ChannelId` —
    // `sheet.ts` asks the same question in the same place for the same reason.
    // A rejected id touches the filesystem not at all.
    if (!ChannelId.safeParse(channel).success) {
      logger.log("error", { event: "store_unavailable", channel, reason: "channel_id" });
      return null;
    }

    if (!existsSync(join(options.channelsRoot, channel, SHEET_FILENAME))) {
      // Not an error. The app is in a channel nobody provisioned — which is the
      // normal state of most channels in a workspace — and the right answer is
      // to record nothing there. `info`, so it is greppable when someone asks
      // why a channel has no history, and not alarming when it is expected.
      logger.log("info", { event: "store_unavailable", channel, reason: "no_team_sheet" });
      return null;
    }

    try {
      // SQLite writes `-wal` and `-shm` beside the file, so what has to exist
      // and be writable is the directory rather than the path.
      mkdirSync(join(options.storeRoot, channel), { recursive: true });
      return openMessageStore({ channel, root: options.storeRoot, logger });
    } catch (error) {
      // A reason code and nothing else: an errno from someone else's closed
      // vocabulary, or the class name. Never the message — `openMessageStore`
      // puts the file path in its errors, and `LogFields.file` is the declared
      // place for a path.
      logger.log("error", {
        event: "store_unavailable",
        channel,
        reason: errnoOf(error) ?? (error instanceof Error ? error.name : "unknown")
      });
      return null;
    }
  };
}
