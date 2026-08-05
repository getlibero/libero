// The sessions, one per (workspace, channel), and nothing shared between them.
//
// A session is created on first use and torn down when it has been idle long
// enough, because a long-lived process must not accumulate one per channel
// forever. Today a session is a mutex and a timestamp, so eviction frees very
// little; the reason it exists now is that the next two issues make it matter.
// #63 gives a session a SQLite handle and #67 a display-name cache, and both
// are released at the single `entries.delete` below.
//
// There is no accessor that returns more than one session and no iteration over
// them outside the sweep. Ask for one session, get one session.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { Mutex } from "./mutex.js";
import { createMutex } from "./mutex.js";
import type { SessionKey } from "./types.js";

/**
 * How long a session survives with nothing to do.
 *
 * Exported because #66 has to reconcile with it: once a session holds the set
 * of threads it will answer without a re-mention, evicting a session
 * deactivates its threads. #66's follow-up window must therefore be this or
 * shorter, or a thread goes quiet before the window it advertised is up.
 *
 * A constructor option with a constant default rather than an environment
 * variable. This process's environment contract is that everything in it is
 * required and load-bearing; an optional knob for a number nobody has yet had a
 * reason to change cuts against it.
 */
export const SESSION_IDLE_MS = 30 * 60_000;

export interface Session {
  readonly key: SessionKey;
  readonly mutex: Mutex;
  /** When work here last finished. The sweep reads it; the router writes it. */
  lastUsedAt: number;
}

export interface SessionRegistryOptions {
  idleMs?: number;
  /** Injected so a test states the clock rather than faking timers. */
  now?: () => number;
  logger?: Logger;
}

export interface SessionRegistry {
  /** This key's session, created on first use. Synchronous, deliberately. */
  open(key: SessionKey): Session;
  /** How many are live. For tests — there is no iteration over them. */
  readonly size: number;
}

/**
 * Builds the registry.
 *
 * **`open` is synchronous on purpose.** There is no `await` between finding a
 * session and joining its queue, so a sweep cannot drop a session that someone
 * is about to queue work on. An async lookup would open that window for nothing
 * — there is no I/O here to be async about.
 *
 * **Eviction is lazy, on the path that runs anyway.** A `setInterval` would
 * keep the process alive to free memory nobody is waiting on, and a sweep that
 * fires while no mention is arriving has nothing to do. Sweeping on `open`
 * means the cost is paid by the traffic that created the sessions.
 *
 * **A busy session is never evicted, however old.** `pending > 0` is the whole
 * check, and it covers running and queued alike.
 */
export function createSessionRegistry(options: SessionRegistryOptions = {}): SessionRegistry {
  const idleMs = options.idleMs ?? SESSION_IDLE_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? createSilentLogger();

  // Both halves are ids from a restricted alphabet, so the separator cannot be
  // ambiguous the way a tool name's would be.
  const entries = new Map<string, Session>();
  const idOf = (key: SessionKey): string => `${key.workspace}/${key.channel}`;

  function sweep(at: number): void {
    for (const [id, session] of entries) {
      if (session.mutex.pending > 0) continue;
      if (at - session.lastUsedAt < idleMs) continue;

      // The one place a session is dropped, which is where #63's `close()` and
      // #67's cache release go. One line to change rather than a lifecycle to
      // invent.
      entries.delete(id);
      logger.log("info", {
        event: "session_evicted",
        team: session.key.workspace,
        channel: session.key.channel
      });
    }
  }

  return {
    get size(): number {
      return entries.size;
    },

    open(key: SessionKey): Session {
      const at = now();
      sweep(at);

      const id = idOf(key);
      const existing = entries.get(id);
      if (existing !== undefined) {
        // Touched on the way in as well as on the way out, so a session that
        // has been queued on but has not finished anything yet does not look
        // idle to the next sweep.
        existing.lastUsedAt = at;
        return existing;
      }

      const session: Session = { key, mutex: createMutex(), lastUsedAt: at };
      entries.set(id, session);
      return session;
    }
  };
}
