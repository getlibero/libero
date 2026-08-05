// The spend client, faked at the transport seam.
//
// TLS is not here: a real handshake and a real certificate are
// ./transport.test.ts, which is also where "a completed task moves the meter"
// is asserted against a listener that reads the peer certificate. This file is
// about what the client does with an answer, what bytes it puts on the wire,
// and the deadline it carries on its own behalf.

import { SpendReport } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../completion/types.js";
import { createProxySpendClient } from "./spend.js";
import { ProxyClientError, type ProxyRequest, type ProxyResponse, type ProxyTransport } from "./transport.js";

const CHANNEL = "C024BE91L";
const TURN = "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55";

/** What a provider that reports everything reports. */
const USAGE: TokenUsage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadInputTokens: 4096,
  cacheCreationInputTokens: 1024
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
        return (await answer?.(options)) ?? { status: 200, body: { outcome: "recorded" } };
      }
    }
  };
}

function clientWith(
  answer?: (options: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>,
  timeoutMs?: number
): { client: ReturnType<typeof createProxySpendClient>; sent: ProxyRequest[] } {
  const fake = fakeTransport(answer);
  const client = createProxySpendClient({
    transport: fake.transport,
    channel: CHANNEL,
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  });
  return { client, sent: fake.sent };
}

describe("reporting what a turn cost", () => {
  it("posts the report on the channel's certificate", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(CHANNEL);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.path).toBe("/v1/spend");
  });

  // The counts are the provider's, and they arrive as the provider gave them:
  // no weighting, because that is the team sheet's, and no total, because a
  // total would be this process deciding what a cached token costs.
  it("sends the four counts raw, unweighted and unsummed", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    expect(SpendReport.parse(sent[0]?.body).usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 4096,
      cacheCreationInputTokens: 1024
    });
    // 11 + 7 + 4096 + 1024. Nothing in the body is the sum of anything.
    expect(JSON.stringify(sent[0]?.body)).not.toContain("5138");
  });

  // The loop keeps "the provider never mentioned this" apart from "the provider
  // said zero", because a cap has to know which it is looking at. A meter
  // column cannot hold the difference and does not need to: not reported means
  // not spent.
  it("reports zero for a cache field the provider never mentioned", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, { inputTokens: 11, outputTokens: 7 });

    expect(SpendReport.parse(sent[0]?.body).usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    });
  });

  it("sends the turn id it was given, unchanged", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    expect(SpendReport.parse(sent[0]?.body).turn).toBe(TURN);
  });

  // The channel is an identity here, not a field: it chose the certificate, and
  // the proxy reads it off that. A body asserting one is refused rather than
  // trimmed, so this is the test that fails if someone adds it.
  it("puts no channel in the body, in any form", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    expect(JSON.stringify(sent[0]?.body)).not.toContain(CHANNEL);
  });
});

describe("the meter's answer", () => {
  it("returns recorded when the turn was counted", async () => {
    const { client } = clientWith();

    await expect(client.report(TURN, USAGE)).resolves.toBe("recorded");
  });

  // The whole point of a turn id. A retry under one already counted must not
  // spend the budget twice, so the meter says it did not — which is the answer
  // the retry was hoping for, not an error to raise.
  it("treats a duplicate as the success it is", async () => {
    const { client } = clientWith(() => ({ status: 200, body: { outcome: "duplicate" } }));

    await expect(client.report(TURN, USAGE)).resolves.toBe("duplicate");
  });
});

describe("a report the proxy could not take", () => {
  it("throws for a non-200 and for an answer that does not parse", async () => {
    for (const answer of [
      { status: 500, body: undefined },
      { status: 400, body: { error: { code: "bad_request", message: "no", requestId: "r1" } } },
      { status: 200, body: { outcome: "counted" } },
      { status: 200, body: undefined }
    ]) {
      const { client } = clientWith(() => answer);
      await expect(client.report(TURN, USAGE)).rejects.toBeInstanceOf(ProxyClientError);
    }
  });

  // The proxy's own message is written by the proxy and documented safe to
  // relay, so it is the better sentence for an operator.
  it("relays the proxy's own message when it sent one", async () => {
    const { client } = clientWith(() => ({
      status: 400,
      body: {
        error: {
          code: "bad_request",
          message: "the request body is not a valid spend report",
          requestId: "req-1"
        }
      }
    }));

    await expect(client.report(TURN, USAGE)).rejects.toThrow(
      /^proxy client: the request body is not a valid spend report$/
    );
  });

  it("carries no response body into the error it raises", async () => {
    const { client } = clientWith(() => ({
      status: 500,
      body: { secret: "ghp_should_not_appear" }
    }));

    await expect(client.report(TURN, USAGE)).rejects.toThrow(
      /^proxy client: the spend report failed$/
    );
  });
});

describe("the deadline this client carries", () => {
  it("abandons a report the proxy never answers", async () => {
    const { client } = clientWith(
      options =>
        new Promise<ProxyResponse>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new ProxyClientError("proxy client: cancelled", "cancelled"));
          });
        }),
      10
    );

    await expect(client.report(TURN, USAGE)).rejects.toMatchObject({ reason: "timed_out" });
  });

  // An operator reading `cancelled` goes looking for a shutdown. There was no
  // shutdown: this object accepts no caller signal, so the only thing that can
  // abort a report in flight is its own deadline, and it says so.
  it("calls its own deadline a timeout rather than a cancellation", async () => {
    const { client } = clientWith(
      options =>
        new Promise<ProxyResponse>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new ProxyClientError("proxy client: cancelled", "cancelled"));
          });
        }),
      10
    );

    await expect(client.report(TURN, USAGE)).rejects.toThrow(
      /^proxy client: the spend report timed out$/
    );
  });

  // Structural, and the assertion is the point: a cancelled task still spent
  // tokens, so there is no signal a caller could hand this that would be right
  // to honour. Refusing the parameter is what keeps it from being added back.
  it("takes no signal from its caller", () => {
    const { client } = clientWith();

    expect(client.report.length).toBe(2);
  });
});

// The two ends never meet in this file — the proxy is a package this one may
// not import, and both processes running for real is the e2e suite's job (#41).
// What they do share is @getlibero/schema, and it is the proxy's edge parse. So
// the substitute for standing up the real server is to put the bytes this
// client sends through the exact schema that server parses them with: a body
// that fails here is a 400 there.
describe("the contract the proxy will parse", () => {
  it("sends a body that satisfies the schema the proxy validates against", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    expect(SpendReport.safeParse(sent[0]?.body).success).toBe(true);
  });

  // Strict on the other side, at both levels. This is the test that fails when
  // someone adds a channel, a day, or a convenience total.
  it("sends no field the schema does not name", async () => {
    const { client, sent } = clientWith();

    await client.report(TURN, USAGE);

    const body = sent[0]?.body as { usage: object };
    expect(Object.keys(body).sort()).toEqual(["turn", "usage"]);
    expect(Object.keys(body.usage).sort()).toEqual([
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "inputTokens",
      "outputTokens"
    ]);
  });
});
