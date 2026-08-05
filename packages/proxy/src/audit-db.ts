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
// serving path — the only other SQL is the `schema_version` bookkeeping at open
// — and the table refuses both from any connection.
//
// "Once the file is open" is doing real work in that sentence, and #125 is why.
// Widening the outcome vocabulary meant rebuilding the table, and SQLite cannot
// alter a CHECK constraint in place, so `migrateV1ToV2` below drops the two
// triggers, drops the table, and renames a copy over it. That is the one moment
// the append-only property is deliberately switched off, and it is confined to
// a single function that runs inside one transaction before `append` has been
// prepared and before the listener binds. Read the rule as: **the serving path
// has one statement; the open path may rebuild, once, transactionally, and puts
// the triggers back.** A DROP or an UPDATE anywhere else in this module is a
// review failure exactly as it was.
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
// mean an attacker holding the file cannot. Tamper *evidence* — hash-chaining
// rows so a deletion is detectable — is phase 5 on the roadmap and is
// deliberately not built here.
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
// Nothing here reads. The audit CLI (#98) adds the query statements — to this
// file, per the rule above — and the operator-shaped helpers beside it. Until
// then the only consumer is the route, and the route only writes.
//
// To ask what a request cost, join to the budget file by hand: rows here carry
// `task`, and `turn_report` over there carries turn ids shaped `<task>.<n>`.
// Deliberately by an operator across two files, and by no code in this package.
//
// `node:sqlite` for the reason ./budget-db.ts gives: it is built in, so the
// proxy gains no dependency and the license gate has nothing new to check.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { AuditRecord } from "@getlibero/schema";
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
 * added the `ticket` column. A file from the past now has exactly one path
 * forward — see `migrate` at the bottom of this file — and what makes that safe
 * is that the change is a *widening*: v2 accepts every outcome v1 did, so no
 * existing row can fail the new constraint and the copy cannot be rejected.
 * That property is worth checking before adding a version 3; a migration that
 * can reject a row is a different kind of thing and needs a different answer to
 * "what happens to the rows that fail".
 *
 * A file from the future is still a startup failure, and now so is a file from
 * a past this build has no migration from.
 */
export const AUDIT_SCHEMA_VERSION = 2;

/**
 * The table, parameterised on its name.
 *
 * One source for the DDL, because `migrateV1ToV2` has to build a table that is
 * *identical* to the one a fresh file gets and then rename it into place. Two
 * copies of these columns would agree on the day they were written and drift on
 * some later one, and the failure would be a database whose shape depends on how
 * old it is — which is the thing a schema version exists to make impossible.
 * There is a test that opens a created file and a migrated one and compares what
 * SQLite says the table is.
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
                     ('ran', 'held', 'refused', 'unavailable', 'approved', 'denied', 'expired')),
  refusal_reason   TEXT,
  result_bytes     INTEGER,
  result_is_error  INTEGER,
  approver         TEXT,
  ticket           TEXT
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
 * belongs on the operator path (#98) and must never appear on the interface the
 * serving process closes over. No delete, no update: those are what the table
 * refuses, and a method here would be a method that always throws.
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
    // No ON CONFLICT clause, deliberately: an upsert would fire the update
    // trigger, and there is nothing to conflict on anyway. Two calls that are
    // identical in every column are two rows, because they are two calls.
    append: db.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error, approver,
          ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
  } satisfies Record<string, StatementSync>;

  logger?.log("info", { event: "audit_opened", file });

  return {
    append(record) {
      statements.append.run(
        record.at,
        record.channel,
        record.requestingUser,
        record.task,
        record.requestId,
        record.callId,
        record.server,
        record.tool,
        record.argumentsSha256,
        record.outcome,
        record.refusalReason ?? null,
        record.resultBytes ?? null,
        // NULL rather than 0 when the call did not run: a refusal has no result,
        // and 0 would read as a tool that succeeded and said nothing.
        record.resultIsError === undefined ? null : record.resultIsError ? 1 : 0,
        record.approver ?? null,
        record.ticket ?? null
      );
    },

    close() {
      db.close();
    }
  };
}

/**
 * v1 → v2: `approved`, `denied`, and `expired` join the outcome vocabulary, and
 * rows gain the ticket that ties an approval's lifecycle together.
 *
 * The repository's first migration, so what it establishes matters as much as
 * what it does. SQLite cannot alter a CHECK constraint in place, so widening one
 * is create-new / copy / drop / rename — the procedure the SQLite manual gives
 * for every otherwise-unsupported change.
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
 * **No row can fail the new constraint**, because v2's vocabulary is a strict
 * superset of v1's. That is what makes this a widening rather than a data
 * question, and it is the property `AUDIT_SCHEMA_VERSION`'s doc asks a future
 * migration to check for itself.
 *
 * No `PRAGMA foreign_keys` dance — the manual's procedure begins by disabling
 * them and there is not one in either database here. No `VACUUM`: the rebuild
 * leaves free pages behind, and reclaiming them means rewriting the whole file
 * at startup for a log this module has already decided not to optimise for size.
 */
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(auditTableDdl("tool_call_audit_v2", false));
    db.exec(`
      INSERT INTO tool_call_audit_v2
        (id, at, channel, requesting_user, task, request_id, call_id, server, tool,
         arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error,
         approver, ticket)
      SELECT
         id, at, channel, requesting_user, task, request_id, call_id, server, tool,
         arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error,
         approver, NULL
        FROM tool_call_audit
       ORDER BY id
    `);
    db.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_update");
    db.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_delete");
    db.exec("DROP TABLE tool_call_audit");
    db.exec("ALTER TABLE tool_call_audit_v2 RENAME TO tool_call_audit");
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
 * does and for the same reason. What changes is that one version we *do*
 * recognise now has a way forward.
 *
 * **The absent-row case runs the rebuild too**, which is deliberate rather than
 * lazy. `db.exec(SCHEMA)` and the version stamp are two commits, so a process
 * that died between them left a file holding a v1 table and no version row —
 * and stamping that v2 without looking would produce a database that accepts
 * every write until the first `denied` row and then fails a CHECK nobody
 * expects. On a file this build just created the rebuild copies zero rows and
 * costs a handful of DDL statements once, at startup. The alternative is
 * sniffing the constraint out of `sqlite_master.sql` with a substring test,
 * which is a clever way to be wrong later.
 */
function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (row !== undefined && row.version === AUDIT_SCHEMA_VERSION) return;
  if (row === undefined || row.version === 1) {
    migrateV1ToV2(db);
    return;
  }
  throw new Error(
    `proxy audit: ${file} is schema version ${row.version}, and this build writes ` +
      `version ${AUDIT_SCHEMA_VERSION} with no migration from ${row.version}`
  );
}
