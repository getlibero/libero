// The approvals client, faked at the transport seam.
//
// TLS is not here — a real handshake and a real certificate are
// ./transport.test.ts. This file is about what the client does with an answer,
// what bytes it puts on the wire, and the deadline it carries on its own
// behalf.

import { ApprovalDecision } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import { createProxyApprovalsClient } from "./approvals.js";
import { ProxyClientError, type ProxyRequest, type ProxyResponse, type ProxyTransport } from "./transport.js";

const CHANNEL = "C024BE91L";
const TICKET = "9b2f1c4e-5a7d-4f3b-8e6c-0d55a2f01c4e";

const DECISION: ApprovalDecision = {
  ticket: TICKET,
  decision: "approve",
  approver: "U0G9QF9C6"
};

function fakeTransport(
  answer?: (options: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>
): { transport: ProxyTransport; sent: ProxyRequest[] } {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        return (
          (await answer?.(options)) ?? {
            status: 200,
            body: { outcome: "recorded", ticket: TICKET, decision: "approve" }
          }
        );
      }
    }
  };
}

function clientWith(
  answer?: (options: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>,
  timeoutMs?: number
): { client: ReturnType<typeof createProxyApprovalsClient>; sent: ProxyRequest[] } {
  const fake = fakeTransport(answer);
  const client = createProxyApprovalsClient({
    transport: fake.transport,
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  });
  return { client, sent: fake.sent };
}

describe("relaying a decision", () => {
  it("posts the decision on the certificate of the channel it was given", async () => {
    const { client, sent } = clientWith();

    await client.decide(CHANNEL, DECISION);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(CHANNEL);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.path).toBe("/v1/approvals");
  });

  // The channel is an identity, not a field: it chose the certificate, and the
  // proxy reads it off that. `ApprovalDecision` is strict on the other side, so
  // this is the test that fails if someone adds it.
  it("puts no channel in the body, in any form", async () => {
    const { client, sent } = clientWith();

    await client.decide(CHANNEL, DECISION);

    expect(JSON.stringify(sent[0]?.body)).not.toContain(CHANNEL);
  });
});

describe("the broker's answer", () => {
  it("returns each served outcome as the broker gave it", async () => {
    for (const body of [
      { outcome: "recorded", ticket: TICKET, decision: "deny" },
      { outcome: "already_decided", ticket: TICKET, decision: "approve" },
      { outcome: "expired", ticket: TICKET },
      { outcome: "unknown", ticket: TICKET }
    ]) {
      const { client } = clientWith(() => ({ status: 200, body }));
      await expect(client.decide(CHANNEL, DECISION)).resolves.toEqual(body);
    }
  });

  // `already_decided` carries the verdict that stands — the first one. The
  // client hands it back untouched, because the caller must act on what stood,
  // not on the click it just relayed.
  it("hands back the standing verdict on a decision that came second", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: { outcome: "already_decided", ticket: TICKET, decision: "deny" }
    }));

    const answer = await client.decide(CHANNEL, { ...DECISION, decision: "approve" });

    expect(answer).toEqual({ outcome: "already_decided", ticket: TICKET, decision: "deny" });
  });
});

describe("a decision the proxy could not take", () => {
  it("throws for a non-200 and for an answer that does not parse", async () => {
    for (const answer of [
      { status: 500, body: undefined },
      { status: 400, body: { error: { code: "bad_request", message: "no", requestId: "r1" } } },
      { status: 200, body: { outcome: "decided" } },
      { status: 200, body: undefined }
    ]) {
      const { client } = clientWith(() => answer);
      await expect(client.decide(CHANNEL, DECISION)).rejects.toBeInstanceOf(ProxyClientError);
    }
  });

  it("relays the proxy's own message when it sent one", async () => {
    const { client } = clientWith(() => ({
      status: 400,
      body: {
        error: {
          code: "bad_request",
          message: "the request body is not a valid approval decision",
          requestId: "req-1"
        }
      }
    }));

    await expect(client.decide(CHANNEL, DECISION)).rejects.toThrow(
      /^proxy client: the request body is not a valid approval decision$/
    );
  });

  it("carries no response body into the error it raises", async () => {
    const { client } = clientWith(() => ({
      status: 500,
      body: { secret: "ghp_should_not_appear" }
    }));

    await expect(client.decide(CHANNEL, DECISION)).rejects.toThrow(
      /^proxy client: the decision relay failed$/
    );
  });
});

describe("the deadline this client carries", () => {
  it("abandons a relay the proxy never answers, and calls it a timeout", async () => {
    const { client } = clientWith(
      options =>
        new Promise<ProxyResponse>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new ProxyClientError("proxy client: cancelled", "cancelled"));
          });
        }),
      10
    );

    await expect(client.decide(CHANNEL, DECISION)).rejects.toMatchObject({ reason: "timed_out" });
  });

  // A cancelled task did not cancel the human's click: the decision outlives
  // any task, so there is no caller signal that would be right to honour.
  it("takes no signal from its caller", () => {
    const { client } = clientWith();

    expect(client.decide.length).toBe(2);
  });
});

// The two ends never meet in this file — the proxy is a package this one may
// not import. What they share is @getlibero/schema, the proxy's edge parse, so
// the substitute for the real server is the exact schema it parses with.
describe("the contract the proxy will parse", () => {
  it("sends a body that satisfies the schema the proxy validates against", async () => {
    const { client, sent } = clientWith();

    await client.decide(CHANNEL, DECISION);

    expect(ApprovalDecision.safeParse(sent[0]?.body).success).toBe(true);
  });

  it("sends no field the schema does not name", async () => {
    const { client, sent } = clientWith();

    await client.decide(CHANNEL, DECISION);

    expect(Object.keys(sent[0]?.body as object).sort()).toEqual([
      "approver",
      "decision",
      "ticket"
    ]);
  });
});
