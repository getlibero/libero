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
    const entry = registry.get(decision.ticketId);
    if (entry === undefined) {
      // Nobody is waiting: a stale card after a restart, a click that lost a
      // race with settlement, or an id that never existed. Entries live and
      // die with their tasks, so these are one case, and none of them is
      // relayed — the proxy's expiry bounds what an orphaned ticket can
      // become without this process's help.
      logger.log("info", {
        event: "approval_ignored",
        reason: "unknown_ticket",
        channel: decision.channelId,
        ticket: decision.ticketId
      });
      return;
    }

    if (decision.channelId !== entry.channel) {
      // The card sits in the channel whose certificate minted the ticket, so
      // a click from anywhere else did not come from that card. Dropped here,
      // before the proxy is asked to decide anything on the wrong channel's
      // behalf — the broker would scope the lookup by certificate anyway;
      // this keeps the wrong question from being asked at all.
      logger.log("warn", {
        event: "approval_ignored",
        reason: "channel_mismatch",
        channel: decision.channelId,
        ticket: decision.ticketId
      });
      return;
    }

    const answer = await approvals.decide(entry.channel, {
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
          channel: entry.channel,
          ticket: decision.ticketId
        });
        entry.settle({ state: "expired" });
        return;
    }
  };
}
