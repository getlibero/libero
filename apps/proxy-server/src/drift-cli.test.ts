// The drift command's cases (#239).
//
// Two things are being claimed here and they are different. One is arithmetic:
// the computed side is the price table applied to the counts in the record, and
// it has to be re-derived at read time so that correcting a price makes the
// difference go away. The other is wording: an operator reading "$4.12 against
// $4.60" has to come away knowing which of the two is theirs to fix and which
// way their dollar cap is wrong. The second is as much the deliverable as the
// first, which is why the sentences are asserted rather than the numbers alone.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDriftDb } from "@getlibero/proxy";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runDriftCommand } from "./drift-cli.js";

const CHANNEL = "C024BE91L";
const OTHER = "C7ZZZ9999";
const MODEL = "claude-sonnet-4-6";
const DAY = "2026-08-29";

/**
 * A million tokens at a round price, so the two sides are readable by eye.
 *
 * Input alone, at $3 per million: the proxy computes exactly $3.000000 for this
 * row, and whatever the test tells the gateway to have said is the other side.
 */
const MILLION = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
};
const THREE_DOLLARS_NANO = 3_000_000_000;

const PRICE_TABLE = `
[[model]]
id = "${MODEL}"
input = 3000000
output = 15000000
cache_read = 300000
cache_write = 3750000
`;

let dir: string;
let file: string;
let priceFile: string;

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[], env?: Record<string, string>): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runDriftCommand({
    argv,
    env: env ?? { PROXY_DRIFT_DB: file, PROXY_PRICE_TABLE: priceFile },
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** Rows written the way the spend route writes them, through the real store. */
function record(
  reports: readonly {
    channel?: string;
    day?: string;
    model?: string;
    usage?: typeof MILLION;
    costNanoUsd: number;
  }[]
): void {
  const db = openDriftDb({ file });
  try {
    for (const report of reports) {
      db.recordReported(report.channel ?? CHANNEL, report.day ?? DAY, {
        model: report.model ?? MODEL,
        usage: report.usage ?? MILLION,
        costNanoUsd: report.costNanoUsd
      });
    }
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-drift-cli-"));
  file = join(dir, "drift.db");
  priceFile = join(dir, "prices.toml");
  writeFileSync(priceFile, PRICE_TABLE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("comparing the two figures", () => {
  it("prints both sides and the gap between them", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO }]);

    const { code, text } = run(["show"]);

    expect(code).toBe(EXIT_OK);
    expect(text).toContain(MODEL);
    expect(text).toContain("computed $3.0000");
    expect(text).toContain("reported $3.0000");
  });

  // The direction is the actionable half. A table below the gateway's means a
  // channel's daily_usd is letting more real spend through than it reads.
  it("says which way a table that under-prices is wrong", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO * 2 }]);

    const { text } = run(["show"]);

    expect(text).toContain("+100.0%");
    expect(text).toContain("below the gateway");
    expect(text).toContain("allowing more real spend than it reads");
  });

  it("says which way a table that over-prices is wrong", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO / 2 }]);

    const { text } = run(["show"]);

    expect(text).toContain("-50.0%");
    expect(text).toContain("above the gateway");
    expect(text).toContain("cutting spend off earlier than it reads");
  });

  // Under a percent the two tables agree for every practical purpose, and a
  // sentence on every row would make the rows that matter harder to find.
  it("says nothing about a row the two sides agree on", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO + 1_000_000 }]);

    const { text } = run(["show"]);

    expect(text).toContain("+0.0%");
    expect(text).not.toContain("below the gateway");
    expect(text).not.toContain("above the gateway");
  });

  // The point of computing at read time rather than stamping a figure when the
  // report arrived: this is the operator's feedback loop. Fix the price, run it
  // again, and the difference is gone — over spend already recorded.
  it("re-prices what is already recorded when the table is corrected", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO * 2 }]);
    expect(run(["show"]).text).toContain("+100.0%");

    writeFileSync(priceFile, PRICE_TABLE.replace("input = 3000000", "input = 6000000"));

    const { text } = run(["show"]);
    expect(text).toContain("+0.0%");
    expect(text).toContain("computed $6.0000");
  });

  // Aggregation has to be exact, not approximate: pricing summed counts is the
  // sum of pricing each turn, because cost is linear in the counts.
  it("prices a day of turns as one sum", () => {
    record([
      { costNanoUsd: THREE_DOLLARS_NANO },
      { costNanoUsd: THREE_DOLLARS_NANO },
      { costNanoUsd: THREE_DOLLARS_NANO }
    ]);

    const { text } = run(["show"]);

    expect(text).toContain("3 turns");
    expect(text).toContain("computed $9.0000");
    expect(text).toContain("reported $9.0000");
  });

  // Four decimal places, because a day of embeddings is fractions of a cent and
  // rounding to the cent would print $0.00 against $0.00 on every row of them.
  it("shows a figure smaller than a cent", () => {
    record([
      {
        usage: { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costNanoUsd: 180
      }
    ]);

    const { text } = run(["show"]);

    expect(text).toContain("reported $0.0000");
  });
});

describe("what the record cannot settle", () => {
  // Priced at zero by the gateway is a statement; the record cannot tell "free
  // there" from "its table has no row either", so the sentence names both.
  it("names both readings of a gateway that charged nothing", () => {
    record([{ costNanoUsd: 0 }]);

    const { text } = run(["show"]);

    expect(text).toContain("priced these at nothing");
    expect(text).toContain("either the model is free there");
  });

  // A different fault with a different remedy, and one the deployment is
  // already learning the expensive way: daily_usd fails closed on it.
  it("says when the price table has no row for a model at all", () => {
    record([{ model: "gpt-4o-mini", costNanoUsd: 100 }]);

    const { text } = run(["show"]);

    expect(text).toContain("no price for this model");
    expect(text).toContain("already being refused");
  });
});

describe("reading the record", () => {
  it("splits a model's history by day, so a change has a date", () => {
    record([
      { day: "2026-08-24", costNanoUsd: THREE_DOLLARS_NANO },
      { day: "2026-08-28", costNanoUsd: THREE_DOLLARS_NANO * 2 }
    ]);

    const { code, out } = run(["days", MODEL]);

    expect(code).toBe(EXIT_OK);
    expect(out.some(line => line.includes("2026-08-24") && line.includes("+0.0%"))).toBe(true);
    expect(out.some(line => line.includes("2026-08-28") && line.includes("+100.0%"))).toBe(true);
  });

  it("narrows to one channel when asked", () => {
    record([
      { channel: CHANNEL, costNanoUsd: THREE_DOLLARS_NANO },
      { channel: OTHER, costNanoUsd: THREE_DOLLARS_NANO * 3 }
    ]);

    const { text } = run(["show", OTHER]);

    expect(text).toContain("computed $3.0000");
    expect(text).toContain("reported $9.0000");
  });

  it("reports an empty record as an empty record rather than as agreement", () => {
    record([]);

    const { code, text } = run(["show"]);

    expect(code).toBe(EXIT_OK);
    expect(text).toContain("nothing recorded");
    expect(text).toContain("calling providers directly reports none");
  });
});

describe("saying what it is not", () => {
  // #239's own wording: this must never enforce. There is deliberately no exit
  // code for a difference being large, so a script cannot come to depend on one.
  it("exits 0 on a difference of any size", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO * 1000 }]);

    expect(run(["show"]).code).toBe(EXIT_OK);
  });

  it("says on the page that nothing here enforced anything", () => {
    record([{ costNanoUsd: THREE_DOLLARS_NANO }]);

    expect(run(["show"]).text).toContain("Nothing above enforced anything");
  });
});

describe("configuration", () => {
  it("says so rather than printing an empty table when no record is kept", () => {
    const { code, text } = run(["show"], { PROXY_PRICE_TABLE: priceFile });

    expect(code).toBe(EXIT_ERROR);
    expect(text).toContain("PROXY_DRIFT_DB is not set");
  });

  // Half the comparison, and the half this deployment owns. A deployment with
  // no price table caps nothing in dollars and has no stale table to find.
  it("says so when there is no price table to compare against", () => {
    record([{ costNanoUsd: 1 }]);

    const { code, text } = run(["show"], { PROXY_DRIFT_DB: file });

    expect(code).toBe(EXIT_ERROR);
    expect(text).toContain("PROXY_PRICE_TABLE is not set");
  });

  it("takes exactly one channel on show and one model on days", () => {
    record([{ costNanoUsd: 1 }]);

    expect(run(["show", CHANNEL, OTHER]).code).toBe(EXIT_USAGE);
    expect(run(["days"]).code).toBe(EXIT_USAGE);
    expect(run(["nonsense"]).code).toBe(EXIT_USAGE);
    expect(run([]).code).toBe(EXIT_USAGE);
    expect(run(["--help"]).code).toBe(EXIT_OK);
  });
});
