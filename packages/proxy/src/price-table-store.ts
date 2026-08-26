// The price table on disk: read at startup, re-read when it changes, and never
// trusted to be there.
//
// The operator's second authored artifact, after the team sheets. It answers
// what a model's tokens cost so that `[budget] daily_usd` can mean something,
// and like a team sheet it is reviewed, mounted read-only, and re-read while the
// proxy runs rather than at a restart. See ./team-sheet-store.ts for the pattern
// this follows and the two places it deliberately does not.
//
// **One file for the process, not one per channel.** A price is a fact about a
// model and a provider's rate card; it is not a permission and not a per-channel
// setting, so there is nothing here to isolate. What a *channel* may spend is
// its sheet's `daily_usd`, which stays where every other limit is.
//
// **Stat on read, paired with a watcher**, for the reason ./team-sheet-store.ts
// gives: neither is complete on its own. The stat is the reliable half and costs
// one `statSync` on a path already doing a sheet resolve and an upstream HTTP
// call — but `(mtime, size, inode)` cannot see an edit that changed neither
// size nor inode within one clock tick, and correcting a mistyped digit in a
// price is *exactly* that edit. The watcher covers it. The watcher alone would
// not do either: it drops events under load and reports nothing on a filesystem
// that does not support it, so the stat is what makes a missed event cost one
// call rather than a day of wrong prices.
//
// **A parse failure keeps the last good table**, exactly as a sheet does. An
// operator editing a price into a syntax error should not silently widen every
// channel's spend to unpriceable, and should not have their deployment stop
// either — the previous reviewed table is what they last successfully said.

import { createHash } from "node:crypto";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type ModelPrice, type PriceTable, parsePriceTable, priceFor } from "@getlibero/schema";
import type { Logger } from "./log.js";

/**
 * What enforcement is handed: a price for a model, and which bytes said so.
 *
 * Narrow on purpose. A decision needs to look one model up and to record what
 * priced it; it has no business reading the whole table, reloading it, or
 * knowing there is a file. `version` is the content digest — see `digestOf`.
 */
export interface PriceLookup {
  priceFor(model: string): ModelPrice | undefined;
  readonly version: string;
}

/**
 * The lookup a deployment with no price table gets.
 *
 * Prices nothing, and says so with an empty version rather than inventing one.
 * A channel that caps only tokens and tool calls is served exactly as before; a
 * channel whose sheet sets `daily_usd` finds every model unpriced and is
 * refused, which is the fail-closed answer and the loud one.
 *
 * That this is a real value rather than a `null` the callers check is the point:
 * "there is no table" and "the table does not know this model" are the same
 * answer to a decision, and giving them one shape means no call site can handle
 * one and forget the other.
 */
export const NO_PRICES: PriceLookup = {
  priceFor: () => undefined,
  version: ""
};

/**
 * Watches a directory and says when a file in it changed. Answers a cancel.
 *
 * `AmbientTimer`'s shape in apps/server, and it exists for that seam's reason
 * (#474): **`fs.watch` delivery is at the platform's discretion**, so a test that
 * asserts through a real one is asserting how fast the operating system felt like
 * telling us. On macOS a directory watch is FSEvents, which coalesces — and under
 * a full-workspace suite it has exceeded a second, which was already the raised
 * bound.
 *
 * `name` is the basename that changed, or `null` when the platform did not say
 * which — a case the default below deliberately treats as "possibly ours",
 * because a watcher that ignored an unnamed event would silently stop covering
 * the one edit the stat cannot see.
 *
 * Injected only by tests. Nothing in production passes it, and the default is
 * what every deployment runs.
 */
export type FileWatcher = (
  directory: string,
  onChange: (name: string | null) => void
) => () => void;

/**
 * The real one: `fs.watch` over the directory, and never over the file.
 *
 * The directory rather than the file, because a watch on a file follows the
 * inode — and write-a-temp-file-then-rename, which is what editors and
 * deployment tooling do, leaves such a watch pointed at bytes nobody will read
 * again.
 *
 * **A watcher that cannot be established is not an error.** The stat still covers
 * every edit that changes size, inode or mtime, which is every ordinary edit, and
 * a proxy must not refuse to start because a filesystem does not support inotify.
 * So a throw here answers a cancel that does nothing, and the caller logs.
 */
export function watchDirectory(
  directory: string,
  onChange: (name: string | null) => void
): () => void {
  let watcher: FSWatcher | null = watch(directory, { persistent: false });
  watcher.on("error", () => {
    watcher?.close();
    watcher = null;
  });
  watcher.on("change", (_event, name) => {
    onChange(name === null || name === undefined ? null : String(name));
  });
  return () => {
    watcher?.close();
    watcher = null;
  };
}

export interface PriceTableStoreOptions {
  /** The TOML file. Absent is legal and yields `NO_PRICES`. */
  readonly file?: string | undefined;
  readonly logger?: Logger;
  /**
   * How a change is noticed. Defaults to `watchDirectory`, the real `fs.watch`.
   *
   * **Injected only by tests** (#474), so that the one property depending on a
   * watcher — an in-place edit the stat cannot see still reaches the store — is
   * asserted without waiting on the platform. See `FileWatcher`.
   */
  readonly watch?: FileWatcher;
}

export interface PriceTableStore {
  /**
   * The table as of now, re-reading the file if it has changed.
   *
   * Called once per decision, so a corrected price takes effect on the next
   * call with no restart — the property `cache_read_weight` already has, and the
   * reason cost is computed from raw counts rather than accumulated.
   */
  current(): PriceLookup;
  close(): void;
}

/**
 * The version stamped into a decision: the digest of the file's bytes.
 *
 * **Observed, not declared.** A `version = "3"` line in the file would be a
 * claim about the bytes that nothing checks, and an operator who edited a price
 * without touching it would produce two different tables calling themselves the
 * same version — after which a recorded price-table version means nothing. The
 * digest cannot be wrong about what it summarises.
 *
 * Truncated to 16 hex characters. It goes in a log line and, from PR 3, an audit
 * column; the full 64 buys collision resistance against an adversary, and there
 * is none here — the question is only "are these the same bytes I reviewed",
 * which an operator answers against their own git history.
 *
 * A whitespace-only edit changes it. That is correct rather than noise: the
 * reviewed artifact changed, and a version that tried to be clever about which
 * edits count would be a second definition of what the table is.
 */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** What a `statSync` says about the file, as one comparable value. */
function stampOf(file: string): string | null {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

export function openPriceTableStore(options: PriceTableStoreOptions): PriceTableStore {
  const { file, logger } = options;

  if (file === undefined) {
    logger?.log("info", { event: "price_table_absent" });
    return { current: () => NO_PRICES, close: () => {} };
  }

  let stamp: string | null = null;
  let lookup: PriceLookup = NO_PRICES;
  let closed = false;
  // Set by the watcher, cleared by a read. The stat cannot see an in-place edit
  // that kept the size within one mtime tick; this is what makes that edit
  // arrive.
  let touched = false;

  // See `FileWatcher`: the directory is watched rather than the file, and a
  // watcher that cannot be established is a log line rather than a failure.
  let stopWatching: (() => void) | null = null;
  try {
    stopWatching = (options.watch ?? watchDirectory)(dirname(file), name => {
      // An unnamed event is treated as possibly ours. A platform that does not
      // say which file changed would otherwise stop covering the one edit the
      // stat cannot see, silently.
      if (name === null || name === basename(file)) touched = true;
    });
  } catch {
    logger?.log("warn", { event: "price_table_unwatched", file });
  }

  const reload = (): void => {
    const next = stampOf(file);
    if (next === stamp && !touched) return;
    touched = false;
    stamp = next;

    if (next === null) {
      // The file went away. Keeping the last good table would be serving prices
      // from bytes that are no longer on disk and no longer reviewable, so this
      // is the one fault that drops it — and dropping it fails closed, because
      // an unpriced model refuses a channel that caps in dollars.
      logger?.log("error", { event: "price_table_unreadable", file });
      lookup = NO_PRICES;
      return;
    }

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      logger?.log("error", { event: "price_table_unreadable", file });
      lookup = NO_PRICES;
      return;
    }

    const parsed = parsePriceTable(text);
    if (!parsed.ok) {
      // Keep what the operator last successfully said. The parse reasons carry
      // positions and issue codes rather than file content, for the reason
      // ./team-sheet-store.ts gives.
      logger?.log("error", {
        event: "price_table_invalid",
        file,
        reason: parsed.reason
      });
      return;
    }

    lookup = lookupOver(parsed.table, digestOf(text));
    logger?.log("info", {
      event: "price_table_loaded",
      file,
      version: lookup.version,
      count: parsed.table.model.length
    });
  };

  reload();

  return {
    current() {
      if (!closed) reload();
      return lookup;
    },
    close() {
      closed = true;
      stopWatching?.();
      stopWatching = null;
    }
  };
}

function lookupOver(table: PriceTable, version: string): PriceLookup {
  return {
    priceFor: model => priceFor(table, model),
    version
  };
}
