// The Slack adapter, and the only file in this process besides index.ts that
// knows what Slack is.
//
// Its whole job is six lines of mapping: a `SlackMention` becomes a
// `TaskRequest`, and whatever the router replies becomes a `SlackReply`.
// Everything channel-shaped happens on the other side of that mapping —
// sessions, the mutex, the team sheet, the loop — and none of it can name a
// Slack type, because an ESLint rule on `src/session/**` says so rather than a
// comment asking nicely.
//
// That is what makes this file the seam. A second front-end — Teams, an HTTP
// endpoint, a CLI — writes its own version of this mapping and reaches the same
// router, the same sheets, and the same per-channel serialization, without
// anything below it changing.
//
// `SlackReply` and `TaskReply` are structurally identical today, so the return
// mapping is a pass-through. It is written out rather than cast: the two types
// belong to different layers and only one of them is allowed to grow Slack's
// blocks, attachments, and message ts.

import type { MentionHandler, SlackMention, SlackReply } from "@getlibero/gateway";
import type { ChannelRouter } from "./session/router.js";

/**
 * Wraps the router as the handler the gateway dispatches to.
 *
 * The gateway goes on dispatching mentions concurrently, which it must: it
 * acknowledges an inbound event within about three seconds or Slack redelivers
 * it, and a mention queued behind a slow task cannot be holding that
 * acknowledgement. Queueing happens under the router, below the acknowledgement
 * and above nothing.
 */
export function createMentionHandler(route: ChannelRouter): MentionHandler {
  return async (mention: SlackMention): Promise<SlackReply | undefined> => {
    const reply = await route({
      // `team_id` is Slack's word for the workspace; the router's word is
      // `workspace`, and this is where the translation happens.
      key: { workspace: mention.teamId, channel: mention.channelId },
      requestingUser: mention.userId,
      text: mention.text,
      // Slack's `event_id`, stable across delivery retries, so one grep ties a
      // task's log lines back to the message a person actually sent.
      traceId: mention.eventId
    });

    return reply === undefined ? undefined : { text: reply.text };
  };
}
