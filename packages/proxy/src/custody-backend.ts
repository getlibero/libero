// Which backend the serving process holds, and the one place that decides.
//
// ./custody.ts says what a store is; this file says which implementation the
// deployment got. It is the whole switch — #483 and #484 add a member to
// `CustodyConfig` and a branch to `openCustody`, and nothing else in either
// service learns there is more than one kind of store.
//
// **Two things this file deliberately cannot reach.** It does not import
// ./vault-file.ts or ./custody-admin.ts, so "the serving composition holds no
// vault writer" is an import list here exactly as "it never writes" is one in
// ./vault.ts — the same claim, one level up. And it acquires no key: a
// `CustodyConfig` arrives with whatever material its backend needs, because
// `vaultKeyFromEnv` in apps/proxy-server is the deployment's single
// key-acquisition seam and a second reader of `PROXY_VAULT_KEY` would end it.
//
// **`openCustody` is async and the file backend is not.** Opening a managed
// store is a network call; opening two files is not. Returning a promise here
// regardless is what keeps the composition root's shape the same across
// backends, and it costs the default deployment one microtask at startup.

import { openGcpCustody } from "./custody-gcp.js";
import { openTokenStore } from "./token-store.js";
import { openVault } from "./vault.js";
import type { Custody } from "./custody.js";
import type { GcpEndpoints } from "./custody-gcp-client.js";
import type { VaultKey } from "./envelope.js";
import type { Logger } from "./log.js";

/**
 * Where this deployment's credentials live.
 *
 * A discriminated union rather than an options bag with optional fields,
 * because a backend's material is not optional — it is required by its own
 * branch and meaningless in the others. That is what lets `PROXY_VAULT_KEY`
 * stay required for the default shape while a managed backend needs none of
 * it: the key is demanded by the branch, not by the process.
 *
 * `encrypted-files` rather than `files`: the operator-facing spelling is
 * `PROXY_CUSTODY_BACKEND=files`, and the two are deliberately not the same
 * string, so the env vocabulary can stay short while this one stays exact.
 */
export type CustodyConfig =
  | {
      readonly backend: "encrypted-files";
      /** The vault's path. The token store is its sibling — `tokenStorePathFor`. */
      readonly vaultFile: string;
      readonly key: VaultKey;
    }
  | {
      readonly backend: "gcp-secret-manager";
      readonly project: string;
      /** This deployment's slice of the project. Half of every secret id. */
      readonly prefix: string;
      /**
       * Test-only, and there is no environment variable that reaches it.
       * `env.test.ts` asserts the config `custodyFromEnv` builds carries
       * neither of these: an operator-settable API endpoint inside the process
       * that holds every credential is a switch for sending them elsewhere.
       */
      readonly endpoints?: GcpEndpoints;
      readonly fetch?: typeof globalThis.fetch;
    };

/** What every backend takes and no backend's identity depends on. */
export interface CustodyDeps {
  readonly logger?: Logger;
  /** Injected so a rotation's timestamp can be tested without waiting. */
  readonly now?: () => number;
}

/**
 * Open both stores, failing fast where failing is cheap.
 *
 * Runs at startup, before anything binds, which is the one place in the proxy
 * where a throw is the right shape: a wrong key, a corrupt store or an
 * unreachable backend is an operator's problem at `docker compose up` rather
 * than at the far end of a Slack thread. Absent is not a failure for either
 * store — a deployment that has loaded no credentials, or has no OAuth
 * upstream, is a valid one.
 *
 * Logs nothing itself. The two stores log their own opening, so what an
 * operator reads at startup is unchanged by there being a seam.
 */
export function openCustody(config: CustodyConfig, deps: CustodyDeps = {}): Promise<Custody> {
  const { logger } = deps;

  if (config.backend === "gcp-secret-manager") {
    return openGcpCustody(config, deps);
  }

  const { vaultFile, key } = config;

  // The same key buffer reaches both, as it always has: one master key, two
  // subkeys separated by HKDF info. `tokens.close()` is what zeroes it, which
  // is why `close` below goes through the token store rather than the buffer.
  const vault = openVault({ file: vaultFile, key, ...(logger !== undefined ? { logger } : {}) });
  const tokens = openTokenStore({
    vaultFile,
    key,
    ...(logger !== undefined ? { logger } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {})
  });

  return Promise.resolve({
    vault,
    tokens,
    close: () => {
      tokens.close();
    }
  });
}
