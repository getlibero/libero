// The ambient clock, driven by `scan` rather than by a timer.
//
// Every claim this module makes is a claim about *when* something fires, and a
// test that waited real minutes to check one would be a test nobody runs. So the
// clock is an argument: each case steps `at` and asserts what fired, which is
// also the seam the loop uses — `start()` is a sleep wrapped around this.
//
// The session registry is real, over one real store, because what is being
// checked includes which mutex a heartbeat runs on. The enumerator is a function
// answering a list, because listing a directory is ./channels.ts's job and has
// its own test beside this one.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import {
  AMBIENT_RESCAN_MS,
  MAX_CONCURRENT_HEARTBEATS,
  createAmbientScheduler,
  earliestDue
} from "./ambient.js";
import type { AmbientSchedulerOptions, AmbientSchedulerSettings } from "./ambient.js";
import { createSessionRegistry } from "./registry.js";

const WORKSPACE = "T0LIBERO";
const AT = 1_700_000_000_000;
const CADENCE_MS = 15 * 60_000;

const ON: AmbientSchedulerSettings = { enabled: true, heartbeatEveryMs: CADENCE_MS };
const OFF: AmbientSchedulerSettings = { enabled: false, heartbeatEveryMs: CADENCE_MS };

let root: string;
let store: MessageStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-ambient-"));
  // `openMessageStore` creates no directory — that gate is store.ts's, and this
  // test is not it.
  mkdirSync(join(root, "C0ENGINEERING"));
  store = openMessageStore({ channel: "C0ENGINEERING", root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** Drains the microtask queue, so a scan's awaits settle before an assertion. */
const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

function captureLogger(): { logger: Logger; lines: LogFields[] } {
  const lines: LogFields[] = [];
  return {
    lines,
    logger: {
      log: (_level: LogLevel, fields: LogFields) => {
        lines.push(fields);
      }
    }
  };
}

interface RigOptions {
  /** Which channels the enumerator answers with. */
  channels?: string[];
  /** What each channel's sheet says. Anything unnamed is off. */
  sheets?: Record<string, AmbientSchedulerSettings>;
  /** Overrides the heartbeat. The default records the channel and returns. */
  heartbeat?: AmbientSchedulerOptions["heartbeat"];
  /**
   * Overrides the fire path. Absent, the rig wires one that records the ticket.
   *
   * `null` composes the scheduler with none at all, which is the deployment
   * where a due ticket is noticed and deliberately left pending.
   */
  fireTask?: AmbientSchedulerOptions["fireTask"] | null;
  /** Overrides the workspace, including to `undefined`. */
  workspace?: () => string | undefined;
  signal?: AbortSignal;
  logger?: Logger;
}

function rig(options: RigOptions = {}) {
  const fired: string[] = [];
  const checked: string[] = [];
  // One store for every channel: nothing here asserts on its contents, and what
  // matters is that the store the session opened is the one the heartbeat gets.
  const sessions = createSessionRegistry({ openStore: () => store });
  const sheets = options.sheets ?? {};

  const scheduler = createAmbientScheduler({
    channels: () => Promise.resolve(options.channels ?? Object.keys(sheets)),
    sessions,
    workspace: options.workspace ?? ((): string | undefined => WORKSPACE),
    settings: channel => Promise.resolve(sheets[channel] ?? OFF),
    heartbeat:
      options.heartbeat ??
      ((channel: string): Promise<void> => {
        fired.push(channel);
        return Promise.resolve();
      }),
    ...(options.fireTask === null
      ? {}
      : {
          fireTask:
            options.fireTask ??
            ((channel: string, _store, task): Promise<void> => {
              checked.push(`${channel}:${task.id}`);
              // What the real one does, and what the scan's next plan depends
              // on: a fired ticket stops being pending.
              store.markScheduledTaskFired(task.id, AT, "posted");
              return Promise.resolve();
            })
        }),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {})
  });

  return { scheduler, fired, checked, sessions };
}

/** A ticket in the one store the rig hands every channel. */
function schedule(id: string, dueAt: number): void {
  store.scheduleTask({ id, task: "task-1", prompt: `check ${id}`, dueAt, createdAt: AT });
}

describe("the ambient scheduler", () => {
  it("fires an enabled channel on its cadence, and not before", async () => {
    const { scheduler, fired } = rig({ sheets: { C0ENGINEERING: ON } });

    // First sight schedules and never fires — the restart rule, from the other
    // end. A channel this process has only just met has nothing it missed.
    expect(await scheduler.scan(AT)).toEqual({ fired: 0, checks: 0, nextDueAt: AT + CADENCE_MS });
    expect(fired).toEqual([]);

    // One tick short.
    expect((await scheduler.scan(AT + CADENCE_MS - 1)).fired).toBe(0);
    expect(fired).toEqual([]);

    expect(await scheduler.scan(AT + CADENCE_MS)).toEqual({
      fired: 1,
      checks: 0,
      nextDueAt: AT + 2 * CADENCE_MS
    });
    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("never fires a channel whose sheet leaves ambient off", async () => {
    // Off is the default, so this is also the case for every channel in every
    // deployment that has not opted in: enumerated, resolved, and scheduled
    // nothing. The clock costs an unenrolled channel one sheet read per scan.
    const { scheduler, fired } = rig({
      channels: ["C0ENGINEERING", "C0QUIET"],
      sheets: { C0ENGINEERING: ON }
    });

    await scheduler.scan(AT);
    await scheduler.scan(AT + 10 * CADENCE_MS);

    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("stops firing when the sheet turns ambient off, with no restart", async () => {
    // The sheet is read per scan for the reason the proxy reads it per call: an
    // operator's edit is the whole mechanism, and a cached answer would make
    // turning the feature off a deployment operation.
    const sheets: Record<string, AmbientSchedulerSettings> = { C0ENGINEERING: ON };
    const { scheduler, fired } = rig({ sheets });

    await scheduler.scan(AT);
    await scheduler.scan(AT + CADENCE_MS);
    expect(fired).toEqual(["C0ENGINEERING"]);

    sheets["C0ENGINEERING"] = OFF;

    expect(await scheduler.scan(AT + 2 * CADENCE_MS)).toEqual({ fired: 0, checks: 0, nextDueAt: null });
    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("starts a fresh cadence when a channel is enabled again", async () => {
    // The entry is dropped when a channel disables, so re-enabling cannot fire
    // immediately off a deadline set before the team turned it off.
    const sheets: Record<string, AmbientSchedulerSettings> = { C0ENGINEERING: ON };
    const { scheduler, fired } = rig({ sheets });

    await scheduler.scan(AT);
    sheets["C0ENGINEERING"] = OFF;
    await scheduler.scan(AT + CADENCE_MS);
    sheets["C0ENGINEERING"] = ON;

    // Due by the old schedule twice over, and fires neither.
    expect((await scheduler.scan(AT + 2 * CADENCE_MS)).fired).toBe(0);
    expect((await scheduler.scan(AT + 3 * CADENCE_MS)).fired).toBe(1);
    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("takes an edited cadence on the next scan", async () => {
    const sheets: Record<string, AmbientSchedulerSettings> = { C0ENGINEERING: ON };
    const { scheduler } = rig({ sheets });

    await scheduler.scan(AT);
    sheets["C0ENGINEERING"] = { enabled: true, heartbeatEveryMs: 60_000 };

    // The pending deadline was set from the old cadence, so this fires when the
    // old one said — and reschedules on the new one, which is what an operator
    // tightening the cadence is asking for.
    expect(await scheduler.scan(AT + CADENCE_MS)).toEqual({
      fired: 1,
      checks: 0,
      nextDueAt: AT + CADENCE_MS + 60_000
    });
  });

  it("fires once for a window it was down for, not once per window missed", async () => {
    // The restart case, which is the one this rule exists for: a fresh scheduler
    // is what every process start has, and a heartbeat asks whether anything
    // merits a post *now*. Seven hundred of them would be seven hundred answers
    // to one question.
    const { scheduler, fired } = rig({ sheets: { C0ENGINEERING: ON } });

    await scheduler.scan(AT);
    await scheduler.scan(AT + 400 * CADENCE_MS);
    await scheduler.scan(AT + 400 * CADENCE_MS + 1);

    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("runs a heartbeat on the channel's session mutex", async () => {
    // Serialized against a task's context read rather than racing it, which is
    // every background pass's rule. This one reaches the same store a task does.
    const { scheduler, sessions } = rig({ sheets: { C0ENGINEERING: ON } });
    const session = sessions.open({ workspace: WORKSPACE, channel: "C0ENGINEERING" });

    let release = (): void => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    void session.mutex.run(() => held);

    await scheduler.scan(AT);
    let done = false;
    const scanning = scheduler.scan(AT + CADENCE_MS).then(result => {
      done = true;
      return result;
    });

    await Promise.resolve();
    expect(done).toBe(false);

    release();
    expect((await scanning).fired).toBe(1);
  });

  it("hands the heartbeat the session's own store", async () => {
    const seen: MessageStore[] = [];
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: ON },
      heartbeat: (_channel, handed) => {
        seen.push(handed);
        return Promise.resolve();
      }
    });

    await scheduler.scan(AT);
    await scheduler.scan(AT + CADENCE_MS);

    expect(seen).toEqual([store]);
  });

  it("carries on when one channel's heartbeat throws", async () => {
    const { logger, lines } = captureLogger();
    const seen: string[] = [];
    const { scheduler } = rig({
      sheets: { C0ALPHA: ON, C0BRAVO: ON, C0CHARLIE: ON },
      logger,
      heartbeat: channel => {
        seen.push(channel);
        return channel === "C0BRAVO"
          ? Promise.reject(new Error("provider is having a minute"))
          : Promise.resolve();
      }
    });

    await scheduler.scan(AT);
    const result = await scheduler.scan(AT + CADENCE_MS);

    expect(seen.sort()).toEqual(["C0ALPHA", "C0BRAVO", "C0CHARLIE"]);
    // Two fired, one failed — and the failure is a log line for that channel
    // rather than a scan that stopped at the second of three.
    expect(result.fired).toBe(2);
    expect(lines.filter(line => line.event === "ambient_failed")).toEqual([
      { event: "ambient_failed", team: WORKSPACE, channel: "C0BRAVO", reason: "Error" }
    ]);
  });

  it("carries on when one channel's sheet cannot be resolved", async () => {
    // The enumerator's rule applies to the sheet read as much as to the
    // heartbeat: one channel is one log line, and the rest of the scan runs.
    const { logger, lines } = captureLogger();
    const sessions = createSessionRegistry({ openStore: () => store });
    const fired: string[] = [];
    const scheduler = createAmbientScheduler({
      channels: () => Promise.resolve(["C0ALPHA", "C0BRAVO"]),
      sessions,
      workspace: () => WORKSPACE,
      settings: channel =>
        channel === "C0ALPHA" ? Promise.reject(new RangeError("nope")) : Promise.resolve(ON),
      heartbeat: channel => {
        fired.push(channel);
        return Promise.resolve();
      },
      logger
    });

    await scheduler.scan(AT);
    expect((await scheduler.scan(AT + CADENCE_MS)).fired).toBe(1);
    expect(fired).toEqual(["C0BRAVO"]);
    expect(lines.filter(line => line.event === "ambient_failed")).toEqual([
      { event: "ambient_failed", team: WORKSPACE, channel: "C0ALPHA", reason: "RangeError" },
      { event: "ambient_failed", team: WORKSPACE, channel: "C0ALPHA", reason: "RangeError" }
    ]);
  });

  it("runs no more than the concurrency bound at once", async () => {
    // The thundering herd this exists for: every channel takes the same
    // first-sight instant, so they all come due together one cadence later.
    const channels = Array.from({ length: 12 }, (_unused, index) => `C0CHANNEL${index}`);
    const sheets = Object.fromEntries(channels.map(channel => [channel, ON]));
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const { scheduler } = rig({
      sheets,
      heartbeat: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<void>(resolve => {
          releases.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      }
    });

    await scheduler.scan(AT);
    let settled = false;
    const scanning = scheduler.scan(AT + CADENCE_MS).then(result => {
      settled = true;
      return result;
    });

    // Release whatever is running, round by round, until the scan settles —
    // every channel gets its turn, so the bound costs a wait rather than a
    // heartbeat. `peak` is what the bound is asserted on.
    for (let guard = 0; guard < 100 && !settled; guard += 1) {
      await flush();
      while (releases.length > 0) releases.shift()?.();
    }

    expect((await scanning).fired).toBe(channels.length);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_HEARTBEATS);
    expect(peak).toBe(MAX_CONCURRENT_HEARTBEATS);
  });

  it("skips a channel whose previous heartbeat is still running", async () => {
    // Skipped rather than queued: a channel already behind gets further behind
    // if its turns stack up, and the next scan finds it due again anyway.
    const { logger, lines } = captureLogger();
    let release = (): void => {};
    let started = 0;
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: ON },
      logger,
      heartbeat: () => {
        started += 1;
        return new Promise<void>(resolve => {
          release = resolve;
        });
      }
    });

    await scheduler.scan(AT);
    const first = scheduler.scan(AT + CADENCE_MS);
    await Promise.resolve();

    expect(await scheduler.scan(AT + 2 * CADENCE_MS)).toEqual({
      fired: 0,
      checks: 0,
      nextDueAt: AT + 3 * CADENCE_MS
    });
    expect(started).toBe(1);
    expect(lines.filter(line => line.event === "ambient_overrun")).toHaveLength(1);

    release();
    await first;
  });

  it("wakes at the earliest deadline across channels, not at a cadence multiple", async () => {
    // What #324's due task joins: the next wake is the minimum over the plan, so
    // a second kind of due thing adds an entry rather than a second clock.
    const { scheduler } = rig({
      sheets: {
        C0SLOW: { enabled: true, heartbeatEveryMs: 60 * 60_000 },
        C0BRISK: { enabled: true, heartbeatEveryMs: 60_000 }
      }
    });

    expect((await scheduler.scan(AT)).nextDueAt).toBe(AT + 60_000);
  });

  it("scans nothing until it knows which workspace it is in", async () => {
    // A `SessionKey` this module made up would be a second session, and
    // therefore a second mutex, over a live channel.
    const { logger, lines } = captureLogger();
    // Initialized rather than left bare, so `prefer-const` reads the assignment
    // below as the reassignment it is.
    let workspace: string | undefined = undefined;
    const { scheduler, fired } = rig({
      sheets: { C0ENGINEERING: ON },
      workspace: () => workspace,
      logger
    });

    expect(await scheduler.scan(AT)).toEqual({ fired: 0, checks: 0, nextDueAt: null });
    expect(lines.map(line => line.event)).toEqual(["ambient_unidentified"]);

    // And nothing was scheduled either, so the first scan that can act is also
    // the one that first sees the channel.
    workspace = WORKSPACE;
    expect((await scheduler.scan(AT + CADENCE_MS)).fired).toBe(0);
    expect((await scheduler.scan(AT + 2 * CADENCE_MS)).fired).toBe(1);
    expect(fired).toEqual(["C0ENGINEERING"]);
  });

  it("says what it would have done when no heartbeat is wired", async () => {
    // What this issue ships: the clock, with #319's turn still to come. An
    // operator who turns `[ambient]` on now sees the line rather than silence.
    const { logger, lines } = captureLogger();
    const sessions = createSessionRegistry({ openStore: () => store });
    const scheduler = createAmbientScheduler({
      channels: () => Promise.resolve(["C0ENGINEERING"]),
      sessions,
      workspace: () => WORKSPACE,
      settings: () => Promise.resolve(ON),
      logger
    });

    await scheduler.scan(AT);
    expect((await scheduler.scan(AT + CADENCE_MS)).fired).toBe(1);
    expect(lines).toEqual([{ event: "ambient_due", team: WORKSPACE, channel: "C0ENGINEERING" }]);
  });

  it("starts nothing on a channel once the process is stopping", async () => {
    const controller = new AbortController();
    const { scheduler, fired } = rig({
      sheets: { C0ALPHA: ON, C0BRAVO: ON },
      signal: controller.signal
    });

    await scheduler.scan(AT);
    controller.abort();

    expect(await scheduler.scan(AT + CADENCE_MS)).toEqual({
      fired: 0,
      checks: 0,
      nextDueAt: AT + 2 * CADENCE_MS
    });
    expect(fired).toEqual([]);
  });

  describe("the loop", () => {
    /** A timer seam that records the sleep and runs it when told. */
    function manualTimer() {
      const sleeps: number[] = [];
      let pending: (() => void) | undefined;
      return {
        sleeps,
        timer: (ms: number, fn: () => void) => {
          sleeps.push(ms);
          pending = fn;
          return (): void => {
            pending = undefined;
          };
        },
        fire: async (): Promise<void> => {
          const run = pending;
          pending = undefined;
          run?.();
          await flush();
        },
        pending: (): boolean => pending !== undefined
      };
    }

    it("sleeps to the next deadline, and never longer than the rescan bound", async () => {
      const clock = manualTimer();
      const sessions = createSessionRegistry({ openStore: () => store });
      let at = AT;
      const scheduler = createAmbientScheduler({
        channels: () => Promise.resolve(["C0ENGINEERING"]),
        sessions,
        workspace: () => WORKSPACE,
        // A cadence far longer than the rescan bound, so the two are
        // distinguishable: the first sleep is the bound, not the cadence.
        settings: () => Promise.resolve({ enabled: true, heartbeatEveryMs: 60 * 60_000 }),
        heartbeat: () => Promise.resolve(),
        timer: clock.timer,
        now: () => at
      });

      scheduler.start();
      await flush();

      expect(clock.sleeps).toEqual([AMBIENT_RESCAN_MS]);

      // A wake inside the cadence re-reads the sheets and sleeps the bound
      // again, which is how a channel that just enabled ambient is discovered.
      at = AT + AMBIENT_RESCAN_MS;
      await clock.fire();
      expect(clock.sleeps).toEqual([AMBIENT_RESCAN_MS, AMBIENT_RESCAN_MS]);

      scheduler.stop();
      await clock.fire();
      expect(clock.sleeps).toHaveLength(2);
    });

    it("sleeps to a deadline nearer than the bound", async () => {
      const clock = manualTimer();
      const sessions = createSessionRegistry({ openStore: () => store });
      const scheduler = createAmbientScheduler({
        channels: () => Promise.resolve(["C0ENGINEERING"]),
        sessions,
        workspace: () => WORKSPACE,
        settings: () => Promise.resolve({ enabled: true, heartbeatEveryMs: 30_000 }),
        heartbeat: () => Promise.resolve(),
        timer: clock.timer,
        now: () => AT
      });

      scheduler.start();
      await flush();

      expect(clock.sleeps).toEqual([30_000]);
      scheduler.stop();
    });

    it("stops the loop rather than leaving a timer holding the process open", async () => {
      const clock = manualTimer();
      const sessions = createSessionRegistry({ openStore: () => store });
      const scheduler = createAmbientScheduler({
        channels: () => Promise.resolve([]),
        sessions,
        workspace: () => WORKSPACE,
        settings: () => Promise.resolve(OFF),
        timer: clock.timer,
        now: () => AT
      });

      scheduler.start();
      await flush();
      expect(clock.pending()).toBe(true);

      scheduler.stop();
      expect(clock.pending()).toBe(false);
    });
  });
});

describe("earliestDue", () => {
  it("answers the earliest instant, whatever kind it belongs to", () => {
    expect(
      earliestDue([
        { kind: "heartbeat", channel: "C0ALPHA", dueAt: AT + 900 },
        { kind: "heartbeat", channel: "C0BRAVO", dueAt: AT + 30 },
        { kind: "heartbeat", channel: "C0CHARLIE", dueAt: AT + 400 }
      ])
    ).toBe(AT + 30);
  });

  it("answers null when nothing is due", () => {
    // A deployment with no channel enrolled. The loop reads this as "sleep the
    // rescan bound", which is how one that enrols later is ever noticed.
    expect(earliestDue([])).toBeNull();
  });
});

// #324. A due ticket is a second kind of due thing on the same plan, and every
// case here is about the difference between the two kinds: a heartbeat is an
// opportunity and a check has a deadline.
describe("a due scheduled check", () => {
  it("fires at its own instant rather than at the next cadence", async () => {
    // Due four minutes from the sighting scan, where the cadence is fifteen. A
    // clock that only woke on cadence boundaries would run this eleven minutes
    // late, which is the whole reason `DueEntry` has a second member.
    schedule("t1", AT + 4 * 60_000);
    const { scheduler, checked, fired } = rig({ sheets: { C0ENGINEERING: ON } });

    const first = await scheduler.scan(AT);
    expect(checked).toEqual([]);
    expect(first.nextDueAt).toBe(AT + 4 * 60_000);

    const second = await scheduler.scan(AT + 4 * 60_000);
    expect(checked).toEqual(["C0ENGINEERING:t1"]);
    expect(second.checks).toBe(1);
    // The heartbeat is not due for another eleven minutes and did not run.
    expect(fired).toEqual([]);
  });

  // Absolute time, the lifecycle clocks' argument. One row and one stamp, so
  // there is nothing to fire per missed window.
  it("fires once and late for a ticket that came due while the process was down", async () => {
    schedule("t1", AT - 3 * 24 * 60 * 60_000);
    const { scheduler, checked } = rig({ sheets: { C0ENGINEERING: ON } });

    await scheduler.scan(AT);

    expect(checked).toEqual(["C0ENGINEERING:t1"]);
    expect((await scheduler.scan(AT + 1_000)).checks).toBe(0);
  });

  // A channel may hold several at once and they may come due together. Firing
  // all of them would put a burst of unprompted messages into one channel at one
  // instant; the rest are due again on the next scan.
  it("fires at most one per channel per scan, earliest first", async () => {
    schedule("t1", AT - 3_000);
    schedule("t2", AT - 2_000);
    schedule("t3", AT - 1_000);
    const { scheduler, checked } = rig({ sheets: { C0ENGINEERING: ON } });

    await scheduler.scan(AT);
    expect(checked).toEqual(["C0ENGINEERING:t1"]);

    await scheduler.scan(AT + 1);
    expect(checked).toEqual(["C0ENGINEERING:t1", "C0ENGINEERING:t2"]);
  });

  // The spin guard. Every way a due ticket can stay pending — and this is the
  // baldest one — would otherwise ask the loop to wake at an instant that has
  // already passed, forever, as fast as the event loop allows.
  it("never asks the loop to wake in the past when a due ticket stays pending", async () => {
    schedule("t1", AT - 60 * 60_000);
    const { scheduler, checked } = rig({ sheets: { C0ENGINEERING: ON }, fireTask: null });

    const scan = await scheduler.scan(AT);

    expect(checked).toEqual([]);
    expect(scan.nextDueAt).toBe(AT + AMBIENT_RESCAN_MS);
    expect(scan.nextDueAt).toBeGreaterThan(AT);
  });

  // A deployment with no fire path must not consume a channel's checks — the
  // opposite of what the clock does with a heartbeat it cannot run, because a
  // heartbeat is an opportunity and this is a thing somebody approved.
  it("leaves a due ticket pending when nothing can run it", async () => {
    schedule("t1", AT - 1_000);
    const { logger, lines } = captureLogger();
    const { scheduler } = rig({ sheets: { C0ENGINEERING: ON }, fireTask: null, logger });

    await scheduler.scan(AT);

    expect(store.nextScheduledTaskDueAt()).toBe(AT - 1_000);
    expect(lines.filter(line => line.event === "ambient_check_due")).toHaveLength(1);
  });

  // `[ambient]` off is the one silence: the clock never enumerates the channel,
  // so a ticket cannot fire and nothing is said about it either.
  it("does not fire a ticket in a channel whose block is off", async () => {
    schedule("t1", AT - 1_000);
    const { scheduler, checked } = rig({ sheets: { C0ENGINEERING: OFF } });

    const scan = await scheduler.scan(AT);

    expect(checked).toEqual([]);
    expect(scan.nextDueAt).toBeNull();
    expect(store.nextScheduledTaskDueAt()).toBe(AT - 1_000);
  });

  // Two kinds of due thing on one plan, and `earliestDue` answers over both.
  it("wakes at a ticket's instant when it beats every cadence", async () => {
    schedule("t1", AT + 60_000);
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: { enabled: true, heartbeatEveryMs: 60 * 60_000 } }
    });

    expect((await scheduler.scan(AT)).nextDueAt).toBe(AT + 60_000);
  });

  // A check has a deadline and a heartbeat does not, so when both are due the
  // check goes first. They share the mutex, so this decides which one waits.
  it("runs a due check before a due heartbeat in the same channel", async () => {
    schedule("t1", AT + CADENCE_MS);
    const order: string[] = [];
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: ON },
      heartbeat: () => {
        order.push("heartbeat");
        return Promise.resolve();
      },
      fireTask: (_channel, _store, task) => {
        order.push("check");
        store.markScheduledTaskFired(task.id, AT, "posted");
        return Promise.resolve();
      }
    });

    await scheduler.scan(AT);
    await scheduler.scan(AT + CADENCE_MS);

    expect(order).toEqual(["check", "heartbeat"]);
  });
});

