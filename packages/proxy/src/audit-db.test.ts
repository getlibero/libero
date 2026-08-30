import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { AuditRecord } from "@getlibero/schema";
import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_SCHEMA_VERSION,
  CHAINED_COLUMNS,
  auditRowHash,
  auditRowPreimage,
  auditRowValuesOf,
  openAuditDb,
  openAuditReader
} from "./audit-db.js";
import type { AuditChainVerdict, AuditDb, AuditReader, AuditRowValues } from "./audit-db.js";

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

/**
 * A row without the two columns the chain adds, for an assertion about the rest.
 *
 * The chain's own properties are asserted in `describe("the chain")` below; a
 * case about what a migration preserved should not have to carry a hash literal
 * that changes whenever any other column does.
 */
function unchained(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([name]) => name !== "prev_hash" && name !== "row_hash")
  );
}

/**
 * Walk the log and answer the id of the first row that does not verify, or
 * `undefined` when every row does.
 *
 * This is #354's round-trip: rows the writer produced are checked by
 * recomputing the hash from the row's own columns rather than by trusting the
 * column beside them. It deliberately re-derives `prev_hash` from the walk as
 * well as recomputing `row_hash`, because a chain whose links are each
 * self-consistent but which do not join is a deleted row.
 *
 * #355 is the operator command that does this against a real file; this is the
 * same walk in twenty lines, which is what makes the property testable now.
 */
function firstBrokenRow(path: string): number | undefined {
  let prev: string = AUDIT_CHAIN_GENESIS;
  for (const row of rows(path)) {
    if (row["prev_hash"] !== prev || auditRowHash(prev, auditRowValuesOf(row)) !== row["row_hash"]) {
      return row["id"] as number;
    }
    prev = row["row_hash"] as string;
  }
  return undefined;
}

/**
 * A connection with the append-only triggers taken off it.
 *
 * The actor the module header names and the triggers cannot stop: somebody who
 * holds the file. Every case in `describe("what the chain detects")` goes
 * through here, because a tamper the triggers already refuse would prove nothing
 * about the chain.
 */
function tamper(path: string, sql: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_update");
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_delete");
    raw.exec(sql);
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
        ticket: null,
        destination: null,
        result_bytes_by_type: null,
        // #354. The first row chains from the genesis constant, and its hash is
        // asserted by recomputation rather than as a literal — a literal here
        // would have to be regenerated from the code it is meant to check.
        prev_hash: AUDIT_CHAIN_GENESIS,
        row_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string
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
      ticket: null,
      destination: null
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

  // #501's half of "the audit row records what crossed": `result_bytes` says how
  // much, this says of what kinds and in what proportion.
  it("records what a multi-part result was made of", () => {
    db.append(record({ resultBytes: 5235, resultBytesByType: { image: 4823, text: 412 } }));

    expect(rows(file)[0]).toMatchObject({
      result_bytes: 5235,
      result_bytes_by_type: '{"image":4823,"text":412}'
    });
    const reader = openAuditReader({ file });
    try {
      expect(reader.page({})[0]?.resultBytesByType).toEqual({ image: 4823, text: 412 });
    } finally {
      reader.close();
    }
  });

  // Sorted, because this column is hashed: two rows recording the same result
  // must produce the same bytes, and object key order is the order a producer
  // happened to walk the blocks in.
  it("serializes the breakdown by sorted key, whatever order it was built in", () => {
    db.append(record({ resultBytes: 5235, resultBytesByType: { text: 412, image: 4823 } }));

    expect(rows(file)[0]?.["result_bytes_by_type"]).toBe('{"image":4823,"text":412}');
  });

  // Written whenever the total is, including on an all-text result: a reader
  // telling "all text" from "not recorded" needs the two to look different.
  it("leaves the breakdown null on exactly the rows the total is null on", () => {
    db.append(record({ outcome: "refused", refusalReason: "tool_not_allowed" }));

    expect(rows(file)[0]).toMatchObject({ result_bytes: null, result_bytes_by_type: null });
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

describe("the chain", () => {
  it("chains the first row from the genesis constant", () => {
    db.append(record());

    expect(rows(file)[0]?.["prev_hash"]).toBe(AUDIT_CHAIN_GENESIS);
  });

  it("links each row to the one before it", () => {
    db.append(record({ task: "t-1" }));
    db.append(record({ task: "t-2" }));
    db.append(record({ task: "t-3" }));

    const written = rows(file);
    expect(written.map(row => row["prev_hash"])).toEqual([
      AUDIT_CHAIN_GENESIS,
      written[0]?.["row_hash"],
      written[1]?.["row_hash"]
    ]);
  });

  // #354's round trip, and the acceptance criterion this block exists for.
  it("produces rows that verify by recomputation", () => {
    db.append(record({ resultBytes: 12, resultIsError: false }));
    db.append(record({ outcome: "refused", refusalReason: "budget_exhausted", budgetLimit: "daily_usd" }));
    db.append(record({ outcome: "approved", approver: "U0BOSS", ticket: "tk-1" }));

    expect(firstBrokenRow(file)).toBeUndefined();
  });

  // What makes a chain a chain rather than a per-row checksum: the same call
  // recorded twice does not hash the same, because its predecessor differs. A
  // per-row digest would let an attacker swap two identical rows, or splice one
  // in, without changing anything.
  it("gives two identical calls different hashes", () => {
    db.append(record());
    db.append(record());

    const [first, second] = rows(file);
    expect(second?.["row_hash"]).not.toBe(first?.["row_hash"]);
    expect(firstBrokenRow(file)).toBeUndefined();
  });

  // The tip is held in memory, so this is the case that proves it is *seeded*
  // from the file rather than reset. Without the read at open, a restarted proxy
  // would begin a second chain from the genesis constant and every walk over the
  // file would report a break at the first row written after the restart.
  it("carries the tip across a close and reopen", () => {
    db.append(record({ task: "before" }));
    db.close();

    const reopened = openAuditDb({ file });
    try {
      reopened.append(record({ task: "after" }));
    } finally {
      reopened.close();
    }
    db = openAuditDb({ file });

    expect(rows(file)).toHaveLength(2);
    expect(firstBrokenRow(file)).toBeUndefined();
  });

  // The append-only triggers stop UPDATE and DELETE and not INSERT, so anyone
  // holding the file can append to it. These two are what the unique index on
  // `prev_hash` buys, and without them the single-writer assumption would be a
  // sentence in the README rather than something SQLite checks.
  it("refuses a second row claiming the same predecessor", () => {
    db.append(record());
    const tip = rows(file)[0]?.["row_hash"] as string;

    const raw = new DatabaseSync(file);
    try {
      raw.exec(
        `INSERT INTO tool_call_audit
           (at, channel, requesting_user, task, request_id, call_id, server, tool,
            arguments_sha256, outcome, prev_hash, row_hash)
         VALUES (${NOON}, '${CHANNEL}', 'U0ALICE', 't-fork', 'r-fork', 'toolu_f', 'github',
                 'create_issue', '${"d".repeat(64)}', 'ran', '${tip}', '${"e".repeat(64)}')`
      );
    } finally {
      raw.close();
    }

    // The forged row took the tip's successor slot, so this proxy's next call
    // cannot be recorded — and a call that cannot be recorded is refused, which
    // is the rule the route already runs on. Loud, and deliberately not repaired
    // by re-seeding the tip: that would chain onto the forgery and carry on.
    expect(() => db.append(record({ task: "t-next" }))).toThrow();
    expect(rows(file).map(row => row.task)).toEqual(["t-1", "t-fork"]);
  });

  it("leaves the tip where it was when an append is refused", () => {
    db.append(record());
    const before = rows(file);

    const raw = new DatabaseSync(file);
    try {
      raw.exec("CREATE UNIQUE INDEX tmp_block ON tool_call_audit (task)");
    } finally {
      raw.close();
    }
    expect(() => db.append(record())).toThrow();
    const unblock = new DatabaseSync(file);
    try {
      unblock.exec("DROP INDEX tmp_block");
    } finally {
      unblock.close();
    }

    db.append(record({ task: "t-2" }));

    // Three rows would mean the refused attempt landed; a broken walk would mean
    // the writer advanced its tip past a row SQLite never took.
    expect(rows(file)).toHaveLength(before.length + 1);
    expect(firstBrokenRow(file)).toBeUndefined();
  });

  // The null-omitting encoding has to be unambiguous, or a row with a column
  // absent could serialize to the same bytes as one with it present. Two rows
  // differing in nothing but that are what tests it.
  it("hashes a null column differently from a present one", () => {
    // Each row is the first in its own file, so all three chain from the genesis
    // constant and the only thing that can differ between the preimages is the
    // column itself.
    const firstRowHash = (name: string, entry: AuditRecord): string => {
      const handle = openAuditDb({ file: join(dir, name) });
      try {
        handle.append(entry);
      } finally {
        handle.close();
      }
      return rows(join(dir, name))[0]?.["row_hash"] as string;
    };

    const present = firstRowHash("present.db", record({ resultBytes: 12 }));
    const absent = firstRowHash("absent.db", record());
    const absentAgain = firstRowHash("again.db", record());

    expect(present).not.toBe(absent);
    // The control: without it the case above also passes on an encoding that is
    // simply unstable, which would say nothing about how a null is treated.
    expect(absentAgain).toBe(absent);
  });
});

// The serialization is what the whole chain is denominated in, so a change to it
// invalidates every log on every operator's disk. These cases exist to make that
// change loud: it should fail here, with a readable diff, rather than silently
// somewhere a year from now.
describe("the canonical serialization", () => {
  const cells = (overrides: Partial<AuditRowValues> = {}): AuditRowValues => ({
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
    budget_limit: null,
    day_spend_micro_usd: null,
    price_version: null,
    result_bytes: null,
    result_is_error: null,
    approver: null,
    ticket: null,
    destination: null,
    result_bytes_by_type: null,
    ...overrides
  });

  // Pinned as bytes rather than as a digest of them, so that changing the
  // encoding fails with something a reviewer can read.
  it("is pinned, byte for byte", () => {
    expect(auditRowPreimage(AUDIT_CHAIN_GENESIS, cells())).toBe(
      `libero/tool_call_audit/chain/1\n${AUDIT_CHAIN_GENESIS}\n` +
        `{"at":${NOON},"channel":"${CHANNEL}","requesting_user":"U0ALICE","task":"t-1",` +
        `"request_id":"r-1","call_id":"toolu_01","server":"github","tool":"create_issue",` +
        `"arguments_sha256":"${"a".repeat(64)}","outcome":"ran"}`
    );
  });

  it("chains from a genesis that is 64 hex characters like every other link", () => {
    expect(AUDIT_CHAIN_GENESIS).toMatch(/^[0-9a-f]{64}$/);
  });

  // The property that lets the next widening leave every historical hash alone.
  it("omits a null column rather than encoding it", () => {
    expect(auditRowPreimage(AUDIT_CHAIN_GENESIS, cells())).not.toContain("ticket");
    expect(auditRowPreimage(AUDIT_CHAIN_GENESIS, cells({ ticket: "tk-1" }))).toContain('"ticket":"tk-1"');
  });

  // Version 6's column, asserted the same way — and this is the case that makes
  // "the v6 migration leaves every existing hash alone" a checked claim rather
  // than a paragraph in AUDIT_SCHEMA_VERSION's doc. A row with no destination
  // hashes to exactly what it hashed before the column existed.
  it("leaves a row without a destination hashing as it did before version 6", () => {
    const preimage = auditRowPreimage(AUDIT_CHAIN_GENESIS, cells());
    expect(preimage).not.toContain("destination");
    expect(auditRowPreimage(AUDIT_CHAIN_GENESIS, cells({ destination: "evil.example.com" }))).toContain(
      '"destination":"evil.example.com"'
    );
  });

  // Version 7's column, asserted the way version 6's is, and for the same
  // reason: it is what makes "the migration leaves every existing hash alone" a
  // checked claim rather than a paragraph in AUDIT_SCHEMA_VERSION's doc.
  it("leaves a row without a breakdown hashing as it did before version 7", () => {
    expect(auditRowPreimage(AUDIT_CHAIN_GENESIS, cells())).not.toContain("result_bytes_by_type");
    expect(
      auditRowPreimage(AUDIT_CHAIN_GENESIS, cells({ result_bytes_by_type: '{"image":4823}' }))
    ).toContain('"result_bytes_by_type":"{\\"image\\":4823}"');
  });

  it("keeps a numeric column and a text one carrying the same digits apart", () => {
    expect(auditRowHash(AUDIT_CHAIN_GENESIS, cells({ call_id: "12" }))).not.toBe(
      auditRowHash(AUDIT_CHAIN_GENESIS, cells({ call_id: 12 }))
    );
  });

  // `call_id` is model-authored and the schema bounds its length and not its
  // alphabet, so it is the column an attacker would write fields with. Escaping
  // both the key and the value is the only thing that stops them.
  it("cannot be forged by a value carrying the serialization's own punctuation", () => {
    const forged = auditRowHash(AUDIT_CHAIN_GENESIS, cells({ call_id: '","channel":"C0EVIL' }));
    const real = auditRowHash(AUDIT_CHAIN_GENESIS, cells({ channel: "C0EVIL" }));

    expect(forged).not.toBe(real);
  });

  // What stops a version 6 adding a column to the DDL and silently leaving it
  // out of the chain — which would be a row whose new column nothing vouches
  // for, in a table whose whole claim is that it does.
  it("covers every column the table has except the three it cannot", () => {
    const raw = new DatabaseSync(file);
    let names: string[];
    try {
      names = raw
        .prepare("PRAGMA table_info(tool_call_audit)")
        .all()
        .map(row => row["name"] as string);
    } finally {
      raw.close();
    }

    expect([...CHAINED_COLUMNS]).toEqual(
      names.filter(name => name !== "id" && name !== "prev_hash" && name !== "row_hash")
    );
  });

  it("refuses a row that is missing a column it has to cover", () => {
    expect(() => auditRowValuesOf({ at: NOON })).toThrow(/channel/);
  });
});

// The actor the triggers cannot stop, which is the whole reason this workstream
// exists: somebody holding the file, who drops the triggers before touching a
// row. #97 said in as many words that append-only does not cover this.
//
// What the chain does *not* catch is not tested here because it cannot be: an
// attacker who recomputes every hash after the row they edited leaves a file
// that verifies clean. That is stated in the module header and answered by
// #355's tip hash, anchored outside the file by the operator.
describe("what the chain detects", () => {
  beforeEach(() => {
    db.append(record({ task: "t-1" }));
    db.append(record({ task: "t-2" }));
    // A refusal, so the downgrade case below has something to downgrade. Three
    // rows that were all `ran` would let an UPDATE setting `ran` pass while
    // changing nothing, which is a test that cannot fail.
    db.append(record({ task: "t-3", outcome: "refused", refusalReason: "budget_exhausted" }));
  });

  it("names a row rewritten through a trigger-stripped connection", () => {
    tamper(file, "UPDATE tool_call_audit SET tool = 'delete_branch' WHERE id = 2");

    expect(firstBrokenRow(file)).toBe(2);
  });

  it("catches an outcome quietly downgraded to a success", () => {
    tamper(file, "UPDATE tool_call_audit SET outcome = 'ran', refusal_reason = NULL WHERE id = 3");

    expect(firstBrokenRow(file)).toBe(3);
  });

  it("catches a deleted row at the successor that no longer joins", () => {
    tamper(file, "DELETE FROM tool_call_audit WHERE id = 2");

    // Row 3, not row 2: the deleted row is gone, and what remains to be observed
    // is that row 3 claims a predecessor the file no longer holds. Naming the
    // first row that does not verify is the contract, and everything after a
    // break is unverifiable rather than vouched for.
    expect(firstBrokenRow(file)).toBe(3);
  });

  it("catches a row spliced in with a forged hash", () => {
    tamper(
      file,
      `INSERT INTO tool_call_audit
         (id, at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, prev_hash, row_hash)
       VALUES (99, ${NOON}, '${CHANNEL}', 'U0ALICE', 't-forged', 'r-forged', 'toolu_f',
               'github', 'delete_branch', '${"d".repeat(64)}', 'ran',
               '${"e".repeat(64)}', '${"f".repeat(64)}')`
    );

    expect(firstBrokenRow(file)).toBe(99);
  });

  // The negative control for this whole block: without it, every case above
  // also passes against a walk that reports a break on any file at all.
  it("reports nothing on the log it was given", () => {
    expect(firstBrokenRow(file)).toBeUndefined();
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
        "INSERT INTO tool_call_audit (at, channel, requesting_user, task, request_id, call_id, server, tool, arguments_sha256, outcome, prev_hash, row_hash) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(${NOON}, "${CHANNEL}", "U0ALICE", "t-kill", "r-kill", "toolu_kill", "github", "create_issue", "b".repeat(64), "ran", "c".repeat(64), "d".repeat(64));
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

/**
 * The version 4 schema, verbatim as it shipped. Frozen on V1_SCHEMA's argument.
 *
 * It differs from v5 by the two chain columns and by nothing else, which is what
 * the block below is for: v4 is the last shape written without a chain, so it is
 * the file that proves the migration can give every row a hash rather than
 * failing the NOT NULL it just declared.
 */
const V4_SCHEMA = `
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
                     ('ran', 'held', 'refused', 'unavailable', 'unanswered',
                      'approved', 'denied', 'expired')),
  refusal_reason   TEXT,
  budget_limit     TEXT CHECK (budget_limit IS NULL OR budget_limit IN
                     ('daily_tokens', 'daily_tool_calls', 'daily_usd')),
  day_spend_micro_usd INTEGER,
  price_version    TEXT,
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
 * The version 5 table: version 6 minus `destination`, and the shape a deployment
 * running the previous build has on disk right now.
 *
 * The migration that matters, in other words. v1 through v4 are the historical
 * ladder and this is the live rung — if #219's column can be added without
 * breaking a chain, this is the file that proves it, because its rows are
 * already hashed and those hashes must not move.
 */
const V5_SCHEMA = `
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
                     ('ran', 'held', 'refused', 'unavailable', 'unanswered',
                      'approved', 'denied', 'expired')),
  refusal_reason   TEXT,
  budget_limit     TEXT CHECK (budget_limit IS NULL OR budget_limit IN
                     ('daily_tokens', 'daily_tool_calls', 'daily_usd')),
  day_spend_micro_usd INTEGER,
  price_version    TEXT,
  result_bytes     INTEGER,
  result_is_error  INTEGER,
  approver         TEXT,
  ticket           TEXT,
  prev_hash        TEXT    NOT NULL CHECK (length(prev_hash) = 64),
  row_hash         TEXT    NOT NULL CHECK (length(row_hash) = 64)
);

CREATE INDEX IF NOT EXISTS tool_call_audit_channel_at ON tool_call_audit (channel, at);
CREATE INDEX IF NOT EXISTS tool_call_audit_channel_task ON tool_call_audit (channel, task);
CREATE INDEX IF NOT EXISTS tool_call_audit_ticket ON tool_call_audit (ticket) WHERE ticket IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tool_call_audit_prev_hash ON tool_call_audit (prev_hash);

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
 * A version 5 file with `count` chained rows in it.
 *
 * The hashes are computed with the *current* `auditRowHash`, which is the point
 * rather than a shortcut: `destination` and `result_bytes_by_type` are null on
 * every one of these rows and NULL columns are omitted from the preimage, so the
 * current function and the version 5 function produce identical bytes for
 * identical rows. If that ever stopped being true this fixture would stop
 * verifying, which is exactly the alarm wanted.
 */
/**
 * A version 6 file: the version 5 shape plus #219's `destination`.
 *
 * Built by migrating a version 5 file with this build's own rebuild and then
 * re-stamping it as 6, rather than by carrying a second frozen DDL. The rebuild
 * is version-blind — it reads `PRAGMA table_info` and selects NULL for a column
 * the old table lacks — so what it produces from a v5 file is the table a v6
 * build wrote, and the hashes it keeps are the ones a v6 build computed. A
 * frozen literal would be a second copy of the DDL to drift, which is the thing
 * `auditTableDdl`'s own header exists to prevent.
 *
 * This is the shape every deployed operator actually has, which is why it is
 * worth a fixture of its own on top of the v5 one.
 */
function writeV6File(path: string, count: number): void {
  writeV5File(path, count);
  openAuditDb({ file: path }).close();
  const raw = new DatabaseSync(path);
  try {
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_update");
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_delete");
    raw.exec("ALTER TABLE tool_call_audit DROP COLUMN result_bytes_by_type");
    raw.exec("UPDATE schema_version SET version = 6");
  } finally {
    raw.close();
  }
}

function writeV5File(path: string, count: number): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(V5_SCHEMA);
    raw.prepare("INSERT INTO schema_version (version) VALUES (5)").run();
    const insert = raw.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, budget_limit, day_spend_micro_usd,
          price_version, result_bytes, result_is_error, approver, ticket, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let prev: string = AUDIT_CHAIN_GENESIS;
    for (let n = 1; n <= count; n += 1) {
      const refused = n % 2 === 0;
      const values = {
        at: NOON + n,
        channel: CHANNEL,
        requesting_user: "U0ALICE",
        task: `t-${n}`,
        request_id: `r-${n}`,
        call_id: `toolu_${n}`,
        server: "github",
        tool: refused ? "merge_pr" : "create_issue",
        arguments_sha256: "d".repeat(64),
        outcome: refused ? "refused" : "ran",
        refusal_reason: refused ? "budget_exhausted" : null,
        budget_limit: refused ? "daily_usd" : null,
        day_spend_micro_usd: refused ? 5_000_000 : null,
        price_version: refused ? "sha256:abc" : null,
        result_bytes: refused ? null : 10,
        result_is_error: refused ? null : 0,
        approver: refused ? null : "U0BOSS",
        ticket: refused ? null : `tk-${n}`,
        destination: null,
        result_bytes_by_type: null
      } as const;
      const hash = auditRowHash(prev, values);
      insert.run(
        values.at, values.channel, values.requesting_user, values.task, values.request_id,
        values.call_id, values.server, values.tool, values.arguments_sha256, values.outcome,
        values.refusal_reason, values.budget_limit, values.day_spend_micro_usd,
        values.price_version, values.result_bytes, values.result_is_error, values.approver,
        values.ticket, prev, hash
      );
      prev = hash;
    }
  } finally {
    raw.close();
  }
}

/**
 * A version 4 file with `count` rows in it.
 *
 * Rows differ from one another in more than their ids, and one of them is a
 * budget refusal carrying #62's three columns — so a chain computed over them
 * is computed over a mix of present and null values rather than over rows that
 * happen to serialize alike.
 */
function writeV4File(path: string, count: number): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(V4_SCHEMA);
    raw.prepare("INSERT INTO schema_version (version) VALUES (4)").run();
    const insert = raw.prepare(
      `INSERT INTO tool_call_audit
         (at, channel, requesting_user, task, request_id, call_id, server, tool,
          arguments_sha256, outcome, refusal_reason, budget_limit, day_spend_micro_usd,
          price_version, result_bytes, result_is_error, approver, ticket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let n = 1; n <= count; n += 1) {
      const refused = n % 2 === 0;
      insert.run(
        NOON + n, CHANNEL, "U0ALICE", `t-${n}`, `r-${n}`, `toolu_${n}`, "github",
        refused ? "merge_pr" : "create_issue", "c".repeat(64),
        refused ? "refused" : "ran",
        refused ? "budget_exhausted" : null,
        refused ? "daily_usd" : null,
        refused ? 5_000_000 : null,
        refused ? "sha256:abc" : null,
        refused ? null : 10,
        refused ? null : 0,
        refused ? null : "U0BOSS",
        refused ? null : `tk-${n}`
      );
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
      expect(unchained(after[0] as Record<string, unknown>)).toEqual({
        ...unchained(before[0] as Record<string, unknown>),
        ticket: null,
        destination: null,
        result_bytes_by_type: null,
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

  it("adds the later columns as null and keeps everything else", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old).map(unchained)).toEqual(
        before.map(row => ({
          ...unchained(row),
          budget_limit: null,
          day_spend_micro_usd: null,
          price_version: null,
          destination: null,
          result_bytes_by_type: null
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
      expect(after.map(unchained)).toEqual(
        before.map(row => ({
          ...unchained(row),
          budget_limit: null,
          day_spend_micro_usd: null,
          price_version: null,
          destination: null,
          result_bytes_by_type: null
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

// The migration a real deployment will actually run. Every other `migrating a
// version N` block below is the historical ladder; this is the rung the last
// release left people on, so it is where "adding #219's column does not disturb
// what is already written" has to be true rather than argued.
describe("migrating a version 5 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v5.db");
    writeV5File(old, 3);
  });

  it("adds the later columns as null and changes nothing else", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old)).toEqual(before.map(row => ({ ...row, destination: null, result_bytes_by_type: null })));
    } finally {
      migrated.close();
    }
  });

  // The claim `AUDIT_SCHEMA_VERSION`'s doc makes about version 6, checked
  // rather than asserted: the rows were hashed by the previous build, and after
  // the migration they carry **the same hashes**. That is what "NULL columns are
  // omitted from the preimage" buys, and if it ever stopped holding, every
  // operator's log would fail to verify on upgrade.
  it("leaves every existing row hashing exactly as it did", () => {
    const before = rows(old).map(row => row["row_hash"]);
    const migrated = openAuditDb({ file: old });
    try {
      expect(rows(old).map(row => row["row_hash"])).toEqual(before);
      expect(firstBrokenRow(old)).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  it("chains a row written after the migration onto the last one written before it", () => {
    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(
        record({ callId: "toolu_after", outcome: "refused", refusalReason: "egress_denied", destination: "evil.example.com" })
      );
      expect(firstBrokenRow(old)).toBeUndefined();
      expect(rows(old).at(-1)).toMatchObject({ destination: "evil.example.com" });
    } finally {
      migrated.close();
    }
  });
});

describe("migrating a version 4 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v4.db");
    writeV4File(old, 3);
  });

  it("keeps every row, its id, and its order", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      const after = rows(old);
      // Plus version 6's column, which a version 4 row has no value for and is
      // given null — the same reading version 4 gave its own three.
      expect(after.map(unchained)).toEqual(before.map(row => ({ ...row, destination: null, result_bytes_by_type: null })));
      expect(after.map(row => row.id)).toEqual([1, 2, 3]);
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  // The case v5 exists for, and the answer to the question
  // `AUDIT_SCHEMA_VERSION`'s doc asks each version to answer for itself: two NOT
  // NULL columns and no default any older row could be given, so the rebuild has
  // to compute one for every row it copies or the copy fails the constraint.
  it("gives every migrated row a hash, and the whole file verifies", () => {
    const migrated = openAuditDb({ file: old });
    try {
      expect(rows(old).map(row => row["prev_hash"])).not.toContain(null);
      expect(rows(old).map(row => row["row_hash"])).not.toContain(null);
      expect(firstBrokenRow(old)).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  // The chain has to continue across the migration rather than restart at it,
  // or every walk over a migrated file would report a break at the first row
  // written afterwards.
  it("continues the chain into rows written after it", () => {
    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(record({ task: "t-after" }));
      expect(rows(old)).toHaveLength(4);
      expect(firstBrokenRow(old)).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  // The counterpart of the ticket case above, one column later and with a worse
  // failure mode. `schema_version` carries no triggers, so deleting the stamp is
  // how an attacker asks for a rebuild; a rebuild that recomputed would re-bless
  // whatever they had already edited, turning the chain into a laundering step.
  it("keeps the hashes in a chained file whose version row was deleted", () => {
    openAuditDb({ file: old }).close();
    const chained = rows(old);
    tamper(old, "UPDATE tool_call_audit SET tool = 'delete_branch' WHERE id = 2");
    const raw = new DatabaseSync(old);
    try {
      raw.exec("DELETE FROM schema_version");
    } finally {
      raw.close();
    }

    const migrated = openAuditDb({ file: old });
    try {
      expect(rows(old).map(row => row["row_hash"])).toEqual(
        chained.map(row => row["row_hash"])
      );
      // Still broken afterwards, which is the whole point: the rebuild carried
      // the evidence through rather than writing over it.
      expect(firstBrokenRow(old)).toBe(2);
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
      expect(rebuilt).toContain("row_hash");
      expect(rebuilt).toBe(tableSql(file, "tool_call_audit"));
    } finally {
      migrated.close();
    }
  });

  it("runs once and is a no-op on every open after it", () => {
    openAuditDb({ file: old }).close();
    const afterFirst = rows(old);

    const second = openAuditDb({ file: old });
    try {
      expect(rows(old)).toEqual(afterFirst);
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(tableSql(old, "tool_call_audit_rebuilt")).toBe("");
    } finally {
      second.close();
    }
  });

  // The rollback case, on the shape the other migration blocks use: the scratch
  // table already exists, so the rebuild's CREATE fails. It matters more here
  // than it did before, because the loop writes N times rather than once and a
  // partial chain committed halfway would be a file that verifies to its own
  // truncation point.
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
    expect(versionOf(old)).toBe(4);
  });
});

// The version every deployed operator is on, so this is where "version 7 costs
// the chain nothing" has to be true rather than argued. The v5 block above
// proves the rebuild's harder case; this one proves the case that will actually
// run on upgrade.
describe("migrating a version 6 file", () => {
  let old: string;

  beforeEach(() => {
    old = join(dir, "v6.db");
    writeV6File(old, 3);
  });

  it("adds the breakdown as null and changes nothing else", () => {
    const before = rows(old);
    const migrated = openAuditDb({ file: old });
    try {
      expect(versionOf(old)).toBe(AUDIT_SCHEMA_VERSION);
      expect(rows(old)).toEqual(before.map(row => ({ ...row, result_bytes_by_type: null })));
    } finally {
      migrated.close();
    }
  });

  // The load-bearing one: NULL columns are omitted from the preimage, so a row
  // written before the column existed hashes to exactly what it did. If this
  // ever stopped holding, every operator's log would fail to verify on upgrade.
  it("leaves every existing row hashing exactly as it did", () => {
    const before = rows(old).map(row => row["row_hash"]);
    const migrated = openAuditDb({ file: old });
    try {
      expect(rows(old).map(row => row["row_hash"])).toEqual(before);
      expect(firstBrokenRow(old)).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  it("continues the chain into rows written after it", () => {
    const migrated = openAuditDb({ file: old });
    try {
      migrated.append(record({ task: "t-after", resultBytes: 12, resultBytesByType: { text: 12 } }));
      expect(rows(old)).toHaveLength(4);
      expect(rows(old).at(-1)?.["result_bytes_by_type"]).toBe('{"text":12}');
      expect(firstBrokenRow(old)).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  it("builds the same table a new file gets", () => {
    const migrated = openAuditDb({ file: old });
    try {
      expect(tableSql(old, "tool_call_audit")).toBe(tableSql(file, "tool_call_audit"));
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

  // #355. The walk an operator runs, as opposed to `firstBrokenRow` above —
  // that one is an independent recomputation, written to check the writer's
  // arithmetic; this is the shipped answer, and what is asserted here is the
  // verdict rather than the hashes.
  describe("verifyChain", () => {
    /** The tip, or a failure that says what the walk found instead. */
    const tipOf = (verdict: AuditChainVerdict): string => {
      if (!verdict.ok) throw new Error(`expected a passing walk, got a ${verdict.reason} break at ${verdict.brokenAt}`);
      return verdict.tip;
    };

    it("passes a log nothing has touched, and names the tip", () => {
      expect(read(r => r.verifyChain())).toEqual({
        ok: true,
        rows: 5,
        tip: rows(file).at(-1)?.["row_hash"]
      });
    });

    // The tip is the whole product of a passing walk, so it has to be the
    // *last row's* hash and not merely some hash the walk saw. Appending moves
    // it; a walk that returned a constant, or the first row's, would pass the
    // case above and fail this one.
    it("answers a tip that moves with the log", () => {
      const before = tipOf(read(r => r.verifyChain()));
      db.append(record({ task: "t-later" }));
      const after = read(r => r.verifyChain());

      expect(tipOf(after)).not.toBe(before);
      expect(tipOf(after)).toBe(rows(file).at(-1)?.["row_hash"]);
      expect(after).toMatchObject({ rows: 6 });
    });

    // An empty log is verified rather than special-cased: nothing was written,
    // so nothing was altered, and the tip is what the first row will chain from.
    // Its own file, because this block's `beforeEach` seeds the shared one.
    it("passes an empty log with the genesis as its tip", () => {
      const empty = join(dir, "empty.db");
      openAuditDb({ file: empty }).close();

      const reader = openAuditReader({ file: empty });
      try {
        expect(reader.verifyChain()).toEqual({ ok: true, rows: 0, tip: AUDIT_CHAIN_GENESIS });
      } finally {
        reader.close();
      }
    });

    it("names a rewritten row and calls it a content break", () => {
      tamper(file, "UPDATE tool_call_audit SET tool = 'delete_branch' WHERE id = 3");

      expect(read(r => r.verifyChain())).toEqual({
        ok: false,
        verified: 2,
        brokenAt: 3,
        reason: "content"
      });
    });

    // A deleted row leaves its successor entirely intact — the successor's own
    // columns still hash to its stored `row_hash`. So this is the case that
    // decides the order of the two checks inside the walk: content-first would
    // report `content` for a row nobody edited.
    it("names the successor of a deleted row and calls it a link break", () => {
      tamper(file, "DELETE FROM tool_call_audit WHERE id = 3");

      expect(read(r => r.verifyChain())).toEqual({
        ok: false,
        verified: 2,
        brokenAt: 4,
        reason: "link"
      });
    });

    // Naming one row is the contract. A second break further on must not change
    // the answer, because everything past the first is unverified rather than
    // wrong, and reporting the later one would present a guess as a finding.
    it("names the first break and stops", () => {
      tamper(file, "UPDATE tool_call_audit SET tool = 'x' WHERE id IN (2, 4)");

      expect(read(r => r.verifyChain())).toMatchObject({ ok: false, brokenAt: 2 });
    });

    it("reads without writing, on a connection that could not", () => {
      const before = rows(file);

      expect(read(r => r.verifyChain()).ok).toBe(true);

      expect(rows(file)).toEqual(before);
    });
  });
});
