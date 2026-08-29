import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer, ResolvedToolCall } from "@getlibero/schema";
import { afterEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { startFakeTokenIssuer } from "./fake-token-issuer.js";
import type { FakeTokenIssuer } from "./fake-token-issuer.js";
import { createHttpDispatcher } from "./http-dispatcher.js";
import { openTokenStore } from "./token-store.js";
import type { FileTokenStore } from "./token-store.js";
import type { CallLimits } from "./enforce.js";

/**
 * The channel's bound on a result, which every `callTool` now carries.
 *
 * Roomy on purpose: these cases are about the protocol and the transport, not
 * about truncation. The bound's own behaviour is mcp-bounds.test.ts's.
 */
const LIMITS: CallLimits = { maxResultChars: 100_000 };
import { createJsonLogger } from "./log.js";
import { type FakeMcpServer, completeResult, startFakeMcpServer } from "./mcp-fake-server.js";
import { RedactionError } from "./redact.js";
import { parseVaultKey } from "./vault.js";
import type { CredentialLookup, Secret, Vault } from "./vault.js";

// A real socket rather than a stubbed `fetch`, because the claim under test is
// that the credential arrives at the far end of one. The upstream is the fake
// MCP server from ./mcp-fake-server.ts: loopback, port 0, no dependency.

const SECRET = "ghp_live_token_do_not_leak";
const CRED = "github_service_account";

let fake: FakeMcpServer | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function secretOf(value: string): Secret {
  return Object.freeze({ reveal: () => value, toJSON: () => "[redacted]", toString: () => "[redacted]" }) as Secret;
}

/** A vault holding one entry, with the real one's API and no listing. */
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

function callTo(tool = "list_prs"): ResolvedToolCall {
  return {
    id: "toolu_01",
    server: "github",
    tool,
    arguments: { state: "open" },
    requestingUser: "U0ASKER",
    task: "b9d5a2f0-0000-4000-8000-000000000001",
    channel: "C0ENGINEERING"
  };
}

/**
 * An http upstream. `url` is required by the type, not by convention — the
 * schema discriminates on transport (#89), so an http block with no address is
 * rejected at load and there is no such value to build here.
 */
function serverAt(url: string, overrides: Partial<Pick<McpServer, "name" | "credential" | "tool">> = {}): McpServer {
  return {
    name: "github",
    transport: "http",
    url,
    credential: CRED,
    tool: [{ name: "list_prs" }],
    ...overrides
  };
}

/** A stdio upstream: a process, so no address at all. */
function stdioServer(): McpServer {
  return { name: "github", transport: "stdio", credential: CRED, tool: [{ name: "list_prs" }] };
}

/** Polls rather than sleeps, per the convention in team-sheet-store.test.ts. */
async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Captures every log line the dispatcher writes, for the leak assertions. */
function capturingLogger(): { lines: string[]; logger: ReturnType<typeof createJsonLogger> } {
  const lines: string[] = [];
  return { lines, logger: createJsonLogger(line => lines.push(line)) };
}

describe("serving a call", () => {
  it("delivers the real secret to the upstream", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result).toEqual({ outcome: "ran", result: { content: "called list_prs", isError: false } });
    // Every request, not just the call: the discovery probe carries it too.
    expect(fake.received).not.toHaveLength(0);
    for (const request of fake.received) {
      expect(request.authorization).toBe(`Bearer ${SECRET}`);
    }
  });

  it("sends the tool and its arguments, and no channel or attribution", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    const call = fake.callsTo("tools/call")[0];
    expect(call?.rpc?.params).toMatchObject({ name: "list_prs", arguments: { state: "open" } });

    // Across every request, including the discovery probe — `_meta.clientInfo`
    // is the field on the wire that most looks like it should carry a caller
    // identity, and it must not.
    const everything = fake.received.map(request => request.body).join("");
    expect(everything).not.toContain("C0ENGINEERING");
    // Who asked and which task is ours to audit, not a third party's to learn.
    // The upstream is somebody else's service and its logs are somebody else's
    // logs; a Slack user id landing in them is a leak with no upside (#95).
    expect(everything).not.toContain("U0ASKER");
    expect(everything).not.toContain("b9d5a2f0");
  });

  it("omits the header entirely for an upstream with no credential", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}) });
    const upstreamWithoutCredential: McpServer = {
      name: "internal",
      transport: "http",
      url: fake.url,
      tool: [{ name: "list_prs" }]
    };
    const result = await dispatcher.dispatch(callTo(), upstreamWithoutCredential, LIMITS);

    expect(result.outcome).toBe("ran");
    expect(fake.received[0]?.authorization).toBeUndefined();
  });

  // A 404 from a tool is a result the model may recover from, not a refusal
  // (nothing was denied) and not a proxy error (nothing broke).
  it("passes a non-2xx back as an error result, not a refusal", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { status: 404, raw: "no such repo" } : null);
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("HTTP 404");
    expect(result.outcome === "ran" && result.result.content).toContain("no such repo");
  });

  it("reads an event-stream reply as readily as a JSON one", async () => {
    fake = await startFakeMcpServer({ framing: "sse" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS)).toEqual({
      outcome: "ran",
      result: { content: "called list_prs", isError: false }
    });
  });
});

describe("a credential the vault cannot resolve", () => {
  it("refuses by name", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ other: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS)).toEqual({
      outcome: "refused",
      refusal: { reason: "credential_unresolved", credential: CRED }
    });
  });

  // The acceptance criterion that matters most here: the refusal happens before
  // anything is opened, so the upstream never learns the call existed — not
  // even through a discovery probe, which now precedes every first call.
  it("opens no connection, not even to discover", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}) });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(fake.received).toEqual([]);
  });

  it("logs the credential by name and never a value", async () => {
    fake = await startFakeMcpServer();
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url, { credential: "absent_credential" }), LIMITS);

    expect(lines.join("")).toContain("absent_credential");
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("an upstream that cannot be served", () => {
  it("answers unavailable for a stdio transport, which is not a denial", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), stdioServer(), LIMITS)).toEqual({ outcome: "unavailable" });
    expect(fake.received).toEqual([]);
  });

  it("resolves no credential for an upstream it cannot serve", async () => {
    let looked = 0;
    const counting: Vault = {
      lookup: () => {
        looked += 1;
        return { status: "missing" };
      },
      size: 0
    };
    await createHttpDispatcher({ vault: counting }).dispatch(callTo(), stdioServer(), LIMITS);
    expect(looked).toBe(0);
  });

  // An oauth upstream against a proxy with no token store: fail closed, the
  // grant has not been run. Nothing was denied and nothing was dialled.
  it("answers unavailable for an oauth upstream when no token store exists", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const declared: McpServer = {
      name: "github",
      transport: "http",
      url: fake.url,
      credential: "notion_grant",
      tool: [{ name: "list_prs" }],
      auth: { scheme: "oauth", issuer: "https://as.example", scopes: [] }
    };

    expect(await dispatcher.dispatch(callTo(), declared, LIMITS)).toEqual({
      outcome: "unavailable",
      reason: "no_grant"
    });
    expect(fake.received).toEqual([]);
  });
});

// The token engine on the serving path (#256). The store is real, in a temp
// dir; the issuer is the fake over a real socket; the upstream demands the
// token the issuer just minted, which is the positive control that makes the
// negative assertions below evidence rather than vacuity.
describe("an oauth upstream", () => {
  const GRANT = "notion_grant";
  let issuer: FakeTokenIssuer | undefined;
  let tokenDir: string | undefined;
  let tokens: FileTokenStore | undefined;

  afterEach(async () => {
    await issuer?.close();
    issuer = undefined;
    tokens?.close();
    tokens = undefined;
    if (tokenDir !== undefined) rmSync(tokenDir, { recursive: true, force: true });
    tokenDir = undefined;
  });

  async function grantSeededTokens(issuerUrl: string, refreshToken: string): Promise<FileTokenStore> {
    tokenDir = mkdtempSync(join(tmpdir(), "libero-dispatcher-oauth-"));
    const parsed = parseVaultKey(randomBytes(32).toString("base64"));
    if (!parsed.ok) throw new Error("fixture key failed to parse");
    tokens = openTokenStore({ vaultFile: join(tokenDir, "vault.enc"), key: parsed.key });
    await tokens.putGrant(GRANT, {
      issuer: issuerUrl,
      clientId: "https://getlibero.com/client.json",
      refreshToken,
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_000_000
    });
    return tokens;
  }

  function oauthServer(url: string, issuerUrl: string): McpServer {
    return {
      name: "github",
      transport: "http",
      url,
      credential: GRANT,
      tool: [{ name: "list_prs" }],
      auth: { scheme: "oauth", issuer: issuerUrl, scopes: ["mcp.read"] }
    };
  }

  it("mints a token and serves the call end to end", async () => {
    issuer = await startFakeTokenIssuer();
    const store = await grantSeededTokens(issuer.url, issuer.currentRefreshToken);
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}), tokens: store });

    const result = await dispatcher.dispatch(callTo(), oauthServer(fake.url, issuer.url), LIMITS);

    expect(result.outcome).toBe("ran");
    expect(issuer.tokenRequests).toHaveLength(1);
    // The positive control: the minted token arrived at the upstream, on
    // every request the connection made.
    expect(fake.received).not.toHaveLength(0);
    for (const request of fake.received) {
      expect(request.authorization).toBe(`Bearer ${issuer.accessTokens[0] ?? ""}`);
    }
  });

  it("answers unavailable for a dead grant, and the upstream never learns", async () => {
    issuer = await startFakeTokenIssuer();
    const store = await grantSeededTokens(issuer.url, "rt_stale_stolen");
    fake = await startFakeMcpServer();
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}), tokens: store, logger });

    const result = await dispatcher.dispatch(callTo(), oauthServer(fake.url, issuer.url), LIMITS);

    expect(result).toEqual({ outcome: "unavailable", reason: "grant_dead" });
    expect(fake.received).toEqual([]);
    // The theft signal, by name, plus the call that went unserved.
    expect(lines.join("")).toContain("invalid_grant");
    expect(lines.join("")).toContain("dispatch_grant_unavailable");
  });

  // The scheme selects the store, in both directions and with no fallback.
  it("never consults the vault for an oauth upstream", async () => {
    issuer = await startFakeTokenIssuer();
    const store = await grantSeededTokens(issuer.url, issuer.currentRefreshToken);
    fake = await startFakeMcpServer();
    let looked = 0;
    const counting: Vault = {
      lookup: () => {
        looked += 1;
        return { status: "found", secret: secretOf(SECRET) };
      },
      size: 1
    };

    const result = await createHttpDispatcher({ vault: counting, tokens: store }).dispatch(
      callTo(),
      oauthServer(fake.url, issuer.url),
      LIMITS
    );

    expect(result.outcome).toBe("ran");
    expect(looked).toBe(0);
  });

  it("never consults the token store for a bearer upstream", async () => {
    fake = await startFakeMcpServer();
    let reads = 0;
    const counting: FileTokenStore = {
      read: () => {
        reads += 1;
        return { status: "missing", reason: "absent" };
      },
      rotate: () => Promise.resolve(),
      putGrant: () => Promise.resolve(),
      close: () => undefined,
      size: 0
    };

    const result = await createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), tokens: counting }).dispatch(
      callTo(),
      serverAt(fake.url),
      LIMITS
    );

    expect(result.outcome).toBe("ran");
    expect(reads).toBe(0);
  });

  // The acceptance criterion verbatim: an access token echoed by the upstream
  // comes back redacted, under the credential's name. The minted value enters
  // callUpstream's needle list exactly where the revealed vault value does.
  it("scrubs a minted token an upstream echoes back", async () => {
    issuer = await startFakeTokenIssuer();
    const store = await grantSeededTokens(issuer.url, issuer.currentRefreshToken);
    fake = await startFakeMcpServer({ echoHeaders: "text" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}), tokens: store });

    const result = await dispatcher.dispatch(callTo(), oauthServer(fake.url, issuer.url), LIMITS);

    const written = JSON.stringify(result);
    const minted = issuer.accessTokens[0] ?? "";
    expect(minted).not.toBe("");
    expect(written).not.toContain(minted);
    expect(written).toContain(`[redacted:${GRANT}]`);
  });
});

describe("an upstream that does not answer", () => {
  it("reports a timeout as an error result rather than throwing", async () => {
    const hang = createServer(() => {
      /* accept and never respond */
    });
    await new Promise<void>(resolve => hang.listen(0, "127.0.0.1", resolve));
    const hangOrigin = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;

    try {
      const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), timeoutMs: 50 });
      const result = await dispatcher.dispatch(callTo(), serverAt(hangOrigin), LIMITS);

      expect(result.outcome).toBe("ran");
      expect(result.outcome === "ran" && result.result.isError).toBe(true);
      expect(result.outcome === "ran" && result.result.content).toContain("timed_out");
    } finally {
      hang.closeAllConnections();
      await new Promise<void>(resolve => hang.close(() => resolve()));
    }
  });

  it("reports an unreachable upstream without leaking the credential", async () => {
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    // Port 1 on loopback: nothing listens, so the connection is refused.
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(lines.join("")).toContain("unreachable");
    expect(lines.join("")).not.toContain(SECRET);
  });

  // A handshake failure relays nothing of what came back. The type has no
  // `detail` to put it in, and this is the test that says so from outside.
  // This fake answers 502 to both rungs of the ladder, so what the model is
  // told is that the server speaks nothing we do — which is the true statement
  // about a server that refused the probe and then refused the handshake.
  it("relays no upstream bytes when the handshake is what failed", async () => {
    fake = await startFakeMcpServer();
    fake.respond = () => ({ status: 502, raw: `<html>edge proxy rejected Bearer ${SECRET}</html>` });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    const content = result.outcome === "ran" ? result.result.content : "";

    expect(content).toBe("The tool server does not speak a version of MCP this proxy supports. The call was not made.");
    expect(content).not.toContain("edge proxy");
    expect(content).not.toContain("502");
    expect(content).not.toContain(SECRET);
  });
});

// The pool's permit gate seen from the outside (#159): what a model is told, and
// what an operator finds in the log. The limit's own behaviour is
// mcp-pool.test.ts's and the semaphore's is semaphore.test.ts's.
describe("an upstream already running as many calls as this proxy allows", () => {
  it("tells the model it was not called, without blaming the server", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({
      vault: vaultOf({ [CRED]: SECRET }),
      logger,
      maxUpstreamConcurrency: 1,
      queueWaitMs: 25
    });

    // Two identical calls at a one-permit upstream that answers no `tools/call`.
    // Exactly one of them holds the permit and hangs; the other waits out
    // `queueWaitMs` and gives up. Which is which is a race and does not matter —
    // that is what makes this deterministic without polling for it. `held` is
    // awaited at the end, once the fake is gone and its request has failed.
    const held = dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    // A failure, not a refusal: nothing was denied, and the proxy did not break.
    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toBe(
      "This proxy is already running as many calls to that tool server as it allows, and none finished in time. The call was not made."
    );
    // Not "could not be reached", which would send an operator to check a server
    // that is perfectly healthy and was never asked.
    expect(result.outcome === "ran" && result.result.content).not.toContain("could not be reached");

    // Filed under its own event, so a search for a failing upstream does not
    // turn these up and a search for a saturated one turns up nothing else.
    expect(lines.join("")).toContain("upstream_saturated");
    expect(lines.join("")).not.toContain("upstream_failed");
    expect(lines.join("")).not.toContain(SECRET);

    await dispatcher.close();
    await fake.close();
    fake = undefined;
    await held;
  });

  // At `warn`, not `error`. Saturation at a healthy deployment under load clears
  // on its own, and one error line per queued call is how a working system pages
  // somebody at three in the morning.
  it("writes the line at warn rather than error", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({
      vault: vaultOf({ [CRED]: SECRET }),
      logger,
      maxUpstreamConcurrency: 1,
      queueWaitMs: 25
    });

    const held = dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    const saturated = lines.filter(line => line.includes("upstream_saturated"));
    expect(saturated).not.toHaveLength(0);
    for (const line of saturated) {
      expect(JSON.parse(line)).toMatchObject({ level: "warn", reason: "busy" });
    }

    await dispatcher.close();
    await fake.close();
    fake = undefined;
    await held;
  });
});

// Shutdown reaches `failureText` through `connect_failed` since #159: the pool
// opens its limiters so a queued call is woken rather than stranded, and what it
// wakes into is a client that has already flipped closed. That arm's default
// sentence blames the upstream, which is the wrong party for a server nobody
// asked anything.
describe("a call queued for a permit when the proxy shuts down", () => {
  it("is told the proxy is shutting down, not that the server was unreachable", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/call" });
    const dispatcher = createHttpDispatcher({
      vault: vaultOf({ [CRED]: SECRET }),
      maxUpstreamConcurrency: 1,
      // Long enough that the wait cannot be what ends this call: the close is.
      queueWaitMs: 30_000
    });

    const held = dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    // Reaches the fake, so the permit is spoken for before the second call asks.
    await until(() => fake?.callsTo("tools/call").length === 1, "the upstream to be saturated");
    const queued = dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    await dispatcher.close();
    const result = await queued;

    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.content).toBe(
      "The proxy is shutting down. The call was not made."
    );
    expect(result.outcome === "ran" && result.result.content).not.toContain("could not be reached");

    await fake.close();
    fake = undefined;
    await held;
  });
});

describe("a server this proxy cannot speak to", () => {
  it("says so rather than calling at a version nobody agreed on", async () => {
    fake = await startFakeMcpServer({ supportedVersions: ["2025-03-26", "2025-06-18"] });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("does not speak a version of MCP");
    expect(fake.callsTo("tools/call")).toHaveLength(0);
    expect(lines.join("")).toContain("unsupported_protocol");
  });
});

describe("an upstream asking for more input", () => {
  // MRTR replaced server-initiated sampling and elicitation. Answering means
  // the proxy speaking for a channel with no sheet entry and no click behind
  // it, so the call is abandoned and the model is told why.
  it("is refused, and the model is told rather than left guessing", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: completeResult({
              resultType: "input_required",
              // A conformant one: `inputRequests` is a map keyed by an
              // identifier the server assigns, not a bare marker. A malformed
              // one is refused too, but as a protocol error — which would let
              // this case pass without exercising the refusal it is about.
              inputRequests: {
                ask: {
                  method: "sampling/createMessage",
                  params: { messages: [{ role: "user", content: { type: "text", text: "who?" } }], maxTokens: 64 }
                }
              }
            }) } }
        : null;
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("does not answer for a channel");
    expect(lines.join("")).toContain("mcp_input_required");
  });
});

describe("a schema too deep to scan for header declarations", () => {
  // The call-path half of the catalog's degrade rule. A definition the catalog
  // could not produce is a thin catalog, not a failed call — the call still
  // goes out, with no mirrored headers. Before the guard, the scan's
  // RangeError surfaced here and was answered "the call was made and no
  // result came back" with a `ran` audit row, for a call never dispatched.
  it("still dispatches the call, without mirrored headers", async () => {
    // Raw bytes, not a catalog object — the fake's own JSON.stringify would
    // overflow first on a small-stacked CI worker; mcp-catalog.test.ts's twin
    // case says the whole of it.
    const depth = 60_000;
    const deep = '{"type":"object","properties":{"a":'.repeat(depth) + '{"type":"string"}' + "}}".repeat(depth);
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? {
            raw: `{"jsonrpc":"2.0","id":${String(request.rpc.id ?? 0)},"result":{"resultType":"complete","ttlMs":0,"cacheScope":"public","tools":[{"name":"list_prs","description":"Lists PRs.","inputSchema":${deep}}]}}`
          }
        : null;
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(false);
    expect(result.outcome === "ran" && result.result.content).toBe("called list_prs");
  });
});

describe("a credential revoked mid-session", () => {
  // `unauthorized` is reachable on the call path, not only at connect: the
  // upstream forgets the session, the reopen's re-initialize is answered 401.
  // The default sentence's clauses are both false here — the 404 precedes
  // dispatch, so the tool never ran — and the wording matches the connect-time
  // case because the operator's fix is the same either way.
  it("says the credential was rejected, not that the call was made", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const warm = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    expect(warm.outcome === "ran" && warm.result.isError).toBe(false);

    fake.expireSessions();
    fake.respond = request =>
      request.rpc?.method === "initialize" ? { status: 401, raw: "token revoked" } : null;

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    const content = result.outcome === "ran" ? result.result.content : "";

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(content).toBe("The tool server rejected this proxy's credential for it. The call was not made.");
    expect(content).not.toContain("token revoked");
  });
});

describe("what the proxy writes down", () => {
  it("logs the destination host and the credential name, never the value", async () => {
    fake = await startFakeMcpServer();
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    const written = lines.join("");
    expect(written).toContain("127.0.0.1");
    expect(written).toContain(CRED);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("ghp_");
    expect(written).not.toContain("Bearer");
  });

  it("keeps an echoing upstream out of the log", async () => {
    fake = await startFakeMcpServer({ echoHeaders: "text" });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(lines.join("")).not.toContain(SECRET);
  });

  // The field earns its place now that there are two values: it answers the
  // question an operator asks when an upstream misbehaves — did the proxy fall
  // back? — and a fleet-wide count of `legacy` is how this fallback's eventual
  // removal gets scheduled.
  each(["stateless", "legacy"] as const)("names %s as the protocol it served the call over", async protocol => {
    fake = await startFakeMcpServer({ protocol });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(lines.map(line => JSON.parse(line) as { event: string; protocol?: string })).toContainEqual(
      expect.objectContaining({ event: "upstream_call", protocol })
    );
  });

  // The handshake makes three more requests than the stateless path, and the
  // session id is a new upstream-authored value that gets written back out.
  // Neither is a place the credential may surface.
  it("keeps an echoing legacy upstream out of the log, session and all", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", echoHeaders: "text", echoAuthAsSessionId: true });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    // Not vacuous: the upstream really did receive it, on every request.
    expect(fake.received).not.toHaveLength(0);
    for (const request of fake.received) expect(request.authorization).toBe(`Bearer ${SECRET}`);

    const written = lines.join("");
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("ghp_");
    expect(written).not.toContain("Bearer");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("an upstream that echoes its own auth header", () => {
  // The leak class the redaction pass exists to close. The fake reflects the
  // header it received, which is what a debug endpoint or a verbose error
  // handler does in practice.
  it("does not hand the value back in the result", async () => {
    fake = await startFakeMcpServer({ echoHeaders: "text" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome).toBe("ran");
    const content = result.outcome === "ran" ? result.result.content : "";
    // The upstream really did receive it — otherwise this asserts nothing.
    expect(fake.callsTo("tools/call")[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(SECRET);
    expect(content).not.toContain("ghp_");
  });

  // The shape that defeated redaction before #149: this client parses the body
  // it is handed, and a parse un-escapes what the scan missed.
  it("does not hand it back JSON-escaped either", async () => {
    fake = await startFakeMcpServer({ echoHeaders: "json-escaped" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    const content = result.outcome === "ran" ? result.result.content : "";
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(SECRET);
    expect(content).not.toContain("ghp_");
  });

  it("scrubs it out of an error body too", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? { status: 500, raw: `request failed: ${request.authorization ?? ""}` }
        : null;
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).not.toContain(SECRET);
  });

  it("keeps it out of a response header the client reads", async () => {
    fake = await startFakeMcpServer({ echoIntoResponseHeader: true });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("shutting down", () => {
  // Not awaited, on purpose: the refusal has to hold from the instant `close()`
  // is entered rather than from when its session terminations resolve.
  it("answers rather than opening a connection after close", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const closing = dispatcher.close();

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("shutting down");
    expect(fake.received).toEqual([]);
    await closing;
  });

  it("is idempotent", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}) });
    await dispatcher.close();
    await expect(dispatcher.close()).resolves.toBeUndefined();
  });

  // The line means the sessions are gone rather than that they were asked to
  // go, which is why it is written after the terminations rather than before.
  it("terminates a legacy session before it resolves, and says so afterwards", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);
    expect(fake.liveSessions.size).toBe(1);

    await dispatcher.close();

    expect(fake.received.filter(request => request.method === "DELETE")).toHaveLength(1);
    expect(fake.liveSessions.size).toBe(0);
    expect(lines.map(line => JSON.parse(line) as { event: string }).at(-1)).toMatchObject({
      event: "mcp_pool_closed"
    });
  });
});

describe("fail-closed", () => {
  // A redaction that cannot be performed must not be converted into a served
  // result. It has to escape the catch that handles transport failures.
  it("rethrows a redaction failure instead of answering with a result", async () => {
    fake = await startFakeMcpServer();
    // An empty stored value: rejected by `vault set`, reachable only from a
    // corrupt or hand-edited vault, and exactly the case where quiet nonsense
    // would be worse than no answer.
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: "" }) });

    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS)).rejects.toBeInstanceOf(RedactionError);
  });

  // A rejected discovery must not be cached as a rejected promise, or every
  // later call on this upstream would await the same dead one.
  it("does not poison the client with a rejected discovery", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: "" }) });

    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS)).rejects.toBeInstanceOf(RedactionError);
    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS)).rejects.toBeInstanceOf(RedactionError);
  });

  it("still converts a transport failure into a result, which is a tool failing", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"), LIMITS);

    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
  });
});

// #151's two bounds, met at the seam where a call actually crosses a socket.
// outbound.test.ts proves the *mechanism* — the read stops and cancels — against
// a stubbed stream; these prove the *outcome* a model and an operator get, over
// loopback. The fake writes its reply with a single `end()` and cannot drip a
// body, and does not need to: a multi-megabyte write still arrives at the reader
// as many chunks.
describe("the two bounds on what comes back", () => {
  /** A `tools/call` reply carrying one text block of `size` characters. */
  const answering = (size: number) => (request: { rpc: { id?: unknown; method?: unknown } | null }) =>
    request.rpc?.method === "tools/call"
      ? {
          message: {
            jsonrpc: "2.0",
            id: request.rpc.id,
            result: completeResult({ content: [{ type: "text", text: "x".repeat(size) }] })
          }
        }
      : null;

  // The channel's bound. A large answer is usually still a useful one, so it is
  // truncated and says so rather than being refused.
  it("truncates a result past the channel's bound and names the truncation", async () => {
    fake = await startFakeMcpServer();
    fake.respond = answering(200_000);
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), { maxResultChars: 1_000 });

    expect(result.outcome).toBe("ran");
    const content = result.outcome === "ran" ? result.result.content : "";
    expect(content).toContain("[result truncated: 1000 of 200000 characters]");
    // A truncated answer is still an answer: the tool did not fail.
    expect(result.outcome === "ran" && result.result.isError).toBe(false);
  });

  // The deployment's bound. Nothing is decoded, so there is no partial answer to
  // give — but the call did reach the upstream, and the sentence says so rather
  // than claiming the call was never made.
  it("refuses a body past the deployment's bound, after the tool has run", async () => {
    fake = await startFakeMcpServer();
    fake.respond = answering(200_000);
    const dispatcher = createHttpDispatcher({
      vault: vaultOf({ [CRED]: SECRET }),
      maxResponseBytes: 8_192
    });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toBe(
      "The tool server's answer was larger than this proxy will accept. The call was made and the answer was discarded."
    );
    // The honest part of that sentence: the upstream did receive the call, so a
    // model must not be told it was never made.
    expect(fake.callsTo("tools/call")).not.toHaveLength(0);
  });

  // The bounds are layered rather than alternatives, and the wire one has to sit
  // well above the content one or the ordinary large result never gets to be a
  // truncated one.
  it("truncates rather than refusing when the body fits but the result does not", async () => {
    fake = await startFakeMcpServer();
    fake.respond = answering(50_000);
    const dispatcher = createHttpDispatcher({
      vault: vaultOf({ [CRED]: SECRET }),
      maxResponseBytes: 4_194_304
    });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), { maxResultChars: 2_000 });

    expect(result.outcome === "ran" && result.result.isError).toBe(false);
    expect(result.outcome === "ran" && result.result.content).toContain("[result truncated: 2000 of 50000");
  });

  // A handshake runs under MAX_CONTROL_BODY_BYTES, well below the configured
  // cap, and reports its own sentence: "could not be reached" would be false
  // about a server that answered at length.
  it("names an oversized handshake as one, not as an unreachable server", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "server/discover" ? { raw: `{"pad":"${"z".repeat(200_000)}"}` } : null;
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url), LIMITS);

    expect(result.outcome === "ran" && result.result.content).toBe(
      "The tool server's handshake was larger than this proxy will accept. The call was not made."
    );
  });
});
