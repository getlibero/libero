// Resolving a channel's team sheet, and keeping it current.
//
// Two mechanisms, deliberately, because they fail differently.
//
// The authoritative one is a stat on every resolve: if the file's identity has
// changed since the cached copy was read, it is re-read before the answer is
// given. That makes freshness a property of the read path rather than of an
// event arriving, which matters because fs.watch is the weaker half — it drops
// events on some network filesystems, behaves differently across platforms and
// container bind mounts, and an editor's write-to-temp-then-rename can arrive
// as a shape the naive watcher misses entirely. A missed event would mean
// enforcement running on a sheet an operator believes they replaced, which is
// the failure this file exists to prevent.
//
// The watcher then earns its place by doing what the stat cannot: telling an
// operator that the sheet they just saved is broken *at the moment they save
// it*, rather than at whatever later time the channel is next used. A sheet
// that only announces its own invalidity on the next call is a sheet that
// announces it in the middle of somebody's task.
//
// The stat also cannot see a rewrite that lands within the same millisecond at
// the same size, which is rare but not impossible for a scripted edit. The
// watcher covers that. Neither is complete; together they are.

import { type FSWatcher, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ChannelId, type TeamSheet, parseTeamSheet } from "@getlibero/schema";
import { type Logger, createSilentLogger } from "./log.js";

/** The sheet's filename inside a channel's directory. */
export const SHEET_FILENAME = "channel.toml";

/**
 * What a channel's enforcement state is right now.
 *
 * Three answers, not two, and never an empty sheet standing in for a missing
 * one. "There is no sheet" and "there is a sheet and it has never been
 * readable" both deny every call, but they are different operator mistakes with
 * different fixes, and a refusal that cannot tell them apart sends someone to
 * look for a typo in a file that does not exist.
 */
export type SheetState =
  /**
   * A validated sheet is in force. `stale` means the file on disk currently
   * fails to parse and this is the last version that did — enforcement
   * continues on it rather than widening or going dark, and the flag exists so
   * that behaviour is observable instead of silent.
   */
  | { readonly status: "active"; readonly sheet: TeamSheet; readonly stale: boolean }
  /** No sheet file. The channel is not provisioned, or has been revoked. */
  | { readonly status: "absent" }
  /** A sheet file exists, has never parsed, and there is no earlier good one. */
  | { readonly status: "unusable" };

export interface TeamSheetStoreOptions {
  /** The `channels/` directory holding one directory per channel. */
  root: string;
  logger?: Logger;
}

/** How the file looked when it was last read. Any change triggers a re-read. */
interface Fingerprint {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

interface Entry {
  state: SheetState;
  fingerprint: Fingerprint | null;
  /** Deduplicates concurrent resolves of the same channel onto one read. */
  inFlight: Promise<SheetState> | null;
  watcher: FSWatcher | null;
}

function sameFile(a: Fingerprint | null, b: Fingerprint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/**
 * Per-channel team sheets, cached and kept current.
 *
 * There is no accessor that returns more than one channel's sheet, and no
 * iteration over the cache. That is not an oversight to be tidied up later: a
 * method handing back every sheet at once is the seed of a query that joins
 * across channels, and the one-file-per-channel layout is the isolation
 * boundary this service is built on. Ask for one channel, get one channel.
 */
export class TeamSheetStore {
  readonly #root: string;
  readonly #logger: Logger;
  readonly #entries = new Map<string, Entry>();
  #closed = false;

  constructor(options: TeamSheetStoreOptions) {
    this.#root = options.root;
    this.#logger = options.logger ?? createSilentLogger();
  }

  /** Absolute path of a channel's sheet. The channel id is validated first. */
  path(channel: string): string {
    // ChannelId is what makes this concatenation safe: it rejects separators
    // and leading dots, so a resolved id is a single path segment and cannot
    // climb out of the root. The proxy validates the same rule when it reads
    // an id off a certificate; this is the second of the two.
    if (!ChannelId.safeParse(channel).success) {
      throw new Error("TeamSheetStore: channel is not a valid channel id");
    }
    return join(this.#root, channel, SHEET_FILENAME);
  }

  /**
   * The channel's current enforcement state.
   *
   * Re-reads when the file has changed since the cached copy, so a valid edit
   * is picked up without a restart and without waiting for a watch event.
   */
  async resolve(channel: string): Promise<SheetState> {
    const file = this.path(channel);
    const entry = this.#entry(channel);
    if (entry.inFlight !== null) return entry.inFlight;

    const work = this.#refresh(channel, file, entry).finally(() => {
      entry.inFlight = null;
    });
    entry.inFlight = work;
    return work;
  }

  /** Stops watching. Cached state is dropped; the store is not reusable. */
  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      entry.watcher?.close();
      entry.watcher = null;
    }
    this.#entries.clear();
  }

  #entry(channel: string): Entry {
    let entry = this.#entries.get(channel);
    if (entry === undefined) {
      entry = { state: { status: "absent" }, fingerprint: null, inFlight: null, watcher: null };
      this.#entries.set(channel, entry);
    }
    return entry;
  }

  async #refresh(channel: string, file: string, entry: Entry): Promise<SheetState> {
    const fingerprint = await this.#fingerprint(file);

    if (fingerprint === null) {
      // Gone. Deletion takes effect immediately and is not treated like an
      // invalid edit, because the two differ in what the operator has told us.
      // A typo leaves their intent unknown, so the last good sheet stays in
      // force. A deletion states the intent plainly, and the architecture
      // defines removing a sheet as how a channel is revoked — so it must not
      // be the one edit that leaves permissions running.
      if (entry.state.status !== "absent") {
        this.#logger.log("warn", { event: "team_sheet_removed", channel, file });
      }
      entry.state = { status: "absent" };
      entry.fingerprint = null;
      this.#watch(channel, entry);
      return entry.state;
    }

    if (sameFile(fingerprint, entry.fingerprint) && entry.state.status !== "absent") {
      this.#watch(channel, entry);
      return entry.state;
    }

    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // Raced with a delete between the stat and the read. Report what is true
      // now rather than what was true a syscall ago.
      entry.state = { status: "absent" };
      entry.fingerprint = null;
      this.#watch(channel, entry);
      return entry.state;
    }

    const parsed = parseTeamSheet(text);
    entry.fingerprint = fingerprint;

    if (parsed.ok) {
      const reloaded = entry.state.status === "active";
      entry.state = { status: "active", sheet: parsed.sheet, stale: false };
      this.#logger.log("info", {
        event: reloaded ? "team_sheet_reloaded" : "team_sheet_loaded",
        channel,
        file
      });
      this.#watch(channel, entry);
      return entry.state;
    }

    // Loud, and it names the file and what is wrong with it. An operator whose
    // edit did not take effect must not have to infer that from a channel
    // behaving oddly.
    this.#logger.log("error", {
      event: "team_sheet_invalid",
      channel,
      file,
      reason: parsed.reason,
      ...(parsed.reason === "toml_syntax"
        ? { line: parsed.line, column: parsed.column }
        : { issues: parsed.issues.map(issue => `${issue.path}: ${issue.code}`) }),
      // Says which way the failure resolved, so the log line answers the
      // operator's actual question: is my channel still working?
      effect: entry.state.status === "active" ? "previous_sheet_retained" : "no_sheet_in_force"
    });

    entry.state =
      entry.state.status === "active"
        ? { status: "active", sheet: entry.state.sheet, stale: true }
        : { status: "unusable" };
    this.#watch(channel, entry);
    return entry.state;
  }

  async #fingerprint(file: string): Promise<Fingerprint | null> {
    try {
      const stats = await stat(file);
      if (!stats.isFile()) return null;
      return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
    } catch {
      return null;
    }
  }

  /**
   * Watch the channel's *directory*, not the sheet itself.
   *
   * A watch on the file follows the inode, so the common editor and deployment
   * pattern — write a temp file, rename it over the target — leaves the watcher
   * attached to the replaced file and silent about the one now in its place.
   * The directory sees the rename.
   *
   * Nothing is watched while the directory does not exist. That is not a hole:
   * the stat on resolve finds the sheet whenever it appears, so a channel
   * provisioned later works without a restart. It only means a broken sheet in
   * a brand-new channel is reported on first use rather than on save.
   */
  #watch(channel: string, entry: Entry): void {
    if (this.#closed || entry.watcher !== null) return;
    const directory = join(this.#root, channel);
    let watcher: FSWatcher;
    try {
      watcher = watch(directory, { persistent: false });
    } catch {
      return;
    }
    entry.watcher = watcher;
    watcher.on("error", () => {
      watcher.close();
      if (entry.watcher === watcher) entry.watcher = null;
    });
    watcher.on("change", (_event, filename) => {
      // A rename of the directory itself arrives with a null filename; treat
      // anything unnamed as possibly relevant rather than dropping it.
      if (filename !== null && filename !== undefined && filename.toString() !== SHEET_FILENAME) {
        return;
      }
      void this.resolve(channel).catch(() => {
        // resolve throws only on an invalid channel id, which cannot happen
        // here: this watcher exists because the id already validated.
      });
    });
  }
}
