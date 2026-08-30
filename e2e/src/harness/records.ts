// What the proxy wrote down, read back from outside it.
//
// Both databases are opened by the *spawned* process, and both are read here
// while it is still running. That is safe rather than lucky: both are WAL with
// `busy_timeout = 5000` and commit with `synchronous = FULL`, so a row the proxy
// acknowledged is on disk and visible to another process's reader. Nothing has
// to be torn down before an assertion.
//
// The audit log is read with a raw handle rather than `openAuditDb`, because
// opening it properly runs the schema-version check and installs the
// append-only triggers. A reader should do neither — and the audit CLI (#98)
// reads it the same way, so this exercises that shape too.

import { DatabaseSync } from "node:sqlite";
import { CHAINED_COLUMNS, openBudgetDb, readChannelSpend } from "@getlibero/proxy";
import type { DailySpend } from "@getlibero/proxy";

/** One row of `tool_call_audit`, as the columns are named in audit-db.ts. */
export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly channel: string;
  readonly requesting_user: string;
  readonly task: string;
  readonly request_id: string;
  readonly call_id: string;
  readonly server: string;
  readonly tool: string;
  readonly arguments_sha256: string;
  readonly outcome: string;
  readonly refusal_reason: string | null;
  /**
   * #62. Which limit bound, the channel's running total at the moment of the
   * decision, and the price table that computed it — not what the call cost,
   * which is not a quantity. Null when nothing was priced.
   */
  readonly budget_limit: string | null;
  readonly day_spend_micro_usd: number | null;
  readonly price_version: string | null;
  readonly result_bytes: number | null;
  readonly result_is_error: number | null;
  readonly approver: string | null;
  readonly ticket: string | null;
  /**
   * The host a sandbox run was killed for reaching (#219). Null on every row
   * that is not an `egress_denied` refusal, which is almost all of them.
   */
  readonly destination: string | null;
  /**
   * What a served result was made of, by kind (#501): decoded bytes per block
   * type, as JSON, summing to `result_bytes`. Null on exactly the rows
   * `result_bytes` is null on.
   */
  readonly result_bytes_by_type: string | null;
  /**
   * #354. The chain. `prev_hash` is the previous row's `row_hash`, and the first
   * row's is a stated genesis constant; neither is null, because the migration
   * gives every row it copies one.
   */
  readonly prev_hash: string;
  readonly row_hash: string;
}

/**
 * The table's columns, in the table's order — the proxy's own list rather than a
 * second copy of it (#511).
 *
 * `AuditRow` above stays hand-written, because it carries a type and a paragraph
 * per column and neither survives being derived. What it stops carrying is the
 * *set*: `satisfies` makes a column the proxy added and this interface did not
 * declare a compile error naming the column, where before it was nothing at all
 * — not a type error, not a failing case, just a property the rows came back
 * holding that nothing here could assert on, because a missing property is
 * exactly what `SELECT *` and a cast suppress. #501 added `result_bytes_by_type`
 * and this interface went without it through a whole green suite.
 *
 * `CHAINED_COLUMNS` is the audited columns. The three the chain cannot cover are
 * spelled here — `id`, which SQLite assigns at the insert, and the two hashes —
 * and their *position* is this file's claim rather than the proxy's. That is why
 * `auditColumns` below exists and why the case in ../audit.test.ts checks this
 * whole list against a live log: two hand-written lists agreeing with each other
 * and not with SQLite is the failure being fixed, not a new place to have it.
 */
export const AUDIT_ROW_COLUMNS = [
  "id",
  ...CHAINED_COLUMNS,
  "prev_hash",
  "row_hash"
] as const satisfies readonly (keyof AuditRow)[];

/**
 * Rows after `since`.
 *
 * The cursor is not a convenience: the table is append-only by trigger, so
 * nothing — not this harness, not a `beforeEach` — can truncate it. A file
 * shared by several cases is read forward from where the last one finished,
 * which is itself a demonstration of the property under test.
 */
export function auditRows(file: string, since = 0): AuditRow[] {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare("SELECT * FROM tool_call_audit WHERE id > ? ORDER BY id").all(since) as unknown as AuditRow[];
  } finally {
    raw.close();
  }
}

/**
 * The columns the live table actually has, in its declared order.
 *
 * `PRAGMA table_info` rather than `auditTableDdl`, for the reason the module
 * header gives about the raw handle: this is a reader, and what it is reading is
 * what the proxy's own migration left behind rather than what a literal in this
 * repository says it should have.
 */
export function auditColumns(file: string): string[] {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare("PRAGMA table_info(tool_call_audit)").all().map(row => row["name"] as string);
  } finally {
    raw.close();
  }
}

/** The highest id written so far — the cursor a case takes before it acts. */
export function lastAuditId(file: string): number {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const row = raw.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tool_call_audit").get() as { id: number };
    return row.id;
  } finally {
    raw.close();
  }
}

/**
 * One channel's spend for the current UTC day.
 *
 * Through the operator's own path (`readChannelSpend`), not a hand-written
 * query: reading one channel's counters is exactly what that function is for,
 * and a second SQL string here would be one the "every statement lives in the
 * module that opens its database" rule cannot see.
 */
export function spendFor(file: string, channel: string): DailySpend {
  const db = openBudgetDb({ file });
  try {
    return readChannelSpend(db, channel).spend;
  } finally {
    db.close();
  }
}
