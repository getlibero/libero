import { describe, expect, it } from "vitest";
import { toMention } from "./mention.js";
import type { SlackEnvelope } from "./types.js";

/** Builds an envelope by overriding the two halves independently. */
function envelope(
  event: Record<string, unknown> = {},
  body: Record<string, unknown> = {}
): SlackEnvelope {
  return {
    ack: () => Promise.resolve(),
    event: {
      type: "app_mention",
      user: "U0ALICE",
      text: "<@U0BOT> what is the deploy status",
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

function mentionOf(result: ReturnType<typeof toMention>) {
  if (!("mention" in result)) throw new Error(`expected a mention, got ${result.ignored}`);
  return result.mention;
}

function ignoredOf(result: ReturnType<typeof toMention>) {
  if (!("ignored" in result)) throw new Error("expected the envelope to be ignored");
  return result.ignored;
}

describe("toMention", () => {
  it("normalizes a top-level mention and targets its own thread", () => {
    const mention = mentionOf(toMention(envelope()));

    expect(mention).toEqual({
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      userId: "U0ALICE",
      text: "<@U0BOT> what is the deploy status",
      ts: "1717171717.000100",
      threadTs: "1717171717.000100",
      eventId: "Ev0EVENT"
    });
  });

  it("targets the parent thread when the mention is inside one", () => {
    const mention = mentionOf(
      toMention(envelope({ ts: "1717171800.000200", thread_ts: "1717171717.000100" }))
    );

    expect(mention.ts).toBe("1717171800.000200");
    expect(mention.threadTs).toBe("1717171717.000100");
  });

  it("takes the team from the envelope body, not from the event", () => {
    // In a Slack Connect channel `event.team` is the author's workspace, not the
    // one the app is installed in. Sessions and, later, the client certificate
    // are keyed on the latter.
    const mention = mentionOf(toMention(envelope({ team: "T0GUEST" }, { team_id: "T0HOST" })));

    expect(mention.teamId).toBe("T0HOST");
  });

  it("keeps a timestamp as the exact string it arrived as", () => {
    const mention = mentionOf(toMention(envelope({ ts: "1717171717.000100" })));

    // Through Number() this loses its trailing digits, and those digits are the
    // message's identity.
    expect(mention.ts).toBe("1717171717.000100");
  });

  it("keeps the mention token in the text", () => {
    // Stripping it and rendering attribution is the context assembler's job.
    expect(mentionOf(toMention(envelope())).text).toContain("<@U0BOT>");
  });

  it("accepts an empty text", () => {
    // A blocks-only mention is a real thing; the handler can answer it with
    // silence. It is not a malformed event.
    expect(mentionOf(toMention(envelope({ text: "" }))).text).toBe("");
  });

  it("ignores unknown extra fields", () => {
    expect(mentionOf(toMention(envelope({ something_new: 1 }, { also_new: 2 }))).userId).toBe(
      "U0ALICE"
    );
  });

  it("ignores a message posted by a bot", () => {
    expect(ignoredOf(toMention(envelope({ bot_id: "B0BOT" })))).toBe("bot_message");
  });

  it("ignores any subtype", () => {
    for (const subtype of ["message_changed", "message_deleted", "thread_broadcast"]) {
      expect(ignoredOf(toMention(envelope({ subtype })))).toBe("message_subtype");
    }
  });

  it("ignores an event that is not an app_mention", () => {
    expect(ignoredOf(toMention(envelope({ type: "message" })))).toBe("not_a_mention");
  });

  it("ignores an envelope that is not shaped like an event at all", () => {
    expect(ignoredOf(toMention({ ack: () => Promise.resolve(), event: null, body: {} }))).toBe(
      "not_a_mention"
    );
    expect(ignoredOf(toMention({ ack: () => Promise.resolve(), event: {}, body: "nope" }))).toBe(
      "not_a_mention"
    );
  });

  it("ignores an event missing any field the reply depends on", () => {
    expect(ignoredOf(toMention(envelope({ channel: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({ user: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({ ts: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({ text: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({}, { team_id: undefined })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({}, { event_id: undefined })))).toBe("missing_field");
  });

  it("treats an empty-string id as missing rather than as an id", () => {
    // Failing closed matters most here: an empty channel id that survived
    // normalization is a post into nothing, or later a certificate for nothing.
    expect(ignoredOf(toMention(envelope({ channel: "" })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({}, { team_id: "" })))).toBe("missing_field");
  });

  it("treats a non-string id as missing rather than coercing it", () => {
    expect(ignoredOf(toMention(envelope({ channel: 42 })))).toBe("missing_field");
    expect(ignoredOf(toMention(envelope({ ts: 1717171717.0001 })))).toBe("missing_field");
  });
});
