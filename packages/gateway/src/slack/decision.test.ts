import { describe, expect, it } from "vitest";
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from "./approval-ids.js";
import { toDecision } from "./decision.js";
import { blockActionsEnvelope } from "./stub-slack.js";
import type { SlackInteractionEnvelope } from "./types.js";

/**
 * Builds a raw payload from parts, so a test can break exactly one field.
 *
 * `blockActionsEnvelope` is the well-formed article and is used where the point
 * is a real click; this is for the malformed cases, which need to reach past it.
 */
function envelope(body: unknown): SlackInteractionEnvelope {
  return { ack: () => Promise.resolve(), body };
}

function wellFormed(overrides: Record<string, unknown> = {}): SlackInteractionEnvelope {
  return envelope({
    type: "block_actions",
    team: { id: "T0TEAM" },
    user: { id: "U0HUMAN" },
    channel: { id: "C0CHAN" },
    message: { ts: "1717171717.000200" },
    container: { type: "message", thread_ts: "1717171717.000100" },
    actions: [{ type: "button", action_id: APPROVE_ACTION_ID, value: "ticket-1" }],
    ...overrides
  });
}

function decisionOf(result: ReturnType<typeof toDecision>) {
  if (!("decision" in result)) throw new Error(`expected a decision, got ${result.ignored}`);
  return result.decision;
}

function ignoredOf(result: ReturnType<typeof toDecision>) {
  if (!("ignored" in result)) throw new Error("expected the envelope to be ignored");
  return result.ignored;
}

describe("toDecision", () => {
  it("normalizes an approve click", () => {
    expect(decisionOf(toDecision(wellFormed()))).toEqual({
      teamId: "T0TEAM",
      channelId: "C0CHAN",
      approverId: "U0HUMAN",
      ticketId: "ticket-1",
      verdict: "approve",
      messageTs: "1717171717.000200",
      threadTs: "1717171717.000100"
    });
  });

  it("normalizes a deny click", () => {
    const result = toDecision(
      wellFormed({ actions: [{ action_id: DENY_ACTION_ID, value: "ticket-2" }] })
    );

    expect(decisionOf(result)).toMatchObject({ verdict: "deny", ticketId: "ticket-2" });
  });

  it("finds the thread on the container, the message, or falls back to the card itself", () => {
    expect(decisionOf(toDecision(wellFormed())).threadTs).toBe("1717171717.000100");

    // No container thread: the message's own is the same answer.
    expect(
      decisionOf(
        toDecision(
          wellFormed({
            container: { type: "message" },
            message: { ts: "1717171717.000200", thread_ts: "1717171717.000111" }
          })
        )
      ).threadTs
    ).toBe("1717171717.000111");

    // Neither: a card that is somehow top-level is its own thread root, the
    // same fallback `toMention` makes.
    expect(
      decisionOf(toDecision(wellFormed({ container: { type: "message" } }))).threadTs
    ).toBe("1717171717.000200");
  });

  it("ignores anything that is not a block_actions payload", () => {
    const notInteractions: unknown[] = [
      undefined,
      null,
      "block_actions",
      42,
      [],
      {},
      { type: "view_submission" },
      { type: "shortcut" },
      { type: "block_actions" },
      { type: "block_actions", actions: "nope" },
      { type: "block_actions", actions: [] },
      { type: "block_actions", actions: [42] },
      { type: "block_actions", actions: [{ value: "ticket-1" }] },
      { type: "block_actions", actions: [{ action_id: "" }] }
    ];

    for (const body of notInteractions) {
      expect(ignoredOf(toDecision(envelope(body)))).toBe("not_an_interaction");
    }
  });

  it("leaves another surface's button alone", () => {
    // Not an error and not ours to have an opinion about — a different reason
    // from an id in our own namespace, so an operator can tell them apart.
    const result = toDecision(
      wellFormed({ actions: [{ action_id: "some_other_feature_go", value: "x" }] })
    );

    expect(ignoredOf(result)).toBe("not_an_approval");
  });

  it("drops one of our own ids that this build does not publish", () => {
    // A card from an older build, still on screen.
    const result = toDecision(
      wellFormed({ actions: [{ action_id: "libero_approval_maybe", value: "ticket-1" }] })
    );

    expect(ignoredOf(result)).toBe("unknown_verdict");
  });

  it("refuses a click missing any field the decision depends on", () => {
    const broken: Array<[string, Record<string, unknown>]> = [
      ["no team", { team: {} }],
      ["no channel", { channel: {} }],
      ["no user", { user: {} }],
      ["no message ts", { message: {} }],
      ["team not a record", { team: "T0TEAM" }],
      ["user not a record", { user: null }],
      ["no ticket", { actions: [{ action_id: APPROVE_ACTION_ID }] }],
      ["empty ticket", { actions: [{ action_id: APPROVE_ACTION_ID, value: "" }] }],
      // `value` holds 2000 characters and a ticket id is at most 64, so
      // anything longer did not come from a card this package drew.
      [
        "oversized ticket",
        { actions: [{ action_id: APPROVE_ACTION_ID, value: "t".repeat(2000) }] }
      ]
    ];

    for (const [name, overrides] of broken) {
      expect(ignoredOf(toDecision(wellFormed(overrides))), name).toBe("missing_field");
    }
  });

  it("never throws, whatever arrives", () => {
    // The issue's first acceptance bullet: a malformed envelope is dropped and
    // logged, not thrown. The dispatcher logs; this returns.
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      "",
      [],
      { type: "block_actions", actions: [{ action_id: APPROVE_ACTION_ID, value: {} }] },
      { type: "block_actions", actions: [null] },
      { type: "block_actions", actions: [{ action_id: 42 }] },
      { type: "block_actions", team: [], user: [], channel: [], message: [], actions: [{}] },
      Object.create(null) as unknown
    ];

    for (const body of hostile) {
      expect(() => toDecision(envelope(body))).not.toThrow();
    }
  });

  it("reads no secret off the payload", () => {
    // `response_url` is a URL with a secret in it and `token` is Slack's legacy
    // verification token. Socket Mode authenticates the connection, so neither
    // is needed, and this package's rule is that no field of any type holds a
    // token. `blockActionsEnvelope` carries both so there is something to catch.
    const result = toDecision(blockActionsEnvelope());

    expect(JSON.stringify(result)).not.toContain("RESPONSEURLSECRET");
    expect(JSON.stringify(result)).not.toContain("legacy-verification-token");
    expect(JSON.stringify(result)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(result)).not.toContain("trigger_id");
  });
});
