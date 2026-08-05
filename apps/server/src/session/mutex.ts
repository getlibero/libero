// One at a time, in arrival order.
//
// The tail of the chain is the queue. Enqueueing is attaching to it, so arrival
// order is chain order and there is nothing to poll: no boolean, no array of
// resolvers, no drain loop deciding who goes next. The alternative is the same
// behaviour with three more places to get it wrong.
//
// This is what makes two mentions in one channel queue rather than interleave.
// Channels do not share a mutex, so a channel waiting on a slow task delays only
// itself.

const NOOP = (): void => {};

export interface Mutex {
  /** Runs `work` once every earlier caller has settled. Rejections propagate. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Queued plus running. Zero means nothing holds this session, which is the
   * one condition under which it is safe to evict.
   */
  readonly pending: number;
}

export function createMutex(): Mutex {
  // Never rejects: both assignments to it below swallow. That is what lets
  // `run` chain with one handler rather than guarding every link.
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    get pending(): number {
      return pending;
    },

    run<T>(work: () => Promise<T>): Promise<T> {
      pending += 1;
      const result = tail.then(work);

      // The queue drains on failure exactly as on success. A task that threw
      // must not hold the ones behind it, and a rejected `tail` that nobody
      // observes is an unhandled rejection at the process level — which under
      // Node's default is a dead process, over a task that already failed.
      // The caller still gets the rejection, because what is returned is
      // `result` rather than this.
      tail = result.then(NOOP, NOOP);

      // Registered after `tail`'s continuation, so the next task is scheduled
      // before `pending` drops. That is not a race: the next task incremented
      // `pending` when it enqueued, so the count reaches zero only when the
      // session is genuinely idle. Eviction rests on exactly that.
      return result.finally(() => {
        pending -= 1;
      });
    }
  };
}
