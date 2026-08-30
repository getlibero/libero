import { afterEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { type ToolResultBlock, resultText } from "@getlibero/schema";
import { type McpClient, createMcpClient } from "./mcp-client.js";
import { type FakeMcpServer, type FakeReply, completeResult, startFakeMcpServer } from "./mcp-fake-server.js";
// Written down here rather than imported from the client, for the reason
// ./mcp-fake-server.ts states: a test that shares its constants with the code
// under test cannot catch that code disagreeing with a real server.
const MCP_PROTOCOL_VERSION = "2026-07-28";
const METHOD_NOT_FOUND = -32601;
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
    source: constantCredential("bearer", secret, "github_service_account"),
    timeoutMs: 2000
  });
}

/** One text block, which is every result the proxy currently produces (#500). */
const text = (content: string): ToolResultBlock[] => [{ type: "text", text: content }];

describe("the round trip", () => {
  it("discovers, calls, and returns the result", async () => {
    const client = await clientFor();
    const outcome = await client.callTool("list_prs", { repo: "libero" }, LIMITS, NO_HEADERS);

    expect(outcome).toEqual({ outcome: "called", result: { content: text("called list_prs"), isError: false } });
    expect(fake?.received.map(r => r.rpc?.method)).toEqual(["server/discover", "tools/call"]);
  });

  it("reads an event-stream reply identically", async () => {
    const client = await clientFor({ framing: "sse" });
    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(outcome).toEqual({ outcome: "called", result: { content: text("called list_prs"), isError: false } });
  });

  it("sends the transport's required headers", async () => {
    const client = await clientFor();
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    await client.callTool("get_issue", {}, LIMITS, NO_HEADERS);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(2);
  });

  it("discovers once for concurrent first calls", async () => {
    const client = await clientFor();
    await Promise.all([client.callTool("a", {}, LIMITS, NO_HEADERS), client.callTool("b", {}, LIMITS, NO_HEADERS), client.callTool("c", {}, LIMITS, NO_HEADERS)]);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(3);
  });
});

describe("the credential", () => {
  // Positive first, so nothing below is vacuously true.
  it("reaches the upstream on every request", async () => {
    const client = await clientFor();
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(fake?.received).not.toHaveLength(0);
    for (const request of fake?.received ?? []) {
      expect(request.authorization).toBe(`Bearer ${VALUE}`);
    }
  });

  it("never comes back in a result when the upstream echoes it", async () => {
    const client = await clientFor({ echoHeaders: "text" });
    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    const content = outcome.outcome === "called" ? resultText(outcome.result.content) : "";
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(VALUE);
    expect(content).not.toContain("ghp_");
  });

  // The case #149 exists for: the upstream escapes the header, and this client
  // parses the body — so an escaped spelling that survived the scan would be
  // un-escaped on the way to the model.
  it("never comes back when the upstream echoes it JSON-escaped", async () => {
    const client = await clientFor({ echoHeaders: "json-escaped" });
    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    const content = outcome.outcome === "called" ? resultText(outcome.result.content) : "";
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(VALUE);
    expect(content).not.toContain("ghp_");
  });

  each([['a value with "quotes"', 'ghp_"quoted"_token'], ["a value with \\ backslashes", "ghp_\\back\\slash"]])(
    "survives %s",
    async (_label, value) => {
      fake = await startFakeMcpServer({ echoHeaders: "text" });
      const client = createMcpClient({
        url: fake.url,
        source: constantCredential("bearer", secretOf(value), "c"),
        timeoutMs: 2000
      });
      const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

      const content = outcome.outcome === "called" ? resultText(outcome.result.content) : "";
      expect(content).not.toContain(value);
    }
  );

  it("is scrubbed from a response header before anything reads it", async () => {
    const client = await clientFor({ echoIntoResponseHeader: true });
    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
      source: constantCredential("bearer", secretOf(VALUE), "c"),
      timeoutMs: 2000
    });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
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
        source: constantCredential("bearer", secretOf(VALUE), "c"),
        timeoutMs: 2000
      });

      const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
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
      source: constantCredential("bearer", secretOf(VALUE), "c"),
      timeoutMs: 2000
    });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(fake.callsTo("tools/call")).toHaveLength(0);
  });

  it("reports an unreachable upstream without a socket", async () => {
    const client = createMcpClient({
      url: "http://127.0.0.1:1/mcp",
      source: constantCredential("bearer", undefined),
      timeoutMs: 2000
    });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({ outcome: "connect_failed", failure: "unreachable" });
  });

  // A transient outage must not disable an upstream for the process lifetime,
  // which is what caching a failed discovery would do.
  it("retries discovery on the next call rather than caching the failure", async () => {
    fake = await startFakeMcpServer();
    let failing = true;
    fake.respond = () => (failing ? { status: 503, raw: "" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("connect_failed");
    failing = false;
    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
  });
});

describe("version negotiation", () => {
  it("fails closed against a server that speaks nothing we do", async () => {
    const client = await clientFor({ supportedVersions: ["2025-03-26", "2025-06-18"] });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake?.callsTo("tools/call")).toHaveLength(0);
  });

  // The SDK's own legacy list reaches back to the HTTP+SSE revisions, whose
  // results arrive on the standalone GET stream the guarded fetch answers 405 —
  // so accepting this handshake would make every call a thirty-second timeout
  // with a wrong word at the end. The hand-rolled client failed closed on
  // exactly this list; `supportedProtocolVersions` is what keeps the SDK doing
  // the same, and this is the test that fails without it.
  each(["2024-11-05", "2024-10-07"])("fails closed on the HTTP+SSE era (%s) rather than calling into a void", async version => {
    const client = await clientFor({ protocol: "legacy", legacyVersion: version });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake.callsTo("tools/call")).toHaveLength(0);
  });
});

describe("the ladder", () => {
  it("falls back to the handshake and completes the call", async () => {
    const client = await clientFor({ protocol: "legacy" });

    expect(await client.callTool("list_prs", { repo: "libero" }, LIMITS, NO_HEADERS)).toEqual({
      outcome: "called",
      result: { content: text("called list_prs"), isError: false }
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
  each(["rpc_error", "http_400", "http_404"] as const)("falls back whatever shape the refusal took (%s)", async refusal => {
    const client = await clientFor({ protocol: "legacy", discoverRefusal: refusal });

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    expect(fake?.callsTo("initialize")).toHaveLength(1);
  });

  // The bug this catches is not hypothetical: before the wire context existed,
  // `requestHeaders` hardcoded the pinned constant, and a server receiving a
  // version it did not agree to MUST answer 400 — so every legacy call would
  // have been refused.
  it("speaks the version the server named, not the one it was pinned to", async () => {
    const client = await clientFor({ protocol: "legacy", legacyVersion: "2025-06-18" });
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    const call = fake?.callsTo("tools/call")[0];
    expect(call?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(call?.headers["mcp-session-id"]).toBe("session-1");
    // The `2026-07-28` transport headers are that revision's own.
    expect("mcp-method" in (call?.headers ?? {})).toBe(false);
  });

  it("names no version on the request that establishes one", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect("mcp-protocol-version" in (fake?.callsTo("initialize")[0]?.headers ?? {})).toBe(false);
  });

  // A server SHOULD NOT process other requests until the acknowledgement
  // arrives, so a `tools/call` racing it is one the server may refuse.
  it("acknowledges the handshake before it calls anything, carrying the session", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    const methods = fake?.received.map(r => r.rpc?.method) ?? [];
    expect(methods.indexOf("notifications/initialized")).toBeLessThan(methods.indexOf("tools/call"));
    expect(fake?.callsTo("notifications/initialized")[0]?.headers["mcp-session-id"]).toBe("session-1");
  });

  it("reads the handshake over an event stream identically", async () => {
    const client = await clientFor({ protocol: "legacy", framing: "sse" });

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
  });

  // A legacy server that assigns no session is an ordinary one, not a broken
  // one — so the calls that follow carry none and nothing goes looking.
  it("carries no session when the server assigned none", async () => {
    const client = await clientFor({ protocol: "legacy", sessions: false });

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    for (const request of fake?.received ?? []) {
      expect("mcp-session-id" in request.headers).toBe(false);
    }
  });

  it("settles the protocol once and re-probes nothing", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    await client.callTool("get_issue", {}, LIMITS, NO_HEADERS);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("initialize")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(2);
  });

  it("runs the ladder once for concurrent first calls", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await Promise.all([client.callTool("a", {}, LIMITS, NO_HEADERS), client.callTool("b", {}, LIMITS, NO_HEADERS), client.callTool("c", {}, LIMITS, NO_HEADERS)]);

    expect(fake?.callsTo("server/discover")).toHaveLength(1);
    expect(fake?.callsTo("initialize")).toHaveLength(1);
    expect(fake?.callsTo("tools/call")).toHaveLength(3);
  });

  it("reports which protocol it settled on", async () => {
    const legacy = await clientFor({ protocol: "legacy" });
    expect(legacy.protocol).toBeUndefined();
    await legacy.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    expect(legacy.protocol).toBe("legacy");
    await fake?.close();

    const stateless = await clientFor();
    await stateless.callTool("list_prs", {}, LIMITS, NO_HEADERS);
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 150 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({ outcome: "connect_failed", failure: "timed_out" });
    expect(fake.callsTo("initialize")).toHaveLength(0);
    expect(fake.received).toHaveLength(1);
  });

  it("never attempts the handshake against a host nothing listens on", async () => {
    const client = createMcpClient({
      url: "http://127.0.0.1:1/mcp",
      source: constantCredential("bearer", undefined),
      timeoutMs: 2000
    });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({ outcome: "connect_failed", failure: "unreachable" });
  });

  it("never attempts the handshake against a redirect", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request =>
      request.rpc?.method === "server/discover" ? { status: 307, headers: { location: "http://127.0.0.1:1/" } } : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({ outcome: "connect_failed", failure: "redirected" });
    expect(fake.callsTo("initialize")).toHaveLength(0);
  });

  // The deliberate non-trigger: a well-formed request answered 200 with bytes
  // that are not MCP is a broken server or an edge proxy rather than an old
  // one, and it has already shown it is not speaking the protocol.
  //
  // **`unsupported_protocol` rather than `protocol_error`, and the resolution
  // is genuinely lost.** The hand-rolled ladder told an unreadable probe answer
  // apart from a version both ends failed to agree on; the SDK reports both as
  // one era-negotiation failure and there is nothing on the error to tell them
  // apart. The model-facing sentence — "does not speak a version of MCP this
  // proxy supports" — is true of a server answering HTML to the probe, and the
  // property this case is really about is the one still asserted below: no
  // second attempt is made.
  it("reports an unreadable probe answer without a second attempt", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request => (request.rpc?.method === "server/discover" ? { raw: "<html>hello</html>" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "called",
      result: { content: text("no such repo"), isError: true }
    });
  });

  // The permissive `CallEnvelope` is what keeps this reaching `blockText`'s
  // placeholder branch: with no caller schema the SDK validates the result
  // against the specification's closed content union, and one forward-revision
  // block beside ordinary text would fail the entire call — losing an answer
  // the upstream actually returned. Legacy era; the modern era validates
  // spec-first above any caller schema, the same narrowing the catalog pins.
  it("renders an unrecognized content block as a placeholder rather than failing the call", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: {
                content: [
                  { type: "text", text: "the answer" },
                  { type: "hologram", uri: "mcp://clip" }
                ]
              }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    expect(outcome.outcome).toBe("called");
    const content = outcome.outcome === "called" ? resultText(outcome.result.content) : "";
    expect(content).toContain("the answer");
    expect(content).toContain("[unsupported content block: hologram]");
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "call_failed",
      failure: "rpc_error",
      code: METHOD_NOT_FOUND,
      detail: "no tool named list_prs"
    });
  });

  it("reports an answer it cannot read as MCP", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { raw: "<html>502</html>" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    expect(outcome).toMatchObject({ outcome: "call_failed", failure: "protocol_error" });
  });

  it("relays a non-2xx with its status", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? { status: 429, raw: "slow down" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    expect(outcome).toMatchObject({ outcome: "call_failed", failure: "http_error", status: 429 });
    // Contained rather than equal: the detail is the SDK's error message, which
    // wraps the upstream's body in a fixed preamble of its own. The body is
    // what matters and it is there — and it is safe to relay for the reason it
    // always was, that it reached this process through `callUpstream` and was
    // scrubbed before the SDK ever saw it.
    expect(outcome.outcome === "call_failed" && outcome.detail).toContain("slow down");
  });

  // The one relay `parseRpcResponse` never bounds, bounded where it is born:
  // an endpoint answering its error in megabytes should not spend the
  // channel's tokens saying so.
  it("truncates a non-2xx body rather than relaying a wall of text", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call" ? { status: 500, raw: "x".repeat(100_000) } : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(outcome).toMatchObject({ outcome: "call_failed", failure: "http_error", status: 500 });
    expect(outcome.outcome === "call_failed" && (outcome.detail?.length ?? 0)).toBeLessThan(400);
  });
});

// #156's two claims, against the real SDK rather than against the seam.
describe("a server that leaves its event stream open", () => {
  it("returns the result it already sent, instead of timing out", async () => {
    fake = await startFakeMcpServer({ framing: "sse" });
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            keepStreamOpen: true,
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: completeResult({ content: [{ type: "text", text: "ok" }] })
            }
          }
        : null;
    // A budget short enough that the old buffered read could only have reported
    // `timed_out`: nothing closes this stream before the test's own teardown.
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const started = process.hrtime.bigint();
    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(outcome).toMatchObject({ outcome: "called" });
    // Answered on the event rather than on the timeout. Asserted as well as the
    // outcome because a `timed_out` that happened to be reported as a result
    // would pass the line above.
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("still scrubs a credential the held-open stream echoes back", async () => {
    fake = await startFakeMcpServer({ framing: "sse" });
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? {
            keepStreamOpen: true,
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: completeResult({ content: [{ type: "text", text: `saw ${request.authorization}` }] })
            }
          }
        : null;
    const client = createMcpClient({
      url: fake.url,
      source: constantCredential("bearer", secretOf(VALUE), "github_pat"),
      timeoutMs: 2000
    });

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(outcome).toMatchObject({ outcome: "called" });
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
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
              // A conformant one: `inputRequests` is a map keyed by an
              // identifier the server assigns, not an array. Written correctly
              // on purpose — a malformed one is refused too, but as a protocol
              // error, which would let this case pass without ever exercising
              // the refusal it is about.
              result: {
                resultType: "input_required",
                inputRequests: {
                  ask: {
                    method: "sampling/createMessage",
                    params: { messages: [{ role: "user", content: { type: "text", text: "who?" } }], maxTokens: 64 }
                  }
                }
              }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({ outcome: "call_failed", failure: "input_required" });
  });

  // Retrying is precisely how the round trip would be completed, so not
  // retrying is the refusal rather than an implementation detail of it.
  it("is not retried", async () => {
    fake = await startFakeMcpServer();
    fake.respond = request =>
      request.rpc?.method === "tools/call"
        ? { message: { jsonrpc: "2.0", id: request.rpc.id, result: { resultType: "input_required" } } }
        : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

    expect(fake.callsTo("tools/call")).toHaveLength(1);
  });
});

describe("what is never retried", () => {
  // Every one of these can mean the call ran and the answer was lost. Replaying
  // a `tools/call` is how one write becomes two. Run on both dialects, because
  // the legacy path is the one that now has a replay at all — and the point is
  // that it is the *only* signal that gets one.
  each([
    ["a 500", { status: 500, raw: "" }],
    ["a malformed body", { raw: "not json" }],
    ["a JSON-RPC error", { message: { jsonrpc: "2.0", id: 2, error: { code: -1, message: "x" } } }]
  ])("sends exactly one tools/call after %s", async (_label, reply) => {
    for (const protocol of ["stateless", "legacy"] as const) {
      fake = await startFakeMcpServer({ protocol });
      fake.respond = request => (request.rpc?.method === "tools/call" ? reply : null);
      const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

      await client.callTool("list_prs", {}, LIMITS, NO_HEADERS);

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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });
    expireOn(fake, 1);

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    expect(fake.callsTo("initialize")).toHaveLength(2);
    expect(fake.callsTo("tools/call")).toHaveLength(2);

    const [first, second] = fake.callsTo("tools/call");
    expect(second?.headers["mcp-session-id"]).not.toBe(first?.headers["mcp-session-id"]);
  });

  it("gives the model an error rather than a loop against a server that forgets every session", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });
    expireOn(fake, Number.MAX_SAFE_INTEGER);

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toMatchObject({ failure: "http_error", status: 404 });
    expect(fake.callsTo("tools/call")).toHaveLength(1);
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });

  it("treats a 404 to the handshake itself as a refusal rather than a loss", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request => (request.rpc?.method === "initialize" ? { status: 404, raw: "" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).toEqual({
      outcome: "connect_failed",
      failure: "unsupported_protocol"
    });
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });

  // The reopen clears `session` before its handshake resolves, and that window
  // is one `ensureOpen` has to know about: a fresh call arriving inside it sees
  // neither a session nor an `opening` and would start a second full ladder —
  // a `server/discover` against a server already known to be legacy — racing
  // the reopen, with the loser's session dropped unterminated at the upstream.
  it("rides a reopen in flight rather than starting a second ladder", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect((await client.callTool("warm", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    fake.expireSessions();

    // Fired the moment the reopen's `initialize` is on the wire — exactly the
    // window where `session` is cleared and only `reopening` knows better.
    let straggler: ReturnType<McpClient["callTool"]> | undefined;
    fake.respond = request => {
      if (request.rpc?.method === "initialize" && straggler === undefined) {
        straggler = client.callTool("b", {}, LIMITS, NO_HEADERS);
      }
      return null;
    };

    expect((await client.callTool("a", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    expect((await straggler)?.outcome).toBe("called");
    // One probe at first contact, and no second: the straggler rode the reopen.
    expect(fake.callsTo("server/discover")).toHaveLength(1);
    expect(fake.callsTo("initialize")).toHaveLength(2);
  });

  // The generation check and the single flight, together. Round-trip count is
  // the visible half; the half that matters is that a straggler's 404 does not
  // invalidate a session two other calls were about to use.
  it("costs one re-initialize when three calls lose the session at once", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect((await client.callTool("warm", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    fake.expireSessions();

    const outcomes = await Promise.all([
      client.callTool("a", {}, LIMITS, NO_HEADERS),
      client.callTool("b", {}, LIMITS, NO_HEADERS),
      client.callTool("c", {}, LIMITS, NO_HEADERS)
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
      const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

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

  // Serializers that spell an absent field `null` are commonplace — Go's
  // encoding/json without omitempty, most Java frameworks — and a page refused
  // over its cursor blanks the catalog of every tool on it. `CatalogPage`
  // vouches for the envelope only; the cursor's reading is `parseToolsList`'s,
  // which treats anything but a non-empty string as end-of-pagination.
  it("treats a null cursor as end-of-pagination rather than refusing the page", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    fake.respond = request =>
      request.rpc?.method === "tools/list"
        ? {
            message: {
              jsonrpc: "2.0",
              id: request.rpc.id,
              result: { tools: [{ name: "list_prs", description: "Lists PRs." }], nextCursor: null }
            }
          }
        : null;
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.listTools(undefined, undefined);
    expect(outcome).toMatchObject({ outcome: "listed", nextCursor: null });
    expect(outcome.outcome === "listed" && outcome.tools.map(tool => tool.name)).toEqual(["list_prs"]);
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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", secretOf(VALUE)), timeoutMs: 2000 });

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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "call_failed",
      failure: "rpc_error",
      code: METHOD_NOT_FOUND
    });
  });

  // The reply echoes the request's own id rather than naming one, because a
  // client is entitled to number its requests however it likes and an answer to
  // an id nobody asked about is not a malformed *result* — it is no answer at
  // all, which this suite would see as a timeout rather than as the refusal it
  // is testing for.
  each<[string, (id: number | undefined) => FakeReply]>([
    ["a body that is not MCP", () => ({ raw: "not json" })],
    [
      "a result with no tools array",
      id => ({ message: { jsonrpc: "2.0", id, result: { resultType: "complete" } } })
    ]
  ])("refuses %s", async (_label, reply) => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/list" ? reply(request.rpc.id) : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

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
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 4000 });

    const started = Date.now();
    expect(await client.listTools(undefined, 200)).toEqual({ outcome: "call_failed", failure: "timed_out" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The same signal `callTool` replays, safe here for one more reason: the 404
  // precedes dispatch, *and* a listing is a read.
  it("reconnects once when the session was lost, and lists", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect((await client.listTools(undefined, undefined)).outcome).toBe("listed");
    fake.expireSessions();

    expect((await client.listTools(undefined, undefined)).outcome).toBe("listed");
    expect(fake.callsTo("initialize")).toHaveLength(2);
    expect(fake.callsTo("tools/list")).toHaveLength(3);
  });

  it("treats a 404 from a client with no session as the wrong url it is", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", sessions: false });
    fake.respond = request => (request.rpc?.method === "tools/list" ? { status: 404, raw: "no such path" } : null);
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(await client.listTools(undefined, undefined)).toEqual({
      outcome: "call_failed",
      failure: "http_error",
      status: 404
    });
    expect(fake.callsTo("tools/list")).toHaveLength(1);
    expect(fake.callsTo("initialize")).toHaveLength(1);
  });
});

// SEP-2243's `Mcp-Param-*` headers, and the gap #130 hit. The SDK mirrors them
// only on a `2026-07-28` connection — correct, since `x-mcp-header` exists in no
// earlier revision — while GitHub negotiates the legacy revision and requires
// them anyway. So on the legacy path the proxy derives them itself, from the
// codec vendored at ./vendor/mcp-param-headers.ts.
describe("mirroring an argument into a request header", () => {
  const ANNOTATED = [
    {
      name: "create_or_update_file",
      description: "Writes a file.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", "x-mcp-header": "owner" },
          repo: { type: "string", "x-mcp-header": "repo" },
          path: { type: "string" }
        },
        required: ["owner", "repo", "path"]
      }
    }
  ];

  const DECLARED: UpstreamCallDefinition = {
    paramDeclarations: [
      { path: ["owner"], headerName: "owner", type: "string" },
      { path: ["repo"], headerName: "repo", type: "string" }
    ]
  };

  // Both halves, and the second is what makes the first mean anything: an
  // assertion that the call merely succeeded would pass just as well against a
  // fake that never checked.
  it("sends them on a legacy connection, which is where GitHub demands them", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", catalog: ANNOTATED, requireParamHeaders: true });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool(
      "create_or_update_file",
      { owner: "getlibero", repo: "libero", path: "README.md" },
      LIMITS,
      DECLARED
    );

    expect(outcome.outcome).toBe("called");
    const call = fake.callsTo("tools/call")[0];
    expect(call?.headers["mcp-param-owner"]).toBe("getlibero");
    expect(call?.headers["mcp-param-repo"]).toBe("libero");
  });

  // The same server, the same call, with the declarations withheld: this is what
  // #130 looked like from the inside, and it is why the case above is not
  // vacuous.
  it("is refused -32020 by such a server when it sends none", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy", catalog: ANNOTATED, requireParamHeaders: true });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    expect(
      await client.callTool(
        "create_or_update_file",
        { owner: "getlibero", repo: "libero", path: "README.md" },
        LIMITS,
        NO_HEADERS
      )
    ).toMatchObject({ outcome: "call_failed", failure: "rpc_error", code: -32020 });
  });

  // SEP-2243's intermediary note: infrastructure on an older negotiated revision
  // SHOULD reject a request carrying header values it cannot validate. So the
  // headers go only to a server that asked for them in its own schema, never
  // blanket.
  it("sends none to a server that declared none", async () => {
    const client = await clientFor({ protocol: "legacy" });
    await client.callTool("list_prs", { repo: "libero" }, LIMITS, NO_HEADERS);

    const sent = Object.keys(fake?.callsTo("tools/call")[0]?.headers ?? {});
    expect(sent.filter(name => name.startsWith("mcp-param-"))).toEqual([]);
  });

  // A modern connection needs them from the same place, and the reason is not
  // obvious: the SDK's mirroring lives in `callTool`, which this client does
  // not use — a `tools/call` goes out as a raw `request` so the re-POST
  // recovery has no code path to run on — so its mirroring never runs and
  // would send nothing. One derivation, both eras. This case is what caught
  // that.
  it("sends them on a modern connection too, where the SDK's own mirroring cannot", async () => {
    fake = await startFakeMcpServer({ protocol: "stateless", catalog: ANNOTATED, requireParamHeaders: true });
    const client = createMcpClient({ url: fake.url, source: constantCredential("bearer", undefined), timeoutMs: 2000 });

    const outcome = await client.callTool(
      "create_or_update_file",
      { owner: "getlibero", repo: "libero", path: "README.md" },
      LIMITS,
      DECLARED
    );

    // The SDK's own mirroring satisfies the same enforcing fake, from the same
    // annotations — which is also the equivalence check on the vendored codec:
    // if its encoding ever diverged from the SDK's, these two cases would stop
    // producing the same headers for the same arguments.
    expect(outcome.outcome).toBe("called");
    const call = fake.callsTo("tools/call")[0];
    expect(call?.headers["mcp-param-owner"]).toBe("getlibero");
  });
});


/**
 * A server that answers `tools/call` normally, but only after `delayMs`.
 *
 * `respond` replaces the default reply rather than decorating it, so the result
 * envelope is built here — the same shape mcp-catalog.test.ts builds to slow a
 * page. Slow rather than hanging, because a caller with one timeout cannot tell
 * those apart and a caller running a *sequence* under one budget can.
 */
function slowCalls(server: FakeMcpServer, delayMs: number): void {
  server.respond = request =>
    request.rpc?.method === "tools/call"
      ? {
          delayMs,
          message: {
            jsonrpc: "2.0",
            id: request.rpc.id,
            result: completeResult({ content: [{ type: "text", text: "ok" }] })
          }
        }
      : null;
}

// #253: one budget for the queue wait and the call it is for.
//
// The caller — ./mcp-pool.ts's gate — starts a deadline before it asks for a
// permit, so queueing spends the call's allowance rather than sitting beside
// it. Everything here is about what this file does with that instant.
describe("a caller's deadline", () => {
  it("bounds a call more tightly than the client's own timeout", async () => {
    fake = await startFakeMcpServer();
    const client = createMcpClient({
      url: fake.url,
      source: constantCredential("bearer", undefined),
      timeoutMs: 5_000
    });
    slowCalls(fake, 200);

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS, Date.now() + 60);
    expect(outcome).toEqual({ outcome: "call_failed", failure: "timed_out" });
  });

  // The control for the case above, and it is what makes it worth anything: the
  // same client and the same slow server answer normally when nobody imposed a
  // deadline, so what failed was the deadline rather than the fixture.
  it("leaves a call with no deadline on the client's timeout", async () => {
    fake = await startFakeMcpServer();
    const client = createMcpClient({
      url: fake.url,
      source: constantCredential("bearer", undefined),
      timeoutMs: 5_000
    });
    slowCalls(fake, 200);

    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
  });

  // A request fired with no time left is a write to the upstream on behalf of a
  // caller whose budget is gone. ./semaphore.ts splices a departed waiter out of
  // its queue for the same reason rather than handing it a permit.
  it("sends nothing at all once the deadline has passed", async () => {
    fake = await startFakeMcpServer();
    const client = createMcpClient({
      url: fake.url,
      source: constantCredential("bearer", undefined),
      timeoutMs: 5_000
    });
    // Opened first, so the handshake is not what this case observes.
    expect((await client.callTool("list_prs", {}, LIMITS, NO_HEADERS)).outcome).toBe("called");
    const before = fake.callsTo("tools/call").length;

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS, Date.now() - 1);

    expect(outcome).toEqual({ outcome: "call_failed", failure: "timed_out" });
    expect(fake.callsTo("tools/call")).toHaveLength(before);
  });

  // **The reason it is an instant and not a duration.** `callTool` makes up to
  // two requests, and a duration handed in once would bound each of them — so a
  // caller asking for a budget could spend twice it, which is the stacking #253
  // exists to remove reappearing one layer down.
  //
  // The server loses the session on the first call and delays every call, so
  // the replay starts with most of the budget already spent. Under a duration
  // it would be handed a fresh copy and would succeed.
  it("charges the replay what is left rather than a second copy", async () => {
    fake = await startFakeMcpServer({ protocol: "legacy" });
    const client = createMcpClient({
      url: fake.url,
      source: constantCredential("bearer", undefined),
      timeoutMs: 5_000
    });
    // **Both attempts are slow, and the first one is what spends the budget.**
    // A fast first attempt would leave the replay nearly the whole allowance
    // and the case would pass under either semantics, which is the version of
    // this test that proves nothing.
    let sent = 0;
    fake.respond = request => {
      if (request.rpc?.method !== "tools/call") return null;
      sent += 1;
      // A 404 to a request that carried a session id is the spec's own way of
      // saying the session is gone — the one signal this client replays.
      if (sent === 1) return { delayMs: 200, status: 404, raw: "no such session" };
      return {
        delayMs: 200,
        message: {
          jsonrpc: "2.0",
          id: request.rpc.id,
          result: completeResult({ content: [{ type: "text", text: "ok" }] })
        }
      };
    };

    const outcome = await client.callTool("list_prs", {}, LIMITS, NO_HEADERS, Date.now() + 300);

    // Not `called`. Whether the second attempt went out and timed out, or found
    // nothing left and never went, is a matter of how loaded the machine is —
    // both are the budget holding, and neither is a call that succeeded by
    // spending it twice.
    expect(outcome.outcome).toBe("call_failed");
    expect(fake.callsTo("tools/call").length).toBeLessThanOrEqual(2);
  });
});
