// The click → proxy → settle ordering, with both neighbours faked: a recorded
// approvals client on one side, a recording settle on the other. The proxy's
// own behaviour — first verdict stands, per-channel lookup — is tested in the
// proxy package; this file is about what this process does with each of the
// four answers, and about the two drops that never reach the proxy.

import type { ProxyApprovalsClient } from "@getlibero/agent";
import type { ApprovalDecisionResponse } from "@getlibero/schema";
import type { LogFields, LogLevel, Logger, SlackDecision } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { createDecisionHandler } from "./decisions.js";
import { createApprovalRegistry, type ApprovalSettlement } from "./registry.js";

const CHANNEL = "C024BE91L";
const TICKET = "tk-7f3a";

const decision = (partial: Partial<SlackDecision> = {}): SlackDecision => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  approverId: "U0G9QF9C6",
  ticketId: TICKET,
  verdict: "approve",
  messageTs: "1717171717.000100",
  threadTs: "1717171717.000001",
  ...partial
});

function fakeApprovals(
  answer: (channel: string) => ApprovalDecisionResponse | Promise<ApprovalDecisionResponse>
): { approvals: ProxyApprovalsClient; asked: Array<{ channel: string; body: unknown }> } {
  const asked: Array<{ channel: string; body: unknown }> = [];
  return {
    asked,
    approvals: {
      async decide(channel, body) {
        asked.push({ channel, body });
        return answer(channel);
      }
    }
  };
}

function capturingLogger(): { logger: Logger; lines: Array<{ level: LogLevel } & LogFields> } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { logger: { log: (level, fields) => lines.push({ level, ...fields }) }, lines };
}

function waiting(channel = CHANNEL): {
  registry: ReturnType<typeof createApprovalRegistry>;
  settled: ApprovalSettlement[];
} {
  const registry = createApprovalRegistry();
  const settled: ApprovalSettlement[] = [];
  registry.register(channel, TICKET, { settle: outcome => settled.push(outcome) });
  return { registry, settled };
}

describe("a click that reaches the proxy", () => {
  it("relays it on the waiting entry's channel, then settles with what was recorded", async () => {
    const { registry, settled } = waiting();
    const { approvals, asked } = fakeApprovals(() => ({
      outcome: "recorded",
      ticket: TICKET,
      decision: "approve"
    }));
    const handle = createDecisionHandler({ registry, approvals });

    await handle(decision());

    expect(asked).toEqual([
      { channel: CHANNEL, body: { ticket: TICKET, decision: "approve", approver: "U0G9QF9C6" } }
    ]);
    expect(settled).toEqual([{ state: "approved", approver: "U0G9QF9C6" }]);
  });

  it("settles a recorded deny as denied", async () => {
    const { registry, settled } = waiting();
    const { approvals } = fakeApprovals(() => ({
      outcome: "recorded",
      ticket: TICKET,
      decision: "deny"
    }));

    await createDecisionHandler({ registry, approvals })(decision({ verdict: "deny" }));

    expect(settled).toEqual([{ state: "denied", approver: "U0G9QF9C6" }]);
  });

  // The first verdict stands: an approve clicked after a deny settles the wait
  // as denied, because that is what the broker holds and what the
  // re-submission will be judged against.
  it("settles with the standing verdict when the click came second", async () => {
    const { registry, settled } = waiting();
    const { approvals } = fakeApprovals(() => ({
      outcome: "already_decided",
      ticket: TICKET,
      decision: "deny"
    }));

    await createDecisionHandler({ registry, approvals })(decision({ verdict: "approve" }));

    expect(settled).toEqual([{ state: "denied", approver: "U0G9QF9C6" }]);
  });

  it("settles an expired ticket as expired", async () => {
    const { registry, settled } = waiting();
    const { approvals } = fakeApprovals(() => ({ outcome: "expired", ticket: TICKET }));

    await createDecisionHandler({ registry, approvals })(decision());

    expect(settled).toEqual([{ state: "expired" }]);
  });

  // `unknown` with someone waiting means the proxy lost the ticket to a
  // restart. Waiting out the local deadline buys nothing the re-submission
  // will not learn faster.
  it("settles a ticket the proxy lost as expired, and says so", async () => {
    const { registry, settled } = waiting();
    const { approvals } = fakeApprovals(() => ({ outcome: "unknown", ticket: TICKET }));
    const { logger, lines } = capturingLogger();

    await createDecisionHandler({ registry, approvals, logger })(decision());

    expect(settled).toEqual([{ state: "expired" }]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "approval_unknown", ticket: TICKET })
    );
  });
});

describe("a click that never reaches the proxy", () => {
  it("drops a ticket nobody is waiting on, without asking the proxy", async () => {
    const registry = createApprovalRegistry();
    const { approvals, asked } = fakeApprovals(() => ({ outcome: "unknown", ticket: TICKET }));
    const { logger, lines } = capturingLogger();

    await createDecisionHandler({ registry, approvals, logger })(decision());

    expect(asked).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "approval_ignored", reason: "unknown_ticket" })
    );
  });

  // The card sits in the channel whose certificate minted the ticket; a click
  // observed anywhere else did not come from that card. The registry's lookup
  // is scoped by the click's channel, so a foreign click and a ticket that
  // never existed are one answer — the proxy's shape, for the proxy's reason.
  it("drops a click from another channel, without asking the proxy", async () => {
    const { registry, settled } = waiting();
    const { approvals, asked } = fakeApprovals(() => ({ outcome: "unknown", ticket: TICKET }));
    const { logger, lines } = capturingLogger();

    await createDecisionHandler({ registry, approvals, logger })(
      decision({ channelId: "C99OTHER1" })
    );

    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "approval_ignored", reason: "unknown_ticket" })
    );
  });

  it("drops a click that lost the race with settlement, as an unknown ticket", async () => {
    const { registry, settled } = waiting();
    registry.remove(CHANNEL, TICKET);
    const { approvals, asked } = fakeApprovals(() => ({ outcome: "unknown", ticket: TICKET }));

    await createDecisionHandler({ registry, approvals })(decision());

    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
  });
});

// The gateway logs the rejection as decision_failed and drops the click; the
// entry staying registered is what keeps the amber card's buttons meaningful —
// the human retries by clicking, not by waiting.
describe("a relay the proxy did not take", () => {
  it("propagates the rejection and leaves the wait pending", async () => {
    const { registry, settled } = waiting();
    const { approvals } = fakeApprovals(() => {
      throw new Error("proxy client: the decision relay timed out");
    });

    await expect(createDecisionHandler({ registry, approvals })(decision())).rejects.toThrow(
      /timed out/
    );

    expect(settled).toEqual([]);
    expect(registry.get(CHANNEL, TICKET)).toBeDefined();
  });
});
