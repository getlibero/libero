// The ambient scheduler: the one clock in this process, and the one enumerator
// over every channel (#317).
//
// Everything else here runs on channel *activity*. The four background passes
// fire from the message ingest, and ./skill-lifecycle.ts states that as a
// feature rather than a limitation: a cron would mean this process growing a
// timer and an enumerator over every channel, neither of which anything else
// needs. Ambient is the thing that needs both, so they land here once and the
// on-activity passes stay on-activity.
//
// What this module decides is **when to look, and where**. What a heartbeat then
// weighs, and whether anything gets posted, is the evaluation turn's (#319) and
// the posting surface's (#318) — neither of which this file can reach. With no
// `heartbeat` wired it logs `ambient_due` and runs nothing, which is what a
// clock with no reader honestly is.
//
// ## Wake at the next due instant, not on a tick
//
// The loop sleeps until the earliest thing that is due, rather than ticking at a
// fixed rate and asking what has piled up. Today the only kind of due thing is a
// channel's heartbeat, whose instants are cadence multiples; the `schedule_task`
// workstream adds a second kind — a task due at 14:32, which must fire at 14:32
// and not at the next cadence boundary. That one adds an **event source**, not a
// second clock: it contributes entries to the same plan, and `earliestDue`
// answers over all of them. `DueEntry.kind` exists so that addition is an
// addition.
//
// The sleep is capped at `AMBIENT_RESCAN_MS` anyway, and that is not a tick in
// disguise — it is the discovery bound. Nothing notifies this process that a
// sheet was edited, so a loop that only ever woke at a known due instant would
// never learn that a channel just turned ambient on, and a process with no
// enabled channel would sleep forever.
//
// ## Missed windows are skipped, not replayed
//
// A heartbeat asks "does anything here merit a post *now*". Catching up on a
// week of downtime by firing seven hundred of them would be seven hundred
// answers to one question. Two rules make that structural rather than a check
// somewhere:
//
//   - **First sight never fires.** A channel newly seen enabled is scheduled at
//     `now + cadence`, so a fresh process — every restart is one — fires nothing
//     for the windows it was down for. This is `planSkillLifecycle`'s "moves
//     nothing on the run it first meets a skill", and it is why the schedule
//     needs no persistence: in-memory state that starts empty *is* the
//     skip-don't-replay rule.
//   - **A fire schedules from the instant it fired**, not from the deadline it
//     missed, so a scan that finds a channel six windows overdue fires once.
//
// The consequence is stated rather than discovered: an enabled channel waits one
// full cadence after a restart before its first heartbeat, and a channel whose
// sheet just enabled ambient waits one cadence after the scan that noticed. That
// is the right side of the trade — the failure it refuses is a burst of unbidden
// posts after an outage, in a channel nobody was talking to.
//
// ## What bounds it
//
//   - **The sheet.** `[ambient] enabled` is off unless a channel wrote
//     otherwise, and `heartbeat_every_minutes` is the cadence. Re-read per scan,
//     so an edit lands on the next one with no restart — the freshness the
//     proxy's per-call sheet read gives enforcement.
//   - **`AMBIENT_RESCAN_MS`**, which is what a scan costs at most: a `readdir`
//     and one small file read per channel. No network, no model call.
//   - **`MAX_CONCURRENT_HEARTBEATS`**, the fan-out. See the constant.
//   - **The overrun rule.** A channel whose previous heartbeat has not finished
//     is skipped rather than queued.
//   - **The meter**, once #319 gives a heartbeat something to spend — through
//     the same `SpendReport` path every other turn takes. The backstop, not the
//     mechanism.
//
// ## Why the enumerator is the filesystem rather than the live sessions
//
// A session exists because a channel has had traffic. Ambient exists for the
// channel that has *not* — the question sitting unanswered since Friday — so an
// enumerator over live sessions would systematically miss the case the feature
// is for, and would miss every channel again after each restart. So it lists
// `AGENT_CHANNELS_ROOT`, which is the operator's statement about which channels
// exist, read-only, and already the source of truth the sheet resolver reads.
//
// That is also the whole reason this module needs a workspace. A directory
// listing gives channel ids; a `SessionKey` is `(workspace, channel)`, and
// inventing one would key a second session over a live channel — two mutexes
// over one channel's state, which is precisely what the session registry exists
// to prevent. So the workspace is asked for, and it comes from Slack's own
// `auth.test` by way of the gateway (see `SlackGateway.workspace`). Until there
// is one, this scans nothing and says so.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import type { ChannelLister } from "./channels.js";
import type { SessionRegistry } from "./registry.js";

/**
 * The longest this scheduler will sleep, and therefore how late a sheet edit can
 * land.
 *
 * **A ceiling on the sleep, not a tick.** A wake still happens at a due instant
 * earlier than this; what this bounds is how long the process can go without
 * re-reading the channels directory, which is the only way it learns that a
 * channel turned `[ambient] enabled` on — nothing notifies it, and a process
 * with nothing enabled has no due instant to wake at.
 *
 * One minute because that is the shortest cadence a sheet can express:
 * `heartbeat_every_minutes` is `min(1)`, so a scan no coarser than the smallest
 * cadence means a newly enabled channel waits at most one cadence plus one scan.
 * The cost of being wrong in the cheap direction is small — a scan is a
 * `readdir` and one small file read per channel, with no network and no model
 * call in it — which is the opposite of `CURATE_INTERVAL_MS`, where the thing
 * being paced is a completion.
 */
export const AMBIENT_RESCAN_MS = 60_000;

/**
 * How many channels' heartbeats may be in flight at once.
 *
 * `MAX_THREADS_PER_SWEEP`'s counterpart, and what makes the figure different is
 * what starts the work. The four on-activity passes are rate-limited by traffic
 * and run one channel at a time, because a message arrives in one channel. This
 * enumerator can start work in *every* channel at one instant — and after a
 * restart it will try to, because every enabled channel takes the same
 * first-sight instant and therefore comes due together one cadence later.
 *
 * So the bound is against that thundering herd rather than against the steady
 * state, where a scan fires one or two. Four at a time turns a hundred-channel
 * deployment's synchronized wake into a queue that drains over the following
 * seconds instead of a hundred concurrent model calls, and no channel is
 * starved: the scan runs every due channel before it answers, so being fifth in
 * line costs a wait rather than a heartbeat.
 */
export const MAX_CONCURRENT_HEARTBEATS = 4;

/**
 * Runs `fn` after `ms` and answers a cancel.
 *
 * The gateway's `Scheduler`, restated rather than imported: the ESLint rule on
 * this directory allows four names through from that package and this is not one
 * of them, which is the rule working rather than a wrinkle — a timer seam is
 * two lines and does not need to arrive from the Slack adapter. A seam at all so
 * that a test drives the loop without waiting real minutes, and so `stop()`
 * cancels a pending sleep instead of leaving a timer holding the process open
 * for a minute.
 */
export type AmbientTimer = (ms: number, fn: () => void) => () => void;

const defaultTimer: AmbientTimer = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** What the scheduler needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface AmbientSchedulerSettings {
  /** `[ambient] enabled`. False and the channel is never enumerated into work. */
  readonly enabled: boolean;
  /** `[ambient] heartbeat_every_minutes`, in milliseconds. */
  readonly heartbeatEveryMs: number;
}

/**
 * What runs when a channel's cadence comes due.
 *
 * `SummarySweep`'s shape, and it takes the session's store for that one's reason:
 * a channel's file is opened once, by the session, and a pass that opened its own
 * would be a second handle with its own lifetime.
 *
 * Optional on the scheduler. Absent, a due channel logs `ambient_due` and nothing
 * runs — which is what this issue ships, since the turn that weighs a channel is
 * #319. Its rejection is caught and logged; it does not stop the scan.
 */
export type AmbientHeartbeat = (channel: string, store: MessageStore) => Promise<void>;

/** One thing that will be due at an instant. */
export interface DueEntry {
  /**
   * What kind of due thing this is.
   *
   * One member today. `schedule_task`'s firing issue adds the second, and the
   * point of the field is that it adds a *member* — a due task contributes an
   * entry to this same plan and wakes the same loop at its own instant, rather
   * than bringing a second clock.
   */
  readonly kind: "heartbeat";
  readonly channel: string;
  readonly dueAt: number;
}

/** What one scan did, and when the loop should wake next. */
export interface AmbientScan {
  /**
   * How many channels came due and were acted on.
   *
   * Heartbeats run, or — with no heartbeat wired — channels that would have had
   * one. A channel skipped for an overrun, or one whose heartbeat threw, is not
   * counted.
   */
  readonly fired: number;
  /** The earliest instant anything is due, or `null` when nothing is. */
  readonly nextDueAt: number | null;
}

export interface AmbientSchedulerOptions {
  /**
   * Which channels exist, asked once per scan. See ./channels.ts — it lists the
   * channels root, which is the operator's statement about what a channel is,
   * and it never rejects.
   */
  channels: ChannelLister;
  /** The one registry, so a heartbeat runs on the same mutex a task does. */
  sessions: SessionRegistry;
  /**
   * The workspace this app is installed in, or `undefined` while it is not yet
   * known.
   *
   * A function rather than a value because the answer arrives during
   * `gateway.start()` and is read on a clock afterwards. `undefined` scans
   * nothing: a `SessionKey` this module made up would be a second session, and
   * therefore a second mutex, over a live channel.
   */
  workspace: () => string | undefined;
  /** The channel's `[ambient]` block, re-read per scan. Never throws. */
  settings: (channel: string) => Promise<AmbientSchedulerSettings>;
  heartbeat?: AmbientHeartbeat;
  /** Injected so a test drives the loop without waiting real minutes. */
  timer?: AmbientTimer;
  /** Injected so a test states the clock rather than faking timers. */
  now?: () => number;
  /** Cancels in-flight work when the process is stopping. */
  signal?: AbortSignal;
  logger?: Logger;
}

export interface AmbientScheduler {
  /**
   * Begins the loop. Idempotent — a second call while running does nothing.
   *
   * Called after the gateway has connected, because that is when there is a
   * workspace to key a session with.
   */
  start(): void;
  /** Cancels the pending sleep. In-flight heartbeats unwind on the signal. */
  stop(): void;
  /**
   * Runs every channel due at `at`, and answers when the next thing is due.
   *
   * **The whole of the behaviour**, so a test drives this rather than a timer.
   * Never rejects: an unreadable channels directory, an unopenable store and a
   * throwing heartbeat are each one log line and a scan that carries on.
   */
  scan(at: number): Promise<AmbientScan>;
}

/**
 * The earliest instant in a plan, or `null` for an empty one.
 *
 * A named function over `DueEntry[]` rather than a `Math.min` inline, because
 * this is the seam a second event source joins at: what wakes the loop is the
 * minimum over *entries*, not a multiple of any one cadence.
 */
export function earliestDue(entries: readonly DueEntry[]): number | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    if (earliest === null || entry.dueAt < earliest) earliest = entry.dueAt;
  }
  return earliest;
}

/**
 * Runs `work` over `items`, at most `limit` at a time, and waits for all of them.
 *
 * Awaited rather than fired and forgotten, which is the opposite of what the
 * ingest path does with the four passes — and the reason is that nothing is
 * waiting on a scan. There, a person is waiting on the handler and a pass must
 * not delay a reply; here the only caller is a timer, and awaiting is what gives
 * the concurrency bound teeth: a scan that returned immediately would let the
 * next one start work in the same channels.
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const item = items[next++];
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Builds the scheduler. It starts nothing until `start()`.
 *
 * The schedule is in memory and starts empty, and that is load-bearing rather
 * than a simplification — see the header on why first sight never fires.
 */
export function createAmbientScheduler(options: AmbientSchedulerOptions): AmbientScheduler {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const timer = options.timer ?? defaultTimer;
  const heartbeat = options.heartbeat;
  const signal = options.signal;

  /** When each enabled channel is next due. Dropped when a channel disables. */
  const schedule = new Map<string, number>();
  /** Channels whose heartbeat has not finished. See the overrun rule. */
  const running = new Set<string>();

  let started = false;
  let stopped = false;
  let cancelSleep: (() => void) | undefined;

  /** One channel's heartbeat, on its session's mutex. Never rejects. */
  async function fire(channel: string, workspace: string): Promise<boolean> {
    running.add(channel);
    try {
      if (heartbeat === undefined) {
        // No reader wired: the clock still says what it would have done, which
        // is what an operator turning `[ambient]` on before #319 lands should be
        // able to see.
        logger.log("info", { event: "ambient_due", team: workspace, channel });
        return true;
      }

      const session = options.sessions.open({ workspace, channel });
      const store = session.store;
      if (store === null) {
        // No sheet, or the file could not be opened — said once when the session
        // was created. A heartbeat with no store has nothing to weigh.
        logger.log("error", {
          event: "ambient_failed",
          team: workspace,
          channel,
          reason: "store_unavailable"
        });
        return false;
      }

      // On the mutex, for the reason the four passes are: it reads the channel's
      // store, and a task's context read has to be serialized against that
      // rather than racing it.
      await session.mutex.run(() => heartbeat(channel, store));
      logger.log("info", { event: "ambient_due", team: workspace, channel });
      return true;
    } catch (error) {
      logger.log("error", {
        event: "ambient_failed",
        team: workspace,
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return false;
    } finally {
      running.delete(channel);
    }
  }

  async function scan(at: number): Promise<AmbientScan> {
    const workspace = options.workspace();
    if (workspace === undefined) {
      // Before `auth.test` has answered, or in a composition with no identity to
      // ask. Nothing is enumerated and nothing is scheduled, so the first scan
      // that *can* act is also the one that first sees each channel — which
      // keeps the first-sight rule true rather than seeding a schedule this
      // process could not have acted on.
      logger.log("warn", { event: "ambient_unidentified" });
      return { fired: 0, nextDueAt: null };
    }

    const channels = await options.channels();
    const due: string[] = [];
    const enabled = new Set<string>();

    for (const channel of channels) {
      // Wrapped, though the resolver is documented total: this loop is the
      // enumerator, and "one channel does not stop the rest" has to hold for the
      // sheet read as much as for the heartbeat. A channel whose settings could
      // not be resolved keeps whatever deadline it had and is looked at again on
      // the next scan.
      let settings: AmbientSchedulerSettings;
      try {
        settings = await options.settings(channel);
      } catch (error) {
        logger.log("error", {
          event: "ambient_failed",
          team: workspace,
          channel,
          reason: error instanceof Error ? error.name : "unknown"
        });
        enabled.add(channel);
        continue;
      }
      if (!settings.enabled) continue;
      enabled.add(channel);

      const dueAt = schedule.get(channel);
      if (dueAt === undefined) {
        // First sight. Scheduled, never fired — see the header.
        schedule.set(channel, at + settings.heartbeatEveryMs);
        continue;
      }
      if (dueAt > at) continue;

      // Rescheduled from *this* instant and with the cadence just read, so a
      // missed window collapses to one heartbeat and an edited cadence takes
      // effect here rather than at the next fire.
      schedule.set(channel, at + settings.heartbeatEveryMs);

      if (running.has(channel)) {
        // The previous heartbeat has not finished. Skipped rather than queued:
        // a channel that is already behind gets further behind if its turns
        // stack up on the mutex, and the next scan will find it due again.
        logger.log("warn", { event: "ambient_overrun", team: workspace, channel });
        continue;
      }
      due.push(channel);
    }

    // A channel that disabled ambient, or whose directory is gone, loses its
    // entry — so re-enabling starts a fresh cadence rather than firing
    // immediately off a stale deadline, and the map cannot outgrow the
    // directory.
    for (const channel of [...schedule.keys()]) {
      if (!enabled.has(channel)) schedule.delete(channel);
    }

    let fired = 0;
    await runBounded(due, MAX_CONCURRENT_HEARTBEATS, async channel => {
      // Checked per channel rather than once: a scan of a hundred channels
      // outlives the signal that cancelled it, and what is left to do is exactly
      // what should not be started.
      if (signal?.aborted === true || stopped) return;
      if (await fire(channel, workspace)) fired += 1;
    });

    const plan: DueEntry[] = [...schedule].map(([channel, dueAt]) => ({
      kind: "heartbeat",
      channel,
      dueAt
    }));
    return { fired, nextDueAt: earliestDue(plan) };
  }

  /** Scan, sleep, repeat. Nothing awaits this; it ends when `stop()` is called. */
  function loop(): void {
    if (stopped) return;
    const at = now();
    void scan(at)
      .catch(() => ({ fired: 0, nextDueAt: null }) as AmbientScan)
      .then(result => {
        if (stopped) return;
        const horizon = at + AMBIENT_RESCAN_MS;
        const wakeAt = result.nextDueAt === null ? horizon : Math.min(result.nextDueAt, horizon);
        // From a fresh reading rather than from `at`: the scan itself took time,
        // and sleeping the full interval on top of it would drift the cadence by
        // however long a heartbeat ran.
        cancelSleep = timer(Math.max(0, wakeAt - now()), loop);
      });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      loop();
    },

    stop(): void {
      stopped = true;
      cancelSleep?.();
      cancelSleep = undefined;
    },

    scan
  };
}
