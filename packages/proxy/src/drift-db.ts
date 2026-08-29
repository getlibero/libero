// The price-drift record's file on disk: opening it, its schema, and every
// statement run against it (#239).
//
// **Every SQL string that runs against this file lives here**, which is
// ./budget-db.ts's rule and the reason a second database is allowed at all: one
// module per database, all of its statements on one screen, so what each one is
// scoped to is checkable by reading rather than by grepping.
//
// ## What is recorded, and why it is not a meter
//
// Two figures price the same call. The proxy computes one from the token counts
// the agent reported and the operator's price table, and that is the figure
// `daily_usd` enforces on. A router — a LiteLLM the operator runs, or the
// sidecar the compose file starts — computes the other from its own price map
// and reports it on the response. When they disagree persistently, the
// operator's table has gone stale, and this file is what makes that visible
// before the provider's invoice is.
//
// **Nothing here is ever read on the enforcement path.** No route consults it,
// `./enforce.ts` does not import it, and the serving interface (`DriftRecorder`)
// has one method, which writes. A drift figure that could refuse a call would
// move enforcement onto a number a gateway computed, which is the invariant the
// whole design hangs on — #239 says this must never enforce and the shape is
// what keeps it so, rather than a comment asking nicely.
//
// ## Why a file of its own, beside the meter rather than inside it
//
// `budget reset` exists to make a hard limit soft again, and it discards
// counters. Drift is the opposite kind of fact: an observation accumulated over
// weeks, whose whole value is that it outlives the day it was made in. Keeping
// it in the meter's file would make its survival a property of what
// `clearDay` happens to delete — a discipline a later reset command could break
// without noticing. A separate file makes it structural. This is
// ./attempts-db.ts's shape and its argument: a second concern, off the first
// one's tables, in its own optional file.
//
// ## Why the rows are aggregated, and why that loses nothing
//
// One row per `(day, channel, model)`, holding summed counts, a summed reported
// cost, and how many turns went into both. Not one row per turn.
//
// The comparison survives the summing exactly, because cost is **linear in the
// counts at a fixed price**: pricing the summed counts of a day's turns on one
// model gives precisely the sum of pricing each turn. `costMicroUsd` already
// sums four products and divides once for this reason, so aggregating here even
// removes a rounding step rather than adding one — a per-turn computed cost
// would truncate to micro-USD once per turn, and a nine-token embedding costs
// less than that.
//
// What it buys is a bounded file. Rows are days times channels times models,
// where per-turn rows would grow with traffic and need a retention policy this
// package deliberately does not have for the audit log either.
//
// ## What is deliberately not stored
//
// **The proxy's own computed cost.** It is derived at read time from the counts
// in the row and whatever the price table says *then* — the rule `PriceTable`
// already states: cost is never accumulated, it is computed fresh, so
// correcting a mistyped price re-prices what is already recorded. A drift
// record that stamped the computed figure at write time would keep showing an
// operator the drift they have already fixed.
//
// **Turns that reported no cost.** A gateway that cannot price a model sends no
// figure, and a direct provider call sends none either. Recording those as zero
// would manufacture a total that reads as "the gateway says this was free", and
// the whole signal here is that absent and zero are different statements. A turn
// with no reported cost is simply not part of the comparison; it is metered
// exactly as it always was.
//
// **Turns that named no model.** There is nothing to compare a figure against
// without one — no price table row can be looked up — so a report carrying a
// cost and no model records nothing here. The meter still counts it, under
// `(unreported)`, and that is the bucket whose remedy is to fix the agent.
//
// ## The channel column
//
// This table has one, for ./budget-db.ts's reason: what is in it belongs to the
// operator and is read by the operator, so aggregating across channels is the
// feature rather than the hazard. It is not channel content and no channel
// member can read it — the only surface it has is an operator command run inside
// the proxy's own container.

import { DatabaseSync } from "node:sqlite";
import type { TurnTokens } from "./budget-db.js";
import type { Logger } from "./log.js";

/**
 * The schema version this build writes.
 *
 * Version 1 and no migration path yet, deliberately: an unrecognised version
 * refuses to start, exactly as the meter's does. What that costs here is
 * smaller than what it costs there — this file holds observations rather than
 * counters — but a build that silently wrote a shape it did not understand
 * would be the same bug.
 */
export const DRIFT_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_drift (
  day                TEXT    NOT NULL,
  channel            TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  turns              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reported_nano_usd  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel, model)
) WITHOUT ROWID;
`;

/** One turn's contribution: the counts that were metered and what a gateway charged for them. */
export interface ReportedCost {
  readonly model: string;
  readonly usage: TurnTokens;
  /** Nano-USD, as `SpendReport.costNanoUsd` carries it. Zero means priced and free. */
  readonly costNanoUsd: number;
}

/**
 * The serving interface: one method, and it writes.
 *
 * ./spend-route.ts closes over this and nothing wider, exactly as it closes over
 * `TokenRecorder` rather than `SpendMeter`. There is no read here to be tempted
 * into a decision with, which is the structural half of "this never gates a
 * call".
 */
export interface DriftRecorder {
  /**
   * Add one turn's reported cost to its day's row.
   *
   * `day` comes from the meter's answer rather than from a clock of this
   * module's own, so the drift row and the counters it is compared against can
   * never disagree about which day a report landed in.
   *
   * Never throws on a write it cannot make: a failed observation must not fail
   * a spend report, because the report carries the token counts a runaway loop
   * is caught by and the observation carries nothing anyone is waiting on.
   */
  recordReported(channel: string, day: string, cost: ReportedCost): void;
}

/** One aggregated row, as the operator's command reads it. */
export interface DriftRow {
  readonly day: string;
  readonly channel: string;
  readonly model: string;
  readonly turns: number;
  readonly usage: TurnTokens;
  /** Nano-USD, summed. BigInt for the reason `readAll` gives. */
  readonly reportedNanoUsd: bigint;
}

export interface DriftDb extends DriftRecorder {
  /**
   * Every row, oldest day first. The operator path — nothing serving calls this.
   *
   * Unfiltered and cross-channel on purpose: the question this file answers is
   * "which of my prices look wrong, and since when", which is a question about
   * the deployment. Narrowing belongs to the command that formats the answer.
   */
  readAll(): readonly DriftRow[];
  close(): void;
}

export interface DriftDbOptions {
  /** The database file. Its directory must exist and be writable. */
  readonly file: string;
  readonly logger?: Logger;
}

export function openDriftDb(options: DriftDbOptions): DriftDb {
  const { file, logger } = options;

  // No mkdir, for ./budget-db.ts's reason: a file invented under a path nobody
  // meant is an observation nobody will ever read, discovered when it is needed.
  const db = new DatabaseSync(file);

  try {
    db.exec("PRAGMA journal_mode = WAL");
    // NORMAL rather than the meter's FULL, and this is the one place the two
    // differ. A lost commit in the meter is lost spend, which fails open on a
    // limit; a lost commit here is one turn missing from a comparison drawn over
    // thousands. Paying an fsync per spend report to make an observation
    // crash-proof would be buying the wrong thing.
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    migrate(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    add: db.prepare(
      `INSERT INTO price_drift
         (day, channel, model, turns, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reported_nano_usd)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (day, channel, model) DO UPDATE SET
           turns              = turns              + 1,
           input_tokens       = input_tokens       + excluded.input_tokens,
           output_tokens      = output_tokens      + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           reported_nano_usd  = reported_nano_usd  + excluded.reported_nano_usd`
    ),
    // Ordered, so two runs of the operator's command over an unchanged file
    // print the same thing in the same order — rows that move between runs read
    // as data changing when nothing did.
    readAll: db.prepare(
      `SELECT day, channel, model, turns, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, reported_nano_usd
         FROM price_drift ORDER BY day, model, channel`
    )
  };

  // **BigInt on the way out, and not as a flourish.** `node:sqlite` throws
  // rather than rounding when an INTEGER column does not fit a JS number, and a
  // sum of nano-USD is the one column here that could get there on a large
  // enough deployment. A read that throws is a command that stops working
  // exactly when the deployment it is reporting on got big.
  statements.readAll.setReadBigInts(true);

  return {
    recordReported(channel: string, day: string, cost: ReportedCost): void {
      try {
        statements.add.run(
          day,
          channel,
          cost.model,
          cost.usage.inputTokens,
          cost.usage.outputTokens,
          cost.usage.cacheReadTokens,
          cost.usage.cacheWriteTokens,
          cost.costNanoUsd
        );
      } catch (error) {
        // Swallowed and said out loud, which is the contract above. The spend
        // report this rode in on has already moved the meter, and failing it
        // now would turn a lost observation into lost token counts.
        logger?.log("error", {
          event: "drift_record_failed",
          channel,
          reason: error instanceof Error ? error.name : "unknown"
        });
      }
    },

    readAll(): readonly DriftRow[] {
      return statements.readAll.all().map(row => {
        const number = (column: string): number => Number(row[column] as bigint);
        return {
          day: String(row["day"]),
          channel: String(row["channel"]),
          model: String(row["model"]),
          turns: number("turns"),
          usage: {
            inputTokens: number("input_tokens"),
            outputTokens: number("output_tokens"),
            cacheReadTokens: number("cache_read_tokens"),
            cacheWriteTokens: number("cache_write_tokens")
          },
          reportedNanoUsd: row["reported_nano_usd"] as bigint
        };
      });
    },

    close(): void {
      db.close();
    }
  };
}

/**
 * Bring the file to the version this build writes, or refuse to start.
 *
 * ./budget-db.ts's `migrate` in miniature: `db.exec(SCHEMA)` and the version
 * stamp are two commits, so a file created by a build that died between them is
 * a real state, and an unstamped file whose tables already exist is stamped
 * rather than rejected.
 */
function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  if (row !== undefined && row.version === DRIFT_SCHEMA_VERSION) return;
  if (row === undefined) {
    db.exec(`INSERT INTO schema_version (version) VALUES (${DRIFT_SCHEMA_VERSION})`);
    return;
  }
  throw new Error(
    `proxy drift: ${file} is schema version ${row.version}, and this build writes ` +
      `version ${DRIFT_SCHEMA_VERSION} with no migration from ${row.version}`
  );
}
