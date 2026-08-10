import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditRecord } from "@getlibero/schema";
import { AUDIT_SCHEMA_VERSION, openAuditDb } from "./audit-db.js";
import type { AuditDb } from "./audit-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);

/**
 * A record with every required field and no optional one. The optional fields
 * are added per test rather than cleared, because `exactOptionalPropertyTypes`
 * makes "present and undefined" a different thing from absent — which is the
 * distinction the null columns below are about.
 */
function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    at: NOON,
    channel: CHANNEL,
    requestingUser: "U0ALICE",
    task: "t-1",
    requestId: "r-1",
    callId: "toolu_01",
    server: "github",
    tool: "create_issue",
    argumentsSha256: "a".repeat(64),
    outcome: "ran",
    ...overrides
  };
}

/** Every row, read the way the audit CLI will: a second handle, its own SQL. */
function rows(path: string): Record<string, unknown>[] {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("SELECT * FROM tool_call_audit ORDER BY id").all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

let dir: string;
let file: string;
let db: AuditDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-audit-"));
  file = join(dir, "audit.db");
  db = openAuditDb({ file });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("appending", () => {
  it("writes every field the record carries", () => {
    db.append(record({ resultBytes: 12, resultIsError: false }));

    expect(rows(file)).toEqual([
      {
        id: 1,
        at: NOON,
        channel: CHANNEL,
        requesting_user: "U0ALICE",
        task: "t-1",
        request_id: "r-1",
        call_id: "toolu_01",
        server: "github",
        tool: "create_issue",
        arguments_sha256: "a".repeat(64),
        outcome: "ran",
        refusal_reason: null,
        result_bytes: 12,
        result_is_error: 0,
        approver: null,
        ticket: null
      }
    ]);
  });

  // The broker's three, which no /v1/tools/call request produces. Version 1
  // could not hold any of them — see the migration tests below.
  it("writes an approval decision with its approver and its ticket", () => {
    db.append(record({ outcome: "approved", approver: "U0BOSS", ticket: "tk-1" }));
    db.append(record({ outcome: "denied", approver: "U0BOSS", ticket: "tk-2" }));
    db.append(record({ outcome: "expired", ticket: "tk-3" }));

    expect(rows(file).map(row => [row.outcome, row.approver, row.ticket])).toEqual([
      ["approved", "U0BOSS", "tk-1"],
      ["denied", "U0BOSS", "tk-2"],
      ["expired", null, "tk-3"]
    ]);
  });

  // The row a decided call leaves when the handler failed before it could answer
  // (#124). Its result columns are null because the proxy could not measure a
  // result, not because there was none — and it can carry a ticket and an
  // approver, because a human can have approved the call that then went
  // unanswered.
  it("writes a call the proxy never answered, with or without an approval", () => {
    db.append(record({ outcome: "unanswered" }));
    db.append(record({ outcome: "unanswered", approver: "U0BOSS", ticket: "tk-4" }));

    expect(rows(file)).toHaveLength(2);
    expect(rows(file)[0]).toMatchObject({
      outcome: "unanswered",
      refusal_reason: null,
      result_bytes: null,
      result_is_error: null,
      approver: null,
      ticket: null
    });
    expect(rows(file)[1]).toMatchObject({ outcome: "unanswered", approver: "U0BOSS", ticket: "tk-4" });
  });

  // NULL and not 0. A refused call has no result, and a 0 would read as a tool
  // that ran and returned nothing.
  it("leaves the result columns null when the call did not run", () => {
    db.append(record({ outcome: "refused", refusalReason: "tool_not_allowed" }));

    expect(rows(file)[0]).toMatchObject({
      outcome: "refused",
      refusal_reason: "tool_not_allowed",
      result_bytes: null,
      result_is_error: null
    });
  });

  it("records a tool's own error without changing the proxy's outcome", () => {
    db.append(record({ resultBytes: 40, resultIsError: true }));

    expect(rows(file)[0]).toMatchObject({ outcome: "ran", result_is_error: 1 });
  });

  // An audit log records that something happened twice. A retry reuses the
  // model's tool-use id, so nothing may collapse the two.
  it("gives identical calls two rows in insertion order", () => {
    db.append(record());
    db.append(record());

    const written = rows(file);
    expect(written).toHaveLength(2);
    expect(written.map(row => row.id)).toEqual([1, 2]);
  });

  it("refuses an outcome outside the vocabulary", () => {
    expect(() => db.append(record({ outcome: "succeeded" as AuditRecord["outcome"] }))).toThrow();
  });
});

describe("append-only", () => {
  beforeEach(() => {
    db.append(record());
  });

  it("refuses an UPDATE, whole-table or by id", () => {
    const raw = new DatabaseSync(file);
    try {
      expect(() => raw.exec("UPDATE tool_call_audit SET tool = 'something_else'")).toThrow(/append-only/);
      expect(() => raw.exec("UPDATE tool_call_audit SET outcome = 'refused' WHERE id = 1")).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    expect(rows(file)[0]).toMatchObject({ tool: "create_issue", outcome: "ran" });
  });

  it("refuses a DELETE, whole-table or by id", () => {
    const raw = new DatabaseSync(file);
    try {
      expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM tool_call_audit WHERE id = 1")).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    expect(rows(file)).toHaveLength(1);
  });

  // The triggers live in the file's schema, so they must hold for a connection
  // that did not create it — an operator with sqlite3, or the audit CLI.
  it("holds for a handle that opened the file afterwards", () => {
    db.close();
    db = openAuditDb({ file });

    const raw = new DatabaseSync(file);
    try {
      expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
      expect(() => raw.exec("UPDATE tool_call_audit SET task = 'x'")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });
});

describe("isolation", () => {
  // The property the whole layout rests on: one table, and two channels'
  // calls still tell apart. There is no cross-channel join to make here
  // because there is no read method at all — see the surface test below.
  it("keeps two channels' rows distinguishable", () => {
    db.append(record({ channel: CHANNEL, callId: "toolu_01" }));
    db.append(record({ channel: OTHER, callId: "toolu_02" }));

    const written = rows(file);
    expect(written.map(row => row.channel)).toEqual([CHANNEL, OTHER]);
    expect(written.filter(row => row.channel === OTHER).map(row => row.call_id)).toEqual(["toolu_02"]);
  });

  // A regression test for the forward rule, not a tautology: the serving
  // process must never gain a way to read the log or to close it out from
  // under itself. A read method belongs on the operator path (#98).
  it("exposes appending and closing, and nothing else", () => {
    expect(Object.keys(db).sort()).toEqual(["append", "close"]);
  });
});

describe("durability", () => {
  it("reads back what it wrote before the process went away", () => {
    db.append(record());
    db.close();

    db = openAuditDb({ file });
    expect(rows(file)).toHaveLength(1);
  });

  // What `synchronous = FULL` buys. A proxy killed mid-call must not lose the
  // row for a call it already recorded.
  it("keeps a row written by a process that was killed without closing", () => {
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.prepare(
        "INSERT INTO tool_call_audit (at, channel, requesting_user, task, request_id, call_id, server, tool, arguments_sha256, outcome) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(${NOON}, "${CHANNEL}", "U0ALICE", "t-kill", "r-kill", "toolu_kill", "github", "create_issue", "b".repeat(64), "ran");
      process.kill(process.pid, "SIGKILL");
    `;

    const killed = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(killed.signal).toBe("SIGKILL");

    expect(rows(file).map(row => row.task)).toContain("t-kill");
  });

  // WAL. The audit CLI reads this file while the proxy is serving into it.
  it("shows a second handle rows the first has written", () => {
    db.append(record());

    const reader = new DatabaseSync(file);
    try {
      const count = reader.prepare("SELECT COUNT(*) AS n FROM tool_call_audit").get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      reader.close();
    }
  });
});

describe("opening", () => {
  it("stamps its schema version on a new file", () => {
    const raw = new DatabaseSync(file);
    try {
      expect(raw.prepare("SELECT version FROM schema_version").get()).toEqual({
        version: AUDIT_SCHEMA_VERSION
      });
    } finally {
      raw.close();
    }
  });

  it("refuses a file written by a build it does not recognise", () => {
    db.close();
    bumpVersionTo(file, AUDIT_SCHEMA_VERSION + 1);

    expect(() => openAuditDb({ file })).toThrow(/schema version/);

    db = openAuditDb({ file: join(dir, "replacement.db") });
  });

  // No mkdir, so a path nobody meant is a startup failure with the path named
  // rather than an audit log written where no operator will look for it.
  it("does not create a missing directory", () => {
    expect(() => openAuditDb({ file: join(dir, "nope", "audit.db") })).toThrow();
  });
});

/** Reaches past the module's API on purpose: nothing else can forge a version. */
function bumpVersionTo(path: string, version: number): void {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE schema_version SET version = ?").run(version);
  raw.close();
}

/**
 * The version 1 schema, verbatim as it shipped.
 *
 * **A frozen fixture, not a live statement.** It is a copy of a schema that is
 * on operators' disks and can never change again, which is why it may sit
 * outside ./audit-db.ts without bending that module's one-file-for-SQL rule:
 * nothing runs it against a database the proxy serves from. Its whole job is to
 * make a real version 1 file for the migration to be tested against, because a
 * migration tested only against a file the current build wrote is a migration
 * tested against nothing.
 */
const V1_SCHEMA = `
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

/** A version 1 file with `count` rows in it, as the previous build left one. */
function writeV1File(path: string, count: number): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(V1_SCHEMA);
    raw.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    const insert = raw.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error, approver)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let n = 1; n <= count; n += 1) {
      insert.run(NOON + n, CHANNEL, "U0ALICE", `t-${n}`, `r-${n}`, `toolu_${n}`, "github", "create_issue", "c".repeat(64), "ran", null, 10, 0, null);
    }
  } finally {
    raw.close();
  }
}

/**
 * The version 2 schema, verbatim as it shipped. A frozen fixture on V1_SCHEMA's
 * argument, and frozen for the same reason: v2 is now a shape on operators'
 * disks that can never change again.
 *
 * It differs from v1 by the three broker outcomes and the `ticket` column, and
 * from v3 by nothing but the CHECK — which is exactly what the block below is
 * for. A v2 file copied with v1's assumptions would still pass every row and
 * column assertion and silently lose every ticket.
 */
const V2_SCHEMA = `
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
  outcome          TEXT    NOT NULL CHECK (outcome IN
                     ('ran', 'held', 'refused', 'unavailable', 'approved', 'denied', 'expired')),
  refusal_reason   TEXT,
  result_bytes     INTEGER,
  result_is_error  INTEGER,
  approver         TEXT,
  ticket           TEXT
);

CREATE INDEX IF NOT EXISTS tool_call_audit_channel_at ON tool_call_audit (channel, at);
CREATE INDEX IF NOT EXISTS tool_call_audit_channel_task ON tool_call_audit (channel, task);
CREATE INDEX IF NOT EXISTS tool_call_audit_ticket ON tool_call_audit (ticket) WHERE ticket IS NOT NULL;

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
 * A version 2 file with `count` rows in it, every one carrying a ticket.
 *
 * Every row, rather than some: the column exists to tie an approval's lifecycle
 * together, and a fixture where it were mostly null would let a migration that
 * dropped it look almost right.
 */
function writeV2File(path: string, count: number): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(V2_SCHEMA);
    raw.prepare("INSERT INTO schema_version (version) VALUES (2)").run();
    const insert = raw.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, result_bytes, result_is_error, approver, ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let n = 1; n <= count; n += 1) {
      insert.run(NOON + n, CHANNEL, "U0ALICE", `t-${n}`, `r-${n}`, `toolu_${n}`, "github", "merge_pr", "c".repeat(64), "ran", null, 10, 0, "U0BOSS", `tk-${n}`);
    }
  } finally {
    raw.close();
  }
}

/** What SQLite says a table is, normalised for the quoting a RENAME leaves. */
function tableSql(path: string, table: string): string {
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { sql: string }
      | undefined;
    return (row?.sql ?? "").replace(/"/g, "").replace(/\s+/g, " ").trim();
  } finally {
    raw.close();
  }
}

function versionOf(path: string): number | undefined {
  const raw = new DatabaseSync(path);
  try {
    return (raw.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)?.version;
  } finally {
    raw.close();
  }
}

describe("migrating a version 1 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v1.db");
    writeV1File(old, 3);
  });

  it("keeps every row, its id, and its order", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      const after = rows(old);
      expect(after.map(row => row.id)).toEqual([1, 2, 3]);
      expect(after.map(row => row.task)).toEqual(before.map(row => row.task));
      // Every v1 column survives untouched; the one v1 lacked is null on old rows.
      expect(after[0]).toEqual({ ...before[0], ticket: null });
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  // The regression test for "one rebuild, not a ladder". A v1 file reaches the
  // current version in a single pass rather than being copied once per version
  // it skipped — which is what lets `auditTableDdl` stay the only copy of the
  // columns, since a ladder would need a frozen intermediate DDL to build.
  it("reaches the current version in one rebuild, whatever it skipped", () => {
    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(3);
      expect(tableSql(old, "tool_call_audit_rebuilt")).toBe("");
      expect(rows(old)).toHaveLength(3);
    } finally {
      migrated.close();
    }
  });

  // The test that proves the migration was necessary at all rather than being
  // a schema-version bump with a rebuild bolted on.
  it("accepts an outcome the old constraint refused, and only afterwards", () => {
    const raw = new DatabaseSync(old);
    try {
      expect(() =>
        raw.exec(
          `INSERT INTO tool_call_audit
             (at, channel, requesting_user, task, request_id, call_id, server, tool,
              arguments_sha256, outcome)
           VALUES (${NOON}, '${CHANNEL}', 'U0ALICE', 't-x', 'r-x', 'toolu_x', 'github', 'merge_pr',
                   '${"d".repeat(64)}', 'denied')`
        )
      ).toThrow();
    } finally {
      raw.close();
    }

    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(record({ outcome: "denied", approver: "U0BOSS", ticket: "tk-1" }));
      expect(rows(old).at(-1)).toMatchObject({ outcome: "denied", approver: "U0BOSS", ticket: "tk-1" });
    } finally {
      migrated.close();
    }
  });

  // The most important one in this file. The rebuild is the single moment the
  // append-only property is deliberately switched off, and a migration that
  // forgot to put the triggers back would leave a log that silently permits
  // exactly what the whole table exists to prevent — with every test above
  // still passing.
  it("puts the append-only triggers back", () => {
    const migrated = openAuditDb({ file: old });
    try {
      const raw = new DatabaseSync(old);
      try {
        expect(() => raw.exec("UPDATE tool_call_audit SET tool = 'x'")).toThrow(/append-only/);
        expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
      } finally {
        raw.close();
      }
      expect(rows(old)).toHaveLength(3);
    } finally {
      migrated.close();
    }
  });

  // Atomicity. Forced by pre-creating the table the migration builds into, so
  // its very first statement fails and everything after it must not have run.
  it("leaves the file exactly as it was when the rebuild fails", () => {
    const before = rows(old);
    const blocker = new DatabaseSync(old);
    try {
      blocker.exec("CREATE TABLE tool_call_audit_rebuilt (id INTEGER PRIMARY KEY)");
    } finally {
      blocker.close();
    }

    expect(() => openAuditDb({ file: old })).toThrow();

    expect(rows(old)).toEqual(before);
    expect(versionOf(old)).toBe(1);
    const raw = new DatabaseSync(old);
    try {
      expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it("runs once and is a no-op on every open after it", () => {
    openAuditDb({ file: old }).close();
    const sqlAfterFirst = tableSql(old, "tool_call_audit");

    const second = openAuditDb({ file: old });
    try {
      expect(tableSql(old, "tool_call_audit")).toBe(sqlAfterFirst);
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old)).toHaveLength(3);
      // The scratch table is gone rather than left beside the real one.
      expect(tableSql(old, "tool_call_audit_rebuilt")).toBe("");
    } finally {
      second.close();
    }
  });

  // The reason auditTableDdl takes its table name as a parameter. Two copies of
  // the DDL would agree today and drift later, and the symptom would be a
  // database whose shape depends on how old it is.
  it("builds the same table a new file gets", () => {
    const migrated = openAuditDb({ file: old });
    try {
      const rebuilt = tableSql(old, "tool_call_audit");
      // Asserted rather than assumed: two empty strings compare equal, and a
      // typo in either table name would make this pass while comparing nothing.
      expect(rebuilt).toContain("ticket");
      expect(rebuilt).toBe(tableSql(file, "tool_call_audit"));
    } finally {
      migrated.close();
    }
  });

  // A file whose creation died between the table and the version stamp: the
  // table is v1-shaped and nothing says so. Stamping it current without looking
  // would pass every test here and fail on the first `denied` row in production.
  it("rebuilds a file that has a table but no version row", () => {
    const raw = new DatabaseSync(old);
    try {
      raw.exec("DELETE FROM schema_version");
    } finally {
      raw.close();
    }

    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      migrated.append(record({ outcome: "expired", ticket: "tk-9" }));
      expect(rows(old).at(-1)).toMatchObject({ outcome: "expired", ticket: "tk-9" });
    } finally {
      migrated.close();
    }
  });
});

describe("migrating a version 2 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v2.db");
    writeV2File(old, 3);
  });

  // The highest-value case in this file, and the one the rebuild's column check
  // exists for. v2 and v3 differ in no column, so a rebuild that assumed the
  // oldest source shape would copy NULL over every ticket — passing the row
  // count, the ids, the order, and every other column while quietly severing
  // every approval from the call it authorized.
  it("keeps every row, its id, its order, and its ticket", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      const after = rows(old);
      expect(after).toEqual(before);
      expect(after.map(row => row.ticket)).toEqual(["tk-1", "tk-2", "tk-3"]);
      expect(after.map(row => row.approver)).toEqual(["U0BOSS", "U0BOSS", "U0BOSS"]);
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  it("accepts an outcome the old constraint refused, and only afterwards", () => {
    const raw = new DatabaseSync(old);
    try {
      expect(() =>
        raw.exec(
          `INSERT INTO tool_call_audit
             (at, channel, requesting_user, task, request_id, call_id, server, tool,
              arguments_sha256, outcome)
           VALUES (${NOON}, '${CHANNEL}', 'U0ALICE', 't-x', 'r-x', 'toolu_x', 'github', 'merge_pr',
                   '${"d".repeat(64)}', 'unanswered')`
        )
      ).toThrow();
    } finally {
      raw.close();
    }

    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(record({ outcome: "unanswered", approver: "U0BOSS", ticket: "tk-1" }));
      expect(rows(old).at(-1)).toMatchObject({ outcome: "unanswered", approver: "U0BOSS", ticket: "tk-1" });
    } finally {
      migrated.close();
    }
  });

  it("puts the append-only triggers back", () => {
    const migrated = openAuditDb({ file: old });
    try {
      const raw = new DatabaseSync(old);
      try {
        expect(() => raw.exec("UPDATE tool_call_audit SET tool = 'x'")).toThrow(/append-only/);
        expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
      } finally {
        raw.close();
      }
      expect(rows(old)).toHaveLength(3);
    } finally {
      migrated.close();
    }
  });

  it("builds the same table a new file gets", () => {
    const migrated = openAuditDb({ file: old });
    try {
      const rebuilt = tableSql(old, "tool_call_audit");
      expect(rebuilt).toContain("unanswered");
      expect(rebuilt).toBe(tableSql(file, "tool_call_audit"));
    } finally {
      migrated.close();
    }
  });

  it("runs once and is a no-op on every open after it", () => {
    openAuditDb({ file: old }).close();
    const sqlAfterFirst = tableSql(old, "tool_call_audit");

    const second = openAuditDb({ file: old });
    try {
      expect(tableSql(old, "tool_call_audit")).toBe(sqlAfterFirst);
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old)).toHaveLength(3);
      expect(tableSql(old, "tool_call_audit_rebuilt")).toBe("");
    } finally {
      second.close();
    }
  });

  // `schema_version` carries no triggers, so an operator can delete the stamp
  // from a file that has rows in it. This is the case that makes the rebuild ask
  // `PRAGMA table_info` rather than branch on the version number: with no stamp
  // to read, the table itself is the only thing that knows it has tickets.
  it("keeps the tickets in a file whose version row was deleted", () => {
    const raw = new DatabaseSync(old);
    try {
      raw.exec("DELETE FROM schema_version");
    } finally {
      raw.close();
    }

    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old).map(row => row.ticket)).toEqual(["tk-1", "tk-2", "tk-3"]);
    } finally {
      migrated.close();
    }
  });
});
