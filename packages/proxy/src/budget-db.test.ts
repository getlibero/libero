import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_MODEL } from "@getlibero/schema";
import { BUDGET_SCHEMA_VERSION, NO_SPEND, openBudgetDb, utcDay } from "./budget-db.js";
import type { BudgetDb } from "./budget-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const DAY = "2026-08-04";
const MODEL = "claude-sonnet-4-6";
const OTHER_MODEL = "claude-haiku-4-5";

const usage = {
  inputTokens: 120,
  outputTokens: 8,
  cacheReadTokens: 100,
  cacheWriteTokens: 20
};

let dir: string;
let file: string;
let db: BudgetDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-budget-"));
  file = join(dir, "budget.db");
  db = openBudgetDb({ file });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the day key", () => {
  it("is the UTC calendar date", () => {
    expect(utcDay(Date.UTC(2026, 7, 4, 12, 0, 0))).toBe("2026-08-04");
  });

  // The boundary is the whole rollover. One millisecond either side of UTC
  // midnight has to land in different days or a counter carries over.
  it("changes at UTC midnight and not a millisecond before", () => {
    const midnight = Date.UTC(2026, 7, 5, 0, 0, 0);
    expect(utcDay(midnight - 1)).toBe("2026-08-04");
    expect(utcDay(midnight)).toBe("2026-08-05");
  });

  // The host's timezone must not move the boundary: two operators reading the
  // same file would otherwise disagree about which day they were looking at,
  // and a host that changed zones would roll over twice or not at all.
  it("does not follow the host timezone", () => {
    const original = process.env.TZ;
    try {
      // 20:00 UTC is already the next day in Tokyo and still the previous one
      // in Honolulu. Both must answer with the UTC date.
      const evening = Date.UTC(2026, 7, 4, 20, 0, 0);
      process.env.TZ = "Asia/Tokyo";
      expect(utcDay(evening)).toBe("2026-08-04");
      process.env.TZ = "Pacific/Honolulu";
      expect(utcDay(evening)).toBe("2026-08-04");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("reading a channel's day", () => {
  it("reads zero for a day that was never written", () => {
    expect(db.readSpend(CHANNEL, DAY)).toEqual(NO_SPEND);
  });

  it("counts tool calls one at a time", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addToolCall(CHANNEL, DAY);
    expect(db.readSpend(CHANNEL, DAY).toolCalls).toBe(2);
  });

  it("keeps the four token counts apart", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    expect(db.readSpend(CHANNEL, DAY)).toEqual({
      toolCalls: 0,
      ...usage,
      byModel: [{ model: MODEL, ...usage }]
    });
  });

  // The dimension #62 added, and the property that makes the totals safe to keep
  // beside it: they are summed from these rows rather than stored, so a bucket
  // that is not in `byModel` cannot be in the totals either.
  it("keeps two models apart and totals across them", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.addTurnTokens(CHANNEL, DAY, "t2", 0, OTHER_MODEL, usage);

    const spend = db.readSpend(CHANNEL, DAY);
    expect(spend.byModel.map(bucket => bucket.model)).toEqual([OTHER_MODEL, MODEL]);
    expect(spend.byModel.every(bucket => bucket.inputTokens === 120)).toBe(true);
    expect(spend.inputTokens).toBe(240);
    expect(spend.cacheReadTokens).toBe(200);
  });

  // One model's second turn lands on its own bucket rather than making a new
  // one, which is what `ON CONFLICT (channel, day, model)` is for.
  it("accumulates a model's own turns into one bucket", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.addTurnTokens(CHANNEL, DAY, "t2", 0, MODEL, usage);

    const spend = db.readSpend(CHANNEL, DAY);
    expect(spend.byModel).toHaveLength(1);
    expect(spend.byModel[0]?.inputTokens).toBe(240);
  });

  it("adds a second turn to the first", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.addTurnTokens(CHANNEL, DAY, "t2", 0, MODEL, usage);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(240);
  });

  it("keeps tool calls and tokens on the same row without clobbering", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.addToolCall(CHANNEL, DAY);
    const spend = db.readSpend(CHANNEL, DAY);
    expect(spend.toolCalls).toBe(2);
    expect(spend.inputTokens).toBe(120);
  });
});

describe("the turn id", () => {
  // The retry story. A report that arrives twice — a failed response, a
  // restart mid-flight — must move the meter once.
  it("counts a turn once however many times it is reported", () => {
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage)).toBe(true);
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage)).toBe(false);
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage)).toBe(false);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });

  // First write wins, silently. Re-keying a turn id is inside the
  // compromised-agent-process threat model, which already yields worse.
  it("ignores the numbers on a repeat of a turn it has seen", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, { ...usage, inputTokens: 9_000_000 });
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });

  // Turn ids are scoped to the channel that reported them, like everything
  // else here. Two agents that happen to generate the same id are not one.
  it("is scoped to a channel", () => {
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage)).toBe(true);
    expect(db.addTurnTokens(OTHER, DAY, "t1", 0, MODEL, usage)).toBe(true);
    expect(db.readSpend(OTHER, DAY).inputTokens).toBe(120);
  });
});

describe("isolation between channels", () => {
  it("never lets one channel's writes reach another's counters", () => {
    for (let i = 0; i < 5; i += 1) db.addToolCall(CHANNEL, DAY);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);

    expect(db.readSpend(OTHER, DAY)).toEqual(NO_SPEND);
    expect(db.readSpend(CHANNEL, DAY).toolCalls).toBe(5);
  });

  it("clears one channel's day and leaves the other's alone", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addToolCall(OTHER, DAY);
    db.clearDay(CHANNEL, DAY);

    expect(db.readSpend(CHANNEL, DAY)).toEqual(NO_SPEND);
    expect(db.readSpend(OTHER, DAY).toolCalls).toBe(1);
  });
});

// The soft limit's once-a-day claim (#99). A marker, not a counter: it holds no
// number, and the worst a channel can do by provoking it is spend its own.
describe("claiming a warning", () => {
  it("answers true once and false after", () => {
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(false);
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(false);
  });

  // Per limit, not per channel. Two limits are two facts, and a channel told
  // about its tokens has not been told about its tool calls.
  it("keeps the two limits apart", () => {
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    expect(db.claimWarning(CHANNEL, DAY, "daily_tool_calls")).toBe(true);
    expect(db.claimWarning(CHANNEL, DAY, "daily_tool_calls")).toBe(false);
  });

  it("keeps channels and days apart", () => {
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    expect(db.claimWarning(OTHER, DAY, "daily_tokens")).toBe(true);
    expect(db.claimWarning(CHANNEL, "2026-08-05", "daily_tokens")).toBe(true);
  });

  it("moves no counter", () => {
    db.claimWarning(CHANNEL, DAY, "daily_tokens");
    expect(db.readSpend(CHANNEL, DAY)).toEqual(NO_SPEND);
  });

  // A reset starts the day over, and a day that cannot be warned about is not
  // started over — the same half-reset the turn ids would be.
  it("is re-armed by the operator's reset", () => {
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    db.clearDay(CHANNEL, DAY);
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
  });

  it("leaves another channel's claim alone when one channel is reset", () => {
    db.claimWarning(CHANNEL, DAY, "daily_tokens");
    db.claimWarning(OTHER, DAY, "daily_tokens");
    db.clearDay(CHANNEL, DAY);

    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    expect(db.claimWarning(OTHER, DAY, "daily_tokens")).toBe(false);
  });

  // The claim survives a restart, which is what makes "once a day" a property
  // of the day rather than of how long the process happened to stay up.
  it("survives reopening the file", () => {
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(true);
    db.close();
    db = openBudgetDb({ file });
    expect(db.claimWarning(CHANNEL, DAY, "daily_tokens")).toBe(false);
  });
});

describe("the day boundary", () => {
  it("reads a new day as zero and leaves the old day where it is", () => {
    db.addToolCall(CHANNEL, DAY);
    expect(db.readSpend(CHANNEL, "2026-08-05")).toEqual(NO_SPEND);
    expect(db.readSpend(CHANNEL, DAY).toolCalls).toBe(1);
  });

  // A reset is for today. Yesterday is history and the operator did not ask
  // for it to be rewritten.
  it("clears only the day it was given", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addToolCall(CHANNEL, "2026-08-05");
    db.clearDay(CHANNEL, "2026-08-05");

    expect(db.readSpend(CHANNEL, DAY).toolCalls).toBe(1);
    expect(db.readSpend(CHANNEL, "2026-08-05")).toEqual(NO_SPEND);
  });

  it("lists the days a channel has spent on", () => {
    db.addToolCall(CHANNEL, "2026-08-05");
    db.addToolCall(CHANNEL, DAY);
    db.addToolCall(OTHER, "2026-08-06");
    expect(db.daysWithSpend(CHANNEL)).toEqual([DAY, "2026-08-05"]);
  });
});

describe("the file", () => {
  it("survives a close and reopen", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.close();

    db = openBudgetDb({ file });
    expect(db.readSpend(CHANNEL, DAY)).toEqual({
      toolCalls: 1,
      ...usage,
      byModel: [{ model: MODEL, ...usage }]
    });
  });

  // The retry guard has to outlive the process, or a restart mid-report is
  // exactly when a turn gets counted twice.
  it("remembers reported turns across a reopen", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    db.close();

    db = openBudgetDb({ file });
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage)).toBe(false);
  });

  // Two handles on one file is the reset path: the operator's process writes
  // while the proxy is serving, and the proxy's next read has to see it.
  it("lets a second handle write while the first is open", () => {
    db.addToolCall(CHANNEL, DAY);

    const operator = openBudgetDb({ file });
    operator.clearDay(CHANNEL, DAY);
    operator.close();

    expect(db.readSpend(CHANNEL, DAY)).toEqual(NO_SPEND);
  });

  // No mkdir: a budget file invented under a path nobody meant is a channel
  // with a permanently fresh budget, which fails open and in silence.
  it("refuses a directory that does not exist", () => {
    expect(() => openBudgetDb({ file: join(dir, "nope", "budget.db") })).toThrow();
  });

  it("stamps its schema version and refuses a file from the future", () => {
    db.close();

    const ahead = openBudgetDb({ file });
    ahead.close();
    bumpVersionTo(file, BUDGET_SCHEMA_VERSION + 1);

    expect(() => openBudgetDb({ file })).toThrow(/schema version/);
    // Reopened only so afterEach has something to close.
    bumpVersionTo(file, BUDGET_SCHEMA_VERSION);
    db = openBudgetDb({ file });
  });
});

describe("pruning reported turns", () => {
  // The table exists to defeat retries, whose useful life is seconds. Keeping
  // every turn id forever is unbounded growth for no property.
  it("drops turn ids older than the cutoff and keeps the rest", () => {
    db.addTurnTokens(CHANNEL, DAY, "old", 1_000, MODEL, usage);
    db.addTurnTokens(CHANNEL, DAY, "new", 9_000, MODEL, usage);

    expect(db.pruneTurnReportsBefore(5_000)).toBe(1);
    // The pruned id is no longer deduped — that is the trade, and it is why
    // the retention window is generous.
    expect(db.addTurnTokens(CHANNEL, DAY, "old", 9_000, MODEL, usage)).toBe(true);
    expect(db.addTurnTokens(CHANNEL, DAY, "new", 9_000, MODEL, usage)).toBe(false);
  });

  // Counters are not pruned. They are the only per-day spend history that
  // exists until the audit log lands.
  it("leaves the counters alone", () => {
    db.addTurnTokens(CHANNEL, DAY, "old", 1_000, MODEL, usage);
    db.pruneTurnReportsBefore(5_000);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });
});

// The migration #62 needed and this file did not have (#62). Until version 2
// `checkVersion` could only stamp or refuse, so every case here is exercising
// machinery that did not exist — which is why the suite is this size for one
// version step. Read it as the answer to "what happens to a real operator's
// counters", not as coverage.
describe("migrating a version 1 file", () => {
  beforeEach(() => {
    // The fixtures below build their own files, so the shared handle is closed
    // first and reopened at the end of each case for afterEach to close.
    db.close();
  });

  afterEach(() => {
    db = openBudgetDb({ file: join(dir, "reopened.db") });
  });

  it("keeps tool calls and moves tokens to the legacy bucket", () => {
    const path = writeV1File(join(dir, "v1.db"), [
      { channel: CHANNEL, day: DAY, toolCalls: 7, ...usage }
    ]);

    const migrated = openBudgetDb({ file: path });
    const spend = migrated.readSpend(CHANNEL, DAY);

    expect(spend.toolCalls).toBe(7);
    // Every token survives, and the totals still read exactly as they did — the
    // limit that was in force when they were spent is unaffected.
    expect(spend.inputTokens).toBe(120);
    expect(spend.cacheReadTokens).toBe(100);
    // And they are attributed honestly rather than to a model nobody can check.
    expect(spend.byModel).toEqual([{ model: LEGACY_MODEL, ...usage }]);
    migrated.close();
  });

  // Not an optimisation. A channel that made tool calls and never reported a
  // token would otherwise gain a bucket of four zeroes, which reads to anything
  // looking at `byModel` as "this channel has spend it cannot price" — and that
  // is false, and under a dollar cap it would be false in the refusing direction.
  it("gives an all-zero row no bucket at all", () => {
    const path = writeV1File(join(dir, "zero.db"), [
      { channel: CHANNEL, day: DAY, toolCalls: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    ]);

    const migrated = openBudgetDb({ file: path });
    const spend = migrated.readSpend(CHANNEL, DAY);
    expect(spend.toolCalls).toBe(3);
    expect(spend.byModel).toEqual([]);
    migrated.close();
  });

  it("carries every channel and every day across", () => {
    const path = writeV1File(join(dir, "many.db"), [
      { channel: CHANNEL, day: DAY, toolCalls: 1, ...usage },
      { channel: CHANNEL, day: "2026-08-05", toolCalls: 2, ...usage },
      { channel: OTHER, day: DAY, toolCalls: 4, ...usage }
    ]);

    const migrated = openBudgetDb({ file: path });
    expect(migrated.daysWithSpend(CHANNEL)).toEqual([DAY, "2026-08-05"]);
    expect(migrated.readSpend(OTHER, DAY).toolCalls).toBe(4);
    // Still isolated afterwards, which a rebuild that dropped the channel from
    // a key would break silently.
    expect(migrated.readSpend(OTHER, "2026-08-05")).toEqual(NO_SPEND);
    migrated.close();
  });

  // `db.exec(SCHEMA)` and the version stamp are two commits, so a process that
  // died between them left exactly this: v1 tables and no stamp. Stamping it
  // current without looking would leave every count sitting in columns nothing
  // reads any more.
  it("runs the rebuild on a v1-shaped file with no version row", () => {
    const path = writeV1File(join(dir, "unstamped.db"), [
      { channel: CHANNEL, day: DAY, toolCalls: 1, ...usage }
    ]);
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM schema_version");
    raw.close();

    const migrated = openBudgetDb({ file: path });
    expect(migrated.readSpend(CHANNEL, DAY).byModel).toEqual([{ model: LEGACY_MODEL, ...usage }]);
    migrated.close();
  });

  // The property that makes one rebuild procedure safe to run on any recognised
  // version: it asks the table what it has rather than trusting the stamp. An
  // operator can delete the stamp — `schema_version` carries no trigger — and a
  // rebuild that assumed the oldest shape would move nothing and lose nothing,
  // but must not invent a legacy bucket for a file that already has real ones.
  it("does not manufacture a legacy bucket on an already-migrated file", () => {
    const path = join(dir, "v2.db");
    const first = openBudgetDb({ file: path });
    first.addTurnTokens(CHANNEL, DAY, "t1", 0, MODEL, usage);
    first.close();

    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM schema_version");
    raw.close();

    const reopened = openBudgetDb({ file: path });
    expect(reopened.readSpend(CHANNEL, DAY).byModel).toEqual([{ model: MODEL, ...usage }]);
    reopened.close();
  });

  // The shape a file ends up with must not depend on how old it is, which is
  // the thing a schema version exists to make impossible.
  it("produces the same tables a fresh file gets", () => {
    const migratedPath = writeV1File(join(dir, "shape-v1.db"), [
      { channel: CHANNEL, day: DAY, toolCalls: 1, ...usage }
    ]);
    openBudgetDb({ file: migratedPath }).close();
    const freshPath = join(dir, "shape-new.db");
    openBudgetDb({ file: freshPath }).close();

    for (const table of ["channel_spend", "channel_token_spend"]) {
      expect(tableInfo(migratedPath, table)).toEqual(tableInfo(freshPath, table));
    }
    // And the scratch table is gone rather than left beside the real one.
    expect(tableNames(migratedPath)).not.toContain("channel_spend_rebuilt");
    expect(tableNames(migratedPath)).toEqual(tableNames(freshPath));
  });

  it("refuses a version it has no migration from, naming both numbers", () => {
    const path = join(dir, "future.db");
    openBudgetDb({ file: path }).close();
    bumpVersionTo(path, BUDGET_SCHEMA_VERSION + 1);

    expect(() => openBudgetDb({ file: path })).toThrow(
      new RegExp(`version ${BUDGET_SCHEMA_VERSION + 1}.*version ${BUDGET_SCHEMA_VERSION}`, "s")
    );
  });
});

/** Reaches past the module's API on purpose: nothing else can forge a version. */
function bumpVersionTo(path: string, version: number): void {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE schema_version SET version = ?").run(version);
  raw.close();
}

/** One row of the table version 1 wrote: five counters on one key. */
interface V1Row {
  readonly channel: string;
  readonly day: string;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * A file exactly as version 1 wrote one.
 *
 * The DDL is spelled out here rather than imported, and that is the point: this
 * is a *frozen* copy of a shape the module no longer contains, and the module
 * deliberately holds no v1 literal to import — `channelSpendDdl` is by
 * construction the current table. A fixture that built its v1 file from current
 * code would migrate nothing and pass forever.
 */
function writeV1File(path: string, rows: readonly V1Row[]): string {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE channel_spend (
      channel            TEXT    NOT NULL,
      day                TEXT    NOT NULL,
      tool_calls         INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel, day)
    ) WITHOUT ROWID;
    CREATE TABLE turn_report (
      channel TEXT    NOT NULL,
      turn    TEXT    NOT NULL,
      day     TEXT    NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (channel, turn)
    ) WITHOUT ROWID;
    CREATE TABLE budget_warning (
      channel      TEXT NOT NULL,
      day          TEXT NOT NULL,
      budget_limit TEXT NOT NULL,
      PRIMARY KEY (channel, day, budget_limit)
    ) WITHOUT ROWID;
  `);
  raw.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
  const insert = raw.prepare(
    `INSERT INTO channel_spend
       (channel, day, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.channel,
      row.day,
      row.toolCalls,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens
    );
  }
  raw.close();
  return path;
}

function tableInfo(path: string, table: string): unknown[] {
  const raw = new DatabaseSync(path);
  const info = raw.prepare(`PRAGMA table_info(${table})`).all();
  raw.close();
  return info;
}

function tableNames(path: string): string[] {
  const raw = new DatabaseSync(path);
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as
    Record<string, unknown>[]).map(row => String(row["name"]));
  raw.close();
  return names;
}
