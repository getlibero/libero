// The runner's TLS material.
//
// A copy of packages/proxy/src/tls.ts's shape rather than an import of it, and
// the reason is the whole point of this service: an import would put the proxy's
// package — and with it the MCP SDK and the vault — into the image of the one
// process that can reach the Docker socket. Twelve lines of duplication against
// that edge is the trade CLAUDE.md's "copy only what has nowhere else to go"
// rule asks for, and this says which it is.

import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";

export interface RunnerTlsPaths {
  readonly cert: string;
  readonly key: string;
  readonly ca: string;
}

const read = (role: string, path: string): Buffer => {
  try {
    return readFileSync(path);
  } catch {
    // The path is named because the realistic failure is a mount that is not
    // there, and the path is the whole of what an operator needs to fix it.
    throw new Error(`runner TLS: cannot read ${role} at ${path}`);
  }
};

/**
 * Both flags together, or neither means anything.
 *
 * `requestCert` alone asks for a certificate and serves a peer that declines to
 * send one. `rejectUnauthorized` alone has nothing to reject. TLS 1.3 as a floor
 * because both ends here are ours and there is no old client to accommodate.
 */
export function loadRunnerTls(paths: RunnerTlsPaths): ServerOptions {
  return {
    cert: read("certificate", paths.cert),
    key: read("private key", paths.key),
    ca: read("certificate authority", paths.ca),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3"
  };
}
