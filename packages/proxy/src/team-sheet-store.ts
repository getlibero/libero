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
//
// What that pairing does not say, and what #137 was, is that the watcher also
// reads at the worst possible moment. It fires partway through a write that is
// not atomic — a shell redirect truncates before it writes — so its read lands
// when the file is least likely to be whole. The read itself corrects itself:
// the fingerprint it caches is the one it stat'ed, so the settled file looks
// different and is read again. What does not correct itself is handing that
// answer to a caller who arrived after the write landed. So resolve() shares a
// read only while it has not yet looked at the file.
//
// **The transient `team_sheet_invalid` is expected, and #342 decided not to
// remove it.** A torn read is a read of a file that does not parse, so it takes
// the same branch a real typo takes: an `error` line saying the edit did not
// land and that the previous sheet is still in force, followed — once the write
// settles and the watcher fires again — by an `info` line saying it did. Both
// are true of the instant they describe. The sequence is still misleading, so
// the second line now carries `supersedes: "team_sheet_invalid"` and retracts
// the first in the log rather than in the reader's head.
//
// The complaint itself stays, because every way of suppressing it is worse.
// Measured rather than argued: against a writer that holds the truncation window
// open for 25ms, forty valid saves produced twenty-one complaints and forty
// successful reloads. Re-stating after the failed parse and suppressing when the
// file moved — the cheap fix, and no timer — took that to twenty, because a read
// and a stat together are microseconds and the window they have to fall inside
// is not. Closing it needs a delay before the complaint, which means a timer in
// the watcher, which is where #141 lives; and the writers that provoke it are
// both non-atomic *and* slow, which the CLI's own sheet writer is neither
// (`@getlibero/atomic-write`, so `libero channel add` never tears). Paying with
// timing in the weaker of the two mechanisms to quiet a line that retracts
// itself is the wrong trade.
//
// So: a `team_sheet_invalid` with no `supersedes` line after it is real. One
// followed by a reload that supersedes it was a torn read, and the sheet on disk
// is fine.

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
  /** No sheet file. The channel is not provisioned, or has been retired. */
  | { readonly status: "absent" }
  /** A sheet file exists, has never parsed, and there is no earlier good one. */
  | { readonly status: "unusable" };

/**
 * One channel's state, and nothing else.
 *
 * What the routes actually need from a store, and therefore what they are
 * handed — the same narrowing as the write-only `AuditWriter` the server closes
 * over, and `TokenRecorder` in place of the meter. A route holding the store
 * itself could `close()` it, and every caller reading a type would have to work
 * out that it does not.
 *
 * It also draws a line the store's own internals sit on the other side of. The
 * watcher refreshes a channel by calling `this.resolve` (see `#watch`), which is
 * the store keeping itself current rather than anything asking it a question —
 * so a count taken at *this* boundary is a count of what a request caused, and
 * `server.test.ts` depends on exactly that.
 */
export interface TeamSheetSource {
  resolve(channel: string): Promise<SheetState>;
}

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
  /**
   * Whether `inFlight` has taken the stat its answer will describe. Until it
   * has, a caller arriving now is answered by a look that is still to come and
   * may share it. After it has, that caller needs its own.
   */
  inFlightStated: boolean;
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
export class TeamSheetStore implements TeamSheetSource {
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
   *
   * Concurrent callers still share one read, but only one that has not yet
   * looked at the file, so an answer is never older than the question.
   */
  async resolve(channel: string): Promise<SheetState> {
    const file = this.path(channel);
    const entry = this.#entry(channel);

    // A read that has not stat'ed yet will stat after this call, so its answer
    // is an answer to this call and sharing it is free. A read that has
    // already stat'ed describes the file as it was before this caller arrived;
    // passing that on is how a resolve came back describing a sheet that had
    // already been replaced (#137). The watcher makes that ordering routine
    // rather than exotic: it fires partway through a non-atomic write, so its
    // read is in flight at exactly the moment a caller is likely to ask.
    const running = entry.inFlight;
    if (running !== null && !entry.inFlightStated) return running;

    const work = this.#queued(running, channel, file, entry).finally(() => {
      if (entry.inFlight === work) {
        entry.inFlight = null;
        entry.inFlightStated = false;
      }
    });
    entry.inFlight = work;
    entry.inFlightStated = false;
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
      entry = {
        state: { status: "absent" },
        fingerprint: null,
        inFlight: null,
        inFlightStated: false,
        watcher: null
      };
      this.#entries.set(channel, entry);
    }
    return entry;
  }

  /**
   * Refreshes on one channel run one at a time. They write the cached state
   * and the fingerprint it is keyed to, and two in flight would interleave
   * those writes and leave the pair describing two different reads.
   *
   * This queues at most one deep however many callers arrive. A refresh that
   * is waiting here has not stat'ed, so everyone turning up behind it shares
   * it rather than adding another — which is the same rule that lets
   * simultaneous callers share a read in the first place.
   */
  async #queued(
    running: Promise<SheetState> | null,
    channel: string,
    file: string,
    entry: Entry
  ): Promise<SheetState> {
    // Whatever it answered belongs to its own caller, including a failure.
    // This refresh is about to look for itself either way.
    if (running !== null) await running.catch(() => undefined);
    return this.#refresh(channel, file, entry);
  }

  async #refresh(channel: string, file: string, entry: Entry): Promise<SheetState> {
    const fingerprint = await this.#fingerprint(file);
    // From here the answer describes the file as of the stat above, so it has
    // stopped being an answer to a caller who has not arrived yet.
    entry.inFlightStated = true;

    if (fingerprint === null) {
      // Gone. Deletion takes effect immediately and is not treated like an
      // invalid edit, because the two differ in what the operator has told us.
      // A typo leaves their intent unknown, so the last good sheet stays in
      // force. A deletion states the intent plainly, and the architecture
      // defines removing a sheet as how a channel is retired — so it must not
      // be the one edit that leaves permissions running.
      //
      // The retain rule has a sharper edge since #79, and it is deliberately
      // not softened here: a sheet edit that revokes a leaked certificate and
      // fails to parse leaves the leaked fingerprint pinned. Reversing that for
      // one field would mean a typo disables a channel, which is the failure
      // this rule exists to prevent — so the answer is the `team_sheet_invalid`
      // line below, which says at save time that the edit did not land, and
      // this branch, which is the emergency path when it has to land now.
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
      // Whether a `team_sheet_invalid` is outstanding for this channel. `stale`
      // is set only by the branch that logs one, so it is exactly the record of
      // "something was complained about and has not been retracted" — which is
      // what this line is about to retract. See `supersedes` in ./log.ts.
      const complained = entry.state.status === "active" && entry.state.stale;
      entry.state = { status: "active", sheet: parsed.sheet, stale: false };
      this.#logger.log("info", {
        event: reloaded ? "team_sheet_reloaded" : "team_sheet_loaded",
        channel,
        file,
        ...(complained ? { supersedes: "team_sheet_invalid" as const } : {})
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
