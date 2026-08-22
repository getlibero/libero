// One MCP client per upstream.
//
// **Two channels naming one upstream share a client, and that is intended.**
// They already share the credential, which is the identity the upstream sees,
// so a shared client grants neither channel anything that sharing the
// credential did not already grant. Enforcement is per-channel and runs before
// anything here is reached: by the time a call arrives, the sheet has already
// said this channel may call this tool on this server.
//
// The key is `upstreamKey` from ./enforce.ts rather than a comparison written
// out again here. That is the point of exporting it: the pool's notion of "one
// upstream" has to be enforcement's, or the pool could merge two blocks
// enforcement treats as distinct and send a call authorized against one over a
// client built for the other.
//
// Closing is asynchronous because a legacy client may hold a session, and
// ending one is a request. Every termination runs concurrently under a short
// budget of its own, so a wedged upstream costs shutdown one timeout rather
// than one per upstream — see `SESSION_TERMINATION_TIMEOUT_MS`.
//
// **`maxResponseBytes` is configured here, and a per-channel bound could not
// be.** It is the deployment's — `PROXY_MAX_RESPONSE_BYTES` — so it is the same
// number for every channel, and there is nothing for the two channels sharing
// the client above to disagree about. The obvious wrong edit is to move a
// channel's bound here alongside it: that would hand whichever channel opened
// the client first the say over every other channel's calls. The channel's own
// bound on a result travels per call instead, on `CallLimits`.
//
// **The concurrency limit is the same kind of setting and sits behind the same
// sentence** (#159). One client per upstream meant every channel naming it
// issued requests to it with nothing counting them, so ten channels calling one
// server made ten concurrent requests — correct for isolation, since they
// already share the credential, but it let one busy channel spend a shared rate
// limit on everyone else's behalf, and it left the pool's worst case against a
// black-holing upstream unbounded. `acquire` now returns a client that takes a
// permit before it speaks. `PROXY_MAX_UPSTREAM_CONCURRENCY` is the deployment's
// number for the same reason `PROXY_MAX_RESPONSE_BYTES` is: an upstream's
// tolerance is a fact about the upstream, and no single team sheet owns one —
// an upstream is a `(transport, url, credential)` tuple any number of sheets
// may name, so there is nobody to put the field on.
//
// **A client is kept while it is being used and dropped once it is not**
// (#158). The issue this closes was parked on the argument that an unused entry
// costs a map slot, which stopped being true at #150: a legacy client holds an
// `Mcp-Session-Id`, which is state at somebody else's server, and the `DELETE`
// that ends it used to be sent only from `close()` at shutdown. So a pool that
// never evicted held sessions open at upstreams nobody was calling, for as long
// as the process ran.
//
// **The trigger the issue named turned out to argue the other way.** #256 was
// expected to make a client hold a token with a lifetime; instead it introduced
// `CredentialSource`, so the client holds the *source* and asks it per request —
// see the note in `acquire`. OAuth is a settled reason *not* to evict, and the
// live reason is the paragraph above plus the one below.
//
// **Key drift is what makes this a leak rather than a preference.** Team sheets
// are re-read when they change, and `upstreamKey` includes the url, the
// credential name and the auth triple. Rotate a credential name, move a server,
// retire a block — the old key is never acquired again, and nothing before this
// removed it. That entry is not idle in the ordinary sense; it is unreachable,
// and only a sweep over the whole map collects it.
//
// **The bucket is `upstreamKey`, so it includes the credential.** Two sheet
// blocks pointing at one host under two credentials get a limit each. That is
// the right reading of "one upstream" — they are two identities with two rate
// limits as far as the far end is concerned — but it is also the way to run
// 2N calls at one host, and an operator sizing this should know it.

import type { McpServer } from "@getlibero/schema";
import { upstreamKey } from "./enforce.js";
import {
  type McpClient,
  type McpListOutcome,
  type McpOutcome,
  createMcpClient
} from "./mcp-client.js";
import { type CredentialSource, DEFAULT_UPSTREAM_CONCURRENCY, DEFAULT_UPSTREAM_TIMEOUT_MS } from "./outbound.js";
import { type Semaphore, createSemaphore } from "./semaphore.js";

/**
 * How long a call waits for a permit before giving up.
 *
 * A constant rather than a second environment variable, on the argument
 * `CATALOG_BUDGET_MS` and `SESSION_TERMINATION_TIMEOUT_MS` already make: the
 * operator's decision is how many calls their upstream tolerates, and how long
 * this process is willing to hold one waiting is a consequence of numbers that
 * are not theirs.
 *
 * **Five seconds, sized against the far end of the wire rather than this one.**
 * The agent's HTTP client abandons a request after `DEFAULT_PROXY_TIMEOUT_MS`
 * — thirty seconds — and `DEFAULT_UPSTREAM_TIMEOUT_MS` is also thirty, so the
 * call alone already fills what the agent will wait for. A wait much longer
 * than this buys nothing: the permit would come free for a caller that had
 * already stopped listening, and the proxy would spend a saturated upstream's
 * scarce capacity answering nobody. Long enough to absorb the case this exists
 * for — a burst of channels arriving together, where the calls ahead finish in
 * a second or two.
 *
 * **It is spent out of the call's budget, not beside it** (#253). This used to
 * say "short enough to leave the call its own budget", which was the honest
 * description of a bug: waiting here and then starting a fresh
 * `DEFAULT_UPSTREAM_TIMEOUT_MS` meant a queued call could run thirty-five
 * seconds against an agent that hung up at thirty, so the gate narrowed the
 * *number* of orphaned calls while slightly widening the window for each one.
 * `gate` now reads a deadline before it asks for a permit, so this number no
 * longer adds to anything — it only decides how much of the one allowance may
 * go to queueing.
 */
export const QUEUE_WAIT_MS = 5_000;

/**
 * How long a `tools/list` page waits for one. Shorter, and it has to be.
 *
 * **The invariant: this must stay below `CATALOG_BUDGET_MS`**, which is the race
 * the whole walk runs inside. Set the two equal — they both began at five
 * seconds — and a walk that has to queue can never win: its permit arrives at
 * best a hair after the catalog has already given up and answered `partial`.
 * That is not merely wasted work. A partial walk writes a resolution for every
 * name it went after, with **empty `paramDeclarations`**, cached for
 * `CATALOG_FAILURE_TTL_MS` — so against a SEP-2243 upstream, thirty seconds of
 * calls would go out with no `Mcp-Param-*` headers and be refused `-32020` at
 * the far end, for a reason nothing in the log names. A capacity blip would
 * become half a minute of failures. `mcp-pool.test.ts` pins the inequality.
 *
 * Two seconds also reflects which traffic has the weaker claim on a scarce
 * permit. A thin catalog has never been allowed to block a permitted call, so a
 * listing losing its place costs accuracy; a call losing its place costs the
 * call.
 */
export const LISTING_QUEUE_WAIT_MS = 2_000;

/**
 * How long an entry survives with nothing using it.
 *
 * A constant rather than an environment variable, on the argument
 * `QUEUE_WAIT_MS` and `CATALOG_TTL_MS` already make: the operator's decisions
 * are which upstreams exist and how many calls each tolerates, and how long
 * this process keeps a client for one it is not calling follows from those
 * rather than being a third thing to size.
 *
 * **Fifteen minutes, chosen against what eviction costs rather than what it
 * saves.** It saves an upstream session and an SDK client; it costs the next
 * caller the version ladder again — `server/discover`, and on a legacy upstream
 * the handshake behind it — which is one or two round trips inside a call
 * budget that already allows thirty seconds. So the number wants to be well
 * clear of the gaps in ordinary traffic and no larger: a channel that goes
 * quiet over lunch should still find its client, and one quiet overnight should
 * not be holding a session at 03:00.
 *
 * **Above `CATALOG_TTL_MS`, and that ordering is deliberate.** A catalog entry
 * is good for five minutes and is keyed on the same `upstreamKey`. Evict
 * underneath one and a deployment calling an upstream every four minutes would
 * re-probe on every call while its listing never expired — paying the ladder
 * precisely where the caches were supposed to be collapsing the work. Nothing
 * breaks if the two cross; it is just the wrong trade in the case that matters.
 */
export const IDLE_TTL_MS = 900_000;

/** The `http` member of the schema's transport union, where `url` is a string. */
export type HttpUpstream = Extract<McpServer, { transport: "http" }>;

export interface McpPool {
  /**
   * The client for this upstream, created on first use and after `IDLE_TTL_MS`
   * with nothing using it.
   *
   * `null` once closed, so a call that arrives during teardown is answered
   * rather than being served over a connection the process is dismantling.
   *
   * **Every call is also the pool's only chance to collect** — this is where
   * idle entries are swept, because there is no timer. See `sweep`.
   */
  acquire(upstream: HttpUpstream, source: CredentialSource): McpClient | null;
  /** Live entries, after whatever the last `acquire` swept. */
  readonly size: number;
  /**
   * Terminates any legacy session and drops every client. Never rejects.
   *
   * Bounded twice over: each `DELETE` carries `SESSION_TERMINATION_TIMEOUT_MS`,
   * and they run together rather than in sequence, so a pool of thirty
   * upstreams costs one timeout and not thirty. `Promise.allSettled` is the
   * structural half of "never rejects" — the client already swallows its own
   * failures, and this is what keeps the promise true if a later edit stops
   * swallowing one.
   */
  close(): Promise<void>;
}

export interface McpPoolOptions {
  readonly timeoutMs?: number;
  /** The deployment's bound on a response body. Absent means the process default. */
  readonly maxResponseBytes?: number;
  /**
   * The deployment's bound on concurrent calls to one upstream, from
   * `PROXY_MAX_UPSTREAM_CONCURRENCY`. Absent means
   * `DEFAULT_UPSTREAM_CONCURRENCY`.
   */
  readonly maxUpstreamConcurrency?: number;
  /**
   * How long a call waits for a permit. Absent means `QUEUE_WAIT_MS`.
   *
   * For tests, which would otherwise spend five seconds proving that a wait
   * ends. Not an operator setting and not plumbed to one — see the constant.
   */
  readonly queueWaitMs?: number;
  /**
   * The clock idle eviction reads. Absent means `Date.now`.
   *
   * Injected for the reason `mcp-catalog.ts` injects one and with the same
   * caveat: this clock decides when to drop a client nobody is calling, which
   * is a resource decision and not a deadline anything is enforced against. The
   * approval ticket's clock is the other kind, and they should not be confused.
   */
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * What the sweep reads to decide an entry is not in use.
 *
 * **The pool counts its own callers rather than reading the semaphore.**
 * `Semaphore` exposes `held` and `waiting`, and both say they are read by tests
 * and never by a decision — a line worth keeping true, but the counts are also
 * the wrong ones. `inFlight` is incremented before the permit is asked for, so
 * it covers a caller queued behind a saturated upstream as well as one already
 * speaking; an entry at its limit with a queue behind it is the busiest thing
 * in the pool, and reading `held` alone would have made it look evictable in
 * exactly the case where evicting is worst.
 */
interface Usage {
  /** Calls admitted here and not yet finished, including ones still queued. */
  inFlight: number;
  /** When the last call finished, or the client was handed out, or was built. */
  lastUsed: number;
}

/** A client and the permits that bound it. One per `upstreamKey`. */
interface Entry {
  readonly client: McpClient;
  readonly limiter: Semaphore;
  /** The client every caller is handed: `client`, behind `limiter`. */
  readonly gated: McpClient;
  readonly usage: Usage;
}

/**
 * `client`, admitting only as many calls at once as `limiter` allows.
 *
 * **A decorator rather than an async `acquire`.** A permit is released when the
 * *call* ends, not when the client is dropped, so an `acquire` that handed one
 * back would have to hand back a release with it and trust two call sites —
 * `dispatch` and the catalog's `lease` — to run it on every path including a
 * throw. Here there is one `finally` and no caller can forget it. It also keeps
 * `McpPool`, `McpClient` and `ClientLease` the shapes they already are: nothing
 * outside this file learns that a gate exists.
 *
 * **Listings are gated too, on a shorter wait.** A `tools/list` walk is a
 * credentialed request to the same upstream and counts against the same rate
 * limit, so exempting it would be exempting the traffic that arrives in bursts.
 * It waits `LISTING_QUEUE_WAIT_MS` rather than `waitMs`, for the reason written
 * on that constant. A walk that loses degrades to a thin catalog, which has
 * never been allowed to block a permitted call.
 *
 * **One permit covers a call, not a request.** A single `callTool` may spend it
 * on `server/discover`, `initialize`, `notifications/initialized`, the
 * `tools/call` itself, and — if the upstream forgot the session — a second
 * handshake and a retry. Six requests under one permit. An operator sizing
 * `PROXY_MAX_UPSTREAM_CONCURRENCY` against a server that rate-limits *requests*
 * should know the unit is not the same one.
 *
 * **No gated method calls another, and that invariant is load-bearing.** Each
 * takes one permit, holds it across nobody else's work, and releases it in a
 * `finally`. The edit that breaks it is the tempting one: hoisting a single
 * permit up into `dispatch` so a cold call does not wait twice — once for the
 * catalog's walk, once for the call. At `maxUpstreamConcurrency = 1` that
 * self-deadlocks, because the dispatch would hold the only permit while the
 * walk beneath it waited for one. Gating per request and gating per dispatch are
 * both coherent; half of each is a hang.
 *
 * `protocol` and `close` pass straight through. Neither speaks to an upstream:
 * one is a word about a connection already settled, and the other is shutdown,
 * which is exactly when this must not be waiting for a permit.
 *
 * **It is also where an entry's use is recorded** (#158). Both gated methods
 * bracket everything they do in `usage`: `inFlight` up before the permit is
 * asked for, down in the outermost `finally`, which is the same `finally` that
 * stamps `lastUsed`. Stamping on the way *out* rather than the way in is what
 * makes a slow call count as use for its whole duration rather than from when
 * it started, so a thirty-second call cannot leave an entry looking half a
 * minute idler than it is.
 *
 * A refused permit takes the same path: `busy` is traffic this upstream is
 * getting, and an upstream saturated enough to turn calls away is the last one
 * whose client should be dropped for disuse.
 */
function gate(
  client: McpClient,
  limiter: Semaphore,
  waitMs: number,
  listingWaitMs: number,
  budgetMs: number,
  usage: Usage,
  now: () => number
): McpClient {
  return {
    async callTool(tool, args, limits, definition): Promise<McpOutcome> {
      usage.inFlight += 1;
      try {
        // **The budget starts here, before the wait** (#253). Until this line
        // existed a call could wait `waitMs` for a permit and then be given a
        // full `timeoutMs` on top, so the gate that exists to stop a saturated
        // upstream from black-holing this process slightly *widened* the window
        // in which the agent has already hung up on a call still in flight.
        // Reading the deadline before `acquire` is what makes the two one
        // allowance rather than two.
        //
        // **`Date.now` and not `now`**, which is the injected clock two fields
        // up. That one's own doc draws the line: it is what idle eviction reads,
        // a resource decision and "not a deadline anything is enforced against".
        // This is the other kind, and it has to agree with the clock
        // `mcp-client.ts` reads on the far side of the call — a deadline
        // computed from a test's fiction would be arithmetic against a number
        // that file will never see.
        const deadline = Date.now() + budgetMs;
        const permit = await limiter.acquire(waitMs);
        // `connect_failed` rather than `call_failed`, and the type is the reason
        // as much as the truth is: nothing was sent, and this is the member that
        // structurally has no `detail` for a later edit to put upstream bytes in.
        if (permit === null) return { outcome: "connect_failed", failure: "busy" };
        try {
          return await client.callTool(tool, args, limits, definition, deadline);
        } finally {
          permit.release();
        }
      } finally {
        usage.inFlight -= 1;
        usage.lastUsed = now();
      }
    },

    async listTools(cursor, timeoutMs): Promise<McpListOutcome> {
      usage.inFlight += 1;
      try {
        // **No deadline here, and it is not an omission** (#253). A listing
        // already runs inside one: ./mcp-catalog.ts races the whole walk against
        // `CATALOG_BUDGET_MS`, which starts before the first page is asked for
        // and therefore already covers whatever this wait costs. That is the
        // same invariant `LISTING_QUEUE_WAIT_MS` is chosen against — it has to
        // stay below the catalog budget or a queued walk can never win — so the
        // listing arm was never the arm that stacked.
        const permit = await limiter.acquire(listingWaitMs);
        if (permit === null) return { outcome: "connect_failed", failure: "busy" };
        try {
          return await client.listTools(cursor, timeoutMs);
        } finally {
          permit.release();
        }
      } finally {
        usage.inFlight -= 1;
        usage.lastUsed = now();
      }
    },

    get protocol() {
      return client.protocol;
    },

    close() {
      return client.close();
    }
  };
}

export function createMcpPool(options: McpPoolOptions): McpPool {
  const entries = new Map<string, Entry>();
  const limit = options.maxUpstreamConcurrency ?? DEFAULT_UPSTREAM_CONCURRENCY;
  const waitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
  // Scaled from the call's wait rather than taken as a second option, so a test
  // that shortens one shortens both and the inequality the listing wait depends
  // on survives the override. At least a millisecond: a test may pass a wait
  // small enough that 40% of it rounds to no wait at all, and a listing that
  // never waits is a different behaviour from one that waits briefly.
  const listingWaitMs = Math.max(1, Math.round(waitMs * (LISTING_QUEUE_WAIT_MS / QUEUE_WAIT_MS)));
  // The same number the clients are built with, read here so the gate can turn
  // it into a deadline that starts before the wait (#253). Not a second setting
  // — a pool whose queue budget and whose call budget could disagree would be
  // exactly the stacking this removes, spelled as configuration.
  const budgetMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let closed = false;

  /**
   * Drop every entry nothing is using, except the one being acquired.
   *
   * **Lazy, on `acquire`, and there is deliberately no timer** — the question
   * #158 asked out loud. `mcp-catalog.ts` settled the pattern for this process:
   * an injected clock and expiry evaluated when something reads the map. A
   * timer would be the only recurring one in the proxy, would have to be
   * `unref`'d not to hold the process open, and would buy the difference
   * between collecting a dead entry now and collecting it at the next call.
   *
   * The cost of lazy is worth naming: **a pool that goes completely quiet keeps
   * what it had.** Nothing sweeps a proxy nobody is calling, so the last entry
   * to be used outlives its window until either the next `acquire` or
   * `close()`, which ends every session anyway. That is the case least worth
   * spending a timer on.
   *
   * **The whole map, not just the key being acquired**, because the entry this
   * exists to collect is the one whose key no longer appears in any sheet.
   * Checking only the requested key would collect exactly the entries that are
   * still in use and none of the stranded ones. `entries` is bounded by the
   * operator's configuration — tens, not thousands — so a linear pass per
   * acquire costs less than the map lookup it follows.
   *
   * **`except` is the key on its way to being used**, and skipping it is not
   * bookkeeping. Evicting an entry in the same breath as handing it out would
   * make an upstream called once an hour re-run the version ladder every single
   * time and never hold a session at all — the pathological case for a cache,
   * reached only by the caller that proves the entry is wanted.
   */
  const sweep = (except: string, at: number): void => {
    for (const [key, entry] of entries) {
      if (key === except) continue;
      if (entry.usage.inFlight > 0) continue;
      if (at - entry.usage.lastUsed < IDLE_TTL_MS) continue;
      entries.delete(key);
      // Unawaited, and safe only because `McpClient.close` swallows every
      // failure including a `RedactionError` — the second place in this package
      // leaning on that, after `close()` below. `acquire` is synchronous and
      // must stay so; the session `DELETE` is a courtesy to the upstream and
      // nothing here reads its answer, so there is nobody to report to and
      // nothing to wait for.
      void entry.client.close();
      // No `limiter.open()`, unlike shutdown: `inFlight` is zero, so there is
      // no waiter to wake. Opening it would hand an inert permit to whatever
      // reached a stale reference, in place of the refusal it should get.
    }
  };

  return {
    acquire(upstream, source) {
      if (closed) return null;

      const key = upstreamKey(upstream);
      const at = now();
      sweep(key, at);

      const existing = entries.get(key);
      if (existing !== undefined) {
        // Handing a client out counts as use, before any call is made with it.
        // The catalog holds a leased client across a multi-page walk and the
        // dispatcher across its own guards, so an entry whose caller is between
        // requests is in use in the sense that matters.
        existing.usage.lastUsed = at;
        return existing.gated;
      }

      // The source is only read when a client is created; a later call with
      // the same key keeps the client it has. That is correct rather than
      // convenient — the key carries the credential *name* and the auth block,
      // so two acquires under one key cannot mean two ways of authenticating.
      // What the credential behind the source is worth *right now* is the
      // source's business, asked per request inside the guarded fetch; that is
      // what lets a client outlive a minted token where it could never outlive
      // a captured one.
      const client = createMcpClient({
        url: upstream.url,
        source,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      });
      // One semaphore per key, created with the client and never afterwards, so
      // every channel reaching this upstream is counted against one limit. A
      // limiter built per `acquire` would count nothing.
      const limiter = createSemaphore(limit);
      const usage: Usage = { inFlight: 0, lastUsed: at };
      const entry: Entry = {
        client,
        limiter,
        gated: gate(client, limiter, waitMs, listingWaitMs, budgetMs, usage, now),
        usage
      };
      entries.set(key, entry);
      return entry.gated;
    },

    get size() {
      return entries.size;
    },

    // A stateless client has nothing to hang up — `2026-07-28` has no session
    // to terminate and no socket this layer owns, since undici's keep-alive is
    // beneath us. A legacy client with a session does: one `DELETE` naming it,
    // which is the courtesy the spec asks for.
    //
    // **The state changes before the first await, not after it.** `acquire`
    // must refuse and `size` must read zero from the instant `close()` is
    // entered rather than from when its terminations resolve — a caller that
    // does not await this still gets a pool that hands out nothing.
    //
    // **The limiters open rather than reject**, in the same breath and for the
    // same reason. A call queued for a permit when shutdown begins is woken and
    // sent on to the client, which answers `closed`. The alternative was a
    // second saturated vocabulary meaning "not busy, shutting down", to say a
    // thing the layer beneath already says. Waking them is also what keeps
    // `close()`'s promise never to leave a caller waiting on a pool that is gone.
    //
    // This is the path that made `failureText` owe `closed` a sentence on its
    // `connect_failed` arm as well as its `call_failed` one. Before #159 a
    // connect-time `closed` needed a race to reach; now it is where every queued
    // call goes at shutdown, and the default sentence there would have blamed a
    // server that was never asked.
    //
    // **The closes are started before the limiters open, and the order is the
    // mechanism rather than tidiness.** `McpClient.close` flips its own `closed`
    // before its first await, so calling it first — without awaiting — is what
    // makes the sentence above true: every waiter woken on the next line meets a
    // client that already refuses. Open the limiters first and a woken call
    // would race the flip and send a real request to an upstream this process is
    // walking away from.
    async close() {
      if (closed) return;
      closed = true;
      const open = [...entries.values()];
      entries.clear();
      const closing = open.map(entry => entry.client.close());
      for (const entry of open) entry.limiter.open();
      await Promise.allSettled(closing);
    }
  };
}
