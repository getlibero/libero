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
// **It speaks both protocols, because the client has to choose between them
// without being told.** A `legacy` fake refuses `server/discover` the way an
// older framework does and answers `initialize`, holding real session state: it
// issues an id, requires it on every later request, 404s one it has forgotten,
// and drops it on a `DELETE`. That state is what makes the reconnect and
// concurrency tests claims about behaviour rather than about call counts — a
// test can expire a session mid-call and watch the client recover, which no
// amount of stubbing a response body would demonstrate.
//
// It lives in `src` because the tests do. `package.json`'s test script excludes
// `dist`, so the compiled copy is never collected.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION, METHOD_NOT_FOUND } from "./mcp-protocol.js";

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
  /** Extra response headers. The legacy handshake assigns its session in one. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Record the request and never answer it, so the caller hits its own timeout.
   *
   * The one thing this fake could not do before: it always wrote a response, so
   * a transport failure needed a second bare server standing up alongside it.
   */
  readonly hang?: boolean;
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
  /**
   * Which protocol this server speaks.
   *
   * `legacy` refuses `server/discover` the way a pre-`2026-07-28` framework
   * does — an unrouted method — and answers `initialize` instead.
   */
  protocol: "stateless" | "legacy";
  /**
   * How a legacy server refuses `server/discover`.
   *
   * Three shapes because the client must not classify on any of them: the
   * attempt is the discriminator, not the code, and a test that only ever sees
   * one shape would let a code check creep back in unnoticed.
   */
  discoverRefusal: "rpc_error" | "http_400" | "http_404";
  /** Whether `initialize` assigns a session. `false` is the legacy-sessionless upstream. */
  sessions: boolean;
  /** What `initialize` names as the revision it will speak. */
  legacyVersion: string;
  /**
   * Answer with the received `Authorization` as the session id.
   *
   * The session-id twin of `echoHeaders`: it proves the redaction pass covers
   * the header the allowlist newly admits, and that a marker rather than a
   * value is what gets replayed.
   */
  echoAuthAsSessionId: boolean;
  /** Record a request with this JSON-RPC method and never answer it. */
  hangOn: string | null;
}

export interface FakeMcpServer {
  readonly url: string;
  readonly received: FakeRequest[];
  /** Every request whose JSON-RPC `method` was this one. */
  callsTo(method: string): FakeRequest[];
  /** Replaces the default behaviour for one test. Return `null` to fall through. */
  respond: ((request: FakeRequest) => FakeReply | null) | null;
  options: FakeMcpServerOptions;
  /** Every session id this server has issued and not yet forgotten. */
  readonly liveSessions: ReadonlySet<string>;
  /**
   * Forget every live session, so the next request carrying one gets a 404.
   *
   * Called from inside a `respond` hook it expires the very request that
   * triggered it, because `respond` runs before the default handler.
   */
  expireSessions(): void;
  close(): Promise<void>;
}

const DEFAULTS: FakeMcpServerOptions = {
  framing: "json",
  echoHeaders: "off",
  echoIntoResponseHeader: false,
  supportedVersions: [MCP_PROTOCOL_VERSION],
  protocol: "stateless",
  discoverRefusal: "rpc_error",
  sessions: true,
  legacyVersion: LEGACY_PROTOCOL_VERSION,
  echoAuthAsSessionId: false,
  hangOn: null
};

/** Spell every character as `\uXXXX`, the way an over-eager encoder would. */
function fullyEscape(text: string): string {
  return Array.from({ length: text.length }, (_, i) => `\\u${text.charCodeAt(i).toString(16).padStart(4, "0")}`).join(
    ""
  );
}

export async function startFakeMcpServer(overrides: Partial<FakeMcpServerOptions> = {}): Promise<FakeMcpServer> {
  const received: FakeRequest[] = [];
  const sessions = new Set<string>();
  let issued = 0;
  const fake: FakeMcpServer = {
    url: "",
    received,
    callsTo: method => received.filter(request => request.rpc?.method === method),
    respond: null,
    options: { ...DEFAULTS, ...overrides },
    liveSessions: sessions,
    expireSessions: () => sessions.clear(),
    close: async () => {}
  };

  /** How a legacy framework answers a method it has never heard of. */
  const refuseDiscover = (id: number): FakeReply => {
    switch (fake.options.discoverRefusal) {
      case "http_400":
        return { status: 400, raw: "missing session id" };
      case "http_404":
        return { status: 404, raw: "" };
      case "rpc_error":
        return { message: { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: "no such method" } } };
    }
  };

  const openSession = (request: FakeRequest): FakeReply => {
    const id = request.rpc?.id ?? 0;
    const message = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: fake.options.legacyVersion,
        capabilities: {},
        serverInfo: { name: "fake", version: "0" }
      }
    };
    if (!fake.options.sessions) return { message };

    issued += 1;
    // The bare token rather than the whole header, so the assigned id is a
    // legal session id: a hostile server reflecting the credential would pick
    // the spelling that gets replayed, not the one a validator throws out.
    const reflected = request.authorization?.replace(/^Bearer /, "");
    const assigned =
      fake.options.echoAuthAsSessionId && reflected !== undefined ? reflected : `session-${String(issued)}`;
    sessions.add(assigned);
    return { message, headers: { "mcp-session-id": assigned } };
  };

  const defaultReply = (request: FakeRequest): FakeReply => {
    const id = request.rpc?.id ?? 0;

    if (fake.options.hangOn !== null && request.rpc?.method === fake.options.hangOn) return { hang: true };

    // The session is terminated whatever protocol the rest of this fake is
    // speaking, so a stray `DELETE` is never mistaken for a tool call.
    if (request.method === "DELETE") {
      const carried = request.headers["mcp-session-id"];
      if (carried !== undefined) sessions.delete(carried);
      return { status: 204, raw: "" };
    }

    if (fake.options.protocol === "legacy") {
      if (request.rpc?.method === "server/discover") return refuseDiscover(id);
      if (request.rpc?.method === "initialize") return openSession(request);
      // A 202 with an empty body, which is what the spec says. Deliberately not
      // a 200 with `{}`: a client that ran this through its response parser
      // would report the empty body as malformed, and answering with valid JSON
      // would hide that mistake rather than catch it.
      if (request.rpc?.method === "notifications/initialized") return { status: 202, raw: "" };
      // Every request after the handshake has to carry a live session. An
      // unknown one is a 404 — the spec's signal for a session the server has
      // forgotten — and it is generated here, before anything is dispatched,
      // which is what makes replaying that one request safe.
      if (fake.options.sessions) {
        const carried = request.headers["mcp-session-id"];
        if (carried === undefined || !sessions.has(carried)) return { status: 404, raw: "no such session" };
      }
    } else if (request.rpc?.method === "server/discover") {
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
      // Recorded above, answered never: the caller is left to hit its own
      // timeout. The socket is torn down by `closeAllConnections` at the end of
      // the test rather than here.
      if (reply.hang === true) return;

      const framing = reply.framing ?? fake.options.framing;
      const payload = reply.raw ?? JSON.stringify(reply.message ?? {});

      const responseHeaders: Record<string, string> = {
        "content-type": framing === "sse" ? "text/event-stream" : "application/json",
        ...reply.headers
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
        // Before `close()`, which otherwise waits for sockets to go idle: a
        // `hangOn` request leaves the caller still holding one, and the wait
        // would hang the test's teardown rather than the request under test.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  });
}
