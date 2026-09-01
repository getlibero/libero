// Turning one `message` envelope into a SlackRevision — the deletion or the
// edit of a message already recorded — or into a reason it is not one.
//
// The third normalizer, written to the rules mention.ts and message.ts keep:
// pure, importing no SDK type, reading every field defensively, failing closed,
// and duplicating `asRecord` and `readString` rather than sharing them, so this
// file stays the whole account of how one payload is read.
//
// It is reached from the same subscription and the same dispatch an ordinary
// message takes. `toMessage` answers `message_edit` for exactly these subtypes,
// and that reason is the seam: the gateway hands the envelope on rather than
// deciding a second time what kind of payload it is holding.
//
// **Deletions are read permissively and edits strictly**, because the two ways
// of being wrong are not the same size. A deletion this file drops leaves text
// its author retracted in a file that enters the model's context on every turn;
// a deletion it passes on for a message the store never held is a no-op, since
// `remove` answers false. An edit is the one that can *write*, so it is the one
// carrying a filter.
//
// What is deliberately not restated here is which subtypes the store agreed to
// record. `ALLOWED_SUBTYPES` lives in message.ts and stays there: the store
// already holds exactly the messages that passed it, and both store operations
// are keyed on `ts`, so the store's own contents are the filter — a second copy
// of that policy is a copy that goes out of step, and going out of step means
// an edit to a stored `file_share` silently not mirrored.

import type { SlackEnvelope, SlackRevision } from "./types.js";

/**
 * Why an envelope is not a revision to mirror. A closed set — each one is a
 * `reason` in a log line, as with `IgnoreReason`.
 */
export type RevisionIgnoreReason =
  /**
   * An app's edit of its own message, including this one's.
   *
   * **Volume, not correctness — and #523 narrowed what that sentence rests
   * on.** It used to rest on "a bot's message is never stored", so mirroring
   * one would be a no-op anyway. That is no longer true of this app's own text
   * replies, which `toMessage` now keeps.
   *
   * What the drop still saves is the work, and the work is all of it: the live
   * checklist edits its card on every step and each edit arrives here as a
   * `message_changed`, so without this the gateway would open a session and run
   * a statement per checklist tick. What it costs is one case that does not
   * happen — only the posting app can edit its own message, and the only thing
   * this app edits is a card, which was never stored.
   *
   * **Deletions are unaffected and still mirror.** `message_deleted` is read
   * before this check and carries no filter at all, so a reply deleted in Slack
   * is deleted here; that is the half of retention parity #523 actually needed,
   * and it is the half the permissive reading above was already written for.
   * The tombstone path sits below this check, which costs nothing: this app's
   * replies are replies, never a thread parent with replies of their own.
   */
  | "bot_message"
  /** Not a `message` event, or not one of the two revision subtypes. */
  | "not_a_revision"
  /** The ts of the revised message, or an edit's new text, was not readable. */
  | "missing_field";

export type RevisionResult = { revision: SlackRevision } | { ignored: RevisionIgnoreReason };

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
 * Normalizes a `message_deleted` or `message_changed` envelope.
 *
 * The two subtypes do not map one-to-one onto the two kinds, and that is the
 * one surprise in this file. A `message_changed` whose nested message carries
 * `subtype: "tombstone"` is a **deletion**: Slack sends it in place of
 * `message_deleted` when the deleted message was a thread parent with replies,
 * because the thread has to keep something to hang them on. Read as an edit it
 * would replace a channel's stored text with Slack's placeholder and leave the
 * row standing, so a retracted thread parent would outlive its retraction —
 * exactly the case this whole path exists for.
 */
export function toRevision(envelope: SlackEnvelope): RevisionResult {
  const event = asRecord(envelope.event);
  const body = asRecord(envelope.body);
  if (event === undefined || body === undefined) return { ignored: "not_a_revision" };
  if (event["type"] !== "message") return { ignored: "not_a_revision" };

  const subtype = event["subtype"];
  const teamId = readString(body, "team_id");
  const eventId = readString(body, "event_id");
  const channelId = readString(event, "channel");
  if (teamId === undefined || eventId === undefined || channelId === undefined) {
    // Before the subtype split, because these three are what any revision needs
    // and neither branch can do anything useful without them.
    return subtype === "message_deleted" || subtype === "message_changed"
      ? { ignored: "missing_field" }
      : { ignored: "not_a_revision" };
  }

  if (subtype === "message_deleted") {
    // `deleted_ts` and not the envelope's own `ts`, which is when the deletion
    // happened. `previous_message.ts` carries the same value on payloads that
    // have one, and is not read: one field, so there is no case where the two
    // disagree and this has to pick.
    const ts = readString(event, "deleted_ts");
    if (ts === undefined) return { ignored: "missing_field" };
    return { revision: { kind: "deleted", teamId, channelId, ts, eventId } };
  }

  if (subtype !== "message_changed") return { ignored: "not_a_revision" };

  const message = asRecord(event["message"]);
  if (message === undefined) return { ignored: "missing_field" };
  // On the nested message, which is where an edit's `bot_id` lives — the outer
  // event carries none. `bot_id` and not `app_id`, for the reason mention.ts
  // gives.
  if (message["bot_id"] !== undefined) return { ignored: "bot_message" };

  const ts = readString(message, "ts");
  if (ts === undefined) return { ignored: "missing_field" };

  // A deleted thread parent, wearing an edit's clothes. See the doc comment.
  if (message["subtype"] === "tombstone") {
    return { revision: { kind: "deleted", teamId, channelId, ts, eventId } };
  }

  // Not `readString`: an edit that empties a `file_share`'s comment sends `""`,
  // and storing that is how the retraction gets mirrored. `undefined` here is a
  // payload with no text at all, which is nothing this can act on.
  const text = message["text"];
  if (typeof text !== "string") return { ignored: "missing_field" };

  return { revision: { kind: "edited", teamId, channelId, ts, text, eventId } };
}
