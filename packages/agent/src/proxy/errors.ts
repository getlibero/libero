// What this client does with a status it did not expect.
//
// Shared by every route rather than written per route, because the rule it
// keeps is one a second copy could quietly stop keeping: *nothing of an
// unrecognised body is echoed*. An error raised here can reach a Slack thread
// and the model's own transcript, so a body this client cannot vouch for is a
// body it says nothing about.

import { ProxyError } from "@getlibero/schema";
import { ProxyClientError } from "./transport.js";

/**
 * A non-200 as an error, using the proxy's own message when it sent one.
 *
 * `ProxyError.message` is written by the proxy and documented safe to relay to
 * a Slack channel as-is, so it is the better sentence: "the request body is not
 * a valid tool call" tells an operator more than a status code. When the body
 * is not a `ProxyError` the fallback says only that the request failed —
 * nothing of an unrecognised body is echoed, because an unrecognised body is
 * one this client cannot vouch for.
 */
export function proxyErrorFrom(body: unknown, fallback: string): ProxyClientError {
  const parsed = ProxyError.safeParse(body);
  return parsed.success
    ? new ProxyClientError(`proxy client: ${parsed.data.error.message}`, "proxy_error")
    : new ProxyClientError(`proxy client: ${fallback}`, "proxy_error");
}
