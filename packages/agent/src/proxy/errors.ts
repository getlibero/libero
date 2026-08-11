// What this client does with a status it did not expect.
//
// Shared by every route rather than written per route, because the rule it
// keeps is one a second copy could quietly stop keeping: *nothing of an
// unrecognised body is echoed*. An error raised here can reach a Slack thread
// and the model's own transcript, so a body this client cannot vouch for is a
// body it says nothing about.

import { ProxyError } from "@getlibero/schema";
import { ProxyClientError } from "./transport.js";
import type { ProxyFailure } from "./transport.js";

/** The proxy's status for a connection whose certificate it would not accept. */
const UNAUTHENTICATED = 401;

/**
 * A non-200 as an error, using the proxy's own message when it sent one.
 *
 * `ProxyError.message` is written by the proxy and documented safe to relay to
 * a Slack channel as-is, so it is the better sentence: "the request body is not
 * a valid tool call" tells an operator more than a status code. When the body
 * is not a `ProxyError` the fallback says only that the request failed —
 * nothing of an unrecognised body is echoed, because an unrecognised body is
 * one this client cannot vouch for.
 *
 * One status gets its own reason rather than the generic one. A 401 means the
 * proxy was reached, answered, and would not accept this channel's certificate
 * — which is a different thing from "the request could not be served", and
 * since #79 it is a thing an operator can cause with a mistyped fingerprint or
 * a rotation done in the wrong order. Calling it `proxy_error` would put "the
 * tool proxy could not be reached" in front of a channel whose proxy is fine.
 */
export function proxyErrorFrom(body: unknown, fallback: string, status?: number): ProxyClientError {
  const reason: ProxyFailure = status === UNAUTHENTICATED ? "certificate_rejected" : "proxy_error";
  const parsed = ProxyError.safeParse(body);
  return parsed.success
    ? new ProxyClientError(`proxy client: ${parsed.data.error.message}`, reason)
    : new ProxyClientError(`proxy client: ${fallback}`, reason);
}
