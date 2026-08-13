// The budget meter's file on disk: opening it, its schema, and every statement
// run against it.
//
// **Every SQL string that runs against this file lives here**, and the same
// holds for the audit log in ./audit-db.ts: one module per database, and no
// statements anywhere else in the package. That is the compensation for keeping
// all channels in one file rather than one file each. The isolation property — a
// channel never sees another channel's counters — rests on each statement
// carrying `WHERE channel = ?`, and confining them to one module is what makes
// that claim checkable by reading one screen instead of grepping a package. A
// second database does not weaken it as long as its statements are all on one
// screen too. A statement added anywhere else is a review failure.
//
// CLAUDE.md's one-file-per-channel invariant is narrowed rather than broken,
// and the line is about **whose data it is and who reads it**, not about how
// much of it there is.
//
// Channel content — messages, memory — belongs to that channel's members and is
// read on their behalf. A cross-channel join there is one channel's members
// seeing another's conversation, so the layout has to make it impossible and
// the file split is the mechanism.
//
// Spend belongs to the operator and is read by the operator. Cross-channel
// aggregation is not a hazard to be designed out; it is a feature this data
// exists for — a platform or finance team asking how a workspace is tracking
// against its caps needs exactly the query the per-file layout would forbid.
// Building that on N files would mean opening N handles to reassemble something
// that was one table all along. (The same argument covers the audit log, which
// is now built the same way: one table with a channel column, in ./audit-db.ts.
// What is *not* shared is the write discipline — this file's statements are
// `x = x + n` and the operator may clear a day, while that one only ever
// inserts and a trigger refuses anything else.)
//
// What has to hold instead is that **the people who live in the channels cannot
// manipulate the numbers**, and that is structural here:
//
//   - The channel comes from the client certificate, so an agent can only ever
//     write its own row. No request body names a channel.
//   - Every write to a counter is `x = x + n`. There is no decrement in this
//     file. (`claimWarning` writes no counter — it takes a marker, which is why
//     it can sit on the serving interface beside the increments.)
//   - The server's whole surface on the meter is `read`, `recordToolCall`,
//     `recordTokens`, `claimWarning` (see `SpendMeter` in ./dispatch.js).
//     Clearing a counter lives in ./budget-admin.ts, which nothing in the server
//     imports.
//
// So the worst a prompt-injected channel member can do is spend more of their
// own channel's budget, which is the limit doing its job.
//
// **The forward rule, while it is still cheap to state:** an aggregate read —
// spend across channels, progress against caps for a workspace — belongs on the
// operator path in ./budget-admin.ts. It must never appear on the interface the
// server closes over. Reading one channel is a serving concern; reading all of
// them is an operator concern, and the two must not share a method.
//
// `node:sqlite` rather than a driver from npm. It is built in, so the proxy
// gains no dependency and the license gate has nothing new to check — and this
// package's dependency list is itself a security property (see ./server.ts).
// It is unflagged from Node 22.13, which was this repo's floor when the meter
// landed; the floor is now Node 24, moved for `packages/memory`, whose FTS5
// index `node:sqlite` could not create before 22.16. It is a release candidate
// from 24.15 and experimental below that: the API may still move, and the whole
// surface used here is `DatabaseSync`, `prepare`, `run`, `get`, `all`, `exec`.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { LEGACY_MODEL } from "@getlibero/schema";
import type { Logger } from "./log.js";

/**
 * The day a counter belongs to: the UTC calendar date, `YYYY-MM-DD`.
 *
 * This function is the entire rollover mechanism. Nothing sweeps at midnight
 * and nothing resets at process start — a new day is simply a key that has
 * never been written, so it reads as zero, and yesterday's row stays where it
 * is. That is also why rollover survives a restart: it is a property of the
 * clock, not of anything the process remembers.
 *
 * UTC, not local time. A deployment whose day boundary moved with the host's
 * timezone would roll over twice or not at all when that host changed zones,
 * and two operators reading the same numbers would disagree about which day
 * they were looking at.
 */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * One model's tokens, for one channel on one day.
 *
 * The dimension #62 added. What a token *costs* depends on which model spent it,
 * and under a router that is not knowable from the team sheet — so the meter
 * records it beside the counts and the price table joins them at decision time.
 *
 * `model` is whatever the provider echoed back, or one of the two ids this
 * module writes itself (`LEGACY_MODEL`, `UNREPORTED_MODEL` in
 * @getlibero/schema). It is a **dimension of a count and never a permission**:
 * it selects a price and nothing else.
 */
export interface ModelSpend {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * The counters for one channel on one day. Raw counts; no weighting here.
 *
 * **The four totals and `byModel` are the same rows, asked two ways**, and the
 * totals are summed from the buckets rather than stored beside them — so there
 * is one number on disk and no pair that can drift. Two limits ask two
 * questions: `daily_tokens` weighs the day's tokens by the sheet's cache ratios
 * and does not care what spent them, and `daily_usd` has to know, because that
 * is the whole difference between the two units.
 *
 * The totals stay flat rather than making every caller fold `byModel` because
 * the token limit is unchanged by any of this, and a shape that forced its
 * arithmetic to be rewritten would be inviting a behaviour change into a
 * feature that is not supposed to have one.
 */
export interface DailySpend {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly byModel: readonly ModelSpend[];
}

export const NO_SPEND: DailySpend = {
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  byModel: []
};

/**
 * The schema version this build writes.
 *
 * Checked at open, and a file from the future is a startup failure rather than
 * something to work around. A proxy rolled back onto a newer file would
 * otherwise write rows the newer build cannot read, or read columns that have
 * moved — and the symptom of either is a wrong number in a budget, which is
 * exactly the failure that goes unnoticed until a bill.
 *
 * **`budget_warning` arrived without a bump** (#99), on the argument that added
 * the `message_thread` index in packages/memory without one: what this number
 * guards is the shape of the *counters*, because a wrong number in a budget is
 * the failure worth refusing to start over. That table holds no count and no
 * column of one. A build without it reads and writes every counter identically
 * and simply never warns; a build with it creates the table on open, since the
 * schema runs before this check. Neither direction can produce a wrong number,
 * so neither is worth an operator's outage.
 *
 * **Version 2 moved the token counts into their own table, keyed by model**
 * (#62), and that precedent explicitly does not apply: the columns it moved are
 * counters, which is precisely what this number guards. It is also the version
 * that gave this file a migration at all — until it, `checkVersion` could only
 * stamp or refuse, so a shape change had no way forward that did not go through
 * an operator deleting their spend.
 *
 * Unlike the audit log's versions, this one is a **data move rather than a
 * widening**, so "what happens to a row that fails" needs its own answer: none
 * can. Every v1 row maps to exactly one `channel_spend` row and at most one
 * `channel_token_spend` row, by a total function with no constraint to violate.
 * Check that again before adding a version 3.
 */
export const BUDGET_SCHEMA_VERSION = 2;

/**
 * The two spend tables, parameterised on their names.
 *
 * One source for each, for `auditTableDdl`'s reason: `rebuildBudgetTables` has
 * to build tables *identical* to the ones a fresh file gets and rename them into
 * place, and two copies of these columns would agree the day they were written
 * and drift on some later one. There is a test that opens a created file and a
 * migrated one and compares what SQLite says the tables are.
 *
 * **They are two tables because a tool call has no model.** Keying one table on
 * `(channel, day, model)` would force `addToolCall` to invent one, and the row
 * it invented would carry a real tool-call count with zeroed token columns — one
 * key meaning two different things. The split also says something worth being
 * able to read off the schema: `daily_tool_calls` is the limit that holds under
 * full compromise of the agent process, and nothing #62 added touches its table.
 *
 * The argument is always a module-private literal. It is never input, and it
 * cannot be: nothing outside this file can call these.
 */
const channelSpendDdl = (table: string, ifNotExists: boolean): string => `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  channel    TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, day)
) WITHOUT ROWID`;

const tokenSpendDdl = (table: string, ifNotExists: boolean): string => `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  channel            TEXT    NOT NULL,
  day                TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, day, model)
) WITHOUT ROWID`;

/**
 * What a file must have before `migrate` can look at it.
 *
 * `turn_report` and `budget_warning` are unchanged across both versions and
 * carry no column the migration touches, so they and the one index sit here
 * rather than being deferred the way the audit log's are — there is no version
 * on which creating them would fail.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

${channelSpendDdl("channel_spend", true)};

${tokenSpendDdl("channel_token_spend", true)};

CREATE TABLE IF NOT EXISTS turn_report (
  channel TEXT    NOT NULL,
  turn    TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (channel, turn)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS budget_warning (
  channel      TEXT NOT NULL,
  day          TEXT NOT NULL,
  budget_limit TEXT NOT NULL,
  PRIMARY KEY (channel, day, budget_limit)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS turn_report_at ON turn_report (at);
`;

/**
 * A row of `channel_token_spend`, as SQLite hands it back.
 *
 * Indexed rather than declared as named properties, because `all()` is typed as
 * a bag of `SQLOutputValue` and a direct assertion to a named shape is one TS
 * refuses without a detour through `unknown` — which would assert more than this
 * module knows. The column list is three lines above the read.
 */
type TokenRow = Record<string, unknown>;

const count = (row: TokenRow, column: string): number => (row[column] as number | undefined) ?? 0;

/**
 * The day's counters, from the two rows sets that hold them.
 *
 * The four totals are summed here, from the same buckets that are handed back —
 * so they are a projection of what is being returned rather than a second read
 * that could disagree with it. Nothing on disk holds a total.
 */
function toDailySpend(toolCalls: number, rows: readonly TokenRow[]): DailySpend {
  const byModel = rows.map(row => ({
    model: String(row["model"]),
    inputTokens: count(row, "input_tokens"),
    outputTokens: count(row, "output_tokens"),
    cacheReadTokens: count(row, "cache_read_tokens"),
    cacheWriteTokens: count(row, "cache_write_tokens")
  }));

  return {
    toolCalls,
    inputTokens: byModel.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
    outputTokens: byModel.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
    cacheReadTokens: byModel.reduce((sum, bucket) => sum + bucket.cacheReadTokens, 0),
    cacheWriteTokens: byModel.reduce((sum, bucket) => sum + bucket.cacheWriteTokens, 0),
    byModel
  };
}

export interface BudgetDbOptions {
  /** The database file. Its directory must exist and be writable. */
  readonly file: string;
  readonly logger?: Logger;
}

/**
 * The open database, as a set of named operations rather than a handle.
 *
 * A handle would let a caller `prepare` its own statement, and the one thing
 * this module is for is that nobody does. Every method below takes a channel
 * and every statement behind it is scoped to that channel.
 */
export interface BudgetDb {
  readSpend(channel: string, day: string): DailySpend;
  addToolCall(channel: string, day: string): void;
  /**
   * Record a turn's tokens once.
   *
   * Returns false if this channel has already reported this turn — the answer a
   * retry should get. The dedupe insert and the counter update are one
   * transaction: a crash between them would leave the turn marked as counted
   * with its tokens never added, which is spend lost in silence.
   */
  addTurnTokens(
    channel: string,
    day: string,
    turn: string,
    atMs: number,
    model: string,
    usage: TurnTokens
  ): boolean;
  /**
   * Take this channel's one warning for this limit today, if it is still there.
   *
   * Returns true to the caller that took it and false to everyone after,
   * which is what makes "once per channel per day" hold under concurrency: two
   * calls that both cross the threshold race on an insert rather than on a
   * read-then-write, and exactly one wins. Same mechanism as `claimTurn` above
   * and the same reason — an `ON CONFLICT DO NOTHING` and its `changes` count.
   *
   * A row per limit rather than per channel. The two limits are two facts, a
   * channel told about its tokens has not been told about its tool calls, and
   * the bound this exists to keep is "not forty warnings" rather than "exactly
   * one" — two in a day is still a warning somebody reads.
   *
   * It moves no counter, which is why it is safe on the serving interface at
   * all: the worst a channel can do by provoking it is spend its own warning.
   */
  claimWarning(channel: string, day: string, limit: string): boolean;
  /** Operator paths. See ./budget-admin.ts — nothing in the server calls these. */
  clearDay(channel: string, day: string): void;
  daysWithSpend(channel: string): readonly string[];
  pruneTurnReportsBefore(atMs: number): number;
  close(): void;
}

/** What one turn cost, in raw counts, named as the meter's columns name them. */
export interface TurnTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export function openBudgetDb(options: BudgetDbOptions): BudgetDb {
  const { file, logger } = options;

  // No mkdir. A budget file that the proxy invented under a path nobody meant
  // is a channel with a permanently fresh budget — the failure that fails
  // *open*, silently, at the far end of a Slack thread. A missing directory is
  // a misconfiguration and says so here, at startup, with the path named.
  const db = new DatabaseSync(file);

  try {
    // WAL because the operator's reset runs as a second process on this file
    // and must not block a proxy that is serving. It also means SQLite writes
    // `-wal` and `-shm` beside the file, so the *directory* has to be writable.
    db.exec("PRAGMA journal_mode = WAL");
    // FULL, not NORMAL. Under WAL, NORMAL survives a process crash but can lose
    // the last commits on a host crash — and a lost commit is lost spend, which
    // is the permissive direction. One fsync per served tool call sits behind
    // an upstream HTTP call two orders of magnitude slower. It is also what
    // makes a hard kill safe without closing the database: everything committed
    // is already on disk.
    db.exec("PRAGMA synchronous = FULL");
    // The reset process holds the write lock for microseconds. Waiting is the
    // right answer; SQLITE_BUSY back to a serving request is not.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    migrate(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    readCalls: db.prepare(`SELECT tool_calls FROM channel_spend WHERE channel = ? AND day = ?`),
    // Ordered, so that two processes reading one day agree on the order of the
    // buckets. Nothing depends on which order, only that it is not the file's
    // insertion history — a `budget show` whose rows moved between runs reads
    // as data changing when nothing did.
    readTokens: db.prepare(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM channel_token_spend WHERE channel = ? AND day = ? ORDER BY model`
    ),
    addCall: db.prepare(
      `INSERT INTO channel_spend (channel, day, tool_calls) VALUES (?, ?, 1)
         ON CONFLICT (channel, day) DO UPDATE SET tool_calls = tool_calls + 1`
    ),
    claimTurn: db.prepare(
      `INSERT INTO turn_report (channel, turn, day, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (channel, turn) DO NOTHING`
    ),
    addTokens: db.prepare(
      `INSERT INTO channel_token_spend
         (channel, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, day, model) DO UPDATE SET
           input_tokens       = input_tokens       + excluded.input_tokens,
           output_tokens      = output_tokens      + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`
    ),
    claimWarning: db.prepare(
      `INSERT INTO budget_warning (channel, day, budget_limit) VALUES (?, ?, ?)
         ON CONFLICT (channel, day, budget_limit) DO NOTHING`
    ),
    clearSpend: db.prepare(`DELETE FROM channel_spend WHERE channel = ? AND day = ?`),
    clearTokens: db.prepare(`DELETE FROM channel_token_spend WHERE channel = ? AND day = ?`),
    clearTurns: db.prepare(`DELETE FROM turn_report WHERE channel = ? AND day = ?`),
    clearWarnings: db.prepare(`DELETE FROM budget_warning WHERE channel = ? AND day = ?`),
    // Both tables, because either can hold a day the other does not: a channel
    // whose turns all failed before a tool call has tokens and no calls, and one
    // whose agent never reported has calls and no tokens. A `budget show` that
    // missed such a day would report zero for a day with spend in it.
    days: db.prepare(
      `SELECT day FROM channel_spend WHERE channel = ?
         UNION
       SELECT day FROM channel_token_spend WHERE channel = ?
        ORDER BY day`
    ),
    // The one statement in this file with no `WHERE channel = ?`, on purpose:
    // it expires retry-dedupe rows by age alone and never touches
    // channel_spend, so no channel's counters can move through it. Anything
    // new that crosses channels belongs on the operator path, not here.
    prune: db.prepare(`DELETE FROM turn_report WHERE at < ?`)
  } satisfies Record<string, StatementSync>;

  logger?.log("info", { event: "budget_opened", file });

  return {
    readSpend(channel, day) {
      const calls = statements.readCalls.get(channel, day) as { tool_calls: number } | undefined;
      const tokens = statements.readTokens.all(channel, day) as TokenRow[];
      return toDailySpend(calls?.tool_calls ?? 0, tokens);
    },

    addToolCall(channel, day) {
      statements.addCall.run(channel, day);
    },

    addTurnTokens(channel, day, turn, atMs, model, usage) {
      // IMMEDIATE takes the write lock up front. Two concurrent reports that
      // both began as readers would otherwise deadlock upgrading it.
      db.exec("BEGIN IMMEDIATE");
      try {
        // Number(), because node:sqlite reports `changes` as a bigint once a
        // statement has been switched to big-int mode, and a `=== 0` that
        // silently stopped matching would turn every report into a duplicate.
        const claimed = statements.claimTurn.run(channel, turn, day, atMs);
        if (Number(claimed.changes) === 0) {
          db.exec("COMMIT");
          return false;
        }
        statements.addTokens.run(
          channel,
          day,
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    claimWarning(channel, day, limit) {
      // Number(), for `claimTurn`'s reason: `changes` is a bigint once the
      // statement has been switched to big-int mode, and a `=== 0` that quietly
      // stopped matching would make every warning look already-taken.
      return Number(statements.claimWarning.run(channel, day, limit).changes) === 1;
    },

    clearDay(channel, day) {
      // All four tables, in one transaction. Clearing the counters and leaving
      // this channel's turn ids behind would let a retry of an already-counted
      // turn re-spend a budget that was just reset; leaving the warning behind
      // would give the channel a reset day it cannot be warned about, which is
      // the same class of half-reset and the reason a reset re-arms rather than
      // merely re-zeroes. Since #62 the token counts are their own table, and
      // one cleared without the other is a channel reset in one unit and not
      // the other — which is the same half-reset one table down.
      db.exec("BEGIN IMMEDIATE");
      try {
        statements.clearSpend.run(channel, day);
        statements.clearTokens.run(channel, day);
        statements.clearTurns.run(channel, day);
        statements.clearWarnings.run(channel, day);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    daysWithSpend(channel) {
      return (statements.days.all(channel, channel) as { day: string }[]).map(row => row.day);
    },

    pruneTurnReportsBefore(atMs) {
      return Number(statements.prune.run(atMs).changes);
    },

    close() {
      db.close();
    }
  };
}

/**
 * Whether a table has this column, asked of SQLite rather than inferred.
 *
 * The same structural question `audit-db.ts` asks, for the same reason: the
 * rebuild reads the table's actual shape instead of trusting a version number,
 * so an operator who deleted the stamp from a file that has rows in it does not
 * get their token counts silently zeroed. `schema_version` carries no trigger,
 * so that is a thing they can do.
 *
 * The table name is a module-private literal at every call site and cannot be
 * input.
 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry["name"] === column);
}

/**
 * Rebuild the spend tables into the shape this build writes, keeping every count.
 *
 * One procedure rather than one per version pair, for `rebuildAuditTable`'s
 * reason: the DDL builders above are by construction the *current* tables, so a
 * ladder would need a frozen v1 literal beside them — the second copy of these
 * columns that their doc exists to prevent.
 *
 * **Where a v1 file's tokens go.** They were recorded before the meter knew what
 * spent them, so there is no honest model id to give them and inventing one
 * would be a price applied to spend that never met it. They go to
 * `LEGACY_MODEL`, which the price table answers at **zero** — `daily_usd` did
 * not exist when they were spent, so no sheet asked for them to be capped, and
 * charging them would refuse a channel on the morning after an upgrade for spend
 * its operator never opted into. They still count in full against `daily_tokens`,
 * which is the limit that *was* in force. The bucket can only carry rows dated on
 * or before this migration, so it ages out with one UTC day.
 *
 * **An all-zero v1 row produces no bucket.** The `WHERE` below is not an
 * optimisation: a channel that made tool calls and never reported a token would
 * otherwise gain a `(legacy)` row of four zeroes, which reads as "this channel
 * has unpriceable spend" to anything looking at the buckets, and is false.
 *
 * **No row can fail**, which is the property `BUDGET_SCHEMA_VERSION`'s doc asks
 * each version to establish for itself. Every v1 row maps to one `channel_spend`
 * row and at most one `channel_token_spend` row; there is no constraint for a
 * copied value to violate, because the destination's only new column is one this
 * procedure supplies. That is a weaker claim than the audit log's widenings and
 * had to be checked separately — this is a data move, not a relaxed CHECK.
 *
 * The scratch table is named for what it is rather than for a version, and for
 * the same reason `tool_call_audit_rebuilt` is.
 */
function rebuildBudgetTables(db: DatabaseSync): void {
  // Read before the transaction opens: a question about the tables as they
  // stand, whose answer decides whether there is anything to move.
  const carriesTokens = hasColumn(db, "channel_spend", "input_tokens");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(channelSpendDdl("channel_spend_rebuilt", false));
    db.exec(`
      INSERT INTO channel_spend_rebuilt (channel, day, tool_calls)
      SELECT channel, day, tool_calls FROM channel_spend
    `);
    // Already created by SCHEMA on every path that reaches here; stated again so
    // this procedure is complete on its own terms rather than depending on the
    // order two module-level constants happen to run in.
    db.exec(tokenSpendDdl("channel_token_spend", true));
    if (carriesTokens) {
      // Bound rather than interpolated. It is a module constant and not input,
      // so this is not a live injection — but every value in this file is bound
      // and an exception would be the one a later reader copies.
      db.prepare(
        `INSERT INTO channel_token_spend
           (channel, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         SELECT channel, day, ?,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM channel_spend
          WHERE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens > 0`
      ).run(LEGACY_MODEL);
    }
    db.exec("DROP TABLE channel_spend");
    db.exec("ALTER TABLE channel_spend_rebuilt RENAME TO channel_spend");
    db.exec("DELETE FROM schema_version");
    db.exec(`INSERT INTO schema_version (version) VALUES (${BUDGET_SCHEMA_VERSION})`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Bring the file to the version this build writes, or refuse to start.
 *
 * A version we do not recognise still means refusing to start — the rule this
 * file had before it had a migration at all, and the only answer that cannot
 * corrupt a counter.
 *
 * **The absent-row case runs the rebuild too**, for the reason `audit-db.ts`
 * gives: `db.exec(SCHEMA)` and the version stamp are two commits, so a process
 * that died between them left a file with an older table and no stamp, and
 * stamping that current without looking would leave v1 token columns sitting
 * beside an empty bucket table — every count still on disk and none of it
 * metered. On a file this build just created the rebuild copies zero rows and
 * costs a handful of DDL statements once, at startup.
 */
function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (row !== undefined && row.version === BUDGET_SCHEMA_VERSION) return;
  if (row === undefined || row.version === 1) {
    rebuildBudgetTables(db);
    return;
  }
  throw new Error(
    `proxy budget: ${file} is schema version ${row.version}, and this build writes ` +
      `version ${BUDGET_SCHEMA_VERSION} with no migration from ${row.version}`
  );
}
