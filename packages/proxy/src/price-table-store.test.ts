import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { waitFor } from "@getlibero/test-kit";
import { expect } from "expect";
import { NO_PRICES, openPriceTableStore, watchDirectory } from "./price-table-store.js";
import type { FileWatcher } from "./price-table-store.js";
import type { LogFields, LogLevel, Logger } from "./log.js";

const SONNET = `
[[model]]
id          = "claude-sonnet-4-6"
input       = 3_000_000
output      = 15_000_000
cache_write = 3_750_000
cache_read  = 300_000
`;

const HAIKU = `
[[model]]
id          = "claude-haiku-4-5"
input       = 1_000_000
output      = 5_000_000
cache_write = 1_250_000
cache_read  = 100_000
`;

let dir: string;
let file: string;
let lines: { level: LogLevel; fields: LogFields }[];
let logger: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-prices-"));
  file = join(dir, "prices.toml");
  lines = [];
  logger = { log: (level, fields) => lines.push({ level, fields }) };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const events = (): string[] => lines.map(line => line.fields.event);

/**
 * A watcher a case drives, in place of `fs.watch` (#474).
 *
 * **This replaced a timeout, and the history is the argument.** The one case that
 * depends on a watcher used to wait for a real `fs.watch` event: first a flat
 * 50 ms, then — when that lost on a loaded machine — a polled second, with the
 * comment claiming a second was "far longer than delivery ever takes". A
 * full-workspace run falsified that too. Raising it a third time would be the
 * same fix with the same expiry ahead of it, and each raise makes a genuine
 * regression slower to surface.
 *
 * So the store takes the watcher as a seam, and the property under test —
 * *an edit the stat cannot see still reaches the store* — is asserted with no
 * timing in it at all. That is `AmbientTimer`'s reason in apps/server: a test
 * should drive the clock rather than wait out the platform's.
 *
 * What this must not become is the seam proving itself, so one case below still
 * runs a real `fs.watch` end to end. See `describe("the real watcher")`.
 */
function drivenWatcher(): { watch: FileWatcher; change: (name: string | null) => void; stopped: () => number } {
  let listener: ((name: string | null) => void) | null = null;
  let stops = 0;
  return {
    stopped: () => stops,
    watch: (_directory, onChange) => {
      listener = onChange;
      return () => {
        stops += 1;
        listener = null;
      };
    },
    change: name => {
      if (listener === null) throw new Error("test: no watcher was established");
      listener(name);
    }
  };
}

describe("a deployment with no price table", () => {
  // The common case for a while: nothing sets `daily_usd`, so nothing needs a
  // file. It must not be a startup failure.
  it("prices nothing and starts anyway", () => {
    const store = openPriceTableStore({ file: undefined, logger });
    expect(store.current()).toBe(NO_PRICES);
    expect(store.current().priceFor("claude-sonnet-4-6")).toBeUndefined();
    expect(events()).toEqual(["price_table_absent"]);
    store.close();
  });

  // The fail-closed half, stated here because it is the half that is easy to
  // lose: "no table" and "this model is not in the table" have to be one answer,
  // so no caller can handle one and forget the other.
  it("answers undefined the same way a table that lacks a model does", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });

    expect(store.current().priceFor("claude-opus-4-6")).toBeUndefined();
    expect(NO_PRICES.priceFor("claude-opus-4-6")).toBeUndefined();
    store.close();
  });
});

describe("loading a table", () => {
  it("prices a model the file names, at all four tiers", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });

    expect(store.current().priceFor("claude-sonnet-4-6")).toEqual({
      id: "claude-sonnet-4-6",
      input: 3_000_000,
      output: 15_000_000,
      cache_write: 3_750_000,
      cache_read: 300_000
    });
    store.close();
  });

  // Observed rather than declared: the file carries no version line, and two
  // tables that differ by a digit must not be able to call themselves the same
  // thing.
  it("stamps a version that follows the bytes", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    const first = store.current().version;
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    writeFileSync(file, SONNET.replace("3_000_000", "3_500_000"));
    expect(store.current().version).not.toBe(first);
    store.close();
  });

  it("logs the digest and the entry count at load", () => {
    writeFileSync(file, SONNET + HAIKU);
    const store = openPriceTableStore({ file, logger });

    const loaded = lines.find(line => line.fields.event === "price_table_loaded");
    expect(loaded?.fields.count).toBe(2);
    expect(loaded?.fields.version).toBe(store.current().version);
    store.close();
  });
});

describe("an edit while the proxy is running", () => {
  // The property that makes raw counts the right thing to store: a corrected
  // price re-prices today's spend on the next call, with no restart.
  it("picks up a new price without being told", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);

    writeFileSync(file, SONNET.replace("3_000_000", "9_000_000"));
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(9_000_000);
    store.close();
  });

  // The edit the stat alone cannot see, and the whole reason there is a watcher:
  // correcting a mistyped digit changes neither the file's size nor its inode,
  // and on a filesystem whose mtime is coarser than the edit it changes nothing
  // the stat compares at all.
  //
  // **The mtime is restored on purpose.** Writing the same-length replacement is
  // not enough to prove anything: this host's mtime has sub-millisecond
  // resolution, so the stat sees such an edit and the case passes with the
  // watcher deleted — a test that encoded the gap instead of catching it. Putting
  // the timestamp back makes every field the stat compares identical, so the
  // watcher is the only thing that can answer, on every host.
  it("sees an in-place edit that changes neither size, inode, nor mtime", () => {
    // Pinned to a whole second before the store ever reads it, because
    // `utimesSync` does not round-trip a sub-millisecond mtime — restoring one
    // captured from a live write leaves a fraction of a millisecond of
    // difference, which is a difference the stat can see.
    const PINNED = new Date(1_700_000_000_000);
    writeFileSync(file, SONNET);
    utimesSync(file, PINNED, PINNED);

    const driven = drivenWatcher();
    const store = openPriceTableStore({ file, logger, watch: driven.watch });
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);

    const before = statSync(file);
    const corrected = SONNET.replace("3_000_000", "9_000_000");
    expect(corrected).toHaveLength(SONNET.length);
    writeFileSync(file, corrected);
    utimesSync(file, PINNED, PINNED);

    // Nothing the stat reads has moved, so the watcher is the only thing that
    // can answer. If this block ever starts failing, the case has stopped
    // testing what it says it does.
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);

    // Still the old price: the bytes changed and nothing has told the store.
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);

    driven.change(basename(file));
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(9_000_000);
    store.close();
  });

  // An unnamed event is treated as possibly ours. A platform that does not say
  // which file changed would otherwise stop covering the one edit the stat
  // cannot see, and it would do it silently.
  it("takes an unnamed change as possibly its own", () => {
    const PINNED = new Date(1_700_000_000_000);
    writeFileSync(file, SONNET);
    utimesSync(file, PINNED, PINNED);

    const driven = drivenWatcher();
    const store = openPriceTableStore({ file, logger, watch: driven.watch });
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);

    writeFileSync(file, SONNET.replace("3_000_000", "9_000_000"));
    utimesSync(file, PINNED, PINNED);

    driven.change(null);
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(9_000_000);
    store.close();
  });

  it("ignores a change to some other file in the directory", () => {
    const PINNED = new Date(1_700_000_000_000);
    writeFileSync(file, SONNET);
    utimesSync(file, PINNED, PINNED);

    const driven = drivenWatcher();
    const store = openPriceTableStore({ file, logger, watch: driven.watch });
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);

    writeFileSync(file, SONNET.replace("3_000_000", "9_000_000"));
    utimesSync(file, PINNED, PINNED);

    driven.change("something-else.toml");
    // Unchanged: the stat cannot see this edit and the event was not ours.
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);
    store.close();
  });

  it("stops watching when it is closed", () => {
    writeFileSync(file, SONNET);
    const driven = drivenWatcher();
    const store = openPriceTableStore({ file, logger, watch: driven.watch });

    expect(driven.stopped()).toBe(0);
    store.close();
    expect(driven.stopped()).toBe(1);
  });

  // A syntax error is an operator mid-edit. Widening every channel to
  // unpriceable would refuse deployments that were working a keystroke ago, and
  // the previous table is what they last successfully said.
  it("keeps the last good table when the file stops parsing", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    const before = store.current().version;

    writeFileSync(file, "[[model]\nid = ");
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);
    expect(store.current().version).toBe(before);
    expect(events()).toContain("price_table_invalid");

    // And recovers on the next good write, rather than needing a restart.
    writeFileSync(file, HAIKU);
    expect(store.current().priceFor("claude-haiku-4-5")).toBeDefined();
    expect(store.current().priceFor("claude-sonnet-4-6")).toBeUndefined();
    store.close();
  });

  // The one fault that does drop the table. Serving prices out of bytes that are
  // no longer on disk is serving a number nobody can review — and dropping it
  // fails closed, because an unpriced model refuses a channel capped in dollars.
  it("drops the table when the file is removed", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    expect(store.current().priceFor("claude-sonnet-4-6")).toBeDefined();

    unlinkSync(file);
    expect(store.current().priceFor("claude-sonnet-4-6")).toBeUndefined();
    expect(store.current().version).toBe("");
    expect(events()).toContain("price_table_unreadable");
    store.close();
  });

  // A file that has not changed must not be re-read on every decision — this is
  // called once per served call.
  it("does not reload a file that has not changed", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    for (let i = 0; i < 5; i += 1) store.current();

    expect(events().filter(event => event === "price_table_loaded")).toHaveLength(1);
    store.close();
  });

  it("stops re-reading once closed", () => {
    writeFileSync(file, SONNET);
    const store = openPriceTableStore({ file, logger });
    store.close();

    writeFileSync(file, HAIKU);
    expect(store.current().priceFor("claude-haiku-4-5")).toBeUndefined();
    expect(store.current().priceFor("claude-sonnet-4-6")).toBeDefined();
  });
});

describe("a table that does not start", () => {
  // Loud at load rather than resolved by a rule. Two prices for one model is a
  // file that says two things about one number.
  it("refuses a duplicate model id and keeps nothing", () => {
    writeFileSync(file, SONNET + SONNET);
    const store = openPriceTableStore({ file, logger });

    expect(store.current().priceFor("claude-sonnet-4-6")).toBeUndefined();
    expect(events()).toContain("price_table_invalid");
    store.close();
  });
});

/**
 * The one place a real `fs.watch` is exercised (#474).
 *
 * The seam above removed the platform's timing from every case that was about
 * the *store*. This is what stops that becoming the seam proving itself: the
 * default `watchDirectory` is what every deployment runs, and a mistake in it —
 * the wrong directory, a basename that never matches, an error handler that
 * swallows — would otherwise ship with a green suite.
 *
 * It asserts the notifier and nothing downstream of it, so a failure here means
 * one thing rather than three. And its bound is **ten seconds**, deliberately far
 * past anything a working platform takes: this is the one assertion in the file
 * that waits on the operating system, so its timeout should be long enough that
 * reaching it is news. `waitFor` polls, so an event that arrives in a
 * millisecond costs a millisecond.
 */
describe("the real watcher", () => {
  it("tells the caller which file in the directory changed", async () => {
    const seen: (string | null)[] = [];
    writeFileSync(file, SONNET);
    const stop = watchDirectory(dir, name => seen.push(name));

    try {
      writeFileSync(file, `${SONNET}\n# touched\n`);
      await waitFor(
        () => {
          // `null` is a platform that did not say, which the store treats as
          // possibly its own — so either answer is the watcher working.
          expect(seen.some(name => name === null || name === basename(file))).toBe(true);
        },
        { timeout: 10_000 }
      );
    } finally {
      stop();
    }
  });

  // Establishing one must never be a startup failure: the stat covers every
  // ordinary edit, and a proxy must not refuse to start because a filesystem
  // does not support inotify.
  it("is a log line rather than a failure when it cannot be established", () => {
    const store = openPriceTableStore({
      file,
      logger,
      watch: () => {
        throw new Error("inotify unavailable");
      }
    });

    writeFileSync(file, SONNET);
    expect(store.current().priceFor("claude-sonnet-4-6")?.input).toBe(3_000_000);
    expect(events()).toContain("price_table_unwatched");
    store.close();
  });
});
