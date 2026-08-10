import { describe, expect, it } from "vitest";
import { toMessage } from "./message.js";
import type { SlackEnvelope } from "./types.js";

/** Builds an envelope by overriding the two halves independently. */
function envelope(
  event: Record<string, unknown> = {},
  body: Record<string, unknown> = {}
): SlackEnvelope {
  return {
    ack: () => Promise.resolve(),
    event: {
      type: "message",
      user: "U0ALICE",
      text: "the deploy went out at four",
      ts: "1717171717.000100",
      channel: "C0CHAN",
      ...event
    },
    body: {
      team_id: "T0TEAM",
      event_id: "Ev0EVENT",
      type: "event_callback",
      ...body
    }
  };
}

function messageOf(result: ReturnType<typeof toMessage>) {
  if (!("message" in result)) throw new Error(`expected a message, got ${result.ignored}`);
  return result.message;
}

function ignoredOf(result: ReturnType<typeof toMessage>) {
  if (!("ignored" in result)) throw new Error("expected the envelope to be ignored");
  return result.ignored;
}

describe("toMessage", () => {
  it("normalizes a top-level message and records no thread", () => {
    const message = messageOf(toMessage(envelope()));

    expect(message).toEqual({
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      userId: "U0ALICE",
      text: "the deploy went out at four",
      ts: "1717171717.000100",
      threadTs: null,
      eventId: "Ev0EVENT"
    });
  });

  it("keeps the raw thread_ts rather than coalescing it to the message's own ts", () => {
    // The one thing this normalizer exists for. `toMention` writes
    // `thread_ts ?? ts` because it is choosing a reply target; doing that here
    // would make a top-level message indistinguishable from a self-threaded one
    // and the store could never tell them apart again.
    const message = messageOf(
      toMessage(envelope({ ts: "1717171800.000200", thread_ts: "1717171717.000100" }))
    );

    expect(message.ts).toBe("1717171800.000200");
    expect(message.threadTs).toBe("1717171717.000100");
  });

  it("takes the team from the envelope body, not from the event", () => {
    // Slack Connect: `event.team` is the author's workspace, not the one the app
    // is installed in, and the session is keyed on the latter.
    const message = messageOf(toMessage(envelope({ team: "T0GUEST" }, { team_id: "T0HOST" })));

    expect(message.teamId).toBe("T0HOST");
  });

  it("keeps a timestamp as the exact string it arrived as", () => {
    // The ts is the store's primary identity. Through Number() it loses its
    // trailing digits, and a redelivery would then land on a different row.
    expect(messageOf(toMessage(envelope({ ts: "1717171717.000100" }))).ts).toBe(
      "1717171717.000100"
    );
  });

  it("keeps mention tokens in the text", () => {
    // Resolving `<@U…>` to a name is the context assembler's, and it needs the
    // token to do it.
    const message = messageOf(toMessage(envelope({ text: "ask <@U0BOT> about it" })));

    expect(message.text).toBe("ask <@U0BOT> about it");
  });

  it("records a message with no subtype", () => {
    expect(messageOf(toMessage(envelope())).text).toBe("the deploy went out at four");
  });

  it.each([["thread_broadcast"], ["file_share"]])(
    "records a %s, which is still a person saying something",
    subtype => {
      // Excluded, these leave holes in the transcript #67 reads back: a broadcast
      // reply and a message with a file attached are both text a person typed.
      expect(messageOf(toMessage(envelope({ subtype }))).userId).toBe("U0ALICE");
    }
  );

  it("accepts an empty text on a file_share", () => {
    // An attachment with no comment. Still a person, at a time, in a channel —
    // and the file itself is not recorded, because a file is not text.
    expect(messageOf(toMessage(envelope({ subtype: "file_share", text: "" }))).text).toBe("");
  });

  it("ignores unknown extra fields", () => {
    expect(messageOf(toMessage(envelope({ something_new: 1 }, { also_new: 2 }))).userId).toBe(
      "U0ALICE"
    );
  });

  it("ignores a message posted by a bot, including this app's own replies", () => {
    // The consequence is that a stored conversation is one-sided. That is #67's
    // to revisit; what must not happen is the agent recording itself by default.
    expect(ignoredOf(toMessage(envelope({ bot_id: "B0BOT" })))).toBe("bot_message");
  });

  it("reports a bot message as a bot message even when it also carries a subtype", () => {
    // `bot_message` is itself a subtype, so the order of the two checks decides
    // which reason an operator greps for.
    expect(ignoredOf(toMessage(envelope({ bot_id: "B0BOT", subtype: "bot_message" })))).toBe(
      "bot_message"
    );
  });

  it.each([["message_changed"], ["message_deleted"]])(
    "reports %s as an edit rather than as an unwanted subtype",
    subtype => {
      // Its own code because it is work deferred rather than content declined:
      // the store has `remove` and `replaceText` waiting, and mirroring onto
      // them is #177. The distinct reason is what makes "how often does this
      // happen here" a grep.
      expect(ignoredOf(toMessage(envelope({ subtype })))).toBe("message_edit");
    }
  );

  it.each([["channel_join"], ["channel_topic"], ["pinned_item"], ["channel_archive"]])(
    "ignores the system event %s",
    subtype => {
      expect(ignoredOf(toMessage(envelope({ subtype })))).toBe("message_subtype");
    }
  );

  it("ignores a subtype that is not a string rather than coercing it", () => {
    expect(ignoredOf(toMessage(envelope({ subtype: 42 })))).toBe("message_subtype");
  });

  it("ignores an event that is not a message", () => {
    expect(ignoredOf(toMessage(envelope({ type: "app_mention" })))).toBe("not_a_message");
  });

  it("ignores an envelope that is not shaped like an event at all", () => {
    expect(ignoredOf(toMessage({ ack: () => Promise.resolve(), event: null, body: {} }))).toBe(
      "not_a_message"
    );
    expect(ignoredOf(toMessage({ ack: () => Promise.resolve(), event: {}, body: "nope" }))).toBe(
      "not_a_message"
    );
  });

  it("ignores an event missing any field the record depends on", () => {
    expect(ignoredOf(toMessage(envelope({ channel: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({ user: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({ ts: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({ text: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({}, { team_id: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({}, { event_id: undefined })))).toBe("missing_field");
  });

  it("treats an empty-string id as missing rather than as an id", () => {
    // The channel id becomes a directory name and a SQLite filename. An empty
    // one that survived normalization is a write into the store root itself.
    expect(ignoredOf(toMessage(envelope({ channel: "" })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({ user: "" })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({}, { team_id: "" })))).toBe("missing_field");
  });

  it("treats a non-string id as missing rather than coercing it", () => {
    expect(ignoredOf(toMessage(envelope({ channel: 42 })))).toBe("missing_field");
    expect(ignoredOf(toMessage(envelope({ ts: 1717171717.0001 })))).toBe("missing_field");
  });

  it("treats an empty thread_ts as no thread rather than as a thread", () => {
    // `readString` rejects "", so this lands on the `?? null` — a message that
    // claims an empty parent is top-level, not a message in a thread named "".
    expect(messageOf(toMessage(envelope({ thread_ts: "" }))).threadTs).toBeNull();
  });
});
