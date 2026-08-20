import { MAX_TOOL_DESCRIPTION } from "@getlibero/schema";
import type { McpServer } from "@getlibero/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpDispatcher } from "./http-dispatcher.js";
import { createJsonLogger } from "./log.js";
import { createMcpCatalog } from "./mcp-catalog.js";
import { type HttpUpstream, createMcpPool } from "./mcp-pool.js";
import { constantCredential } from "./outbound.js";
import {
  CATALOG_BUDGET_MS,
  CATALOG_FAILURE_TTL_MS,
  CATALOG_TTL_MS,
  MAX_CATALOG_PAGES,
  MAX_DESCRIBED_TOOLS
} from "./mcp-catalog.js";
import {
  ANNOTATION_BEHIND_REF,
  ANNOTATION_UNDER_ITEMS,
  type FakeMcpServer,
  type FakeReply,
  completeListResult,
  completeResult,
  startFakeMcpServer
} from "./mcp-fake-server.js";
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

/** Polls rather than sleeps, per the convention in team-sheet-store.test.ts. */
async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
  /**
   * The described half of a catalog answer, which is what almost every case
   * here is about. The exclusion half has its own accessor below rather than
   * being threaded through twenty assertions that have nothing to say about it.
   */
  readonly describe: (upstream: McpServer, wanted: readonly string[]) => Promise<
    ReadonlyMap<string, { description?: string; inputSchema?: Record<string, unknown> }>
  >;
  /** The names the proxy walked, found, and will not publish at all. */
  readonly excludedBy: (upstream: McpServer, wanted: readonly string[]) => Promise<ReadonlySet<string>>;
  readonly lines: Record<string, unknown>[];
  readonly advance: (ms: number) => void;
}

function harnessFor(vault: Vault = vaultOf({ [CRED]: SECRET }), maxResponseBytes?: number): Harness {
  const lines: Record<string, unknown>[] = [];
  const clock = clockFrom(1_000_000);
  const built = createHttpDispatcher({
    vault,
    timeoutMs: 2000,
    now: clock.now,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    logger: createJsonLogger(line => lines.push(JSON.parse(line) as Record<string, unknown>))
  });
  dispatcher = built;
  return {
    describe: async (upstream, wanted) => (await built.describe(upstream, wanted)).described,
    excludedBy: async (upstream, wanted) => (await built.describe(upstream, wanted)).excluded,
    lines,
    advance: clock.advance
  };
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
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: completeListResult({ tools: [], nextCursor: "always" }) } }
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
    // The bound exactly, marker included, because it is the same constant
    // `PermittedTool.description` parses against — one character over and the
    // agent rejects the whole listing as `malformed_response`, which ends the
    // task rather than shortening a sentence. This case asserted 1025 before
    // #130 and so encoded that gap.
    expect(entry?.description).toHaveLength(MAX_TOOL_DESCRIPTION);
    expect(entry?.inputSchema).toEqual({ type: "object" });
  });

  it("drops a schema no provider would take, and keeps the description", async () => {
    // The class this rules out is the one that fails a whole turn rather than
    // one tool: the agent casts this straight into the provider's definition.
    fake = await startFakeMcpServer({
      protocol: "legacy",
      catalog: [{ name: "list_prs", description: "Lists PRs.", inputSchema: { type: "string" } }]
    });
    const { describe: ask, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({ description: "Lists PRs." });
    expect(
      lines.some(line => line["event"] === "catalog_schema_rejected" && line["reason"] === "not_type_object")
    ).toBe(true);
  });

  // The vendored header scan recurses per nesting level with no depth bound,
  // and it runs on the *raw* schema — deliberately, so a large tool keeps its
  // headers — which makes it the one consumer of bytes nothing has bounded
  // yet. Tens of thousands of levels fit inside the response bound, and the
  // RangeError is neither a RedactionError nor an outcome: unguarded, it
  // escapes the degrade-to-thin contract and turns one hostile upstream into
  // a 500 for the channel's whole listing.
  it("survives a schema nested too deep to scan, and publishes the tool thin", async () => {
    // Served as raw bytes rather than through the fake's catalog: JSON.parse
    // keeps its continuation state on the heap, but JSON.stringify recurses on
    // the call stack — a deep *object* in the catalog would blow up the fake's
    // own serializer on a small-stacked CI worker before the guard under test
    // ever ran, and how deep "too deep" is would depend on the runner.
    const depth = 60_000;
    const deep = '{"type":"object","properties":{"a":'.repeat(depth) + '{"type":"string"}' + "}}".repeat(depth);
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? {
            raw: `{"jsonrpc":"2.0","id":${String(request.rpc.id ?? 0)},"result":{"resultType":"complete","ttlMs":0,"cacheScope":"public","tools":[{"name":"list_prs","description":"Lists PRs.","inputSchema":${deep}}]}}`
          }
        : null;
    const { describe: ask } = harnessFor();

    // Thin, not absent, and above all: answered. The description survives; the
    // schema is over the publish bound anyway and is dropped on its own rule.
    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({ description: "Lists PRs." });
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
    fake = await startFakeMcpServer({ protocol: "legacy", catalog: [{ name: "list_prs" }] });
    const { describe: ask, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({});
    // A tool that published no schema is not a rejected schema.
    expect(lines.some(line => line["event"] === "catalog_schema_rejected")).toBe(false);
  });
});

// #200. The one place the degrade-to-thin contract narrows, and the reasoning
// is at `Publication` in mcp-catalog.ts: the proxy cannot derive headers for a
// tool whose annotations do not validate, so a thin entry is a tool the model
// can see, will call, and whose every call an upstream requiring them refuses
// `-32020` at the far end. Showing the model a tool that cannot work is worse
// than not showing it, and dropping the row deauthorizes nothing.
describe("a tool whose x-mcp-header annotations do not validate", () => {
  // The positive control this whole block rests on. Every assertion below also
  // passes against a scan that rejected *everything*, so one case has to prove
  // a well-placed annotation is still published — and still produces the
  // declarations the call path mirrors into headers.
  it("is not the fate of a well-placed one", async () => {
    fake = await startFakeMcpServer({
      catalog: [
        {
          name: "list_prs",
          description: "Lists PRs.",
          inputSchema: { type: "object", properties: { owner: { type: "string", "x-mcp-header": "Owner" } } }
        }
      ]
    });
    const { describe: ask, excludedBy, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({
      description: "Lists PRs.",
      inputSchema: { type: "object", properties: { owner: { type: "string", "x-mcp-header": "Owner" } } }
    });
    expect(await excludedBy(serverAt(fake.url), ["list_prs"])).toEqual(new Set());
    expect(lines.some(line => line["event"] === "catalog_tool_excluded")).toBe(false);
  });

  // Two routes to the same fault, kept as a pair: the codec sweeps every
  // keyword the `properties` chain must not pass through, so a case built only
  // on `items` would still pass against a scan that had quietly stopped
  // descending into `$defs`.
  it.each([
    ["under items", ANNOTATION_UNDER_ITEMS],
    ["behind a $ref", ANNOTATION_BEHIND_REF]
  ])("is excluded when the annotation sits %s, not published thin", async (_label, inputSchema) => {
    fake = await startFakeMcpServer({
      catalog: [{ name: "list_prs", description: "Lists PRs.", inputSchema }]
    });
    const { describe: ask, excludedBy, lines } = harnessFor();

    // Absent from the answer entirely. Thin — `{}`, or the description alone —
    // is the behaviour this replaced and the one the model cannot act on.
    expect((await ask(serverAt(fake.url), ["list_prs"])).has("list_prs")).toBe(false);
    expect(await excludedBy(serverAt(fake.url), ["list_prs"])).toEqual(new Set(["list_prs"]));
    expect(
      lines.some(
        line =>
          line["event"] === "catalog_tool_excluded" &&
          line["tool"] === "list_prs" &&
          line["reason"] === "invalid_annotations"
      )
    ).toBe(true);
  });

  // The acceptance criterion that keeps the two unlisted states readable apart:
  // both end up out of the answer, and only one is the upstream's fault.
  it("is distinguishable in the log from a tool the upstream does not offer", async () => {
    fake = await startFakeMcpServer({
      catalog: [{ name: "list_prs", inputSchema: ANNOTATION_UNDER_ITEMS }]
    });
    const { describe: ask, excludedBy, lines } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs", "merge_pr"])).size).toBe(0);
    // `merge_pr` was walked and confirmed absent, so it is not withheld — the
    // listing route lists the sheet's own row for it and drops the other.
    expect(await excludedBy(serverAt(fake.url), ["list_prs", "merge_pr"])).toEqual(new Set(["list_prs"]));
    expect(lines.filter(line => line["event"] === "catalog_tool_excluded").map(line => line["tool"])).toEqual([
      "list_prs"
    ]);
  });

  it("takes no other tool down with it", async () => {
    fake = await startFakeMcpServer({
      catalog: [
        { name: "list_prs", inputSchema: ANNOTATION_BEHIND_REF },
        { name: "merge_pr", description: "Merges a PR.", inputSchema: { type: "object" } }
      ]
    });
    const { describe: ask } = harnessFor();

    // One invalid definition invalidates one tool. The scan runs per tool, and
    // a hostile upstream must not be able to empty a channel's listing by
    // annotating one schema wrongly.
    expect([...(await ask(serverAt(fake.url), ["list_prs", "merge_pr"])).keys()]).toEqual(["merge_pr"]);
  });

  // The cap bounds what enters the model's context. A withheld tool never
  // enters it, so charging it to that cap would hand a hostile upstream a way
  // to shrink a listing with schemas it knew were invalid.
  it("does not spend the cap on what the model is shown", async () => {
    const many = Array.from({ length: MAX_DESCRIBED_TOOLS }, (_, i) => ({
      name: `tool_${String(i)}`,
      inputSchema: { type: "object" as const }
    }));
    fake = await startFakeMcpServer({
      catalog: [{ name: "poisoned", inputSchema: ANNOTATION_UNDER_ITEMS }, ...many]
    });
    const { describe: ask } = harnessFor();

    const described = await ask(serverAt(fake.url), ["poisoned", ...many.map(tool => tool.name)]);

    // Listed first, so a cap that counted it would cost the last tool its row.
    expect(described.size).toBe(MAX_DESCRIBED_TOOLS);
    expect(described.has(`tool_${String(MAX_DESCRIBED_TOOLS - 1)}`)).toBe(true);
  });

  // Every other listing failure still degrades. The doctrine narrows here and
  // nowhere else, so a tool the proxy merely could not describe keeps its row.
  it("is not what happens to a tool with a schema no provider would take", async () => {
    fake = await startFakeMcpServer({
      protocol: "legacy",
      catalog: [{ name: "list_prs", description: "Lists PRs.", inputSchema: { type: "string" } }]
    });
    const { describe: ask, excludedBy } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({ description: "Lists PRs." });
    expect(await excludedBy(serverAt(fake.url), ["list_prs"])).toEqual(new Set());
  });

  // The bound exists because definitions are re-sent on every model turn. It is
  // applied *after* the sheet's names have filtered the page, which is what
  // stops an upstream burying a permitted tool behind decoys.
  it("caps how many tools one upstream may describe", async () => {
    const many = Array.from({ length: MAX_DESCRIBED_TOOLS + 5 }, (_, i) => ({
      name: `tool_${String(i)}`,
      description: "d",
      inputSchema: { type: "object" as const }
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
    const decoys = Array.from({ length: MAX_DESCRIBED_TOOLS + 20 }, (_, i) => ({
      name: `decoy_${String(i)}`,
      inputSchema: { type: "object" as const }
    }));
    fake = await startFakeMcpServer({
      catalog: [...decoys, { name: "list_prs", description: "Lists PRs.", inputSchema: { type: "object" } }]
    });
    const { describe: ask } = harnessFor();

    expect((await ask(serverAt(fake.url), ["list_prs"])).get("list_prs")).toEqual({
      description: "Lists PRs.",
      inputSchema: { type: "object" }
    });
  });

  // **The tolerance above is the legacy era's, and #188 is where that became
  // true.** The proxy's rule is that an unreadable *entry* is skipped and only
  // an unreadable *page* is refused, because a partial catalog costs the model
  // accuracy while a refused one costs every tool beside the bad entry its
  // schema. The client asks for a page against a permissive schema precisely to
  // keep that — and on `2026-07-28` it does not survive, because the SDK
  // validates the result against the specification's shape *before* any
  // caller-supplied schema, and we never see the bytes it rejected.
  //
  // Pinned rather than left to be rediscovered. What is lost is graceful
  // degradation, not a permission: a thin catalog still names every tool the
  // sheet allows, and the proxy still enforces the sheet on the call. Every
  // upstream in production today negotiates legacy, GitHub included.
  it("loses that tolerance on the modern era, where the specification is enforced above us", async () => {
    const catalog = [
      { name: "list_prs", description: "Lists PRs.", inputSchema: { type: "object" as const } },
      { name: "malformed", inputSchema: { type: "string" as const } }
    ];

    fake = await startFakeMcpServer({ protocol: "legacy", catalog });
    expect([...(await harnessFor().describe(serverAt(fake.url), ["list_prs", "malformed"])).keys()]).toEqual([
      "list_prs",
      "malformed"
    ]);
    await dispatcher?.close();
    await fake.close();

    fake = await startFakeMcpServer({ protocol: "stateless", catalog });
    expect(await harnessFor().describe(serverAt(fake.url), ["list_prs", "malformed"])).toEqual(new Map());
  });
});

describe("when the upstream cannot be asked", () => {
  // The replies are factories so the one that answers with a *result* can echo
  // the request's own id. A client numbers its requests however it likes, and an
  // answer to an id nobody asked about is no answer at all — which this suite
  // would see as a timeout rather than as the refusal it is testing for.
  it.each<[string, (id: number | undefined) => FakeReply, string]>([
    ["a body that is not MCP", () => ({ raw: "not json" }), "protocol_error"],
    [
      "a result with no tools",
      id => ({ message: { jsonrpc: "2.0", id, result: completeResult({}) } }),
      "protocol_error"
    ],
    ["a 500", () => ({ status: 500, raw: "boom" }), "http_error"]
  ])("answers empty and logs a reason for %s", async (_label, reply, reason) => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/list" ? reply(request.rpc.id) : null);
    const { describe: ask, lines } = harnessFor();

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === reason)).toBe(true);
  });

  // #151's listing half, and the reason the wire bound refuses a body rather
  // than truncating it. A tool result cut at a cap is a short answer that admits
  // it; half a JSON-RPC envelope is not a short catalog, it is an unparseable
  // one. So an oversized listing takes the path a malformed listing already
  // took: nothing is parsed, the tools fall back to the thin entries the sheet
  // wrote, and one line says why.
  it("answers thin for a listing past the wire bound rather than parsing half of it", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: completeListResult({ tools: [{ name: "list_prs", description: "y".repeat(200_000) }], nextCursor: null })
            }
          }
        : null;
    const { describe: ask, lines } = harnessFor(vaultOf({ [CRED]: SECRET }), 16_384);

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "too_large")).toBe(true);
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
      expect((await built.describe(serverAt(fake.url), ["list_prs"])).described).toEqual(new Map());
      const spent = Date.now() - started;

      expect(spent).toBeLessThan(CATALOG_BUDGET_MS * 2);
      expect(spent).toBeLessThan(DEFAULT_UPSTREAM_TIMEOUT_MS);
      expect(
        lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "budget_exhausted")
      ).toBe(true);
    },
    CATALOG_BUDGET_MS * 4
  );

  // The other half of abandoning a walk, and it only became a cost with #159:
  // every page takes a permit from the upstream's semaphore, so a walk that has
  // already lost its race and is read by nobody was queuing four more times
  // against calls that are. The page in flight still lands — that is where the
  // handshake ladder runs, so it is what warms the client — and the walk stops
  // there.
  it("asks for no further pages once its budget has gone", async () => {
    // Three pages fit inside `CATALOG_BUDGET_MS` and five do not, so the walk is
    // reliably mid-pagination when the race ends, on a slow machine as well as a
    // fast one.
    const PAGE_MS = 1_500;
    fake = await startFakeMcpServer();
    // The never-advancing cursor from "gives up on a server whose cursor never
    // advances", slowed. Every page has a next one, so nothing but a bound of
    // ours can stop this walk — and that case is this one's positive control:
    // on the same fixture at full speed the walk really does ask for all
    // `MAX_CATALOG_PAGES`, so a count below it here is the stop flag rather than
    // a fixture that could only ever serve one page.
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? {
            delayMs: PAGE_MS,
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: completeListResult({ tools: [], nextCursor: "always" })
            }
          }
        : null;
    const { describe: ask } = harnessFor();

    expect(await ask(serverAt(fake.url), ["list_prs"])).toEqual(new Map());
    const asked = fake.callsTo("tools/list").length;

    // Genuinely mid-walk when the race ended, with pages still inside the cap to
    // go after. Ranges rather than an exact count: the claim is about what the
    // walk does next, and a slow machine moves the number without moving that.
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThan(MAX_CATALOG_PAGES);

    // Long enough for the page in flight to land and a further one to have been
    // asked for and answered. A request is a permit, which is why counting them
    // is the assertion rather than a proxy for it.
    await new Promise(resolve => setTimeout(resolve, PAGE_MS * 2));
    expect(fake.callsTo("tools/list")).toHaveLength(asked);
  }, CATALOG_BUDGET_MS * 4);

  it("answers empty once the pool has begun closing", async () => {
    fake = await startFakeMcpServer();
    const built = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), timeoutMs: 2000 });
    await built.close();

    expect((await built.describe(serverAt(fake.url), ["list_prs"])).described).toEqual(new Map());
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

// #188 keyed the cache on the upstream alone and stores what is known per tool
// name. The reason is the call path: it wants one tool's definition, and under
// the old (upstream, exact-wanted-set) key that was a different question and so
// a guaranteed miss — a five-page walk under a five-second budget, per call,
// against an upstream that was walked seconds ago.
describe("what one upstream is already known to offer", () => {
  it("answers a single tool from a walk another question paid for", async () => {
    fake = await startFakeMcpServer({ pageSize: 1 });
    const { describe: ask } = harnessFor();
    const upstream = serverAt(fake.url);

    // The listing route's question: every tool this sheet names.
    await ask(upstream, ["list_prs", "merge_pr"]);
    const paid = fake.callsTo("tools/list").length;

    // The call path's question, one tool. Under the old keying this walked again.
    const one = await ask(upstream, ["merge_pr"]);

    expect([...one.keys()]).toEqual(["merge_pr"]);
    expect(fake.callsTo("tools/list")).toHaveLength(paid);
  });

  // Absence is a fact worth storing. Without it a sheet naming a tool the
  // upstream does not offer re-walks that upstream on every listing and every
  // call — the case a `null` resolution exists for.
  it("remembers that a tool is not there, rather than looking again", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask } = harnessFor();
    const upstream = serverAt(fake.url);

    // Asked as part of a wider question, so the second ask is a *different*
    // question — which is exactly what the old keying could not answer, and why
    // this is the discriminator rather than a repeat of the same request.
    expect([...(await ask(upstream, ["list_prs", "no_such_tool"])).keys()]).toEqual(["list_prs"]);
    const paid = fake.callsTo("tools/list").length;
    expect(await ask(upstream, ["no_such_tool"])).toEqual(new Map());

    expect(fake.callsTo("tools/list")).toHaveLength(paid);
  });

  it("asks again once what it learned has gone stale", async () => {
    fake = await startFakeMcpServer();
    const { describe: ask, advance } = harnessFor();
    const upstream = serverAt(fake.url);

    await ask(upstream, ["list_prs"]);
    advance(CATALOG_TTL_MS + 1);
    await ask(upstream, ["list_prs"]);

    expect(fake.callsTo("tools/list")).toHaveLength(2);
  });

  // The cap bounds what enters a model's context, and definitions are re-sent
  // every turn — so it has to hold across the *answer*, not across one walk.
  // Merging is what makes that a live question: without a budget, a caller
  // asking for a few names and then for many would carry the first answer plus
  // a full cap's worth of the second.
  it("holds the described-tools cap across a merged answer", async () => {
    const catalog = Array.from({ length: MAX_DESCRIBED_TOOLS + 20 }, (_unused, index) => ({
      name: `tool_${String(index)}`,
      description: "listed",
      inputSchema: { type: "object" as const }
    }));
    fake = await startFakeMcpServer({ catalog, pageSize: null });
    const { describe: ask } = harnessFor();
    const upstream = serverAt(fake.url);
    const every = catalog.map(tool => tool.name);

    await ask(upstream, every.slice(0, 30));
    const described = await ask(upstream, every);

    expect(described.size).toBeLessThanOrEqual(MAX_DESCRIBED_TOOLS);
  });

  // The walk's budget bounds what one question adds, but resolutions merge
  // across questions: two narrow asks can together settle more names than the
  // cap, and a later wide ask then finds everything fresh and walks nothing.
  // The cap has to hold on the assembled answer itself, or the fully-cached
  // path — the cheapest one — is the one path that can exceed it.
  it("holds the cap when the whole answer is already cached", async () => {
    const catalog = Array.from({ length: MAX_DESCRIBED_TOOLS + 20 }, (_unused, index) => ({
      name: `tool_${String(index)}`,
      description: "listed",
      inputSchema: { type: "object" as const }
    }));
    fake = await startFakeMcpServer({ catalog, pageSize: null });
    const { describe: ask, lines } = harnessFor();
    const upstream = serverAt(fake.url);
    const every = catalog.map(tool => tool.name);

    await ask(upstream, every.slice(0, MAX_DESCRIBED_TOOLS));
    await ask(upstream, every.slice(MAX_DESCRIBED_TOOLS));
    const walksSoFar = fake.callsTo("tools/list").length;
    const described = await ask(upstream, every);

    expect(described.size).toBe(MAX_DESCRIBED_TOOLS);
    // Wanted order is the sheet's order, so the operator's first hundred win.
    expect(described.has("tool_0")).toBe(true);
    expect(described.has(`tool_${String(MAX_DESCRIBED_TOOLS + 19)}`)).toBe(false);
    // The wide ask was served from the cache — the cap did not force a re-walk.
    expect(fake.callsTo("tools/list")).toHaveLength(walksSoFar);
    expect(lines.some(line => line["event"] === "catalog_unavailable" && line["reason"] === "truncated")).toBe(true);
  });
});

/**
 * What the cache stops holding (#374).
 *
 * **Built from the pool and the catalog directly, which is this file's one
 * departure from the convention above.** Everywhere else the catalog is reached
 * through `createHttpDispatcher`, because the lease — the transport guard and
 * the vault lookup — is half of what those cases are about. It is no part of
 * this one: these are about what survives in a map, and the lease's only job
 * here is to hand over a client that really walks a real socket, which it does.
 * The dispatcher does not expose the count, and widening the serving interface
 * to carry a number only a test reads is the worse of the two trades.
 *
 * Collecting is otherwise invisible — an expired resolution and a swept one are
 * treated identically by every reader — so `size` is the claim's only witness,
 * and each case pairs it with a walk count to say the behaviour did not move.
 */
describe("what the cache stops holding", () => {
  /** A pool and a catalog over it, with a clock the case drives. */
  function cacheFor() {
    const clock = clockFrom(1_000_000);
    const pool = createMcpPool({ timeoutMs: 2000, now: clock.now });
    const catalog = createMcpCatalog({
      lease: upstream => {
        if (upstream.transport !== "http") return { ok: false, reason: "unsupported_transport" };
        const client = pool.acquire(upstream as HttpUpstream, constantCredential("bearer", undefined));
        return client === null ? { ok: false, reason: "shutting_down" } : { ok: true, client };
      },
      now: clock.now
    });
    return { catalog, advance: clock.advance, close: () => pool.close() };
  }

  // The half the issue was written against: an upstream nobody names any more.
  // A sheet edit that moves a url or renames a credential mints a new
  // `upstreamKey`, and the old entry was never acquired again and never dropped.
  it("drops an entry for an upstream nothing asks about any more", async () => {
    fake = await startFakeMcpServer();
    const { catalog, advance, close } = cacheFor();
    try {
      await catalog.describe(serverAt(fake.url), ["list_prs"]);
      expect(catalog.size).toEqual({ entries: 1, resolutions: 1 });

      advance(CATALOG_TTL_MS + 1);
      // A different credential name, so a different key: the sheet edit, as the
      // cache sees it. Any read is the sweep's only chance to run.
      await catalog.describe(serverAt(fake.url, { credential: "rotated" }), ["list_prs"]);

      // The stranded entry is gone rather than joined by a second.
      expect(catalog.size).toEqual({ entries: 1, resolutions: 1 });
    } finally {
      await close();
    }
  });

  // A stale name the next ask does not mention is collected rather than left to
  // be overwritten by a `merge` that will never come. Both resolutions here are
  // past their window, so this says sweeping happens and not yet at what
  // granularity — the case below is the one that pins that.
  it("drops a stale resolution the next ask does not name", async () => {
    fake = await startFakeMcpServer();
    const { catalog, advance, close } = cacheFor();
    try {
      const upstream = serverAt(fake.url);
      await catalog.describe(upstream, ["list_prs", "merge_pr"]);
      expect(catalog.size).toEqual({ entries: 1, resolutions: 2 });
      const walked = fake.callsTo("tools/list").length;

      // Past the window, then the sheet asks for one of the two. Both
      // resolutions are stale, so both are swept and only the asked-for one is
      // walked again — the dropped tool's description does not come back.
      advance(CATALOG_TTL_MS + 1);
      const described = await catalog.describe(upstream, ["list_prs"]);

      expect([...described.described.keys()]).toEqual(["list_prs"]);
      expect(catalog.size).toEqual({ entries: 1, resolutions: 1 });
      expect(fake.callsTo("tools/list").length).toBeGreaterThan(walked);
    } finally {
      await close();
    }
  });

  // **The discriminator, and the reason the rule is per resolution.** Here one
  // name is past its window and one is not. A rule that dropped an entry only
  // once *every* resolution in it had expired — the obvious shape, and the one
  // #374 was written against — would keep both and pass every other case in
  // this block. That rule never fires on the case that holds bytes: an operator
  // removes one tool from a fifty-tool server, and the other forty-nine keep
  // the entry warm forever while nothing ever asks for the removed name again.
  //
  // The other side of it is asserted here too: a resolution inside its window
  // is a cache doing its job, and sweeping it would buy memory with round trips.
  it("keeps a fresh resolution while collecting a stale one beside it", async () => {
    fake = await startFakeMcpServer();
    const { catalog, advance, close } = cacheFor();
    try {
      const upstream = serverAt(fake.url);
      // Two names warmed at different instants, so the entry holds one of each
      // once the clock lands between their windows.
      await catalog.describe(upstream, ["list_prs"]);
      advance(CATALOG_TTL_MS - 1000);
      await catalog.describe(upstream, ["merge_pr"]);
      expect(catalog.size).toEqual({ entries: 1, resolutions: 2 });
      const walked = fake.callsTo("tools/list").length;

      // `list_prs` is now past its window and `merge_pr` is not.
      advance(2000);
      const described = await catalog.describe(upstream, ["merge_pr"]);

      expect([...described.described.keys()]).toEqual(["merge_pr"]);
      // The stale one collected, the fresh one kept — and kept in the strong
      // sense: the answer came out of the map without asking the upstream.
      expect(catalog.size).toEqual({ entries: 1, resolutions: 1 });
      expect(fake.callsTo("tools/list")).toHaveLength(walked);
    } finally {
      await close();
    }
  });

  // A dropped entry is a cold cache and nothing else: the next ask re-walks and
  // answers exactly what it answered before. This is the case that says the
  // sweep is a memory decision rather than a change of behaviour.
  it("answers the same tools after the entry it had was collected", async () => {
    fake = await startFakeMcpServer();
    const { catalog, advance, close } = cacheFor();
    try {
      const upstream = serverAt(fake.url);
      const before = await catalog.describe(upstream, ["list_prs"]);

      advance(CATALOG_TTL_MS + 1);
      await catalog.describe(serverAt(fake.url, { credential: "rotated" }), ["list_prs"]);
      const after = await catalog.describe(upstream, ["list_prs"]);

      expect(after.described).toEqual(before.described);
      expect(after.excluded).toEqual(before.excluded);
    } finally {
      await close();
    }
  });

  // The `walks` guard, which is a correctness guard and not a memory one. An
  // entry is at its emptiest exactly while it is being walked — the read that
  // started the walk is the read whose sweep collected everything stale in it —
  // so without this the next sweep drops it, and a caller joining that same
  // in-flight walk assembles from a different object and answers with nothing.
  // `costs one walk when several listings arrive at once` is where that shows
  // as a wrong answer; this is where it shows as the entry going missing.
  it("keeps an empty entry that a walk in flight is about to fill", async () => {
    fake = await startFakeMcpServer();
    const { catalog, advance, close } = cacheFor();
    const upstream = serverAt(fake.url);
    try {
      await catalog.describe(upstream, ["list_prs"]);
      advance(CATALOG_TTL_MS + 1);

      fake.respond = request => (request.rpc?.method === "tools/list" ? { hang: true } : null);
      const walking = catalog.describe(upstream, ["list_prs"]);
      await until(() => (fake?.callsTo("tools/list").length ?? 0) >= 2, "the walk to reach the upstream");

      // A read for a different upstream, which is the sweep's only trigger.
      await catalog.describe(serverAt(fake.url, { credential: "other" }), ["list_prs"]);

      // Two: the one being walked, held by its in-flight count despite holding
      // nothing, and the one just filled. Without the guard the first is gone.
      expect(catalog.size.entries).toBe(2);

      await close();
      await fake.close();
      fake = undefined;
      await Promise.allSettled([walking]);
    } finally {
      await close();
    }
  });
});
