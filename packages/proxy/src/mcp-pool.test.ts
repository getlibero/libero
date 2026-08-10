import { type McpServer, TeamSheet as TeamSheetSchema } from "@getlibero/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import { type HttpUpstream, createMcpPool } from "./mcp-pool.js";
import type { Secret } from "./vault.js";
import type { CallLimits } from "./enforce.js";

/**
 * The channel's bound on a result, which every `callTool` now carries.
 *
 * Roomy on purpose: these cases are about the protocol and the transport, not
 * about truncation. The bound's own behaviour is mcp-protocol.test.ts's.
 */
const LIMITS: CallLimits = { maxResultChars: 100_000 };

const VALUE = "ghp_live_token_do_not_log";

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
    channel: { name: "engineering" },
    mcp_server: [{ tool: [{ name: "list_prs" }], ...block }]
  });
  const parsed: McpServer | undefined = sheet.mcp_server[0];
  if (parsed === undefined || parsed.transport !== "http") throw new Error("fixture is not an http upstream");
  return parsed;
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
    const pool = createMcpPool({ scheme: "bearer" });

    const a = pool.acquire(
      upstreamOf({ name: "github", transport: "http", url: fake.url, credential: "c" }),
      secretOf("v")
    );
    const b = pool.acquire(
      upstreamOf({ name: "gh", transport: "http", url: fake.url, credential: "c", tool: [{ name: "get_issue" }] }),
      secretOf("v")
    );

    expect(a).toBe(b);
    expect(pool.size).toBe(1);

    await a?.callTool("list_prs", {}, LIMITS);
    await b?.callTool("get_issue", {}, LIMITS);
    expect(fake.callsTo("server/discover")).toHaveLength(1);
  });

  it.each([
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
    const pool = createMcpPool({ scheme: "bearer" });

    const a = pool.acquire(upstreamOf(left), secretOf("v"));
    const b = pool.acquire(upstreamOf(right), secretOf("v"));

    expect(a).not.toBe(b);
    expect(pool.size).toBe(2);
  });

  it("creates nothing until a call needs it", () => {
    const pool = createMcpPool({ scheme: "bearer" });
    expect(pool.size).toBe(0);
  });
});

describe("closing", () => {
  // A call arriving during teardown is answered rather than served over a
  // connection the process is dismantling. Asserted *without* awaiting, on
  // purpose: the refusal has to hold from the instant `close()` is entered
  // rather than from when its session terminations resolve.
  it("hands out nothing afterwards", async () => {
    const pool = createMcpPool({ scheme: "bearer" });
    const upstream = upstreamOf({ name: "github", transport: "http", url: "http://a:3001" });

    expect(pool.acquire(upstream, undefined)).not.toBeNull();
    const closing = pool.close();

    expect(pool.acquire(upstream, undefined)).toBeNull();
    expect(pool.size).toBe(0);
    await closing;
  });

  it("is safe to call twice", async () => {
    const pool = createMcpPool({ scheme: "bearer" });
    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it("sends one DELETE per client, carrying that client's own session", async () => {
    const first = await startFakeMcpServer({ protocol: "legacy" });
    const second = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ scheme: "bearer", timeoutMs: 2000 });
      for (const server of [first, second]) {
        const client = pool.acquire(
          upstreamOf({ name: "s", transport: "http", url: server.url, credential: "c" }),
          secretOf(VALUE)
        );
        expect(await client?.callTool("list_prs", {}, LIMITS)).toMatchObject({ outcome: "called" });
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
      const pool = createMcpPool({ scheme: "bearer", timeoutMs: 2000 });
      for (const server of [stateless, sessionless]) {
        const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), undefined);
        expect(await client?.callTool("list_prs", {}, LIMITS)).toMatchObject({ outcome: "called" });
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
    const pool = createMcpPool({ scheme: "bearer", timeoutMs: 2000 });
    const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), undefined);
    expect(await client?.callTool("list_prs", {}, LIMITS)).toMatchObject({ outcome: "called" });

    await server.close();

    await expect(pool.close()).resolves.toBeUndefined();
  });

  // The budget exists because this runs inside a signal handler: an upstream
  // that accepts the connection and never answers must not hold shutdown past
  // the orchestrator's grace period.
  it("resolves within its own budget against an upstream that never answers", async () => {
    const server = await startFakeMcpServer({ protocol: "legacy" });
    try {
      const pool = createMcpPool({ scheme: "bearer", timeoutMs: 2000 });
      const client = pool.acquire(upstreamOf({ name: "s", transport: "http", url: server.url }), undefined);
      expect(await client?.callTool("list_prs", {}, LIMITS)).toMatchObject({ outcome: "called" });

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
