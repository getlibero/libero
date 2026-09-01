import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { mentionsApp, toMessage } from "./message.js";
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
      eventId: "Ev0EVENT",
      mentionsApp: false,
      fromApp: false
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

  each([["thread_broadcast"], ["file_share"]])(
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

  it("ignores a message posted by another app", () => {
    // Its own reply is the exception and the four cases below are that; every
    // other bot is dropped exactly as it always was. What a third party's bot
    // message is worth stays an unanswered question rather than one #523
    // answered on the way past.
    expect(ignoredOf(toMessage(envelope({ bot_id: "B0BOT", user: "U0OTHERBOT" }), "U0BOT"))).toBe(
      "bot_message"
    );
  });

  it("ignores a bot message when the app's own id is not known yet", () => {
    // Fails closed, as `mentionsApp` does and for the cheaper side of the same
    // trade: a reply lost during startup is one line missing from a thread,
    // where the other mistake would be filing another app's text under this
    // app's byline.
    expect(ignoredOf(toMessage(envelope({ bot_id: "B0BOT", user: "U0BOT" })))).toBe("bot_message");
  });

  it("records this app's own text reply, marked as its own", () => {
    // #523: the store held only what people said, and inside a thread that left
    // the model reasoning from questions with the answers cut out.
    const message = messageOf(
      toMessage(
        envelope({ bot_id: "B0BOT", user: "U0BOT", thread_ts: "1717171717.000100" }),
        "U0BOT"
      )
    );

    expect(message.fromApp).toBe(true);
    expect(message.userId).toBe("U0BOT");
    expect(message.threadTs).toBe("1717171717.000100");
  });

  it("records this app's own reply when Slack attaches the bot_message subtype", () => {
    // An app with a bot user normally posts with no subtype at all, so this is
    // the shape that is not guaranteed. Both are the same message.
    const message = messageOf(
      toMessage(envelope({ bot_id: "B0BOT", user: "U0BOT", subtype: "bot_message" }), "U0BOT")
    );

    expect(message.fromApp).toBe(true);
  });

  it("ignores this app's own cards, which carry attachments", () => {
    // Approval cards and the live checklist are `chat.update`d as their state
    // moves, so through this door they would arrive as a stream of edits to
    // interactive messages. Nothing a person said and nothing the agent
    // answered.
    expect(
      ignoredOf(
        toMessage(
          envelope({ bot_id: "B0BOT", user: "U0BOT", attachments: [{ fallback: "held" }] }),
          "U0BOT"
        )
      )
    ).toBe("bot_message");
  });

  it("records a reply whose attachments field is present and empty", () => {
    // The test is for a card, and an empty array is not one. Getting this wrong
    // the other way would drop replies for a shape Slack is entitled to send.
    expect(
      messageOf(toMessage(envelope({ bot_id: "B0BOT", user: "U0BOT", attachments: [] }), "U0BOT"))
        .fromApp
    ).toBe(true);
  });

  it("reports another app's message as a bot message even when it also carries a subtype", () => {
    // `bot_message` is itself a subtype, so the order of the two checks decides
    // which reason an operator greps for.
    expect(
      ignoredOf(
        toMessage(envelope({ bot_id: "B0BOT", user: "U0OTHER", subtype: "bot_message" }), "U0BOT")
      )
    ).toBe("bot_message");
  });

  each([["message_changed"], ["message_deleted"]])(
    "reports %s as an edit rather than as an unwanted subtype",
    subtype => {
      // Its own code because it is a handoff rather than a drop: since #177
      // `dispatchMessage` reads exactly this answer and passes the envelope to
      // `toRevision`, which mirrors it onto the store's `remove` and
      // `replaceText`. Folding it into `message_subtype` would silently stop
      // deletions being mirrored, so this assertion is load-bearing rather than
      // descriptive.
      expect(ignoredOf(toMessage(envelope({ subtype })))).toBe("message_edit");
    }
  );

  each([["channel_join"], ["channel_topic"], ["pinned_item"], ["channel_archive"]])(
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

  it("marks a message that mentions the app", () => {
    const text = "<@U0BOT> what broke";
    expect(messageOf(toMessage(envelope({ text }), "U0BOT")).mentionsApp).toBe(true);
    expect(messageOf(toMessage(envelope({ text }), "U0ALICE")).mentionsApp).toBe(false);
  });
});

describe("mentionsApp", () => {
  it("matches both spellings of a mention token", () => {
    // Older clients append the display name Slack had at the time. The id
    // beside it is what identifies the app, and the label is not read.
    expect(mentionsApp("<@U0BOT> hello", "U0BOT")).toBe(true);
    expect(mentionsApp("<@U0BOT|libero> hello", "U0BOT")).toBe(true);
  });

  it("does not match a different user, or an id this one is a prefix of", () => {
    expect(mentionsApp("<@U0ALICE> hello", "U0BOT")).toBe(false);
    // The closing bracket is part of the test, so `U0BOT` does not match
    // `<@U0BOTTLE>`. A `includes("<@U0BOT")` would.
    expect(mentionsApp("<@U0BOTTLE> hello", "U0BOT")).toBe(false);
  });

  it("does not match a bare id outside a token", () => {
    // Ids get quoted in ordinary conversation — "U0BOT is the app" — and that
    // is not addressing it.
    expect(mentionsApp("U0BOT is the app", "U0BOT")).toBe(false);
  });

  it("treats any mention token as the app when the id is unknown", () => {
    // Fails closed: a message that might address the app is treated as though
    // it does, because the copy that arrives on `app_mention` is already being
    // answered and running it twice is the expensive mistake.
    expect(mentionsApp("<@U0ALICE> does that look right", undefined)).toBe(true);
    expect(mentionsApp("<@W0ALICE> on Enterprise Grid", undefined)).toBe(true);
    expect(mentionsApp("no, the other cluster", undefined)).toBe(false);
  });

  it("answers the same way twice for the same text", () => {
    // A global regexp carries `lastIndex` between calls, so a shared one used
    // with `.test` alternates. That would be an intermittent duplicate answer,
    // which is the worst shape this bug could take.
    expect(mentionsApp("<@U0ALICE> hi", undefined)).toBe(true);
    expect(mentionsApp("<@U0ALICE> hi", undefined)).toBe(true);
  });

  it("does not match a channel or group token", () => {
    expect(mentionsApp("<!here> deploy is out", undefined)).toBe(false);
    expect(mentionsApp("<#C0OPS|ops> has the details", undefined)).toBe(false);
  });
});
