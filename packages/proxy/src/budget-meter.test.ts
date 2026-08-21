import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { UNREPORTED_MODEL } from "@getlibero/schema";
import { NO_SPEND, openBudgetDb } from "./budget-db.js";
import { TURN_RETENTION_MS, createSqliteSpendMeter, openSpendMeter } from "./budget-meter.js";
import type { BudgetDb } from "./budget-db.js";
import type { SpendMeter } from "./dispatch.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";

const MODEL = "claude-sonnet-4-6";

const usage = {
  inputTokens: 120,
  outputTokens: 8,
  cacheReadInputTokens: 100,
  cacheCreationInputTokens: 20
};

/** The same four numbers as the meter's columns name them. */
const COUNTS = {
  inputTokens: 120,
  outputTokens: 8,
  cacheReadTokens: 100,
  cacheWriteTokens: 20
};

/** 2026-08-04T12:00:00Z — midday, so a test can move either way from it. */
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 5, 0, 0, 0);

let dir: string;
let file: string;
let db: BudgetDb;
let clock: number;
let meter: SpendMeter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-meter-"));
  file = join(dir, "budget.db");
  db = openBudgetDb({ file });
  clock = NOON;
  meter = createSqliteSpendMeter({ db, now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("counting", () => {
  it("reads nothing spent for a channel that has done nothing", async () => {
    expect(await meter.read(CHANNEL)).toEqual(NO_SPEND);
  });

  it("counts each served call once", async () => {
    await meter.recordToolCall(CHANNEL);
    await meter.recordToolCall(CHANNEL);
    expect((await meter.read(CHANNEL)).toolCalls).toBe(2);
  });

  // The four counts stay apart all the way to enforcement, because what a
  // cached token is worth is a team sheet setting and the meter does not know
  // it. A meter that stored a weighted total would bake today's weights in.
  it("keeps the four token counts apart and unweighted", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage, MODEL);
    expect(await meter.read(CHANNEL)).toEqual({
      toolCalls: 0,
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      byModel: [{ model: MODEL, ...COUNTS }]
    });
  });

  it("accumulates across turns", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage, MODEL);
    await meter.recordTokens(CHANNEL, "t2", usage, MODEL);
    expect((await meter.read(CHANNEL)).outputTokens).toBe(16);
  });

  // The substitution #62 put here, and the one line of this module that touches
  // the model at all. It names a bucket — it does not decide anything, and a
  // channel whose sheet sets no `daily_usd` is metered exactly as before.
  it("files a report that named no model under the reserved bucket", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage);

    const spend = await meter.read(CHANNEL);
    expect(spend.byModel).toEqual([{ model: UNREPORTED_MODEL, ...COUNTS }]);
    // The totals are untouched by the substitution, which is what makes this
    // inert for `daily_tokens`.
    expect(spend.inputTokens).toBe(120);
  });

  // Two of them, and they must not merge: "no model was named" and "this model
  // was named" are different facts, and one of them is the one a dollar cap
  // refuses on.
  it("keeps the reserved bucket apart from a named model's", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage);
    await meter.recordTokens(CHANNEL, "t2", usage, MODEL);

    const spend = await meter.read(CHANNEL);
    expect(spend.byModel.map(bucket => bucket.model)).toEqual([UNREPORTED_MODEL, MODEL]);
    expect(spend.inputTokens).toBe(240);
  });
});

describe("retrying a report", () => {
  it("records a turn once and calls the repeat a duplicate", async () => {
    expect(await meter.recordTokens(CHANNEL, "t1", usage)).toEqual({ outcome: "recorded" });
    expect(await meter.recordTokens(CHANNEL, "t1", usage)).toEqual({ outcome: "duplicate" });
    expect((await meter.read(CHANNEL)).inputTokens).toBe(120);
  });

  // A duplicate is what a retry should get: the turn is counted, nothing was
  // denied, and the caller has nothing to do about it.
  it("leaves the counters untouched on a duplicate", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage);
    const before = await meter.read(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", { ...usage, inputTokens: 5_000_000 });
    expect(await meter.read(CHANNEL)).toEqual(before);
  });
});

describe("two channels metered at once", () => {
  it("keeps their counters entirely apart", async () => {
    await meter.recordToolCall(CHANNEL);
    await meter.recordToolCall(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", usage);
    await meter.recordToolCall(OTHER);

    expect((await meter.read(CHANNEL)).toolCalls).toBe(2);
    expect((await meter.read(OTHER)).toolCalls).toBe(1);
    expect((await meter.read(OTHER)).inputTokens).toBe(0);
  });

  // Turn ids are generated per agent process and two channels can plausibly
  // produce the same one. Deduping across channels would silently drop spend.
  it("does not let one channel's turn id shadow another's", async () => {
    expect(await meter.recordTokens(CHANNEL, "t1", usage)).toEqual({ outcome: "recorded" });
    expect(await meter.recordTokens(OTHER, "t1", usage)).toEqual({ outcome: "recorded" });
    expect((await meter.read(OTHER)).inputTokens).toBe(120);
  });
});

describe("the day boundary", () => {
  // Rollover is a property of the clock, not of anything the process
  // remembers: a new UTC day is a key that has never been written.
  it("reads zero once the day rolls over", async () => {
    await meter.recordToolCall(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", usage);

    clock = NEXT_DAY;
    expect(await meter.read(CHANNEL)).toEqual(NO_SPEND);
  });

  // Rollover is not a wipe. Yesterday's row is still there, which is what
  // distinguishes a key change from a sweep and is the only per-day history
  // the deployment has until the audit log lands.
  it("leaves the previous day's counters in place", async () => {
    await meter.recordToolCall(CHANNEL);
    clock = NEXT_DAY;
    await meter.recordToolCall(CHANNEL);
    clock = NOON;

    expect((await meter.read(CHANNEL)).toolCalls).toBe(1);
  });

  it("does not roll over a millisecond early", async () => {
    await meter.recordToolCall(CHANNEL);
    clock = NEXT_DAY - 1;
    expect((await meter.read(CHANNEL)).toolCalls).toBe(1);
  });
});

// The meter's whole share of the soft limit (#99): which day the claim belongs
// to. Whether the threshold is crossed is ./enforce.ts's, and this file has no
// team sheet to ask.
describe("claiming the day's warning", () => {
  it("gives the claim to the first caller and refuses the rest", async () => {
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(true);
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(false);
  });

  // The same rollover the counters have, from the same clock: a channel warned
  // at 23:59 can be warned again at 00:01, because that is a different day and
  // a different budget.
  it("re-arms when the day rolls over", async () => {
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(true);
    clock = NEXT_DAY;
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(true);
  });

  it("does not re-arm a millisecond early", async () => {
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(true);
    clock = NEXT_DAY - 1;
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(false);
  });

  it("keeps one channel's claim out of another's", async () => {
    expect(await meter.claimWarning(CHANNEL, "daily_tokens")).toBe(true);
    expect(await meter.claimWarning(OTHER, "daily_tokens")).toBe(true);
  });

  it("counts nothing", async () => {
    await meter.claimWarning(CHANNEL, "daily_tokens");
    expect(await meter.read(CHANNEL)).toEqual(NO_SPEND);
  });
});

describe("surviving a restart", () => {
  // The counters roll over at the day boundary rather than at process start:
  // a proxy restarted at noon reads the same numbers it wrote at eleven.
  it("reads back what it wrote before the process went away", async () => {
    await meter.recordToolCall(CHANNEL);
    await meter.recordTokens(CHANNEL, "t1", usage, MODEL);
    db.close();

    db = openBudgetDb({ file });
    meter = createSqliteSpendMeter({ db, now: () => clock });
    expect(await meter.read(CHANNEL)).toEqual({
      toolCalls: 1,
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      byModel: [{ model: MODEL, ...COUNTS }]
    });
  });

  it("still refuses a turn it counted before the restart", async () => {
    await meter.recordTokens(CHANNEL, "t1", usage);
    db.close();

    db = openBudgetDb({ file });
    meter = createSqliteSpendMeter({ db, now: () => clock });
    expect(await meter.recordTokens(CHANNEL, "t1", usage)).toEqual({ outcome: "duplicate" });
  });
});

describe("reading without a cache", () => {
  // The property the operator reset rests on. A second process clearing the
  // row has to be visible to the very next call, or `budget reset` is a lie
  // until the proxy bounces.
  it("sees a write made by another handle on the same file", async () => {
    await meter.recordToolCall(CHANNEL);

    const operator = openBudgetDb({ file });
    operator.clearDay(CHANNEL, "2026-08-04");
    operator.close();

    expect(await meter.read(CHANNEL)).toEqual(NO_SPEND);
  });
});

describe("pruning reported turns", () => {
  it("drops turn ids past the retention window", async () => {
    await meter.recordTokens(CHANNEL, "old", usage);

    // Far enough past retention that "old" is collectable, and a new day so
    // the once-per-day gate opens.
    clock = NOON + TURN_RETENTION_MS + 1;
    await meter.recordTokens(CHANNEL, "new", usage);

    // "old" is no longer deduped — that is the trade the window buys.
    expect(await meter.recordTokens(CHANNEL, "old", usage)).toEqual({ outcome: "recorded" });
  });

  it("keeps a turn id that is still inside the window", async () => {
    await meter.recordTokens(CHANNEL, "recent", usage);
    clock = NEXT_DAY;
    await meter.recordTokens(CHANNEL, "next", usage);

    expect(await meter.recordTokens(CHANNEL, "recent", usage)).toEqual({ outcome: "duplicate" });
  });

  // Counters are not pruned. They are the deployment's only spend history.
  it("never prunes a counter", async () => {
    await meter.recordTokens(CHANNEL, "old", usage);
    clock = NOON + TURN_RETENTION_MS + 1;
    await meter.recordTokens(CHANNEL, "new", usage);
    clock = NOON;

    expect((await meter.read(CHANNEL)).inputTokens).toBe(120);
  });
});

describe("opening a meter and its file together", () => {
  it("hands back a working meter and the handle to close", async () => {
    const opened = openSpendMeter({ file: join(dir, "opened.db"), now: () => clock });
    try {
      await opened.meter.recordToolCall(CHANNEL);
      expect((await opened.meter.read(CHANNEL)).toolCalls).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});
