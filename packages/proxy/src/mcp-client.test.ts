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
  // an error page with the request echoed in it as anything MCP.
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

    expect(outcome).toEqual({ outcome: "connect_failed", failure: "http_error" });
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

  // The seam #150 attaches its handshake fallback to: a server old enough not
  // to implement `server/discover` at all.
  it("names an older server as unsupported rather than as a generic error", async () => {
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
  // a `tools/call` is how one write becomes two.
  it.each([
    ["a 500", { status: 500, raw: "" }],
    ["a malformed body", { raw: "not json" }],
    ["a JSON-RPC error", { message: { jsonrpc: "2.0", id: 2, error: { code: -1, message: "x" } } }]
  ])("sends exactly one tools/call after %s", async (_label, reply) => {
    fake = await startFakeMcpServer();
    fake.respond = request => (request.rpc?.method === "tools/call" ? reply : null);
    const client = createMcpClient({ url: fake.url, scheme: "bearer", secret: undefined, timeoutMs: 2000 });

    await client.callTool("list_prs", {});

    expect(fake.callsTo("tools/call")).toHaveLength(1);
    await fake.close();
    fake = undefined;
  });
});
