import type { McpServer } from "@getlibero/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpDispatcher } from "./http-dispatcher.js";
import { createJsonLogger } from "./log.js";
import {
  CATALOG_BUDGET_MS,
  CATALOG_FAILURE_TTL_MS,
  CATALOG_TTL_MS,
  MAX_CATALOG_PAGES,
  MAX_DESCRIBED_TOOLS
} from "./mcp-catalog.js";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./outbound.js";
import type { CredentialLookup, Secret, Vault } from "./vault.js";

// Against the real thing: the fake MCP server over a real socket, a real pool,
// a real vault shape. The catalog is reached through `createHttpDispatcher`
// rather than constructed directly, because the lease — the transport guard and
// the vault lookup — is half of what these tests are about, and a hand-built
// lease would be the half that cannot be wrong.

const SECRET = "ghp_live_token_do_not_leak";
const CRED = "github_service_account";

let fake: FakeMcpServer | undefined;
let dispatcher: { close(): Promise<void> } | undefined;

afterEach(async () => {
  await dispatcher?.close();
  dispatcher = undefined;
  await fake?.close();
  fake = undefined;
});

function secretOf(value: string): Secret {
  return Object.freeze({ reveal: () => value, toJSON: () => "[redacted]", toString: () => "[redacted]" }) as Secret;
}

function vaultOf(entries: Record<string, string>): Vault {
  return {
    lookup(name: string): CredentialLookup {
      const value = Object.hasOwn(entries, name) ? entries[name] : undefined;
      return value === undefined ? { status: "missing" } : { status: "found", secret: secretOf(value) };
    },
    get size() {
      return Object.keys(entries).length;
    }
  };
}

function serverAt(url: string, overrides: Partial<McpServer> = {}): McpServer {
  return { name: "github", transport: "http", url, credential: CRED, tool: [], ...overrides } as McpServer;
}

/** A manual clock, so a TTL is a decision rather than a wait. */
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

interface Harness {
  readonly describe: (upstream: McpServer, wanted: readonly string[]) => Promise<
    ReadonlyMap<string, { description?: string; inputSchema?: Record<string, unknown> }>
  >;
  readonly lines: Record<string, unknown>[];
  readonly advance: (ms: number) => void;
}

function harnessFor(vault: Vault = vaultOf({ [CRED]: SECRET })): Harness {
  const lines: Record<string, unknown>[] = [];
  const clock = clockFrom(1_000_000);
  const built = createHttpDispatcher({
    vault,
    timeoutMs: 2000,
    now: clock.now,
    logger: createJsonLogger(line => lines.push(JSON.parse(line) as Record<string, unknown>))
  });
  dispatcher = built;
  return { describe: (upstream, wanted) => built.describe(upstream, wanted), lines, advance: clock.advance };
}

describe("describing a sheet's tools from an upstream", () => {
  it("keeps the tools the sheet named and no others", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask } = harnessFor();

    const described = await ask(serverAt(fake.url), ["list_prs"]);

    expect([...described.keys()]).toEqual(["list_prs"]);
    expect(described.get("list_prs")).toEqual({
      description: "Lists open pull requests.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] }
    });
  });

  it("asks nothing at all when the sheet named nothing", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask } = harnessFor();

    expect(await ask(serverAt(fake.url), [])).toEqual(new Map());
    expect(fake.received).toHaveLength(0);
  });

  it("stops walking as soon as it has found what the sheet named", async () => {
    fake = await startFakeMcpServer({ pageSize: 1 });
    const { describe: ask } = harnessFor();

    // `list_prs` is on page one of two. There is no reason to fetch page two.
    expect([...(await ask(serverAt(fake.url), ["list_prs"])).keys()]).toEqual(["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(1);
  });

  it("walks pages to reach a tool the upstream lists late", async () => {
    fake = await startFakeMcpServer({ pageSize: 1 });
    const { describe: ask } = harnessFor();

    // The reason first-page-only is wrong: the sheet's tool is on page two, and
    // stopping early would thin exactly the upstreams big enough to paginate.
    expect([...(await ask(serverAt(fake.url), ["merge_pr"])).keys()]).toEqual(["merge_pr"]);
    expect(fake.callsTo("tools/list")).toHaveLength(2);
  });

  it("gives up on a server whose cursor never advances", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: { tools: [], nextCursor: "always" } } }
        : null;
    const { describe: ask, lines } = harnessFor();

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    expect(fake.callsTo("tools/list")).toHaveLength(MAX_CATALOG_PAGES);
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "truncated")).toBe(true);
  });
});

describe("what an upstream is allowed to say", () => {
  it("truncates a description rather than dropping the tool", async () => {
    fake = await startFakeMcpServer({
      catalog: [{ name: "list_prs", description: "x".repeat(4000), inputSchema: { type: "object" } }]
    });
    const { describe: ask } = harnessFor();

    const entry = (await ask(serverAt(fake.url), ["list_prs"])).get("list_prs");
    expect(entry?.description).toHaveLength(1025);
    expect(entry?.inputSchema).toEqual({ type: "object" });
  });

  it("drops a schema no provider would take, and keeps the description", async () => {
    // The class this rules out is the one that fails a whole turn rather than
    // one tool: the agent casts this straight into the provider's definition.
    fake = await startFakeMcpServer({
      catalog: [{ name: "list_prs", description: "Lists PRs.", inputSchema: { type: "string" } }]
    });
    const { describe: ask, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({ description: "Lists PRs." });
    expect(
      lines.some(line => line["event"] === "catalog_schema_rejected" && line["reason"] === "not_type_object")
    ).toBe(true);
  });

  it("drops a schema too large to publish", async () => {
    fake = await startFakeMcpServer({
      catalog: [{ name: "list_prs", inputSchema: { type: "object", note: "x".repeat(9000) } }]
    });
    const { describe: ask, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({});
    expect(lines.some(line => line["event"] === "catalog_schema_rejected" && line["reason"] === "too_large")).toBe(
      true
    );
  });

  it("says nothing about a tool the upstream described with nothing", async () => {
    fake = await startFakeMcpServer({ catalog: [{ name: "list_prs" }] });
    const { describe: ask, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({});
    // A tool that published no schema is not a rejected schema.
    expect(lines.some(line => line["event"] === "catalog_schema_rejected")).toBe(false);
  });

  // The bound exists because definitions are re-sent on every model turn. It is
  // applied *after* the sheet's names have filtered the page, which is what
  // stops an upstream burying a permitted tool behind decoys.
  it("caps how many tools one upstream may describe", async () => {
    const many = Array.from({ length: MAX_DESCRIBED_TOOLS + 5 }, (_, i) => ({
      name: `tool_${String(i)}`,
      description: "d"
    }));
    fake = await startFakeMcpServer({ catalog: many });
    const { describe: ask, lines } = harnessFor();

    const described = await ask(
      serverAt(fake.url),
      many.map(tool => tool.name)
    );

    expect(described.size).toBe(MAX_DESCRIBED_TOOLS);
    expect(described.has("tool_0")).toBe(true);
    expect(described.has(`tool_${String(MAX_DESCRIBED_TOOLS + 4)}`)).toBe(false);
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "truncated")).toBe(true);
  });

  it("reaches a sheet's tool that the upstream listed behind a hundred decoys", async () => {
    const decoys = Array.from({ length: MAX_DESCRIBED_TOOLS + 20 }, (_, i) => ({ name: `decoy_${String(i)}` }));
    fake = await startFakeMcpServer({ catalog: [...decoys, { name: "list_prs", description: "Lists PRs." }] });
    const { describe: ask } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({ description: "Lists PRs." });
  });
});

describe("when the upstream cannot be asked", () => {
  it.each([
    ["a body that is not MCP", { raw: "not json" }, "protocol_error"],
    ["a result with no tools", { message: { jsonrpc: "2.0", id: 2, result: {} } }, "protocol_error"],
    ["a 500", { status: 500, raw: "boom" }, "http_error"]
  ])("answers empty and logs a reason for %s", async (_label, reply, reason) => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/list" ? reply : null);
    const { describe: ask, lines } = harnessFor();

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === reason)).toBe(true);
  });

  it("never writes an upstream byte to the log", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list" ? { status: 500, raw: `failed with ${SECRET}` } : null;
    const { describe: ask, lines } = harnessFor();

    await ask(serverAt(fake.url), ["list_prs"]);

    const written = JSON.stringify(lines);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("failed with");
  });

  it("answers empty for a transport this proxy has no client for", async () => {
    const { describe: ask, lines } = harnessFor();

    const stdio = { name: "local", transport: "stdio", tool: [] } as unknown as McpServer;
    expect(await ask(stdio, ["list_prs"])).toEqual(new Map());
    expect(
      lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "unsupported_transport")
    ).toBe(true);
  });

  // The same fail-before-connecting shape a call has: the upstream never learns
  // a listing was attempted, not even through a discovery probe.
  it("answers empty for a credential the vault does not hold, without a single request", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask, lines } = harnessFor(vaultOf({}));

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    expect(fake.received).toHaveLength(0);
    expect(
      lines.some(
        line =>
          line["event"] === "catalog_unavailable" &&
          line["reason"] === "credential_unresolved" &&
          line["credential"] === CRED
      )
    ).toBe(true);
  });

  // The race, and the reason it is a race rather than a deadline threaded into
  // the client: `ensureOpen`'s ladder takes no per-call timeout, so an upstream
  // that black-holes the *handshake* would hold the agent's first turn for the
  // 30s default before a model token was spent. `hangOn: "server/discover"` is
  // the case no per-page timeout can reach.
  it.each([["the handshake", "server/discover"], ["the listing", "tools/list"]])(
    "abandons an upstream that black-holes %s, inside its own budget",
    async (_label, method) => {
      fake = await startFakeMcpServer({ hangOn: method });
      const lines: Record<string, unknown>[] = [];
      // A real clock: the budget is a race against wall time, which is the one
      // thing a manual clock cannot demonstrate.
      const built = createHttpDispatcher({
        vault: vaultOf({ [CRED]: SECRET }),
        logger: createJsonLogger(line => lines.push(JSON.parse(line) as Record<string, unknown>))
      });
      dispatcher = built;

      const started = Date.now();
      expect(await built.describe(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
      const spent = Date.now() - started;

      expect(spent).toBeLessThan(CATALOG_BUDGET_MS * 2);
      expect(spent).toBeLessThan(DEFAULT_UPSTREAM_TIMEOUT_MS);
      expect(
        lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "budget_exhausted")
      ).toBe(true);
    },
    CATALOG_BUDGET_MS * 4
  );

  it("answers empty once the pool has begun closing", async () => {
    fake = await startFakeMcpServer();
    const built = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), timeoutMs: 2000 });
    await built.close();

    expect(await built.describe(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
  });

  // Not an upstream failure: this proxy unable to guarantee its own boundary,
  // and deterministic per credential. Degrading would serve a cheerful thin
  // listing to a channel whose every call is about to 500 the same way.
  it("propagates a redaction failure rather than degrading to a thin listing", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask } = harnessFor(vaultOf({ [CRED]: "" }));

    await expect(ask(serverAt(fake.url), ["list_prs"])).rejects.toThrow();
  });
});

describe("the catalog cache", () => {
  it("asks once inside the window and again past it", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask, advance } = harnessFor();
    const upstream = serverAt(fake.url);

    await ask(upstream, ["list_prs"]);
    await ask(upstream, ["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(1);

    advance(CATALOG_TTL_MS + 1);
    await ask(upstream, ["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(2);
  });

  it("costs one walk when several listings arrive at once", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask } = harnessFor();
    const upstream = serverAt(fake.url);

    const answers = await Promise.all([
      ask(upstream, ["list_prs"]),
      ask(upstream, ["list_prs"]),
      ask(upstream, ["list_prs"])
    ]);

    for (const answer of answers) expect([...answer.keys()]).toEqual(["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(1);
  });

  it("remembers a failure briefly, so a dead upstream is not asked per listing", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/list" ? { status: 500, raw: "" } : null);
    const { describe: ask, advance } = harnessFor();
    const upstream = serverAt(fake.url);

    await ask(upstream, ["list_prs"]);
    await ask(upstream, ["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(1);

    // Briefly, though: a failure is a moment rather than a property, so the
    // window is short enough that recovery is not a restart.
    advance(CATALOG_FAILURE_TTL_MS + 1);
    await ask(upstream, ["list_prs"]);
    expect(fake.callsTo("tools/list")).toHaveLength(2);
  });

  it("expires a truncated walk on the failure window rather than the success one", async () => {
    const many = Array.from({ length: MAX_DESCRIBED_TOOLS + 5 }, (_, i) => ({ name: `tool_${String(i)}` }));
    fake = await startFakeMcpServer({ catalog: many });
    const { describe: ask, advance } = harnessFor();
    const upstream = serverAt(fake.url);
    const wanted = many.map(tool => tool.name);

    await ask(upstream, wanted);
    advance(CATALOG_FAILURE_TTL_MS + 1);
    await ask(upstream, wanted);

    expect(fake.callsTo("tools/list")).toHaveLength(2);
  });

  // The walk stops when it has everything it was asked for and caps on the same
  // set, so what it produces depends on that set. Two sheets naming the same
  // server with different tools must not read each other's answer.
  it("does not answer one sheet's question with another sheet's walk", async () => {
    fake = await startFakeMcpServer({ pageSize: 1 });
    const { describe: ask } = harnessFor();
    const upstream = serverAt(fake.url);

    expect([...(await ask(upstream, ["list_prs"])).keys()]).toEqual(["list_prs"]);
    expect([...(await ask(upstream, ["list_prs", "merge_pr"])).keys()]).toEqual(["list_prs", "merge_pr"]);
  });
});
