// The vault file the proxy process opens.
//
// Written with the shipped write path (`setEntry` + `writeVaultEntries`), not a
// hand-rolled blob: the format is the proxy's, and a fixture that encoded it
// independently would be a second implementation of the one thing whose whole
// job is that only the proxy can read it.
//
// The key is generated per rig and passed to the child by environment variable,
// which is the phase-1 form the proxy's README documents. It never appears in
// this process's own environment.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVaultKey, setEntry, writeVaultEntries } from "@getlibero/proxy";
import type { VaultEntries } from "@getlibero/proxy";
import type { Cleanup } from "./cleanup.js";

export interface PlantedVault {
  /** `PROXY_VAULT_FILE`. */
  readonly file: string;
  /** `PROXY_VAULT_KEY`, base64. */
  readonly keyBase64: string;
}

/**
 * Writes a vault holding exactly the named credentials.
 *
 * The values are the secrets the suite then proves never leave the proxy, so
 * every caller should be planting a canary rather than a plausible-looking
 * token — see canary.ts for why a scan without a positive control is vacuous.
 */
export function writeVault(cleanup: Cleanup, credentials: Readonly<Record<string, string>>): PlantedVault {
  const dir = mkdtempSync(join(tmpdir(), "libero-e2e-vault-"));
  cleanup.add("vault", () => rmSync(dir, { recursive: true, force: true }));

  const keyBase64 = randomBytes(32).toString("base64");
  const parsed = parseVaultKey(keyBase64);
  if (!parsed.ok) {
    // Unreachable: 32 random bytes base64-encoded is exactly what the parser
    // wants. Checked rather than asserted because the alternative is a
    // non-null assertion on the one object that decrypts every credential.
    throw new Error(`e2e: generated vault key was rejected: ${parsed.reason}`);
  }

  let entries: VaultEntries = new Map<string, string>();
  for (const [name, value] of Object.entries(credentials)) {
    entries = setEntry(entries, name, value);
  }

  const file = join(dir, "vault.bin");
  writeVaultEntries(file, parsed.key, entries);
  return { file, keyBase64 };
}
