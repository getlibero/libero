import { describe, expect, it } from "vitest";
import {
  LEGACY_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  STATELESS_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  acceptedProtocolVersion,
  discoverRequest,
  eventStreamPayloads,
  initializeHeaders,
  initializeRequest,
  initializedNotification,
  negotiatedVersion,
  parseRpcResponse,
  requestHeaders,
  sessionTerminationHeaders,
  toolsCallRequest,
  toolsListRequest
} from "./mcp-protocol.js";

/** The wire context a stateless request goes out on. */
const STATELESS = { dialect: "stateless", version: MCP_PROTOCOL_VERSION } as const;

describe("the request shapes", () => {
  it("frames a discover request", () => {
    expect(discoverRequest(1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover"
    });
  });

  it("frames a tools/call with the name and the arguments", () => {
    const request = toolsCallRequest(7, "list_prs", { repo: "libero" }, "stateless");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_prs", arguments: { repo: "libero" } }
    });
  });

  // The `io.modelcontextprotocol/*` keys are that revision's own invention. A
  // legacy server has been told the version and the capabilities by
  // `initialize`, and repeating them here would announce a revision it never
  // agreed to in a field the transport also carries in a header.
  it("carries no _meta on the legacy dialect", () => {
    const request = toolsCallRequest(7, "list_prs", { repo: "libero" }, "legacy");
    expect("_meta" in request.params).toBe(false);
    expect(request.params).toMatchObject({ name: "list_prs", arguments: { repo: "libero" } });
  });

  it("frames a tools/list asking for the first page", () => {
    const request = toolsListRequest(4, "stateless");
    expect(request).toMatchObject({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    // Absent, not null. The spec reads an absent cursor as "the first page" and
    // an explicit one as a position the server issued; a null would be a third
    // state this client invented.
    expect("cursor" in request.params).toBe(false);
  });

  it("carries a cursor only when it was given one, and no _meta on the legacy dialect", () => {
    expect(toolsListRequest(4, "stateless", "page-2").params).toMatchObject({ cursor: "page-2" });
    const legacy = toolsListRequest(4, "legacy", "page-2");
    expect("_meta" in legacy.params).toBe(false);
    expect(legacy.params).toMatchObject({ cursor: "page-2" });
  });

  it("proposes a revision the server can actually accept", () => {
    // Not the pinned constant: this request exists only because
    // `server/discover` failed, so proposing the revision that removed
    // `initialize` is a proposal the server cannot take.
    expect(initializeRequest(3)).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {} }
    });
    expect(initializeRequest(3).params["protocolVersion"]).not.toBe(MCP_PROTOCOL_VERSION);
  });

  // The absence *is* the notification: a message with an id is a request, and a
  // server would owe it a response the client never reads.
  it("frames the acknowledgement as a notification, with no id", () => {
    const notification = initializedNotification();
    expect("id" in notification).toBe(false);
    expect(notification).toMatchObject({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  // The acceptance criterion, at the level where it is decidable: whatever a
  // caller knows about the channel, the asker, and the task, none of it has a
  // parameter to travel in. `_meta.clientInfo` is the one field on the wire
  // that looks like it should carry a caller identity, so it is checked by
  // name rather than only by the sweep below.
  it("names the product in clientInfo and nothing about the caller", () => {
    for (const request of [discoverRequest(1), toolsCallRequest(2, "list_prs", {}, "stateless")]) {
      const meta = (request.params as { _meta: Record<string, unknown> })._meta;
      expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({
        name: "libero-proxy",
        version: expect.any(String) as unknown as string
      });
      expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
      expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
    }
  });

  // The handshake is on this sweep too: `initialize` takes a `clientInfo`, so
  // it is the second field on the wire where a caller identity would look like
  // it belonged.
  it("carries no attribution anywhere in a serialized request", () => {
    const serialized = JSON.stringify([
      discoverRequest(1),
      toolsCallRequest(2, "list_prs", { repo: "libero" }, "stateless"),
      toolsCallRequest(3, "list_prs", { repo: "libero" }, "legacy"),
      initializeRequest(4),
      initializedNotification()
    ]);
    for (const leak of ["C0ENGINEERING", "U0ASKER", "b9d5a2f0", "channel", "requestingUser", "task"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("declares both framings it must accept, and matches the header to the _meta version", () => {
    const headers = requestHeaders(STATELESS, "tools/call", "list_prs");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("list_prs");
    // The server rejects a request whose header and _meta disagree.
    expect(headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
  });

  it("omits Mcp-Name for a request that has no name to give", () => {
    expect("mcp-name" in requestHeaders(STATELESS, "server/discover")).toBe(false);
    // A listing names no tool, so there is no name to carry. Asserted here
    // because it is the header the client would otherwise have to invent one for.
    expect("mcp-name" in requestHeaders(STATELESS, "tools/list")).toBe(false);
  });

  // `Mcp-Method` and `Mcp-Name` are `2026-07-28` transport headers; the version
  // is the *negotiated* one, because a server that receives one it did not
  // agree to MUST answer 400 — which would be every request.
  it("sends the legacy dialect its own headers and its own version", () => {
    const headers = requestHeaders(
      { dialect: "legacy", version: "2025-06-18", sessionId: "session-1" },
      "tools/call",
      "list_prs"
    );
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(headers["mcp-session-id"]).toBe("session-1");
    expect("mcp-method" in headers).toBe(false);
    expect("mcp-name" in headers).toBe(false);
  });

  it("carries no session header when the server assigned none", () => {
    const headers = requestHeaders({ dialect: "legacy", version: "2025-06-18" }, "tools/call", "list_prs");
    expect("mcp-session-id" in headers).toBe(false);
  });

  // There is no negotiated revision yet — that is what the request is for — and
  // naming one the server has not agreed to is exactly what it must 400.
  it("names no protocol version on the request that has none to name", () => {
    expect("mcp-protocol-version" in initializeHeaders()).toBe(false);
    expect(initializeHeaders().accept).toBe("application/json, text/event-stream");
  });

  it("terminates a session with the session and the version it was negotiated at", () => {
    expect(sessionTerminationHeaders("session-1", "2025-11-25")).toEqual({
      "mcp-session-id": "session-1",
      "mcp-protocol-version": "2025-11-25"
    });
  });
});

describe("the protocol revisions", () => {
  it("speaks the stateless revision and the three legacy ones, newest first", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  });

  // Pinned with its reason, so the exclusion survives someone "completing" the
  // list: `2024-11-05` is the deprecated two-endpoint HTTP+SSE transport, where
  // the POST target is named by the server at call time. An `[[mcp_server]]`
  // block holds one url, and a destination the upstream chooses is the shape
  // ./outbound.ts refuses a redirect for.
  it("does not speak the revision whose transport is a second transport", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain("2024-11-05");
  });

  it("partitions into the two halves the client branches on", () => {
    expect([...STATELESS_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect(STATELESS_PROTOCOL_VERSIONS).not.toContain(version);
    }
  });
});

describe("the event stream", () => {
  it("reads a single event", () => {
    expect(eventStreamPayloads('data: {"ok":true}\n\n')).toEqual(['{"ok":true}']);
  });

  it("reads several events in order", () => {
    expect(eventStreamPayloads("data: one\n\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  it("joins a multi-line data field with newlines", () => {
    expect(eventStreamPayloads("data: {\ndata:   \"a\": 1\ndata: }\n\n")).toEqual(['{\n  "a": 1\n}']);
  });

  it("handles CRLF line endings", () => {
    expect(eventStreamPayloads('data: {"ok":true}\r\n\r\n')).toEqual(['{"ok":true}']);
  });

  it("skips comments and the fields this client does not read", () => {
    const body = ": keep-alive\nevent: message\nid: 42\nretry: 3000\ndata: payload\n\n";
    expect(eventStreamPayloads(body)).toEqual(["payload"]);
  });

  // A stream that ends without a trailing blank line still delivered its event.
  it("delivers a final event with no terminating blank line", () => {
    expect(eventStreamPayloads("data: payload")).toEqual(["payload"]);
  });

  it("strips exactly one leading space, which is the field separator", () => {
    expect(eventStreamPayloads("data:  two spaces\n\n")).toEqual([" two spaces"]);
  });

  it("returns nothing for a body with no events", () => {
    expect(eventStreamPayloads(": just a comment\n\n")).toEqual([]);
    expect(eventStreamPayloads("")).toEqual([]);
  });
});

describe("reading a response", () => {
  const RESULT = { jsonrpc: "2.0", id: 1, result: { content: [] } };

  it("reads a JSON body", () => {
    expect(parseRpcResponse("application/json", JSON.stringify(RESULT), 1)).toEqual({
      kind: "result",
      result: { content: [] }
    });
  });

  it("reads an event-stream body identically", () => {
    const body = `data: ${JSON.stringify(RESULT)}\n\n`;
    expect(parseRpcResponse("text/event-stream; charset=utf-8", body, 1)).toEqual({
      kind: "result",
      result: { content: [] }
    });
  });

  // The framing comes from the declared content type, not from the bytes: a
  // parser that guesses is a parser that can be made to guess wrong.
  it("frames by content type rather than by sniffing", () => {
    const body = `data: ${JSON.stringify(RESULT)}\n\n`;
    expect(parseRpcResponse("application/json", body, 1).kind).toBe("malformed");
  });

  it("relays a JSON-RPC error with its code", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no such tool" } });
    expect(parseRpcResponse("application/json", body, 1)).toEqual({
      kind: "error",
      code: -32601,
      message: "no such tool"
    });
  });

  // `data` is unbounded arbitrary JSON. `message` is the field the spec
  // designates human-readable, and it is the only one relayed.
  it("does not relay the error's data member", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -1, message: "failed", data: { stack: "internal detail" } }
    });
    const parsed = parseRpcResponse("application/json", body, 1);
    expect(JSON.stringify(parsed)).not.toContain("internal detail");
  });

  it("truncates an error message rather than relaying a wall of text", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x".repeat(5000) } });
    const parsed = parseRpcResponse("application/json", body, 1);
    expect(parsed.kind === "error" && parsed.message.length).toBeLessThan(400);
  });

  // Request-scoped notifications may precede the result on the stream. They
  // carry no id, so they are skipped rather than mistaken for a mismatch.
  it("skips notifications that arrive before the result", () => {
    const body =
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
      `data: ${JSON.stringify(RESULT)}\n\n`;
    expect(parseRpcResponse("text/event-stream", body, 1)).toEqual({ kind: "result", result: { content: [] } });
  });

  it.each([
    ["not JSON at all", "application/json", "<html>gateway error</html>", "not_json"],
    ["a JSON scalar", "application/json", '"a string"', "not_jsonrpc"],
    ["a response to another request", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }), "id_mismatch"],
    ["neither result nor error", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1 }), "bad_result"],
    ["only notifications", "text/event-stream", 'data: {"jsonrpc":"2.0","method":"x"}\n\n', "no_message"],
    ["an empty body", "application/json", "", "not_json"]
  ])("reports %s as malformed", (_label, contentType, body, reason) => {
    expect(parseRpcResponse(contentType, body, 1)).toEqual({ kind: "malformed", reason });
  });

  it("treats a missing content type as JSON", () => {
    expect(parseRpcResponse(undefined, JSON.stringify(RESULT), 1).kind).toBe("result");
  });
});

describe("version negotiation", () => {
  it("picks a version both ends support", () => {
    expect(negotiatedVersion({ supportedVersions: ["2025-06-18", MCP_PROTOCOL_VERSION] })).toBe(
      MCP_PROTOCOL_VERSION
    );
  });

  // Failing here costs one honest refusal. Guessing costs a call made at a
  // version the server never accepted, which it may answer rather than reject.
  it("returns null when there is no overlap", () => {
    expect(negotiatedVersion({ supportedVersions: ["2025-03-26", "2025-06-18"] })).toBeNull();
  });

  it("does not assume agreement from a server that advertises nothing", () => {
    expect(negotiatedVersion({})).toBeNull();
    expect(negotiatedVersion({ supportedVersions: "2026-07-28" })).toBeNull();
    expect(negotiatedVersion({ supportedVersions: [] })).toBeNull();
  });

  it("only ever returns a version this client speaks", () => {
    const picked = negotiatedVersion({ supportedVersions: ["2026-07-28", "2099-01-01"] });
    expect(picked === null || SUPPORTED_PROTOCOL_VERSIONS.includes(picked)).toBe(true);
  });

  // The guard on the constant split. This function is the *sessionless* path,
  // so agreeing to a legacy revision here would mean sending a `tools/call`
  // carrying no session to a server that requires one — which it is entitled to
  // answer wrongly rather than reject. The legacy revisions are reachable only
  // through `initialize`, which is where a session comes from.
  it("never negotiates a revision the sessionless path cannot hold up", () => {
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect(negotiatedVersion({ supportedVersions: [version] })).toBeNull();
    }
  });
});

describe("the version a legacy server named", () => {
  it("accepts each revision the handshake can speak", () => {
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect(acceptedProtocolVersion({ protocolVersion: version })).toBe(version);
    }
  });

  // A server answering `initialize` with the revision that removed `initialize`
  // has contradicted itself, and this client cannot tell which half it meant.
  it("rejects the revision that has no handshake", () => {
    expect(acceptedProtocolVersion({ protocolVersion: MCP_PROTOCOL_VERSION })).toBeNull();
  });

  it("rejects a version this client does not speak, and a reply that names none", () => {
    expect(acceptedProtocolVersion({ protocolVersion: "2024-11-05" })).toBeNull();
    expect(acceptedProtocolVersion({ protocolVersion: 3 })).toBeNull();
    expect(acceptedProtocolVersion({})).toBeNull();
  });
});

