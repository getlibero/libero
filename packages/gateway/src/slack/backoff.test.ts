import { describe, it } from "node:test";
import { expect } from "expect";
import { DEFAULT_BACKOFF, nextDelayMs } from "./backoff.js";
import type { BackoffPolicy } from "./backoff.js";

const POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 30_000, resetAfterMs: 60_000 };

/** Pins jitter to the top of its range, so the ceiling is what is asserted on. */
const full = (): number => 1;
const none = (): number => 0;

describe("nextDelayMs", () => {
  it("doubles the ceiling with each attempt", () => {
    expect(nextDelayMs(POLICY, 0, full)).toBe(1_000);
    expect(nextDelayMs(POLICY, 1, full)).toBe(2_000);
    expect(nextDelayMs(POLICY, 2, full)).toBe(4_000);
    expect(nextDelayMs(POLICY, 3, full)).toBe(8_000);
  });

  it("clamps the ceiling at maxMs", () => {
    expect(nextDelayMs(POLICY, 5, full)).toBe(30_000);
    expect(nextDelayMs(POLICY, 50, full)).toBe(30_000);
    // 2 ** attempt overflows to Infinity long before this; the clamp holds.
    expect(nextDelayMs(POLICY, 5_000, full)).toBe(30_000);
  });

  it("jitters over the whole range, floor included", () => {
    // Full jitter, not equal jitter: the point is that a fleet coming back from
    // one Slack outage does not retry in step.
    expect(nextDelayMs(POLICY, 3, none)).toBe(0);
    expect(nextDelayMs(POLICY, 3, () => 0.5)).toBe(4_000);
    expect(nextDelayMs(POLICY, 3, full)).toBe(8_000);
  });

  it("stays within [0, ceiling] for any random draw", () => {
    for (const draw of [0, 0.01, 0.37, 0.99, 1]) {
      const delay = nextDelayMs(POLICY, 2, () => draw);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });

  it("never waits longer than it takes to notice the socket is down", () => {
    // The SDK's server-ping timeout is 30s. A ceiling above it would leave the
    // socket down for longer than detecting the drop took.
    expect(DEFAULT_BACKOFF.maxMs).toBeLessThanOrEqual(30_000);
    expect(DEFAULT_BACKOFF.resetAfterMs).toBeGreaterThan(DEFAULT_BACKOFF.maxMs);
  });
});
