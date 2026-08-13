import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditRecord } from "@getlibero/schema";
import { AUDIT_SCHEMA_VERSION, openAuditDb, openAuditReader } from "./audit-db.js";
import type { AuditDb, AuditReader } from "./audit-db.js";

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

/**
 * Every row, from a raw handle with its own SQL — so a row is checked from
 * outside the writer rather than through it. Not how the audit CLI reads: that
 * goes through `openAuditReader`, which is exercised in its own block below.
 */
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
        // #62's three. Null on a row that is neither a budget refusal nor a
        // priced decision, which is most rows — and null here reads as "no such
        // figure", never as zero.
        budget_limit: null,
        day_spend_micro_usd: null,
        price_version: null,
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
      // Every v1 column survives untouched; the four v1 lacked are null on old
      // rows. Null is the honest value rather than a gap — those rows really had
      // no ticket, no budget limit and no priced figure.
      expect(after[0]).toEqual({
        ...before[0],
        ticket: null,
        budget_limit: null,
        day_spend_micro_usd: null,
        price_version: null
      });
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
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
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

// #62's three columns. Their own block because what they assert is not that the
// writer stores what it is given — the block above covers that — but that null
// stays a *reading* rather than becoming a zero, which is the distinction the
// whole feature's honesty rests on.
describe("the priced columns", () => {
  it("stores a budget limit, a day figure, and the table that priced it", () => {
    db.append(
      record({
        outcome: "refused",
        refusalReason: "budget_exhausted",
        budgetLimit: "daily_usd",
        daySpendMicroUsd: 25_000_000,
        priceVersion: "a3f1c02e5b7d9e14"
      })
    );

    expect(rows(file)[0]).toMatchObject({
      budget_limit: "daily_usd",
      day_spend_micro_usd: 25_000_000,
      price_version: "a3f1c02e5b7d9e14"
    });
  });

  // A channel that priced nothing has no figure, and a channel that priced
  // nothing *and spent nothing* still has no figure. Zero would say the meter
  // computed a total and got nought, which is a different claim.
  it("keeps an absent figure absent rather than storing zero", () => {
    db.append(record({ outcome: "ran" }));

    const row = rows(file)[0];
    expect(row?.["day_spend_micro_usd"]).toBeNull();
    expect(row?.["price_version"]).toBeNull();
  });

  // A real zero is legal and distinct: a channel capped in dollars whose day has
  // cost nothing yet was priced, and the row says so.
  it("stores a genuine zero, which is not the same as absent", () => {
    db.append(record({ outcome: "ran", daySpendMicroUsd: 0, priceVersion: "a3f1c02e5b7d9e14" }));

    expect(rows(file)[0]).toMatchObject({ day_spend_micro_usd: 0, price_version: "a3f1c02e5b7d9e14" });
  });

  // The column is constrained to the sheet's own keys, so a limit that is not a
  // limit cannot reach the log even through a caller that bypassed the types.
  it("refuses a budget limit outside the three the meter keeps", () => {
    const raw = new DatabaseSync(file);
    try {
      expect(() =>
        raw
          .prepare(
            `INSERT INTO tool_call_audit
               (at, channel, requesting_user, task, request_id, call_id, server, tool,
                arguments_sha256, outcome, budget_limit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(NOON, CHANNEL, "U0ALICE", "t-1", "r-1", "toolu_1", "github", "x", "a".repeat(64), "refused", "daily_pounds")
      ).toThrow();
    } finally {
      raw.close();
    }
  });

  // The round trip, through the reader the audit CLI actually uses rather than
  // through raw SQL: a column the writer fills and the mapper drops is an empty
  // field in a CSV nobody notices.
  it("reads the three back out through the reader", () => {
    db.append(
      record({
        outcome: "refused",
        refusalReason: "budget_exhausted",
        budgetLimit: "daily_usd",
        daySpendMicroUsd: 25_000_000,
        priceVersion: "a3f1c02e5b7d9e14"
      })
    );
    db.close();

    const reader = openAuditReader({ file });
    try {
      const [entry] = reader.page({});
      expect(entry).toMatchObject({
        budgetLimit: "daily_usd",
        daySpendMicroUsd: 25_000_000,
        priceVersion: "a3f1c02e5b7d9e14"
      });
    } finally {
      reader.close();
      db = openAuditDb({ file });
    }
  });
});

// Version 3 is version 2's table with a wider CHECK, so a v3 file is a v2
// fixture with a different stamp — which is precisely why this case matters: the
// rebuild reads columns rather than the stamp, and v3 is the first source where
// the three columns #62 adds are the *only* difference.
describe("migrating a version 3 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v3.db");
    writeV2File(old, 3);
    const raw = new DatabaseSync(old);
    try {
      raw.prepare("UPDATE schema_version SET version = 3").run();
    } finally {
      raw.close();
    }
  });

  it("adds the three columns as null and keeps everything else", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old)).toEqual(
        before.map(row => ({
          ...row,
          budget_limit: null,
          day_spend_micro_usd: null,
          price_version: null
        }))
      );
    } finally {
      migrated.close();
    }
  });

  it("stores a priced row afterwards, which the old table had nowhere to put", () => {
    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(
        record({
          outcome: "refused",
          refusalReason: "budget_exhausted",
          budgetLimit: "daily_usd",
          daySpendMicroUsd: 4_120_000,
          priceVersion: "a3f1c02e5b7d9e14"
        })
      );
      expect(rows(old).at(-1)).toMatchObject({
        budget_limit: "daily_usd",
        day_spend_micro_usd: 4_120_000,
        price_version: "a3f1c02e5b7d9e14"
      });
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
      // Every v2 column unchanged, plus #62's three as null: those rows carried
      // no priced figure because nothing was priced when they were written.
      expect(after).toEqual(
        before.map(row => ({
          ...row,
          budget_limit: null,
          day_spend_micro_usd: null,
          price_version: null
        }))
      );
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

describe("reading it back", () => {
  const NOT_NOON = NOON + 60_000;

  /** A file with a known spread of rows, in a known order. */
  function seed(): void {
    db.append(record({ at: NOON, channel: CHANNEL, server: "github", tool: "list_prs", outcome: "ran", resultBytes: 16, resultIsError: false, task: "t-1" }));
    db.append(record({ at: NOON + 1, channel: CHANNEL, server: "github", tool: "delete_repo", outcome: "refused", refusalReason: "tool_not_allowed", task: "t-1" }));
    db.append(record({ at: NOT_NOON, channel: OTHER, server: "stripe", tool: "create_refund", outcome: "held", refusalReason: "approval_required", ticket: "tk-1", task: "t-2" }));
    db.append(record({ at: NOT_NOON + 1, channel: OTHER, server: "stripe", tool: "create_refund", outcome: "approved", approver: "U0BOSS", ticket: "tk-1", task: "t-2" }));
    db.append(record({ at: NOT_NOON + 2, channel: OTHER, server: "stripe", tool: "create_refund", outcome: "ran", approver: "U0BOSS", ticket: "tk-1", resultBytes: 40, resultIsError: true, task: "t-2" }));
  }

  function read<T>(use: (reader: AuditReader) => T): T {
    const reader = openAuditReader({ file });
    try {
      return use(reader);
    } finally {
      reader.close();
    }
  }

  beforeEach(seed);

  describe("the connection", () => {
    // The property the whole read path rests on, asserted against SQLite rather
    // than against the triggers: a read-only connection refuses a write before
    // the append-only triggers have to.
    it("refuses every write, including the ones the triggers would catch", () => {
      read(() => {
        const raw = new DatabaseSync(file, { readOnly: true });
        try {
          expect(() => raw.exec("INSERT INTO tool_call_audit (at) VALUES (1)")).toThrow();
          expect(() => raw.exec("UPDATE tool_call_audit SET tool = 'x'")).toThrow();
          expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow();
          expect(() => raw.exec("DROP TABLE tool_call_audit")).toThrow();
        } finally {
          raw.close();
        }
      });
      expect(rows(file)).toHaveLength(5);
    });

    // Migrating is writing, so a reader that repaired a file would be a reader
    // that changed the evidence. Both directions, because a file from the
    // future read with this build's column list would quietly omit a column.
    it("refuses a file from another schema version, in both directions", () => {
      for (const version of [2, 99]) {
        const other = join(dir, `v${version}.db`);
        const raw = new DatabaseSync(other);
        try {
          raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
          raw.exec(`INSERT INTO schema_version (version) VALUES (${version})`);
        } finally {
          raw.close();
        }
        expect(() => openAuditReader({ file: other })).toThrow(new RegExp(`version ${version}`));
      }
    });

    it("refuses a file with no version stamp", () => {
      const bare = join(dir, "bare.db");
      const raw = new DatabaseSync(bare);
      try {
        raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
      } finally {
        raw.close();
      }
      expect(() => openAuditReader({ file: bare })).toThrow(/unstamped/);
    });

    // The reader's half of the writer's absent mkdir: a path nobody meant is an
    // error rather than an empty database that looks like an empty log.
    it("does not create a file that is not there", () => {
      const missing = join(dir, "nope.db");
      expect(() => openAuditReader({ file: missing })).toThrow();
      expect(existsSync(missing)).toBe(false);
    });
  });

  describe("page", () => {
    it("returns every row oldest-first when nothing is asked of it", () => {
      expect(read(r => r.page({}).map(e => e.id))).toEqual([1, 2, 3, 4, 5]);
    });

    // A limit is "the most recent n", still printed in reading order — which is
    // why the statement is a subquery rather than an ORDER BY with a LIMIT.
    it("takes the most recent n and still answers oldest-first", () => {
      expect(read(r => r.page({ limit: 2 }).map(e => e.id))).toEqual([4, 5]);
      expect(read(r => r.page({ limit: 0 }).map(e => e.id))).toEqual([1, 2, 3, 4, 5]);
      expect(read(r => r.page({ limit: 99 }).map(e => e.id))).toEqual([1, 2, 3, 4, 5]);
    });

    it("filters on each field on its own", () => {
      expect(read(r => r.page({ channel: CHANNEL }).map(e => e.id))).toEqual([1, 2]);
      expect(read(r => r.page({ server: "stripe" }).map(e => e.id))).toEqual([3, 4, 5]);
      expect(read(r => r.page({ tool: "delete_repo" }).map(e => e.id))).toEqual([2]);
      expect(read(r => r.page({ task: "t-2" }).map(e => e.id))).toEqual([3, 4, 5]);
      expect(read(r => r.page({ afterId: 3 }).map(e => e.id))).toEqual([4, 5]);
      expect(read(r => r.page({ outcomes: ["ran"] }).map(e => e.id))).toEqual([1, 5]);
    });

    // Both ends inclusive: an operator asking for a moment means the moment.
    it("bounds time at both ends, inclusively", () => {
      expect(read(r => r.page({ sinceMs: NOON + 1 }).map(e => e.id))).toEqual([2, 3, 4, 5]);
      expect(read(r => r.page({ untilMs: NOON + 1 }).map(e => e.id))).toEqual([1, 2]);
      expect(read(r => r.page({ sinceMs: NOON, untilMs: NOON }).map(e => e.id))).toEqual([1]);
    });

    it("takes several outcomes at once", () => {
      expect(read(r => r.page({ outcomes: ["held", "approved"] }).map(e => e.id))).toEqual([3, 4]);
      // An empty list is not a filter that matches nothing: it is no filter.
      expect(read(r => r.page({ outcomes: [] }).map(e => e.id))).toEqual([1, 2, 3, 4, 5]);
    });

    // The acceptance criterion's "filters compose", at the level that decides
    // it: every clause is ANDed and each contributes its own bound parameter.
    it("composes filters with AND", () => {
      expect(
        read(r => r.page({ channel: OTHER, server: "stripe", outcomes: ["ran", "approved"], sinceMs: NOT_NOON + 1 }).map(e => e.id))
      ).toEqual([4, 5]);
      // A composition nothing satisfies is empty rather than an error.
      expect(read(r => r.page({ channel: CHANNEL, server: "stripe" }))).toEqual([]);
    });

    // Values are bound, never concatenated, so a filter carrying SQL is a
    // filter that matches nothing.
    it("binds filter values rather than splicing them", () => {
      expect(read(r => r.page({ channel: "' OR 1=1 --" }))).toEqual([]);
      expect(read(r => r.page({ tool: "'; DROP TABLE tool_call_audit; --" }))).toEqual([]);
      expect(rows(file)).toHaveLength(5);
    });
  });

  it("counts the matches a page was taken from, ignoring the limit", () => {
    expect(read(r => r.count({}))).toBe(5);
    expect(read(r => r.count({ limit: 2 }))).toBe(5);
    expect(read(r => r.count({ channel: CHANNEL }))).toBe(2);
    expect(read(r => r.count({ channel: "C0NOBODY" }))).toBe(0);
  });

  describe("one row and one lifecycle", () => {
    // The absent-versus-falsy distinction, which is the reason rowToEntry
    // spreads conditionally rather than assigning undefined.
    it("round-trips a record field for field, absences included", () => {
      const entry = read(r => r.byId(1));
      expect(entry).toMatchObject({
        id: 1,
        at: NOON,
        channel: CHANNEL,
        requestingUser: "U0ALICE",
        server: "github",
        tool: "list_prs",
        outcome: "ran",
        resultBytes: 16,
        resultIsError: false
      });
      expect(entry && "refusalReason" in entry).toBe(false);
      expect(entry && "approver" in entry).toBe(false);
      expect(entry && "ticket" in entry).toBe(false);
    });

    it("tells a missing result from one of zero", () => {
      db.append(record({ at: NOON + 500, outcome: "unanswered", ticket: "tk-9" }));
      const entry = read(r => r.byId(6));
      expect(entry?.outcome).toBe("unanswered");
      expect(entry && "resultBytes" in entry).toBe(false);
      expect(entry && "resultIsError" in entry).toBe(false);
    });

    it("answers nothing for an id that is not there", () => {
      expect(read(r => r.byId(4210))).toBeUndefined();
    });

    it("returns a ticket's whole lifecycle, oldest-first", () => {
      expect(read(r => r.byTicket("tk-1").map(e => [e.id, e.outcome]))).toEqual([
        [3, "held"],
        [4, "approved"],
        [5, "ran"]
      ]);
      expect(read(r => r.byTicket("tk-never"))).toEqual([]);
    });
  });

  describe("openApprovals", () => {
    // The two questions AuditOutcome's doc poses in prose. A ticket that
    // reached `ran` is closed; one that stopped at `held` or `approved` is not.
    it("finds a held call nobody resolved and an approval nobody redeemed", () => {
      db.append(record({ at: NOON + 100, channel: CHANNEL, outcome: "held", refusalReason: "approval_required", ticket: "tk-stuck" }));
      db.append(record({ at: NOON + 200, channel: CHANNEL, outcome: "held", refusalReason: "approval_required", ticket: "tk-unredeemed" }));
      db.append(record({ at: NOON + 300, channel: CHANNEL, outcome: "approved", approver: "U0BOSS", ticket: "tk-unredeemed" }));

      expect(read(r => r.openApprovals().map(e => [e.ticket, e.outcome]))).toEqual([
        ["tk-stuck", "held"],
        ["tk-unredeemed", "approved"]
      ]);
    });

    // tk-1 reached `ran`, so it is finished and must not appear.
    it("leaves out a ticket whose call already ran", () => {
      expect(read(r => r.openApprovals().map(e => e.ticket))).not.toContain("tk-1");
    });

    it("scopes to one channel when asked", () => {
      db.append(record({ at: NOON + 100, channel: CHANNEL, outcome: "held", refusalReason: "approval_required", ticket: "tk-here" }));
      db.append(record({ at: NOON + 200, channel: OTHER, outcome: "held", refusalReason: "approval_required", ticket: "tk-there" }));

      expect(read(r => r.openApprovals(CHANNEL).map(e => e.ticket))).toEqual(["tk-here"]);
      expect(read(r => r.openApprovals(OTHER).map(e => e.ticket))).toEqual(["tk-there"]);
    });
  });
});
