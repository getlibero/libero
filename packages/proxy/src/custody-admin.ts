// The operator's path into the vault, behind the same seam.
//
// Apart from ./custody-backend.ts for the reason ./vault-file.ts is apart from
// ./vault.ts, one level down: the serving composition imports the first and
// never this, so "the process that serves tool calls holds no vault writer"
// stays readable as an import list at both levels. The ESLint block on
// apps/proxy-server/src/index.ts is the third proof, and IAM will be the fourth
// in a managed backend (#483, #484), where the operator's principal holds the
// write role the proxy's lacks.
//
// **There is no grant admin here, and that asymmetry is the design.** A value
// an operator holds is by definition a vault value; grant material is written
// by the serving process because an authorization server hands it the successor
// to a refresh token it just spent. `putGrant` therefore lives on `TokenStore`
// (./custody.ts) and there is no operator write path to the token store at all.
//
// **There is no `get` on this path either.** `names()` is the whole read
// surface — no values, no lengths, since a length narrows what kind of token an
// entry holds. Adding a command that prints a value back is the failure this
// file and ./vault.ts exist to prevent.

import { openAwsVaultAdmin } from "./custody-aws.js";
import { openGcpVaultAdmin } from "./custody-gcp.js";
import { readVaultEntries, removeEntry, setEntry, writeVaultEntries } from "./vault-file.js";
import type { Awaitable } from "./custody.js";
import type { CustodyConfig } from "./custody-backend.js";

/**
 * What an operator may do to the vault.
 *
 * **Verb-shaped, not set-shaped**, and that is what the seam forced out. The
 * file backend's editing is read-modify-write over the whole entry set because
 * one file holds all of it; a managed backend's `set` is one call against one
 * secret, which is what add-version / destroy-old *is*. An interface that
 * handed a caller the entry map would make every backend pretend to be a file,
 * and would put a whole vault's worth of values in a variable on the way past.
 */
export interface VaultAdmin {
  /** Sorted names, and nothing else about them. */
  names(): Awaitable<readonly string[]>;

  /**
   * Store a value under a name, replacing any predecessor. Replace-not-stack:
   * one name is one entry.
   *
   * Takes a plaintext `string` rather than a `Secret`, for ./vault-file.ts's
   * reason: the whole job is putting a value in, so wrapping the argument would
   * be theatre — the caller has it in hand either way. What no implementation
   * may do is print, return or log one.
   *
   * Throws `VaultEntryError` on a name or a value the contract refuses.
   */
  set(name: string, value: string): Awaitable<void>;

  /** `false` when the name was not there — the caller decides what to say. */
  remove(name: string): Awaitable<boolean>;

  /** Release whatever this retained. Operations fail after this. */
  close(): void;
}

/**
 * The operator's handle on the configured backend.
 *
 * Async for `openCustody`'s reason: opening a managed store is a network call,
 * and one shape across backends is worth a microtask at the start of a CLI
 * command. Unlike `openCustody` this does *not* read the store at open — an
 * editor that failed to start because the vault was corrupt would be an editor
 * that cannot be used to fix it, and each operation reports its own failure.
 *
 * Takes no `CustodyDeps`, unlike `openCustody`: there is nothing here to log
 * and no clock to stamp with, and a parameter every implementation ignores is
 * a parameter the next one will put something surprising in. A backend that
 * needs one adds it in the commit that needs it.
 */
export function openVaultAdmin(config: CustodyConfig): Promise<VaultAdmin> {
  if (config.backend === "gcp-secret-manager") {
    return openGcpVaultAdmin(config);
  }
  if (config.backend === "aws-secrets-manager") {
    return openAwsVaultAdmin(config);
  }

  const { vaultFile, key } = config;
  let closed = false;

  const requireOpen = (): void => {
    // After close() the key bytes are zeros, and a read under a zeroed key is
    // `bad_key_or_tampered` — true, but misleading. Say what happened.
    if (closed) throw new Error("proxy vault: closed");
  };

  return Promise.resolve({
    names(): readonly string[] {
      requireOpen();
      return [...readVaultEntries(vaultFile, key).keys()].sort();
    },

    set(name: string, value: string): void {
      requireOpen();
      writeVaultEntries(vaultFile, key, setEntry(readVaultEntries(vaultFile, key), name, value));
    },

    remove(name: string): boolean {
      requireOpen();
      const next = removeEntry(readVaultEntries(vaultFile, key), name);
      if (next === null) return false;
      writeVaultEntries(vaultFile, key, next);
      return true;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // The same buffer `vaultKeyFromEnv` parsed, not a copy — the CLI's one
      // in-memory master key going to zeros, as `TokenStore.close` does in the
      // serving process.
      key.fill(0);
    }
  });
}
