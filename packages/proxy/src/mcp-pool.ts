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
//
// Closing is asynchronous because a legacy client may hold a session, and
// ending one is a request. Every termination runs concurrently under a short
// budget of its own, so a wedged upstream costs shutdown one timeout rather
// than one per upstream — see `SESSION_TERMINATION_TIMEOUT_MS`.
//
// **`maxResponseBytes` is configured here, and a per-channel bound could not
// be.** It is the deployment's — `PROXY_MAX_RESPONSE_BYTES` — so it is the same
// number for every channel, and there is nothing for the two channels sharing
// the client above to disagree about. The obvious wrong edit is to move a
// channel's bound here alongside it: that would hand whichever channel opened
// the client first the say over every other channel's calls. The channel's own
// bound on a result travels per call instead, on `CallLimits`.

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
  /**
   * Terminates any legacy session and drops every client. Never rejects.
   *
   * Bounded twice over: each `DELETE` carries `SESSION_TERMINATION_TIMEOUT_MS`,
   * and they run together rather than in sequence, so a pool of thirty
   * upstreams costs one timeout and not thirty. `Promise.allSettled` is the
   * structural half of "never rejects" — the client already swallows its own
   * failures, and this is what keeps the promise true if a later edit stops
   * swallowing one.
   */
  close(): Promise<void>;
}

export interface McpPoolOptions {
  readonly scheme: AuthScheme;
  readonly timeoutMs?: number;
  /** The deployment's bound on a response body. Absent means the process default. */
  readonly maxResponseBytes?: number;
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
        ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      });
      clients.set(key, client);
      return client;
    },

    get size() {
      return clients.size;
    },

    // A stateless client has nothing to hang up — `2026-07-28` has no session
    // to terminate and no socket this layer owns, since undici's keep-alive is
    // beneath us. A legacy client with a session does: one `DELETE` naming it,
    // which is the courtesy the spec asks for.
    //
    // **The state changes before the first await, not after it.** `acquire`
    // must refuse and `size` must read zero from the instant `close()` is
    // entered rather than from when its terminations resolve — a caller that
    // does not await this still gets a pool that hands out nothing.
    async close() {
      if (closed) return;
      closed = true;
      const open = [...clients.values()];
      clients.clear();
      await Promise.allSettled(open.map(client => client.close()));
    }
  };
}
