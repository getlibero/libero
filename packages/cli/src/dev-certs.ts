// Driving scripts/dev-certs.sh, which this package ships a copy of.
//
// **The script is run, not reimplemented.** Node cannot sign an X.509
// certificate — `node:crypto` has no CA — so every path here shells out to
// `openssl` in the end, and the choice is between one implementation and two.
// The script is 361 lines of careful POSIX sh: a local CA, the proxy's server
// certificate, one client certificate per channel, mint-only-what-is-missing,
// staged rotation with an ordering guard, expiry warnings, and a LibreSSL
// workaround for the macOS `openssl` that silently lets a config file override
// `-subj`. Writing that again in TypeScript would be two things to keep
// correct, and the second one would be the one nobody runs in CI.
//
// **A copy, not a move.** `packages/proxy/src/server.test.ts` and
// `packages/agent/src/proxy/transport.test.ts` exec the script at its
// repository path to get their fixtures, and the documentation names it in nine
// places — so it stays at `scripts/dev-certs.sh` and `../build.mjs` copies it
// into `dist/` at build time, because npm's `files` cannot reach outside a
// package directory. CI asserts the two are byte-identical, which is what keeps
// "a copy" from becoming "a fork".
//
// The script's own stdout is forwarded rather than summarised. It says which
// certificate it minted and which it kept, warns about expiry, and prints the
// line a rotation has to be finished with; a wrapper that swallowed that would
// be a wrapper that has to reproduce it.

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CertRun {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

export type CertRunner = (script: string, args: readonly string[], cwd: string) => CertRun;

/**
 * The copy this package ships, beside the bundle that resolves it.
 *
 * `import.meta.url` rather than a path from the working directory: an operator
 * running `npx @getlibero/cli` is not standing anywhere in particular, and the
 * script has to come from the install.
 */
export function bundledScript(): string {
  return fileURLToPath(new URL("./dev-certs.sh", import.meta.url));
}

export function runDevCerts(script: string, args: readonly string[], cwd: string): CertRun {
  // `sh` explicitly rather than relying on the executable bit surviving a
  // tarball, an npm install, and whatever umask the operator has.
  const result = spawnSync("sh", [script, ...args], {
    cwd,
    encoding: "utf8",
    // The script names itself when it tells you how to finish a rotation, and
    // by default that name is `$0` — which here is a path inside an install
    // directory nobody should be asked to type. This is how it learns it is
    // being driven. Unset, the script is exactly what it was.
    env: { ...process.env, DEV_CERTS_SELF_CMD: "libero channel" }
  });
  if (result.error !== undefined) throw result.error;
  return {
    code: result.status ?? 1,
    out: lines(result.stdout),
    err: lines(result.stderr)
  };
}

/**
 * A certificate's SHA-256 fingerprint, in the form a team sheet takes.
 *
 * Node's `fingerprint256` is colon-separated uppercase hex, byte-identical to
 * what `openssl x509 -fingerprint -sha256` prints and to what the proxy
 * compares an incoming certificate against — so what this returns is what a
 * sheet has to pin, with nothing in between to get wrong.
 */
export function fingerprintOf(pem: string): string {
  return new X509Certificate(readFileSync(pem)).fingerprint256;
}

function lines(text: string | null): string[] {
  if (text === null || text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}
