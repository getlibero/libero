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
// What it fakes is the three endpoints the exchanges and the grant flow
// touch — RFC 8414 discovery at the well-known path, the token endpoint, and
// the authorization endpoint (a 302 straight back to the redirect URI, so a
// test can be the browser by following one hop) — plus the behaviours the
// contracts hang on: rotation (each exchange invalidates the presented
// refresh token and issues a successor), reuse detection (a stale or unknown
// refresh token is answered `invalid_grant`), and PKCE (a code exchanges only
// with the verifier whose S256 hash the authorization request carried, once).
// Everything else is a knob, because the negative tests that matter — an
// issuer echoing the wrong identity, a token endpoint on another origin, a
// hanging exchange, an oversized body — are this fake with one field changed.
//
// **Since #505 it also verifies DPoP proofs, and that half is the load-bearing
// one.** A fake that accepted any proof would let every DPoP test pass over a
// client that signed nothing, which is the failure #484 named: a fake has to be
// as strict as the thing it stands in for or it proves the opposite of what it
// was written for. So `dpop: true` makes this server check the signature
// against the key the proof carries, check `htm` and `htu` against the request
// it actually received, check `iat` against a window, refuse a `jti` it has seen
// before, demand its own nonce where it issued one, and — the property the whole
// feature exists for — bind each refresh token to the key that proved for it and
// refuse a later exchange presenting a different one.
//
// It computes the thumbprint, the `htu` and the digest **itself** rather than
// importing ./dpop.ts's, deliberately. A verifier that shares the maker's
// arithmetic agrees with it by construction; written from RFC 9449 instead, a
// disagreement between the two is a test failure rather than a fact nobody
// learns until an authorization server disagrees in production.
//
// `dpopFailures` records *why* it refused, and the tests assert on that rather
// than on the 400 alone: a fake that rejected a replay because it mis-parsed the
// header would make a replay test green for the wrong reason.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
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
  /** Extra response headers — how an authorize override shapes its redirect. */
  readonly headers?: Readonly<Record<string, string>>;
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
  /** Whether a code exchange gets a refresh token. `false` is the issuer a headless proxy cannot use. */
  readonly issueRefreshToken?: boolean;
  /** A `scope` member on code-exchange responses — the narrowed-grant knob. Absent by default. */
  readonly grantedScopeEcho?: string;
  /**
   * Advertise DPoP and verify the proofs that follow (#505).
   *
   * Off by default, so every test written before this one keeps the bearer
   * server it was written against — which is also what makes "the bearer path
   * is byte-identical where the issuer is silent" a thing the suite can check
   * rather than a thing the diff claims.
   */
  readonly dpop?: boolean;
  /**
   * Answer the first proof-carrying token request with a nonce challenge.
   *
   * RFC 9449 §8's dance, and the reason it is a knob rather than the default:
   * an authorization server that always challenges doubles every exchange, so
   * a suite that had no way to turn it off would be testing the retry and
   * nothing else.
   */
  readonly requireNonce?: boolean;
}

export interface FakeTokenIssuer {
  /** The issuer identifier: `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly discoveryRequests: number;
  readonly tokenRequests: readonly FakeTokenRequest[];
  /** The query of every authorization request, in order. */
  readonly authorizeRequests: readonly Readonly<Record<string, string>>[];
  /** Every access token minted, in order. The upstream fake checks the last. */
  readonly accessTokens: readonly string[];
  /** The refresh token the *next* exchange must present. */
  readonly currentRefreshToken: string;
  /**
   * Why each refused proof was refused, in order — a closed vocabulary, so a
   * test asserts the reason rather than the status code. Empty on a clean run.
   */
  readonly dpopFailures: readonly string[];
  /** The thumbprint the current grant is bound to, or `undefined` while it is bearer. */
  readonly boundThumbprint: string | undefined;
  /** Override the token endpoint per request; `null` falls through to the fake. */
  respondToken: ((request: FakeTokenRequest) => FakeIssuerReply | null) | undefined;
  /** Override discovery per request; `null` falls through to the fake. */
  respondDiscovery: (() => FakeIssuerReply | null) | undefined;
  /** Override the authorization endpoint per request; `null` falls through to the fake's 302. */
  respondAuthorize: ((query: Readonly<Record<string, string>>) => FakeIssuerReply | null) | undefined;
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
  const authorizeRequests: Readonly<Record<string, string>>[] = [];
  const accessTokens: string[] = [];
  let currentRefreshToken = options.refreshToken;
  let minted = 0;
  let codesIssued = 0;
  // Codes are single-use: an exchange deletes its entry, and a second
  // presentation of the same code is `invalid_grant` — reuse detection for
  // the front channel, as `currentRefreshToken` is for the back.
  const pendingCodes = new Map<string, { codeChallenge: string; redirectUri: string; state: string | undefined }>();

  const dpopFailures: string[] = [];
  // Every `jti` this server has seen. A replay is a proof it has already
  // accepted, and remembering them is the only way to catch one.
  const seenJti = new Set<string>();
  let boundThumbprint: string | undefined;
  let issuedNonce: string | undefined;

  /**
   * Verify one proof against the request it arrived on, RFC 9449 §4.3.
   *
   * Returns the key's thumbprint, or `null` having recorded why not. Written
   * from the RFC rather than from ./dpop.ts — see the header — so every value it
   * compares against is recomputed here: the `htu` from this request's own URL,
   * the thumbprint from the JWK's own members.
   */
  const verifyProof = (
    proof: string | undefined,
    method: string,
    requestUrl: string
  ): string | null => {
    const refuse = (why: string): null => {
      dpopFailures.push(why);
      return null;
    };
    if (proof === undefined) return refuse("missing_proof");

    const parts = proof.split(".");
    if (parts.length !== 3) return refuse("not_a_jws");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return refuse("not_json");
    }

    if (header["typ"] !== "dpop+jwt") return refuse("wrong_typ");
    if (header["alg"] !== "ES256") return refuse("wrong_alg");
    const jwk = header["jwk"];
    if (typeof jwk !== "object" || jwk === null) return refuse("no_jwk");
    const members = jwk as Record<string, unknown>;
    // A private key in a proof header is a client leaking its own key; the RFC
    // forbids it and a verifier that accepted one would never tell anybody.
    if (members["d"] !== undefined) return refuse("private_key_in_header");
    if (members["kty"] !== "EC" || members["crv"] !== "P-256") return refuse("wrong_key_type");
    if (typeof members["x"] !== "string" || typeof members["y"] !== "string") return refuse("malformed_jwk");

    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    } catch {
      return refuse("malformed_jwk");
    }
    const signed = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url")
    );
    if (!signed) return refuse("bad_signature");

    if (payload["htm"] !== method) return refuse("wrong_htm");
    const expectedHtu = new URL(requestUrl);
    expectedHtu.search = "";
    expectedHtu.hash = "";
    if (payload["htu"] !== expectedHtu.toString()) return refuse("wrong_htu");

    const iat = payload["iat"];
    if (typeof iat !== "number") return refuse("no_iat");
    if (Math.abs(Math.floor(Date.now() / 1_000) - iat) > 300) return refuse("stale_iat");

    const jti = payload["jti"];
    if (typeof jti !== "string" || jti.length === 0) return refuse("no_jti");
    if (seenJti.has(jti)) return refuse("replayed_jti");

    if (issuedNonce !== undefined && payload["nonce"] !== issuedNonce) return refuse("wrong_nonce");

    // RFC 7638 over the required members, in the order the RFC fixes. Written
    // out here rather than shared with ./signing-key.ts: this is the check a
    // real server makes, and it has to be able to disagree.
    const thumbprint = createHash("sha256")
      .update(`{"crv":"P-256","kty":"EC","x":"${String(members["x"])}","y":"${String(members["y"])}"}`, "utf8")
      .digest("base64url");

    seenJti.add(jti);
    return thumbprint;
  };

  let respondToken: ((request: FakeTokenRequest) => FakeIssuerReply | null) | undefined;
  let respondDiscovery: (() => FakeIssuerReply | null) | undefined;
  let respondAuthorize: ((query: Readonly<Record<string, string>>) => FakeIssuerReply | null) | undefined;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const send = (reply: FakeIssuerReply): void => {
        if (reply.hang === true) return; // recorded, never answered
        const body =
          reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
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
            code_challenge_methods_supported: ["S256"],
            ...(options.dpop === true ? { dpop_signing_alg_values_supported: ["ES256"] } : {})
          }
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/authorize") {
        const query: Record<string, string> = {};
        for (const [name, value] of url.searchParams) query[name] = value;
        authorizeRequests.push(query);

        const overridden = respondAuthorize?.(query);
        if (overridden !== null && overridden !== undefined) {
          send(overridden);
          return;
        }

        // No consent screen: the fake approves instantly with a 302 to the
        // redirect URI, which is where a test playing the browser reads the
        // `location` header instead of following it.
        if (query.redirect_uri === undefined) {
          send({ status: 400, body: { error: "invalid_request" } });
          return;
        }
        codesIssued += 1;
        const code = `code_${codesIssued}`;
        pendingCodes.set(code, {
          codeChallenge: query.code_challenge ?? "",
          redirectUri: query.redirect_uri,
          state: query.state
        });
        const location = new URL(query.redirect_uri);
        location.searchParams.set("code", code);
        if (query.state !== undefined) location.searchParams.set("state", query.state);
        res.writeHead(302, { location: location.toString() });
        res.end();
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

        // The proof is judged before the grant is, which is the order a real
        // server uses: a request that cannot prove who it is has not asked a
        // question about a refresh token yet.
        let provedThumbprint: string | undefined;
        if (options.dpop === true) {
          if (options.requireNonce === true && issuedNonce === undefined) {
            // The challenge, issued once. The client is expected to come back
            // with it inside a *fresh* proof — a re-sent one fails on `jti`,
            // which is the check that makes the retry a real one.
            issuedNonce = `nonce_${randomBytes(6).toString("hex")}`;
            res.writeHead(400, { "content-type": "application/json", "dpop-nonce": issuedNonce });
            res.end(JSON.stringify({ error: "use_dpop_nonce" }));
            return;
          }
          const thumbprint = verifyProof(headers["dpop"], "POST", `${issuerUrl}${url.pathname}`);
          if (thumbprint === null) {
            send({ status: 400, body: { error: "invalid_dpop_proof" } });
            return;
          }
          // Thumbprint continuity: a grant is bound to the key that was proved
          // for when it was made, and a later exchange under another key is
          // refused. This is the property sender-constraining exists for — a
          // stolen refresh token in somebody else's hands proves nothing.
          if (boundThumbprint !== undefined && boundThumbprint !== thumbprint) {
            dpopFailures.push("thumbprint_changed");
            send({ status: 400, body: { error: "invalid_dpop_proof" } });
            return;
          }
          provedThumbprint = thumbprint;
        }

        if (form.grant_type === "authorization_code") {
          const pending = form.code === undefined ? undefined : pendingCodes.get(form.code);
          if (
            form.code === undefined ||
            pending === undefined ||
            form.redirect_uri !== pending.redirectUri ||
            form.code_verifier === undefined ||
            createHash("sha256").update(form.code_verifier).digest("base64url") !== pending.codeChallenge
          ) {
            send({ status: 400, body: { error: "invalid_grant" } });
            return;
          }
          pendingCodes.delete(form.code);

          minted += 1;
          const accessToken = `at_minted_${minted}`;
          accessTokens.push(accessToken);
          const granted = (options.issueRefreshToken ?? true) ? `rt_granted_${minted}` : undefined;
          // The grant's refresh token becomes the current one, so a follow-on
          // *refresh* exchange by the engine succeeds — the loop from grant to
          // served call closes inside one fake.
          if (granted !== undefined) currentRefreshToken = granted;
          if (provedThumbprint !== undefined) boundThumbprint = provedThumbprint;

          send({
            body: {
              access_token: accessToken,
              token_type: provedThumbprint === undefined ? "Bearer" : "DPoP",
              ...(options.expiresInSeconds !== null ? { expires_in: options.expiresInSeconds } : {}),
              ...(granted !== undefined ? { refresh_token: granted } : {}),
              ...(options.grantedScopeEcho !== undefined ? { scope: options.grantedScopeEcho } : {})
            }
          });
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
        // A refresh under a proof carries the binding forward to the successor,
        // which is what makes the continuity check above mean anything past the
        // first exchange.
        if (provedThumbprint !== undefined) boundThumbprint = provedThumbprint;

        send({
          body: {
            access_token: accessToken,
            token_type: provedThumbprint === undefined ? "Bearer" : "DPoP",
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
    authorizeRequests,
    accessTokens,
    get currentRefreshToken() {
      return currentRefreshToken;
    },
    dpopFailures,
    get boundThumbprint() {
      return boundThumbprint;
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
    get respondAuthorize() {
      return respondAuthorize;
    },
    set respondAuthorize(value) {
      respondAuthorize = value;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
