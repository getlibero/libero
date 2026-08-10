// The deadline arithmetic, and nothing else. Who calls `activate` and with what
// window is router.test.ts; who calls `isActive` is ingest.test.ts; whether the
// whole thing answers a person is follow-up.test.ts.
//
// The clock is a number passed in, so there are no fake timers here and no
// wall-clock waits.

import { describe, expect, it } from "vitest";
import { createThreadActivity } from "./threads.js";

const T = "1758000000.000100";
const OTHER = "1758000000.000200";
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

describe("createThreadActivity", () => {
  it("knows nothing until a task says so", () => {
    const threads = createThreadActivity();

    expect(threads.isActive(T, NOW)).toBe(false);
  });

  it("holds a thread active for the window it was given", () => {
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);

    expect(threads.isActive(T, NOW)).toBe(true);
    expect(threads.isActive(T, NOW + 14 * MINUTE)).toBe(true);
  });

  it("lets a thread go quiet once the window is up", () => {
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);

    expect(threads.isActive(T, NOW + 15 * MINUTE)).toBe(false);
    expect(threads.isActive(T, NOW + 16 * MINUTE)).toBe(false);
  });

  it("measures the window from the most recent task, not the first", () => {
    // The refresh. A conversation that keeps going keeps going, and the
    // deadline is always the last answer plus the window rather than the first
    // question plus it.
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);
    threads.activate(T, NOW + 10 * MINUTE, 15 * MINUTE);

    expect(threads.isActive(T, NOW + 20 * MINUTE)).toBe(true);
    expect(threads.isActive(T, NOW + 25 * MINUTE)).toBe(false);
  });

  it("keeps one thread's window out of another's", () => {
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);

    expect(threads.isActive(OTHER, NOW)).toBe(false);
  });

  it("deactivates on a zero window rather than doing nothing", () => {
    // A sheet edited to `follow_up_window_seconds = 0` is a channel saying it
    // wants no follow-ups, and a thread already warm should go cold at the next
    // task rather than serve out the window the old sheet named.
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);
    threads.activate(T, NOW + MINUTE, 0);

    expect(threads.isActive(T, NOW + MINUTE)).toBe(false);
  });

  it("never activates a thread on a zero window", () => {
    const threads = createThreadActivity();
    threads.activate(T, NOW, 0);

    expect(threads.isActive(T, NOW)).toBe(false);
    expect(threads.size).toBe(0);
  });

  it("drops expired threads rather than accumulating one per conversation", () => {
    // A process that has been up for a month would otherwise hold an entry for
    // every thread anyone ever mentioned the agent in. Swept on the write path,
    // which runs once per task rather than once per message.
    const threads = createThreadActivity();
    for (let index = 0; index < 50; index += 1) {
      threads.activate(`1758000000.0000${String(index).padStart(2, "0")}`, NOW, MINUTE);
    }
    expect(threads.size).toBe(50);

    threads.activate(T, NOW + 2 * MINUTE, MINUTE);

    expect(threads.size).toBe(1);
  });

  it("does not sweep a thread that is still live", () => {
    const threads = createThreadActivity();
    threads.activate(T, NOW, 15 * MINUTE);
    threads.activate(OTHER, NOW + MINUTE, 15 * MINUTE);

    expect(threads.size).toBe(2);
    expect(threads.isActive(T, NOW + 2 * MINUTE)).toBe(true);
  });
});
