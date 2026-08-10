// Teardown that survives a failure part-way through setup.
//
// The rig builds seven things in order, three of which hold an OS resource: a
// spawned process, two listening sockets, and four temporary directories. If
// the fifth step throws, the first four still have to come down — and a
// `beforeAll` that threw has no `afterAll` state to come down *from*, because
// the variables it was going to assign were never assigned.
//
// So the stack is built before anything else and every step registers into it
// as soon as its resource exists. Setup drains it and rethrows; `afterAll`
// drains it again, which is why draining twice has to be safe.

/** Undoes one thing. Must be safe to call once; the stack guarantees no more. */
export type Disposer = () => void | Promise<void>;

export interface Cleanup {
  /** Registers a disposer. Drained in reverse, so register right after acquiring. */
  add(what: string, dispose: Disposer): void;
  /**
   * Runs every disposer, newest first, and forgets them.
   *
   * Every disposer runs even if an earlier one throws — the alternative is that
   * a failed `rmSync` leaves a proxy process alive holding a vault. Failures are
   * collected and thrown together, so a teardown bug is visible rather than
   * swallowed, but only after everything else has had its turn.
   */
  drain(): Promise<void>;
}

export function createCleanup(): Cleanup {
  const stack: Array<{ what: string; dispose: Disposer }> = [];

  return {
    add(what: string, dispose: Disposer): void {
      stack.push({ what, dispose });
    },

    async drain(): Promise<void> {
      const failures: string[] = [];
      // Reverse order, and `pop` rather than iterate: draining is destructive,
      // so a second drain finds an empty stack instead of running everything a
      // second time.
      for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
        try {
          await entry.dispose();
        } catch (error) {
          failures.push(`${entry.what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`e2e: teardown failed:\n  ${failures.join("\n  ")}`);
      }
    }
  };
}

/**
 * Runs `build`, draining the stack if it throws.
 *
 * The shape every multi-step setup wants: the caller gets a built thing or an
 * exception, and in the exception case nothing is left running.
 */
export async function guarded<T>(cleanup: Cleanup, build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    await cleanup.drain().catch(() => {
      // The original failure is what the operator needs to see. A teardown
      // error on top of it would replace the cause with a symptom.
    });
    throw error;
  }
}
