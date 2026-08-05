// The clock is stated rather than faked: `now` is injected, so a test says what
// time it is instead of persuading the timer wheel.

import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
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
});
