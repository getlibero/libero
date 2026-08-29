// The vault master key, generated on the host.
//
// Thirty-two random bytes, base64. The shape is not this file's to choose: it
// has to satisfy `parseVaultKey` in apps/proxy-server/src/env.ts, which is what
// the proxy runs against PROXY_VAULT_KEY at startup and which rejects anything
// that is not base64 or does not decode to exactly VAULT_KEY_BYTES.
//
// **Written rather than imported**, though the proxy exports the same constant.
// scripts/boundary-check.sh greps `packages/agent`, `packages/gateway` and
// `apps/server` and does not look at this package, so nothing mechanical would
// stop `packages/cli` depending on `@getlibero/proxy` — and that edge would pull
// the MCP SDK, the vault's cipher, and the credential-handling code into the one
// artifact people install from npm. Twelve bytes of duplication buys a published
// package that cannot read a vault because it contains no code that could.
//
// `randomBytes` and not `openssl rand -base64 32`, which is what the documented
// instruction has always been: shelling out puts the key in a child process's
// stdout, and the whole point of generating it here is that it goes to a 0600
// file and nowhere else.

import { randomBytes } from "node:crypto";

/** What `parseVaultKey` requires the decoded key to be. */
export const VAULT_KEY_BYTES = 32;

export function generateVaultKey(): string {
  return randomBytes(VAULT_KEY_BYTES).toString("base64");
}

/**
 * Where `--key-file` puts the key when the operator has no other place for it,
 * and where `libero doctor` looks (#495).
 *
 * Host-relative, resolved from the working directory like every other path this
 * package takes — the #98 line: the CLI owns what the operator authors on the
 * host, and the container path is the compose file's business. It is the source
 * path of the commented `secrets:` block in `deploy/docker-compose.yml`, which
 * mounts it at `/run/secrets/proxy_vault_key`, and the two have to agree: this
 * constant is the spelling both the usage text and doctor's default print.
 *
 * `deploy/` rather than the repository root, because that is Compose's project
 * directory and a `secrets: file:` is resolved against it.
 */
export const DEFAULT_KEY_FILE = "deploy/secrets/vault.key";
