// The authorization server on the other side of the token path.
//
// `startFakeTokenIssuer` from @getlibero/proxy, not a second implementation,
// for upstream.ts's reason: it is a real `node:http` listener on loopback that
// records the form body of every token request, and it is kept honest by the
// exchange's own test suite. The refresh token crossing a real socket is what
// makes the leak scan over it mean anything.
//
// A test starts the issuer *before* `startRig` and on its own cleanup stack,
// unlike the upstream: the sheet's `auth.issuer` and the planted grant both
// need its url, and the `respondToken` hooks the hostile cases set are the
// test's to hold, not the rig's.

import { startFakeTokenIssuer } from "@getlibero/proxy";
import type { FakeTokenIssuer, FakeTokenIssuerOptions } from "@getlibero/proxy";
import type { Cleanup } from "./cleanup.js";

/**
 * The fake's own options, passed through, per `UpstreamOptions`: `rotate`,
 * `expiresInSeconds`, `issuerEcho`, `tokenEndpoint` and the rest are documented
 * on `FakeTokenIssuerOptions`, and restating a subset here would be a second
 * list to keep in step.
 */
export type IssuerOptions = Partial<FakeTokenIssuerOptions>;

/**
 * Starts the issuer and registers its shutdown.
 *
 * The returned object is the fake itself, so a case can reach `tokenRequests`,
 * `accessTokens`, `currentRefreshToken` and the `respond*` hooks directly.
 * `close` calls `closeAllConnections` first, so a token request left hanging by
 * the `hang` knob cannot stall teardown.
 */
export async function startIssuer(cleanup: Cleanup, options: IssuerOptions = {}): Promise<FakeTokenIssuer> {
  const issuer = await startFakeTokenIssuer(options);
  cleanup.add("token issuer", () => issuer.close());
  return issuer;
}
