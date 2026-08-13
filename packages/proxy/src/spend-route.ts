// `POST /v1/spend` — the agent reports what a turn cost, and the meter records
// it.
//
// **This route makes no authorization decision.** It reads no team sheet, it
// consults no allowlist, and it produces no verdict — because reporting spend
// is not asking for anything, so there is nothing to decide. That makes it the
// odd one out on a listener whose other call path is "a request arrives,
// enforcement answers, then something happens", and the asymmetry is stated
// here rather than left to be inferred.
//
// The risk is drift rather than this file as written. A route with no decision
// is where a later change quietly puts one — a per-user rule, a "trusted
// reporter" shortcut, an early return that skips the sheet — and next to the
// route that does decide, it would not look wrong. Three things make that hard
// rather than merely discouraged:
//
//   - This module imports neither ./team-sheet-store.js nor ./enforce.js, so
//     the handler has no access to a thing that resolves a sheet. Read the
//     import list as a claim, the way ./vault.ts's is read.
//   - It closes over `TokenRecorder`, not `SpendMeter`. It cannot read a
//     counter and it cannot write a tool-call count — `daily_tool_calls`
//     holding under compromise of the agent process is exactly what a shared
//     record path would cost.
//   - eslint.config.mjs forbids those imports in this file, so the CI job says
//     so before a reviewer has to.
//
// A per-user rule or a trusted-reporter shortcut belongs on /v1/tools/call, or
// nowhere.
//
// **#62 added a `model` to the body, and none of the above changed.** The id the
// provider echoed back is a *dimension of the count* — it decides which row the
// tokens are filed under, the way the day already does — and this route still
// resolves nothing from it, reads no sheet to interpret it, and answers 200
// either way. What a model costs is the price table's, joined against these
// counts in ./enforce.ts on the next call, from the channel's own sheet. The
// three defences above hold verbatim and the ESLint rule is unchanged.
//
// The distinction to keep, if a later change wants more from this field: a
// dimension may select a *price*, and may never select a *permission*. A report
// that named a model this deployment cannot price does not get refused here —
// nothing is being asked for — it lands in a bucket, and the channel's next call
// is the thing that gets an answer.
//
// What this route *does* share with the enforcing one, and must: the channel
// comes from the client certificate and from nowhere else. The body is strict
// and has no channel field, so an agent that tries to report on another
// channel's behalf gets a 400 rather than a silently dropped field.

import {
  PROXY_ERROR_STATUS,
  type ProxyError,
  SpendReport,
  type SpendReportResponse
} from "@getlibero/schema";
import type { TokenRecorder } from "./dispatch.js";
import type { Logger } from "./log.js";
import type { RequestContext, RouteHandler, RouteResponse } from "./server.js";

export interface SpendRouteOptions {
  /** Deliberately the narrow interface. See the note above. */
  readonly meter: TokenRecorder;
  readonly logger: Logger;
}

export function createSpendRoute(options: SpendRouteOptions): RouteHandler {
  const { meter, logger } = options;

  return async (ctx: RequestContext): Promise<RouteResponse> => {
    const parsed = SpendReport.safeParse(ctx.body);
    if (!parsed.success) {
      // The zod issues are not relayed, for the reason the tool-call route
      // gives: they quote the input, and the input comes from the agent.
      logger.log("warn", {
        event: "spend_report_malformed",
        requestId: ctx.requestId,
        channel: ctx.channel
      });
      return {
        status: PROXY_ERROR_STATUS.bad_request,
        body: {
          error: {
            code: "bad_request",
            message: "the request body is not a valid spend report",
            requestId: ctx.requestId,
            channel: ctx.channel
          }
        } satisfies ProxyError
      };
    }

    const { turn, model, usage } = parsed.data;
    const record = await meter.recordTokens(ctx.channel, turn, usage, model);

    logger.log("info", {
      event: "spend_reported",
      requestId: ctx.requestId,
      channel: ctx.channel,
      report: record.outcome,
      // Which model the counts are filed under, which is the spelling an
      // operator needs when they write a price for it — the sheet's `[llm]
      // model` is what was *asked for*, and under a router the two differ.
      // Omitted rather than logged as a placeholder when the agent named none:
      // the meter's substitution is the meter's, and a log line that showed it
      // here would read as though this route had chosen something.
      ...(model === undefined ? {} : { model }),
      // Raw, unweighted: this route knows no team sheet and therefore no
      // weights. What the budget was charged is decided in ./enforce.ts.
      tokens:
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens
    });

    // 200 for both outcomes. A duplicate is the correct answer to a retry —
    // the turn is counted — and nothing here can be denied.
    return { status: 200, body: { outcome: record.outcome } satisfies SpendReportResponse };
  };
}
