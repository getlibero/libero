// A human's decision on a held call, relayed to the proxy's approval broker
// over the same mutual-TLS connection a tool call takes.
//
// The click is observed by gateway code — a Socket Mode interactive envelope —
// and never produced by a model, which is what the approver's identity is worth:
// it holds against a prompt-injected model, and not against a compromised agent
// process, which is the process relaying it. The broker's docs say it the same
// way.
//
// **Process-level, with the channel per call** — unlike the tool and spend
// clients, which are pinned to one channel at construction because one task
// serves one channel. Decisions are not task-shaped: a click arrives for
// whatever channel its card sits in, observed at process scope, so this client
// takes the channel where the transport does. The pinning argument is about
// per-task objects, and this is not one. What still holds is that the channel
// selects a certificate and never a body field: `ApprovalDecision` is strict,
// so a body naming a channel is rejected by the proxy rather than quietly
// dropped, and channel A's certificate cannot decide channel B's ticket.
//
// **No `AbortSignal` parameter, deliberately**, for the spend client's reason:
// the only signal in scope cancels a task, and the human's click outlives any
// task's cancellation — discarding it would lose a decision a person made.
// This object carries its own short deadline instead.
//
// **A failed relay throws, and what that costs is the caller's decision.** The
// broker not hearing a click leaves the ticket pending and the card's buttons
// live, so the human can click again — which is why the caller lets this
// rejection propagate rather than settling anything on it.

import { ApprovalDecisionResponse, type ApprovalDecision } from "@getlibero/schema";
import { proxyErrorFrom } from "./errors.js";
import { ProxyClientError, type ProxyTransport } from "./transport.js";

/**
 * How long a decision relay may take before it is abandoned.
 *
 * Short for the spend deadline's reason: the proxy's work is one parse and one
 * map lookup, and a broker that has not answered in five seconds is not going
 * to answer usefully. The ticket survives the abandonment — fifteen minutes of
 * validity against five seconds of deadline — so the human retries by clicking,
 * not by waiting.
 */
export const DEFAULT_APPROVAL_DECISION_TIMEOUT_MS = 5_000;

export interface ProxyApprovalsClientOptions {
  transport: ProxyTransport;
  timeoutMs?: number;
}

export interface ProxyApprovalsClient {
  /**
   * Relays one decision and answers what the broker did with it.
   *
   * All four outcomes are served requests: `already_decided` carries the
   * verdict that stands — the first one — which is what a caller should act
   * on, not the click it just relayed.
   */
  decide(channel: string, decision: ApprovalDecision): Promise<ApprovalDecisionResponse>;
}

export function createProxyApprovalsClient(
  options: ProxyApprovalsClientOptions
): ProxyApprovalsClient {
  const { transport } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_DECISION_TIMEOUT_MS;

  return {
    async decide(channel: string, decision: ApprovalDecision): Promise<ApprovalDecisionResponse> {
      // Not parsed here before sending, for the spend client's reason: the
      // proxy's parse at its own edge is the authority, and a second opinion
      // in this process could only agree or be wrong.
      const deadline = AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await transport.request({
          channel,
          method: "POST",
          path: "/v1/approvals",
          body: decision,
          signal: deadline
        });
      } catch (cause) {
        // The transport reports any aborted signal as a cancellation, which is
        // wrong here: this object takes no caller signal, so the only thing
        // that can have aborted is the deadline above. Said as what it is.
        if (cause instanceof ProxyClientError && cause.reason === "cancelled" && deadline.aborted) {
          throw new ProxyClientError("proxy client: the decision relay timed out", "timed_out");
        }
        throw cause;
      }

      if (response.status !== 200) throw proxyErrorFrom(response.body, "the decision relay failed", response.status);

      const parsed = ApprovalDecisionResponse.safeParse(response.body);
      if (!parsed.success) {
        throw new ProxyClientError(
          "proxy client: the decision answer was not a valid response",
          "malformed_response"
        );
      }

      return parsed.data;
    }
  };
}
