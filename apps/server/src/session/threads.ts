// Which threads a channel's agent is currently working in, and until when.
//
// This is the whole of #66's state. A mention creates a task, the task's thread
// becomes active, and for as long as it stays active a message in it is routed
// with no mention. Everywhere else in the channel still needs one, which is what
// keeps "the agent answers when addressed" true of a channel that has one live
// thread in it.
//
// **A deadline, not a flag.** Without an expiry the agent answers every message
// in that thread for the life of the process, which is a channel discovering
// weeks later that a conversation it forgot about is still being read. Task
// completion alone is the other tempting rule and it is the wrong one: it would
// route messages that arrive mid-task and nothing else, and the case people
// actually want is replying to the answer.
//
// The window is the channel's — `[llm] follow_up_window_seconds` — and it is
// applied here at *write* time rather than read time. The task that activates a
// thread has already resolved the sheet, and the ingest that asks `isActive` has
// not; making the deadline absolute is what keeps the read path from needing a
// sheet of its own. An operator's edit therefore lands on the next task rather
// than on the next message, which is the same freshness every other sheet value
// has.
//
// Nothing here is an authorization decision. An active thread decides whether a
// task is *started*, never what it may do: the task runs on the same sheet with
// the same caps, and the proxy enforces the same file from its own copy. The
// worst a wrong answer here can do is spend the channel's own budget, which is
// the reason the window is the channel's to set.

/** One channel's active threads. Held by its session, and dies with it. */
export interface ThreadActivity {
  /**
   * Marks a thread active for `windowMs` from `at`, replacing any deadline it
   * already had.
   *
   * `windowMs` of 0 is a channel that has turned follow-ups off, and it
   * *deactivates* rather than doing nothing: a sheet edited to 0 should stop a
   * thread that is already warm, not wait for it to cool.
   */
  activate(thread: string, at: number, windowMs: number): void;
  /** Whether a message arriving in this thread at `at` should be answered. */
  isActive(thread: string, at: number): boolean;
  /** How many are being tracked. For tests — there is no iteration over them. */
  readonly size: number;
}

export function createThreadActivity(): ThreadActivity {
  // Thread id to the moment it stops being active. Absolute, so nothing here
  // holds a clock or a timer — the callers already have one, and a timer per
  // thread is a lifetime this would then have to own.
  const until = new Map<string, number>();

  return {
    get size(): number {
      return until.size;
    },

    activate(thread: string, at: number, windowMs: number): void {
      // Swept on the write path, which is the path that runs once per task
      // rather than once per message — the same argument `registry.ts` makes
      // for sweeping sessions on `open`. Without it a channel that has been up
      // for a month holds an entry per thread anyone ever mentioned the agent
      // in, all of them long expired.
      for (const [id, deadline] of until) {
        if (deadline <= at) until.delete(id);
      }

      if (windowMs <= 0) {
        until.delete(thread);
        return;
      }
      until.set(thread, at + windowMs);
    },

    isActive(thread: string, at: number): boolean {
      const deadline = until.get(thread);
      // Expired entries are left for the next `activate` to sweep rather than
      // deleted here. This is the read path and it runs per message; a read
      // that mutates would make two concurrent messages in one channel race
      // over a map for no gain, since the answer is the same either way.
      return deadline !== undefined && deadline > at;
    }
  };
}
