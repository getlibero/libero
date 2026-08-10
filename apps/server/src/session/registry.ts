// The sessions, one per (workspace, channel), and nothing shared between them.
//
// A session is created on first use and torn down when it has been idle long
// enough, because a long-lived process must not accumulate one per channel
// forever. Since #176 a session holds an open SQLite file and since #67 a cache
// of display names, so eviction now frees something real — both go at the
// single `entries.delete` below.
//
// There is no accessor that returns more than one session and no iteration over
// them outside the sweep. Ask for one session, get one session.
//
// **Two callers open a session and only one of them takes its mutex.** A
// mention goes through the router, which queues on the mutex so a channel's
// model turns do not interleave. Message ingest opens a session and writes
// straight through: a store write is one synchronous statement with nothing to
// serialize — SQLite's own WAL and busy timeout are the concurrency control for
// the file — and putting it behind the mutex would leave a message unwritten
// for the length of a model turn. The mutex is for turns, not for the file.
//
// The consequence is deliberate: message traffic creates sessions and defers
// their eviction, so a chatty channel that never mentions the app keeps a warm
// store handle. That is the point of holding the handle here rather than
// reopening the file per message.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import type { Mutex } from "./mutex.js";
import { createMutex } from "./mutex.js";
import { createNameCache } from "./names.js";
import type { NameCache } from "./names.js";
import type { MessageStoreOpener } from "./store.js";
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
  /**
   * This channel's message store, or `null` when it has none — no
   * `openStore` was given, or the channel has no team sheet, or the file could
   * not be opened. Resolved once, when the session is created, so a channel
   * that cannot have one costs one attempt and one log line rather than one per
   * message. Closed by the sweep.
   */
  readonly store: MessageStore | null;
  /**
   * Who each user id in this channel is, resolved once and kept.
   *
   * On the session because the session's lifetime *is* the invalidation policy:
   * a name that changed is stale for at most one idle window, and there is no
   * TTL, watcher, or bus to invent. It holds no lookup of its own — the
   * function that finds a name is passed in per call, so nothing under this
   * directory has to name a Slack type.
   */
  readonly names: NameCache;
  /** When work here last finished. The sweep reads it; the router writes it. */
  lastUsedAt: number;
}

export interface SessionRegistryOptions {
  idleMs?: number;
  /**
   * How a session gets its message store. Omitted by a caller with nowhere to
   * put messages, which is every test not asserting on the store and any
   * front-end composing no ingest — the sessions then hold `null` and the
   * process answers mentions exactly as before.
   */
  openStore?: MessageStoreOpener;
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
 * is about to queue work on. An async lookup would open that window for
 * nothing.
 *
 * Creating a session does now touch the filesystem — `openStore` stats a sheet,
 * makes a directory, and opens a SQLite file — and it stays synchronous
 * regardless, because `DatabaseSync` is. That is the reason `packages/memory`'s
 * whole interface is synchronous, and it is what lets this window stay closed.
 *
 * **`open` cannot fail.** `openStore` answers `null` rather than throwing, so
 * an unwritable disk costs a channel its history and never a mention its
 * answer. `router.ts` calls this outside any `try`, and a throw here would
 * propagate to the gateway as `handler_failed`.
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
  const openStore = options.openStore;
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

      // The one place a session is dropped, and where #67's cache release goes
      // too. One line to change rather than a lifecycle to invent.
      //
      // Closed before the entry is dropped: after the delete, nothing holds the
      // handle and the file stays open until the process exits. Nothing here
      // catches — `close` is `db.close()` on a database with no statement in
      // flight, because a session with `pending > 0` was skipped above.
      session.store?.close();
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

      // `openStore` is total by contract — it returns null rather than throwing
      // — which is what keeps `open` total. See the note on `open` above and
      // the header of store.ts.
      const session: Session = {
        key,
        mutex: createMutex(),
        store: openStore?.(key.channel) ?? null,
        names: createNameCache(),
        lastUsedAt: at
      };
      entries.set(id, session);
      return session;
    }
  };
}
