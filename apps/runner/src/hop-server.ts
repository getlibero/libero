// The egress hop: the sandbox's only way out, and the thing that says no (#219).
//
// One of these runs per sandbox run, on a network with no route to anywhere
// else. That topology is the enforcement — #393's decision, argued in
// packages/proxy/README.md under "Enforcing `[egress]`". Code that ignores
// `HTTP_PROXY`, or dials a raw address, reaches nothing because there is nowhere
// for the packet to go. This process is what makes the *allowed* destinations
// reachable, not what makes the forbidden ones unreachable.
//
// ## It speaks CONNECT and nothing else
//
// A CONNECT request names a host and a port and carries no payload, so this
// process sees which host was asked for and never what was sent to it. That is
// deliberate and it is why there is no TLS interception here: the hop is an
// allowlist check, not a second redaction point. Redaction belongs to
// packages/proxy/src/outbound.ts, which lives on the credential path — and this
// path carries no credential at all.
//
// The cost is stated where an operator meets it: absolute-form requests
// (`GET http://host/path`, which is what a client sends when `HTTP_PROXY` is
// set) are refused, so plain `http://` does not work. Serving them would make
// this a forward proxy reading bodies, which is the one thing it must not be.
//
// ## It refuses to be clever about names
//
// `isEgressAllowed` from @getlibero/schema decides, and this file does not
// second-guess it. #219's standing rule is that a caller which reimplements
// matching is a review failure, and it is the reason the hop is ours rather than
// Squid or tinyproxy — those express an allowlist in their own ACL syntax, which
// *is* reimplementing it. The near-miss behaviour in that module is the security
// deliverable of #73; agreeing with it by construction is cheaper than proving a
// second matcher agrees.
//
// Two checks sit ahead of it, and both are about addresses rather than names:
// loopback and link-local are refused unconditionally, because a listed name
// that *resolves* to 169.254.169.254 is a rebinding an allowlist over names
// structurally cannot see. RFC1918 is deliberately **not** refused —
// `*.internal.example.com` is the worked example the team-sheet docs ship, and
// a blanket private-range denial would break the documented case.
//
// ## The first denial ends the run
//
// Decided in #393. On a denial this prints one JSON line and stops proxying:
// the runner is following this container's log stream and kills the sandbox when
// it sees that line. The line is the whole interface between the two processes,
// which is why it is a single field with a fixed key rather than prose.

import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { isEgressAllowed } from "@getlibero/schema";

/** The key the runner watches for. Changing it is changing a wire contract. */
export const DENIED_EVENT = "egress_denied";

/** How long to wait for an allowed upstream to accept the connection. */
const DIAL_TIMEOUT_MS = 10_000;

export interface HopOptions {
  readonly allow: readonly string[];
  /** Called once, on the first denial. The hop stops serving after it. */
  onDenied(host: string): void;
}

/**
 * Whether an address is one no sheet may reach, whatever it says.
 *
 * Loopback is the hop and the sandbox themselves. Link-local is the cloud
 * metadata service — 169.254.169.254 — which is the single most valuable thing
 * an SSRF reaches, and which default-deny already blocks by name. This is for
 * the case default-deny cannot see: an operator lists `*.internal.example.com`,
 * and something under it resolves to the metadata address.
 *
 * IPv6 forms included, because `[::1]` and `fe80::` are the same two facts
 * written differently and an allowlist over names would not notice either.
 */
export function isForbiddenAddress(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();

  if (lower === "localhost" || lower === "::1" || lower === "::") return true;
  if (/^127\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  if (/^0\./.test(lower)) return true;
  // Link-local and unique-local IPv6, plus the v4-mapped spellings of the above.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (/^::ffff:(127\.|169\.254\.|0\.)/.test(lower)) return true;
  return false;
}

/**
 * Split a CONNECT target into its host and port.
 *
 * `null` for anything that is not `host:port`, which is refused rather than
 * guessed at: a CONNECT with no port is not a request this hop knows how to
 * serve, and defaulting one would be inventing the destination.
 */
export function parseAuthority(target: string): { host: string; port: number } | null {
  // Bracketed IPv6 first, because splitting on the last colon is wrong for it.
  const bracketed = /^(\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(target);
  const plain = /^([^:/?#\[\]]+):(\d{1,5})$/.exec(target);
  const match = bracketed ?? plain;
  if (match === null) return null;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] as string, port };
}

export function createHop(options: HopOptions): Server {
  let denied = false;

  const server = createServer((req, res) => {
    // Anything that is not CONNECT. A client with HTTP_PROXY set sends
    // absolute-form requests for plain http, and serving one would make this a
    // forward proxy that sees bodies. 405 rather than 403: it is not a
    // governance decision, it is a request this hop does not serve.
    res.writeHead(405, { "content-type": "text/plain", connection: "close" });
    res.end("this proxy serves CONNECT only\n");
    void req;
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refuse = (status: string) => {
      client.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      client.destroy();
    };

    // Once one destination has been denied the run is over; the runner is
    // killing the sandbox. Refusing the rest rather than serving them keeps the
    // window between the denial and the kill from being a window where the
    // allowlist is off.
    if (denied) {
      refuse("403 Forbidden");
      return;
    }

    const target = parseAuthority(req.url ?? "");
    if (target === null) {
      refuse("400 Bad Request");
      return;
    }

    if (isForbiddenAddress(target.host) || !isEgressAllowed(target.host, options.allow)) {
      denied = true;
      // The host as the client wrote it, before any connection is opened — which
      // is #219's acceptance in one line: refused *before*, not after.
      options.onDenied(target.host);
      refuse("403 Forbidden");
      return;
    }

    const upstream = connect({ host: stripBrackets(target.host), port: target.port, timeout: DIAL_TIMEOUT_MS }, () => {
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      // Bytes only, in both directions, and nothing in this process looks at
      // them. The tunnel is opaque on purpose: see the header.
      client.pipe(upstream);
      upstream.pipe(client);
    });

    const drop = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("timeout", drop);
    upstream.on("error", drop);
    client.on("error", drop);
  });

  return server;
}

const stripBrackets = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);
