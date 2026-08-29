// The default backend, run against the contract.
//
// The whole file is a harness and one call. Everything asserted lives in
// ./custody-conformance.ts, so #483 and #484 add a sibling of this file and no
// assertions; what is true of an *envelope on a disk* — the magic bytes, the
// bit flips, the file mode, the store-opened-as-a-vault confusion — stays in
// ./vault.test.ts and ./token-store.test.ts, where a second backend has no
// business inheriting it.
//
// This is also the one place `reveal()` is called on the conformance path. It
// is a `.test.ts`, which outbound.test.ts's two greps already exempt, and that
// is why `CustodyHarness` takes the unwrap rather than the suite doing it.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVaultAdmin } from "./custody-admin.js";
import { openCustody } from "./custody-backend.js";
import { runCustodyConformance } from "./custody-conformance.js";
import type { CustodyFixture } from "./custody-conformance.js";
import type { Custody } from "./custody.js";
import { parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";
import { tokenStorePathFor } from "./token-store.js";

/**
 * Every handle gets its own parse of the same base64.
 *
 * Not a shared buffer: `close()` zeroes the key in place, so two handles over
 * one parse would leave the second holding 32 zero bytes the moment the first
 * shut down. e2e/src/harness/grant.ts makes the same move for the same reason.
 */
function keyFrom(base64: string): VaultKey {
  const parsed = parseVaultKey(base64);
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}

runCustodyConformance({
  name: "encrypted files",

  reveal: secret => secret.reveal(),

  async open(deps = {}): Promise<CustodyFixture> {
    const dir = mkdtempSync(join(tmpdir(), "libero-custody-"));
    const vaultFile = join(dir, "vault.enc");
    const base64 = randomBytes(32).toString("base64");
    const config = () => ({ backend: "encrypted-files" as const, vaultFile, key: keyFrom(base64) });

    const opened: Custody[] = [];
    const stores = await openCustody(config(), deps);
    const admin = await openVaultAdmin(config());

    return {
      stores,
      admin,

      async reopen(): Promise<Custody> {
        const handle = await openCustody(config(), deps);
        opened.push(handle);
        return handle;
      },

      // The union of both stores' closed sets. `not_a_vault` and
      // `not_a_token_store` are the same fact told by two files.
      failureWords: [
        "unreadable",
        "too_large",
        "not_a_vault",
        "not_a_token_store",
        "truncated",
        "unsupported_version",
        "bad_key_or_tampered",
        "malformed_plaintext"
      ],

      sever(): void {
        rmSync(dir, { recursive: true, force: true });
      },

      corrupt(): void {
        // Present and unopenable rather than absent, which is a valid empty
        // deployment. Short enough to fail the length check before any key is
        // used, which is the check order ./envelope.ts fixes.
        writeFileSync(vaultFile, Buffer.from("not a vault at all"));
        writeFileSync(tokenStorePathFor(vaultFile), Buffer.from("nor is this"));
      },

      async dispose(): Promise<void> {
        for (const handle of opened) handle.close();
        stores.close();
        admin.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }
});
