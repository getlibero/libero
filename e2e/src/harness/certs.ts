// Mutual-TLS material, from the script an operator runs.
//
// `scripts/dev-certs.sh` and nothing else, for the reason
// packages/proxy/src/server.test.ts gives: no private key is checked into this
// repository, and the documented command is exercised on every CI run rather
// than rotting beside the code it describes.
//
// The channel id is the load-bearing string. It is the certificate's subject
// (`CN=channel:<id>`), the certificate's filename (`agent/client-<id>.pem`),
// the directory holding the team sheet, and the `channelId` on the stub
// mention. All four have to be the same string, and only the certificate is
// authoritative — the proxy reads the channel off the peer certificate and
// will read it from nowhere else.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cleanup } from "./cleanup.js";

/**
 * Both `src/harness/x.ts` and `dist/harness/x.js` sit three levels below the
 * repository root, so this resolves the same before and after a build.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface MintOptions {
  /** Channel ids to mint client certificates for. Must match `CHANNEL_ID_PATTERN`. */
  readonly channels: readonly string[];
  /**
   * Extra certificates with a verbatim CN, as `label=CN`.
   *
   * For the stolen-identity cases: the label is what the agent side asks for
   * (it becomes the filename, and `createProxyTransport` validates it as a
   * channel id before it becomes one), while the CN is what the proxy actually
   * reads. That is how a test presents a well-formed certificate claiming to be
   * something the CA never meant it to be.
   */
  readonly rawCns?: readonly string[];
}

export interface Certs {
  /** The root the script wrote into. */
  readonly dir: string;
  /** `PROXY_TLS_CA`, and what the agent verifies the proxy against. */
  readonly caPath: string;
  /** `PROXY_TLS_CERT` / `PROXY_TLS_KEY`. */
  readonly serverCert: string;
  readonly serverKey: string;
  /** `PROXY_CLIENT_CERT_DIR`: holds `client-<channel>.pem` and `.key`. */
  readonly clientCertDir: string;
}

export function mintCerts(cleanup: Cleanup, options: MintOptions): Certs {
  const dir = mkdtempSync(join(tmpdir(), "libero-e2e-certs-"));
  cleanup.add("certs", () => rmSync(dir, { recursive: true, force: true }));

  const args = ["--out", dir, "--channels", options.channels.join(",")];
  for (const raw of options.rawCns ?? []) args.push("--raw-cn", raw);

  try {
    execFileSync("sh", ["scripts/dev-certs.sh", ...args], { cwd: REPO_ROOT, stdio: "pipe" });
  } catch (error) {
    // The script's own diagnostics are on stderr and are the useful half —
    // "openssl is required and was not found on PATH" is a one-line fix that an
    // exit-status-only failure would hide.
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`e2e: dev-certs.sh failed\n${stderr}`);
  }

  return {
    dir,
    caPath: join(dir, "ca.pem"),
    serverCert: join(dir, "proxy", "server.pem"),
    serverKey: join(dir, "proxy", "server.key"),
    clientCertDir: join(dir, "agent")
  };
}
