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
        approver: null
      }
    ]);
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
