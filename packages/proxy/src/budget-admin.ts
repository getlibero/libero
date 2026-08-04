// The budget meter — the operator's paths.
//
// Apart from ./budget-meter.ts so that file's import list can be read as a
// claim: the process that serves tool calls counts spend and never clears it.
// Only the operator's entrypoint reaches this module.
//
// That separation is not tidiness. A reset makes a hard limit soft again, so it
// is the one verb on this data that must not sit on the listener the agent
// talks to — `daily_tool_calls` holding under compromise of the agent process
// is the whole reason it is worth having, and a compromised agent that could
// reset its own budget would hold nothing. The proxy has no admin principal by
// design: identity is `CN=channel:<id>` and nothing else. So the operator runs
// a second process against the same file, and WAL plus an uncached meter make
// that take effect on the proxy's next call, with no restart and no signal.

import { utcDay } from "./budget-db.js";
import type { BudgetDb, DailySpend } from "./budget-db.js";

/**
 * Clear a channel's counters for a day, defaulting to today.
 *
 * Today, because that is the day a hard limit is biting on. Yesterday is
 * history and the operator did not ask for it to be rewritten.
 *
 * The turn ids for that day go with it. Clearing the counters and leaving the
 * ids behind would let a retry of an already-counted turn re-spend the budget
 * that was just reset — an operator would clear a channel and watch it refill
 * from nothing.
 */
export function resetChannel(db: BudgetDb, channel: string, nowMs: number = Date.now()): string {
  const day = utcDay(nowMs);
  db.clearDay(channel, day);
  return day;
}

/** What a channel has spent on a day. Read-only; the operator's `show`. */
export function readChannelSpend(
  db: BudgetDb,
  channel: string,
  nowMs: number = Date.now()
): { readonly day: string; readonly spend: DailySpend } {
  const day = utcDay(nowMs);
  return { day, spend: db.readSpend(channel, day) };
}

/** Which days this channel has any recorded spend on, oldest first. */
export function channelDays(db: BudgetDb, channel: string): readonly string[] {
  return db.daysWithSpend(channel);
}

/**
 * Drop reported turn ids older than the window, everywhere.
 *
 * The meter does this opportunistically as it writes. This is the same sweep
 * for an operator with a file that has been sitting idle — a channel that
 * stopped reporting stops pruning, and its ids would otherwise stay forever.
 */
export function pruneTurnReports(db: BudgetDb, olderThanMs: number): number {
  return db.pruneTurnReportsBefore(olderThanMs);
}
