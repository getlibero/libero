// `GET /v1/budget` — whether this channel can afford to be spent for (#335).
//
// The agent side has four background passes that run with nobody waiting on
// them, and three of those spend: a completion or an embedding, on a clock
// rather than on a request. None of that spend passes through this process. A
// completion goes straight to the provider and arrives here afterwards as a
// count on `POST /v1/spend`, which is a debit that always clears — so a turn
// that calls no tool meets no gate at all, however far over its cap the channel
// is. This route is how such a turn asks before it starts.
//
// ## It is advisory, and the README says so where a reader will meet it
//
// **This is not a second enforcement point and must never be described as one.**
// The proxy cannot refuse a completion it never sees, so a compromised agent
// simply does not call this and spends anyway. What it buys is cost control for
// an agent that is working correctly, which is the same standing `[ambient]`
// has on the sheet — honoured by the agent and by nothing else. The property
// that survives agent compromise is unchanged and is `/v1/tools/call`'s:
// `daily_tool_calls` and `daily_tokens` still refuse *tool calls*, from this
// process's own observation.
//
// ## Four claims this module makes by what it holds
//
//   - **It decides nothing that runs.** There is no dispatcher here and no
//     ticket store; the answer is a verdict about a call the caller has not made
//     and this process will never see.
//   - **It holds `SpendReader`, never `SpendMeter`.** The mirror of
//     ./spend-route.ts's `TokenRecorder` argument, one direction over: that
//     route can write a counter and cannot read one, this one can read and
//     cannot write. This is `SpendReader`'s first narrowed consumer, and the
//     narrowing is what keeps CLAUDE.md's "the server's whole surface on the
//     meter is read, recordToolCall, recordTokens" true as the surface grows.
//   - **It writes no audit row.** The audit log records decided *calls*, and
//     there is no call here — contrast ./approvals-route.ts, which writes rows
//     because a human's decision is a fact about a call that no later request
//     records. A row per background pass asking whether it may run would be
//     noise in the one place that must stay readable after an incident.
//   - **It cannot claim a warning.** `crossedThreshold` is the soft counterpart
//     to the check below, reachable only through `WarningClaimer`, and a channel
//     gets one warning a day. Claiming it here would spend it on an answer given
//     to a background pass and to nobody in the channel. `SpendReader` is what
//     makes that impossible rather than merely unwise; see the note on
//     `exhaustedLimit` in ./enforce.ts.
//
// eslint.config.mjs forbids the imports this file must not have, so CI says so
// before a reviewer has to — ./spend-route.ts's mechanism, for its reason: the
// risk is a later change, not this file as written.
//
// ## One function decides
//
// The whole handler is: resolve the sheet, read the meter, hand both to
// `exhaustedLimitFromState`. That is the same function `/v1/tools/call` reaches
// through `decide`, which is the point of the route rather than an economy — a
// second comparison here would be a second answer to "is this channel over", and
// the two would disagree the first time a cache-weight ratio or the
// dollars-before-tokens ordering changed. A test asserts the two agree.

import { exhaustedLimitFromState } from "./enforce.js";
import type { SpendReader } from "./dispatch.js";
import type { Logger } from "./log.js";
import { NO_PRICES } from "./price-table-store.js";
import type { PriceTableStore } from "./price-table-store.js";
import type { RequestContext, RouteHandler, RouteResponse } from "./server.js";
import type { TeamSheetSource } from "./team-sheet-store.js";
import type { BudgetStatus } from "@getlibero/schema";

export interface BudgetRouteOptions {
  readonly sheets: TeamSheetSource;
  /**
   * Deliberately the read half of the meter. See the note above — a read route
   * holding a `SpendMeter` could record a tool call or claim a warning, and
   * neither is something answering a question should be able to do.
   */
  readonly spend: SpendReader;
  /**
   * The operator's price table, or absent for a deployment with none.
   *
   * Read per call rather than captured, which is the freshness `/v1/tools/call`
   * already has: a corrected price re-prices today's spend on the channel's next
   * question exactly as it does on its next call.
   */
  readonly prices?: PriceTableStore;
  readonly logger: Logger;
}

export function createBudgetRoute(options: BudgetRouteOptions): RouteHandler {
  return async (ctx: RequestContext): Promise<RouteResponse> => {
    // The channel is `ctx.channel` and nothing else — it came from the client
    // certificate, and this route reads no body at all.
    const [state, spend] = await Promise.all([
      options.sheets.resolve(ctx.channel),
      options.spend.read(ctx.channel)
    ]);

    // Outside the `Promise.all` for the reason `/v1/tools/call` keeps it
    // outside: a sheet resolve is per channel and may touch disk, where this is
    // one in-memory object for the whole process.
    const refusal = exhaustedLimitFromState(state, spend, options.prices?.current() ?? NO_PRICES);

    const status: BudgetStatus =
      refusal === null ? { spendable: true } : { spendable: false, refusal };

    // The reason code and never a figure. What the channel has spent is the
    // operator's to read through the budget CLI; this line exists so an operator
    // asking why a channel stopped summarizing has an answer.
    options.logger.log("info", {
      event: "budget_read",
      channel: ctx.channel,
      ...(refusal === null ? {} : { reason: refusal.reason })
    });

    return { status: 200, body: status };
  };
}
