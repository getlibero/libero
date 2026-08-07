import { type McpServer, TeamSheet as TeamSheetSchema } from "@getlibero/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import { type HttpUpstream, createMcpPool } from "./mcp-pool.js";
import type { Secret } from "./vault.js";

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

    await a?.callTool("list_prs", {});
    await b?.callTool("get_issue", {});
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
  // connection the process is dismantling.
  it("hands out nothing afterwards", () => {
    const pool = createMcpPool({ scheme: "bearer" });
    const upstream = upstreamOf({ name: "github", transport: "http", url: "http://a:3001" });

    expect(pool.acquire(upstream, undefined)).not.toBeNull();
    pool.close();

    expect(pool.acquire(upstream, undefined)).toBeNull();
    expect(pool.size).toBe(0);
  });

  it("is safe to call twice", () => {
    const pool = createMcpPool({ scheme: "bearer" });
    pool.close();
    expect(() => pool.close()).not.toThrow();
  });
});
