// The MCP server on the other side of the proxy.
//
// `startFakeMcpServer` from @getlibero/proxy, not a second implementation: it
// is a real `node:http` listener on loopback that records the raw
// `Authorization` header and body of every request, and it is kept honest by
// the MCP client's own test suite. A recorder written here would drift from
// what the client actually sends, and drift in the direction of passing.
//
// It records the credential in the clear, which is the point. The suite's
// positive control is that the canary arrived here as `Bearer <canary>` —
// without it, every "the credential did not leak" assertion also passes on a
// run where no credential was ever resolved.

import { startFakeMcpServer } from "@getlibero/proxy";
import type { FakeMcpServer, FakeMcpServerOptions } from "@getlibero/proxy";
import type { Cleanup } from "./cleanup.js";

/**
 * The fake's own options, passed through.
 *
 * Not a narrowed vocabulary: `echoHeaders`, `echoAuthAsSessionId`, `hangOn`,
 * `pageSize` and the rest are documented on `FakeMcpServerOptions` and are
 * exactly what the attack cases reach for. Restating a subset here would be a
 * second list to keep in step.
 */
export type UpstreamOptions = Partial<FakeMcpServerOptions>;

/**
 * Starts the upstream and registers its shutdown.
 *
 * The returned object is the fake itself, so a case can reach `respond`,
 * `options`, and `received` directly — the knobs the attack cases need
 * (`echoHeaders`, `hangOn`, a hostile `respond`) are documented on
 * `FakeMcpServerOptions` and are not worth a second vocabulary here.
 */
export async function startUpstream(cleanup: Cleanup, options: UpstreamOptions = {}): Promise<FakeMcpServer> {
  const upstream = await startFakeMcpServer(options);
  // `close` calls `closeAllConnections` first, so a request left hanging by the
  // `hangOn` knob cannot stall teardown.
  cleanup.add("upstream", () => upstream.close());
  return upstream;
}

/** Every `Authorization` header the upstream saw, for the positive control. */
export function authorizationsSeen(upstream: FakeMcpServer): Array<string | undefined> {
  return upstream.received.map(request => request.authorization);
}
