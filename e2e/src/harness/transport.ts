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
