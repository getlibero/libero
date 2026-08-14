// The grant the proxy refreshes against, planted in the token store.
//
// Written with the shipped write path (`openTokenStore` + `putGrant`), not a
// hand-rolled blob, for vault.ts's reason: the format is the proxy's, and a
// fixture that encoded it independently would be a second implementation of
// the one thing whose whole job is that only the proxy can read it. The store
// lands at `tokens.enc` beside the vault file — `tokenStorePathFor` is fixed,
// so there is no second path to point anywhere else — and the vault
// directory's disposer removes it.
//
// Planting happens *before* the proxy spawns, so its startup line is
// `token_store_opened` and the first mint finds the grant. What the value
// planted here should be is `REFRESH_CANARY`: the refresh token is a secret
// under canary.ts's rule, crossing exactly one wire — the POST to the fake
// issuer's token endpoint — and reaching no surface the agent process sees.

import { openTokenStore, parseVaultKey } from "@getlibero/proxy";
import type { PlantedVault } from "./vault.js";

export interface GrantSpec {
  /** The issuer identifier, byte for byte the fake issuer's url. */
  readonly issuer: string;
  /** The durable secret. Plant `REFRESH_CANARY`, per canary.ts. */
  readonly refreshToken: string;
  /**
   * Must cover whatever the sheet's `auth.scopes` asks for — a sheet asking
   * beyond the grant is `grant_missing` with `reason: "scopes_exceeded"`,
   * which is its own case rather than every case.
   */
  readonly scopes?: readonly string[];
  readonly clientId?: string;
}

/**
 * Writes one grant per credential name into the vault's sibling token store.
 *
 * The key is parsed fresh rather than shared with the vault writer, because
 * `TokenStore.close()` zeroes its key buffer in place — a shared buffer would
 * leave whoever parsed it first holding thirty-two zero bytes.
 */
export async function plantGrants(
  vault: PlantedVault,
  grants: Readonly<Record<string, GrantSpec>>
): Promise<void> {
  const parsed = parseVaultKey(vault.keyBase64);
  if (!parsed.ok) {
    // Unreachable for a key writeVault minted; checked for vault.ts's reason.
    throw new Error(`e2e: the vault key was rejected re-parsing it: ${parsed.reason}`);
  }
  const store = openTokenStore({ vaultFile: vault.file, key: parsed.key });
  try {
    for (const [name, spec] of Object.entries(grants)) {
      await store.putGrant(name, {
        issuer: spec.issuer,
        clientId: spec.clientId ?? "https://e2e.invalid/client.json",
        refreshToken: spec.refreshToken,
        scopes: spec.scopes ?? ["mcp.read"],
        obtainedAt: Date.now()
      });
    }
  } finally {
    store.close();
  }
}
