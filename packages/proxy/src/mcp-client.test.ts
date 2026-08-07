import { afterEach, describe, expect, it } from "vitest";
import { type McpClient, createMcpClient } from "./mcp-client.js";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
import { MCP_PROTOCOL_VERSION, METHOD_NOT_FOUND } from "./mcp-protocol.js";
import type { Secret } from "./vault.js";

const VALUE = "ghp_live_token_do_not_log";

/** A stand-in with the same discipline as the real one: only `reveal` yields it. */
function secretOf(value: string): Secret {
  return Object.freeze({
    reveal: () => value,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]"
  }) as Secret;
}

let fake: FakeMcpServer | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function clientFor(
  overrides: Parameters<typeof startFakeMcpServer>[0] = {},
  secret: Secret | undefined = secretOf(VALUE)
): Promise<McpClient> {
  fake = await startFakeMcpServer(overrides);
  return createMcpClient({
    url: fake.url,
    scheme: "bearer",
    secret,
    credentialName: "github_service_account",
    timeoutMs: 2000
  });
}

describe("the round trip", () => {
  it("discovers, calls, and returns the result", async () => {
    const client = await clientFor();
    const outcome = await client.callTool("list_prs", { repo: "libero" });

    expect(outcome).toEqual({ outcome: "called", result: { content: "called list_prs", isError: false } });
    expect(fake?.received.map(r => r.rpc?.method)).toEqual(["server/discover", "tools/call"]);
  });

  it("reads an event-stream reply identically", async () => {
    const client = await clientFor({ framing: "sse" });
    const outcome = await client.callTool("list_prs", {});

    expect(outcome).toEqual({ outcome: "called", result: { content: "called list_prs", isError: false } });
  });

  it("sends the transport's required headers", async () => {
    const client = await clientFor();
    await client.callTool("list_prs", {});

    const call = fake?.callsTo("tools/call")[0];
    expect(call?.headers["mcp-method"]).toBe("tools/call");
    expect(call?.headers["mcp-name"]).toBe("list_prs");
    expect(call?.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(call?.headers["accept"]).toContain("text/event-stream");
  });

  // Discovery is per-upstream, not per-call: the version two ends agreed on
  // does not change under a running process.
  it("discovers once across many calls", async () => {
    const client = await clientFor();
    await client.callTool("list_prs", {});
    await client.callTool("get_issue", {});

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(2);
  });

  it("discovers once for concurrent first calls", async () => {
    const client = await clientFor();
    await Promise.all([client.callTool("a", {}), client.callTool("b", {}), client.callTool("c", {})]);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(3);
  });
});

describe("the credential", () => {
  // Positive first, so nothing below is vacuously true.
  it("reaches the upstream on every request", async () => {
    const client = await clientFor();
    await client.callTool("list_prs", {});

    expect(fake?.received).not.toHaveLength(0);
    for (const request of fake?.received ?? []) {
      expect(request.authorization).toBe(`Bearer ${VALUE}`);
    }
  });

  it("never comes back in a result when the upstream echoes it", async () => {
    const client = await clientFor({ echoHeaders: "text" });
    const outcome = await client.callTool("list_prs", {});

    const content = outcome.outcome === "called" ? outcome.result.content : "";
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(VALUE);
    expect(content).not.toContain("ghp_");
  });

  // The case #149 exists for: the upstream escapes the header, and this client
  // parses the body — so an escaped spelling that survived the scan would be
  // un-escaped on the way to the model.
  it("never comes back when the upstream echoes it JSON-escaped", async () => {
    const client = await clientFor({ echoHeaders: "json-escaped" });
    const outcome = await client.callTool("list_prs", {});

    const content = outcome.outcome === "called" ? outcome.result.content : "";
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(VALUE);
    expect(content).not.toContain("ghp_");
  });

  it.each([['a value with "quotes"', 'ghp_"quoted"_token'], ["a value with \\ backslashes", "ghp_\\back\\slash"]])(
    "survives %s",
    async (_label, value) => {
      fake = await startFakeMcpServer({ echoHeaders: "text" });
      const client = createMcpClient({
        url: fake.url,
        scheme: "bearer",
        secret: secretOf(value),
        credentialName: "c",
        timeoutMs: 2000
      });
      const outcome = await client.callTool("list_prs", {});

      const content = outcome.outcome === "called" ? outcome.result.content : "";
      expect(content).not.toContain(value);
    }
  );

  it("is scrubbed from a response header before anything reads it", async () => {
    const client = await clientFor({ echoIntoResponseHeader: true });
    const outcome = await client.callTool("list_prs", {});

    // The call still works: the framing header is read, and reading it is what
    // makes redacting it matter.
    expect(outcome.outcome).toBe("called");
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
  });

  // The handshake makes three more requests than the stateless path does, and
  // every one of them carries the credential. Positive first, as above: this is
  // what stops the negatives below being vacuous.
  it("reaches the upstream on every request the handshake makes", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {});

    expect(fake?.received.map(r => r.rpc?.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/call"
    ]);
    for (const request of fake?.received ?? []) {
      expect(request.authorization).toBe(`Bearer ${VALUE}`);
    }
  });

  // The header the allowlist newly admits is upstream-authored, and its only
  // use is being written straight back out — so a server that answers with the
  // credential *as* its session id is the case that widening had to survive. It
  // survives structurally: the header goes through the same scrub as the body
  // before it leaves `callUpstream`, so what the client stores and replays is a
  // marker. The upstream then does not recognise it, which is the right
  // outcome, and none of it is the value.
  it("is never replayed as a session id", async () => {
    const client = await clientFor({ protocol: "legacy", echoAuthAsSessionId: true });
    await client.callTool("list_prs", {});

    const replayed = fake?.callsTo("tools/call")[0]?.headers["mcp-session-id"] ?? "";
    expect(replayed).toBe("[redacted:github_service_account]");
    expect(replayed).not.toContain(VALUE);

    // And nothing else on the wire carried it either.
    const everyHeader = (fake?.received ?? []).flatMap(request =>
      Object.entries(request.headers)
        .filter(([name]) => name !== "authorization")
        .map(([, value]) => value)
    );
    expect(everyHeader.join("|")).not.toContain("ghp_");
  });

  it("is absent from an outcome when the handshake itself fails", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request =>
      request.rpc?.method === "initialize"
        ? { status: 500, raw: `{"detail":"Bearer ${VALUE} rejected by edge proxy"}` }
        : null;
    const client = createMcpClient({
      url: fake.url,
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      timeoutMs: 2000
    });

    const outcome = await client.callTool("list_prs", {});
    expect(outcome).toEqual({ outcome: "connect_failed", failure: "unsupported_protocol" });
    expect(JSON.stringify(outcome)).not.toContain("edge proxy");
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
  });

  // The one no other test can make: whatever went wrong, nothing that came
  // back is in what the caller is handed.
  it("is absent from every failure outcome", async () => {
    for (const respond of [
      () => ({ status: 500, raw: `{"error":"upstream said Bearer ${VALUE}"}` }),
      () => ({ raw: `<html>Bearer ${VALUE}</html>` }),
      () => ({ message: { jsonrpc: "2.0", id: 1, error: { code: -1, message: `Bearer ${VALUE}` } } })
    ]) {
      fake = await startFakeMcpServer();
      fake.respond = request => (request.rpc?.method === "tools/call" ? respond() : null);
      const client = createMcpClient({
        url: fake.url,
        scheme: "bearer",
        secret: secretOf(VALUE),
        credentialName: "c",
        timeoutMs: 2000
      });

      const outcome = await client.callTool("list_prs", {});
      expect(JSON.stringify(outcome)).not.toContain(VALUE);
      await fake.close();
      fake = undefined;
    }
  });
});

describe("when discovery fails", () => {
  // The acceptance criterion is specific: nothing an upstream said during the
  // handshake reaches the caller. A 500 from an auth proxy is as likely to be
  // an error page with the request echoed in it as anything MCP — and this now
  // covers *both* rungs of the ladder, since a 500 to `server/discover` earns a
  // fallback attempt and this fake answers that one the same way.
  it("relays no upstream bytes, whatever came back", async () => {
    fake = await startFakeMcpServer();
    fake.respond = () => ({ status: 500, raw: `{"detail":"Bearer ${VALUE} rejected by edge proxy"}` });
    const client = createMcpClient({
      url: fake.url,
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      timeoutMs: 2000
    });

    const outcome = await client.callTool("list_prs", {});

    expect(outcome).toEqual({ outcome: "connect_failed", failure: "unsupported_protocol" });
    // `connect_failed` has no `detail` field to put them in, which is the type
    // rather than the caller doing the work.
    expect("detail" in outcome).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("edge proxy");
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
  });

  it("never sends the call", async () => {
    fake = await startFakeMcpServer();
    fake.respond = () => ({ status: 503, raw: "" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    await client.callTool("list_prs", {});

    expect(fake.callsTo("tools/call")).toHaveLength(0);
  });

  it("reports an unreachable upstream without a socket", async () => {
    const client = createMcpClient({
      url: "http://127.0.0.1:1/mcp",
      scheme: "bearer",
      secret: undefined,
      timeoutMs: 2000
    });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "connect_failed", failure: "unreachable" });
  });

  // A transient outage must not disable an upstream for the process lifetime,
  // which is what caching a failed discovery would do.
  it("retries discovery on the next call rather than caching the failure", async () => {
    fake = await startFakeMcpServer();
    let failing = true;
    fake.respond = () => (failing ? { status: 503, raw: "" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect((await client.callTool("list_prs", {})).outcome).toBe("connect_failed");
    failing = false;
    expect((await client.callTool("list_prs", {})).outcome).toBe("called");
  });
});

describe("version negotiation", () => {
  it("fails closed against a server that speaks nothing we do", async () => {
    const client = await clientFor({ supportedVersions: ["2025-03-26", "2025-06-18"] });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake?.callsTo("tools/call")).toHaveLength(0);
  });

  // A server that refused the probe and then refused the handshake has said it
  // twice, and there is no third rung.
  it("names a server that answers neither rung as unsupported", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "server/discover"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, error: { code: METHOD_NOT_FOUND, message: "unknown" } } }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake.callsTo("tools/call")).toHaveLength(0);
  });
});

describe("the ladder", () => {
  it("falls back to the handshake and completes the call", async () => {
    const client = await clientFor({ protocol: "legacy" });

    expect(await client.callTool("list_prs", { repo: "libero" })).toEqual({
      outcome: "called",
      result: { content: "called list_prs", isError: false }
    });
    expect(fake?.received.map(r => r.rpc?.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/call"
    ]);
  });

  // **The attempt is the discriminator, not the code.** A server old enough to
  // need `initialize` refuses `server/discover` with whatever its framework
  // does with an unrouted method, and no one of those shapes is reliably the
  // signal. A test that only ever saw one of them would let a code check creep
  // back in unnoticed.
  it.each(["rpc_error", "http_400", "http_404"] as const)("falls back whatever shape the refusal took (%s)", async refusal => {
    const client = await clientFor({ protocol: "legacy", discoverRefusal: refusal });

    expect((await client.callTool("list_prs", {})).outcome).toBe("called");
    expect(fake?.callsTo("initialize")).toHaveLength(1);
  });

  // The bug this catches is not hypothetical: before the wire context existed,
  // `requestHeaders` hardcoded the pinned constant, and a server receiving a
  // version it did not agree to MUST answer 400 — so every legacy call would
  // have been refused.
  it("speaks the version the server named, not the one it was pinned to", async () => {
    const client = await clientFor({ protocol: "legacy", legacyVersion: "2025-06-18" });
    await client.callTool("list_prs", {});

    const call = fake?.callsTo("tools/call")[0];
    expect(call?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(call?.headers["mcp-session-id"]).toBe("session-1");
    // The `2026-07-28` transport headers are that revision's own.
    expect("mcp-method" in (call?.headers ?? {})).toBe(false);
  });

  it("names no version on the request that establishes one", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {});

    expect("mcp-protocol-version" in (fake?.callsTo("initialize")[0]?.headers ?? {})).toBe(false);
  });

  // A server SHOULD NOT process other requests until the acknowledgement
  // arrives, so a `tools/call` racing it is one the server may refuse.
  it("acknowledges the handshake before it calls anything, carrying the session", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {});

    const methods = fake?.received.map(r => r.rpc?.method) ?? [];
    expect(methods.indexOf("notifications/initialized")).toBeLessThan(methods.indexOf("tools/call"));
    expect(fake?.callsTo("notifications/initialized")[0]?.headers["mcp-session-id"]).toBe("session-1");
  });

  it("reads the handshake over an event stream identically", async () => {
    const client = await clientFor({ protocol: "legacy", framing: "sse" });

    expect((await client.callTool("list_prs", {})).outcome).toBe("called");
  });

  // A legacy server that assigns no session is an ordinary one, not a broken
  // one — so the calls that follow carry none and nothing goes looking.
  it("carries no session when the server assigned none", async () => {
    const client = await clientFor({ protocol: "legacy", sessions: false });

    expect((await client.callTool("list_prs", {})).outcome).toBe("called");
    for (const request of fake?.received ?? []) {
      expect("mcp-session-id" in request.headers).toBe(false);
    }
  });

  it("settles the protocol once and re-probes nothing", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {});
    await client.callTool("get_issue", {});

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("initialize")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(2);
  });

  it("runs the ladder once for concurrent first calls", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await Promise.all([client.callTool("a", {}), client.callTool("b", {}), client.callTool("c", {})]);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("initialize")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(3);
  });

  it("reports which protocol it settled on", async () => {
    const legacy = await clientFor({ protocol: "legacy" });
    expect(legacy.protocol).toBeUndefined();
    await legacy.callTool("list_prs", {});
    expect(legacy.protocol).toBe("legacy");
    await fake?.close();

    const stateless = await clientFor();
    await stateless.callTool("list_prs", {});
    expect(stateless.protocol).toBe("stateless");
  });
});

// **Nothing answered, so there is nothing to fall back from.** A timeout or a
// refused connection says nothing about which protocol a server speaks, and
// attempting the handshake would only double the wait on an upstream that is
// down.
describe("when nothing answered the probe", () => {
  it("never attempts the handshake against a server that does not reply", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", hangOn: "server/discover" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 150 });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "connect_failed", failure: "timed_out" });
    expect(fake.callsTo("initialize")).toHaveLength(0);
    expect(fake.received).toHaveLength(1);
  });

  it("never attempts the handshake against a host nothing listens on", async () => {
    const client = createMcpClient({
      url: "http://127.0.0.1:1/mcp",
      scheme: "bearer",
      secret: undefined,
      timeoutMs: 2000
    });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "connect_failed", failure: "unreachable" });
  });

  it("never attempts the handshake against a redirect", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request =>
      request.rpc?.method === "server/discover" ? { status: 307, headers: { location: "http://127.0.0.1:1/" } } : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "connect_failed", failure: "redirected" });
    expect(fake.callsTo("initialize")).toHaveLength(0);
  });

  // The deliberate non-trigger: a well-formed request answered 200 with bytes
  // that are not MCP is a broken server or an edge proxy rather than an old
  // one, and it has already shown it is not speaking the protocol.
  it("reports an unreadable probe answer without a second attempt", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request => (request.rpc?.method === "server/discover" ? { raw: "<html>hello</html>" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "connect_failed", failure: "protocol_error" });
    expect(fake.callsTo("initialize")).toHaveLength(0);
  });
});

describe("when the call fails", () => {
  it("relays a tool's own error flag as a result", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: { resultType: "complete", content: [{ type: "text", text: "no such repo" }], isError: true }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "called",
      result: { content: "no such repo", isError: true }
    });
  });

  it("relays a JSON-RPC error with its code", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              error: { code: METHOD_NOT_FOUND, message: "no tool named list_prs" }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "call_failed",
      failure: "rpc_error",
      code: METHOD_NOT_FOUND,
      detail: "no tool named list_prs"
    });
  });

  it("reports an answer it cannot read as MCP", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { raw: "<html>502</html>" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {});
    expect(outcome).toMatchObject({ outcome: "call_failed", failure: "protocol_error" });
  });

  it("relays a non-2xx with its status", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { status: 429, raw: "slow down" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "call_failed",
      failure: "http_error",
      status: 429,
      detail: "slow down"
    });
  });

  // The one relay `parseRpcResponse` never bounds, bounded where it is born:
  // an endpoint answering its error in megabytes should not spend the
  // channel's tokens saying so.
  it("truncates a non-2xx body rather than relaying a wall of text", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call" ? { status: 500, raw: "x".repeat(100_000) } : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {});

    expect(outcome).toMatchObject({ outcome: "call_failed", failure: "http_error", status: 500 });
    expect(outcome.outcome === "call_failed" && (outcome.detail?.length ?? 0)).toBeLessThan(400);
  });
});

describe("an upstream asking for more input", () => {
  // MRTR replaced server-initiated sampling and elicitation. Answering one
  // means the proxy speaking for a channel — spending its model budget, or
  // supplying something nobody was asked — with no sheet entry and no click.
  it("is refused rather than satisfied", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: { resultType: "input_required", inputRequests: [{ type: "sampling" }] }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({ outcome: "call_failed", failure: "input_required" });
  });

  // Retrying is precisely how the round trip would be completed, so not
  // retrying is the refusal rather than an implementation detail of it.
  it("is not retried", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: { resultType: "input_required" } } }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    await client.callTool("list_prs", {});

    expect(fake.callsTo("tools/call")).toHaveLength(1);
  });
});

describe("what is never retried", () => {
  // Every one of these can mean the call ran and the answer was lost. Replaying
  // a `tools/call` is how one write becomes two. Run on both dialects, because
  // the legacy path is the one that now has a replay at all — and the point is
  // that it is the *only* signal that gets one.
  it.each([
    ["a 500", { status: 500, raw: "" }],
    ["a malformed body", { raw: "not json" }],
    ["a JSON-RPC error", { message: { jsonrpc: "2.0", id: 2, error: { code: -1, message: "x" } } }]
  ])("sends exactly one tools/call after %s", async (_label, reply) => {
    for (const protocol of ["stateless", "legacy"] as const) {
      fake = await startFakeMcpServer({ protocol });
      fake.respond = request => (request.rpc?.method === "tools/call" ? reply : null);
      const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

      await client.callTool("list_prs", {});

      expect(fake.callsTo("tools/call")).toHaveLength(1);
      await fake.close();
      fake = undefined;
    }
  });
});

// **The one signal this client replays, and only on the legacy path.** A 404
// answering a request that carried a session id is the spec's own way of
// saying the session is gone, and it is generated before the server dispatches
// anything — so the tool did not run and there is no write to double.
describe("when the session is lost", () => {
  /** Expire the live session as the next `tools/call` arrives, at most `times` times. */
  function expireOn(server: FakeMcpServer, times: number): void {
    let left = times;
    server.respond = request => {
      if (request.rpc?.method === "tools/call" && left > 0) {
        left -= 1;
        // `respond` runs before the default handler, so the request that
        // triggered this is the one that finds no live session and 404s.
        server.expireSessions();
      }
      return null;
    };
  }

  it("reconnects once mid-task and the call completes", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });
    expireOn(fake, 1);

    expect((await client.callTool("list_prs", {})).outcome).toBe("called");
    expect(fake.callsTo("initialize")).toHaveLength(2);
    expect(fake.callsTo("tools/call")).toHaveLength(2);

    const [first, second] = fake.callsTo("tools/call");
    expect(second?.headers["mcp-session-id"]).not.toBe(first?.headers["mcp-session-id"]);
  });

  it("gives the model an error rather than a loop against a server that forgets every session", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });
    expireOn(fake, Number.MAX_SAFE_INTEGER);

    expect(await client.callTool("list_prs", {})).toMatchObject({
      outcome: "call_failed",
      failure: "http_error",
      status: 404
    });
    // Two attempts and no third: the budget is the structure, not a counter.
    expect(fake.callsTo("tools/call")).toHaveLength(2);
    expect(fake.callsTo("initialize")).toHaveLength(2);
  });

  // **The load-bearing negative.** A 404 to a client that sent no session id is
  // a wrong url — the sheet naming an endpoint that does not exist — and
  // reconnecting would not make the url right while doubling every call made
  // against a typo.
  it("treats a 404 from a client with no session as the wrong url it is", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", sessions: false });
    fake.respond = request => (request.rpc?.method === "tools/call" ? { status: 404, raw: "no such path" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toMatchObject({ failure: "http_error", status: 404 });
    expect(fake.callsTo("tools/call")).toHaveLength(1);
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });

  it("treats a 404 to the handshake itself as a refusal rather than a loss", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request => (request.rpc?.method === "initialize" ? { status: 404, raw: "" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {})).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });

  // The generation check and the single flight, together. Round-trip count is
  // the visible half; the half that matters is that a straggler's 404 does not
  // invalidate a session two other calls were about to use.
  it("costs one re-initialize when three calls lose the session at once", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect((await client.callTool("warm", {})).outcome).toBe("called");
    fake.expireSessions();

    const outcomes = await Promise.all([
      client.callTool("a", {}),
      client.callTool("b", {}),
      client.callTool("c", {})
    ]);
    for (const outcome of outcomes) expect(outcome.outcome).toBe("called");

    // The original handshake plus exactly one more, not one per loser.
    expect(fake.callsTo("initialize")).toHaveLength(2);
    // One warm-up, three that 404'd, three that succeeded.
    expect(fake.callsTo("tools/call")).toHaveLength(7);
  });
});

describe("listing an upstream's catalog", () => {
  it("lists over both dialects, up the same ladder", async () => {
    for (const protocol of ["stateless", "legacy"] as const) {
      fake = await startFakeMcpServer({ protocol });
      const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

      const outcome = await client.listTools(undefined, undefined);

      expect(outcome).toMatchObject({ outcome: "listed", nextCursor: null });
      expect(outcome.outcome === "listed" && outcome.tools.map(tool => tool.name)).toEqual([
        "list_prs",
        "merge_pr"
      ]);
      await fake.close();
      fake = undefined;
    }
  });

  it("names no tool in the transport headers, because a listing names none", async () => {
    const client = await clientFor();
    await client.listTools(undefined, undefined);

    const listing = fake?.callsTo("tools/list")[0];
    expect(listing?.headers["mcp-method"]).toBe("tools/list");
    expect("mcp-name" in (listing?.headers ?? {})).toBe(false);
  });

  it("sends the negotiated revision to a legacy server, never the pinned constant", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", legacyVersion: "2025-06-18" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    await client.listTools(undefined, undefined);

    // A server receiving a version it did not agree to MUST answer 400, so the
    // pinned constant here would have every legacy listing refused.
    const listing = fake.callsTo("tools/list")[0];
    expect(listing?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(listing?.headers["mcp-protocol-version"]).not.toBe(MCP_PROTOCOL_VERSION);
  });

  it("walks pages by the cursor the server issued", async () => {
    const client = await clientFor({ pageSize: 1 });

    const first = await client.listTools(undefined, undefined);
    expect(first).toMatchObject({ outcome: "listed", nextCursor: "1" });

    const second = await client.listTools("1", undefined);
    expect(second).toMatchObject({ outcome: "listed", nextCursor: null });
    expect(second.outcome === "listed" && second.tools.map(tool => tool.name)).toEqual(["merge_pr"]);
  });

  // The failure members have no `detail` field to fill in. A failing listing
  // produces no model-facing text, so an upstream byte here could only ever be
  // written down by the process holding every credential.
  it("relays a status and a code, and never an upstream byte", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list" ? { status: 500, raw: `boom ${VALUE}` } : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: secretOf(VALUE), timeoutMs: 2000 });

    const outcome = await client.listTools(undefined, undefined);

    expect(outcome).toEqual({ outcome: "call_failed", failure: "http_error", status: 500 });
    expect(JSON.stringify(outcome)).not.toContain("boom");
  });

  it("relays a JSON-RPC error as its code alone", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, error: { code: METHOD_NOT_FOUND, message: "nope" } } }
        : null;
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "call_failed",
      failure: "rpc_error",
      code: METHOD_NOT_FOUND
    });
  });

  it.each([
    ["a body that is not MCP", { raw: "not json" }],
    ["a result with no tools array", { message: { jsonrpc: "2.0", id: 2, result: { resultType: "complete" } } }]
  ])("refuses %s", async (_label, reply) => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/list" ? reply : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "call_failed",
      failure: "protocol_error"
    });
  });

  it("reports a ladder that never opened as a connect failure", async () => {
    const client = await clientFor({ supportedVersions: ["1999-01-01"], protocol: "stateless" });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake?.callsTo("tools/list")).toHaveLength(0);
  });

  it("honours the caller's own timeout rather than the client's", async () => {
    fake = await startFakeMcpServer({ hangOn: "tools/list" });
    // The client's default is twenty times the budget, so a listing that comes
    // back promptly proves the per-call value is the one in force.
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 4000 });

    const started = Date.now();
    expect(await client.listTools(undefined, 200)).toEqual({ outcome: "call_failed", failure: "timed_out" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The same signal `callTool` replays, safe here for one more reason: the 404
  // precedes dispatch, *and* a listing is a read.
  it("reconnects once when the session was lost, and lists", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect((await client.listTools(undefined, undefined)).outcome).toBe("listed");
    fake.expireSessions();

    expect((await client.listTools(undefined, undefined)).outcome).toBe("listed");
    expect(fake.callsTo("initialize")).toHaveLength(2);
    expect(fake.callsTo("tools/list")).toHaveLength(3);
  });

  it("treats a 404 from a client with no session as the wrong url it is", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", sessions: false });
    fake.respond = request => (request.rpc?.method === "tools/list" ? { status: 404, raw: "no such path" } : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "call_failed",
      failure: "http_error",
      status: 404
    });
    expect(fake.callsTo("tools/list")).toHaveLength(1);
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });
});
