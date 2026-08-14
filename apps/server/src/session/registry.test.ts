// The clock is stated rather than faked: `now` is injected, so a test says what
// time it is instead of persuading the timer wheel.

import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "./registry.js";
import type { SessionKey } from "./types.js";

const KEY: SessionKey = { workspace: "T024BE7LD", channel: "C024BE91L" };

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/** A promise the test resolves when it wants held work to finish. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A clock the test advances by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: ms => {
      at += ms;
    }
  };
}

describe("createSessionRegistry", () => {
  it("creates a session on first use and returns the same one after", () => {
    const sessions = createSessionRegistry();

    const first = sessions.open(KEY);
    const second = sessions.open(KEY);

    expect(second).toBe(first);
    expect(sessions.size).toBe(1);
  });

  it("gives each channel its own session and its own queue", () => {
    const sessions = createSessionRegistry();

    const a = sessions.open(KEY);
    const b = sessions.open({ ...KEY, channel: "C024BE92M" });

    expect(b).not.toBe(a);
    expect(b.mutex).not.toBe(a.mutex);
    expect(sessions.size).toBe(2);
  });

  it("treats the same channel id under two workspaces as two sessions", () => {
    const sessions = createSessionRegistry();

    const a = sessions.open(KEY);
    const b = sessions.open({ ...KEY, workspace: "T0OTHER99" });

    expect(b).not.toBe(a);
    expect(sessions.size).toBe(2);
  });

  it("evicts a session that has been idle longer than the window", () => {
    const time = clock();
    const captured = capturingLogger();
    const sessions = createSessionRegistry({
      idleMs: 60_000,
      now: time.now,
      logger: captured.logger
    });

    const first = sessions.open(KEY);
    first.lastUsedAt = time.now();
    expect(sessions.size).toBe(1);

    time.advance(60_001);
    // Opening another channel is what runs the sweep — eviction is lazy, on the
    // path traffic takes anyway.
    sessions.open({ ...KEY, channel: "C0OTHER11" });

    expect(sessions.size).toBe(1);
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ event: "session_evicted", channel: "C024BE91L" })
    );
  });

  it("keeps a session that has not been idle long enough", () => {
    const time = clock();
    const sessions = createSessionRegistry({ idleMs: 60_000, now: time.now });

    const first = sessions.open(KEY);
    first.lastUsedAt = time.now();

    time.advance(59_999);
    expect(sessions.open(KEY)).toBe(first);
    expect(sessions.size).toBe(1);
  });

  it("never evicts a session with work queued or running, however old", async () => {
    // The property the mutex's `pending` exists for. A session dropped out from
    // under queued work would give the next request a fresh mutex, and the two
    // would run at once in one channel.
    const time = clock();
    const sessions = createSessionRegistry({ idleMs: 1, now: time.now });

    const session = sessions.open(KEY);
    const gate = deferred();
    const held = session.mutex.run(() => gate.promise);

    time.advance(10_000_000);
    sessions.open({ ...KEY, channel: "C0OTHER11" });

    expect(sessions.open(KEY)).toBe(session);

    gate.resolve();
    await held;
  });

  it("re-creates a session after it was evicted", () => {
    const time = clock();
    const sessions = createSessionRegistry({ idleMs: 60_000, now: time.now });

    const first = sessions.open(KEY);
    first.lastUsedAt = time.now();

    time.advance(60_001);
    const second = sessions.open(KEY);

    expect(second).not.toBe(first);
    expect(sessions.size).toBe(1);
  });

  describe("the message store", () => {
    /** A store that counts its own closes and nothing else. */
    function countingStore(): { store: MessageStore; closes: () => number } {
      let closed = 0;
      return {
        closes: () => closed,
        store: {
          append: () => true,
          remove: () => false,
          replaceText: () => false,
          search: () => [],
          recent: () => [],
          recentInThread: () => [],
          putEmbedding: () => {},
          nearest: () => [],
          removeEmbedding: () => false,
          putThreadSummary: () => {},
          staleThreads: () => [],
          close: () => {
            closed += 1;
          }
        }
      };
    }

    it("opens one store per session, keyed on the channel", () => {
      const opened: string[] = [];
      const sessions = createSessionRegistry({
        openStore: channel => {
          opened.push(channel);
          return countingStore().store;
        }
      });

      sessions.open(KEY);
      sessions.open(KEY);
      sessions.open({ ...KEY, channel: "C0OTHER11" });

      expect(opened).toEqual(["C024BE91L", "C0OTHER11"]);
    });

    it("closes the store when the session is evicted", () => {
      // The single `entries.delete` is where a session's resources go, and this
      // is the first one that is more than a timestamp. Without the close the
      // file stays open for the life of the process and the map that would have
      // let anything find it again is gone.
      const time = clock();
      const counting = countingStore();
      const sessions = createSessionRegistry({
        idleMs: 60_000,
        now: time.now,
        openStore: () => counting.store
      });

      const session = sessions.open(KEY);
      session.lastUsedAt = time.now();

      time.advance(60_001);
      sessions.open({ ...KEY, channel: "C0OTHER11" });

      expect(sessions.size).toBe(1);
      expect(counting.closes()).toBe(1);
    });

    it("does not close the store of a session it kept", () => {
      const time = clock();
      const counting = countingStore();
      const sessions = createSessionRegistry({
        idleMs: 60_000,
        now: time.now,
        openStore: () => counting.store
      });

      const session = sessions.open(KEY);
      session.lastUsedAt = time.now();

      time.advance(59_999);
      sessions.open(KEY);

      expect(counting.closes()).toBe(0);
    });

    it("never closes the store of a session with work in flight", async () => {
      // A store closed out from under a running task is a `SQLITE_MISUSE` from
      // inside a model turn. `pending > 0` already guards the eviction; this is
      // the assertion that the close is inside that guard rather than beside it.
      const time = clock();
      const counting = countingStore();
      const sessions = createSessionRegistry({
        idleMs: 1,
        now: time.now,
        openStore: () => counting.store
      });

      const session = sessions.open(KEY);
      const gate = deferred();
      const held = session.mutex.run(() => gate.promise);

      time.advance(10_000_000);
      sessions.open({ ...KEY, channel: "C0OTHER11" });

      expect(counting.closes()).toBe(0);

      gate.resolve();
      await held;
    });

    it("holds null for a channel with no store, and still evicts cleanly", () => {
      // No sheet, or a file that would not open. `store.ts` answers null rather
      // than throwing, and the sweep has to survive the absence.
      const time = clock();
      const sessions = createSessionRegistry({
        idleMs: 60_000,
        now: time.now,
        openStore: () => null
      });

      const session = sessions.open(KEY);
      expect(session.store).toBeNull();
      session.lastUsedAt = time.now();

      time.advance(60_001);
      expect(() => sessions.open({ ...KEY, channel: "C0OTHER11" })).not.toThrow();
      expect(sessions.size).toBe(1);
    });

    it("holds null when no opener was given at all", () => {
      expect(createSessionRegistry().open(KEY).store).toBeNull();
    });

    it("re-opens a store for a channel whose session was evicted", () => {
      const time = clock();
      let opens = 0;
      const sessions = createSessionRegistry({
        idleMs: 60_000,
        now: time.now,
        openStore: () => {
          opens += 1;
          return countingStore().store;
        }
      });

      sessions.open(KEY).lastUsedAt = time.now();
      time.advance(60_001);
      sessions.open(KEY);

      expect(opens).toBe(2);
    });
  });
});
