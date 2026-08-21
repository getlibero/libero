// Polling until an assertion holds — `vi.waitFor` without the default that
// nobody chose.
//
// The timeout is a **required** argument, and that is the whole reason this is
// not a two-line copy of vitest's helper. `vi.waitFor` defaulted to a second,
// and six e2e call sites silently took it inside rigs whose other waits are
// measured in minutes; one of them failed a CI run on nothing but a loaded
// runner (#329). `e2e/src/harness-shape.test.ts` grepped for the import to stop
// that recurring. A required parameter is the same rule enforced by the type
// system instead, which is why that grep is gone.
//
// The last failure is what surfaces on timeout, not a generic "timed out": the
// half `expected undefined to be defined` was missing is *what* was being
// waited for, and the assertion that kept failing says it.

export interface WaitForOptions {
  /** How long to keep retrying, in milliseconds. No default, on purpose. */
  readonly timeout: number;
  /** How long to sleep between attempts. */
  readonly interval?: number;
}

/** Runs `check` until it returns without throwing, or until `timeout` elapses. */
export async function waitFor(
  check: () => void | Promise<void>,
  { timeout, interval = 25 }: WaitForOptions
): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: unknown;

  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw last instanceof Error
    ? new Error(`still failing after ${timeout} ms: ${last.message}`, { cause: last })
    : new Error(`still failing after ${timeout} ms: ${String(last)}`);
}
