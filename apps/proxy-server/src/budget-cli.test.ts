import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSpendMeter, openBudgetDb } from "@getlibero/proxy";
import type { BudgetDb } from "@getlibero/proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runBudgetCommand } from "./budget-cli.js";

const CHANNEL = "C024BE91L";
const OTHER = "C7ZZZ9999";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 5, 12, 0, 0);

const usage = {
  inputTokens: 120,
  outputTokens: 8,
  cacheReadInputTokens: 100,
  cacheCreationInputTokens: 20
};

let dir: string;
let file: string;

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[], at = NOON, env?: Record<string, string>): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runBudgetCommand({
    argv,
    env: env ?? { PROXY_BUDGET_DB: file },
    out: line => void out.push(line),
    err: line => void err.push(line),
    now: () => at
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** Spend written the way the proxy writes it, through the real meter. */
async function spend(at: number, channel: string, calls: number, turn?: string): Promise<void> {
  const db: BudgetDb = openBudgetDb({ file });
  try {
    const meter = createSqliteSpendMeter({ db, now: () => at });
    for (let i = 0; i < calls; i += 1) await meter.recordToolCall(channel);
    if (turn !== undefined) await meter.recordTokens(channel, turn, usage);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-budget-cli-"));
  file = join(dir, "budget.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("show", () => {
  it("prints today's counters, unweighted and labelled as such", async () => {
    await spend(NOON, CHANNEL, 3, "t1");

    const result = run(["show", CHANNEL]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("day         2026-08-04 (UTC)");
    expect(result.text).toContain("tool calls  3");
    expect(result.text).toContain("cache read  100");
    // The operator must not read these as what the budget was charged: the
    // weights live in the team sheet and are applied at decision time.
    expect(result.text).toContain("unweighted");
  });

  it("prints zeroes for a channel that has spent nothing today", () => {
    const result = run(["show", CHANNEL]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("tool calls  0");
  });

  it("shows the day it was asked about and not another", async () => {
    await spend(NOON, CHANNEL, 3);
    const result = run(["show", CHANNEL], NEXT_DAY);
    expect(result.text).toContain("day         2026-08-05 (UTC)");
    expect(result.text).toContain("tool calls  0");
  });
});

describe("days", () => {
  it("lists the days a channel has recorded spend on", async () => {
    await spend(NOON, CHANNEL, 1);
    await spend(NEXT_DAY, CHANNEL, 1);

    expect(run(["days", CHANNEL]).out).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("says so plainly when there is nothing", () => {
    expect(run(["days", CHANNEL]).text).toContain("recorded no spend");
  });
});

describe("reset", () => {
  it("clears today's counters and names the day", async () => {
    await spend(NOON, CHANNEL, 3, "t1");

    const result = run(["reset", CHANNEL]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([`budget: reset ${CHANNEL} for 2026-08-04 (UTC)`]);
    expect(run(["show", CHANNEL]).text).toContain("tool calls  0");
  });

  it("leaves every other channel alone", async () => {
    await spend(NOON, CHANNEL, 1);
    await spend(NOON, OTHER, 2);

    run(["reset", CHANNEL]);

    expect(run(["show", OTHER]).text).toContain("tool calls  2");
  });

  it("clears today and leaves earlier days as history", async () => {
    await spend(NOON, CHANNEL, 1);
    await spend(NEXT_DAY, CHANNEL, 4);

    run(["reset", CHANNEL], NEXT_DAY);

    expect(run(["show", CHANNEL], NOON).text).toContain("tool calls  1");
    expect(run(["show", CHANNEL], NEXT_DAY).text).toContain("tool calls  0");
  });
});

describe("prune", () => {
  it("reports how many turn reports it dropped", async () => {
    await spend(NOON, CHANNEL, 0, "t1");

    // Three days on, so the report is past the 48h window.
    const later = NOON + 3 * 24 * 60 * 60 * 1000;
    expect(run(["prune"], later).out).toEqual(["budget: pruned 1 turn report"]);
    expect(run(["prune"], later).out).toEqual(["budget: pruned 0 turn reports"]);
  });

  it("takes no arguments", () => {
    expect(run(["prune", CHANNEL]).code).toBe(EXIT_USAGE);
  });
});

describe("usage and errors", () => {
  it("prints usage and fails when given no command", () => {
    const result = run([]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.text).toContain("usage: budget <command>");
  });

  it("prints usage and succeeds when asked for help", () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = run([flag]);
      expect(result.code).toBe(EXIT_OK);
      expect(result.text).toContain("usage: budget <command>");
    }
  });

  it("rejects an unknown command", () => {
    const result = run(["drain", CHANNEL]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err[0]).toBe("budget: unknown command: drain");
  });

  it("requires exactly one channel id", () => {
    expect(run(["show"]).code).toBe(EXIT_USAGE);
    expect(run(["reset", CHANNEL, OTHER]).code).toBe(EXIT_USAGE);
  });

  // The same rule the other variables follow: name the variable, say nothing
  // about what was set.
  it("names the variable when the database is not configured", () => {
    const result = run(["show", CHANNEL], NOON, {});
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err[0]).toContain("PROXY_BUDGET_DB");
  });

  it("fails rather than inventing a database under a missing directory", () => {
    const result = run(["show", CHANNEL], NOON, {
      PROXY_BUDGET_DB: join(dir, "nope", "budget.db")
    });
    expect(result.code).toBe(EXIT_ERROR);
  });
});
