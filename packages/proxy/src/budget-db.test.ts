import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGET_SCHEMA_VERSION, NO_SPEND, openBudgetDb, utcDay } from "./budget-db.js";
import type { BudgetDb } from "./budget-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const DAY = "2026-08-04";

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
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
    expect(db.readSpend(CHANNEL, DAY)).toEqual({ toolCalls: 0, ...usage });
  });

  it("adds a second turn to the first", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
    db.addTurnTokens(CHANNEL, DAY, "t2", 0, usage);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(240);
  });

  it("keeps tool calls and tokens on the same row without clobbering", () => {
    db.addToolCall(CHANNEL, DAY);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
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
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage)).toBe(true);
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage)).toBe(false);
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage)).toBe(false);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });

  // First write wins, silently. Re-keying a turn id is inside the
  // compromised-agent-process threat model, which already yields worse.
  it("ignores the numbers on a repeat of a turn it has seen", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, { ...usage, inputTokens: 9_000_000 });
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });

  // Turn ids are scoped to the channel that reported them, like everything
  // else here. Two agents that happen to generate the same id are not one.
  it("is scoped to a channel", () => {
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage)).toBe(true);
    expect(db.addTurnTokens(OTHER, DAY, "t1", 0, usage)).toBe(true);
    expect(db.readSpend(OTHER, DAY).inputTokens).toBe(120);
  });
});

describe("isolation between channels", () => {
  it("never lets one channel's writes reach another's counters", () => {
    for (let i = 0; i < 5; i += 1) db.addToolCall(CHANNEL, DAY);
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);

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
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
    db.close();

    db = openBudgetDb({ file });
    expect(db.readSpend(CHANNEL, DAY)).toEqual({ toolCalls: 1, ...usage });
  });

  // The retry guard has to outlive the process, or a restart mid-report is
  // exactly when a turn gets counted twice.
  it("remembers reported turns across a reopen", () => {
    db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage);
    db.close();

    db = openBudgetDb({ file });
    expect(db.addTurnTokens(CHANNEL, DAY, "t1", 0, usage)).toBe(false);
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
    db.addTurnTokens(CHANNEL, DAY, "old", 1_000, usage);
    db.addTurnTokens(CHANNEL, DAY, "new", 9_000, usage);

    expect(db.pruneTurnReportsBefore(5_000)).toBe(1);
    // The pruned id is no longer deduped — that is the trade, and it is why
    // the retention window is generous.
    expect(db.addTurnTokens(CHANNEL, DAY, "old", 9_000, usage)).toBe(true);
    expect(db.addTurnTokens(CHANNEL, DAY, "new", 9_000, usage)).toBe(false);
  });

  // Counters are not pruned. They are the only per-day spend history that
  // exists until the audit log lands.
  it("leaves the counters alone", () => {
    db.addTurnTokens(CHANNEL, DAY, "old", 1_000, usage);
    db.pruneTurnReportsBefore(5_000);
    expect(db.readSpend(CHANNEL, DAY).inputTokens).toBe(120);
  });
});

/** Reaches past the module's API on purpose: nothing else can forge a version. */
function bumpVersionTo(path: string, version: number): void {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE schema_version SET version = ?").run(version);
  raw.close();
}
