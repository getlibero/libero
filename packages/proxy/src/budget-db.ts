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
//   - Every write is `x = x + n`. There is no decrement in this file.
//   - The server's whole surface on the meter is `read`, `recordToolCall`,
//     `recordTokens` (see `SpendMeter` in ./dispatch.js). Clearing a counter
//     lives in ./budget-admin.ts, which nothing in the server imports.
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
// It is unflagged from Node 22.13, which is the floor this repo now states, and
// still stability 1.1: the API may move, and the whole surface used here is
// `DatabaseSync`, `prepare`, `run`, `get`, `all`, and `exec`.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
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

/** The counters for one channel on one day. Raw counts; no weighting here. */
export interface DailySpend {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const NO_SPEND: DailySpend = {
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
};

/**
 * The schema version this build writes.
 *
 * Checked at open, and a file from the future is a startup failure rather than
 * something to work around. A proxy rolled back onto a newer file would
 * otherwise write rows the newer build cannot read, or read columns that have
 * moved — and the symptom of either is a wrong number in a budget, which is
 * exactly the failure that goes unnoticed until a bill.
 */
export const BUDGET_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_spend (
  channel            TEXT    NOT NULL,
  day                TEXT    NOT NULL,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS turn_report (
  channel TEXT    NOT NULL,
  turn    TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (channel, turn)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS turn_report_at ON turn_report (at);
`;

/** A row of `channel_spend`, as SQLite hands it back. */
interface SpendRow {
  readonly tool_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

function toDailySpend(row: SpendRow | undefined): DailySpend {
  if (row === undefined) return NO_SPEND;
  return {
    toolCalls: row.tool_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens
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
  addTurnTokens(channel: string, day: string, turn: string, atMs: number, usage: TurnTokens): boolean;
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
    checkVersion(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    read: db.prepare(
      `SELECT tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM channel_spend WHERE channel = ? AND day = ?`
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
      `INSERT INTO channel_spend
         (channel, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, day) DO UPDATE SET
           input_tokens       = input_tokens       + excluded.input_tokens,
           output_tokens      = output_tokens      + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`
    ),
    clearSpend: db.prepare(`DELETE FROM channel_spend WHERE channel = ? AND day = ?`),
    clearTurns: db.prepare(`DELETE FROM turn_report WHERE channel = ? AND day = ?`),
    days: db.prepare(`SELECT day FROM channel_spend WHERE channel = ? ORDER BY day`),
    // The one statement in this file with no `WHERE channel = ?`, on purpose:
    // it expires retry-dedupe rows by age alone and never touches
    // channel_spend, so no channel's counters can move through it. Anything
    // new that crosses channels belongs on the operator path, not here.
    prune: db.prepare(`DELETE FROM turn_report WHERE at < ?`)
  } satisfies Record<string, StatementSync>;

  logger?.log("info", { event: "budget_opened", file });

  return {
    readSpend(channel, day) {
      return toDailySpend(statements.read.get(channel, day) as SpendRow | undefined);
    },

    addToolCall(channel, day) {
      statements.addCall.run(channel, day);
    },

    addTurnTokens(channel, day, turn, atMs, usage) {
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

    clearDay(channel, day) {
      // Both tables, in one transaction. Clearing the counters and leaving this
      // channel's turn ids behind would let a retry of an already-counted turn
      // re-spend a budget that was just reset.
      db.exec("BEGIN IMMEDIATE");
      try {
        statements.clearSpend.run(channel, day);
        statements.clearTurns.run(channel, day);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    daysWithSpend(channel) {
      return (statements.days.all(channel) as { day: string }[]).map(row => row.day);
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
 * Read the version, or claim the file if it has none.
 *
 * A file with no row is either brand new or one this build just created, and
 * both are ours to stamp. A row we do not recognise is not: refusing to start
 * is the only answer that cannot corrupt a counter.
 */
function checkVersion(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(BUDGET_SCHEMA_VERSION);
    return;
  }
  if (row.version !== BUDGET_SCHEMA_VERSION) {
    throw new Error(
      `proxy budget: ${file} is schema version ${row.version}, and this build writes ` +
        `version ${BUDGET_SCHEMA_VERSION}`
    );
  }
}
