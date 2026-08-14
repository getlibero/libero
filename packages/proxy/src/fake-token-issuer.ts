// An OAuth authorization server that is not one.
//
// Shipped beside ./mcp-fake-server.ts and on its argument: the e2e suite
// (#258) needs an authorization server that records what a token request
// actually carried, and it should be a harness over this rather than a second
// implementation whose knobs quietly stop matching what the exchange does.
// Exporting it widens nothing — it is a server, holds no store, no engine and
// no client, and can open nothing.
//
// A real `node:http` server on loopback, port 0, no dependency: the refresh
// token crosses a real socket, which is the only way the leak tests mean
// anything.
//
// What it fakes is the two endpoints the exchange touches — RFC 8414
// discovery at the well-known path, and the token endpoint — plus the two
// behaviours the engine's contract hangs on: rotation (each exchange
// invalidates the presented refresh token and issues a successor) and reuse
// detection (a stale or unknown refresh token is answered `invalid_grant`).
// Everything else is a knob, because the negative tests that matter — an
// issuer echoing the wrong identity, a token endpoint on another origin, a
// hanging exchange, an oversized body — are this fake with one field changed.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTokenRequest {
  /** The parsed form body: grant_type, refresh_token, client_id. */
  readonly form: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

/** What a hook answers, or `null` for the fake's own behaviour. */
export interface FakeIssuerReply {
  readonly status?: number;
  /** The raw body. A string is sent as-is; an object is JSON. */
  readonly body?: string | Record<string, unknown>;
  /** Record the request and never answer. The client's timeout is the test's bound. */
  readonly hang?: boolean;
}

export interface FakeTokenIssuerOptions {
  /** The refresh token the next exchange must present. */
  readonly refreshToken: string;
  /** Rotate on each exchange, OAuth 2.1's default posture. */
  readonly rotate: boolean;
  /** `expires_in` on each minted token; `null` omits the field entirely. */
  readonly expiresInSeconds: number | null;
  /** What discovery's `issuer` field claims. Defaults to the real url. */
  readonly issuerEcho?: string;
  /** What discovery offers as the token endpoint. Defaults to `<url>/token`. */
  readonly tokenEndpoint?: string;
}

export interface FakeTokenIssuer {
  /** The issuer identifier: `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly discoveryRequests: number;
  readonly tokenRequests: readonly FakeTokenRequest[];
  /** Every access token minted, in order. The upstream fake checks the last. */
  readonly accessTokens: readonly string[];
  /** The refresh token the *next* exchange must present. */
  readonly currentRefreshToken: string;
  /** Override the token endpoint per request; `null` falls through to the fake. */
  respondToken: ((request: FakeTokenRequest) => FakeIssuerReply | null) | undefined;
  /** Override discovery per request; `null` falls through to the fake. */
  respondDiscovery: (() => FakeIssuerReply | null) | undefined;
  close(): Promise<void>;
}

export async function startFakeTokenIssuer(
  overrides: Partial<FakeTokenIssuerOptions> = {}
): Promise<FakeTokenIssuer> {
  const options: FakeTokenIssuerOptions = {
    refreshToken: "rt_initial",
    rotate: true,
    expiresInSeconds: 3_600,
    ...overrides
  };

  let discoveryRequests = 0;
  const tokenRequests: FakeTokenRequest[] = [];
  const accessTokens: string[] = [];
  let currentRefreshToken = options.refreshToken;
  let minted = 0;

  let respondToken: ((request: FakeTokenRequest) => FakeIssuerReply | null) | undefined;
  let respondDiscovery: (() => FakeIssuerReply | null) | undefined;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const send = (reply: FakeIssuerReply): void => {
        if (reply.hang === true) return; // recorded, never answered
        const body =
          reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(body);
      };

      const url = new URL(req.url ?? "/", issuerUrl);

      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        discoveryRequests += 1;
        const overridden = respondDiscovery?.();
        if (overridden !== null && overridden !== undefined) {
          send(overridden);
          return;
        }
        send({
          body: {
            issuer: options.issuerEcho ?? issuerUrl,
            token_endpoint: options.tokenEndpoint ?? `${issuerUrl}/token`,
            authorization_endpoint: `${issuerUrl}/authorize`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"]
          }
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/token") {
        const form: Record<string, string> = {};
        for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
          form[name] = value;
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
        const request: FakeTokenRequest = { form, headers };
        tokenRequests.push(request);

        const overridden = respondToken?.(request);
        if (overridden !== null && overridden !== undefined) {
          send(overridden);
          return;
        }

        // Reuse detection, the behaviour the theft signal hangs on: only the
        // current refresh token exchanges, and under rotation each exchange
        // invalidates the one presented.
        if (form.grant_type !== "refresh_token" || form.refresh_token !== currentRefreshToken) {
          send({ status: 400, body: { error: "invalid_grant" } });
          return;
        }

        minted += 1;
        const accessToken = `at_minted_${minted}`;
        accessTokens.push(accessToken);
        const rotated = options.rotate ? `rt_rotated_${minted}` : undefined;
        if (rotated !== undefined) currentRefreshToken = rotated;

        send({
          body: {
            access_token: accessToken,
            token_type: "Bearer",
            ...(options.expiresInSeconds !== null ? { expires_in: options.expiresInSeconds } : {}),
            ...(rotated !== undefined ? { refresh_token: rotated } : {})
          }
        });
        return;
      }

      send({ status: 404, body: { error: "not_found" } });
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const issuerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: issuerUrl,
    get discoveryRequests() {
      return discoveryRequests;
    },
    tokenRequests,
    accessTokens,
    get currentRefreshToken() {
      return currentRefreshToken;
    },
    get respondToken() {
      return respondToken;
    },
    set respondToken(value) {
      respondToken = value;
    },
    get respondDiscovery() {
      return respondDiscovery;
    },
    set respondDiscovery(value) {
      respondDiscovery = value;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
