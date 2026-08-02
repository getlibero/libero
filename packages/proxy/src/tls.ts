// The proxy's TLS configuration.
//
// Mutual TLS is not decoration here: it is the only authentication the proxy
// has. A client with no certificate the local CA signed cannot open a
// connection, and the certificate it presents is where the channel identity
// comes from (see identity.ts).

import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";

export interface ProxyTlsPaths {
  /** The proxy's own certificate, signed by the local CA. */
  cert: string;
  key: string;
  /** The local CA. Client certificates are verified against this and nothing else. */
  ca: string;
}

function read(role: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    // Naming the path is the whole value of this message: the common failure
    // is a compose volume that did not mount where the operator expected.
    throw new Error(`proxy TLS: cannot read ${role} at ${path}`);
  }
}

/**
 * Server options for a listener that refuses anonymous clients.
 *
 * `requestCert` asks for a client certificate and `rejectUnauthorized` makes
 * the absence of a valid one fatal to the connection. Both are required:
 * `requestCert` alone would ask and then accept whatever came back, including
 * nothing.
 *
 * TLS 1.3 only. Both ends of this connection are ours and ship together, so
 * there is no legacy client to accommodate and no reason to leave older
 * versions and their cipher negotiation reachable.
 */
export function loadTlsOptions(paths: ProxyTlsPaths): ServerOptions {
  return {
    cert: read("certificate", paths.cert),
    key: read("private key", paths.key),
    ca: read("certificate authority", paths.ca),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3"
  };
}
