import { type McpServer, TeamSheet as TeamSheetSchema } from "@getlibero/schema";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import type { McpClient, McpOutcome } from "./mcp-client.js";
import { CATALOG_BUDGET_MS, CATALOG_TTL_MS } from "./mcp-catalog.js";
import {
  IDLE_TTL_MS,
  LISTING_QUEUE_WAIT_MS,
  QUEUE_WAIT_MS,
  type HttpUpstream,
  createMcpPool
} from "./mcp-pool.js";
import { constantCredential } from "./outbound.js";
import type { Secret } from "./vault.js";
import type { CallLimits } from "./enforce.js";
import type { UpstreamCallDefinition } from "./dispatch.js";

/**
 * The channel's bound on a result, which every `callTool` now carries.
 *
 * Roomy on purpose: these cases are about the protocol and the transport, not
 * about truncation. The bound's own behaviour is mcp-bounds.test.ts's.
 */
const LIMITS: CallLimits = { maxResultChars: 100_000 };

/** No `x-mcp-header` declarations. These cases are not about header mirroring. */
const NO_HEADERS: UpstreamCallDefinition = { paramDeclarations: [] };

/**
 * A credential long enough to be one.
 *
 * **Not a one-character stand-in, and that is not fussiness.** `redactSecrets`
 * replaces every occurrence of the value in a response, so a needle of `"v"`
 * rewrites the `v` inside `supportedVersions` in the upstream's own handshake —
 * which used to be invisible only because the hand-rolled client's replies
 * happened to contain no `v`. A fixture that quietly corrupts the bytes under
 * test is a fixture that will one day fail for a reason nobody can find.
 */
const VALUE = "ghp_live_token_do_not_log";

/** The vault's form of a source: one value, nothing to refresh. */
const bearer = (secret: Secret | undefined) => constantCredential("bearer", secret);

function secretOf(value: string): Secret {
  return Object.freeze({
    reveal: () => value,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]"
  }) as Secret;
}

/** Parsed through the real schema, so no test asserts against a block a sheet could not hold. */
function upstreamOf(block: Record<string, unknown>): HttpUpstream {
  const sheet = TeamSheetSchema.parse({
    // Pinned because every sheet must be (#79); nothing in the pool reads it.
    channel: { name: "engineering", certificate_sha256: ["AB".repeat(32)] },
    mcp_server: [{ tool: [{ name: "list_prs" }], ...block }]
  });
  const parsed: McpServer | undefined = sheet.mcp_server[0];
  if (parsed === undefined || parsed.transport !== "http") throw new Error("fixture is not an http upstream");
  return parsed;
}

/**
 * Polls rather than sleeps, per the convention in team-sheet-store.test.ts.
 *
 * Module-scoped because idle eviction needs it too: a swept client's `close()`
 * is deliberately unawaited, so its session `DELETE` lands a moment after the
 * `acquire` that caused it.
 */
async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let fake: FakeMcpServer | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("one client per upstream", () => {
  // The pool's whole reason to exist, and the case `decide` cannot reach: two
  // sheets naming one destination and one credential under different server
  // names. They already share the credential, which is the identity the
  // upstream sees.
  it("shares a client between blocks that differ only in name and tools", async () => {
    fake = await startFakeMcpServer();
    const pool = createMcpPool({});

    const a = pool.acquire(
      upstreamOf({ name: "github", transport: "http", url: fake.url, credential: "c" }),
      bearer(secretOf(VALUE))
    );
    const b = pool.acquire(
      upstreamOf({ name: "gh", transport: "http", url: fake.url, credential: "c", tool: [{ name: "get_issue" }] }),
      bearer(secretOf(VALUE))
    );

    expect(a).toBe(b);
    expect(pool.size).toBe(1);

    await a?.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    await b?.callTool("get_issue", {}, LIMITS, NO_HEADERS);
    expect(fake.callsTo("server/discover")).toHaveLength(1);
  });

  each([
    [
      "a differing url",
      { name: "github", transport: "http", url: "http://a:3001", credential: "c" },
      { name: "github", transport: "http", url: "http://b:3001", credential: "c" }
    ],
    [
      "a differing credential",
      { name: "github", transport: "http", url: "http://a:3001", credential: "cred_a" },
      { name: "github", transport: "http", url: "http://a:3001", credential: "cred_b" }
    ],
    [
      "one credential and none",
      { name: "github", transport: "http", url: "http://a:3001", credential: "cred_a" },
      { name: "github", transport: "http", url: "http://a:3001" }
    ]
  ])("never shares a client across %s", (_label, left, right) => {
    const pool = createMcpPool({});

    const a = pool.acquire(upstreamOf(left), bearer(secretOf(VALUE)));
    const b = pool.acquire(upstreamOf(right), bearer(secretOf(VALUE)));

    expect(a).not.toBe(b);
    expect(pool.size).toBe(2);
  });

  it("creates nothing until a call needs it", () => {
    const pool = createMcpPool({});
    expect(pool.size).toBe(0);
  });
});

describe("closing", () => {
  // A call arriving during teardown is answered rather than served over a
  // connection the process is dismantling. Asserted *without* awaiting, on
  // purpose: the refusal has to hold from the instant `close()` is entered
  // rather than from when its session terminations resolve.
  it("hands out nothing afterwards", async () => {
    const pool = createMcpPool({});
    const upstream = upstreamOf({ name: "github", transport: "http", url: "http://a:3001" });

    expect(pool.acquire(upstream, bearer(undefined))).not.toBeNull();
    const closing = pool.close();

    expect(pool.acquire(upstream, bearer(undefined))).toBeNull();
    expect(pool.size).toBe(0);
    await closing;
  });

  it("is safe to call twice", async () => {
    const pool = createMcpPool({});
    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it("sends one DELETE per client, carrying that client's own session", async () => {
    const first = await startFakeMcpServer({ protocol: "legacy" });
    const second = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ timeoutMs: 2000 });
      for (const server of [first, second]) {
        const client = pool.acquire(
          upstreamOf({ name: "s", transport: "http", url: server.url, credential: "c" }),
          bearer(secretOf(VALUE))
        );
        expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });
      }

      await pool.close();

      for (const server of [first, second]) {
        const deletes = server.received.filter(request => request.method === "DELETE");
        expect(deletes).toHaveLength(1);
        // Its own session, not the other fake's — both issue `session-1`, so
        // the claim that matters is that the id was live here and is now gone.
        expect(deletes[0]?.headers["mcp-session-id"]).toBe("session-1");
        expect(deletes[0]?.authorization).toBe(`Bearer ${VALUE}`);
        expect(server.liveSessions.size).toBe(0);
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("sends nothing for a client with no session to end", async () => {
    const stateless = await startFakeMcpServer();
    const sessionless = await startFakeMcpServer({ protocol: "legacy", sessions: false });
    try {
      const pool = createMcpPool({ timeoutMs: 2000 });
      for (const server of [stateless, sessionless]) {
        const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), bearer(undefined));
        expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });
      }

      await pool.close();

      for (const server of [stateless, sessionless]) {
        expect(server.received.filter(request => request.method === "DELETE")).toHaveLength(0);
      }
    } finally {
      await stateless.close();
      await sessionless.close();
    }
  });

  // The termination is a courtesy the spec asks for, not a correctness
  // requirement — a server expires a session it stops hearing from. So an
  // upstream that has gone away must not turn shutdown into a rejection.
  it("resolves when the upstream has gone away", async () => {
    const server = await startFakeMcpServer({ protocol: "legacy" });
    const pool = createMcpPool({ timeoutMs: 2000 });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), bearer(undefined));
    expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });

    await server.close();

    await expect(pool.close()).resolves.toBeUndefined();
  });

  // The budget exists because this runs inside a signal handler: an upstream
  // that accepts the connection and never answers must not hold shutdown past
  // the orchestrator's grace period.
  it("resolves within its own budget against an upstream that never answers", async () => {
    const server = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ timeoutMs: 2000 });
      const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), bearer(undefined));
      expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });

      server.respond = request => (request.method === "DELETE" ? { hang: true } : null);
      const started = Date.now();
      await pool.close();

      // Generous against the 2s cap, because the claim is "bounded", not "fast"
      // — and the repo has no fake clock to make it exact.
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      await server.close();
    }
  });
});

/**
 * The permit gate (#159).
 *
 * Every case here is built on `hangOn`, so saturation is a fact rather than a
 * race: the calls holding permits are ones the fake has recorded and will never
 * answer, and the calls waiting for permits give up after `BRIEF` and say so.
 * Nothing asserts on elapsed time, and there is no clock to fake.
 *
 * The fake can hold a request open but cannot release one, so the other half —
 * a released permit reaching the next caller — is proved in semaphore.test.ts
 * where a permit can be handed back by hand.
 */
describe("the concurrency limit", () => {
  /** Long enough that reaching it would mean the assertion after it is already wrong. */
  const PATIENT = 30_000;

  /** Short enough to spend, for the callers meant to give up. */
  const BRIEF = 25;

  /**
   * `count` concurrent calls at one upstream, collecting outcomes as they land.
   *
   * The returned promises are not all awaitable: the ones that win permits hang
   * at the fake by construction. `settled` is what a case asserts against, and
   * `drain` is how the test ends without leaving a request in flight.
   */
  function fire(client: McpClient, count: number) {
    const settled: McpOutcome[] = [];
    const calls = Array.from({ length: count }, (_unused, index) =>
      client.callTool(`tool_${String(index)}`, {}, LIMITS, NO_HEADERS).then(outcome => {
        settled.push(outcome);
        return outcome;
      })
    );
    return { settled, drain: () => Promise.allSettled(calls) };
  }

  it("sends no more than the limit to one upstream at once", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const pool = createMcpPool({ maxUpstreamConcurrency: 2, queueWaitMs: BRIEF });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    if (client === null) throw new Error("the pool handed out nothing");

    const { settled, drain } = fire(client, 4);
    // **Both waits, and the first one is not decoration.** The losers give up
    // on a timer of their own, which is causally independent of the winners
    // getting through the handshake and onto the wire — so asserting the
    // upstream's count off the losers alone asserts it at an arbitrary moment
    // in the winners' progress. It passed on a fast machine and failed on a
    // loaded runner with one call landed instead of two.
    // `>=` rather than `===`: this wait establishes that the winners have
    // landed, and the assertion below is what says no more than the limit did.
    // Pinned to the exact number here, a build that let all four through would
    // race past it and fail on the wrong line.
    await until(() => (fake?.callsTo("tools/call").length ?? 0) >= 2, "the upstream to be saturated");
    await until(() => settled.length === 2, "the two queued calls to give up");

    // The two that never got a permit, and the upstream never heard of them.
    expect(settled).toHaveLength(2);
    for (const outcome of settled) {
      expect(outcome).toEqual({ outcome: "connect_failed", failure: "busy" });
    }
    // Still two, now that the other two have demonstrably finished failing:
    // the claim is that a refused permit sends nothing, and a broken gate would
    // read four here — or hang all four and never satisfy the wait above.
    expect(fake.callsTo("tools/call")).toHaveLength(2);

    // Closing the fake is what lets the two held calls settle; without it they
    // wait out the client's own timeout and this file leaks a request.
    await pool.close();
    await fake.close();
    fake = undefined;
    await drain();
  });

  // **The positive control, and it is load-bearing.** The case above also passes
  // on a build where the calls were never made at all — an upstream that saw two
  // `tools/call`s and an upstream that saw two because the other two were
  // dropped on the floor look identical from the count alone. This is the run
  // that proves the fixture can deliver four.
  it("sends all of them when the limit is not reached", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const pool = createMcpPool({ maxUpstreamConcurrency: 4, queueWaitMs: BRIEF });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    if (client === null) throw new Error("the pool handed out nothing");

    const { settled, drain } = fire(client, 4);
    await until(() => fake?.callsTo("tools/call").length === 4, "all four calls to reach the upstream");

    // Nobody waited, so nobody gave up.
    expect(settled).toHaveLength(0);

    await pool.close();
    await fake.close();
    fake = undefined;
    await drain();
  });

  // The bucket is `upstreamKey`, so one saturated upstream is one saturated
  // upstream — not a proxy that has stopped calling anything.
  it("counts each upstream separately", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const other = await startFakeMcpServer();
    try {
      const pool = createMcpPool({ maxUpstreamConcurrency: 1, queueWaitMs: BRIEF });
      const saturated = pool.acquire(upstreamOf({ name: "a", transport: "http", url: fake.url }), bearer(undefined));
      const free = pool.acquire(upstreamOf({ name: "b", transport: "http", url: other.url }), bearer(undefined));
      if (saturated === null || free === null) throw new Error("the pool handed out nothing");

      const held = fire(saturated, 1);
      await until(() => fake?.callsTo("tools/call").length === 1, "the first upstream to be saturated");

      // The second upstream's permit was never contended for.
      expect(await free.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });
      // And the first is still saturated, so this is not a limit that lapsed.
      expect(await saturated.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
        outcome: "connect_failed",
        failure: "busy"
      });

      await pool.close();
      await fake.close();
      fake = undefined;
      await held.drain();
    } finally {
      await other.close();
    }
  });

  // **The invariant `LISTING_QUEUE_WAIT_MS` exists to keep**, asserted rather
  // than left to a comment. A listing waits inside the catalog's own race, so a
  // wait at or above that budget means a queued walk can never win: the permit
  // arrives after the catalog has already answered `partial`, which caches empty
  // `paramDeclarations` for thirty seconds and sends every call to a SEP-2243
  // upstream without its `Mcp-Param-*` headers.
  it("gives a listing less time than the catalog will wait for the whole walk", () => {
    expect(LISTING_QUEUE_WAIT_MS).toBeLessThan(CATALOG_BUDGET_MS);
    // And less than a call's, because a thin catalog costs accuracy while a
    // refused call costs the call.
    expect(LISTING_QUEUE_WAIT_MS).toBeLessThan(QUEUE_WAIT_MS);
  });

  // The same ordering as behaviour, and through the test override, so the
  // relationship survives a `queueWaitMs` that shortens both.
  it("lets a listing give up while a call is still waiting", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const pool = createMcpPool({ maxUpstreamConcurrency: 1, queueWaitMs: 1000 });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    if (client === null) throw new Error("the pool handed out nothing");

    const held = fire(client, 1);
    await until(() => fake?.callsTo("tools/call").length === 1, "the upstream to be saturated");

    let calling = false;
    const call = client.callTool("list_prs", {}, LIMITS, NO_HEADERS).then(outcome => {
      calling = true;
      return outcome;
    });

    // The listing gives up first, and the call is demonstrably still queued when
    // it does — which is the ordering, stated without measuring either one.
    expect(await client.listTools(undefined, undefined)).toEqual({ outcome: "connect_failed", failure: "busy" });
    expect(calling).toBe(false);
    expect(await call).toEqual({ outcome: "connect_failed", failure: "busy" });

    await pool.close();
    await fake.close();
    fake = undefined;
    await held.drain();
  });

  // Shutdown must not strand a caller waiting for a permit that is never coming.
  // It is woken, meets a client that has already flipped closed, and gets the
  // sentence that belongs to shutting down rather than the one about saturation.
  it("wakes a queued call when the pool closes", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const pool = createMcpPool({ maxUpstreamConcurrency: 1, queueWaitMs: PATIENT });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    if (client === null) throw new Error("the pool handed out nothing");

    const held = fire(client, 1);
    await until(() => fake?.callsTo("tools/call").length === 1, "the upstream to be saturated");
    const queued = client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    await pool.close();

    // `closed`, not `busy`. The permit was never the reason this call failed.
    expect(await queued).toEqual({ outcome: "connect_failed", failure: "closed" });

    await fake.close();
    fake = undefined;
    await held.drain();
  });
});

/**
 * Idle eviction (#158).
 *
 * The one part of this file with a clock it controls. `now` is injected, so
 * every case moves time by assignment and none of them sleeps — which is what
 * lets a fifteen-minute window be tested at all.
 *
 * Sweeping happens on `acquire` and nowhere else, so most cases here are shaped
 * the same way: use an upstream, move the clock past the window, then acquire
 * *something* to give the pool its chance to collect.
 */
describe("idle eviction", () => {
  let clock = 1_000_000;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  /** A second upstream, whose only job is to be the `acquire` that triggers a sweep. */
  const OTHER = { name: "other", transport: "http", url: "http://elsewhere:3001" };

  // The case the issue was really about: the entry holds an `Mcp-Session-Id`,
  // which is state at somebody else's server, and before this it was released
  // only at shutdown. Asserted on the `DELETE` rather than on `size`, because
  // dropping the map entry while leaving the session open would satisfy the
  // count and none of the point.
  it("ends the session of a client nothing has used for the window", async () => {
    const server = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ timeoutMs: 2000, now });
      const client = pool.acquire(
        upstreamOf({ name: "s", transport: "http", url: server.url, credential: "c" }),
        bearer(secretOf(VALUE))
      );
      expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });
      expect(server.liveSessions.size).toBe(1);

      clock += IDLE_TTL_MS;
      pool.acquire(upstreamOf(OTHER), bearer(undefined));

      expect(pool.size).toBe(1);
      // The close is unawaited by design, so the courtesy lands just after.
      await until(() => server.liveSessions.size === 0, "the idle session to be terminated");
      expect(server.received.filter(request => request.method === "DELETE")).toHaveLength(1);

      await pool.close();
    } finally {
      await server.close();
    }
  });

  // The motivating case, and the one no per-key check would reach: the operator
  // renames the credential, so the sheet now yields a different `upstreamKey`
  // and the old entry is never acquired again. It is not idle in the ordinary
  // sense — nothing will ever ask for it — which is why the sweep walks the
  // whole map rather than only the key in hand.
  it("collects an entry whose key no sheet names any more", async () => {
    const server = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ timeoutMs: 2000, now });
      const before = pool.acquire(
        upstreamOf({ name: "s", transport: "http", url: server.url, credential: "cred_a" }),
        bearer(secretOf(VALUE))
      );
      expect(await before?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });

      clock += IDLE_TTL_MS;
      // The same server under the sheet's new credential name: a new key, and
      // the old one now unreachable.
      const after = pool.acquire(
        upstreamOf({ name: "s", transport: "http", url: server.url, credential: "cred_b" }),
        bearer(secretOf(VALUE))
      );

      expect(after).not.toBe(before);
      expect(pool.size).toBe(1);
      await until(() => server.received.filter(r => r.method === "DELETE").length === 1, "the stranded session to end");

      await pool.close();
    } finally {
      await server.close();
    }
  });

  // Handing a client out is use, before any call is made with it. The catalog
  // leases one across a multi-page walk and the dispatcher across its own
  // guards, so an entry whose caller is merely between requests must survive.
  it("never evicts the entry being acquired, however long it has been quiet", async () => {
    fake = await startFakeMcpServer();
    const pool = createMcpPool({ now });
    const upstream = upstreamOf({ name: "s", transport: "http", url: fake.url });

    const first = pool.acquire(upstream, bearer(undefined));
    expect(await first?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });

    clock += IDLE_TTL_MS * 10;
    const second = pool.acquire(upstream, bearer(undefined));

    expect(second).toBe(first);
    expect(pool.size).toBe(1);
    // The claim behind the exclusion: no rebuild means no second ladder. An
    // upstream called once an hour would otherwise re-probe on every call.
    expect(fake.callsTo("server/discover")).toHaveLength(1);

    await pool.close();
  });

  // `inFlight` counts a queued caller as well as a speaking one, so an upstream
  // saturated enough to be turning calls away is the last thing evicted rather
  // than the first. The hanging call here holds the only permit.
  it("keeps a client with a call still in flight", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const pool = createMcpPool({ maxUpstreamConcurrency: 1, queueWaitMs: 30_000, now });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    if (client === null) throw new Error("the pool handed out nothing");

    const held = client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    await until(() => fake?.callsTo("tools/call").length === 1, "the call to reach the upstream");
    const queued = client.callTool("get_issue", {}, LIMITS, NO_HEADERS);

    clock += IDLE_TTL_MS * 10;
    pool.acquire(upstreamOf(OTHER), bearer(undefined));

    // Both the speaking call and the one queued behind it kept it alive.
    expect(pool.size).toBe(2);

    await pool.close();
    await fake.close();
    fake = undefined;
    await Promise.allSettled([held, queued]);
  });

  // The documented limit of sweeping lazily, pinned so it is a decision rather
  // than a surprise: nothing collects a proxy nobody is calling. `close()` ends
  // those sessions instead, which is why this is the case worth the least.
  it("collects nothing while the pool is quiet", async () => {
    fake = await startFakeMcpServer();
    const pool = createMcpPool({ now });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    expect(await client?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });

    clock += IDLE_TTL_MS * 100;

    expect(pool.size).toBe(1);
    await pool.close();
  });

  // A lease outliving its entry is possible — the catalog holds one across a
  // walk — so the stale reference has to degrade to a refusal rather than to a
  // request over a torn-down transport. It does, because `gate` closes over a
  // client that has already flipped `closed`.
  it("refuses a caller holding a client that was swept", async () => {
    fake = await startFakeMcpServer();
    const pool = createMcpPool({ now });
    const stale = pool.acquire(upstreamOf({ name: "s", transport: "http", url: fake.url }), bearer(undefined));
    expect(await stale?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ outcome: "called" });
    const callsBefore = fake.callsTo("tools/call").length;

    clock += IDLE_TTL_MS;
    pool.acquire(upstreamOf(OTHER), bearer(undefined));

    // `closed`, not `busy`: the permit was never the reason, and nothing was
    // sent to the upstream on the way to finding out.
    expect(await stale?.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "connect_failed",
      failure: "closed"
    });
    expect(fake.callsTo("tools/call")).toHaveLength(callsBefore);

    await pool.close();
  });

  // The same shape as the listing-wait inequality above, and load-bearing for
  // the same reason: a client evicted underneath a catalog entry still citing
  // it means re-probing on every call while the listing never expires.
  it("outlives the catalog entry keyed on the same upstream", () => {
    expect(IDLE_TTL_MS).toBeGreaterThan(CATALOG_TTL_MS);
  });
});
