import { z } from "zod";

/**
 * The shape every failure from the tool proxy takes, on every endpoint.
 *
 * Fixed here, in the base package, because both services need it: the proxy
 * renders it and the agent parses it in order to relay a refusal to the
 * channel. See docs/ARCHITECTURE.md ("Tool proxy").
 *
 * The object is strict and its fields are enumerated deliberately. Credentials
 * are referenced by name and never by value anywhere in Libero, and the way
 * that invariant is kept on this path is that there is no field on this shape
 * a value could travel in — not a `detail`, not a `cause`, not an
 * open-ended bag. Anything added here later inherits that requirement.
 */

export const ProxyErrorCode = z.enum([
  /** The connection carries no channel identity the proxy can use. Rare in
   *  practice: a client with no valid certificate is refused at the TLS
   *  handshake and never reaches a route. */
  "unauthenticated",
  "bad_request",
  /** The request body exceeded the proxy's read cap and was not buffered. */
  "payload_too_large",
  "not_found",
  "method_not_allowed",
  /**
   * The call was permitted and could not be served, because the thing that
   * would serve it is not built. Distinct from `internal`: nothing failed, and
   * a caller retrying gets the same answer until the deployment gains an
   * upstream. Enforcement has already run when this is returned — a refused
   * call never reaches it.
   */
  "not_implemented",
  "internal",
]);

export type ProxyErrorCode = z.infer<typeof ProxyErrorCode>;

export const ProxyError = z
  .object({
    error: z
      .object({
        code: ProxyErrorCode,
        /** Human-readable, safe to relay to a Slack channel as-is. */
        message: z.string().min(1),
        /** The channel the request authenticated as, when it authenticated. */
        channel: z.string().optional(),
        /** Correlates the response with the proxy's log line for the request. */
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ProxyError = z.infer<typeof ProxyError>;

/** HTTP status for each code, so a route never picks one by hand. */
export const PROXY_ERROR_STATUS: Record<ProxyErrorCode, number> = {
  unauthenticated: 401,
  bad_request: 400,
  payload_too_large: 413,
  not_found: 404,
  method_not_allowed: 405,
  not_implemented: 501,
  internal: 500,
};
