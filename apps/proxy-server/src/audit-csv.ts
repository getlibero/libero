// The audit log as CSV: the column contract, and the escape.
//
// Pure — an `AuditEntry` in, a string out — so the whole export contract is one
// screen with no database and no process behind it.
//
// ## The header row is the contract
//
// The columns are the table's, with the table's names and its declared order,
// so a CSV column and a SQL column are the same thing under the same name and
// nobody has to hold a mapping in their head. A test asserts this list equals
// `PRAGMA table_info(tool_call_audit)`, so the two cannot drift silently.
//
// **A new column is appended to the end**, even if the DDL declares it in the
// middle. Someone's script indexes positionally, and shifting a column under
// them turns a correct script into a wrong one with no error. That rule costs
// the list its exact correspondence with the DDL's *order* one day; it is worth
// it, and the test will say so when the day comes.
//
// ## Escaping, which is not hypothetical here
//
// RFC 4180: quote a field containing a double quote, a comma, CR, or LF, or one
// with leading or trailing whitespace; inside a quoted field a double quote
// becomes two. Nothing else is altered.
//
// The field that makes this real is `call_id`. It is the model's tool-use id and
// its schema is `z.string().min(1).max(128)` with no alphabet constraint at all,
// so a model can put a comma, a quote, or a newline in it and the proxy will
// faithfully record what it was sent. Every other text column is either an
// `identifier()` or a channel id from a certificate subject, and neither can
// carry any of those. So the quoting exists for exactly one column, and that
// column is the one an attacker controls.
//
// ## Formula injection is documented, not mangled
//
// A `call_id` beginning with `=`, `+`, `-`, or `@` is a formula as far as a
// spreadsheet is concerned, and RFC 4180 quoting does not stop that — the usual
// mitigation is to prefix the field with an apostrophe.
//
// This does not do that, deliberately. The mitigation alters a recorded value in
// an export of an append-only log, which is the one property the whole file
// exists to have; an operator comparing a CSV cell against a proxy log line
// would find them different, and the log would be the thing that looked wrong.
// The hazard is named in `--help` and in the proxy's README instead, so someone
// opening the file in Excel has been told. It is a one-line change if that trade
// is ever judged the wrong way round.

import type { AuditEntry } from "@getlibero/proxy";

/**
 * A column: its header, and how a row becomes its cell.
 *
 * One table rather than a header list beside a row-rendering function, because
 * two lists in one order is how a column ends up under the wrong name.
 */
interface Column {
  readonly header: string;
  readonly of: (entry: AuditEntry) => string;
}

/**
 * Epoch milliseconds as ISO-8601 UTC.
 *
 * The same rendering the human output uses, so one timestamp means one string
 * everywhere. Milliseconds are kept: two rows can share a second, and the log's
 * order is a thing a reader may need to reconstruct.
 */
export function isoTime(atMs: number): string {
  return new Date(atMs).toISOString();
}

/**
 * Absent is an empty cell, and that is not the same as `false` or `0`.
 *
 * `AuditRecord` is emphatic about this: on an `unanswered` row the result
 * columns are absent because the proxy could not measure a result, not because
 * there was none. A `false` in the error column would read as a tool that ran
 * and succeeded, which is precisely the claim that row refuses to make.
 */
const optional = (value: string | number | boolean | undefined): string =>
  value === undefined ? "" : String(value);

export const AUDIT_CSV_COLUMNS: readonly Column[] = [
  { header: "id", of: e => String(e.id) },
  { header: "at", of: e => isoTime(e.at) },
  { header: "channel", of: e => e.channel },
  { header: "requesting_user", of: e => e.requestingUser },
  { header: "task", of: e => e.task },
  { header: "request_id", of: e => e.requestId },
  { header: "call_id", of: e => e.callId },
  { header: "server", of: e => e.server },
  { header: "tool", of: e => e.tool },
  { header: "arguments_sha256", of: e => e.argumentsSha256 },
  { header: "outcome", of: e => e.outcome },
  // The enumerated token, never the sentence. Sentences are for the human
  // output; an export is data, and a reader filtering on this wants a value it
  // can compare rather than prose that might be re-worded.
  { header: "refusal_reason", of: e => optional(e.refusalReason) },
  // #62. `budget_limit` is which limit bound; the other two are the channel's
  // running total at the moment of the decision and the price table that
  // computed it — **not** what this call cost, which is not a quantity. Empty
  // rather than `0` when nothing was priced, so a reader summing the column is
  // summing figures that exist. Micro-USD, integer, because a CSV column of
  // dollars-and-cents is a column somebody's spreadsheet will re-round.
  { header: "budget_limit", of: e => optional(e.budgetLimit) },
  { header: "day_spend_micro_usd", of: e => optional(e.daySpendMicroUsd) },
  { header: "price_version", of: e => optional(e.priceVersion) },
  { header: "result_bytes", of: e => optional(e.resultBytes) },
  { header: "result_is_error", of: e => optional(e.resultIsError) },
  { header: "approver", of: e => optional(e.approver) },
  { header: "ticket", of: e => optional(e.ticket) },
  // #219, appended for this file's own rule: a new column goes at the end,
  // because a script reading this by position should keep working.
  { header: "destination", of: e => optional(e.destination) },
  // #501, appended for the same rule. JSON in a CSV cell, which `escape` quotes
  // like any other value carrying a comma — one column that survives a fifth
  // block type beats four that would each need a schema version.
  {
    header: "result_bytes_by_type",
    of: e => (e.resultBytesByType === undefined ? "" : JSON.stringify(e.resultBytesByType))
  },
  // #354. Not `optional`, because the columns are NOT NULL — every exported row
  // has both. They are here rather than left off because an export that drops
  // the chain is an export nobody can verify: `row_hash` is what recomputation
  // is checked against, and `prev_hash` is what ties a row to the one before it.
  // A CSV of the log that cannot be checked is a copy of the log, not evidence.
  { header: "prev_hash", of: e => e.prevHash },
  { header: "row_hash", of: e => e.rowHash }
];

/** RFC 4180, and nothing beyond it. */
export function csvField(value: string): string {
  const needsQuotes =
    value.includes('"') ||
    value.includes(",") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value !== value.trim();
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvHeader(): string {
  return AUDIT_CSV_COLUMNS.map(column => csvField(column.header)).join(",");
}

export function csvRow(entry: AuditEntry): string {
  return AUDIT_CSV_COLUMNS.map(column => csvField(column.of(entry))).join(",");
}
