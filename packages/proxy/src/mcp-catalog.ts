// What an upstream says its tools are, bounded and cached.
//
// This fills the `ToolCatalog` seam in ./dispatch.ts. The listing route asks it
// what a server offers; it walks that server's `tools/list` pages, keeps the
// entries the team sheet named, bounds what each one said, and answers a map.
//
// **It takes a lease on a client, never a `Vault` and never a `Secret`.** The
// header of ./http-dispatcher.ts claims to be the only module holding a vault
// and a network transport at once, and that claim is worth keeping verbatim: a
// second module resolving credentials is a second place to audit. So the
// transport guard and the vault lookup stay where they already are, and this
// file receives the result — a client, or the reason there is none.
//
// **Nothing here refuses a listing.** Every way of not getting an answer is an
// empty map and one log line, because the listing is not the enforcement: a
// tool with no schema is still a tool the sheet permits, and a tool the sheet
// omits is still refused at call time. The single exception is a
// `RedactionError`, which is not an upstream failure but this proxy unable to
// guarantee its own boundary — it propagates, for the reason ./http-dispatcher.ts
// rethrows one rather than converting it to a result.
//
// **It is a cache with a clock, and the clock is not a security deadline.** An
// approval ticket deliberately shares the server's clock because a deadline is
// policy; this one only decides when to ask an upstream again, which is why it
// is an injected `now()` here and nothing more.

import type { McpServer } from "@getlibero/schema";
import type { ToolCatalog, UpstreamToolDescription } from "./dispatch.js";
import { createSilentLogger, type Logger } from "./log.js";
import type { McpClient } from "./mcp-client.js";
import { boundedToolDescription, boundedToolInputSchema } from "./mcp-protocol.js";
import { upstreamKey } from "./enforce.js";

/**
 * How long an answered catalog is reused.
 *
 * Not the handshake ladder's rule, which caches for the client's life. That
 * caches a *protocol both ends agreed on*, which cannot change under a running
 * process; a catalog is data, and an operator who adds a tool upstream should
 * see its schema without restarting a proxy.
 *
 * Five minutes because a task fetches its listing once and mentions arrive in
 * bursts, so this collapses a burst to one round trip per upstream.
 */
export const CATALOG_TTL_MS = 300_000;

/**
 * How long a failed or partial walk is remembered.
 *
 * Also not the ladder's rule, which caches success and never failure. There,
 * not caching a failure costs one retry; here it would mean every listing pays
 * a full budget against a dead upstream, which is the polling-load problem this
 * cache exists for, in its worst form. Thirty seconds bounds a persistently
 * down upstream to one attempt per half minute per process and still recovers
 * quickly.
 */
export const CATALOG_FAILURE_TTL_MS = 30_000;

/**
 * The wall clock one upstream's whole walk may spend.
 *
 * **A race here rather than a timeout in the client, and the difference
 * matters.** `ensureOpen`'s ladder takes no per-call timeout — it falls back to
 * `DEFAULT_UPSTREAM_TIMEOUT_MS` — so a listing against a black-holing upstream
 * would hang the agent's first turn for thirty seconds before a single model
 * token was spent. Threading a timeout into the ladder instead would be worse:
 * its result is cached for the client's life, so the handshake's deadline would
 * depend on whichever caller happened to open it.
 *
 * The abandoned handshake keeps running, and that is the point rather than a
 * leak: it is single-flighted inside the client, so it warms that client for
 * the next listing or the first tool call. Nothing reads its result, so no
 * upstream bytes escape the race.
 */
export const CATALOG_BUDGET_MS = 5_000;

/**
 * How many tools from one upstream may carry a description.
 *
 * A bound on what enters the model's context, since definitions are fetched
 * once per task and re-sent on every turn. Applied *after* the sheet's names
 * have filtered the page — see `describe` — so an upstream cannot push a
 * sheet's tool past the cap behind two hundred decoys.
 */
export const MAX_DESCRIBED_TOOLS = 100;

/** How many pages of one catalog are walked before the walk gives up. */
export const MAX_CATALOG_PAGES = 5;

/**
 * A client for this upstream, or why there is none.
 *
 * The three reasons are the three things ./http-dispatcher.ts already
 * discovers before it opens anything: a transport with no HTTP client, a
 * credential the vault does not hold, and a pool that has begun closing.
 */
export type ClientLease =
  | { readonly ok: true; readonly client: McpClient }
  | {
      readonly ok: false;
      readonly reason: "unsupported_transport" | "credential_unresolved" | "shutting_down";
      /** By name, never by value, and only where there is one to name. */
      readonly credential?: string;
    };

export interface McpCatalogOptions {
  readonly lease: (upstream: McpServer) => ClientLease;
  readonly logger?: Logger;
  readonly now?: () => number;
}

type Described = ReadonlyMap<string, UpstreamToolDescription>;

interface CacheEntry {
  readonly described: Described;
  readonly expiresAt: number;
}

/**
 * Whether a walk ran out.
 *
 * A walk that ended early — a failure, a cap, the budget — is not a success,
 * and is remembered for `CATALOG_FAILURE_TTL_MS` rather than the full window.
 * What it collected before it stopped is kept regardless: the thin entry is the
 * floor, so a partial walk describes less and never misdescribes.
 */
type Walked = "complete" | "partial";

const EMPTY: Described = new Map();

/**
 * The cache key: the upstream, and what was asked of it.
 *
 * `upstreamKey` alone would be wrong. A walk stops as soon as it has found
 * every wanted name and it caps on the wanted names, so what it produces
 * depends on the set it was given — and two channels whose sheets name the same
 * server with different tool lists would otherwise read each other's answer.
 * That is not a content leak (a catalog is the server's, identical for every
 * channel that can reach it, and `upstreamKey` already separates credentials)
 * but it is a wrong answer, and one channel's listing going thin because
 * another asked for less is exactly the bug nobody would find.
 *
 * Sorted, so two sheets naming the same tools in different orders share the
 * entry they should share.
 */
function cacheKey(upstream: McpServer, wanted: ReadonlySet<string>): string {
  return JSON.stringify([upstreamKey(upstream), [...wanted].sort()]);
}

export function createMcpCatalog(options: McpCatalogOptions): ToolCatalog & { clear(): void } {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const cached = new Map<string, CacheEntry>();
  const walking = new Map<string, Promise<Described>>();

  const unavailable = (upstream: McpServer, reason: string, extra: Record<string, unknown> = {}): void => {
    // On a cache miss only, so a client polling the listing route does not
    // produce a line per poll. One event with a closed reason set rather than
    // eight events, for the reason a refusal has one shape.
    logger.log("warn", {
      event: "catalog_unavailable",
      server: upstream.name,
      reason,
      ...extra
    });
  };

  /**
   * One tool's two describing fields, or nothing worth publishing.
   *
   * A description truncates and a schema does not, which is the split
   * `mcp-protocol.ts` argues. A rejected schema is logged with its reason
   * because an operator asking why one tool is thin has no other way to find
   * out; a truncated description is not an event, because truncation is the
   * designed behaviour rather than a fault.
   */
  const boundedEntry = (
    upstream: McpServer,
    name: string,
    rawDescription: unknown,
    rawSchema: unknown
  ): UpstreamToolDescription => {
    const description = boundedToolDescription(rawDescription);
    const schema = boundedToolInputSchema(rawSchema);
    if (!schema.ok && rawSchema !== undefined) {
      logger.log("warn", {
        event: "catalog_schema_rejected",
        server: upstream.name,
        tool: name,
        reason: schema.reason
      });
    }
    return {
      ...(description !== undefined ? { description } : {}),
      ...(schema.ok ? { inputSchema: schema.schema } : {})
    };
  };

  /**
   * Walk this upstream's pages until every wanted name is found, or a bound
   * stops it.
   *
   * Stops on the first of: nothing left to want, a page that names no next
   * cursor, `MAX_CATALOG_PAGES`, the remaining budget, or a failure. Whatever
   * was collected before the stop is kept — the thin entry is the floor, so a
   * partial walk never misdescribes anything, it only describes less.
   */
  const walk = async (
    upstream: McpServer,
    client: McpClient,
    wanted: ReadonlySet<string>,
    described: Map<string, UpstreamToolDescription>
  ): Promise<Walked> => {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      // Also the per-request timeout, so an abandoned page stops rather than
      // lingering on a socket after the race below has moved on.
      const outcome = await client.listTools(cursor, CATALOG_BUDGET_MS);
      if (outcome.outcome !== "listed") {
        unavailable(upstream, outcome.failure, {
          ...(outcome.outcome === "call_failed" && outcome.status !== undefined ? { status: outcome.status } : {}),
          described: described.size
        });
        return "partial";
      }

      for (const entry of outcome.tools) {
        // Filtered by the sheet's names *before* the cap applies. This is the
        // whole reason `wanted` is passed down rather than applied by the
        // caller: capping in the upstream's order would let a server bury a
        // permitted tool behind decoys.
        if (!wanted.has(entry.name) || described.has(entry.name)) continue;
        if (described.size >= MAX_DESCRIBED_TOOLS) {
          unavailable(upstream, "truncated", { described: described.size });
          return "partial";
        }
        described.set(entry.name, boundedEntry(upstream, entry.name, entry.description, entry.inputSchema));
      }

      if (described.size === wanted.size) return "complete";
      if (outcome.nextCursor === null) return "complete";
      cursor = outcome.nextCursor;
    }

    unavailable(upstream, "truncated", { described: described.size });
    return "partial";
  };

  /**
   * The walk, given up on after `CATALOG_BUDGET_MS`.
   *
   * **A race rather than a deadline threaded into the client, and the handshake
   * is why.** `ensureOpen`'s ladder takes no per-call timeout — it falls back to
   * `DEFAULT_UPSTREAM_TIMEOUT_MS` — so an upstream that black-holes
   * `server/discover` would hold the agent's first turn for thirty seconds
   * before a model token was spent, and no per-page timeout reaches inside it.
   * A race around the whole walk bounds the handshake and the pages together.
   *
   * The map is the caller's, so whatever the abandoned walk had already
   * collected survives the race — the walk keeps running, which is the point
   * rather than a leak: it is single-flighted inside the client, so it warms
   * that client for the next listing or the first tool call, and nothing reads
   * its result.
   */
  const walkWithin = async (
    upstream: McpServer,
    client: McpClient,
    wanted: ReadonlySet<string>,
    described: Map<string, UpstreamToolDescription>
  ): Promise<Walked> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const budget = new Promise<"partial">(resolve => {
      timer = setTimeout(() => {
        expired = true;
        resolve("partial");
      }, CATALOG_BUDGET_MS);
      // The process must not be held open by a cache's stopwatch.
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([walk(upstream, client, wanted, described), budget]);
      // Only when the timer actually fired. A walk that returned `partial` on
      // its own has already logged the reason it did, and a second line saying
      // "budget" would name the wrong cause.
      if (expired) unavailable(upstream, "budget_exhausted", { described: described.size });
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * One upstream, asked at most once at a time and at most once per TTL.
   *
   * The single flight is `ensureOpen`'s shape and buys the same thing: N
   * listings naming one upstream at the same instant cost one walk. The entry
   * is written before the promise is cleared, so the next caller sees the cache
   * rather than starting a second walk into the gap.
   */
  const describeUpstream = async (upstream: McpServer, wanted: ReadonlySet<string>): Promise<Described> => {
    const key = cacheKey(upstream, wanted);
    const hit = cached.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return hit.described;

    const inFlight = walking.get(key);
    if (inFlight !== undefined) return inFlight;

    const started = (async (): Promise<Described> => {
      const lease = options.lease(upstream);
      if (!lease.ok) {
        unavailable(upstream, lease.reason, lease.credential !== undefined ? { credential: lease.credential } : {});
        // Cached like any other failure, so a sheet naming a credential the
        // vault does not hold costs one log line per half minute rather than
        // one per listing.
        cached.set(key, { described: EMPTY, expiresAt: now() + CATALOG_FAILURE_TTL_MS });
        return EMPTY;
      }

      const described = new Map<string, UpstreamToolDescription>();
      const walked = await walkWithin(upstream, lease.client, wanted, described);
      cached.set(key, {
        described,
        expiresAt: now() + (walked === "complete" ? CATALOG_TTL_MS : CATALOG_FAILURE_TTL_MS)
      });
      return described;
    })().finally(() => {
      walking.delete(key);
    });

    walking.set(key, started);
    return started;
  };

  return {
    async describe(upstream, wanted) {
      if (wanted.length === 0) return EMPTY;
      return describeUpstream(upstream, new Set(wanted));
    },

    /**
     * Forget everything, before the pool this leases from is dismantled.
     *
     * Synchronous and called before `close()`'s first await, matching the
     * pool's rule that it hands out nothing from the instant closing begins: a
     * cache entry surviving a close would describe tools against a client that
     * no longer exists.
     */
    clear() {
      cached.clear();
      walking.clear();
    }
  };
}
