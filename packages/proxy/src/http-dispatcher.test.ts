import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer, ResolvedToolCall } from "@getlibero/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpDispatcher } from "./http-dispatcher.js";
import { createJsonLogger } from "./log.js";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import { RedactionError } from "./redact.js";
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

/** Captures every log line the dispatcher writes, for the leak assertions. */
function capturingLogger(): { lines: string[]; logger: ReturnType<typeof createJsonLogger> } {
  const lines: string[] = [];
  return { lines, logger: createJsonLogger(line => lines.push(line)) };
}

describe("serving a call", () => {
  it("delivers the real secret to the upstream", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    const result = await dispatcher.dispatch(callTo(), upstreamWithoutCredential);

    expect(result.outcome).toBe("ran");
    expect(fake.received[0]?.authorization).toBeUndefined();
  });

  // A 404 from a tool is a result the model may recover from, not a refusal
  // (nothing was denied) and not a proxy error (nothing broke).
  it("passes a non-2xx back as an error result, not a refusal", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { status: 404, raw: "no such repo" } : null);
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));
    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("HTTP 404");
    expect(result.outcome === "ran" && result.result.content).toContain("no such repo");
  });

  it("reads an event-stream reply as readily as a JSON one", async () => {
    fake = await startFakeMcpServer({ framing: "sse" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(fake.url))).toEqual({
      outcome: "ran",
      result: { content: "called list_prs", isError: false }
    });
  });
});

describe("a credential the vault cannot resolve", () => {
  it("refuses by name", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ other: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(fake.url))).toEqual({
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
    await dispatcher.dispatch(callTo(), serverAt(fake.url));

    expect(fake.received).toEqual([]);
  });

  it("logs the credential by name and never a value", async () => {
    fake = await startFakeMcpServer();
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url, { credential: "absent_credential" }));

    expect(lines.join("")).toContain("absent_credential");
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("an upstream that cannot be served", () => {
  it("answers unavailable for a stdio transport, which is not a denial", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), stdioServer())).toEqual({ outcome: "unavailable" });
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
    await createHttpDispatcher({ vault: counting }).dispatch(callTo(), stdioServer());
    expect(looked).toBe(0);
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
      const result = await dispatcher.dispatch(callTo(), serverAt(hangOrigin));

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
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"));

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

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));
    const content = result.outcome === "ran" ? result.result.content : "";

    expect(content).toBe("The tool server does not speak a version of MCP this proxy supports. The call was not made.");
    expect(content).not.toContain("edge proxy");
    expect(content).not.toContain("502");
    expect(content).not.toContain(SECRET);
  });
});

describe("a server this proxy cannot speak to", () => {
  it("says so rather than calling at a version nobody agreed on", async () => {
    fake = await startFakeMcpServer({ supportedVersions: ["2025-03-26", "2025-06-18"] });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: { resultType: "input_required" } } }
        : null;
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).toContain("does not answer for a channel");
    expect(lines.join("")).toContain("mcp_input_required");
  });
});

describe("what the proxy writes down", () => {
  it("logs the destination host and the credential name, never the value", async () => {
    fake = await startFakeMcpServer();
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    await dispatcher.dispatch(callTo(), serverAt(fake.url));

    expect(lines.join("")).not.toContain(SECRET);
  });

  // The field earns its place now that there are two values: it answers the
  // question an operator asks when an upstream misbehaves — did the proxy fall
  // back? — and a fleet-wide count of `legacy` is how this fallback's eventual
  // removal gets scheduled.
  it.each(["stateless", "legacy"] as const)("names %s as the protocol it served the call over", async protocol => {
    fake = await startFakeMcpServer({ protocol });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).not.toContain(SECRET);
  });

  it("keeps it out of a response header the client reads", async () => {
    fake = await startFakeMcpServer({ echoIntoResponseHeader: true });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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

    const result = await dispatcher.dispatch(callTo(), serverAt(fake.url));

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
    await dispatcher.dispatch(callTo(), serverAt(fake.url));
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

    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url))).rejects.toBeInstanceOf(RedactionError);
  });

  // A rejected discovery must not be cached as a rejected promise, or every
  // later call on this upstream would await the same dead one.
  it("does not poison the client with a rejected discovery", async () => {
    fake = await startFakeMcpServer();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: "" }) });

    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url))).rejects.toBeInstanceOf(RedactionError);
    await expect(dispatcher.dispatch(callTo(), serverAt(fake.url))).rejects.toBeInstanceOf(RedactionError);
  });

  it("still converts a transport failure into a result, which is a tool failing", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"));

    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
  });
});
