// A click becomes a settled wait, by way of the proxy.
//
// The order is the point of this file. The registry says whether anyone is
// waiting; the proxy says what the click was worth; only then is the wait
// settled, with what the proxy said rather than what was clicked. A decision
// this process never relayed is a decision that did not happen — the broker's
// ticket state is the record the re-submission will be judged against, so
// settling a wait on an unrelayed click would repaint a card green for a call
// the proxy still holds as pending.
//
// What this file trusts is worth saying once: the approver id is read out of a
// Socket Mode envelope by gateway code, so it holds against a prompt-injected
// model and not against a compromised agent process, which is the process
// running this handler. The proxy's docs make the same claim in the same words.

import type { ProxyApprovalsClient } from "@getlibero/agent";
import type { DecisionHandler, Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { ApprovalRegistry } from "./registry.js";

export interface DecisionHandlerOptions {
  registry: ApprovalRegistry;
  approvals: ProxyApprovalsClient;
  logger?: Logger;
}

/**
 * The `onDecision` the gateway dispatches clicks to.
 *
 * A rejection propagates deliberately: the gateway logs it as
 * `decision_failed` and the entry stays registered, which leaves the card
 * amber and its buttons live — the true state, since the proxy recorded
 * nothing. The human retries by clicking, not by waiting.
 */
export function createDecisionHandler(options: DecisionHandlerOptions): DecisionHandler {
  const { registry, approvals } = options;
  const logger = options.logger ?? createSilentLogger();

  return async decision => {
    // The lookup is scoped by the click's channel, so a click from any other
    // channel finds nothing — the card sits in the channel whose certificate
    // minted the ticket, and the registry's shape is what makes that check
    // unforgettable rather than a comparison after the fetch. Dropped before
    // the proxy is asked to decide anything on the wrong channel's behalf;
    // the broker would scope the lookup by certificate anyway.
    const entry = registry.get(decision.channelId, decision.ticketId);
    if (entry === undefined) {
      // Nobody is waiting under this channel, and the drop is the same either
      // way — nothing is relayed, nothing settles, and the clicker sees no
      // difference. The log line is not the same: a wait held under another
      // channel means a misdirected or forged click, which is an operator's
      // signal at warn, where a stale card after a restart, a click that lost
      // a race with settlement, or an id that never existed is expected noise
      // at info. `heldElsewhere` answers a boolean precisely so this branch
      // can choose a word without being handed an entry it must not settle.
      if (registry.heldElsewhere(decision.channelId, decision.ticketId)) {
        logger.log("warn", {
          event: "approval_ignored",
          reason: "channel_mismatch",
          channel: decision.channelId,
          ticket: decision.ticketId
        });
      } else {
        logger.log("info", {
          event: "approval_ignored",
          reason: "unknown_ticket",
          channel: decision.channelId,
          ticket: decision.ticketId
        });
      }
      return;
    }

    const answer = await approvals.decide(decision.channelId, {
      ticket: decision.ticketId,
      decision: decision.verdict,
      approver: decision.approverId
    });

    switch (answer.outcome) {
      case "recorded":
        entry.settle(
          answer.decision === "approve"
            ? { state: "approved", approver: decision.approverId }
            : { state: "denied", approver: decision.approverId }
        );
        return;
      case "already_decided":
        // The first verdict stands and is what the wait settles with. The
        // approver shown is the clicker whose relay got through, which can be
        // the second clicker when the first's response was lost — attribution
        // slack the card tolerates; the audit log has the row that counts.
        entry.settle(
          answer.decision === "approve"
            ? { state: "approved", approver: decision.approverId }
            : { state: "denied", approver: decision.approverId }
        );
        return;
      case "expired":
        entry.settle({ state: "expired" });
        return;
      case "unknown":
        // The proxy lost the ticket — a restart during the hold. Waiting out
        // the local deadline buys nothing a re-submission will not learn
        // faster, and the re-submission's `approval_unknown` refusal already
        // says what happened.
        logger.log("warn", {
          event: "approval_unknown",
          channel: decision.channelId,
          ticket: decision.ticketId
        });
        entry.settle({ state: "expired" });
        return;
    }
  };
}
