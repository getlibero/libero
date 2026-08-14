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
import { type CredentialSource, DEFAULT_UPSTREAM_CONCURRENCY } from "./outbound.js";
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
 * — thirty seconds — and the call this permit is for may then take
 * `DEFAULT_UPSTREAM_TIMEOUT_MS`, which is also thirty. So a wait much longer
 * than this buys nothing: the permit would come free for a caller that had
 * already stopped listening, and the proxy would spend a saturated upstream's
 * scarce capacity answering nobody. Short enough to leave the call its own
 * budget, long enough to absorb the case this exists for — a burst of channels
 * arriving together, where the calls ahead finish in a second or two.
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

/** The `http` member of the schema's transport union, where `url` is a string. */
export type HttpUpstream = Extract<McpServer, { transport: "http" }>;

export interface McpPool {
  /**
   * The client for this upstream, created on first use.
   *
   * `null` once closed, so a call that arrives during teardown is answered
   * rather than being served over a connection the process is dismantling.
   */
  acquire(upstream: HttpUpstream, source: CredentialSource): McpClient | null;
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
  readonly fetch?: typeof globalThis.fetch;
}

/** A client and the permits that bound it. One per `upstreamKey`. */
interface Entry {
  readonly client: McpClient;
  readonly limiter: Semaphore;
  /** The client every caller is handed: `client`, behind `limiter`. */
  readonly gated: McpClient;
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
 */
function gate(client: McpClient, limiter: Semaphore, waitMs: number, listingWaitMs: number): McpClient {
  return {
    async callTool(tool, args, limits, definition): Promise<McpOutcome> {
      const permit = await limiter.acquire(waitMs);
      // `connect_failed` rather than `call_failed`, and the type is the reason
      // as much as the truth is: nothing was sent, and this is the member that
      // structurally has no `detail` for a later edit to put upstream bytes in.
      if (permit === null) return { outcome: "connect_failed", failure: "busy" };
      try {
        return await client.callTool(tool, args, limits, definition);
      } finally {
        permit.release();
      }
    },

    async listTools(cursor, timeoutMs): Promise<McpListOutcome> {
      const permit = await limiter.acquire(listingWaitMs);
      if (permit === null) return { outcome: "connect_failed", failure: "busy" };
      try {
        return await client.listTools(cursor, timeoutMs);
      } finally {
        permit.release();
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
  let closed = false;

  return {
    acquire(upstream, source) {
      if (closed) return null;

      const key = upstreamKey(upstream);
      const existing = entries.get(key);
      if (existing !== undefined) return existing.gated;

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
      const entry: Entry = { client, limiter, gated: gate(client, limiter, waitMs, listingWaitMs) };
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
