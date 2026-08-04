// The tool proxy's HTTP surface.
//
// Node's own https server and an exact-match route table, no framework. This
// process holds every credential in the deployment, so its dependency list is
// a security property in its own right.
//
// The rule, stated as what is actually enforced rather than as "zero": nothing
// third-party here beyond what reading a team sheet requires — today zod and
// smol-toml, reached through @getlibero/schema, each with no dependencies of
// its own and both on the licence allowlist. A framework, a logger, an HTTP
// client, or a TOML parser this process pulls in directly are all things a
// reviewer should reject. The claim was previously "zero", which was never
// quite true: zod has been in this tree since the first team-sheet import.
//
// Every request that reaches a route has already proved two things: it opened
// a connection with a certificate the local CA signed, and that certificate
// named a channel. Routes therefore receive a channel id rather than deriving
// one, and no route may accept a channel from a header, a query parameter, or
// a body.
//
// What is not here yet: the MCP client pool (#39). It sits behind the
// dispatcher seam, past the point where enforcement has already answered.
// Credential injection is built — ./http-dispatcher.ts resolves a credential
// and ./outbound.ts attaches it — but no route reaches the vault even so: a
// credential is resolved by whatever serves an allowed call, and this file
// hands that a decision rather than a secret. `apps/proxy-server` still
// composes the stand-ins, so the shipped process continues to answer 501.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import {
  PROXY_ERROR_STATUS,
  type ProxyError,
  type ProxyErrorCode,
  ToolCall,
  type ToolCallResponse,
  type ToolListing,
  resolveToolCall
} from "@getlibero/schema";
import { assertServableComposition, type SpendMeter, type ToolDispatcher } from "./dispatch.js";
import { decideFromState, permittedToolsFromState } from "./enforce.js";
import { resolveChannel } from "./identity.js";
import { createJsonLogger, type LogFields, type Logger } from "./log.js";
import type { TeamSheetStore } from "./team-sheet-store.js";

/**
 * The most a tool call may weigh.
 *
 * A tool call is an id, two names, and the model's arguments. A megabyte is
 * already far more than any of that, and the cap exists so a client cannot
 * make this process buffer without bound — the check runs before the bytes are
 * kept, not after.
 */
export const MAX_BODY_BYTES = 1_048_576;

export interface ProxyServerOptions {
  /** From `loadTlsOptions`. Passed through to the https server verbatim. */
  tls: ServerOptions;
  /** Resolves the team sheet that authorizes each channel. */
  sheets: TeamSheetStore;
  /**
   * Required, not defaulted, both of them. See the note in ./dispatch.ts: a
   * missing meter that reads as unmetered, or a missing dispatcher that reads
   * as permissive, are the two ways an option with a default goes wrong here.
   */
  spend: SpendMeter;
  dispatcher: ToolDispatcher;
  logger?: Logger;
  /** Clock, injected for tests. */
  now?: () => number;
}

/** What a route is handed. The channel is authenticated, not asserted. */
export interface RequestContext {
  readonly channel: string;
  readonly requestId: string;
  /**
   * The parsed JSON body, for routes that asked for one, and `undefined` for
   * every other route. `unknown` rather than a shape: this has been through
   * `JSON.parse` and nothing else, and the route validates it against a schema
   * before reading a field off it.
   */
  readonly body: unknown;
}

/** An HTTP status and the body to serialize. */
export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

/** May return a promise; the dispatcher resolves it before serializing. */
type RouteHandler = (ctx: RequestContext) => RouteResponse | Promise<RouteResponse>;

interface Route {
  readonly handler: RouteHandler;
  /**
   * Whether this route reads a request body. Opt-in, so the default stays
   * "drain it": a route that does not declare a body cannot be made to consume
   * one, and adding a route does not require remembering to.
   */
  readonly body?: "json";
}

const ok = (body: unknown): RouteResponse => ({ status: 200, body });

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "malformed" };

/**
 * Read a JSON request body, refusing to buffer past the cap.
 *
 * Two checks, not one. `content-length` is a claim by the client and is
 * honoured only as an early exit; the running total is what actually bounds
 * memory, because a chunked request can omit the header or lie about it.
 *
 * Past the cap the buffer is dropped and the rest of the body is **drained,
 * not refused mid-flight**. Destroying the socket would bound memory just as
 * well and is the first thing to reach for, but it races the response: a client
 * still writing its body gets EPIPE and never reads the 413, so the operator's
 * symptom becomes a broken pipe rather than "the body was too large". Draining
 * costs only the read — nothing past the cap is retained — and buys an answer
 * the caller can act on.
 *
 * A malformed body is not distinguished from an empty one here. Both fail the
 * route's schema parse, and the caller learns its body was not a valid call
 * either way.
 */
function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise(resolve => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (read: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(read);
    };
    const tooLarge = (): void => {
      // Drop what was buffered; from here the stream is read and discarded.
      chunks = [];
      settle({ ok: false, reason: "too_large" });
    };

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) tooLarge();

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        // The parse error is not kept. It quotes the input, and the input is
        // written by the model.
        settle({ ok: false, reason: "malformed" });
      }
    });
    // A connection that dies mid-body is not a request the proxy can answer,
    // and it must not leave this promise pending and the response open.
    req.on("error", () => {
      settle({ ok: false, reason: "malformed" });
    });
    req.resume();
  });
}

function proxyError(
  code: ProxyErrorCode,
  message: string,
  requestId: string,
  channel?: string
): ProxyError {
  return {
    error: {
      code,
      message,
      requestId,
      ...(channel !== undefined ? { channel } : {})
    }
  };
}

export function createProxyServer(options: ProxyServerOptions): Server {
  // Before anything binds. A proxy that would serve tool calls without
  // metering them does not get built.
  assertServableComposition(options.spend, options.dispatcher);

  const logger = options.logger ?? createJsonLogger();
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  /**
   * The tool listing: what this channel may call.
   *
   * Not the enforcement — the call-time gate below is, and it holds on its own
   * against a tool that was never listed or was listed and has since been
   * removed. This keeps an unlisted tool out of the model's context, which is
   * worth doing and is not the same thing.
   */
  const listTools = async (ctx: RequestContext): Promise<RouteResponse> => {
    const state = await options.sheets.resolve(ctx.channel);
    const tools = permittedToolsFromState(state);
    logger.log("info", {
      event: "tools_listed",
      requestId: ctx.requestId,
      channel: ctx.channel,
      sheet: state.status,
      count: tools.length
    });
    return ok({ tools } satisfies ToolListing);
  };

  /**
   * The call-time gate. Order in here is the security property.
   *
   * The decision runs before anything else is touched: no credential is
   * resolved, no connection is opened, and the dispatcher is not reached
   * unless the answer was `allow`. A refused call must leave no trace upstream,
   * and the way that is true is that the only call to `options.dispatcher`
   * sits inside the `allow` branch.
   */
  const callTool = async (ctx: RequestContext): Promise<RouteResponse> => {
    // Strict, so a body asserting a channel fails here rather than having the
    // field dropped. The channel comes from the certificate, below.
    const parsed = ToolCall.safeParse(ctx.body);
    if (!parsed.success) {
      // The zod issues are not relayed. They quote the input, and the input is
      // written by the model.
      logger.log("warn", {
        event: "tool_call_malformed",
        requestId: ctx.requestId,
        channel: ctx.channel
      });
      return {
        status: PROXY_ERROR_STATUS.bad_request,
        body: proxyError(
          "bad_request",
          "the request body is not a valid tool call",
          ctx.requestId,
          ctx.channel
        )
      };
    }

    const call = resolveToolCall(parsed.data, ctx.channel);
    const [state, spend] = await Promise.all([
      options.sheets.resolve(ctx.channel),
      options.spend.read(ctx.channel)
    ]);
    const decision = decideFromState(state, call, spend);

    const audit = (outcome: NonNullable<LogFields["outcome"]>, reason?: string): void => {
      logger.log("info", {
        event: "tool_call",
        requestId: ctx.requestId,
        channel: ctx.channel,
        server: call.server,
        tool: call.tool,
        outcome,
        ...(reason !== undefined ? { reason } : {})
      });
    };

    if (decision.outcome !== "allow") {
      const outcome = decision.outcome === "hold" ? "held" : "refused";
      audit(outcome, decision.refusal.reason);
      // A refusal is a served request, not an error: 200 with the structured
      // shape. The agent relays it to the channel and carries on.
      return ok({ outcome, id: call.id, refusal: decision.refusal } satisfies ToolCallResponse);
    }

    // The upstream comes off the decision, not from a second lookup: the entry
    // that authorized the call is the entry the call goes to. See `Decision`.
    const dispatched = await options.dispatcher.dispatch(call, decision.upstream);
    switch (dispatched.outcome) {
      case "ran":
        audit("ran");
        return ok({ outcome: "ran", id: call.id, result: dispatched.result } satisfies ToolCallResponse);
      case "refused":
        // Refused while serving rather than before: the vault could not resolve
        // a credential (#51), or the destination is off the egress list (#73).
        audit("refused", dispatched.refusal.reason);
        return ok({
          outcome: "refused",
          id: call.id,
          refusal: dispatched.refusal
        } satisfies ToolCallResponse);
      case "unavailable":
        audit("unavailable");
        return {
          status: PROXY_ERROR_STATUS.not_implemented,
          body: proxyError(
            "not_implemented",
            "the call is permitted, and this proxy has no upstream to serve it",
            ctx.requestId,
            ctx.channel
          )
        };
    }
  };

  const routes = new Map<string, Map<string, Route>>([
    [
      // Behind mutual TLS *and* the channel-identity gate like everything
      // else: there is no anonymous surface on this listener, and a caller
      // probing liveness needs a certificate that names a channel — any
      // CA-signed certificate is not enough. That is why docker-compose
      // carries no healthcheck yet; whether monitoring gets a carve-out from
      // the identity gate or a certificate of its own is decided by the issue
      // that adds one, not implied here.
      "/health",
      new Map<string, Route>([
        ["GET", { handler: () => ok({ status: "ok", uptimeMs: now() - startedAt }) }]
      ])
    ],
    [
      // What the connection authenticated as. Small, but it is the endpoint
      // that makes the identity binding observable to an operator with curl.
      "/v1/whoami",
      new Map<string, Route>([["GET", { handler: ctx => ok({ channel: ctx.channel }) }]])
    ],
    ["/v1/tools", new Map<string, Route>([["GET", { handler: listTools }]])],
    ["/v1/tools/call", new Map<string, Route>([["POST", { handler: callTool, body: "json" }]])]
  ]);

  const server = createServer(options.tls, (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const method = req.method ?? "GET";

    // Draining is now per-route rather than unconditional, because a route
    // that reads a body has to attach its own listeners before anything
    // consumes the stream. Every path that does *not* read one still drains:
    // a client that sent a body and is never read from holds the socket open
    // waiting for it. Adding an early return here means adding a `drain()`.
    const drain = (): void => {
      req.resume();
    };

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "https://proxy.invalid").pathname;
    } catch {
      drain();
      logger.log("warn", { event: "request", requestId, method, status: 400, reason: "bad_url" });
      sendJson(
        res,
        PROXY_ERROR_STATUS.bad_request,
        proxyError("bad_request", "the request line is not a valid URL", requestId)
      );
      return;
    }

    const identity = resolveChannel(req.socket as TLSSocket);
    if (!identity.ok) {
      drain();
      // Method and path included deliberately: an operator whose agent is
      // being turned away needs to see what it was trying to do, and neither
      // is a secret.
      logger.log("warn", {
        event: "identity_rejected",
        requestId,
        method,
        path: pathname,
        reason: identity.reason,
        ...(identity.commonName !== undefined ? { commonName: identity.commonName } : {})
      });
      // The reason stays in the log. A caller learns that its certificate does
      // not name a channel, not which of the ways it failed to.
      sendJson(
        res,
        PROXY_ERROR_STATUS.unauthenticated,
        proxyError(
          "unauthenticated",
          "the client certificate does not identify a channel",
          requestId
        )
      );
      return;
    }

    const { channel } = identity;
    const handlers = routes.get(pathname);
    const respond = (status: number, body: unknown): void => {
      logger.log("info", { event: "request", requestId, channel, method, path: pathname, status });
      sendJson(res, status, body);
    };

    if (handlers === undefined) {
      drain();
      respond(
        PROXY_ERROR_STATUS.not_found,
        proxyError("not_found", `no route for ${pathname}`, requestId, channel)
      );
      return;
    }

    const route = handlers.get(method);
    if (route === undefined) {
      drain();
      res.setHeader("allow", [...handlers.keys()].join(", "));
      respond(
        PROXY_ERROR_STATUS.method_not_allowed,
        proxyError("method_not_allowed", `${method} is not allowed on ${pathname}`, requestId, channel)
      );
      return;
    }

    // Promise-aware dispatch: the tool-call endpoint reads a body and the
    // sheet, and without this the symptom would be a pending Promise
    // serialized as {} with status 200 — or a rejection escaping the process
    // as an unhandled rejection.
    Promise.resolve()
      .then(async (): Promise<RouteResponse> => {
        if (route.body !== "json") {
          drain();
          return route.handler({ channel, requestId, body: undefined });
        }

        const read = await readJsonBody(req, MAX_BODY_BYTES);
        if (!read.ok) {
          const code = read.reason === "too_large" ? "payload_too_large" : "bad_request";
          logger.log("warn", {
            event: "request_body_rejected",
            requestId,
            channel,
            method,
            path: pathname,
            reason: read.reason
          });
          return {
            status: PROXY_ERROR_STATUS[code],
            body: proxyError(
              code,
              read.reason === "too_large"
                ? `the request body exceeds ${MAX_BODY_BYTES} bytes`
                : "the request body is not valid JSON",
              requestId,
              channel
            )
          };
        }
        return route.handler({ channel, requestId, body: read.value });
      })
      .then(({ status, body }) => {
        respond(status, body);
      })
      .catch(() => {
        // The thrown value is deliberately not inspected or logged. In this
        // process an exception can carry a credential in its message, and the
        // requestId is enough to correlate the failure with the request.
        logger.log("error", { event: "handler_failed", requestId, channel, method, path: pathname });
        sendJson(
          res,
          PROXY_ERROR_STATUS.internal,
          proxyError("internal", "the proxy failed to handle the request", requestId, channel)
        );
      });
  });

  // Fires when a client presents no certificate, or one this CA did not sign.
  // The connection is already gone; this exists so a refused agent is visible
  // to an operator rather than silent.
  server.on("tlsClientError", (err: Error & { code?: string }) => {
    logger.log("warn", { event: "tls_client_rejected", reason: err.code ?? "unknown" });
  });

  return server;
}
