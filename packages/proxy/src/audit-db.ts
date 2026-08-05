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
// The claim to check here is narrower than the budget's and stronger: **this
// module only ever inserts.** There is no UPDATE and no DELETE in it, and the
// table refuses both from any connection.
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
 */
export const AUDIT_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_call_audit (
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
  outcome          TEXT    NOT NULL CHECK (outcome IN ('ran', 'held', 'refused', 'unavailable')),
  refusal_reason   TEXT,
  result_bytes     INTEGER,
  result_is_error  INTEGER,
  approver         TEXT
);

CREATE INDEX IF NOT EXISTS tool_call_audit_channel_at ON tool_call_audit (channel, at);
CREATE INDEX IF NOT EXISTS tool_call_audit_channel_task ON tool_call_audit (channel, task);

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
    checkVersion(db, file);
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
          arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error, approver)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.approver ?? null
      );
    },

    close() {
      db.close();
    }
  };
}

/**
 * Read the version, or claim the file if it has none. As ./budget-db.ts, and
 * the same reasoning: a row we do not recognise means refusing to start.
 */
function checkVersion(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(AUDIT_SCHEMA_VERSION);
    return;
  }
  if (row.version !== AUDIT_SCHEMA_VERSION) {
    throw new Error(
      `proxy audit: ${file} is schema version ${row.version}, and this build writes ` +
        `version ${AUDIT_SCHEMA_VERSION}`
    );
  }
}
