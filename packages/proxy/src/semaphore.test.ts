import { describe, it } from "node:test";
import { expect } from "expect";
import { type Permit, createSemaphore } from "./semaphore.js";

/**
 * A generous wait, for the cases that must not reach it.
 *
 * Every case below either takes a permit immediately or is woken by a release —
 * so if one of them ever waits this long, the assertion that follows is already
 * wrong and the number only decides how long the suite takes to say so.
 */
const PATIENT = 30_000;

/** A wait short enough to spend, for the two cases about giving up. */
const BRIEF = 10;

/**
 * Let every pending microtask and every already-due timer run.
 *
 * `setImmediate` rather than a sleep: it lands after the microtask queue and
 * after nothing else, so a waiter that has not been woken is still waiting when
 * this resolves. Nothing here asserts on elapsed time, and there is no clock to
 * fake — the repo has none.
 */
const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

/** Watches a promise without awaiting it, so a test can assert it has *not* settled. */
function watch<T>(promise: Promise<T>): { settled: () => boolean; value: () => T | undefined } {
  let settled = false;
  let value: T | undefined;
  void promise.then(result => {
    settled = true;
    value = result;
  });
  return { settled: () => settled, value: () => value };
}

describe("createSemaphore", () => {
  it("grants up to the limit without waiting", async () => {
    const semaphore = createSemaphore(2);

    const first = await semaphore.acquire(PATIENT);
    const second = await semaphore.acquire(PATIENT);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(semaphore.held).toBe(2);
    expect(semaphore.waiting).toBe(0);
  });

  it("queues the caller past the limit", async () => {
    const semaphore = createSemaphore(1);
    await semaphore.acquire(PATIENT);

    const queued = watch(semaphore.acquire(PATIENT));
    await flush();

    expect(queued.settled()).toBe(false);
    expect(semaphore.waiting).toBe(1);
    // Still one. A queued caller is not a holder, which is the whole claim.
    expect(semaphore.held).toBe(1);
  });

  it("hands a released permit to the head of the queue, in order", async () => {
    const semaphore = createSemaphore(1);
    const held = await semaphore.acquire(PATIENT);

    const woken: string[] = [];
    const queue = ["a", "b", "c"].map(label =>
      semaphore.acquire(PATIENT).then(permit => {
        woken.push(label);
        return permit;
      })
    );
    await flush();
    expect(woken).toEqual([]);

    // One release, one wake — not a stampede. The other two stay queued, which
    // is what makes this a limit rather than a barrier.
    held?.release();
    await flush();
    expect(woken).toEqual(["a"]);
    expect(semaphore.waiting).toBe(2);

    (await queue[0])?.release();
    await flush();
    expect(woken).toEqual(["a", "b"]);

    (await queue[1])?.release();
    await flush();
    expect(woken).toEqual(["a", "b", "c"]);

    (await queue[2])?.release();
    expect(semaphore.held).toBe(0);
  });

  it("answers null when nothing comes free in time", async () => {
    const semaphore = createSemaphore(1);
    await semaphore.acquire(PATIENT);

    expect(await semaphore.acquire(BRIEF)).toBeNull();
  });

  // The case the module header is about. A waiter that gave up must leave the
  // queue, or the next release hands its permit to nobody — and that permit is
  // then held against every call that is still waiting.
  it("leaves no waiter behind when a wait expires", async () => {
    const semaphore = createSemaphore(1);
    const held = await semaphore.acquire(PATIENT);

    expect(await semaphore.acquire(BRIEF)).toBeNull();
    expect(semaphore.waiting).toBe(0);

    held?.release();
    // Zero, not one. A ghost waiter would have taken this permit on the way out.
    expect(semaphore.held).toBe(0);
    expect(await semaphore.acquire(BRIEF)).not.toBeNull();
  });

  it("releases once however many times it is called", async () => {
    const semaphore = createSemaphore(1);
    const held = await semaphore.acquire(PATIENT);

    held?.release();
    held?.release();
    held?.release();

    // One, not minus two. A permit returned twice is how a limit of eight
    // quietly becomes ten.
    expect(semaphore.held).toBe(0);
    expect(await semaphore.acquire(BRIEF)).not.toBeNull();
    expect(await semaphore.acquire(BRIEF)).toBeNull();
  });

  describe("open", () => {
    it("wakes every waiter at once", async () => {
      const semaphore = createSemaphore(1);
      await semaphore.acquire(PATIENT);
      const queued = [semaphore.acquire(PATIENT), semaphore.acquire(PATIENT), semaphore.acquire(PATIENT)];

      semaphore.open();

      const permits = await Promise.all(queued);
      expect(permits.every(permit => permit !== null)).toBe(true);
      expect(semaphore.waiting).toBe(0);
    });

    it("stops gating callers that arrive afterwards", async () => {
      const semaphore = createSemaphore(1);
      await semaphore.acquire(PATIENT);

      semaphore.open();

      // Would have queued a moment ago. Shutdown is exactly when a call must not
      // wait for a permit — the client it is headed for is closing and will say so.
      expect(await semaphore.acquire(BRIEF)).not.toBeNull();
    });

    it("is safe to call twice", async () => {
      const semaphore = createSemaphore(1);
      semaphore.open();
      semaphore.open();
      expect(await semaphore.acquire(BRIEF)).not.toBeNull();
    });

    // The permits `open` hands out account for nothing, so releasing one must
    // not decrement a count that no longer means anything.
    it("hands out permits that release into nothing", async () => {
      const semaphore = createSemaphore(1);
      semaphore.open();
      const permit: Permit | null = await semaphore.acquire(BRIEF);

      permit?.release();

      expect(semaphore.held).toBe(0);
    });
  });
});
