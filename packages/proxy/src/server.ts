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
// What is not here yet: the tool list and tool call endpoints, which need the
// team sheet (#36) and the vault (#50) to mean anything.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { PROXY_ERROR_STATUS, type ProxyError, type ProxyErrorCode } from "@getlibero/schema";
import { resolveChannel } from "./identity.js";
import { createJsonLogger, type Logger } from "./log.js";

export interface ProxyServerOptions {
  /** From `loadTlsOptions`. Passed through to the https server verbatim. */
  tls: ServerOptions;
  logger?: Logger;
  /** Clock, injected for tests. */
  now?: () => number;
}

/** What a route is handed. The channel is authenticated, not asserted. */
export interface RequestContext {
  readonly channel: string;
  readonly requestId: string;
}

/** May return a promise; the dispatcher resolves it before serializing. */
type RouteHandler = (ctx: RequestContext) => unknown;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
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
  const logger = options.logger ?? createJsonLogger();
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const routes = new Map<string, Map<string, RouteHandler>>([
    [
      // Behind mutual TLS *and* the channel-identity gate like everything
      // else: there is no anonymous surface on this listener, and a caller
      // probing liveness needs a certificate that names a channel — any
      // CA-signed certificate is not enough. That is why docker-compose
      // carries no healthcheck yet; whether monitoring gets a carve-out from
      // the identity gate or a certificate of its own is decided by the issue
      // that adds one, not implied here.
      "/health",
      new Map<string, RouteHandler>([["GET", () => ({ status: "ok", uptimeMs: now() - startedAt })]])
    ],
    [
      // What the connection authenticated as. Small, but it is the endpoint
      // that makes the identity binding observable to an operator with curl.
      "/v1/whoami",
      new Map<string, RouteHandler>([["GET", ctx => ({ channel: ctx.channel })]])
    ]
  ]);

  const server = createServer(options.tls, (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    // Nothing here reads a request body. Draining keeps a client that sent one
    // from holding the socket open waiting for it to be consumed.
    req.resume();

    const method = req.method ?? "GET";
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "https://proxy.invalid").pathname;
    } catch {
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
      respond(
        PROXY_ERROR_STATUS.not_found,
        proxyError("not_found", `no route for ${pathname}`, requestId, channel)
      );
      return;
    }

    const handler = handlers.get(method);
    if (handler === undefined) {
      res.setHeader("allow", [...handlers.keys()].join(", "));
      respond(
        PROXY_ERROR_STATUS.method_not_allowed,
        proxyError("method_not_allowed", `${method} is not allowed on ${pathname}`, requestId, channel)
      );
      return;
    }

    // Promise-aware dispatch, ahead of need: the tool-call endpoint (#51)
    // will be async, and without this the day's symptom would be a pending
    // Promise serialized as {} with status 200 — or a rejection escaping the
    // process as an unhandled rejection.
    Promise.resolve()
      .then(() => handler({ channel, requestId }))
      .then(body => {
        respond(200, body);
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
