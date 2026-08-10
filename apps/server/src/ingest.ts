// The message write path: a `SlackMessage` becomes a `StoredMessage`.
//
// The sibling of handler.ts, and here for the same reason. It names both a
// Slack type and a session, which is exactly the pair `src/session/**`'s ESLint
// rule forbids in one file — so the mapping lives out here, above the seam, and
// the router below it goes on not knowing what Slack is.
//
// It is a shorter mapping than the mention one, and the difference is the
// point: a mention becomes a request that is answered, a message becomes a row
// that is filed. Nothing here can post, because nothing here holds a poster.

import type { MessageHandler, Logger, SlackMessage } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { DisplayNameLookup } from "./session/names.js";
import type { SessionRegistry } from "./session/registry.js";

export interface MessageIngestOptions {
  sessions: SessionRegistry;
  /**
   * How the author's name is found, for the snapshot stored beside the message.
   *
   * Optional: without one every row stores `null`, which is what #176 did and
   * is a store that still works. The snapshot and the context assembler's live
   * resolution answer different questions — "what were they called when this
   * was said" against "what are they called today" — and this is the first,
   * which is the only attribution available to a reader holding no Slack token.
   */
  names?: DisplayNameLookup;
  logger?: Logger;
  /** Injected so a test states the clock rather than faking timers. */
  now?: () => number;
}

/**
 * Wraps the session registry as the handler the gateway hands messages to.
 *
 * **It does not take the session's mutex, deliberately.** The mutex serializes
 * model turns so a channel's mentions queue rather than interleave; a store
 * write is one synchronous statement with nothing to serialize, and SQLite's
 * own WAL and busy timeout are the concurrency control for the file. Behind the
 * mutex, a message arriving mid-task would wait out a model turn — up to the
 * channel's whole wall-clock cap — to be written, which is the opposite of what
 * a transcript is for.
 *
 * It does open the session, so a message in a channel with nothing running is
 * still written, and so the open file handle has an owner with a lifetime.
 *
 * Nothing is deduplicated here. The store's `ts` is UNIQUE and its insert is
 * `ON CONFLICT DO NOTHING`, so a redelivered event is a no-op that returns
 * false — and that is the authoritative key, being the message's own identity
 * and surviving a restart, which the gateway's `seen` set does not.
 *
 * **It does await one thing, and that is new.** Resolving the author's name is
 * a Slack call, so this path can now be slow and can now fail in a way it could
 * not before. Both are bounded: the session's cache makes it one call per
 * author per session and shares an in-flight one between concurrent messages,
 * and a failed lookup stores no name rather than dropping the message. The
 * `append` still happens either way.
 */
export function createMessageIngest(options: MessageIngestOptions): MessageHandler {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const names = options.names;

  return async (message: SlackMessage): Promise<void> => {
    const session = options.sessions.open({
      // Slack's word for the workspace is `team_id`; the router's is
      // `workspace`, and this is the same translation handler.ts makes.
      workspace: message.teamId,
      channel: message.channelId
    });

    // No store: no team sheet, or the file could not be opened. Said once when
    // the session was created, and silent per message after that. Checked
    // before the name is resolved, so an unprovisioned channel costs no lookup.
    if (session.store === null) return;

    // The author's name as of now, cached on the session — so this is one Slack
    // call per author per session and not one per message, and two messages
    // from the same new author share one in-flight lookup rather than making
    // two. `undefined` when there is no name to have or the lookup failed, and
    // neither costs the message: the row is stored either way.
    const displayName =
      names === undefined ? undefined : await session.names.get(message.userId, names);

    try {
      session.store.append({
        ts: message.ts,
        threadTs: message.threadTs,
        userId: message.userId,
        // A snapshot, not a lookup: what the author was called when this was
        // said. It is deliberately not refreshed later, and the assembler's
        // live resolution is a different question with a different answer for
        // anyone who has since changed their name or left.
        displayName: displayName ?? null,
        text: message.text,
        // When this store learned of the message, not when it was sent — the
        // field's own definition. `message.ts` is the sent time and is stored
        // beside it.
        at: now()
      });
    } catch (error) {
      // One message lost, and the process carries on. The gateway would log
      // `message_failed` for a rejection, but this is the layer that knows it
      // was the store, and a channel's members do not want to be told in the
      // channel that their message was not filed.
      logger.log("error", {
        event: "store_write_failed",
        channel: message.channelId,
        eventId: message.eventId,
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
  };
}
