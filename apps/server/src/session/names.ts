// A session's display names: one lookup per user, not one per message.
//
// The acceptance criterion #67 states — "resolved once per user per session" —
// as a small object rather than a habit at the call sites. The assembler
// resolves an author for every message it renders and every `<@U…>` inside one,
// which in a forty-message transcript is dozens of asks for a handful of
// distinct people.
//
// ### Why the lookup is a parameter and not a field
//
// The implementation is a Slack API call, and an ESLint rule on
// `apps/server/src/session/**` allows only logging names through from
// `@getlibero/gateway`. So what crosses into this directory is
// `DisplayNameLookup` — a plain function of a string — and the Slack-typed
// `UserDirectory` behind it is wired in compose.ts, above the seam. It is the
// same shape `HeldCallPrompter` uses for the same reason, and it is what keeps
// a second front-end able to supply names from wherever it has them.
//
// ### Why it lives on the session
//
// A session is evicted after thirty idle minutes and the cache goes with it,
// which is the whole invalidation policy. A name that changed is wrong for at
// most that long, and there is no watcher, no TTL, and no bus to invent. A
// process-wide cache would be a lifetime nothing here owns.
//
// The cost is that a user in ten channels is looked up ten times. That is the
// right trade at this size: the alternative buys one round trip and pays for it
// with a cache whose entries outlive every reason to trust them.

/**
 * How a name is actually found. Async, because the real one is a network call.
 *
 * `undefined` means there is no name to have — a departed user, or a lookup
 * that failed — and the two are deliberately one answer here. A caller that
 * treated them differently would be a caller that retried, and retrying a
 * missing user is a call per message forever.
 */
export type DisplayNameLookup = (userId: string) => Promise<string | undefined>;

/** How many distinct users one session remembers. */
export const NAME_CACHE_MAX = 500;

export interface NameCache {
  /**
   * This user's name, from the cache or from `lookup`.
   *
   * **The miss is cached too**, which is the half that is easy to leave out: a
   * user who has left the workspace has no name and will not grow one, and a
   * cache that only remembered successes would ask about them once per message
   * forever — which is exactly the failure the acceptance criterion names, just
   * for the users it is most likely to happen to.
   */
  get(userId: string, lookup: DisplayNameLookup): Promise<string | undefined>;
  /** How many users are remembered. For tests. */
  readonly size: number;
}

export interface NameCacheOptions {
  /** Defaults to `NAME_CACHE_MAX`. A constructor option, so a test can state a small one. */
  max?: number;
}

/**
 * Builds the cache.
 *
 * **It caches the promise, not the name**, which is what makes "once per user
 * per session" true rather than usually true. The router assembles a transcript
 * inside the session's mutex, but ingest deliberately does not take it — two
 * messages from the same new author dispatch concurrently, and a cache holding
 * settled values would have both miss and both call. Storing the in-flight
 * promise means the second caller awaits the first one's answer.
 *
 * **A failed lookup is remembered as "no name" rather than retried.** That is
 * the deliberate half of treating both misses alike: an outage costs a session
 * its attribution and never a call per message. A session lasts thirty idle
 * minutes, so the blast radius is bounded by the same eviction everything else
 * here is.
 */
export function createNameCache(options: NameCacheOptions = {}): NameCache {
  const max = options.max ?? NAME_CACHE_MAX;
  // Insertion-ordered, evicting oldest-first — the same bounded-set shape the
  // gateway's `seen` uses, and for the same reason: an unbounded map in a
  // long-lived process is a leak, and a channel can have thousands of members.
  const names = new Map<string, Promise<string | undefined>>();

  return {
    get size(): number {
      return names.size;
    },

    get(userId: string, lookup: DisplayNameLookup): Promise<string | undefined> {
      const existing = names.get(userId);
      if (existing !== undefined) return existing;

      // `.catch` rather than a try around an await, because the entry is stored
      // before anything is awaited — that is the whole in-flight guarantee. The
      // lookup's own contract is that it does not throw (`UserDirectory`
      // answers `undefined` for every failure); this is for a second
      // implementation that forgot, and it fails the same way: no name,
      // remembered, and nothing above this loses a task over an attribution.
      const pending = lookup(userId).catch(() => undefined);
      names.set(userId, pending);

      if (names.size > max) {
        const oldest = names.keys().next().value;
        if (oldest !== undefined) names.delete(oldest);
      }
      return pending;
    }
  };
}
