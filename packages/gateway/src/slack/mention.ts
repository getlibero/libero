// Turning one events_api envelope into a SlackMention, or into a reason it is
// not one.
//
// Pure, and the only code in the package that reads the wire shape. It imports
// no SDK type: what arrives is `unknown` and every field is read defensively,
// so a payload change is a logged `ignored` line rather than a crash in the
// dispatch loop.
//
// It fails closed. A field it cannot read confidently is a reason to ignore the
// event, never a reason to guess — an adapter that guesses a channel id posts
// into the wrong channel, and the channel is what the whole authorization model
// is keyed on.
//
// Note what is deliberately not read: the outer body carries Slack's legacy
// verification `token`, and nothing here touches it. Socket Mode authenticates
// the connection, so that field is neither needed nor safe to start handling.

import type { SlackEnvelope, SlackMention } from "./types.js";

/**
 * Why an envelope is not an answerable mention. A closed set — each one is a
 * `reason` in a log line, so they double as the grep terms for "why did the
 * agent not answer me".
 */
export type IgnoreReason =
  /** Posted by an app, including this one. Answering it is how a loop starts. */
  | "bot_message"
  /** An edit, a deletion, or another subtype. The router mirrors those; the adapter does not answer them. */
  | "message_subtype"
  /** The envelope was not shaped like an events_api `app_mention` at all. */
  | "not_a_mention"
  /** A field the reply depends on was missing or not a string. */
  | "missing_field";

export type MentionResult = { mention: SlackMention } | { ignored: IgnoreReason };

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
 * Normalizes an `app_mention` envelope.
 *
 * The reply target is `thread_ts ?? ts`: a mention inside a thread is answered
 * in that thread, and a top-level mention starts one. Replying to a top-level
 * mention in the channel instead is what turns a busy channel into noise, so
 * the adapter has no way to express it.
 */
export function toMention(envelope: SlackEnvelope): MentionResult {
  const event = asRecord(envelope.event);
  const body = asRecord(envelope.body);
  if (event === undefined || body === undefined) return { ignored: "not_a_mention" };
  if (event["type"] !== "app_mention") return { ignored: "not_a_mention" };

  // A bot's own mention of itself, or one app tagging another. Answering it is
  // how two bots talk to each other until a budget stops them. `bot_id` is the
  // documented signal and the only one checked: `app_id` appears on payloads
  // Slack routes through an app without the message being a bot's, so keying on
  // it would silently stop answering people.
  if (event["bot_id"] !== undefined) return { ignored: "bot_message" };

  // Edits and deletions arrive as subtypes rather than as their own events. The
  // message store mirrors them; the adapter answering one would answer its own
  // edit.
  if (event["subtype"] !== undefined) return { ignored: "message_subtype" };

  const teamId = readString(body, "team_id");
  const eventId = readString(body, "event_id");
  const channelId = readString(event, "channel");
  const userId = readString(event, "user");
  const ts = readString(event, "ts");
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
    mention: {
      teamId,
      channelId,
      userId,
      text,
      ts,
      threadTs: readString(event, "thread_ts") ?? ts,
      eventId
    }
  };
}
