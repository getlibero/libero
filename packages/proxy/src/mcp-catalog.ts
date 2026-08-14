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
// empty answer and one log line, because the listing is not the enforcement: a
// tool with no schema is still a tool the sheet permits, and a tool the sheet
// omits is still refused at call time. The single exception is a
// `RedactionError`, which is not an upstream failure but this proxy unable to
// guarantee its own boundary — it propagates, for the reason ./http-dispatcher.ts
// rethrows one rather than converting it to a result.
//
// **One tool is withheld rather than thinned, and the argument is at
// `Publication` below.** A tool whose `x-mcp-header` annotations do not validate
// is dropped from the answer entirely instead of degrading to the sheet's own
// row (#200). That is the doctrine above narrowing in exactly one place — it
// still deauthorizes nothing, because the sheet names the tool either way and
// ./enforce.ts decides the call.
//
// **It is a cache with a clock, and the clock is not a security deadline.** An
// approval ticket deliberately shares the server's clock because a deadline is
// policy; this one only decides when to ask an upstream again, which is why it
// is an injected `now()` here and nothing more.

import type { McpServer } from "@getlibero/schema";
import {
  type CatalogAnswer,
  NO_CATALOG_ANSWER,
  type ToolCatalog,
  type UpstreamCallDefinition,
  type UpstreamToolDescription
} from "./dispatch.js";
import { createSilentLogger, type Logger } from "./log.js";
import type { McpClient } from "./mcp-client.js";
import { boundedToolDescription, boundedToolInputSchema } from "./mcp-bounds.js";
import { type XMcpHeaderDeclaration, scanXMcpHeaderDeclarations } from "./vendor/mcp-param-headers.js";
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
 *
 * That argument covers the request in flight and stops there. The *pages* after
 * it are abandoned outright, because since #159 each one costs a permit on the
 * upstream's semaphore and would spend it on an answer nobody will read — see
 * `walkWithin`.
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
 * credential the vault does not hold, and a pool that has begun closing. An
 * OAuth upstream is deliberately not a fourth: its source is built without
 * I/O and the token engine decides at the listing's first request, so a
 * grant problem surfaces as that listing's failure rather than as a lease
 * refusal this synchronous path would have to block on.
 */
export type ClientLease =
  | { readonly ok: true; readonly client: McpClient }
  | {
      readonly ok: false;
      readonly reason: "unsupported_transport" | "credential_unresolved" | "shutting_down";
      /** By name, never by value, and only where there is one to name. */
      readonly credential?: string;
    };

/**
 * The catalog, as the module that owns it sees it.
 *
 * Wider than the `ToolCatalog` seam in ./dispatch.ts, and the difference is the
 * point. The listing route closes over `ToolCatalog` — one method, which
 * describes — so that it structurally cannot feed a call. `definitionFor` does
 * feed one, so it lives out here on the concrete type, reachable only by the
 * dispatcher that already holds the pool and the vault.
 */
export interface McpCatalog extends ToolCatalog {
  /**
   * What one tool needs at call time, beyond its arguments.
   *
   * Answers from the same per-name resolutions `describe` fills, so a tool the
   * listing route already walked for costs nothing here — which is the whole
   * reason the cache was rekeyed onto the upstream. A cold cache, a dead
   * upstream or a tool that declares nothing all answer with no declarations,
   * and the call still goes out: a thin catalog has never been allowed to block
   * a permitted call.
   */
  definitionFor(upstream: McpServer, tool: string): Promise<UpstreamCallDefinition>;
  clear(): void;
}

export interface McpCatalogOptions {
  readonly lease: (upstream: McpServer) => ClientLease;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/**
 * What a walk settled about one tool: an entry to publish, or why there is none.
 *
 * **Three states rather than two, because there are two ways to end up unlisted
 * and they are not the same fact.**
 *
 * `absent` is the upstream's: the walk ran and this server does not offer the
 * tool. It has to be storable — distinctly from "not asked about yet" — or a
 * sheet naming a tool the upstream does not offer would re-walk that upstream on
 * every single listing and every single call.
 *
 * `excluded` is this proxy's, and it is the one place the degrade-to-thin
 * contract narrows (#200). The specification's answer to a tool whose
 * `x-mcp-header` annotations fail validation is that the client MUST leave it
 * out of the listing, and that is also the better behaviour independently:
 * the proxy cannot derive the headers for such a tool, so a thin entry is a tool
 * the model can see, will call, and whose every call an upstream that requires
 * them refuses at the far end — `-32020` on GitHub. The model then retries and
 * burns the channel's turns against a cap, for a reason nothing it can read
 * names. Showing the model a tool that cannot work is worse than not showing it.
 *
 * **Excluding is safe under the doctrine it narrows**, and that is why this is a
 * departure in mechanism rather than in the property the doctrine protects.
 * Dropping the entry removes the tool from the model's context and deauthorizes
 * nothing: the sheet still names it, and a call the model somehow makes anyway
 * is still decided by ./enforce.ts from the sheet. Nothing else that goes wrong
 * with a listing gets this treatment — a dead, slow, ambiguous or credential-less
 * upstream still costs the model a description and never the channel a
 * permission.
 *
 * The two unlisted states are stored apart and logged apart because an operator
 * chasing a tool that is not in a listing needs to know which end to look at.
 */
type Publication =
  | { readonly state: "published"; readonly description: UpstreamToolDescription }
  | { readonly state: "absent" }
  | { readonly state: "excluded" };

/** The two `Publication`s with no per-tool payload, so neither is rebuilt per name. */
const ABSENT: Publication = Object.freeze({ state: "absent" });
const EXCLUDED: Publication = Object.freeze({ state: "excluded" });

/**
 * What is known about one tool on one upstream, and until when.
 *
 * Freshness is per name because a walk is per name: a tool found by a complete
 * walk is good for `CATALOG_TTL_MS`, and one touched by a partial walk — a
 * failure, a cap, the budget — for `CATALOG_FAILURE_TTL_MS`, so a dead upstream
 * costs one attempt per half minute rather than pretending its tools are gone.
 */
interface Resolution {
  readonly publication: Publication;
  /**
   * The tool's `x-mcp-header` declarations, scanned from the schema the upstream
   * actually sent.
   *
   * **From the raw schema, before `boundedToolInputSchema` has had it**, and
   * that is a correctness requirement rather than an ordering preference. The
   * bounding rules exist to decide what may enter a *model's context*: a schema
   * over `MAX_TOOL_SCHEMA_BYTES`, or one whose `type` is not `object`, is
   * dropped and the tool published thin. None of that has any bearing on which
   * arguments a server wants mirrored into request headers — and reading the
   * declarations off the published schema would mean a tool whose schema was too
   * large to show the model silently lost its headers and had every call to it
   * refused `-32020` at the far end, for a reason nothing in the log would name.
   */
  readonly paramDeclarations: readonly XMcpHeaderDeclaration[];
  readonly expiresAt: number;
}

/** Everything known about one upstream's catalog, by tool name. */
interface CacheEntry {
  readonly resolved: Map<string, Resolution>;
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

/** A walk that never happened, for the lease that never opened. */
const NOTHING_WALKED: ReadonlyMap<string, Walked_Entry> = new Map();

/** What one walk learned about one tool: the two views, kept apart. */
interface Walked_Entry {
  readonly publication: Publication;
  readonly paramDeclarations: readonly XMcpHeaderDeclaration[];
}

/**
 * The single-flight key: the upstream, and the names this walk is going after.
 *
 * Not the *cache* key — that is `upstreamKey` alone, and the difference is the
 * point of #188's restructure. The cache used to be keyed by (upstream, exact
 * wanted set), which made it a cache of *answers to one question* rather than of
 * the upstream's catalog. That was right while the only caller was the listing
 * route, which always asks the same question for a given sheet; it is wrong the
 * moment the *call* path wants one tool, because a one-name question is a
 * different key and so a guaranteed miss — a full five-page walk under a five
 * second budget, per call, against an upstream that was walked seconds ago.
 *
 * Keying on the upstream and storing per-name facts fixes that without giving up
 * what the old key protected. The hazard it named — "two channels whose sheets
 * name the same server with different tool lists would read each other's
 * answer" — was really about sharing a *conclusion* drawn under someone else's
 * question. Per-name resolutions cannot disagree: a catalog is the server's,
 * identical for every channel that can reach it, and `upstreamKey` already
 * separates credentials. Each channel still gets exactly the names it asked
 * about; they merely stop paying for facts another channel already established.
 *
 * Sorted, so two callers chasing the same missing names collapse to one walk.
 */
function walkKey(upstream: McpServer, missing: ReadonlySet<string>): string {
  return JSON.stringify([upstreamKey(upstream), [...missing].sort()]);
}

export function createMcpCatalog(options: McpCatalogOptions): McpCatalog {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const cached = new Map<string, CacheEntry>();
  // Resolves when the walk has merged, not with an answer: every caller
  // assembles its own from `wanted`, which two callers sharing a walk do not
  // agree on.
  const walking = new Map<string, Promise<void>>();

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
   * `mcp-bounds.ts` argues. A rejected schema is logged with its reason
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
   * cursor, `MAX_CATALOG_PAGES`, the remaining budget, a failure, or
   * `abandoned` — the race in `walkWithin` having been lost. Whatever was
   * collected before the stop is kept — the thin entry is the floor, so a
   * partial walk never misdescribes anything, it only describes less.
   *
   * **`budget` rather than `MAX_DESCRIBED_TOOLS` directly, and that is what
   * makes a merged cache safe.** The cap bounds what enters a model's context,
   * and definitions are re-sent every turn — so it has to hold across the
   * *answer*, not across one walk. Once resolutions merge, a caller asking for
   * sixty names and then for a hundred and sixty would otherwise get sixty
   * remembered plus a hundred freshly walked. The caller subtracts what it is
   * already carrying and this stops there.
   */
  const walk = async (
    upstream: McpServer,
    client: McpClient,
    wanted: ReadonlySet<string>,
    described: Map<string, Walked_Entry>,
    budget: number,
    abandoned: () => boolean
  ): Promise<Walked> => {
    let cursor: string | undefined;
    // What this walk has added to the *answer*, which an excluded tool does not
    // join. `described.size` counted them together until #200 and is no longer
    // the same number.
    let publishable = 0;

    if (budget <= 0) {
      unavailable(upstream, "truncated", { described: 0 });
      return "partial";
    }

    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      // The race below has been lost, so this walk is warming a client rather
      // than answering anyone, and since #159 every further page would queue for
      // a permit against the calls that are (#252). The page already in flight
      // is the one worth finishing — see `walkWithin`. Page zero cannot see this
      // set: the timer is armed and the walk entered in the same tick.
      //
      // What this returns is discarded, because the race settled when the flag
      // was set. It is `partial` regardless, and `walkWithin` has already logged
      // `budget_exhausted` as the cause.
      if (abandoned()) return "partial";

      // Also the per-request timeout — the second of the two things bounding an
      // abandoned page, so the one still in flight when the race ends stops
      // rather than lingering on a socket.
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

        // The raw schema, deliberately — see `Resolution.paramDeclarations`.
        const annotations = declarationsIn(entry.inputSchema);
        if (!annotations.ok) {
          // Not counted against `budget`: nothing about this tool enters the
          // model's context, so charging it to a cap on what does would let a
          // hostile upstream shrink a listing with schemas it knew were
          // invalid. It is still *resolved*, so the walk stops going after it.
          logger.log("warn", {
            event: "catalog_tool_excluded",
            server: upstream.name,
            tool: entry.name,
            reason: "invalid_annotations"
          });
          described.set(entry.name, { publication: EXCLUDED, paramDeclarations: [] });
          continue;
        }

        if (publishable >= budget) {
          unavailable(upstream, "truncated", { described: publishable });
          return "partial";
        }
        described.set(entry.name, {
          publication: {
            state: "published",
            description: boundedEntry(upstream, entry.name, entry.description, entry.inputSchema)
          },
          paramDeclarations: annotations.declarations
        });
        publishable += 1;
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
   * collected survives the race.
   *
   * **The abandoned walk finishes the page it is on and asks for no more**
   * (#252). Letting it run to `MAX_CATALOG_PAGES` used to be free, and the
   * argument for it was that a walk which finishes late still warms the client
   * for the next listing or the first tool call. #159 made a page cost a permit
   * on the upstream's semaphore, so those four further pages became four more
   * queue entries — each waiting up to `LISTING_QUEUE_WAIT_MS` and then holding
   * a permit — competing with live calls for a result nobody would read. The
   * warming survives the narrowing because it is not spread across the walk:
   * `ensureOpen`'s ladder runs inside the first page and is cached for the
   * client's life, so the request already in flight is where essentially all of
   * it is. What that leaves is one permit held at most `CATALOG_BUDGET_MS` past
   * the deadline, by the one request that is doing the useful thing.
   */
  const walkWithin = async (
    upstream: McpServer,
    client: McpClient,
    wanted: ReadonlySet<string>,
    described: Map<string, Walked_Entry>,
    allowance: number
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
      const outcome = await Promise.race([
        walk(upstream, client, wanted, described, allowance, () => expired),
        budget
      ]);
      // Only when the timer actually fired. A walk that returned `partial` on
      // its own has already logged the reason it did, and a second line saying
      // "budget" would name the wrong cause.
      if (expired) unavailable(upstream, "budget_exhausted", { described: described.size });
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  };

  /** This upstream's entry, created empty on first sight. */
  const entryFor = (upstream: McpServer): CacheEntry => {
    const key = upstreamKey(upstream);
    const existing = cached.get(key);
    if (existing !== undefined) return existing;
    const fresh: CacheEntry = { resolved: new Map<string, Resolution>() };
    cached.set(key, fresh);
    return fresh;
  };

  /**
   * A tool's `x-mcp-header` declarations, or the news that it has no valid set.
   *
   * An upstream that declares nothing gets no headers — which is also the safe
   * answer under SEP-2243, whose intermediary note says infrastructure on an
   * older negotiated revision SHOULD reject a request carrying header values it
   * cannot validate. Headers go only to a server that asked for them in its own
   * schema.
   *
   * `ok: false` is the codec's verdict that the *tool definition* is invalid —
   * an annotation that is empty, not an RFC 9110 token, on a non-primitive type,
   * not case-insensitively unique, or placed somewhere the chain of `properties`
   * keys cannot statically reach. The spec's answer to that is exclusion, and
   * `Publication` above is where the caller acts on it.
   *
   * **The scan is guarded, because it runs on the raw schema.** The vendored
   * `visit` recurses per nesting level with no depth bound, and this is the one
   * consumer that feeds it bytes nothing has bounded yet — deliberately, since
   * reading declarations off the *published* schema would silently strip a
   * large tool's headers (see `boundedEntry`). Tens of thousands of levels fit
   * inside the response bound, and the resulting `RangeError` is neither a
   * `RedactionError` nor an `McpListOutcome`: unguarded, it would escape the
   * degrade-to-thin contract and turn one hostile upstream into a 500 for the
   * channel's whole listing.
   *
   * **A schema the scan cannot survive declares nothing, and is published thin
   * rather than excluded.** Those two used to be one case and #200 separated
   * them, so the difference is worth stating: `ok: false` is a determinate fact
   * about the schema — the codec walked it and found a violated MUST — while a
   * throw establishes nothing at all, not even that an annotation is present. A
   * tool excluded on the strength of a scan that did not finish would be a
   * working tool taken away from the model for a schema shape, and the doctrine
   * this file narrows in exactly one place says lean lenient without a
   * determinate reason to narrow. It is the safe answer for the call path
   * either way, because both send no headers.
   */
  const declarationsIn = (
    rawSchema: unknown
  ): { readonly ok: true; readonly declarations: readonly XMcpHeaderDeclaration[] } | { readonly ok: false } => {
    try {
      const scan = scanXMcpHeaderDeclarations(rawSchema);
      return scan.valid ? { ok: true, declarations: scan.declarations } : { ok: false };
    } catch {
      return { ok: true, declarations: [] };
    }
  };

  /**
   * The answer, assembled from what is settled. Wanted order, published only.
   *
   * **The cap is applied here as well as in the walk, and here is the one that
   * holds.** The walk's budget bounds what one question adds, but resolutions
   * merge across questions — a listing that walked a hundred and a call path
   * that walked fifty more leave the entry holding both, so the next wide ask
   * finds everything fresh and walks nothing. Every path returns through this
   * function, which is what makes it the place the answer's bound is a
   * property rather than an accounting hope. Wanted order is the sheet's
   * order, so what survives the cut is the operator's priority, not the
   * upstream's.
   */
  const assemble = (upstream: McpServer, entry: CacheEntry, wanted: ReadonlySet<string>): CatalogAnswer => {
    const described = new Map<string, UpstreamToolDescription>();
    const excluded = new Set<string>();
    // The cap stops the loop *describing*, not the loop. It bounds what enters
    // the model's context, and withholding a tool is the opposite of that — so
    // an answer truncated by the cap still carries every exclusion it settled,
    // or the caller would list the sheet's thin row for one of them. One line
    // afterwards rather than a `break`, so the reason is still reported once.
    let truncated = false;
    for (const name of wanted) {
      const publication = entry.resolved.get(name)?.publication;
      if (publication === undefined || publication.state === "absent") continue;
      if (publication.state === "excluded") {
        excluded.add(name);
        continue;
      }
      if (described.size >= MAX_DESCRIBED_TOOLS) {
        truncated = true;
        continue;
      }
      described.set(name, publication.description);
    }
    if (truncated) unavailable(upstream, "truncated", { described: described.size });
    return { described, excluded };
  };

  /**
   * Write what a walk established, including what it established was absent.
   *
   * Every name the walk went after gets a resolution, so a second ask does not
   * re-walk for a tool this upstream does not offer. A partial walk's findings
   * land on the short window for the reason `CATALOG_FAILURE_TTL_MS` exists: it
   * did not finish, so "absent" is provisional and worth re-asking soon.
   */
  const merge = (
    entry: CacheEntry,
    missing: ReadonlySet<string>,
    described: ReadonlyMap<string, Walked_Entry>,
    walked: Walked
  ): void => {
    const expiresAt = now() + (walked === "complete" ? CATALOG_TTL_MS : CATALOG_FAILURE_TTL_MS);
    for (const name of missing) {
      const found = described.get(name);
      entry.resolved.set(name, {
        publication: found?.publication ?? ABSENT,
        paramDeclarations: found?.paramDeclarations ?? [],
        expiresAt
      });
    }
  };

  /**
   * One upstream, asked only about what it has not already answered for.
   *
   * The single flight is `ensureOpen`'s shape and buys the same thing: N
   * listings naming one upstream at the same instant cost one walk. It is keyed
   * on the *missing* names rather than the wanted ones, so two callers chasing
   * the same gap still collapse, and a caller whose gap is already being filled
   * by a wider walk simply walks its own — correct, and rarer than the case that
   * matters, which is the listing route and the call path asking in turn.
   */
  const describeUpstream = async (upstream: McpServer, wanted: ReadonlySet<string>): Promise<CatalogAnswer> => {
    const entry = entryFor(upstream);
    const at = now();

    const missing = new Set<string>();
    let carried = 0;
    for (const name of wanted) {
      const resolution = entry.resolved.get(name);
      if (resolution === undefined || resolution.expiresAt <= at) {
        missing.add(name);
        continue;
      }
      // What the answer is already carrying against the cap, which an excluded
      // tool does not join — it is withheld from the model rather than shown to
      // it, so it spends none of the budget for what the model is shown.
      if (resolution.publication.state === "published") carried += 1;
    }

    // The whole point of the restructure: a tool the listing route already
    // walked for costs the call path nothing — no lease, no request, no log.
    if (missing.size === 0) return assemble(upstream, entry, wanted);

    const key = walkKey(upstream, missing);
    const inFlight = walking.get(key);
    if (inFlight !== undefined) {
      await inFlight;
      return assemble(upstream, entry, wanted);
    }

    const started = (async (): Promise<void> => {
      const lease = options.lease(upstream);
      if (!lease.ok) {
        unavailable(upstream, lease.reason, lease.credential !== undefined ? { credential: lease.credential } : {});
        // Recorded like any other failure, so a sheet naming a credential the
        // vault does not hold costs one log line per half minute rather than
        // one per listing.
        merge(entry, missing, NOTHING_WALKED, "partial");
        return;
      }

      const described = new Map<string, Walked_Entry>();
      // What this answer may still spend of the cap. Names already carried are
      // in the answer whether or not the walk adds anything, so they count.
      const walked = await walkWithin(upstream, lease.client, missing, described, MAX_DESCRIBED_TOOLS - carried);
      merge(entry, missing, described, walked);
    })().finally(() => {
      walking.delete(key);
    });

    walking.set(key, started);
    await started;
    return assemble(upstream, entry, wanted);
  };

  return {
    async definitionFor(upstream, tool) {
      // Through `describe` rather than beside it, so the freshness rules, the
      // single flight and the budget are the ones already argued rather than a
      // second copy that drifts.
      await describeUpstream(upstream, new Set([tool]));
      const resolution = cached.get(upstreamKey(upstream))?.resolved.get(tool);
      // An excluded tool answers here exactly as an unwalked one does — no
      // declarations — and the call still goes out. #200 changed what the model
      // is shown and deliberately nothing on this path: a thin catalog has never
      // been allowed to block a permitted call, the sheet still names the tool,
      // and ./enforce.ts is what decides it.
      return { paramDeclarations: resolution?.paramDeclarations ?? [] };
    },

    async describe(upstream, wanted) {
      if (wanted.length === 0) return NO_CATALOG_ANSWER;
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
