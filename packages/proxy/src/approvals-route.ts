// `POST /v1/approvals` — a human decided a held call, and the broker writes it
// down.
//
// **This route resolves no team sheet, and that is not an oversight.** Deciding
// is not asking for anything to run. The sheet was consulted when the ticket was
// minted and it is consulted *again* at redemption, from the live sheet, by
// /v1/tools/call — that second read is the load-bearing one, and it is what
// makes an approval unable to widen what a channel may call. A sheet check here
// would be a third read that changes nothing: it could authorize nothing,
// because this route serves no call, and it could withhold nothing, because
// redemption would catch it anyway. What it would do is put an enforcement
// decision on a path with no call to decide about, which is where the next
// mistake goes. So this route's whole job is to write down what a human said.
//
// Three things make that hard to drift from rather than merely discouraged, the
// same three ./spend-route.ts relies on:
//
//   - This module imports neither ./team-sheet-store.js nor ./enforce.js, so the
//     handler has no access to a thing that resolves a sheet. Read the import
//     list as a claim, the way ./vault.ts's is read.
//   - It closes over `ApprovalDecider`, not `ApprovalStore`. It cannot mint a
//     ticket and it cannot redeem one. That is the narrowing that matters most
//     in this feature: a route that could mint could manufacture a ticket for
//     any call it liked and then approve it, which is the whole thing turned
//     inside out, and a route that could redeem could serve one.
//   - eslint.config.mjs forbids those imports here, so CI says so before a
//     reviewer has to.
//
// ## Where this differs from /v1/spend, and why
//
// Unlike the spend route, **this one writes audit rows**. A decision is a
// terminal fact about a call, produced by a request that is not a tool call, so
// there is no later /v1/tools/call to record it — the row is written here or it
// is never written at all. An approval that is clicked and never redeemed is the
// case that makes this matter: without a row here, an agent that died between
// the click and the re-submission would leave a log showing a held call and no
// sign that a human approved it.
//
// The discipline is the tool-call route's, for the reason stated at length
// there: the durable row first, then the log line, and a failed write throws
// rather than being swallowed. A human's decision that no durable write recorded
// is a decision the log can lie about.
//
// ## What this route is worth, stated so nothing overstates it
//
// The approver arrives here from the agent process, which read it out of a
// Socket Mode interactive envelope — gateway code observing a click rather than
// a model producing output. So the identity in the audit row holds against a
// **prompt-injected model** and not against a **compromised agent process**,
// which could forge a decision. That is the same narrower claim `daily_tokens`
// makes, for the same reason, and the alternative — the proxy reading Slack
// itself — is rejected in the architecture because it makes the proxy the
// gateway.
//
// What a forged decision still cannot do is widen anything: it can approve only
// a call the sheet already permits, because redemption enforces the sheet again.

import {
  ApprovalDecision,
  type ApprovalDecisionResponse,
  PROXY_ERROR_STATUS,
  type ProxyError
} from "@getlibero/schema";
import type { ApprovalDecider, ApprovalTicketRecord } from "./approvals.js";
import type { AuditWriter } from "./audit-log.js";
import type { Logger } from "./log.js";
import type { RequestContext, RouteHandler, RouteResponse } from "./server.js";

export interface ApprovalsRouteOptions {
  /** Deliberately the narrow interface. See the note above. */
  readonly approvals: ApprovalDecider;
  /** Because this route writes a row nothing else will. See the note above. */
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly now: () => number;
}

export function createApprovalsRoute(options: ApprovalsRouteOptions): RouteHandler {
  const { approvals, audit, logger, now } = options;

  return async (ctx: RequestContext): Promise<RouteResponse> => {
    const parsed = ApprovalDecision.safeParse(ctx.body);
    if (!parsed.success) {
      // The zod issues are not relayed, for the reason the tool-call route
      // gives: they quote the input, and the input comes from the agent.
      //
      // No audit row either. There is no decided ticket to describe — the same
      // answer a malformed tool call gets, and for the same reason.
      logger.log("warn", {
        event: "approval_decision_malformed",
        requestId: ctx.requestId,
        channel: ctx.channel
      });
      return {
        status: PROXY_ERROR_STATUS.bad_request,
        body: {
          error: {
            code: "bad_request",
            message: "the request body is not a valid approval decision",
            requestId: ctx.requestId,
            channel: ctx.channel
          }
        } satisfies ProxyError
      };
    }

    const { ticket, decision, approver } = parsed.data;

    /**
     * The channel comes from the client certificate, and this one argument is
     * the entire "channel A cannot decide channel B's ticket" property. The
     * body has no channel field to override it with — `ApprovalDecision` is
     * strict — and the store keys tickets by channel first, so a decision from
     * the wrong connection cannot reach the ticket to begin with.
     */
    const recorded = approvals.decide(ctx.channel, ticket, decision, approver);

    /** The row first, then the line. A failed write throws; see the header. */
    const record = async (
      held: ApprovalTicketRecord,
      outcome: "approved" | "denied" | "expired"
    ): Promise<void> => {
      try {
        await audit.append({
          at: now(),
          channel: ctx.channel,
          // Off the ticket, not off this request: they describe the *call*, and
          // this request is not one. The ticket is the only description of it
          // this route has.
          requestingUser: held.requestingUser,
          task: held.task,
          // This request's own id, though. The held row and this one join on
          // the ticket column rather than on a request id, because they are two
          // requests and always were.
          requestId: ctx.requestId,
          callId: held.callId,
          server: held.server,
          tool: held.tool,
          argumentsSha256: held.argumentsSha256,
          outcome,
          ...(outcome === "denied" ? { refusalReason: "approval_denied" as const } : {}),
          // An expiry has no approver, and says so with an absence rather than
          // with a name nobody gave.
          ...(outcome === "expired" ? {} : { approver }),
          ticket: held.id
        });
      } catch (error) {
        // The thrown value is not inspected or logged, as on the tool-call
        // route: in this process an exception is a thing that can carry a
        // credential. Naming the subsystem is what an operator needs.
        logger.log("error", {
          event: "audit_write_failed",
          requestId: ctx.requestId,
          channel: ctx.channel
        });
        throw error;
      }

      logger.log("info", {
        event: "approval_decided",
        requestId: ctx.requestId,
        channel: ctx.channel,
        server: held.server,
        tool: held.tool,
        outcome,
        ticket: held.id,
        ...(outcome === "expired" ? {} : { approver, decision })
      });
    };

    switch (recorded.outcome) {
      case "recorded":
        await record(recorded.ticket, decision === "approve" ? "approved" : "denied");
        return ok({ outcome: "recorded", ticket, decision });

      case "expired":
        // Only if this request is the one that noticed. Without that check, N
        // late clicks on a stale card write N rows and every count of expiries
        // is wrong by however many times someone clicked.
        if (recorded.firstObserved) await record(recorded.ticket, "expired");
        return ok({ outcome: "expired", ticket });

      case "already_decided":
        // No row. The decision that counts already has one, and a second row
        // would say a human decided this twice — which is true of the clicks
        // and false of the decision.
        logger.log("info", {
          event: "approval_decided",
          requestId: ctx.requestId,
          channel: ctx.channel,
          approval: "already_decided",
          ticket,
          approver
        });
        return ok({
          outcome: "already_decided",
          ticket,
          decision: recorded.ticket.verdict ?? decision
        });

      case "unknown":
        // No row, and nothing to put in one: this channel has no such ticket, so
        // there is no call to describe. A ticket another channel holds lands
        // here too, and is indistinguishable from one that never existed.
        logger.log("info", {
          event: "approval_decided",
          requestId: ctx.requestId,
          channel: ctx.channel,
          approval: "unknown",
          ticket,
          approver
        });
        return ok({ outcome: "unknown", ticket });
    }
  };
}

/** 200 for every outcome: none of them is a request that failed. */
function ok(body: ApprovalDecisionResponse): RouteResponse {
  return { status: 200, body };
}
