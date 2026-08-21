import { describe, it } from "node:test";
import { expect } from "expect";
import {
  ApprovalDecision,
  ApprovalDecisionResponse,
  ApprovalTicket,
  ApprovalVerdict
} from "./approval.js";

const TICKET = "b7a1c2d3-4e5f-6789-abcd-ef0123456789";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);

describe("ApprovalTicket", () => {
  it("carries an id and an absolute deadline", () => {
    expect(ApprovalTicket.parse({ id: TICKET, expiresAt: NOON })).toEqual({
      id: TICKET,
      expiresAt: NOON
    });
  });

  // A duration would leave the client and the proxy disagreeing about when the
  // same ticket dies, which shows up as a card offering a button for a call
  // that can no longer run.
  it("rejects a duration where the deadline goes", () => {
    expect(ApprovalTicket.safeParse({ id: TICKET, expiresAt: -1 }).success).toBe(false);
    expect(ApprovalTicket.safeParse({ id: TICKET, expiresAt: 0 }).success).toBe(false);
    expect(ApprovalTicket.safeParse({ id: TICKET, expiresAt: NOON + 0.5 }).success).toBe(false);
  });

  it("refuses a field nobody designed", () => {
    expect(ApprovalTicket.safeParse({ id: TICKET, expiresAt: NOON, channel: "C0X" }).success).toBe(false);
  });
});

describe("ApprovalDecision", () => {
  it("accepts an approve and a deny, each with its approver", () => {
    for (const decision of ApprovalVerdict.options) {
      expect(ApprovalDecision.parse({ ticket: TICKET, decision, approver: "U0BOSS" })).toEqual({
        ticket: TICKET,
        decision,
        approver: "U0BOSS"
      });
    }
  });

  // The property that binds a ticket to its channel. The channel comes from the
  // client certificate, so a body naming one must fail the parse rather than
  // have the field dropped and the request served against the real channel.
  it("refuses a body that names a channel", () => {
    expect(
      ApprovalDecision.safeParse({
        ticket: TICKET,
        decision: "approve",
        approver: "U0BOSS",
        channel: "C0OTHER"
      }).success
    ).toBe(false);
  });

  it("refuses a third verdict", () => {
    for (const decision of ["maybe", "approved", "APPROVE", ""]) {
      expect(ApprovalDecision.safeParse({ ticket: TICKET, decision, approver: "U0BOSS" }).success).toBe(false);
    }
  });

  // Required on a deny as much as on an approve: a log that records who says
  // yes and not who says no answers half of "who decided this".
  it("requires an approver on both verdicts", () => {
    for (const decision of ApprovalVerdict.options) {
      expect(ApprovalDecision.safeParse({ ticket: TICKET, decision }).success).toBe(false);
    }
  });

  it("bounds the ticket and the approver rather than taking any string", () => {
    for (const bad of ["", "a".repeat(65), "../../etc", "has space", "-leading"]) {
      expect(ApprovalDecision.safeParse({ ticket: bad, decision: "approve", approver: "U0BOSS" }).success).toBe(
        false
      );
      expect(ApprovalDecision.safeParse({ ticket: TICKET, decision: "approve", approver: bad }).success).toBe(
        false
      );
    }
  });
});

describe("ApprovalDecisionResponse", () => {
  const samples = [
    { outcome: "recorded" as const, ticket: TICKET, decision: "approve" as const },
    { outcome: "already_decided" as const, ticket: TICKET, decision: "deny" as const },
    { outcome: "expired" as const, ticket: TICKET },
    { outcome: "unknown" as const, ticket: TICKET }
  ];

  it("covers every outcome the broker can reach", () => {
    expect(ApprovalDecisionResponse.options.map(option => option.shape.outcome.value)).toEqual([
      "recorded",
      "already_decided",
      "expired",
      "unknown"
    ]);
    for (const sample of samples) {
      expect(ApprovalDecisionResponse.parse(sample)).toEqual(sample);
    }
  });

  // Built in the proxy, serialized, parsed by the agent. The discriminator has
  // to survive that or the response is just an object.
  it("survives JSON without losing its outcome", () => {
    for (const sample of samples) {
      const overWire: unknown = JSON.parse(JSON.stringify(sample));
      expect(ApprovalDecisionResponse.parse(overWire).outcome).toBe(sample.outcome);
    }
  });

  // The two that report no decision report no verdict either. A `decision` on
  // an `unknown` would be the broker inventing one for a ticket it never had.
  it("carries a verdict only where one exists", () => {
    expect(
      ApprovalDecisionResponse.safeParse({ outcome: "unknown", ticket: TICKET, decision: "approve" }).success
    ).toBe(false);
    expect(ApprovalDecisionResponse.safeParse({ outcome: "recorded", ticket: TICKET }).success).toBe(false);
  });
});
