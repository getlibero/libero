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
import type { SessionRegistry } from "./session/registry.js";

export interface MessageIngestOptions {
  sessions: SessionRegistry;
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
 */
export function createMessageIngest(options: MessageIngestOptions): MessageHandler {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  return (message: SlackMessage): Promise<void> => {
    const session = options.sessions.open({
      // Slack's word for the workspace is `team_id`; the router's is
      // `workspace`, and this is the same translation handler.ts makes.
      workspace: message.teamId,
      channel: message.channelId
    });

    // No store: no team sheet, or the file could not be opened. Said once when
    // the session was created, and silent per message after that.
    if (session.store === null) return Promise.resolve();

    try {
      session.store.append({
        ts: message.ts,
        threadTs: message.threadTs,
        userId: message.userId,
        // A snapshot of the author's name, and nothing here has one to take:
        // resolving a user id is a Slack API call with a cache in front of it,
        // which is #67's. Null now, filled by whatever fills it later.
        displayName: null,
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

    return Promise.resolve();
  };
}
