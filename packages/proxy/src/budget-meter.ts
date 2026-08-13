// The budget meter: the `SpendMeter` the server reads before every call and
// writes after every commitment to serve one.
//
// Accounting, and only accounting. It counts, persists, and rolls over; it does
// not decide anything. What a cached token is worth and which limit is spent
// are read off the channel's team sheet in ./enforce.ts, which is where policy
// lives — so this file has no team sheet, no limits, and no verdict to return.
// The two halves are legible apart on purpose: a meter that could refuse a call
// would be a second enforcement point nobody is looking at.

import { NO_SPEND, openBudgetDb, utcDay } from "./budget-db.js";
import type { BudgetDb } from "./budget-db.js";
import type { SpendMeter, SpendRecord } from "./dispatch.js";
import type { BudgetSpend } from "./enforce.js";
import type { Logger } from "./log.js";
import { UNREPORTED_MODEL } from "@getlibero/schema";
import type { BudgetLimit, TokenUsageReport } from "@getlibero/schema";

/**
 * How long a reported turn id is remembered.
 *
 * The table exists to defeat *retries*, whose useful life is seconds — but a
 * retry after a network partition or an agent restart can be hours late, and
 * the report is only idempotent while its key survives. Two days is generous
 * enough to cover that and short enough to bound the table at two days of
 * turns rather than every turn ever reported.
 */
export const TURN_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface SpendMeterOptions {
  readonly db: BudgetDb;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * The meter over an open budget database.
 *
 * **Nothing is cached.** Every `read` is a primary-key probe on a table holding
 * five integers per channel per day, and that cost buys the property the
 * operator reset rests on: a second process clearing a row is visible to the
 * next call, so a reset needs no restart and no signal. A cache here would make
 * `libero budget reset` a lie until the process bounced.
 *
 * `now` is injected so the day boundary can be tested without waiting for one.
 */
export function createSqliteSpendMeter(options: SpendMeterOptions): SpendMeter {
  const { db, logger } = options;
  const now = options.now ?? (() => Date.now());

  // Pruning is opportunistic and runs at most once per process per UTC day.
  // A timer would hold the event loop open and would have to be cleared on
  // shutdown; the write path already runs whenever there is anything to prune.
  let lastPrunedDay: string | undefined;

  const prune = (today: string): void => {
    if (lastPrunedDay === today) return;
    lastPrunedDay = today;
    const removed = db.pruneTurnReportsBefore(now() - TURN_RETENTION_MS);
    if (removed > 0) {
      logger?.log("info", { event: "turn_reports_pruned", count: removed });
    }
  };

  return {
    read(channel: string): BudgetSpend {
      return db.readSpend(channel, utcDay(now()));
    },

    recordToolCall(channel: string): void {
      db.addToolCall(channel, utcDay(now()));
    },

    claimWarning(channel: string, limit: BudgetLimit): boolean {
      // The day the *warning* belongs to is the day the spend belongs to, read
      // from the same clock at the moment of the call. A channel that crosses
      // its threshold at 23:59 and again at 00:01 is two days and two warnings,
      // which is the rollover the counters already have.
      return db.claimWarning(channel, utcDay(now()), limit);
    },

    recordTokens(channel: string, turn: string, usage: TokenUsageReport, model?: string): SpendRecord {
      const at = now();
      const today = utcDay(at);
      // **Naming a bucket, not deciding anything.** A report that named no model
      // is metered under a reserved id no price table can answer, so a channel
      // capped in dollars is refused on its next call rather than metered at
      // zero — but that refusal is `enforce.ts`'s, made from the sheet, exactly
      // like every other. Nothing here reads a sheet or knows what `daily_usd`
      // is; this line picks which row the counts land in. See
      // `UNREPORTED_MODEL` in @getlibero/schema for why absent must not be
      // spelled the same way as the migration's `(legacy)`.
      const recorded = db.addTurnTokens(channel, today, turn, at, model ?? UNREPORTED_MODEL, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheWriteTokens: usage.cacheCreationInputTokens
      });
      prune(today);
      return { outcome: recorded ? "recorded" : "duplicate" };
    }
  };
}

/**
 * Open the file and return a meter over it, for a composition root that has no
 * other use for the handle.
 *
 * The handle is still returned, because it has to be closed on shutdown and
 * because the operator paths in ./budget-admin.ts take one.
 */
export function openSpendMeter(options: {
  readonly file: string;
  readonly now?: () => number;
  readonly logger?: Logger;
}): { readonly meter: SpendMeter; readonly db: BudgetDb } {
  const { file, logger } = options;
  const db = openBudgetDb({ file, ...(logger !== undefined ? { logger } : {}) });
  const meter = createSqliteSpendMeter({
    db,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(logger !== undefined ? { logger } : {})
  });
  return { meter, db };
}

export { NO_SPEND };
