import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  discoverRequest,
  eventStreamPayloads,
  isInputRequired,
  negotiatedVersion,
  parseRpcResponse,
  requestHeaders,
  toolResultText,
  toolsCallRequest
} from "./mcp-protocol.js";

describe("the request shapes", () => {
  it("frames a discover request", () => {
    expect(discoverRequest(1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover"
    });
  });

  it("frames a tools/call with the name and the arguments", () => {
    const request = toolsCallRequest(7, "list_prs", { repo: "libero" });
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_prs", arguments: { repo: "libero" } }
    });
  });

  // The acceptance criterion, at the level where it is decidable: whatever a
  // caller knows about the channel, the asker, and the task, none of it has a
  // parameter to travel in. `_meta.clientInfo` is the one field on the wire
  // that looks like it should carry a caller identity, so it is checked by
  // name rather than only by the sweep below.
  it("names the product in clientInfo and nothing about the caller", () => {
    for (const request of [discoverRequest(1), toolsCallRequest(2, "list_prs", {})]) {
      const meta = (request.params as { _meta: Record<string, unknown> })._meta;
      expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({
        name: "libero-proxy",
        version: expect.any(String) as unknown as string
      });
      expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
      expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
    }
  });

  it("carries no attribution anywhere in a serialized request", () => {
    const serialized = JSON.stringify([
      discoverRequest(1),
      toolsCallRequest(2, "list_prs", { repo: "libero" })
    ]);
    for (const leak of ["C0ENGINEERING", "U0ASKER", "b9d5a2f0", "channel", "requestingUser", "task"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("declares both framings it must accept, and matches the header to the _meta version", () => {
    const headers = requestHeaders("tools/call", "list_prs");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("list_prs");
    // The server rejects a request whose header and _meta disagree.
    expect(headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
  });

  it("omits Mcp-Name for a request that has no name to give", () => {
    expect("mcp-name" in requestHeaders("server/discover")).toBe(false);
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
});

describe("the multi-round-trip result", () => {
  it("recognises an input_required result", () => {
    expect(isInputRequired({ resultType: "input_required" })).toBe(true);
  });

  // Servers on an earlier revision omit the field, and the spec says to read
  // that as complete.
  it("treats a missing resultType as complete", () => {
    expect(isInputRequired({ content: [] })).toBe(false);
    expect(isInputRequired({ resultType: "complete" })).toBe(false);
  });
});

describe("mapping a tool result to text", () => {
  it("joins text blocks", () => {
    expect(
      toolResultText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] })
    ).toEqual({ content: "one\ntwo", isError: false });
  });

  it("carries the tool's own error flag", () => {
    expect(toolResultText({ content: [{ type: "text", text: "nope" }], isError: true })).toEqual({
      content: "nope",
      isError: true
    });
  });

  // A base64 blob is not viewable as an image from a text block, and inlining
  // it would spend the channel's tokens and the audit row's byte count to
  // deliver something the model cannot use.
  it("names a binary block rather than inlining it", () => {
    const data = "A".repeat(8000);
    const mapped = toolResultText({ content: [{ type: "image", data, mimeType: "image/png" }] });
    expect(mapped?.content).toBe("[image omitted: image/png, 6 KB]");
    expect(mapped?.content).not.toContain("AAAA");
  });

  it.each([
    [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }, "[audio omitted: audio/wav, 3 bytes]"],
    [{ type: "resource", resource: { uri: "file:///x", text: "inline text" } }, "inline text"],
    [
      { type: "resource", resource: { uri: "file:///x", blob: "AAAA", mimeType: "application/zip" } },
      "[resource omitted: application/zip, 3 bytes]"
    ],
    [{ type: "resource_link", uri: "https://example.test/a" }, "[resource: https://example.test/a]"],
    [{ type: "hologram" }, "[unsupported content block: hologram]"]
  ])("renders %j", (block, expected) => {
    expect(toolResultText({ content: [block] })?.content).toBe(expected);
  });

  // Every label is upstream-authored text entering the model's context.
  it("truncates a hostile label rather than relaying a paragraph", () => {
    const mapped = toolResultText({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png; ".repeat(500) }]
    });
    expect(mapped?.content.length).toBeLessThan(150);
  });

  // The spec tells servers to mirror structured content into a text block, so
  // reading both would hand the model a well-behaved server's answer twice.
  it("uses structuredContent only when there is no text", () => {
    expect(toolResultText({ content: [], structuredContent: { total: 3 } })?.content).toBe('{"total":3}');
    expect(
      toolResultText({ content: [{ type: "text", text: "three" }], structuredContent: { total: 3 } })?.content
    ).toBe("three");
  });

  it("maps an empty result to empty text rather than to a failure", () => {
    expect(toolResultText({ content: [] })).toEqual({ content: "", isError: false });
  });

  it.each([
    ["content that is not an array", { content: "text" }],
    ["a block that is not an object", { content: ["text"] }],
    ["a text block with no text", { content: [{ type: "text" }] }],
    ["a resource block with no resource", { content: [{ type: "resource" }] }],
    ["no content at all", {}]
  ])("refuses to read %s", (_label, result) => {
    expect(toolResultText(result)).toBeNull();
  });
});
