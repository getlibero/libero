// The soft limit crossed: what a channel is told *before* its budget stops it.
//
// The counterpart to `budget_exhausted` in ./refusal.ts, and deliberately not a
// member of it. A refusal is an answer to a call — the call did not run — and
// this rides a call that did. Putting it in the refusal union would have made
// every consumer that switches on a reason handle a case where the tool also
// produced a result, which is not what that union means.
//
// **It carries no free-text field**, for the reason `ToolRefusal` carries none:
// every sentence a channel sees is written here, from facts the proxy observed,
// so nothing upstream and nothing the model wrote can reach a person through it.
// What it does carry is the channel's position — the spend and the cap — because
// "you are near your limit" without a number is a sentence nobody can act on,
// and the fraction alone would make a reader do the arithmetic the proxy has
// already done.

import { z } from "zod";
import { BudgetLimit } from "./refusal.js";

export const BudgetWarning = z
  .object({
    /** Which limit was crossed. The other may be nowhere near its own. */
    limit: BudgetLimit,
    /**
     * What this channel has spent today against that limit, as the meter's own
     * reading at the moment of the call.
     *
     * **Fractional for two of the three limits.** `daily_tokens` weights cache
     * reads and writes by the sheet's ratios before comparing, so a channel's
     * billable total is a real number rather than a count; `daily_usd` is
     * dollars, which are fractional by nature and are carried here as dollars
     * rather than as the micro-units the meter computes in. Only
     * `daily_tool_calls` is a whole number. Rounded where it is worded, never
     * here — the shape keeps what was measured.
     *
     * It is the position *before* the call it rides on, because that is the
     * number the decision was made against. A reader who adds one is not wrong.
     */
    spent: z.number().nonnegative(),
    /**
     * The hard limit this is measured against, out of the live sheet.
     *
     * Sent rather than assumed known, because the agent process has no
     * authoritative copy of the sheet: it reads one for its own caps and falls
     * back to defaults when it cannot, so a number it quoted from there could
     * disagree with the number the proxy enforced.
     */
    cap: z.number().positive()
  })
  .strict();

export type BudgetWarning = z.infer<typeof BudgetWarning>;

/**
 * The sentence to put in the channel.
 *
 * Total over the two limits, as `refusalMessage` is over its union, and for the
 * same reason: one wording, on both sides of the wire, so what a channel is told
 * cannot disagree with what the proxy decided.
 *
 * It says what runs next rather than what has run. A warning whose last clause
 * is about the past reads as an apology; the useful half is that the calls do
 * not stop yet and that they will.
 */
export function budgetWarningMessage(warning: BudgetWarning): string {
  switch (warning.limit) {
    case "daily_tokens":
      return `Budget: this channel has spent ${format(warning.spent)} of its ${format(warning.cap)} daily tokens. Calls run until it reaches the limit.`;
    case "daily_tool_calls":
      return `Budget: this channel has made ${format(warning.spent)} of its ${format(warning.cap)} daily tool calls. Calls run until it reaches the limit.`;
    case "daily_usd":
      return `Budget: this channel has spent ${money(warning.spent)} of its ${money(warning.cap)} daily budget. Calls run until it reaches the limit.`;
  }
}

/**
 * A count as a person reads it.
 *
 * The locale is pinned rather than taken from the host, because a budget line
 * whose separators depend on which machine the proxy runs on is a line two
 * operators cannot compare — and because every other sentence in this package
 * is English already. Rounded, because the weighted token total is fractional
 * and a tenth of a token is not a fact anyone needs.
 */
function format(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

/**
 * The same, for dollars (#62).
 *
 * A second formatter rather than a parameter on the first, because the rounding
 * rules are opposites and merging them would mean a flag deciding which. A token
 * count is rounded to whole units — a tenth of a token is not a fact anyone
 * needs — and money is not: `$0` for four cents of spend against a five-cent cap
 * would be a warning that reads as though nothing had been spent.
 *
 * Two fraction digits always, so `$18.40` does not print as `$18.4` and a column
 * of these lines aligns. The currency symbol is fixed rather than derived: the
 * price table is denominated in US dollars, so a line that inferred a currency
 * from a locale would be relabelling the same number.
 */
function money(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
