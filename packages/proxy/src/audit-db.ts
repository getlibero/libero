// The audit log's file on disk: opening it, its schema, and every statement run
// against it.
//
// **Every SQL string that runs against this file lives here**, as every
// statement against the budget file lives in ./budget-db.ts. One module per
// database, not one per package: the rule exists so a claim about what the
// statements do can be checked by reading one screen, and a second database
// does not weaken that as long as its statements are all on one screen too. A
// statement prepared anywhere else — a route, a writer, an admin helper — is a
// review failure.
//
// The claim to check here is narrower than the budget's and stronger: **once
// the file is open, the audit table is touched by exactly one statement, an
// INSERT.** There is no UPDATE and no DELETE against `tool_call_audit` on the
// serving path — the only other SQL is the `schema_version` bookkeeping at open,
// and since #354 one read of the chain's tip, also at open — and the table
// refuses both from any connection.
//
// That tip read is why the chain does not cost the serving path a second
// statement: `openAuditDb` reads the last `row_hash` once and carries it in
// memory, so `append` still runs one INSERT and nothing else. The cost of that
// choice is stated where it is made — it assumes this is the only connection
// appending to the file.
//
// That claim is now per *connection* rather than per file, and the distinction
// is what the reader below rests on. `openAuditDb` is the writing connection and
// prepares one statement, an INSERT. `openAuditReader` is a second connection,
// opened read-only, that prepares only SELECTs, runs no migration, and installs
// nothing. Neither can do the other's work: the reader's connection refuses a
// write, and the writer's interface has no read method.
//
// "Once the file is open" is doing real work in that sentence, and #125 is why.
// Widening the outcome vocabulary meant rebuilding the table, and SQLite cannot
// alter a CHECK constraint in place, so `rebuildAuditTable` below drops the two
// triggers, drops the table, and renames a copy over it. That is the one moment
// the append-only property is deliberately switched off, and it is confined to
// a single function that runs inside one transaction before `append` has been
// prepared and before the listener binds. Read the rule as: **the serving path
// has one statement; the open path may rebuild, once, transactionally, and puts
// the triggers back.** A DROP or an UPDATE anywhere else in this module is a
// review failure exactly as it was.
//
// #124 widened the vocabulary a second time, which is why that function is named
// for what it does rather than for the versions it spans: there is one rebuild
// procedure and `migrate` picks the source it runs against.
//
// One table with a channel column, on the argument ./budget-db.ts makes at
// length: the line is whose data it is and who reads it. An audit log is
// operator-facing, and "what did this workspace do yesterday" is the query it
// exists to answer, not a hazard to design out. What has to hold instead is
// that channel members cannot manipulate it — the channel comes from the client
// certificate, every write is an INSERT the route makes from its own
// observation, and the handle the server holds has `append` and `close` on it
// and nothing else.
//
// ## Append-only: what is load-bearing
//
// **The two triggers.** SQLite has no roles and no grants, so the architecture's
// "no UPDATE/DELETE grants for the service role" cannot be implemented as
// written. `BEFORE UPDATE` and `BEFORE DELETE` triggers that RAISE(ABORT) are
// the real thing: they are enforced by SQLite on the file itself, for every
// connection that opens it — this process, the audit CLI, an operator with
// sqlite3 and a bad idea. That is the mechanism. Note that
// `INSERT … ON CONFLICT DO UPDATE` fires the update trigger, which is why the
// append below carries no conflict clause.
//
// **Defence in depth: the named-operations interface.** `AuditDb` exposes
// `append` and `close`. It stops the mistake, not the attacker — a caller
// holding this handle could still prepare its own statement, and the triggers
// are what refuse it.
//
// **Defence in depth, and weak: filesystem permissions.** They constrain other
// users and other containers. They constrain this process not at all: the
// process that must be able to write the file is the process that could unlink
// it. Nothing here should be read as claiming otherwise.
//
// **What none of it stops**, so nobody has to infer it: DROP TABLE, DROP
// TRIGGER, PRAGMA writable_schema, `rm audit.db`, and a hex editor. Append-only
// means the service cannot rewrite history in normal operation. It does not
// mean an attacker holding the file cannot. That is what the chain below is
// for, and it is *evidence* rather than prevention: the triggers stop the
// service, the chain catches whoever holds the file.
//
// ## The chain (#354)
//
// Every row carries `prev_hash` and `row_hash`. `row_hash` is SHA-256 over the
// predecessor's `row_hash` and a canonical serialization of this row's own
// columns; the first row chains from `AUDIT_CHAIN_GENESIS`. Recomputing the walk
// from the first row is what detects an edit — #355 is the operator command that
// does it, and its statements land in this file with the rest.
//
// **What it catches**, stated narrowly because the word "tamper-evident" invites
// more: any row rewritten, deleted or inserted *without* recomputing every hash
// after it. That is what an UPDATE through `sqlite3` does, and it is the whole of
// what the append-only triggers were already unable to see.
//
// **What it does not catch**, three things:
//
//   1. **A complete recompute.** The chain is unkeyed, so an attacker holding
//      the file can rewrite a row and re-derive every hash after it, and the
//      walk verifies clean. The answer is #355 printing the tip hash and the
//      operator writing it down somewhere the attacker does not hold — evidence
//      lives outside the file or it is not evidence. An HMAC was considered and
//      rejected for the reason ./audit-log.ts already gives about the argument
//      hash: reading `audit.db` means being on the proxy host, where the vault
//      file and this process's memory already are, so the key is standing next
//      to the thing it would protect.
//   2. **Truncation from the tail.** Dropping the last n rows leaves a shorter
//      chain that is internally perfect. Same answer: an anchored tip.
//   3. **A monotone renumbering of `id`.** The chain fixes the *order* and not
//      the numbering: nothing in a preimage names an id, so rewriting 1,2,3 as
//      10,20,30 leaves a walk that verifies. Swapping two ids is caught, because
//      the walk is `ORDER BY id` and the pair stops linking. What a renumbering
//      costs is `afterId` as an export cursor rather than a row or a sequence,
//      and closing it would mean this process assigning the primary key instead
//      of SQLite — a real change to who owns `id`, bought against an attacker who
//      is rebuilding the table anyway and can therefore recompute the chain too.
//   4. **Rotation.** A chain is per *file*. `VACUUM INTO` a dated archive starts
//      a new one, and tying the new file's genesis to the old file's tip is the
//      operator's act — the writer has no way to know a rotation happened.
//
// One thing the chain does more than detect. The unique index on `prev_hash`
// (see `auditIndexDdl`) makes a forked chain a refused INSERT, which matters
// because the append-only triggers stop UPDATE and DELETE and **not** INSERT:
// anyone holding the file can append to it. The cost is worth stating plainly —
// once something has written the tip's successor behind this process's back,
// every call it serves is refused until an operator restarts it. That is a
// denial of service caused by tampering, and it is the posture the route already
// takes when it cannot write a row at all: a proxy that cannot record what it
// did must not answer. Re-seeding the tip on conflict would mean chaining onto
// the attacker's row and carrying on, which is why it is not done.
//
// The serialization is pinned by `CHAINED_COLUMNS` and `auditRowPreimage` below,
// and changing either is a chain break, which is why both version with
// `AUDIT_SCHEMA_VERSION`.
//
// ## No retention, and no DELETE-based one later
//
// ./budget-db.ts prunes `turn_report` because that table exists to defeat
// retries and forgetting an old turn is harmless. This log's entire value is
// not forgetting, and deleting rows from an append-only log is exactly the
// operation an attacker wants — shipping a supported path for it hands them
// one. Growth is bounded and small: roughly 200 bytes a row, so 10k calls a day
// is about 2 MB a day.
//
// The shape when that stops being small is rotation rather than deletion:
// `VACUUM INTO` a dated archive and start a fresh file. If row-level erasure is
// ever genuinely required — a data-subject request naming a `requesting_user` —
// it needs an operator command that drops and recreates the triggers inside one
// transaction, visible in a diff, off the serving path, and reachable from
// nothing the listener holds.
//
// ## Reading it back
//
// `openAuditReader` is the operator's path (#98), and its query statements are
// here rather than in the command that runs them, per the rule above. It is
// reached by `node dist/audit.js` — a second entrypoint of the proxy process,
// like the vault and the budget, because the file lives in a container volume
// the operator's host cannot see. It is *not* reached by the published CLI, and
// an ESLint rule keeps it out of the serving composition root by name.
//
// Three properties, each deliberate. **Read-only**: the connection is opened
// `readOnly`, so SQLite refuses a write before the triggers have to. (SQLite
// still creates the `-wal`/`-shm` sidecars on open — that is bookkeeping beside
// the file, not a write to the log.) **No migration**: migrating is writing, and
// a reader that repaired a file would be a reader that changed the evidence.
// **The schema version must match exactly**, in both directions: a file from the
// future read with this build's column list is the same failure
// `AUDIT_SCHEMA_VERSION` guards against on the write side, turned around — a
// CSV that claims to be the log and quietly omits a column.
//
// To ask what a request cost, join to the budget file by hand: rows here carry
// `task`, and `turn_report` over there carries turn ids shaped `<task>.<n>`.
// Deliberately by an operator across two files, and by no code in this package.
//
// `node:sqlite` for the reason ./budget-db.ts gives: it is built in, so the
// proxy gains no dependency and the license gate has nothing new to check.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { AuditOutcome, AuditRecord, BudgetLimit, RefusalReason } from "@getlibero/schema";
import type { Logger } from "./log.js";

/**
 * The schema version this build writes.
 *
 * Checked at open, and a file from the future is a startup failure rather than
 * something to work around — the same rule the budget file follows, and here
 * the consequence is worse: a build writing rows a later one cannot read leaves
 * an incident review with a gap it has no way to notice.
 *
 * Version 2 widened the outcome vocabulary for the approval broker (#125) and
 * added the `ticket` column. Version 3 widened it again, by one member:
 * `unanswered`, the row a decided call leaves when the handler failed before it
 * could answer (#124). No column changed. Version 4 added `budget_limit`,
 * `day_spend_micro_usd` and `price_version` (#62) — three nullable columns, each
 * of which an older row is given `NULL` for, because a row written before the
 * column existed had no such figure.
 *
 * Each of those is a *widening*, and that is the property a version has to
 * establish for itself rather than inherit: v3 accepts every outcome v2 did, so
 * no existing row can fail the new constraint and the copy cannot be rejected.
 * A migration that *can* reject a row is a different kind of thing and needs a
 * different answer to "what happens to the rows that fail".
 *
 * **Version 5 is the first one that is not a widening in that sense**, and it
 * has to answer the question differently rather than skip it. It adds
 * `prev_hash` and `row_hash` **NOT NULL** (#354), so there is no value an older
 * row could be given by default. What makes it safe is that the rebuild computes
 * one for every row it copies, in order, so no row reaches the new constraint
 * without a value. The honest consequence is recorded at `rebuildAuditTable`:
 * rows written before v5 are chained *as of the migration*, which vouches for
 * them from that moment forward and asserts nothing about what happened to them
 * before it.
 *
 * **Version 6 is a widening again** (#219), and the easy kind: one nullable
 * `destination`, the host that ended a run because the channel's `[egress]` list
 * did not allow it. Every row written before it is given `NULL`, which is a
 * reading rather than a gap — a row that is not an egress refusal has no
 * destination. It costs the chain nothing, because NULL columns are omitted from
 * the preimage: the rows already on disk hash to exactly what they did.
 *
 * It lands now rather than after 0.4 ships, and that is a cost comparison rather
 * than eagerness. `migrate` is a rebuild-and-rename over every row, so the price
 * of this column is paid by whoever has the most of them. Today that is nobody.
 *
 * A file from the future is still a startup failure, and so is a file from a
 * past this build has no migration from.
 */
export const AUDIT_SCHEMA_VERSION = 6;

/**
 * The table, parameterised on its name.
 *
 * One source for the DDL, because `rebuildAuditTable` has to build a table that
 * is *identical* to the one a fresh file gets and then rename it into place. Two
 * copies of these columns would agree on the day they were written and drift on
 * some later one, and the failure would be a database whose shape depends on how
 * old it is — which is the thing a schema version exists to make impossible.
 * There is a test that opens a created file and a migrated one and compares what
 * SQLite says the table is.
 *
 * This is by construction *the table this build writes*, never a past one, and
 * that is what decides the shape of `migrate`: a genuine version ladder would
 * need a frozen v2 literal beside this one, which is the second copy this
 * comment exists to prevent.
 *
 * The argument is always a module-private literal. It is never input, and it
 * cannot be: nothing outside this file can call this.
 */
const auditTableDdl = (table: string, ifNotExists: boolean): string => `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  id               INTEGER PRIMARY KEY,
  at               INTEGER NOT NULL,
  channel          TEXT    NOT NULL,
  requesting_user  TEXT    NOT NULL,
  task             TEXT    NOT NULL,
  request_id       TEXT    NOT NULL,
  call_id          TEXT    NOT NULL,
  server           TEXT    NOT NULL,
  tool             TEXT    NOT NULL,
  arguments_sha256 TEXT    NOT NULL,
  outcome          TEXT    NOT NULL CHECK (outcome IN
                     ('ran', 'held', 'refused', 'unavailable', 'unanswered',
                      'approved', 'denied', 'expired')),
  refusal_reason   TEXT,
  -- #62. Nullable, and null is a reading rather than a gap: a row that is not a
  -- budget refusal has no limit, and a channel that priced nothing has no
  -- figure. See AuditRecord in @getlibero/schema for what each means, and in
  -- particular that day_spend_micro_usd is the channel's running total at the
  -- moment of the decision and never this call's cost.
  budget_limit     TEXT CHECK (budget_limit IS NULL OR budget_limit IN
                     ('daily_tokens', 'daily_tool_calls', 'daily_usd')),
  day_spend_micro_usd INTEGER,
  price_version    TEXT,
  result_bytes     INTEGER,
  result_is_error  INTEGER,
  approver         TEXT,
  ticket           TEXT,
  -- #354. The chain: two columns a row does not supply, because this module
  -- computes them as SQLite computes id. NOT NULL because every row has one --
  -- the migration computes a hash for every row it copies, so a version 5 file
  -- holds no unchained row.
  --
  -- A new column goes at the END of this list, here and in AUDIT_COLUMNS and in
  -- audit-csv.ts, and now for a second reason on top of the one that file gives
  -- about scripts indexing positionally: CHAINED_COLUMNS fixes the chain's
  -- serialization order, so a column inserted in the middle of it would rewrite
  -- the preimage of every row already written.
  -- A shape check, not hex validation. Lowercase hex is pinned by the round-trip
  -- test; a CHECK that pretended to validate it would be worse than none.
  -- #219. The host a run was killed for reaching. Null on every row that is not
  -- an egress_denied refusal, which is almost all of them.
  --
  -- This is the column auditRefusalMessage in @getlibero/schema said the table
  -- did not have: it returned null for egress_denied because naming a host the
  -- row never recorded would be a fabricated fact in a record whose whole value
  -- is that it was observed. It can now rebuild the sentence the channel saw,
  -- which is what that function is for. (No backticks in this block: the DDL is
  -- a template literal, and one would end it.)
  --
  -- One host and not a list, and that is the schema agreeing with the policy
  -- rather than a limitation: #393 made the first denial terminal, so a run has
  -- at most one.
  destination      TEXT,
  prev_hash        TEXT    NOT NULL CHECK (length(prev_hash) = 64),
  row_hash         TEXT    NOT NULL CHECK (length(row_hash) = 64)
)`;

/**
 * The indexes and the triggers, apart from the table because the migration
 * creates them *after* the rename — at which point there is no dependent object
 * for `ALTER TABLE … RENAME TO` to rewrite, and nothing to reason about.
 */
const auditIndexDdl = `
CREATE INDEX IF NOT EXISTS tool_call_audit_channel_at ON tool_call_audit (channel, at);
CREATE INDEX IF NOT EXISTS tool_call_audit_channel_task ON tool_call_audit (channel, task);
-- Partial, because the column is null on every row that never met the approval
-- broker: what this answers is "show me this ticket's lifecycle", which is four
-- rows across four requests that share nothing else.
CREATE INDEX IF NOT EXISTS tool_call_audit_ticket ON tool_call_audit (ticket) WHERE ticket IS NOT NULL;
-- #354, and the only UNIQUE index in either database. Two rows claiming the same
-- predecessor is a forked chain, and this is what makes that a refused INSERT
-- rather than a file that verifies as tampered. It is the same *class* of
-- mechanism as the two triggers below — SQLite enforcing it on the file, for
-- every connection that opens it — which is what lets the writer's in-memory tip
-- be an assumption SQLite checks rather than one the README asks you to believe.
--
-- It covers two things the triggers do not. **The triggers stop UPDATE and
-- DELETE and not INSERT**, so anyone holding the file can append to it today; a
-- forged append takes the tip's successor slot, and this proxy's next call is
-- refused instead of quietly starting a second chain. And two proxies against
-- one file — which is not a deployment shape here, but is the mistake that would
-- otherwise make an untampered log verify as broken, the one failure that
-- teaches an operator to ignore the tool.
CREATE UNIQUE INDEX IF NOT EXISTS tool_call_audit_prev_hash ON tool_call_audit (prev_hash);
`;

const auditTriggerDdl = `
CREATE TRIGGER IF NOT EXISTS tool_call_audit_no_update
BEFORE UPDATE ON tool_call_audit
BEGIN
  SELECT RAISE(ABORT, 'the audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS tool_call_audit_no_delete
BEFORE DELETE ON tool_call_audit
BEGIN
  SELECT RAISE(ABORT, 'the audit log is append-only');
END;
`;

/**
 * What a file must have before `migrate` can look at it, and no more.
 *
 * The indexes and the triggers are deliberately *not* here. One of the indexes
 * names `ticket`, and on a version 1 file that column does not exist yet — so
 * creating them before the migration would fail on exactly the files the
 * migration exists for. They are applied after `migrate` instead, where the
 * column is guaranteed either way.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

${auditTableDdl("tool_call_audit", true)};
`;

/**
 * Domain separation, and the serialization's own version number.
 *
 * It goes into every preimage, so a digest computed here can never coincide with
 * one computed over the same bytes for another purpose. The trailing `/1` is
 * where a future change to the encoding becomes a value somebody has to edit
 * deliberately, which is the point: changing the serialization does not migrate
 * a file, it invalidates it.
 */
export const AUDIT_CHAIN_TAG = "libero/tool_call_audit/chain/1";

/**
 * What the first row chains from.
 *
 * Derived from the tag rather than written as a word, so that every `prev_hash`
 * in the table is 64 hex characters and the column's CHECK can say so. A zero
 * hash was rejected for the opposite reason: all-zeroes is what a half-finished
 * forgery produces, and it should not accidentally be a valid genesis.
 *
 * It is not file-specific, and that is a decision rather than an oversight.
 * Tying it to a path or an inode would break the chain the moment the file is
 * copied — and copying it is the first thing an operator preserving evidence
 * does, as well as being what `VACUUM INTO` rotation is. A random per-file nonce
 * is no better: it would be data in the file, which is data the attacker holding
 * the file can rewrite. Splicing a prefix out of another file is answered by an
 * anchored tip, the same answer the other limits get.
 */
export const AUDIT_CHAIN_GENESIS = createHash("sha256")
  .update(`${AUDIT_CHAIN_TAG}/genesis`, "utf8")
  .digest("hex");

/**
 * The columns a row's hash covers, in the table's declared order.
 *
 * This is the pinned serialization order #354 asks for, and it is also the
 * INSERT's column list and its bind order — all three are generated from this
 * one array below, which is what makes the hash provably cover exactly what was
 * written. Before this they were two hand-aligned lists, and a hash computed
 * from one while the other was bound would have been a chain over a row that
 * does not exist.
 *
 * `id`, `prev_hash` and `row_hash` are deliberately absent. `id` is assigned by
 * SQLite at the insert, so it cannot be in a preimage computed before it. What
 * that costs is stated exactly at the head of this file: the chain fixes the
 * order, so *reordering* two rows breaks it, and *renumbering* them monotonically
 * does not. `prev_hash` is hashed separately, and `row_hash` is the output —
 * a hash cannot cover itself.
 */
export const CHAINED_COLUMNS = [
  "at",
  "channel",
  "requesting_user",
  "task",
  "request_id",
  "call_id",
  "server",
  "tool",
  "arguments_sha256",
  "outcome",
  "refusal_reason",
  "budget_limit",
  "day_spend_micro_usd",
  "price_version",
  "result_bytes",
  "result_is_error",
  "approver",
  "ticket",
  "destination"
] as const;

type ChainedColumn = (typeof CHAINED_COLUMNS)[number];

/** One row's audited columns, as SQLite holds them: no `undefined`, only NULL. */
export type AuditRowValues = Readonly<Record<ChainedColumn, string | number | null>>;

/**
 * The bytes a row's hash is taken over: its predecessor, then its own columns.
 *
 * Pinned, because a change here is a chain break — every row already on disk
 * would stop verifying. That is why it versions with `AUDIT_SCHEMA_VERSION`, and
 * why the two rules below are rules rather than choices.
 *
 * **Order is `CHAINED_COLUMNS`**, not sorted. `canonicalJson` in ./audit-log.ts
 * sorts because its input is an arbitrary parsed object whose key order is not a
 * fact about anything; here the order is a module-private constant, so pinning it
 * there pins it here. This is the same discipline as that function and not a copy
 * of it — a flat map of known columns rather than a recursive walk — and the two
 * could not share code anyway, since ./audit-log.ts imports this module.
 *
 * **NULL columns are omitted**, and this is the load-bearing rule. Every schema
 * version this module has shipped added nullable columns that are NULL on every
 * row written before them, so omitting nulls means a later widening does not
 * change the preimage of a row already chained — the chain survives the next
 * migration instead of having to be recomputed by it. Including `"ticket":null`
 * would have made v2 break every v1 row's hash, had there been one to break.
 *
 * Both the key and the value go through `JSON.stringify`, so a `tool` or a
 * `call_id` containing a quote, a brace or a colon cannot shift a field boundary
 * and make two different rows serialize alike. `call_id` is the sharp case:
 * `ToolCall` bounds its length and constrains its alphabet not at all, so a
 * model can send `","channel":"C0EVIL` and would otherwise be writing its own
 * fields into the preimage. Escaping is the only thing standing between that and
 * a collision, which is why this is not a `join("|")`. It also keeps `12` and
 * `"12"` apart, so an INTEGER column and a TEXT one holding the same digits do
 * not serialize alike.
 *
 * Every numeric column here holds an integer inside `Number.MAX_SAFE_INTEGER`
 * — `at` is epoch ms, `day_spend_micro_usd` is exact past nine billion dollars,
 * `result_bytes` is bounded by the result cap and `result_is_error` is 0 or 1 —
 * where "bounded by the result cap" is since #500 a statement about magnitude
 * rather than an identity: the cap counts a text block's characters and a
 * binary block's decoded bytes, and this column counts utf8 bytes and the same
 * decoded bytes, so the two agree on binary and differ on multi-byte text by
 * the factor utf8 costs. `resultCost` in `@getlibero/schema` holds both rules.
 * Neither can leave the safe-integer range, which is all this paragraph asks —
 * so each renders without a fraction or an exponent. A future column that is not
 * is a serialization change, which is to say a chain break.
 *
 * Exported so a test can pin the bytes rather than pin a digest of them: a
 * change here should fail with a readable diff, not with two hex strings.
 */
export function auditRowPreimage(prevHash: string, values: AuditRowValues): string {
  const fields = CHAINED_COLUMNS.filter(column => values[column] !== null).map(
    column => `${JSON.stringify(column)}:${JSON.stringify(values[column])}`
  );
  return `${AUDIT_CHAIN_TAG}\n${prevHash}\n{${fields.join(",")}}`;
}

/**
 * A row's link in the chain: SHA-256 over `auditRowPreimage`, lowercase hex.
 *
 * The same digest and the same encoding as `hashArguments` in ./audit-log.ts,
 * for the reason that function's own header gives — this is text the proxy
 * observed, never a credential, and ./log.ts's ban on hashing a secret is about
 * a different kind of value.
 *
 * Exported so the round-trip test and #355's walk can recompute a row rather than
 * trusting the column beside it. It is not on the package barrel: nothing on the
 * serving path should be able to compute one for a row it did not write.
 */
export function auditRowHash(prevHash: string, values: AuditRowValues): string {
  return createHash("sha256").update(auditRowPreimage(prevHash, values), "utf8").digest("hex");
}

/**
 * The chained columns of a row as SQLite handed it back, for recomputing a hash.
 *
 * **It throws on a column the row does not have**, and that is the whole reason
 * it exists rather than a cast. `undefined` and `null` are one thing to a
 * `Record<string, unknown>` lookup and two things here: a `SELECT` that lost a
 * column would otherwise produce a preimage with that field omitted, which is a
 * perfectly well-formed hash of the wrong row. Loud beats plausible.
 */
export function auditRowValuesOf(row: Record<string, unknown>): AuditRowValues {
  const values: Record<string, string | number | null> = {};
  for (const column of CHAINED_COLUMNS) {
    const value = row[column];
    if (value === undefined) {
      throw new Error(`proxy audit: cannot hash a row with no ${column} column`);
    }
    values[column] = value as string | number | null;
  }
  return values as AuditRowValues;
}

/**
 * An `AuditRecord` as the columns SQLite is given, which is what gets hashed.
 *
 * The `?? null` conversions are here rather than at the bind site so the hash is
 * taken over the values that are actually written — `undefined` and `null` are
 * one thing to SQLite and two to TypeScript, and the preimage has to see what
 * the row will hold.
 */
function auditRowValues(record: AuditRecord): AuditRowValues {
  return {
    at: record.at,
    channel: record.channel,
    requesting_user: record.requestingUser,
    task: record.task,
    request_id: record.requestId,
    call_id: record.callId,
    server: record.server,
    tool: record.tool,
    arguments_sha256: record.argumentsSha256,
    outcome: record.outcome,
    refusal_reason: record.refusalReason ?? null,
    budget_limit: record.budgetLimit ?? null,
    day_spend_micro_usd: record.daySpendMicroUsd ?? null,
    price_version: record.priceVersion ?? null,
    result_bytes: record.resultBytes ?? null,
    // NULL rather than 0 when the call did not run: a refusal has no result, and
    // 0 would read as a tool that succeeded and said nothing.
    result_is_error: record.resultIsError === undefined ? null : record.resultIsError ? 1 : 0,
    approver: record.approver ?? null,
    ticket: record.ticket ?? null,
    destination: record.destination ?? null
  };
}

export interface AuditDbOptions {
  /** The database file. Its directory must exist and be writable. */
  readonly file: string;
  readonly logger?: Logger;
}

/**
 * The open database, as named operations rather than a handle, for the reason
 * `BudgetDb` gives — nobody prepares their own statement.
 *
 * There is one operation, and it appends. No read method: an aggregate read
 * belongs on the operator path and must never appear on the interface the
 * serving process closes over. That path now exists — it is `AuditReader`, a
 * separate interface over a separate connection from a separate open, reached
 * by a separate entrypoint. Nothing was added here to serve it. No delete, no
 * update: those are what the table refuses, and a method here would be a method
 * that always throws.
 */
export interface AuditDb {
  append(record: AuditRecord): void;
  close(): void;
}

export function openAuditDb(options: AuditDbOptions): AuditDb {
  const { file, logger } = options;

  // No mkdir, as ./budget-db.ts. An audit file the proxy invented under a path
  // nobody meant is a deployment that appears to be audited and whose record
  // dies with the container — a failure that is silent by construction, because
  // the symptom is an empty table nobody looks at until an incident.
  const db = new DatabaseSync(file);

  try {
    // WAL so the audit CLI reading this file cannot block a proxy that is
    // serving. It also means SQLite writes `-wal` and `-shm` beside the file,
    // so the *directory* has to be writable.
    db.exec("PRAGMA journal_mode = WAL");
    // FULL, not NORMAL. Under WAL, NORMAL can lose the last commits on a host
    // crash, and a lost commit here is a call that happened with no record of
    // it. It is also what makes a hard kill safe without closing the database.
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    migrate(db, file);
    // After the migration, never before: one of these names a column that a
    // version 1 file does not have. `migrate` recreates them itself when it
    // rebuilds — these two lines are what covers the already-current file, and
    // both statements are `IF NOT EXISTS`.
    db.exec(auditIndexDdl);
    db.exec(auditTriggerDdl);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    // No ON CONFLICT clause, deliberately, and since #354 the reason is stronger
    // than it was. An upsert would fire the update trigger, and two calls
    // identical in every column are still two rows because they are two calls —
    // but there is now something to conflict *on*: the unique index on
    // `prev_hash`. An `ON CONFLICT` clause there would be the difference between
    // refusing the call and quietly serving into a forked log.
    //
    // The column list and the placeholder run are generated from
    // CHAINED_COLUMNS, so the order this binds in cannot drift from the order
    // the hash was taken in. That is not a tidiness argument: two hand-aligned
    // lists would let a future column be added to one and not the other, and the
    // symptom would be a chain that verifies over a row nobody wrote.
    append: db.prepare(
      `INSERT INTO tool_call_audit (${CHAINED_COLUMNS.join(", ")}, prev_hash, row_hash)
       VALUES (${CHAINED_COLUMNS.map(() => "?").join(", ")}, ?, ?)`
    )
  } satisfies Record<string, StatementSync>;

  // The chain's tip, read once and then carried, which is what keeps the serving
  // path at one statement — see the head of this file. `ORDER BY id DESC LIMIT 1`
  // rather than `MAX(id)` because the value wanted is the last row's hash, and
  // `id` is the append order the whole log is read in.
  //
  // **This assumes one connection appends to this file**, and the unique index
  // on `prev_hash` is what makes that an assumption SQLite checks rather than one
  // this comment asks you to trust. A second writer holds the same tip, so its
  // row claims a predecessor already claimed and the INSERT is refused — which
  // turns what would otherwise be a silent fork, indistinguishable from tampering
  // to anyone walking the chain later, into a call that fails now. The deployment
  // shape is one proxy against one `audit-data` volume
  // (deploy/docker-compose.yml); the index is there for the deployments that are
  // not.
  let tip =
    (
      db.prepare("SELECT row_hash FROM tool_call_audit ORDER BY id DESC LIMIT 1").get() as
        | { row_hash: string }
        | undefined
    )?.row_hash ?? AUDIT_CHAIN_GENESIS;

  // The tip rides along, and it is worth having: where logs are shipped off the
  // host, this is an anchor per restart at no cost — the thing the chain's first
  // limit says has to live outside the file. It is an anchor only as far as the
  // logs travel, which is why #355 still prints one for the operator to keep.
  // ./log.ts's ban on logging a fingerprint is about credential values; a row
  // hash is neither.
  logger?.log("info", { event: "audit_opened", file, chainTip: tip });

  return {
    append(record) {
      const values = auditRowValues(record);
      const rowHash = auditRowHash(tip, values);
      statements.append.run(...CHAINED_COLUMNS.map(column => values[column]), tip, rowHash);
      // After the write, never before. A throw out of `run` — a full disk, a
      // constraint — leaves the tip where it was, so the next call chains onto
      // the last row that actually landed rather than onto one that did not.
      // (That call is refused anyway, by ./server.ts, which is what makes a
      // failed chain computation refuse the call: this function throws and
      // nothing here catches it.)
      tip = rowHash;
    },

    close() {
      db.close();
    }
  };
}

/**
 * A row as it was written, plus the id that orders the log.
 *
 * `id` is not on `AuditRecord` because the writer does not supply it — SQLite
 * assigns it. It is on the way back out because it is the log's own append
 * order and the cursor an export bookmarks, which is why `rebuildAuditTable`
 * copies it explicitly rather than letting a migration renumber history.
 *
 * The two hashes are here for exactly that reason and no other: the writer does
 * not supply them either, this module computes them. They are not optional —
 * the columns are NOT NULL, so a row that reached a reader has both.
 */
export interface AuditEntry extends AuditRecord {
  readonly id: number;
  readonly prevHash: string;
  readonly rowHash: string;
}

/**
 * What to select. Every field is optional and they compose with AND.
 *
 * Absent means "do not filter on this", which is why an empty query is every
 * row rather than none. The two bounds are inclusive at both ends: an operator
 * asking for a day means the day.
 */
export interface AuditQuery {
  readonly channel?: string;
  readonly server?: string;
  readonly tool?: string;
  /** The meter's turn ids are `<task>.<n>`, so this is the cross-file join. */
  readonly task?: string;
  readonly outcomes?: readonly AuditOutcome[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  /** Rows after this id — what an incremental export bookmarks. */
  readonly afterId?: number;
  /**
   * The most recent n matches, still returned oldest-first. 0 or absent is
   * every match.
   */
  readonly limit?: number;
}

/**
 * The operator's read path over the audit log.
 *
 * Named operations rather than a handle, as `AuditDb` is and for the same
 * reason: nobody prepares their own statement. There is no `append` here and
 * there must not be — the two interfaces are the two directions, and a process
 * holding one holds no ability to do the other's job.
 */
export interface AuditReader {
  /** Matching rows, oldest-first. */
  page(query: AuditQuery): readonly AuditEntry[];
  /** How many rows match, ignoring `limit`. What tells a reader it saw a page. */
  count(query: AuditQuery): number;
  byId(id: number): AuditEntry | undefined;
  /** One approval's lifecycle, oldest-first. */
  byTicket(ticket: string): readonly AuditEntry[];
  /**
   * Tickets whose last row is `held` or `approved` — the two questions
   * `AuditOutcome`'s doc poses in prose and answers nowhere: a held call nobody
   * resolved, and an approval nobody redeemed. One shape, because they are one
   * query with a different last word.
   */
  openApprovals(channel?: string): readonly AuditEntry[];
  /**
   * Walk the chain from the first row and answer what it found (#355).
   *
   * Here rather than in the command that runs it, for the reason every statement
   * in this package is in the module that opens its database — and for a second
   * reason this one has on its own: the walk needs the serialization as well as
   * the SQL, and those two agreeing is the whole of whether a verdict means
   * anything. A walk that recomputed with a different encoding would report a
   * break on every untampered file ever written.
   *
   * It takes no filter and there is no version of it that does. The chain links
   * consecutive rows, so any subset of them is a set of rows whose neighbours
   * are missing — a filtered walk would report a break at the second row of
   * every query. `AuditQuery` is for reading the log; this is for checking it.
   */
  verifyChain(): AuditChainVerdict;
  close(): void;
}

/**
 * What a walk found, and the two shapes are the two things an operator does.
 *
 * A pass carries the **tip**, which is the point: it is the one value that
 * commits to every row in the file, so writing it down somewhere the file's
 * holder does not control is what turns this from a consistency check into
 * evidence. `rows` beside it is what says the tip is a commitment to a log
 * rather than to an empty table.
 *
 * A failure names **one** row and stops. That is the contract rather than a
 * limitation: a break means every hash after it was computed over a predecessor
 * this walk cannot vouch for, so the rows beyond it are unverified rather than
 * wrong, and listing them would present a guess as a finding. `verified` is how
 * many rows were checked before it — the prefix that does still hold.
 *
 * `reason` separates the two ways a row fails, because they are different
 * events. `content` is a row whose own columns no longer hash to the value
 * stored beside them: somebody edited that row. `link` is a row whose
 * `prev_hash` is not the predecessor's `row_hash`: something was deleted from in
 * front of it, inserted before it, or the log forked. Neither reads on the
 * other's evidence, so neither is worded to.
 */
export type AuditChainVerdict =
  | { readonly ok: true; readonly rows: number; readonly tip: string }
  | {
      readonly ok: false;
      readonly verified: number;
      readonly brokenAt: number;
      readonly reason: "content" | "link";
    };

/**
 * Every column, named, in the table's declared order.
 *
 * Never `SELECT *`: `rowToEntry` below reads by name, so a `SELECT *` that
 * silently gained a column would produce an entry that silently lacked it.
 *
 * This used to be a hand-written list kept on one screen with the INSERT's, so
 * that a column added to one was visibly missing from the other. Since #354 both
 * are generated from `CHAINED_COLUMNS` and the drift is not possible rather than
 * merely visible — which it had to become, because the same order also fixes the
 * chain's preimage.
 */
const AUDIT_COLUMNS = `
  id, ${CHAINED_COLUMNS.join(", ")}, prev_hash, row_hash`;

/**
 * The WHERE clause and its bound values.
 *
 * **No filter value is ever concatenated into SQL.** Each clause contributes a
 * `?` and pushes its value; the one thing whose *length* varies is the
 * `outcome IN (…)` placeholder run, and even there only the placeholders are
 * generated — the words are bound. Every outcome has already been through
 * `AuditOutcome` before it reaches here, so the list is closed as well as bound.
 */
function where(query: AuditQuery): { readonly sql: string; readonly params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.channel !== undefined) {
    clauses.push("channel = ?");
    params.push(query.channel);
  }
  if (query.server !== undefined) {
    clauses.push("server = ?");
    params.push(query.server);
  }
  if (query.tool !== undefined) {
    clauses.push("tool = ?");
    params.push(query.tool);
  }
  if (query.task !== undefined) {
    clauses.push("task = ?");
    params.push(query.task);
  }
  if (query.sinceMs !== undefined) {
    clauses.push("at >= ?");
    params.push(query.sinceMs);
  }
  if (query.untilMs !== undefined) {
    clauses.push("at <= ?");
    params.push(query.untilMs);
  }
  if (query.afterId !== undefined) {
    clauses.push("id > ?");
    params.push(query.afterId);
  }
  if (query.outcomes !== undefined && query.outcomes.length > 0) {
    clauses.push(`outcome IN (${query.outcomes.map(() => "?").join(", ")})`);
    params.push(...query.outcomes);
  }

  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * A row as SQLite hands it back, to the shape the rest of the system agrees on.
 *
 * The nulls become absences rather than falsy values, which is the whole of the
 * distinction `AuditRecord.resultBytes` insists on: a missing result is not a
 * result of zero, and a missing error flag is not `false`. `exactOptionalProperty
 * Types` is why these are spread conditionally rather than assigned `undefined`.
 */
function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row["id"] as number,
    at: row["at"] as number,
    channel: row["channel"] as string,
    requestingUser: row["requesting_user"] as string,
    task: row["task"] as string,
    requestId: row["request_id"] as string,
    callId: row["call_id"] as string,
    server: row["server"] as string,
    tool: row["tool"] as string,
    argumentsSha256: row["arguments_sha256"] as string,
    outcome: row["outcome"] as AuditOutcome,
    ...(row["refusal_reason"] === null ? {} : { refusalReason: row["refusal_reason"] as RefusalReason }),
    ...(row["budget_limit"] === null ? {} : { budgetLimit: row["budget_limit"] as BudgetLimit }),
    ...(row["day_spend_micro_usd"] === null
      ? {}
      : { daySpendMicroUsd: Number(row["day_spend_micro_usd"]) }),
    ...(row["price_version"] === null ? {} : { priceVersion: row["price_version"] as string }),
    ...(row["result_bytes"] === null ? {} : { resultBytes: row["result_bytes"] as number }),
    ...(row["result_is_error"] === null ? {} : { resultIsError: row["result_is_error"] === 1 }),
    ...(row["approver"] === null ? {} : { approver: row["approver"] as string }),
    ...(row["ticket"] === null ? {} : { ticket: row["ticket"] as string }),
    // Unconditional, unlike everything above them: the columns are NOT NULL, so
    // there is no absence to distinguish from a value.
    prevHash: row["prev_hash"] as string,
    rowHash: row["row_hash"] as string
  };
}

export interface AuditReaderOptions {
  /** The database file. It must exist: a reader does not create one. */
  readonly file: string;
}

/**
 * Open the audit log to read it, and nothing else.
 *
 * See "## Reading it back" at the top of this file for why this is read-only,
 * why it does not migrate, and why a version mismatch is refused in both
 * directions. Three things it deliberately does not do, each of which
 * `openAuditDb` does: it sets no `journal_mode` and no `synchronous` (those are
 * the writer's durability decisions and setting them here would be a write), it
 * runs no `SCHEMA` and no `migrate`, and it creates no index and no trigger.
 * `busy_timeout` is set because it is a property of this connection's patience
 * and of nothing on disk.
 *
 * A missing file is an error and stays missing — SQLite will not create one for
 * a read-only connection, which is the same fail-loud the writer's absent
 * `mkdir` buys.
 *
 * Statements are prepared per call rather than once at open, which is the
 * opposite of `openAuditDb`'s choice and is right for the opposite reason: the
 * filter set is per query, this process runs a handful and exits, and preparing
 * a statement whose shape depends on the filters is the only way `where` can
 * bind rather than concatenate.
 */
export function openAuditReader(options: AuditReaderOptions): AuditReader {
  const { file } = options;
  const db = new DatabaseSync(file, { readOnly: true });

  try {
    db.exec("PRAGMA busy_timeout = 5000");

    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    if (row === undefined || row.version !== AUDIT_SCHEMA_VERSION) {
      throw new Error(
        `proxy audit: ${file} is schema version ${row?.version ?? "unstamped"}, and this build ` +
          `reads version ${AUDIT_SCHEMA_VERSION}. The proxy migrates an older file the first ` +
          `time it opens one; a reader does not, because migrating is writing.`
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const select = (tail: string, params: readonly (string | number)[]): AuditEntry[] =>
    (db.prepare(`SELECT ${AUDIT_COLUMNS} FROM tool_call_audit${tail}`).all(...params) as Record<
      string,
      unknown
    >[]).map(rowToEntry);

  return {
    page(query) {
      const { sql, params } = where(query);
      // Ordered by `id`, never by `at`: two rows can share a millisecond, and
      // `id` is the order the log was actually appended in. A limit means *the
      // most recent n*, so it is taken descending and then flipped, which is why
      // this is a subquery rather than an ORDER BY with a LIMIT on it.
      if (query.limit === undefined || query.limit === 0) {
        return select(`${sql} ORDER BY id`, params);
      }
      return (
        db
          .prepare(
            `SELECT * FROM (SELECT ${AUDIT_COLUMNS} FROM tool_call_audit${sql} ORDER BY id DESC LIMIT ?)
             ORDER BY id`
          )
          .all(...params, query.limit) as Record<string, unknown>[]
      ).map(rowToEntry);
    },

    count(query) {
      const { sql, params } = where(query);
      const row = db.prepare(`SELECT COUNT(*) AS n FROM tool_call_audit${sql}`).get(...params) as {
        n: number;
      };
      return row.n;
    },

    byId(id) {
      const [entry] = select(" WHERE id = ?", [id]);
      return entry;
    },

    byTicket(ticket) {
      // Rides the partial index on `ticket`.
      return select(" WHERE ticket = ? ORDER BY id", [ticket]);
    },

    openApprovals(channel) {
      // "No later row for this ticket" is the definition of both questions, and
      // NOT EXISTS is how it is asked. The outcome list is a module-private
      // literal rather than a bound parameter because it is this query's
      // meaning, not a filter someone supplied.
      const scope = channel === undefined ? "" : " AND t.channel = ?";
      const params = channel === undefined ? [] : [channel];
      return (
        db
          .prepare(
            `SELECT ${AUDIT_COLUMNS} FROM tool_call_audit t
              WHERE t.ticket IS NOT NULL
                AND t.outcome IN ('held', 'approved')
                AND NOT EXISTS (
                  SELECT 1 FROM tool_call_audit l WHERE l.ticket = t.ticket AND l.id > t.id
                )${scope}
              ORDER BY t.id`
          )
          .all(...params) as Record<string, unknown>[]
      ).map(rowToEntry);
    },

    verifyChain() {
      // `iterate`, never `all`: this is the one read whose result set is the
      // whole table by definition, and an operator runs it on the log that has
      // been growing since the deployment started. The walk holds one row.
      //
      // Ordered by `id` for the reason `page` is: it is the order the log was
      // appended in, and the chain was built in that order. Every column, because
      // the preimage covers every column — `AUDIT_COLUMNS` is the same list the
      // writer bound, which is what makes recomputation here the same arithmetic
      // that happened there.
      const walk = db
        .prepare(`SELECT ${AUDIT_COLUMNS} FROM tool_call_audit ORDER BY id`)
        .iterate() as Iterable<Record<string, unknown>>;

      let prev: string = AUDIT_CHAIN_GENESIS;
      let rows = 0;
      for (const row of walk) {
        const id = row["id"] as number;
        // The link first. A row whose predecessor is wrong has a `row_hash` that
        // may well recompute correctly over its own columns — a deleted row
        // leaves its successor entirely intact — so checking the content first
        // would answer `content` for an event that is nothing of the kind.
        if (row["prev_hash"] !== prev) {
          return { ok: false, verified: rows, brokenAt: id, reason: "link" } as const;
        }
        if (auditRowHash(prev, auditRowValuesOf(row)) !== row["row_hash"]) {
          return { ok: false, verified: rows, brokenAt: id, reason: "content" } as const;
        }
        prev = row["row_hash"] as string;
        rows += 1;
      }

      // An empty log passes, and its tip is the genesis. That is the honest
      // answer rather than a special case: nothing has been written, so nothing
      // has been altered, and the value that commits to no rows is the value the
      // first row will chain from.
      return { ok: true, rows, tip: prev } as const;
    },

    close() {
      db.close();
    }
  };
}

/**
 * Which columns does the table have? Structural, from SQLite's own catalogue.
 *
 * `PRAGMA table_info` answers a structural question with a structural API, which
 * is what separates it from the move `migrate` rejects below: sniffing a *CHECK
 * constraint* out of `sqlite_master.sql` with a substring test is guessing at
 * SQL text, and this is asking SQLite what the columns are.
 *
 * A set rather than the per-column predicate this used to be. #62 added three
 * columns and three call sites to go with them; asking once and testing
 * `CHAINED_COLUMNS` against the answer means the next version adds none.
 *
 * The table name is a module-private literal at every call site, as it is for
 * `auditTableDdl`, and cannot be input.
 */
function columnNames(db: DatabaseSync, table: string): ReadonlySet<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(entry => entry["name"] as string)
  );
}

/**
 * Rebuild the audit table into the shape this build writes, keeping every row.
 *
 * One procedure rather than one per version pair, and the reason is
 * `auditTableDdl`: it is by construction the *current* table, so a
 * `migrateV2ToV3` could not build a v2 table to hand to a `migrateV1ToV2`
 * without a frozen v2 DDL literal — the second copy of the columns that
 * `auditTableDdl`'s doc exists to prevent, and one no test could catch drifting,
 * because the test that compares a migrated file to a created one only knows
 * about current. A ladder would also rebuild a v1 file twice, switching the
 * append-only property off twice, to produce an intermediate discarded
 * immediately. So `migrate` fans in here instead, and this function's only
 * concern is what the *source* table can give it.
 *
 * **v1 has no `ticket`, v2 and v3 differ in no column at all** — v3 is a pure
 * CHECK widening — and v4 added #62's three, so the copy takes each column when
 * the old table has one and `NULL` when it does not. Asking the table rather
 * than the version number is what makes the no-stamp case below safe.
 *
 * **v5 is where this stopped being a bulk copy** (#354). Each row's hash depends
 * on the row before it, so the `INSERT … SELECT` became a loop that carries the
 * tip forward. Two consequences worth having in front of you:
 *
 * The rows are chained **as of this migration**. That is a real guarantee — from
 * here on an edit to any of them breaks the walk — and it is not the guarantee a
 * row written under v5 has, which is that it was chained at the moment it was
 * written. The README and the architecture page say so in those words. The
 * alternative considered was refusing a v4 file and making rotation the answer;
 * it was rejected because this log's entire value is not forgetting, and buying
 * evidence by discarding the evidence is a bad trade.
 *
 * And a file that already carries hashes keeps them, rather than being rechained
 * — see the comment on `chained` below for the attack that rules out.
 *
 * SQLite cannot alter a CHECK constraint in place, so widening one is
 * create-new / copy / drop / rename — the procedure the SQLite manual gives for
 * every otherwise-unsupported change.
 *
 * **All of it is one transaction**, including the version stamp the caller would
 * otherwise write afterwards. SQLite's DDL is transactional, so a crash at any
 * point rolls back to a complete, untouched v1 file and the next open re-runs
 * the whole thing. Stamping the version outside would leave a window where the
 * table is v2 and the file says v1, and the invariant worth having is that the
 * shape and the number commit together.
 *
 * **The triggers are dropped explicitly.** `DROP TABLE` removes a table's
 * triggers with it, and its implicit delete does not fire them, so in principle
 * neither statement is needed. They are here anyway: the whole append-only
 * property rests on those two triggers, that claim is a sentence in a manual,
 * and the cost of not depending on it is two statements. If the claim were
 * wrong, the drop would abort and the transaction would roll back — the right
 * failure, and not one to discover on an operator's disk.
 *
 * **`id` is copied explicitly.** It is the log's ordering and the cursor the
 * audit CLI bookmarks; letting SQLite reassign rowids would silently renumber
 * history.
 *
 * **No row can fail the new constraints**, and up to v4 that was one sentence:
 * each version's outcome vocabulary is a strict superset of the one before it,
 * and every added column was nullable. v5's two are NOT NULL, so the sentence it
 * needs is a different one — the loop below computes a value for every row it
 * copies, so no row reaches the constraint without one. Either way it is the
 * property `AUDIT_SCHEMA_VERSION`'s doc asks each new version to check for
 * itself, and the answer is not inherited.
 *
 * The scratch table is named for what it is rather than for a version. A
 * `tool_call_audit_v2` would have to be renamed — here and in the two tests that
 * assert it is gone afterwards — every time the version moves, and would be
 * actively misleading while building a v3.
 *
 * No `PRAGMA foreign_keys` dance — the manual's procedure begins by disabling
 * them and there is not one in either database here. No `VACUUM`: the rebuild
 * leaves free pages behind, and reclaiming them means rewriting the whole file
 * at startup for a log this module has already decided not to optimise for size.
 */
function rebuildAuditTable(db: DatabaseSync): void {
  // Read before the transaction opens: it is a question about the table as it
  // stands, and the answer decides the SELECT list below.
  const present = columnNames(db, "tool_call_audit");
  // A column the old table does not have is selected as `NULL`, which is what
  // "no such figure exists" already reads as on every row that predates it. So
  // the copy loses nothing and invents nothing — the check
  // `AUDIT_SCHEMA_VERSION` asks a new version to make for itself. It is aliased
  // back to the column's name so the loop below can read the row by name in
  // either case.
  const sourceList = CHAINED_COLUMNS.map(column =>
    present.has(column) ? column : `NULL AS ${column}`
  ).join(", ");
  // **A file that is already chained keeps its hashes rather than being given
  // new ones**, and the case is real: `schema_version` carries no triggers, so
  // an operator — or an attacker — can delete the stamp from a version 5 file
  // and make the next open rebuild it. Recomputing there would quietly re-bless
  // every row, including any that had been edited, which is precisely the
  // outcome the chain exists to prevent. This is the same hazard the no-stamp
  // case already had with `ticket`, one column later.
  const chained = present.has("prev_hash") && present.has("row_hash");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(auditTableDdl("tool_call_audit_rebuilt", false));
    // Row at a time rather than one `INSERT … SELECT`, because each row's hash
    // depends on the row before it and SQLite cannot compute one. `iterate`
    // rather than `all` so a large log is not held in memory at startup; the
    // source and destination are different tables, so reading one while writing
    // the other is safe, and the loop is consumed to exhaustion before the DROP
    // below — an early return would leave a cursor open on a table about to go.
    const copy = db.prepare(
      `INSERT INTO tool_call_audit_rebuilt (id, ${CHAINED_COLUMNS.join(", ")}, prev_hash, row_hash)
       VALUES (?, ${CHAINED_COLUMNS.map(() => "?").join(", ")}, ?, ?)`
    );
    const source = db.prepare(
      `SELECT id, ${sourceList}${chained ? ", prev_hash, row_hash" : ""}
         FROM tool_call_audit
        ORDER BY id`
    );

    let tip = AUDIT_CHAIN_GENESIS;
    for (const row of source.iterate() as Iterable<Record<string, unknown>>) {
      const values = Object.fromEntries(
        CHAINED_COLUMNS.map(column => [column, row[column] as string | number | null])
      ) as AuditRowValues;
      const prevHash = chained ? (row["prev_hash"] as string) : tip;
      const rowHash = chained ? (row["row_hash"] as string) : auditRowHash(tip, values);
      copy.run(
        row["id"] as number,
        ...CHAINED_COLUMNS.map(column => values[column]),
        prevHash,
        rowHash
      );
      tip = rowHash;
    }

    db.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_update");
    db.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_delete");
    db.exec("DROP TABLE tool_call_audit");
    db.exec("ALTER TABLE tool_call_audit_rebuilt RENAME TO tool_call_audit");
    db.exec(auditIndexDdl);
    db.exec(auditTriggerDdl);
    db.exec("DELETE FROM schema_version");
    db.exec(`INSERT INTO schema_version (version) VALUES (${AUDIT_SCHEMA_VERSION})`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Bring the file to the version this build writes, or refuse to start.
 *
 * A version we do not recognise still means refusing to start, as ./budget-db.ts
 * does and for the same reason. What changes is that the versions we *do*
 * recognise have a way forward — and they all take the same one, because
 * `rebuildAuditTable` asks the table what it can give rather than being told by
 * a version number. Adding version 5 to this list is the whole of adding a
 * migration from it, provided the rebuild can give every row a value for
 * everything the new table demands.
 *
 * **The absent-row case runs the rebuild too**, which is deliberate rather than
 * lazy. `db.exec(SCHEMA)` and the version stamp are two commits, so a process
 * that died between them left a file holding an older table and no version row —
 * and stamping that current without looking would produce a database that
 * accepts every write until the first row using a value the old CHECK never had,
 * and then fails a constraint nobody expects. On a file this build just created
 * the rebuild copies zero rows and costs a handful of DDL statements once, at
 * startup. The alternative is sniffing the constraint out of `sqlite_master.sql`
 * with a substring test, which is a clever way to be wrong later.
 *
 * That case is also why the rebuild reads `PRAGMA table_info` rather than
 * branching on the version here. `schema_version` carries no triggers, so an
 * operator can delete the stamp from a file that has rows in it — and a rebuild
 * that assumed the oldest shape would silently null every `ticket` in the one
 * file an operator cannot reconstruct.
 */
function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (row !== undefined && row.version === AUDIT_SCHEMA_VERSION) return;
  if (
    row === undefined ||
    row.version === 1 ||
    row.version === 2 ||
    row.version === 3 ||
    row.version === 4 ||
    row.version === 5
  ) {
    rebuildAuditTable(db);
    return;
  }
  throw new Error(
    `proxy audit: ${file} is schema version ${row.version}, and this build writes ` +
      `version ${AUDIT_SCHEMA_VERSION} with no migration from ${row.version}`
  );
}
