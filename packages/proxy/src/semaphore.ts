// A counting semaphore with a bounded wait.
//
// One thing only: how many callers may hold a permit at once. It knows nothing
// about upstreams, calls or credentials — `mcp-pool.ts` is where the decision
// that *this* is what "one upstream" means lives, and this file would be the
// wrong place to restate it.
//
// **The wait is bounded and a departed waiter leaves the queue.** That is the
// one behaviour worth reading the code for, because it is the opposite of the
// other timed race in this package. `walkWithin` in ./mcp-catalog.ts abandons a
// catalog walk but deliberately lets it keep running, since a walk that
// finishes late still warms the client for the next call. A waiter here has
// nothing to warm: if it stayed queued after its caller gave up, it would
// later be handed a permit for a call nobody is waiting for and hold it against
// the calls that are. So `acquire` splices itself out on the way to answering
// `null`.
//
// Fairness is FIFO. A released permit goes to the head of the queue rather than
// to whichever caller happens to ask next, so a steady stream of new calls
// cannot starve one that has been waiting — which is the whole point of the
// limit when one channel is busy and another is not.

/**
 * The right to run, held until released.
 *
 * `release` is idempotent. A caller releasing in a `finally` and again on some
 * error path would otherwise return two permits for one, which is how a limit
 * of eight quietly becomes nine.
 */
export interface Permit {
  release(): void;
}

export interface Semaphore {
  /**
   * A permit, or `null` if none came free within `waitMs`.
   *
   * Resolves synchronously-ish when the semaphore is below its limit: no timer
   * is created and nothing is queued on the uncontended path, which is every
   * call in a deployment that never reaches its limit.
   */
  acquire(waitMs: number): Promise<Permit | null>;
  /**
   * Stop gating, and hand every waiter a permit now.
   *
   * For shutdown. The permits it hands out are inert — releasing one does
   * nothing — because there is no longer anything to account for, and a waiter
   * woken this way is on its way to a client that is closing.
   */
  open(): void;
  /** How many permits are out. Read by tests, never by a decision. */
  readonly held: number;
  /** How many callers are queued. Same caveat. */
  readonly waiting: number;
}

/** A permit that accounts for nothing, handed out once gating has stopped. */
const INERT: Permit = { release() {} };

interface Waiter {
  settle(permit: Permit): void;
  expire(): void;
}

/**
 * A semaphore admitting `limit` holders at once.
 *
 * `limit` must be a positive integer. Nothing here checks it: the only value
 * that reaches this function comes from `maxUpstreamConcurrencyFromEnv`, which
 * refuses anything else at startup, or from `DEFAULT_UPSTREAM_CONCURRENCY`. A
 * check here would be a second answer to a question already answered loudly, in
 * the process that can still print to an operator's terminal.
 */
export function createSemaphore(limit: number): Semaphore {
  let held = 0;
  let opened = false;
  const queue: Waiter[] = [];

  // Not incrementing `held` — the two call sites below own that count, because
  // one of them is a fresh admission and the other is a transfer from a
  // releasing holder to a waiting one, where the total does not change.
  const issue = (): Permit => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const next = queue.shift();
        if (next !== undefined) {
          next.settle(issue());
          return;
        }
        held -= 1;
      }
    };
  };

  return {
    acquire(waitMs) {
      if (opened) return Promise.resolve(INERT);
      if (held < limit) {
        held += 1;
        return Promise.resolve(issue());
      }

      return new Promise<Permit | null>(resolve => {
        let settled = false;

        const waiter: Waiter = {
          settle(permit) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(permit);
          },
          expire() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        };

        queue.push(waiter);
        // Declared after the waiter that closes over it, because the timeout
        // below needs the waiter and the waiter needs the timer. Neither
        // reference is read until one of them fires.
        const timer = setTimeout(() => {
          // Out of the queue before answering, per this file's header: a waiter
          // that gave up must not be holding a place a permit will be handed to.
          const at = queue.indexOf(waiter);
          if (at !== -1) queue.splice(at, 1);
          waiter.expire();
        }, waitMs);
        // The process must not be held open by a caller's stopwatch, on the same
        // argument `mcp-catalog.ts` makes for the catalog budget's timer.
        timer.unref?.();
      });
    },

    open() {
      if (opened) return;
      opened = true;
      // Spliced before settling rather than shifted in a loop: `settle` runs
      // caller code, and a caller that acquires again from inside it would
      // otherwise be appending to a queue this loop is still walking.
      const woken = queue.splice(0, queue.length);
      for (const waiter of woken) waiter.settle(INERT);
    },

    get held() {
      return held;
    },

    get waiting() {
      return queue.length;
    }
  };
}
