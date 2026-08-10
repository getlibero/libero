// Turning one events_api envelope into a SlackMessage, or into a reason it is
// not one.
//
// The sibling of mention.ts and written to the same rules: pure, importing no
// SDK type, reading every field defensively, failing closed. It duplicates
// `asRecord` and `readString` rather than sharing them, for the reason
// decision.ts gives — each of these files stays the whole account of how one
// payload is read, and a shared helper is how a change made for one payload
// silently changes another.
//
// The one field that makes this a separate function rather than a flag on
// `toMention` is `threadTs`. There it is a reply target and is coalesced to
// `thread_ts ?? ts`; here it is the raw value or null, because a store that
// coalesced it could never say whether a message was top-level.
//
// What is read is what is recorded, and nothing more: no `blocks`, no `files`,
// no `edited`. Slack's legacy verification `token` on the outer body is not
// touched here either, for the reason mention.ts states.

import type { SlackEnvelope, SlackMessage } from "./types.js";

/**
 * Subtypes that are still an ordinary person saying something.
 *
 * Most subtypes are events wearing a message's clothes — a join, a topic
 * change, a pinned item — and recording them would put system chatter in a
 * channel's transcript. These two are not: `thread_broadcast` is a threaded
 * reply the author also sent to the channel, and `file_share` is a message
 * whose author attached something. Both carry a real `user`, a real `ts`, and
 * text a person typed, and both read identically to a plain message for every
 * field below.
 *
 * Excluding them would leave holes in the conversation the context assembler
 * (#67) reads back, which is the cost that decided this. The attachment itself
 * is not recorded — a file is not text, and the store holds text.
 */
const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share"]);

/** The subtypes that carry an edit or a deletion, rather than a new message. */
const REVISION_SUBTYPES: ReadonlySet<string> = new Set(["message_changed", "message_deleted"]);

/**
 * Why an envelope is not a message to record. A closed set — each one is a
 * `reason` in a log line, as with `IgnoreReason`.
 */
export type MessageIgnoreReason =
  /** Posted by an app, including this one. */
  | "bot_message"
  /**
   * An edit or a deletion of a message already recorded.
   *
   * Its own reason rather than `message_subtype`, because it is the one drop
   * here that is work deferred rather than content declined: the store has
   * `remove` and `replaceText` waiting for it, and mirroring these onto them is
   * #177. A distinct code is what makes "how often does this actually happen in
   * this workspace" a grep rather than a guess.
   */
  | "message_edit"
  /** A join, a topic change, a pinned item — a system event, not a message. */
  | "message_subtype"
  /** The envelope was not shaped like an events_api `message` at all. */
  | "not_a_message"
  /** A field the record depends on was missing or not a string. */
  | "missing_field";

export type MessageResult = { message: SlackMessage } | { ignored: MessageIgnoreReason };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A present, non-empty string. Slack sends `""` for absent text in some subtypes. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalizes a `message` envelope.
 *
 * A mention arrives twice — once as `app_mention` and once as `message` — and
 * both are kept: this path records it and the other answers it. They cannot
 * double-record, because the store's identity is the message's `ts` and only
 * this path writes.
 *
 * A message this app posted is dropped on `bot_id`, so a stored conversation is
 * one-sided: the agent's own replies are not in it. Whether the assembler wants
 * them back is #67's question, and answering it here would mean deciding what a
 * bot message from *another* app is worth, which is a separate one.
 */
export function toMessage(envelope: SlackEnvelope): MessageResult {
  const event = asRecord(envelope.event);
  const body = asRecord(envelope.body);
  if (event === undefined || body === undefined) return { ignored: "not_a_message" };
  if (event["type"] !== "message") return { ignored: "not_a_message" };

  // Before the subtype check, so a `bot_message` subtype is reported as what it
  // is. `bot_id` and not `app_id`, for the reason mention.ts gives: `app_id`
  // appears on payloads Slack merely routed through an app.
  if (event["bot_id"] !== undefined) return { ignored: "bot_message" };

  const subtype = event["subtype"];
  if (subtype !== undefined) {
    if (typeof subtype !== "string") return { ignored: "message_subtype" };
    if (REVISION_SUBTYPES.has(subtype)) return { ignored: "message_edit" };
    if (!ALLOWED_SUBTYPES.has(subtype)) return { ignored: "message_subtype" };
  }

  const teamId = readString(body, "team_id");
  const eventId = readString(body, "event_id");
  const channelId = readString(event, "channel");
  const userId = readString(event, "user");
  const ts = readString(event, "ts");
  // Not `readString`: a `file_share` with no comment carries `""`, and an empty
  // message is still a message that happened at a time by a person.
  const text = typeof event["text"] === "string" ? event["text"] : undefined;

  if (
    teamId === undefined ||
    eventId === undefined ||
    channelId === undefined ||
    userId === undefined ||
    ts === undefined ||
    text === undefined
  ) {
    return { ignored: "missing_field" };
  }

  return {
    message: {
      teamId,
      channelId,
      userId,
      text,
      ts,
      // The raw value. `?? null` and never `?? ts` — see the header.
      threadTs: readString(event, "thread_ts") ?? null,
      eventId
    }
  };
}
