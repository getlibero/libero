// The agent's side of the mutual-TLS connection to the tool proxy.
//
// This is the only path from this process to a tool, and it is a network call
// by construction rather than by convention: the agent may not import the
// proxy (an ESLint rule and a CI grep both say so), so there is nothing here to
// short-circuit. Compromising this process yields the Slack tokens and the
// model provider key, and no tool credential, because no tool credential is
// reachable from here — the proxy holds them and this end never sees one.
//
// **The channel id never crosses the wire.** It selects which client
// certificate to present, and the proxy resolves the channel from that
// certificate's `CN=channel:<id>` — in its own identity resolver, and nowhere
// else. So a caller here naming a channel is not asserting one: it is choosing
// a key to authenticate with, and a channel whose certificate this process does
// not hold is a channel it cannot reach. That is the whole difference between
// an identity and a field.
//
// (This file names no path inside the proxy package, and not for style: CI
// greps the agent side for one, which is the second of the two checks that keep
// the import ban honest. Describe what the proxy does, do not cite where.)

import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { ChannelId } from "@getlibero/schema";

/** The most a proxy response may weigh, mirroring the proxy's own read cap. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** How long a request may take before it is abandoned, when nothing else says. */
export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

/**
 * Why a call to the proxy failed as a *request*, rather than being answered.
 *
 * A refusal is not in here. The proxy answering "not permitted" is a served
 * request and a normal result, which is the distinction `ToolCallResponse` and
 * `ProxyError` draw in @getlibero/schema; these are the ways there was no
 * answer at all.
 */
export type ProxyFailure =
  /** No connection: the proxy is down, the address is wrong, or the network is. */
  | "unreachable"
  /**
   * This channel has no client certificate, or one that cannot be read.
   *
   * Its own reason rather than a kind of `tls_rejected`, because it is the one
   * failure here that is permanent, per-channel, and a configuration mistake
   * rather than an outage: a channel whose certificate was never minted will
   * never reach the proxy, however healthy the proxy is. It is also the most
   * likely failure on a first deployment. The gateway tells the channel so
   * (apps/server/src/handler.ts) — nobody in a Slack thread is watching stdout,
   * and this one does not clear on its own.
   */
  | "no_client_certificate"
  /**
   * This end would not accept the proxy's certificate.
   *
   * One direction only, and the asymmetry is TLS 1.3's rather than a choice
   * here: the client finishes the handshake before the server has judged its
   * certificate, so a *server* rejecting a client certificate does not arrive
   * as a TLS alert this end can read. It arrives as `connection_reset`. Only
   * this side's own verification failures land here.
   */
  | "tls_rejected"
  /**
   * The proxy closed the connection without answering.
   *
   * Its own reason because it is genuinely ambiguous and an operator should be
   * told so rather than told a guess. Under TLS 1.3 this is what both of these
   * look like from here: the proxy went away mid-request, and the proxy
   * refused this channel's client certificate — the second being what a
   * certificate signed by a CA the proxy does not trust produces. There is no
   * information at the socket to tell them apart, so the two are not split into
   * a confident-sounding pair of wrong answers.
   */
  | "connection_reset"
  /** The proxy answered, and the answer is not a shape this client can read. */
  | "malformed_response"
  /** The proxy answered with a `ProxyError`: the request could not be served. */
  | "proxy_error"
  /** The request outlived its deadline, or the caller cancelled it. */
  | "timed_out"
  | "cancelled";

/**
 * Every failure the proxy client raises.
 *
 * Carries a `reason` code and a message written here, in the same discipline as
 * `CompletionError`: no response body, no cause chain, no URL. This message
 * reaches the model as tool-result content and the transcript it is stored in,
 * and an error is one of the paths a secret leaves a process that holds one.
 */
export class ProxyClientError extends Error {
  readonly reason: ProxyFailure;

  constructor(message: string, reason: ProxyFailure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyClientError";
    this.reason = reason;
  }
}

export interface ProxyTransportOptions {
  /** `PROXY_URL`. Must be https — see the check in `createProxyTransport`. */
  url: string;
  /** `PROXY_TLS_CA`. The proxy's certificate is verified against this and nothing else. */
  caPath: string;
  /** `PROXY_CLIENT_CERT_DIR`, holding `client-<channel>.pem` and `.key` per channel. */
  clientCertDir: string;
  timeoutMs?: number;
}

export interface ProxyResponse {
  readonly status: number;
  /** Through `JSON.parse` and nothing else. The caller validates it. */
  readonly body: unknown;
}

export interface ProxyRequest {
  /**
   * Which channel's certificate to present. Not a field on the request: it
   * chooses the key, and the proxy reads the identity off the certificate.
   */
  readonly channel: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ProxyTransport {
  request(options: ProxyRequest): Promise<ProxyResponse>;
}

/**
 * One `https.Agent` per channel, built from that channel's client certificate.
 *
 * Per channel rather than per process because the certificate *is* the
 * identity: one shared agent would mean one shared identity, which is the
 * design this whole boundary exists to avoid. Connections are pooled within a
 * channel, so a busy channel does not pay for a handshake per tool call.
 */
function createAgentCache(ca: Buffer, clientCertDir: string): (channel: string) => Agent {
  const agents = new Map<string, Agent>();

  return (channel: string): Agent => {
    const cached = agents.get(channel);
    if (cached !== undefined) return cached;

    // Before the id becomes a filename. `ChannelId` is the same rule the proxy
    // validates with, and it is what makes a validated id safe to use as a path
    // segment — no separator, no leading dot, so no `..` and no escape from the
    // certificate directory. The id reaching here comes from a Slack event, and
    // an event is not a place to trust a path from.
    if (!ChannelId.safeParse(channel).success) {
      throw new ProxyClientError(
        "proxy client: the channel id is not a valid channel id",
        "no_client_certificate"
      );
    }

    const agent = new Agent({
      ca,
      cert: readClientFile("client certificate", join(clientCertDir, `client-${channel}.pem`)),
      key: readClientFile("client key", join(clientCertDir, `client-${channel}.key`)),
      keepAlive: true,
      // The proxy listens TLS 1.3 only. Matching it here means a mismatch is a
      // startup-shaped failure rather than a handshake that silently negotiates
      // something neither end meant to allow.
      minVersion: "TLSv1.3"
    });
    agents.set(channel, agent);
    return agent;
  };
}

function read(role: string, path: string, reason: ProxyFailure): Buffer {
  try {
    return readFileSync(path);
  } catch {
    // Naming the path is the value of this message: the common failure is a
    // channel with no certificate minted, or a compose volume that did not
    // mount where the operator expected. A path is not a secret; the key it
    // points at is, and that is never read into a message.
    throw new ProxyClientError(`proxy client: cannot read ${role} at ${path}`, reason);
  }
}

/** A per-channel file. Missing means this channel cannot reach the proxy at all. */
function readClientFile(role: string, path: string): Buffer {
  return read(role, path, "no_client_certificate");
}

/**
 * The transport, over `node:https` and nothing else.
 *
 * No HTTP client dependency, for the reason the proxy's own server has none: a
 * package on this path is a package with a view of every tool call the
 * deployment makes.
 */
export function createProxyTransport(options: ProxyTransportOptions): ProxyTransport {
  const base = parseProxyUrl(options.url);
  // At construction, so a missing CA is a startup failure rather than every
  // task failing later at the far end of a thread. Not per-channel: one trust
  // anchor for the deployment, and without it nothing verifies the proxy.
  const ca = read("certificate authority", options.caPath, "tls_rejected");
  const agentFor = createAgentCache(ca, options.clientCertDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  return {
    // `async`, so resolving the channel's certificate rejects rather than
    // throwing synchronously. A caller awaiting a request should not have to
    // also try/catch the call that produced the promise.
    async request({ channel, method, path, body, signal }: ProxyRequest): Promise<ProxyResponse> {
      const agent = agentFor(channel);
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

      return await new Promise<ProxyResponse>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new ProxyClientError("proxy client: cancelled", "cancelled"));
          return;
        }

        const req = httpsRequest(
          {
            agent,
            host: base.host,
            port: base.port,
            path,
            method,
            timeout: timeoutMs,
            headers: {
              accept: "application/json",
              ...(payload !== undefined
                ? { "content-type": "application/json", "content-length": payload.byteLength }
                : {})
            }
          },
          res => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer) => {
              total += chunk.byteLength;
              // A response past the cap is dropped rather than buffered. The
              // proxy is ours and does not send one, which is exactly why an
              // oversized response means something other than the proxy is
              // answering and is not a thing to read into memory.
              if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk);
            });
            res.on("end", () => {
              if (total > MAX_RESPONSE_BYTES) {
                reject(
                  new ProxyClientError("proxy client: the response was too large", "malformed_response")
                );
                return;
              }
              const raw = Buffer.concat(chunks).toString("utf8");
              try {
                resolve({
                  status: res.statusCode ?? 0,
                  body: raw === "" ? undefined : JSON.parse(raw)
                });
              } catch {
                reject(
                  new ProxyClientError("proxy client: the response was not JSON", "malformed_response")
                );
              }
            });
            res.on("error", () => {
              reject(new ProxyClientError("proxy client: the response failed", "unreachable"));
            });
          }
        );

        const abort = (): void => {
          req.destroy(new ProxyClientError("proxy client: cancelled", "cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        req.on("close", () => signal?.removeEventListener("abort", abort));

        req.on("timeout", () => {
          req.destroy(new ProxyClientError("proxy client: the request timed out", "timed_out"));
        });

        req.on("error", (cause: NodeJS.ErrnoException) => {
          reject(cause instanceof ProxyClientError ? cause : transportError(cause));
        });

        req.end(payload);
      });
    }
  };
}

/**
 * The proxy's address, and the check that it is one.
 *
 * **`https` only, and this throws at construction rather than at the first
 * call.** A `PROXY_URL` of `http://…` is not a degraded deployment: mutual TLS
 * is the proxy's only authentication, so a plaintext URL means the client
 * presents no certificate, the proxy has no channel to resolve, and the
 * property the whole design rests on is gone — silently, with every tool call
 * still appearing to work right up until the proxy refuses them all. An
 * operator who typos a scheme should learn at startup.
 */
function parseProxyUrl(url: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProxyClientError(`proxy client: PROXY_URL is not a URL: ${url}`, "unreachable");
  }

  if (parsed.protocol !== "https:") {
    throw new ProxyClientError(
      `proxy client: PROXY_URL must be https, and was: ${parsed.protocol}//`,
      "tls_rejected"
    );
  }

  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 443 : Number(parsed.port)
  };
}

/**
 * A socket-level failure, as a reason an operator can act on.
 *
 * Three outcomes, because there are three different things to go and fix.
 *
 * `tls_rejected` is this end refusing the proxy's certificate — a wrong CA, or
 * an address the certificate does not cover. OpenSSL reports it through a
 * family of codes rather than one, so they are matched by prefix.
 *
 * `connection_reset` is the proxy hanging up. Under TLS 1.3 that is what a
 * rejected *client* certificate looks like from here — the handshake completes
 * before the server judges it — and it is also what a proxy crashing looks
 * like. Reporting it as either would be a guess; see the reason's own comment.
 *
 * `unreachable` is everything else, which in practice is a refused or timed-out
 * connection: a wrong address, or nothing listening on it.
 */
function transportError(cause: NodeJS.ErrnoException): ProxyClientError {
  const code = cause.code ?? "";

  if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.includes("CERT_")) {
    return new ProxyClientError(
      "proxy client: the proxy's certificate was not accepted",
      "tls_rejected",
      { cause }
    );
  }

  if (code === "ECONNRESET" || code === "EPIPE" || code === "EPROTO") {
    return new ProxyClientError(
      "proxy client: the proxy closed the connection without answering — it is down, or it did not accept this channel's certificate",
      "connection_reset",
      { cause }
    );
  }

  return new ProxyClientError("proxy client: the proxy could not be reached", "unreachable", {
    cause
  });
}
