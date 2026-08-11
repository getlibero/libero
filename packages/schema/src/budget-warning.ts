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
     * Fractional for `daily_tokens` and only for it: cache reads and writes are
     * weighted by the sheet's ratios before they are compared, so a channel's
     * billable total is a real number rather than a count. Rounded where it is
     * worded, never here — the shape keeps what was measured.
     *
     * It is the position *before* the call it rides on, because that is the
     * number the decision was made against. A reader who adds one is not wrong.
     */
    spent: z.number().nonnegative(),
    /**
     * The hard limit this is measured against — `daily_tokens` or
     * `daily_tool_calls` out of the live sheet.
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
  const spent = format(warning.spent);
  const cap = format(warning.cap);
  return warning.limit === "daily_tokens"
    ? `Budget: this channel has spent ${spent} of its ${cap} daily tokens. Calls run until it reaches the limit.`
    : `Budget: this channel has made ${spent} of its ${cap} daily tool calls. Calls run until it reaches the limit.`;
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
