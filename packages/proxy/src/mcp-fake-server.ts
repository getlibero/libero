// A fake MCP server, for the tests in this package.
//
// **The package's first shared test helper, and deliberately so.** Every other
// test file here declares its own fixtures, which is right when a fixture is
// four lines. This one is not: the negative tests that matter — the upstream
// echoing its auth header, echoing it JSON-escaped, failing at discovery,
// advertising a version we do not speak — are the same fake with different
// knobs, and three copies of it would be three places for one of those knobs to
// quietly stop working.
//
// A real `node:http` server on loopback, port 0, no dependency, per the comment
// at the top of http-dispatcher.test.ts: the credential crosses a real socket,
// which is the only way the leak tests mean anything.
//
// It lives in `src` because the tests do. `package.json`'s test script excludes
// `dist`, so the compiled copy is never collected.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MCP_PROTOCOL_VERSION } from "./mcp-protocol.js";

/** One request the fake received, as it arrived. */
export interface FakeRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly body: string;
  /** The parsed JSON-RPC message, or `null` if the body was not one. */
  readonly rpc: { id?: number; method?: string; params?: Record<string, unknown> } | null;
}

/** What the fake should answer with. */
export interface FakeReply {
  /** Defaults to 200. */
  readonly status?: number;
  /** A JSON-RPC message. Ignored when `raw` is set. */
  readonly message?: unknown;
  /** A body to send verbatim, for malformed-response tests. */
  readonly raw?: string;
  /** Overrides the framing for this reply only. */
  readonly framing?: "json" | "sse";
}

export interface FakeMcpServerOptions {
  /** How a reply is framed. Both are spec-legal and the client must read both. */
  framing: "json" | "sse";
  /**
   * Reflect the received `Authorization` header into the tool result.
   *
   * `text` puts it in a text block. `json-escaped` spells it with `\uXXXX`
   * escapes, which is the shape that defeated redaction before #149 — the
   * client parses the body, and the parse un-escapes it.
   */
  echoHeaders: "off" | "text" | "json-escaped";
  /** Reflect the `Authorization` header into a response header as well. */
  echoIntoResponseHeader: boolean;
  /** What `server/discover` claims to speak. */
  supportedVersions: readonly string[];
}

export interface FakeMcpServer {
  readonly url: string;
  readonly received: FakeRequest[];
  /** Every request whose JSON-RPC `method` was this one. */
  callsTo(method: string): FakeRequest[];
  /** Replaces the default behaviour for one test. Return `null` to fall through. */
  respond: ((request: FakeRequest) => FakeReply | null) | null;
  options: FakeMcpServerOptions;
  close(): Promise<void>;
}

const DEFAULTS: FakeMcpServerOptions = {
  framing: "json",
  echoHeaders: "off",
  echoIntoResponseHeader: false,
  supportedVersions: [MCP_PROTOCOL_VERSION]
};

/** Spell every character as `\uXXXX`, the way an over-eager encoder would. */
function fullyEscape(text: string): string {
  return Array.from({ length: text.length }, (_, i) => `\\u${text.charCodeAt(i).toString(16).padStart(4, "0")}`).join(
    ""
  );
}

export async function startFakeMcpServer(overrides: Partial<FakeMcpServerOptions> = {}): Promise<FakeMcpServer> {
  const received: FakeRequest[] = [];
  const fake: FakeMcpServer = {
    url: "",
    received,
    callsTo: method => received.filter(request => request.rpc?.method === method),
    respond: null,
    options: { ...DEFAULTS, ...overrides },
    close: async () => {}
  };

  const defaultReply = (request: FakeRequest): FakeReply => {
    const id = request.rpc?.id ?? 0;

    if (request.rpc?.method === "server/discover") {
      return {
        message: {
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", supportedVersions: [...fake.options.supportedVersions], capabilities: {} }
        }
      };
    }

    if (request.rpc?.method === "tools/call") {
      const auth = request.authorization ?? "";
      const echo =
        fake.options.echoHeaders === "text"
          ? `; auth was ${auth}`
          : fake.options.echoHeaders === "json-escaped"
            ? `; auth was ${auth}`
            : "";
      const text = `called ${String(request.rpc.params?.["name"] ?? "")}${echo}`;

      const message = { jsonrpc: "2.0", id, result: { resultType: "complete", content: [{ type: "text", text }] } };
      if (fake.options.echoHeaders !== "json-escaped") return { message };

      // Hand-built so the credential is spelled with escapes rather than
      // whatever `JSON.stringify` felt was necessary.
      const escaped = JSON.stringify(message).replace(JSON.stringify(auth).slice(1, -1), fullyEscape(auth));
      return { raw: escaped };
    }

    return { status: 404, raw: "" };
  };

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let rpc: FakeRequest["rpc"] = null;
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null) rpc = parsed as FakeRequest["rpc"];
      } catch {
        rpc = null;
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers[name] = value;
      }

      const request: FakeRequest = {
        method: incoming.method ?? "",
        headers,
        authorization: headers["authorization"],
        body,
        rpc
      };
      received.push(request);

      const reply = fake.respond?.(request) ?? defaultReply(request);
      const framing = reply.framing ?? fake.options.framing;
      const payload = reply.raw ?? JSON.stringify(reply.message ?? {});

      const responseHeaders: Record<string, string> = {
        "content-type": framing === "sse" ? "text/event-stream" : "application/json"
      };
      if (fake.options.echoIntoResponseHeader && request.authorization !== undefined) {
        responseHeaders["content-type"] = `${responseHeaders["content-type"]}; echo=${request.authorization}`;
        // A header the client must not read at all, allowlist or no.
        responseHeaders["x-echo"] = request.authorization;
      }

      outgoing.writeHead(reply.status ?? 200, responseHeaders);
      // The stream is closed after the response, which is what the spec says a
      // server SHOULD do. A server that holds it open is the interop risk this
      // client accepts, and it fails as a timeout rather than as a wrong answer.
      outgoing.end(framing === "sse" ? `data: ${payload}\n\n` : payload);
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return Object.assign(fake, {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      })
  });
}
