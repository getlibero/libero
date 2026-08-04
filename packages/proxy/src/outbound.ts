// The outbound call: where a credential stops being a name and becomes a header.
//
// This is the one file in the tree that takes a secret out of the vault. Every
// other module moves credentials as `Secret` handles or as names, and the whole
// design of ./vault.ts — no `get`, no iteration, `toString` and `toJSON` fixed
// at `[redacted]` — exists so that this is true and so that checking it is one
// grep. `injectCredential` below holds the only `reveal()` call, and a second
// one appearing anywhere is the thing a reviewer should stop.
//
// Nothing third-party, per the rule at the top of ./server.ts. The transport is
// Node's built-in `fetch`, injected so tests never open a socket they did not
// stand up themselves — the same shape `packages/agent/src/completion/*.ts`
// uses for provider clients.
//
// **What this file does not do.** It does not check the egress allowlist (#73)
// and it does not redact the response (#52). Both belong on this path and
// neither is built; the caller composes them around this. What is here is the
// injection itself and the rules that keep the secret inside the request.

import type { Secret } from "./vault.js";

/**
 * How the credential is attached.
 *
 * One member today. It is an enum rather than a bare boolean because the shape
 * of the question is "which scheme", and the destination decides — a GitHub
 * token and the MCP HTTP transport both want `Authorization: Bearer`, and the
 * next upstream may not. #39 adds members here; call sites name the scheme
 * explicitly so adding one is a compile error at each site rather than a
 * silently changed default.
 */
export type AuthScheme = "bearer";

/** How long the proxy waits on an upstream before giving up. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * The header name and value a scheme produces. Separated from the request so
 * the injection is testable without a socket, and so the one `reveal()` sits in
 * a function that does nothing else.
 */
export function credentialHeader(scheme: AuthScheme, secret: Secret): readonly [string, string] {
  switch (scheme) {
    case "bearer":
      // The only place a credential value exists as a plain string. It is
      // handed straight to the header map below and never stored, logged,
      // returned, or interpolated into a message.
      return ["authorization", `Bearer ${secret.reveal()}`];
  }
}

/**
 * Put the credential on the request headers.
 *
 * Returns a fresh object rather than mutating the caller's: a headers map that
 * has been through here holds a secret, and one that is shared or reused is a
 * secret that outlives the request. The caller passes this straight to `fetch`
 * and drops it.
 *
 * A `Secret | undefined` rather than two functions, because "this upstream
 * needs no credential" is an ordinary case — an MCP server on the private
 * network may want none — and making it a separate path is how the no-auth
 * branch stops being tested.
 */
export function injectCredential(
  headers: Readonly<Record<string, string>>,
  scheme: AuthScheme,
  secret: Secret | undefined
): Record<string, string> {
  if (secret === undefined) return { ...headers };
  const [name, value] = credentialHeader(scheme, secret);
  return { ...headers, [name]: value };
}

/**
 * Why an outbound call produced no response.
 *
 * A closed set, like `VaultFailure`, and for the same reason: this is the path
 * that holds a secret, so the failure a caller reports has to be something the
 * caller chose from a list rather than a string that came back from the stack.
 */
export type UpstreamFailure = "timed_out" | "unreachable";

/**
 * An outbound call that did not complete.
 *
 * **No `cause`, deliberately.** A `TypeError` out of `fetch` or undici can carry
 * the request in it, and the request is where the credential is — `util.inspect`
 * on an error chain is how that reaches a log line. The original is read for a
 * reason and then dropped, exactly as `VaultError` does at ./vault.ts.
 */
export class UpstreamError extends Error {
  readonly failure: UpstreamFailure;

  constructor(failure: UpstreamFailure) {
    super(`proxy upstream: ${failure}`);
    this.name = "UpstreamError";
    this.failure = failure;
  }
}

export interface UpstreamRequest {
  /** Absolute URL of the upstream. Comes from the team sheet, never the model. */
  readonly url: string;
  /** JSON-serializable. The caller owns the shape; see ./http-dispatcher.ts. */
  readonly body: unknown;
  readonly scheme: AuthScheme;
  /** Resolved from the vault by the caller. `undefined` for an unauthenticated upstream. */
  readonly secret: Secret | undefined;
  readonly timeoutMs?: number;
  /** Injected transport. Tests pass a stub; nothing here reaches the network by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What the upstream said. Status and text; interpreting them is the caller's job. */
export interface UpstreamResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * POST to the upstream with the credential attached.
 *
 * The timeout is not optional in effect — `AbortSignal.timeout` is always
 * applied — because an upstream that accepts a connection and never answers
 * would otherwise pin a request, and through it a channel, indefinitely. It is
 * a fixed ceiling rather than one read from the team sheet: per-task wall time
 * is the agent loop's cap and the budget meter's business (#38), while this is
 * the proxy refusing to hold a socket open forever, which is not a policy an
 * operator should be able to raise from a sheet.
 *
 * Throws `UpstreamError` for transport failures and returns non-2xx responses
 * as ordinary results — a 404 from a tool is something the model should see and
 * may recover from, which is the distinction `ToolResult.isError` draws.
 */
export async function callUpstream(request: UpstreamRequest): Promise<UpstreamResponse> {
  const send = request.fetch ?? globalThis.fetch;
  const headers = injectCredential(
    { "content-type": "application/json", accept: "application/json" },
    request.scheme,
    request.secret
  );

  let response: Response;
  try {
    response = await send(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    // The only thing read off the thrown value is whether it was the abort.
    // Nothing else about it is kept — see the note on `UpstreamError`.
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UpstreamError(timedOut ? "timed_out" : "unreachable");
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    // The response began and then failed mid-stream. Still a transport
    // failure, and still nothing from the error is kept.
    throw new UpstreamError("unreachable");
  }

  return { status: response.status, body };
}

/**
 * The host an upstream URL names, for logging and for the egress check (#73).
 *
 * Host only. A full URL in a log line is a place a query-string token ends up,
 * and the `[egress]` allowlist is written in hosts, so this is the string both
 * want. Returns `null` for a URL that does not parse — the sheet's `url` is
 * `z.url()` so that should not happen, but the caller decides what to do about
 * it rather than being handed an exception on the credential path.
 */
export function destinationHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
