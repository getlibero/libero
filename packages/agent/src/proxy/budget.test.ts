// The budget client, faked at the transport seam.
//
// ./spend.test.ts's shape and its reason: TLS lives in ./transport.test.ts, and
// this file is about what the client does with an answer, what it puts on the
// wire, and the two ways a question can end early.

import { describe, expect, it } from "vitest";
import { createProxyBudgetClient } from "./budget.js";
import { ProxyClientError, type ProxyRequest, type ProxyResponse, type ProxyTransport } from "./transport.js";

const CHANNEL = "C024BE91L";

function fakeTransport(
  answer?: (options: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>
): { transport: ProxyTransport; sent: ProxyRequest[] } {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        return (await answer?.(options)) ?? { status: 200, body: { spendable: true } };
      }
    }
  };
}

function clientWith(
  answer?: (options: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>,
  timeoutMs?: number
): { client: ReturnType<typeof createProxyBudgetClient>; sent: ProxyRequest[] } {
  const fake = fakeTransport(answer);
  const client = createProxyBudgetClient({
    transport: fake.transport,
    channel: CHANNEL,
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  });
  return { client, sent: fake.sent };
}

/** A transport that never answers, so a signal is the only way out. */
const hangs = (options: ProxyRequest): Promise<ProxyResponse> =>
  new Promise<ProxyResponse>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      reject(new ProxyClientError("proxy client: cancelled", "cancelled"));
    });
  });

describe("asking whether a channel may be spent for", () => {
  it("asks on the channel's certificate, with no body", async () => {
    const { client, sent } = clientWith();

    await client.status();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(CHANNEL);
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.path).toBe("/v1/budget");
    // A question carries nothing. The channel is the certificate's and there is
    // nothing else this client could assert.
    expect(sent[0]?.body).toBeUndefined();
  });

  it("answers null for a channel that may spend", async () => {
    const { client } = clientWith(() => ({ status: 200, body: { spendable: true } }));

    expect(await client.status()).toBeNull();
  });

  it("answers the reason the gate would have given", async () => {
    const refusal = { reason: "budget_exhausted", limit: "daily_tokens" };
    const { client } = clientWith(() => ({ status: 200, body: { spendable: false, refusal } }));

    expect(await client.status()).toEqual(refusal);
  });

  it("carries a pricing fault through as itself", async () => {
    // Not collapsed to "over budget". A channel that cannot be priced is fixed
    // in the price table, not by raising a cap, and the caller's log line is the
    // only place an operator will see which it was.
    const refusal = { reason: "model_not_priced", model: "some-vendor/some-model" };
    const { client } = clientWith(() => ({ status: 200, body: { spendable: false, refusal } }));

    expect(await client.status()).toEqual(refusal);
  });

  it("throws rather than guessing when the answer is not a status", async () => {
    for (const body of [{ spendable: "yes" }, { refusal: null }, {}, "no", null]) {
      const { client } = clientWith(() => ({ status: 200, body }));

      await expect(client.status()).rejects.toMatchObject({ reason: "malformed_response" });
    }
  });

  it("throws on a non-200, relaying the service's own error", async () => {
    const { client } = clientWith(() => ({
      status: 500,
      body: { error: { code: "internal", message: "the meter is unavailable", requestId: "r-1" } }
    }));

    const error = (await client.status().catch((cause: unknown) => cause)) as ProxyClientError;

    expect(error).toBeInstanceOf(ProxyClientError);
    expect(error.reason).toBe("proxy_error");
  });

  it("does not degrade to spendable when it cannot ask", async () => {
    // The whole reason this throws rather than answering null: an unanswerable
    // question that read as "go ahead" would make an outage the one condition
    // under which every bound here disappears. What the failure *means* is the
    // caller's, and it cannot decide if it is not told.
    const { client } = clientWith(() => {
      throw new ProxyClientError("proxy client: unreachable", "unreachable");
    });

    await expect(client.status()).rejects.toMatchObject({ reason: "unreachable" });
  });

  describe("the two ways it ends early", () => {
    it("calls its own deadline a timeout rather than a cancellation", async () => {
      const { client } = clientWith(hangs, 10);

      await expect(client.status()).rejects.toThrow(/^proxy client: the budget question timed out$/);
    });

    it("calls the caller's cancellation what it is", async () => {
      // Unlike the spend report, this client takes a caller signal — a cancelled
      // pass should not spend, so cancelling the question is right. The two
      // reasons must stay distinguishable, or an operator reads a shutdown as an
      // unresponsive service.
      const { client } = clientWith(hangs, 60_000);
      const controller = new AbortController();
      const asked = client.status(controller.signal);
      controller.abort();

      await expect(asked).rejects.toMatchObject({ reason: "cancelled" });
    });

    it("passes a caller's signal down to the transport", async () => {
      const { client, sent } = clientWith();
      const controller = new AbortController();

      await client.status(controller.signal);

      expect(sent[0]?.signal).toBeDefined();
      expect(sent[0]?.signal?.aborted).toBe(false);
    });
  });
});
