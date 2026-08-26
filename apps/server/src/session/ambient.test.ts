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
import type { AmbientRule } from "@getlibero/schema";
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

const ON: AmbientSchedulerSettings = { enabled: true, heartbeat: true, heartbeatEveryMs: CADENCE_MS, rules: [] };
const OFF: AmbientSchedulerSettings = { enabled: false, heartbeat: true, heartbeatEveryMs: CADENCE_MS, rules: [] };

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
  /**
   * Overrides the rule fire path. Absent, the rig records the firing.
   *
   * `null` composes the scheduler with none, which is the deployment where a due
   * rule is noticed and nothing runs — and where, unlike a ticket, there is
   * nothing left pending afterwards.
   */
  fireRule?: AmbientSchedulerOptions["fireRule"] | null;
  /** Overrides the workspace, including to `undefined`. */
  workspace?: () => string | undefined;
  signal?: AbortSignal;
  logger?: Logger;
}

function rig(options: RigOptions = {}) {
  const fired: string[] = [];
  const checked: string[] = [];
  const ruled: string[] = [];
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
    ...(options.fireRule === null
      ? {}
      : {
          fireRule:
            options.fireRule ??
            ((channel: string, _store, rule, dueAt): Promise<void> => {
              // The occurrence, not the scan instant — what the meter's turn id
              // is built from, so a case can assert the clock handed over the
              // right one.
              ruled.push(`${channel}:${rule.name}:${dueAt}`);
              return Promise.resolve();
            })
        }),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {})
  });

  return { scheduler, fired, checked, ruled, sessions };
}

/** A rule, with the fields a case is not about left at something innocuous. */
function makeRule(over: Partial<AmbientRule> = {}): AmbientRule {
  return { name: "standup-digest", at: ["09:00"], question: "What is blocked?", ...over };
}

/**
 * A settings block carrying rules, with the heartbeat off.
 *
 * Off by default because these cases assert on `nextDueAt`, and a heartbeat
 * scheduled fifteen minutes out would be the earlier entry in almost all of them
 * — so every rule case would be asserting the cadence it did not set. The cases
 * that are about the two together turn it back on and say so.
 */
function withRules(rules: AmbientRule[], over: Partial<AmbientSchedulerSettings> = {}): AmbientSchedulerSettings {
  return { enabled: true, heartbeat: false, heartbeatEveryMs: CADENCE_MS, rules, ...over };
}

/**
 * The instant of a UTC wall-clock time, stated the way the cases read.
 *
 * The rule cases cannot use `AT` and an offset the way the cadence cases do: what
 * a rule fires on is a time of day, so the fixtures have to be anchored to a real
 * calendar instant or the arithmetic is untestable.
 */
const utc = (iso: string): number => Date.parse(`${iso}Z`);

// 2026-08-26 is a Wednesday, and every rule case below is anchored to that week.
const WED = "2026-08-26T";

/** A ticket in the one store the rig hands every channel. */
function schedule(id: string, dueAt: number): void {
  store.scheduleTask({ id, task: "task-1", prompt: `check ${id}`, dueAt, createdAt: AT });
}

describe("the ambient scheduler", () => {
  it("fires an enabled channel on its cadence, and not before", async () => {
    const { scheduler, fired } = rig({ sheets: { C0ENGINEERING: ON } });

    // First sight schedules and never fires — the restart rule, from the other
    // end. A channel this process has only just met has nothing it missed.
    expect(await scheduler.scan(AT)).toEqual({ fired: 0, checks: 0, rules: 0, nextDueAt: AT + CADENCE_MS });
    expect(fired).toEqual([]);

    // One tick short.
    expect((await scheduler.scan(AT + CADENCE_MS - 1)).fired).toBe(0);
    expect(fired).toEqual([]);

    expect(await scheduler.scan(AT + CADENCE_MS)).toEqual({
      fired: 1,
      checks: 0,
      rules: 0,
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

    expect(await scheduler.scan(AT + 2 * CADENCE_MS)).toEqual({ fired: 0, checks: 0, rules: 0, nextDueAt: null });
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
    sheets["C0ENGINEERING"] = { enabled: true, heartbeat: true, heartbeatEveryMs: 60_000, rules: [] };

    // The pending deadline was set from the old cadence, so this fires when the
    // old one said — and reschedules on the new one, which is what an operator
    // tightening the cadence is asking for.
    expect(await scheduler.scan(AT + CADENCE_MS)).toEqual({
      fired: 1,
      checks: 0,
      rules: 0,
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
      rules: 0,
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
        C0SLOW: { enabled: true, heartbeat: true, heartbeatEveryMs: 60 * 60_000, rules: [] },
        C0BRISK: { enabled: true, heartbeat: true, heartbeatEveryMs: 60_000, rules: [] }
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

    expect(await scheduler.scan(AT)).toEqual({ fired: 0, checks: 0, rules: 0, nextDueAt: null });
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
      rules: 0,
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
        settings: () => Promise.resolve({ enabled: true, heartbeat: true, heartbeatEveryMs: 60 * 60_000, rules: [] }),
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
        settings: () => Promise.resolve({ enabled: true, heartbeat: true, heartbeatEveryMs: 30_000, rules: [] }),
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
      sheets: { C0ENGINEERING: { enabled: true, heartbeat: true, heartbeatEveryMs: 60 * 60_000, rules: [] } }
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


describe("the ambient scheduler's standing rules", () => {
  it("fires at the rule's next occurrence, and not on the scan that found it", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()]) }
    });

    // First sight, at 08:00 on a day the rule fires. Scheduled at 09:00 and not
    // fired — but unlike a heartbeat, which is scheduled a whole cadence out, the
    // instant is the one the sheet named.
    const first = await scheduler.scan(utc(`${WED}08:00:00`));
    expect(first.rules).toBe(0);
    expect(first.nextDueAt).toBe(utc(`${WED}09:00:00`));
    expect(ruled).toEqual([]);

    // A minute short.
    expect((await scheduler.scan(utc(`${WED}08:59:00`))).rules).toBe(0);
    expect(ruled).toEqual([]);

    const fired = await scheduler.scan(utc(`${WED}09:00:00`));
    expect(fired.rules).toBe(1);
    expect(ruled).toEqual([`C0ENGINEERING:standup-digest:${utc(`${WED}09:00:00`)}`]);
    // And rescheduled to tomorrow, off the same arithmetic.
    expect(fired.nextDueAt).toBe(utc("2026-08-27T09:00:00"));
  });

  // The whole of skip-don't-replay for rules, and the cost #461 states rather
  // than hides: a process that was down across 09:00 loses that morning.
  it("skips an occurrence it was down for rather than firing it late", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()]) }
    });

    // The process comes up at 09:05. First sight is the *next* occurrence.
    const first = await scheduler.scan(utc(`${WED}09:05:00`));
    expect(first.rules).toBe(0);
    expect(first.nextDueAt).toBe(utc("2026-08-27T09:00:00"));

    // And nothing fires for the rest of the day, however many scans happen.
    expect((await scheduler.scan(utc(`${WED}12:00:00`))).rules).toBe(0);
    expect((await scheduler.scan(utc(`${WED}23:59:00`))).rules).toBe(0);
    expect(ruled).toEqual([]);
  });

  // Three windows missed is one firing, which is `schedule`'s rule for the
  // cadence — and here it falls out of advancing from `at` rather than from the
  // occurrence that was missed.
  it("fires once for a run of occurrences it was down for", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()]) }
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    // Nothing looked for three days. One firing, then next is the day after.
    const late = await scheduler.scan(utc("2026-08-29T10:00:00"));
    expect(late.rules).toBe(1);
    expect(ruled).toHaveLength(1);
    expect(late.nextDueAt).toBe(utc("2026-08-30T09:00:00"));
  });

  it("fires every time a rule names, in one day", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule({ at: ["09:00", "17:00"] })]) }
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    expect((await scheduler.scan(utc(`${WED}09:00:00`))).rules).toBe(1);
    expect((await scheduler.scan(utc(`${WED}12:00:00`))).rules).toBe(0);
    expect((await scheduler.scan(utc(`${WED}17:00:00`))).rules).toBe(1);
    expect(ruled).toEqual([
      `C0ENGINEERING:standup-digest:${utc(`${WED}09:00:00`)}`,
      `C0ENGINEERING:standup-digest:${utc(`${WED}17:00:00`)}`
    ]);
  });

  it("does not fire on a day the rule does not name", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule({ days: ["mon"] })]) }
    });

    // Wednesday. Next occurrence is the following Monday.
    const first = await scheduler.scan(utc(`${WED}08:00:00`));
    expect(first.nextDueAt).toBe(utc("2026-08-31T09:00:00"));

    expect((await scheduler.scan(utc("2026-08-27T09:00:00"))).rules).toBe(0);
    expect((await scheduler.scan(utc("2026-08-31T09:00:00"))).rules).toBe(1);
    expect(ruled).toHaveLength(1);
  });

  // Two rules due at one instant both fire. Not bounded to one per channel per
  // scan the way tickets are — see `scan`: rules cannot pile up across a
  // downtime, so what is due is what the sheet says is due now.
  it("fires every rule due at one instant", async () => {
    const { scheduler, ruled } = rig({
      sheets: {
        C0ENGINEERING: withRules([
          makeRule({ name: "standup-digest" }),
          makeRule({ name: "blockers-digest" })
        ])
      }
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    expect((await scheduler.scan(utc(`${WED}09:00:00`))).rules).toBe(2);
    expect(ruled).toHaveLength(2);
    expect(ruled.map(line => line.split(":")[1]).sort()).toEqual([
      "blockers-digest",
      "standup-digest"
    ]);
  });

  it("stops firing a rule the sheet no longer carries, with no restart", async () => {
    const sheets: Record<string, AmbientSchedulerSettings> = {
      C0ENGINEERING: withRules([makeRule()])
    };
    const { scheduler, ruled } = rig({ sheets, channels: ["C0ENGINEERING"] });

    await scheduler.scan(utc(`${WED}08:00:00`));
    sheets["C0ENGINEERING"] = withRules([]);

    const after = await scheduler.scan(utc(`${WED}09:00:00`));
    expect(after.rules).toBe(0);
    // Nothing left to wake for: the rule's entry was pruned and this channel has
    // no heartbeat.
    expect(after.nextDueAt).toBeNull();
    expect(ruled).toEqual([]);
  });

  // A renamed rule is a removal and an addition, which is what keys the schedule
  // by name buys: the new name is first-sighted and fires nothing on the scan
  // that noticed it.
  it("treats a renamed rule as a new one", async () => {
    const sheets: Record<string, AmbientSchedulerSettings> = {
      C0ENGINEERING: withRules([makeRule()])
    };
    const { scheduler, ruled } = rig({ sheets, channels: ["C0ENGINEERING"] });

    await scheduler.scan(utc(`${WED}08:00:00`));
    sheets["C0ENGINEERING"] = withRules([makeRule({ name: "morning-digest" })]);

    expect((await scheduler.scan(utc(`${WED}09:00:00`))).rules).toBe(0);
    expect(ruled).toEqual([]);
    // And the new name is scheduled from the scan that saw it, so it fires
    // tomorrow rather than picking up the old one's occurrence.
    expect((await scheduler.scan(utc("2026-08-27T09:00:00"))).rules).toBe(1);
  });

  it("fires nothing for a channel that never enabled ambient", async () => {
    const { scheduler, ruled } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()], { enabled: false }) }
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    expect((await scheduler.scan(utc(`${WED}09:00:00`))).rules).toBe(0);
    expect(ruled).toEqual([]);
  });

  // `[ambient] enabled = false` is the one silence, and it takes the rules with
  // it — where `heartbeat = false` takes only the heartbeat. This is the pair.
  it("drops a rule's schedule when a channel switches ambient off", async () => {
    const sheets: Record<string, AmbientSchedulerSettings> = {
      C0ENGINEERING: withRules([makeRule()])
    };
    const { scheduler, ruled } = rig({ sheets, channels: ["C0ENGINEERING"] });

    await scheduler.scan(utc(`${WED}08:00:00`));
    sheets["C0ENGINEERING"] = withRules([makeRule()], { enabled: false });

    const off = await scheduler.scan(utc(`${WED}09:00:00`));
    expect(off.rules).toBe(0);
    expect(off.nextDueAt).toBeNull();
    expect(ruled).toEqual([]);
  });

  it("notices a due rule and runs nothing when no fire path is wired", async () => {
    const { logger, lines } = captureLogger();
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()]) },
      fireRule: null,
      logger
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    const fired = await scheduler.scan(utc(`${WED}09:00:00`));

    expect(fired.rules).toBe(0);
    expect(lines.some(line => line.event === "ambient_rule_due")).toBe(true);
    // And nothing is left pending: the next occurrence was computed anyway, so
    // the deployment with no reader simply never speaks.
    expect(fired.nextDueAt).toBe(utc("2026-08-27T09:00:00"));
  });

  it("names the rule on every line it logs", async () => {
    const { logger, lines } = captureLogger();
    const { scheduler } = rig({
      sheets: { C0ENGINEERING: withRules([makeRule()]) },
      logger
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    await scheduler.scan(utc(`${WED}09:00:00`));

    const due = lines.find(line => line.event === "ambient_rule_due");
    expect(due?.rule).toBe("standup-digest");
    expect(due?.channel).toBe("C0ENGINEERING");
  });
});

describe("the heartbeat switch", () => {
  // The configuration #461 exists to make possible: Monday digests and no
  // noticing job. `enabled` stays on, so this is not a second spelling of off.
  it("fires rules and evaluates no heartbeat when the heartbeat is off", async () => {
    const { scheduler, fired, ruled } = rig({
      sheets: {
        C0ENGINEERING: withRules([makeRule()])
      }
    });

    await scheduler.scan(utc(`${WED}08:00:00`));
    // A whole cadence later, and then some: nothing would stop a heartbeat here
    // but the switch.
    const later = await scheduler.scan(utc(`${WED}09:00:00`));

    expect(later.rules).toBe(1);
    expect(later.fired).toBe(0);
    expect(fired).toEqual([]);
    expect(ruled).toHaveLength(1);
  });

  // The other half: with the heartbeat off and no rules, the channel is enabled
  // and silent. The schema admits that deliberately, and so does this.
  it("schedules nothing for an enabled channel with no heartbeat and no rules", async () => {
    const { scheduler, fired } = rig({
      sheets: { C0ENGINEERING: withRules([]) }
    });

    const scan = await scheduler.scan(utc(`${WED}08:00:00`));
    expect(scan).toEqual({ fired: 0, checks: 0, rules: 0, nextDueAt: null });
    expect(fired).toEqual([]);
  });

  it("stops firing the heartbeat when the switch goes off, with no restart", async () => {
    const sheets: Record<string, AmbientSchedulerSettings> = { C0ENGINEERING: ON };
    const { scheduler, fired } = rig({ sheets, channels: ["C0ENGINEERING"] });

    await scheduler.scan(AT);
    expect((await scheduler.scan(AT + CADENCE_MS)).fired).toBe(1);

    sheets["C0ENGINEERING"] = { ...ON, heartbeat: false };
    const off = await scheduler.scan(AT + 2 * CADENCE_MS);
    expect(off.fired).toBe(0);
    expect(fired).toEqual(["C0ENGINEERING"]);

    // And switching it back on starts a fresh cadence rather than firing
    // immediately off the deadline it kept — the entry was dropped.
    sheets["C0ENGINEERING"] = ON;
    const back = await scheduler.scan(AT + 3 * CADENCE_MS);
    expect(back.fired).toBe(0);
    expect(back.nextDueAt).toBe(AT + 4 * CADENCE_MS);
  });

  it("still fires a due ticket for a channel with the heartbeat off", async () => {
    const { scheduler, checked } = rig({
      sheets: { C0ENGINEERING: withRules([]) }
    });
    schedule("t-1", AT);

    expect((await scheduler.scan(AT + 1_000)).checks).toBe(1);
    expect(checked).toEqual(["C0ENGINEERING:t-1"]);
  });
});

describe("the wake instant across all three sources", () => {
  // The point of `DueEntry.kind` having three members: one plan, one minimum.
  it("wakes at whichever of the three comes first", async () => {
    const { scheduler } = rig({
      sheets: {
        C0ENGINEERING: withRules([makeRule({ at: ["09:00"] })], {
          heartbeat: true,
          heartbeatEveryMs: 6 * 3_600_000
        })
      }
    });

    const at = utc(`${WED}08:00:00`);
    // The heartbeat is six hours out and the rule is one, so the rule wins.
    const ruleFirst = await scheduler.scan(at);
    expect(ruleFirst.nextDueAt).toBe(utc(`${WED}09:00:00`));

    // A ticket half an hour out beats both.
    schedule("t-1", utc(`${WED}08:30:00`));
    const ticketFirst = await scheduler.scan(at);
    expect(ticketFirst.nextDueAt).toBe(utc(`${WED}08:30:00`));
  });

  it("wakes at the heartbeat when it is the earliest of the three", async () => {
    const { scheduler } = rig({
      sheets: {
        C0ENGINEERING: withRules([makeRule({ at: ["23:00"] })], {
          heartbeat: true,
          heartbeatEveryMs: 60_000
        })
      }
    });

    const at = utc(`${WED}08:00:00`);
    expect((await scheduler.scan(at)).nextDueAt).toBe(at + 60_000);
  });

  it("counts the three kinds of due thing apart", async () => {
    const { scheduler } = rig({
      sheets: {
        C0ENGINEERING: withRules([makeRule()], { heartbeat: true, heartbeatEveryMs: 60_000 })
      }
    });

    await scheduler.scan(utc(`${WED}08:58:00`));
    schedule("t-1", utc(`${WED}09:00:00`));

    const scan = await scheduler.scan(utc(`${WED}09:00:00`));
    expect(scan.rules).toBe(1);
    expect(scan.checks).toBe(1);
    expect(scan.fired).toBe(1);
  });
});
