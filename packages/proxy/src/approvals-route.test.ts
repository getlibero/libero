import { beforeEach, describe, expect, it } from "vitest";
import type { AuditRecord } from "@getlibero/schema";
import type { ApprovalDecider, ApprovalTicketRecord, DecideResult } from "./approvals.js";
import { createApprovalsRoute } from "./approvals-route.js";
import type { AuditWriter } from "./audit-log.js";
import { createSilentLogger } from "./log.js";
import type { RequestContext, RouteHandler } from "./server.js";

const CHANNEL = "C0ENGINEERING";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const TICKET = "tk-7f3a";
const APPROVER = "U0BOSS";

function ticketRecord(overrides: Partial<ApprovalTicketRecord> = {}): ApprovalTicketRecord {
  return {
    id: TICKET,
    channel: CHANNEL,
    server: "github",
    tool: "merge_pr",
    argumentsSha256: "a".repeat(64),
    requestingUser: "U0ASKER",
    task: "b9d5a2f0-0000-4000-8000-000000000001",
    callId: "toolu_01",
    createdAt: NOON,
    expiresAt: NOON + 900_000,
    verdict: null,
    approver: null,
    decidedAt: null,
    spentAt: null,
    expiryObserved: false,
    ...overrides
  };
}

/** Records what the route wrote, and can be made to fail on demand. */
function recordingWriter(): { writer: AuditWriter; rows: AuditRecord[]; fail: () => void } {
  const rows: AuditRecord[] = [];
  let failing = false;
  return {
    rows,
    fail: () => {
      failing = true;
    },
    writer: {
      append(record) {
        if (failing) throw new Error("disk full");
        rows.push(record);
      }
    }
  };
}

/** A decider that answers whatever the test says, and remembers what it was asked. */
function stubDecider(answer: DecideResult): {
  decider: ApprovalDecider;
  seen: { channel: string; id: string; verdict: string; approver: string }[];
} {
  const seen: { channel: string; id: string; verdict: string; approver: string }[] = [];
  return {
    seen,
    decider: {
      decide(channel, id, verdict, approver) {
        seen.push({ channel, id, verdict, approver });
        return answer;
      }
    }
  };
}

let audit: ReturnType<typeof recordingWriter>;

beforeEach(() => {
  audit = recordingWriter();
});

function routeFor(answer: DecideResult): { handler: RouteHandler; decider: ReturnType<typeof stubDecider> } {
  const decider = stubDecider(answer);
  return {
    decider,
    handler: createApprovalsRoute({
      approvals: decider.decider,
      audit: audit.writer,
      logger: createSilentLogger(),
      now: () => NOON
    })
  };
}

function ctx(body: unknown): RequestContext {
  return { channel: CHANNEL, requestId: "r-1", body };
}

const APPROVE = { ticket: TICKET, decision: "approve", approver: APPROVER };
const DENY = { ticket: TICKET, decision: "deny", approver: APPROVER };

describe("the body", () => {
  it("refuses one that is not a decision, and writes no row", async () => {
    const { handler } = routeFor({ outcome: "unknown" });

    for (const body of [{}, { ticket: TICKET }, { ticket: TICKET, decision: "maybe", approver: APPROVER }]) {
      const response = await handler(ctx(body));
      expect(response.status).toBe(400);
    }
    expect(audit.rows).toHaveLength(0);
  });

  // The channel comes from the certificate. A body naming one must fail rather
  // than have the field dropped and the request served against the real channel.
  it("refuses one that names a channel", async () => {
    const { handler } = routeFor({ outcome: "unknown" });

    const response = await handler(ctx({ ...APPROVE, channel: "C0OTHER" }));

    expect(response.status).toBe(400);
    expect(audit.rows).toHaveLength(0);
  });

  it("does not relay the parse errors, which quote what the agent sent", async () => {
    const { handler } = routeFor({ outcome: "unknown" });

    const response = await handler(ctx({ ticket: "'; DROP TABLE tool_call_audit --", decision: "approve" }));

    expect(JSON.stringify(response.body)).not.toContain("DROP TABLE");
  });
});

describe("the channel", () => {
  // The one argument that is the whole "channel A cannot decide channel B's
  // ticket" property. Everything else about it is the store's.
  it("is taken from the certificate and handed to the store", async () => {
    const { handler, decider } = routeFor({ outcome: "recorded", ticket: ticketRecord() });

    await handler(ctx(APPROVE));

    expect(decider.seen).toEqual([
      { channel: CHANNEL, id: TICKET, verdict: "approve", approver: APPROVER }
    ]);
  });
});

describe("recording a decision", () => {
  it("writes one approved row, with the approver and the ticket", async () => {
    const { handler } = routeFor({ outcome: "recorded", ticket: ticketRecord() });

    const response = await handler(ctx(APPROVE));

    expect(response).toEqual({
      status: 200,
      body: { outcome: "recorded", ticket: TICKET, decision: "approve" }
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      at: NOON,
      channel: CHANNEL,
      outcome: "approved",
      approver: APPROVER,
      ticket: TICKET,
      // Off the ticket, because this request is not the call it describes.
      server: "github",
      tool: "merge_pr",
      callId: "toolu_01",
      requestingUser: "U0ASKER",
      argumentsSha256: "a".repeat(64)
    });
    expect(audit.rows[0]?.refusalReason).toBeUndefined();
  });

  it("writes one denied row, with its reason", async () => {
    const { handler } = routeFor({ outcome: "recorded", ticket: ticketRecord() });

    const response = await handler(ctx(DENY));

    expect(response.body).toEqual({ outcome: "recorded", ticket: TICKET, decision: "deny" });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      outcome: "denied",
      refusalReason: "approval_denied",
      approver: APPROVER,
      ticket: TICKET
    });
  });

  // A decision is a fact about a call, and the request that reports it is not
  // one. The row carries this request's id; the held row carries another. They
  // join on the ticket, which is the reason that column exists.
  it("carries this request's id and the ticketed call's attribution", async () => {
    const { handler } = routeFor({ outcome: "recorded", ticket: ticketRecord() });

    await handler(ctx(APPROVE));

    expect(audit.rows[0]).toMatchObject({ requestId: "r-1", task: "b9d5a2f0-0000-4000-8000-000000000001" });
  });
});

describe("an expired ticket", () => {
  it("writes one expired row with no approver on it", async () => {
    const { handler } = routeFor({ outcome: "expired", ticket: ticketRecord(), firstObserved: true });

    const response = await handler(ctx(APPROVE));

    expect(response.body).toEqual({ outcome: "expired", ticket: TICKET });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ outcome: "expired", ticket: TICKET });
    // An absence rather than a name nobody gave: the click was too late, so
    // nobody approved this call.
    expect(audit.rows[0]?.approver).toBeUndefined();
  });

  // Without this, N late clicks on a stale card write N rows and every count of
  // expiries is wrong by however many times somebody clicked.
  it("writes no row when something already observed the expiry", async () => {
    const { handler } = routeFor({ outcome: "expired", ticket: ticketRecord(), firstObserved: false });

    const response = await handler(ctx(APPROVE));

    expect(response.body).toEqual({ outcome: "expired", ticket: TICKET });
    expect(audit.rows).toHaveLength(0);
  });
});

describe("a decision that changes nothing", () => {
  // The decision that counts already has a row. A second would say a human
  // decided this twice, which is true of the clicks and false of the decision.
  it("writes no row for a second click, and reports the verdict that stands", async () => {
    const { handler } = routeFor({
      outcome: "already_decided",
      ticket: ticketRecord({ verdict: "approve", approver: "U0FIRST" })
    });

    const response = await handler(ctx(DENY));

    expect(response.body).toEqual({ outcome: "already_decided", ticket: TICKET, decision: "approve" });
    expect(audit.rows).toHaveLength(0);
  });

  // No call to describe, so nothing to put in a row. A ticket another channel
  // holds lands here too, indistinguishable from one that never existed.
  it("writes no row for a ticket this channel does not have", async () => {
    const { handler } = routeFor({ outcome: "unknown" });

    const response = await handler(ctx(APPROVE));

    expect(response.body).toEqual({ outcome: "unknown", ticket: TICKET });
    expect(audit.rows).toHaveLength(0);
  });
});

describe("the audit write", () => {
  // Row first, then the line, and a failure fails the request — the discipline
  // the tool-call route documents. A human's decision that no durable write
  // recorded is a decision the log can lie about.
  it("fails the request when the row cannot be written", async () => {
    const { handler } = routeFor({ outcome: "recorded", ticket: ticketRecord() });
    audit.fail();

    await expect(handler(ctx(APPROVE))).rejects.toThrow();
  });
});

describe("the status", () => {
  // None of these is a request that failed: "there is no such ticket" is the
  // system working, on the argument ToolCallResponse makes.
  it("is 200 for every outcome the broker can reach", async () => {
    const answers: DecideResult[] = [
      { outcome: "recorded", ticket: ticketRecord() },
      { outcome: "already_decided", ticket: ticketRecord({ verdict: "deny", approver: APPROVER }) },
      { outcome: "expired", ticket: ticketRecord(), firstObserved: true },
      { outcome: "unknown" }
    ];

    for (const answer of answers) {
      const { handler } = routeFor(answer);
      expect((await handler(ctx(APPROVE))).status, answer.outcome).toBe(200);
    }
  });
});
