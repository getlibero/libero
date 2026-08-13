import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelDays, pruneTurnReports, readChannelSpend, resetChannel } from "./budget-admin.js";
import { NO_SPEND, openBudgetDb } from "./budget-db.js";
import { createSqliteSpendMeter } from "./budget-meter.js";
import type { BudgetDb } from "./budget-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 5, 12, 0, 0);

const usage = {
  inputTokens: 120,
  outputTokens: 8,
  cacheReadInputTokens: 100,
  cacheCreationInputTokens: 20
};

let dir: string;
let db: BudgetDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-admin-"));
  db = openBudgetDb({ file: join(dir, "budget.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function meterAt(at: number) {
  return createSqliteSpendMeter({ db, now: () => at });
}

describe("resetting a channel", () => {
  it("clears today's counters and says which day it cleared", async () => {
    const meter = meterAt(NOON);
    await meter.recordToolCall(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", usage);

    expect(resetChannel(db, CHANNEL, NOON)).toBe("2026-08-04");
    expect(await meter.read(CHANNEL)).toEqual(NO_SPEND);
  });

  // A reset is for the day a limit is biting on. Yesterday is history and
  // nobody asked for it to be rewritten.
  it("leaves the other days alone", async () => {
    await meterAt(NOON).recordToolCall(CHANNEL);
    await meterAt(NEXT_DAY).recordToolCall(CHANNEL);

    resetChannel(db, CHANNEL, NEXT_DAY);

    expect((await meterAt(NOON).read(CHANNEL)).toolCalls).toBe(1);
    expect((await meterAt(NEXT_DAY).read(CHANNEL)).toolCalls).toBe(0);
  });

  it("leaves every other channel alone", async () => {
    const meter = meterAt(NOON);
    await meter.recordToolCall(CHANNEL);
    await meter.recordToolCall(OTHER);

    resetChannel(db, CHANNEL, NOON);

    expect((await meter.read(OTHER)).toolCalls).toBe(1);
  });

  // Without this an operator clears a channel and watches it refill: the
  // agent's next retry of an already-counted turn would be seen as new.
  it("takes the day's reported turn ids with it, so a retry cannot re-spend", async () => {
    const meter = meterAt(NOON);
    await meter.recordTokens(CHANNEL, "t1", usage);
    resetChannel(db, CHANNEL, NOON);

    // The retry is now a fresh report — which is correct, because the reset
    // said this channel starts from zero — and it spends only what it carries.
    expect(await meter.recordTokens(CHANNEL, "t1", usage)).toEqual({ outcome: "recorded" });
    expect((await meter.read(CHANNEL)).inputTokens).toBe(120);
  });

  it("is harmless on a channel that has spent nothing", () => {
    expect(() => resetChannel(db, "C0NEVERUSED", NOON)).not.toThrow();
  });
});

describe("showing a channel", () => {
  it("reports the day and the raw counters", async () => {
    const meter = meterAt(NOON);
    await meter.recordToolCall(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", usage, "claude-sonnet-4-6");

    expect(readChannelSpend(db, CHANNEL, NOON)).toEqual({
      day: "2026-08-04",
      spend: {
        toolCalls: 1,
        inputTokens: 120,
        outputTokens: 8,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        byModel: [
          {
            model: "claude-sonnet-4-6",
            inputTokens: 120,
            outputTokens: 8,
            cacheReadTokens: 100,
            cacheWriteTokens: 20
          }
        ]
      }
    });
  });

  it("lists the days a channel has spent on, oldest first", async () => {
    await meterAt(NEXT_DAY).recordToolCall(CHANNEL);
    await meterAt(NOON).recordToolCall(CHANNEL);
    await meterAt(NOON).recordToolCall(OTHER);

    expect(channelDays(db, CHANNEL)).toEqual(["2026-08-04", "2026-08-05"]);
    expect(channelDays(db, OTHER)).toEqual(["2026-08-04"]);
  });
});

describe("pruning turn reports", () => {
  it("drops ids older than the cutoff and reports how many", async () => {
    await meterAt(1_000).recordTokens(CHANNEL, "old", usage);
    await meterAt(9_000).recordTokens(CHANNEL, "new", usage);

    expect(pruneTurnReports(db, 5_000)).toBe(1);
    expect(pruneTurnReports(db, 5_000)).toBe(0);
  });

  it("leaves the counters untouched", async () => {
    await meterAt(1_000).recordTokens(CHANNEL, "old", usage);
    pruneTurnReports(db, 5_000);
    expect((await meterAt(1_000).read(CHANNEL)).inputTokens).toBe(120);
  });
});
