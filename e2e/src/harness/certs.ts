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
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cleanup } from "./cleanup.js";
import { mintCached } from "./cert-cache.js";

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
  /**
   * The sandbox runner's own listener, and the proxy's client half (#219, #395).
   *
   * The same script mints these, so the suite gets them whether or not a case
   * uses them — which is the right default: they are deployment-lifetime
   * material like the proxy's server certificate, not a per-case fixture.
   *
   * `runnerClientPin` is what `RUNNER_CLIENT_PIN` is set to, and it is read out
   * of the file for `fingerprint`'s reason: the value the runner compares
   * against is Node's `fingerprint256`, so computing it the same way here means
   * the harness cannot agree with the script and disagree with the runner.
   *
   * It matters more here than anywhere else in the suite. One CA signs this
   * *and* every channel certificate in `clientCertDir`, so a runner that
   * trusted the CA alone would serve a compromised agent directly — the pin is
   * the whole of what stops that, and a case that wanted to attack it would
   * present one of those channel certificates.
   */
  readonly runnerServerCert: string;
  readonly runnerServerKey: string;
  readonly proxyClientCert: string;
  readonly proxyClientKey: string;
  readonly runnerClientPin: string;
  /**
   * The SHA-256 digest of a minted certificate, by label — a channel id, or a
   * `--raw-cn` label. This is what a team sheet pins (#79), and it is read out
   * of the file rather than parsed out of the script's output: the value the
   * proxy compares against is Node's `fingerprint256`, so computing it the same
   * way here means the harness cannot agree with the script and disagree with
   * the thing under test.
   */
  fingerprint(label: string): string;
  /**
   * Mint a replacement for one channel into `agent/staged/`, leaving what is in
   * service untouched, and answer its fingerprint. The first half of a
   * rotation.
   */
  rotate(channelId: string): string;
  /**
   * Move a staged replacement into place. Refuses — as the script does — unless
   * the channel's sheet already pins the staged fingerprint, which is why this
   * takes the channels root.
   */
  promote(channelId: string, channelsRoot: string): void;
}

function devCerts(args: string[]): string {
  try {
    return execFileSync("sh", ["scripts/dev-certs.sh", ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe"
    }).toString();
  } catch (error) {
    // The script's own diagnostics are on stderr and are the useful half —
    // "openssl is required and was not found on PATH" is a one-line fix that an
    // exit-status-only failure would hide.
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`e2e: dev-certs.sh failed\n${stderr}`);
  }
}

export function mintCerts(cleanup: Cleanup, options: MintOptions): Certs {
  const dir = mkdtempSync(join(tmpdir(), "libero-e2e-certs-"));
  cleanup.add("certs", () => rmSync(dir, { recursive: true, force: true }));

  // Cached, because eighty-one of this suite's calls ask for the same thing and
  // each one is five RSA keys. `cert-cache.ts` has the argument, including why
  // `rotate` and `promote` below are deliberately not routed through it.
  const args = ["--channels", options.channels.join(",")];
  for (const raw of options.rawCns ?? []) args.push("--raw-cn", raw);
  mintCached(REPO_ROOT, join(REPO_ROOT, "scripts", "dev-certs.sh"), args, dir, () =>
    devCerts(["--out", dir, ...args])
  );

  const fingerprint = (label: string): string =>
    new X509Certificate(readFileSync(join(dir, "agent", `client-${label}.pem`))).fingerprint256;

  return {
    dir,
    caPath: join(dir, "ca.pem"),
    serverCert: join(dir, "proxy", "server.pem"),
    serverKey: join(dir, "proxy", "server.key"),
    clientCertDir: join(dir, "agent"),
    runnerServerCert: join(dir, "runner", "server.pem"),
    runnerServerKey: join(dir, "runner", "server.key"),
    proxyClientCert: join(dir, "proxy", "client.pem"),
    proxyClientKey: join(dir, "proxy", "client.key"),
    runnerClientPin: new X509Certificate(readFileSync(join(dir, "proxy", "client.pem"))).fingerprint256,
    fingerprint,
    rotate(channelId: string): string {
      devCerts(["--out", dir, "--rotate", channelId]);
      return new X509Certificate(
        readFileSync(join(dir, "agent", "staged", `client-${channelId}.pem`))
      ).fingerprint256;
    },
    promote(channelId: string, channelsRoot: string): void {
      devCerts(["--out", dir, "--channels-root", channelsRoot, "--promote", channelId]);
    }
  };
}
