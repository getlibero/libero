import { describe, expect, it } from "vitest";
import { toRevision } from "./revision.js";
import { revisionEnvelope } from "./stub-slack.js";
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

function revisionOf(result: ReturnType<typeof toRevision>) {
  if (!("revision" in result)) throw new Error(`expected a revision, got ${result.ignored}`);
  return result.revision;
}

function ignoredOf(result: ReturnType<typeof toRevision>) {
  if (!("ignored" in result)) throw new Error("expected the envelope to be ignored");
  return result.ignored;
}

describe("toRevision", () => {
  it("normalizes a deletion onto the deleted message's ts, not the event's own", () => {
    // The one field this whole path turns on. `deleted_ts` is the message being
    // retracted; `ts` is when the retraction happened, and mirroring that one
    // would delete nothing and leave the text standing.
    const revision = revisionOf(
      toRevision(
        envelope({
          subtype: "message_deleted",
          hidden: true,
          deleted_ts: "1717171717.000300",
          ts: "1717171718.000000"
        })
      )
    );

    expect(revision).toEqual({
      kind: "deleted",
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      ts: "1717171717.000300",
      eventId: "Ev0EVENT"
    });
  });

  it("normalizes an edit onto the nested message's ts and its new text", () => {
    const revision = revisionOf(
      toRevision(
        envelope({
          subtype: "message_changed",
          ts: "1717171718.000000",
          message: {
            type: "message",
            user: "U0ALICE",
            ts: "1717171717.000300",
            text: "the deploy went out at five",
            edited: { user: "U0ALICE", ts: "1717171718.000000" }
          },
          previous_message: {
            type: "message",
            user: "U0ALICE",
            ts: "1717171717.000300",
            text: "the deploy went out at four"
          }
        })
      )
    );

    expect(revision).toEqual({
      kind: "edited",
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      ts: "1717171717.000300",
      text: "the deploy went out at five",
      eventId: "Ev0EVENT"
    });
  });

  it("reads a tombstone as a deletion rather than as an edit to Slack's placeholder", () => {
    // A deleted thread parent with replies: Slack keeps something for the
    // replies to hang on and reports it as a `message_changed`. Read as an edit
    // it would leave the row standing with Slack's placeholder text in it, so a
    // retracted message would outlive its retraction — the case the whole path
    // exists for.
    const revision = revisionOf(
      toRevision(
        envelope({
          subtype: "message_changed",
          ts: "1717171718.000000",
          message: {
            type: "message",
            subtype: "tombstone",
            user: "USLACKBOT",
            ts: "1717171717.000300",
            text: "This message was deleted."
          }
        })
      )
    );

    expect(revision).toEqual({
      kind: "deleted",
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      ts: "1717171717.000300",
      eventId: "Ev0EVENT"
    });
  });

  it("keeps an edit that empties the text, rather than reading it as an absent field", () => {
    // `""` is what an edit sends when someone clears a `file_share`'s comment,
    // and it is precisely the retraction this path exists to mirror. The other
    // readers here treat an empty string as absent; this one must not.
    const revision = revisionOf(
      toRevision(
        envelope({
          subtype: "message_changed",
          message: { type: "message", user: "U0ALICE", ts: "1717171717.000300", text: "" }
        })
      )
    );

    expect(revision).toMatchObject({ kind: "edited", text: "" });
  });

  it("drops an app's edit of its own message", () => {
    // Volume rather than correctness: a bot's message is never stored, so its
    // ts matches no row. What this saves is a session opened and a statement run
    // for every edit the live checklist makes to its own card.
    const ignored = ignoredOf(
      toRevision(
        envelope({
          subtype: "message_changed",
          message: {
            type: "message",
            bot_id: "B0LIBERO",
            ts: "1717171717.000300",
            text: "checklist, step two"
          }
        })
      )
    );

    expect(ignored).toBe("bot_message");
  });

  it("does not restate which subtypes the store agreed to record", () => {
    // An edit to a stored `file_share` is a real edit. `ALLOWED_SUBTYPES` lives
    // in message.ts and is deliberately not copied here: the store holds exactly
    // the messages that passed it and both operations key on `ts`, so the store
    // is the filter. A second copy is one that goes out of step, and out of step
    // means this edit silently not mirrored.
    const revision = revisionOf(
      toRevision(
        envelope({
          subtype: "message_changed",
          message: {
            type: "message",
            subtype: "file_share",
            user: "U0ALICE",
            ts: "1717171717.000300",
            text: "the new numbers"
          }
        })
      )
    );

    expect(revision).toMatchObject({ kind: "edited", ts: "1717171717.000300" });
  });

  it("ignores an ordinary message, a non-message event, and an unrelated subtype", () => {
    expect(ignoredOf(toRevision(envelope({ ts: "1717171717.000300", text: "hi" })))).toBe(
      "not_a_revision"
    );
    expect(ignoredOf(toRevision(envelope({ type: "app_mention" })))).toBe("not_a_revision");
    expect(ignoredOf(toRevision(envelope({ subtype: "channel_join" })))).toBe("not_a_revision");
  });

  it("ignores an envelope whose halves are not objects", () => {
    expect(ignoredOf(toRevision({ ack: () => Promise.resolve(), event: null, body: {} }))).toBe(
      "not_a_revision"
    );
    expect(
      ignoredOf(toRevision({ ack: () => Promise.resolve(), event: {}, body: "not a body" }))
    ).toBe("not_a_revision");
  });

  it("fails closed on a revision missing the field it would act on", () => {
    // Each of these is a payload that names a revision without saying which
    // message. Guessing one would delete or rewrite a row nobody touched.
    expect(ignoredOf(toRevision(envelope({ subtype: "message_deleted" })))).toBe("missing_field");
    expect(ignoredOf(toRevision(envelope({ subtype: "message_changed" })))).toBe("missing_field");
    expect(
      ignoredOf(
        toRevision(envelope({ subtype: "message_changed", message: { type: "message", text: "x" } }))
      )
    ).toBe("missing_field");
    expect(
      ignoredOf(
        toRevision(
          envelope({ subtype: "message_changed", message: { type: "message", ts: "1717.0003" } })
        )
      )
    ).toBe("missing_field");
    expect(
      ignoredOf(
        toRevision(envelope({ subtype: "message_deleted", deleted_ts: "1717.0003" }, { team_id: "" }))
      )
    ).toBe("missing_field");
  });

  it("reads the shapes the stub builds, which is what the intake tests deliver", () => {
    // The stub is what every layered test above this one goes through, so a
    // builder that drifted from the wire would make those tests agree with each
    // other and with nothing else.
    expect(revisionOf(toRevision(revisionEnvelope({ kind: "deleted" })))).toMatchObject({
      kind: "deleted",
      ts: "1717171717.000300"
    });
    expect(
      revisionOf(toRevision(revisionEnvelope({ kind: "edited", text: "five" })))
    ).toMatchObject({ kind: "edited", ts: "1717171717.000300", text: "five" });
    expect(revisionOf(toRevision(revisionEnvelope({ kind: "tombstone" })))).toMatchObject({
      kind: "deleted",
      ts: "1717171717.000300"
    });
    expect(ignoredOf(toRevision(revisionEnvelope({ kind: "edited", botId: "B0LIBERO" })))).toBe(
      "bot_message"
    );
  });
});
