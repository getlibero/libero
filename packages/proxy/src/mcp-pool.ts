// One MCP client per upstream.
//
// **Two channels naming one upstream share a client, and that is intended.**
// They already share the credential, which is the identity the upstream sees,
// so a shared client grants neither channel anything that sharing the
// credential did not already grant. Enforcement is per-channel and runs before
// anything here is reached: by the time a call arrives, the sheet has already
// said this channel may call this tool on this server.
//
// The key is `upstreamKey` from ./enforce.ts rather than a comparison written
// out again here. That is the point of exporting it: the pool's notion of "one
// upstream" has to be enforcement's, or the pool could merge two blocks
// enforcement treats as distinct and send a call authorized against one over a
// client built for the other.

import type { McpServer } from "@getlibero/schema";
import { upstreamKey } from "./enforce.js";
import { type McpClient, createMcpClient } from "./mcp-client.js";
import type { AuthScheme } from "./outbound.js";
import type { Secret } from "./vault.js";

/** The `http` member of the schema's transport union, where `url` is a string. */
export type HttpUpstream = Extract<McpServer, { transport: "http" }>;

export interface McpPool {
  /**
   * The client for this upstream, created on first use.
   *
   * `null` once closed, so a call that arrives during teardown is answered
   * rather than being served over a connection the process is dismantling.
   */
  acquire(upstream: HttpUpstream, secret: Secret | undefined): McpClient | null;
  readonly size: number;
  /** Drops every client. Never rejects. */
  close(): void;
}

export interface McpPoolOptions {
  readonly scheme: AuthScheme;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createMcpPool(options: McpPoolOptions): McpPool {
  const clients = new Map<string, McpClient>();
  let closed = false;

  return {
    acquire(upstream, secret) {
      if (closed) return null;

      const key = upstreamKey(upstream);
      const existing = clients.get(key);
      if (existing !== undefined) return existing;

      // The `Secret` is only read when a client is created; a later call with
      // the same key keeps the client it has. That is correct rather than
      // convenient — the key carries the credential *name*, and one name is one
      // vault entry, so two acquires under one key cannot mean two credentials.
      const client = createMcpClient({
        url: upstream.url,
        scheme: options.scheme,
        secret,
        ...(upstream.credential !== undefined ? { credentialName: upstream.credential } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      });
      clients.set(key, client);
      return client;
    },

    get size() {
      return clients.size;
    },

    // Nothing to hang up. `2026-07-28` has no session to terminate and no
    // socket this layer owns — undici's keep-alive is beneath us — so closing
    // is refusing to hand out more clients and letting the rest go. When #150
    // adds the legacy handshake it also adds sessions, and *that* close has a
    // `DELETE` to send and a shutdown budget to respect.
    close() {
      closed = true;
      clients.clear();
    }
  };
}
