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
 * could answer (#124). No column changed.
 *
 * Both are *widenings*, and that is the property each version has to establish
 * for itself rather than inherit: v3 accepts every outcome v2 did, so no
 * existing row can fail the new constraint and the copy cannot be rejected. A
 * migration that *can* reject a row is a different kind of thing and needs a
 * different answer to "what happens to the rows that fail" — check this before
 * adding a version 4, and if that version adds a column rather than a value,
 * `rebuildAuditTable` is where every older source has to be given something for
 * it.
 *
 * A file from the future is still a startup failure, and so is a file from a
 * past this build has no migration from.
 */
export const AUDIT_SCHEMA_VERSION = 4;

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
    // No ON CONFLICT clause, deliberately: an upsert would fire the update
    // trigger, and there is nothing to conflict on anyway. Two calls that are
    // identical in every column are two rows, because they are two calls.
    append: db.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, budget_limit, day_spend_micro_usd,
          price_version, result_bytes, result_is_error, approver, ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.budgetLimit ?? null,
        record.daySpendMicroUsd ?? null,
        record.priceVersion ?? null,
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
 * A row as it was written, plus the id that orders the log.
 *
 * `id` is not on `AuditRecord` because the writer does not supply it — SQLite
 * assigns it. It is on the way back out because it is the log's own append
 * order and the cursor an export bookmarks, which is why `rebuildAuditTable`
 * copies it explicitly rather than letting a migration renumber history.
 */
export interface AuditEntry extends AuditRecord {
  readonly id: number;
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
  close(): void;
}

/**
 * Every column, named, in the table's declared order.
 *
 * Never `SELECT *`. The point is that this list and the INSERT's column list sit
 * on one screen, so a column added to one is visibly missing from the other —
 * and `rowToEntry` below reads by name, so a `SELECT *` that silently gained a
 * column would produce an entry that silently lacked it.
 */
const AUDIT_COLUMNS = `
  id, at, channel, requesting_user, task, request_id, call_id, server, tool,
  arguments_sha256, outcome, refusal_reason, budget_limit, day_spend_micro_usd,
  price_version, result_bytes, result_is_error, approver, ticket`;

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
    ...(row["ticket"] === null ? {} : { ticket: row["ticket"] as string })
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

    close() {
      db.close();
    }
  };
}

/**
 * Does the table have this column? Structural, from SQLite's own catalogue.
 *
 * `PRAGMA table_info` answers a structural question with a structural API, which
 * is what separates it from the move `migrate` rejects below: sniffing a *CHECK
 * constraint* out of `sqlite_master.sql` with a substring test is guessing at
 * SQL text, and this is asking SQLite what the columns are.
 *
 * The table name is a module-private literal at every call site, as it is for
 * `auditTableDdl`, and cannot be input.
 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry["name"] === column);
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
 * Today that is one column. **v1 has no `ticket` and v2 and v3 differ in no
 * column at all** — v3 is a pure CHECK widening — so the copy takes `ticket`
 * when the old table has one and `NULL` when it does not. Asking the table
 * rather than the version number is what makes the no-stamp case below safe.
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
 * **No row can fail the new constraint**, because each version's vocabulary is a
 * strict superset of the one before it. That is what makes this a widening
 * rather than a data question, and it is the property `AUDIT_SCHEMA_VERSION`'s
 * doc asks each new version to check for itself.
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
  // stands, and the answer decides one expression in the copy below.
  const ticket = hasColumn(db, "tool_call_audit", "ticket") ? "ticket" : "NULL";
  // #62's three, each answered the same way: a row written before the column
  // existed had no such figure, and `NULL` is what "no figure exists" already
  // reads as on every row that was never priced. So the copy loses nothing and
  // invents nothing — which is the check `AUDIT_SCHEMA_VERSION` asks a new
  // version to make for itself.
  const budgetLimit = hasColumn(db, "tool_call_audit", "budget_limit") ? "budget_limit" : "NULL";
  const daySpend = hasColumn(db, "tool_call_audit", "day_spend_micro_usd")
    ? "day_spend_micro_usd"
    : "NULL";
  const priceVersion = hasColumn(db, "tool_call_audit", "price_version") ? "price_version" : "NULL";

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(auditTableDdl("tool_call_audit_rebuilt", false));
    db.exec(`
      INSERT INTO tool_call_audit_rebuilt
        (id, at, channel, requesting_user, task, request_id, call_id, server, tool,
         arguments_sha256, outcome, refusal_reason, budget_limit, day_spend_micro_usd,
         price_version, result_bytes, result_is_error, approver, ticket)
      SELECT
         id, at, channel, requesting_user, task, request_id, call_id, server, tool,
         arguments_sha256, outcome, refusal_reason, ${budgetLimit}, ${daySpend},
         ${priceVersion}, result_bytes, result_is_error, approver, ${ticket}
        FROM tool_call_audit
       ORDER BY id
    `);
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
 * a version number. Adding version 4 to this list is the whole of adding a
 * migration from it, provided that version is a widening.
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
  if (row === undefined || row.version === 1 || row.version === 2 || row.version === 3) {
    rebuildAuditTable(db);
    return;
  }
  throw new Error(
    `proxy audit: ${file} is schema version ${row.version}, and this build writes ` +
      `version ${AUDIT_SCHEMA_VERSION} with no migration from ${row.version}`
  );
}
