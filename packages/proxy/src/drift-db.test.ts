// The price-drift record's own cases (#239).
//
// The property under test throughout is that aggregation loses nothing: a row
// is turns summed, counts summed and reported cost summed, and pricing the
// summed counts has to equal pricing each turn and adding the results. That is
// what makes a bounded file an honest comparison rather than an approximate one.

import { after, before, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DRIFT_SCHEMA_VERSION, openDriftDb, type DriftDb } from "./drift-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const MODEL = "claude-sonnet-4-6";
const DAY = "2026-08-29";

/** The counts LiteLLM main-stable was measured against, and what it charged. */
const USAGE = { inputTokens: 11, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 13 };
const REPORTED = 113_850;

let directory: string;
let file: string;
let db: DriftDb;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "drift-db-"));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  file = join(directory, `${Math.random().toString(36).slice(2)}.db`);
  db = openDriftDb({ file });
});

describe("recording a reported cost", () => {
  it("holds one turn as one row", () => {
    db.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: REPORTED });

    expect(db.readAll()).toEqual([
      {
        day: DAY,
        channel: CHANNEL,
        model: MODEL,
        turns: 1,
        usage: USAGE,
        reportedNanoUsd: BigInt(REPORTED)
      }
    ]);
  });

  // The whole reason a bounded file is enough. Cost is linear in the counts at
  // a fixed price, so summing here and pricing once at read time gives what
  // pricing each turn and summing would have given.
  it("sums turns, counts and cost into the row for its day and model", () => {
    for (let i = 0; i < 3; i += 1) {
      db.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: REPORTED });
    }

    expect(db.readAll()).toEqual([
      {
        day: DAY,
        channel: CHANNEL,
        model: MODEL,
        turns: 3,
        usage: {
          inputTokens: 33,
          outputTokens: 6,
          cacheReadTokens: 21,
          cacheWriteTokens: 39
        },
        reportedNanoUsd: BigInt(REPORTED * 3)
      }
    ]);
  });

  it("keeps days, models and channels in rows of their own", () => {
    db.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: 1 });
    db.recordReported(CHANNEL, "2026-08-30", { model: MODEL, usage: USAGE, costNanoUsd: 2 });
    db.recordReported(CHANNEL, DAY, { model: "gpt-4o-mini", usage: USAGE, costNanoUsd: 4 });
    db.recordReported(OTHER, DAY, { model: MODEL, usage: USAGE, costNanoUsd: 8 });

    expect(db.readAll().map(row => [row.day, row.channel, row.model, row.reportedNanoUsd])).toEqual([
      [DAY, OTHER, MODEL, 8n],
      [DAY, CHANNEL, MODEL, 1n],
      [DAY, CHANNEL, "gpt-4o-mini", 4n],
      ["2026-08-30", CHANNEL, MODEL, 2n]
    ]);
  });

  // A gateway that priced a call at nothing said something, and the record has
  // to keep it. What never reaches here is an *absent* figure — the route drops
  // those, because a call nobody priced is not a disagreement.
  it("records a reported zero as a turn with a cost of zero", () => {
    db.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: 0 });

    expect(db.readAll()[0]).toMatchObject({ turns: 1, reportedNanoUsd: 0n });
  });

  // `node:sqlite` throws rather than rounding when an INTEGER does not fit a JS
  // number, so a deployment large enough to pass 2^53 nano-USD — about nine
  // million dollars on one model — would otherwise turn the operator's command
  // into an exception at exactly the scale it matters most.
  it("reads a sum past 2^53 without losing or refusing it", () => {
    const huge = 9_000_000_000_000n;
    for (let i = 0; i < 3; i += 1) {
      db.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: Number(huge) });
    }

    expect(db.readAll()[0]?.reportedNanoUsd).toBe(huge * 3n);
  });
});

describe("failing to record", () => {
  // The contract the spend route rests on: an observation that cannot be
  // written must not fail the report it rode in on, because that report carries
  // the token counts a runaway loop is caught by.
  it("does not throw when the write fails", () => {
    const closed = openDriftDb({ file: join(directory, "closed.db") });
    closed.close();

    expect(() =>
      closed.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: 1 })
    ).not.toThrow();
  });
});

describe("the schema", () => {
  it("stamps the version this build writes", () => {
    const raw = new DatabaseSync(file);
    const row = raw.prepare("SELECT version FROM schema_version").get() as { version: number };
    raw.close();

    expect(row.version).toBe(DRIFT_SCHEMA_VERSION);
  });

  it("refuses a file written by a build it does not understand", () => {
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM schema_version");
    raw.exec("INSERT INTO schema_version (version) VALUES (99)");
    raw.close();

    expect(() => openDriftDb({ file })).toThrow(/schema version 99/);
  });

  // A build that died between `db.exec(SCHEMA)` and the version stamp leaves a
  // real file with real tables and no version. Stamping it is right; refusing
  // it would strand a deployment on a file nothing is wrong with.
  it("stamps a file whose tables exist but whose version was never written", () => {
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM schema_version");
    raw.close();

    const reopened = openDriftDb({ file });
    reopened.recordReported(CHANNEL, DAY, { model: MODEL, usage: USAGE, costNanoUsd: 1 });
    expect(reopened.readAll()).toHaveLength(1);
    reopened.close();
  });
});
