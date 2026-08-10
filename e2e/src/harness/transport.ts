// Transport decorators, for the cases that need the agent to misbehave.
//
// The agent is the untrusted half. Some claims are about what the proxy holds
// when the agent stops cooperating — and the honest way to express that is to
// interfere with what crosses the wire, not to add a flag to the production
// composition. A `ServerDeps` field saying "do not report spend" would be a
// mode nothing deploys; a transport that swallows the report is a compromised
// agent, which is exactly the threat model.

import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";

/**
 * Answers `/v1/spend` locally and sends nothing.
 *
 * The narrower budget claim, made testable: `daily_tool_calls` is counted by the
 * proxy from calls it serves, so it holds even against an agent that reports no
 * tokens at all — while `daily_tokens` is counted from what the agent reports
 * and therefore holds against a prompt-injected model and no further. With this
 * wrapper the second meter never moves, and the first must still bite.
 *
 * It answers rather than throws because `reportSpend` is total and a failure
 * costs only a log line — a throwing transport would prove the failure path
 * instead of the silence.
 */
export function withoutSpendReports(inner: ProxyTransport): ProxyTransport {
  return {
    request(options: ProxyRequest): Promise<ProxyResponse> {
      if (options.path === "/v1/spend") {
        return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
      }
      return inner.request(options);
    }
  };
}

/**
 * Sends every `/v1/spend` twice, and answers with what the first send said.
 *
 * The other half of the metering threat model: an agent that under-reports is
 * `withoutSpendReports`, and an agent that over-reports is this — a retry loop,
 * a restart replaying a queue, or a compromised sender trying to make a
 * channel's budget look spent. The turn id is the idempotency key, so the
 * second copy must be a `duplicate` and must move no counter.
 *
 * The *first* answer is returned rather than the second, so the agent's own
 * view of what it reported stays honest and the duplicate is observed where it
 * is authoritative: the proxy's log line. A wrapper that reported the duplicate
 * back to the agent would be testing this decorator's bookkeeping instead.
 */
export function replayingSpendReports(inner: ProxyTransport): ProxyTransport {
  return {
    async request(options: ProxyRequest): Promise<ProxyResponse> {
      const first = await inner.request(options);
      if (options.path !== "/v1/spend") return first;
      // Sequential, not concurrent: two in flight at once would race the
      // meter's own insert and the case would be about SQLite's locking rather
      // than about the turn id.
      await inner.request(options);
      return first;
    }
  };
}

/** Every request that crossed, for a case asserting on what the agent sent. */
export interface RecordingTransport {
  readonly transport: ProxyTransport;
  readonly sent: ProxyRequest[];
}

export function recording(inner: ProxyTransport): RecordingTransport {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        return inner.request(options);
      }
    }
  };
}
