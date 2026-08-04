// Serving an allowed call against an HTTP upstream.
//
// This is what fills the dispatcher seam in ./dispatch.ts: it takes the call
// and the team-sheet entry enforcement matched, resolves that entry's named
// credential against the vault, and hands both to ./outbound.ts. It is the only
// module that holds a `Vault` and a network transport at once, which is why the
// two refusals that cannot be answered from a sheet — `credential_unresolved`
// here, `egress_denied` when #73 lands — are discovered at this level.
//
// **The request body shape is provisional and belongs to #39.** What goes on
// the wire below is `{ tool, arguments }` as JSON, which is a placeholder good
// enough to prove a credential reaches an upstream and no further. MCP's
// JSON-RPC framing, session negotiation, and the client pool are #39's, and
// replacing `toolRequestBody` is where that starts. Nothing else in this file
// should need to change for it: the credential path does not depend on the
// protocol.
//
// What this does not do, both deliberately: it does not check the egress
// allowlist (#73), and it does not redact the response (#52). The comment on
// each seam below says where it goes.

import type { McpServer, ResolvedToolCall, ToolResult } from "@getlibero/schema";
import type { Dispatch, ToolDispatcher } from "./dispatch.js";
import { createSilentLogger, type Logger } from "./log.js";
import {
  type AuthScheme,
  UpstreamError,
  callUpstream,
  destinationHost,
  type UpstreamResponse
} from "./outbound.js";
import type { Vault } from "./vault.js";

/**
 * Bearer, for every upstream, until an upstream needs otherwise.
 *
 * Not a team-sheet field. The architecture says a credential is "injected into
 * outbound MCP/HTTP calls by the proxy" without naming a mechanism, and Bearer
 * is what the MCP HTTP transport and a service token both expect. Making it
 * configurable would put an attacker-interesting knob (which header does the
 * secret go in) into a file an admin edits, for no upstream that needs it yet.
 * When one does, it becomes an `AuthScheme` member and a sheet field together.
 */
const SCHEME: AuthScheme = "bearer";

export interface HttpDispatcherOptions {
  /** Opened once at startup. The dispatcher holds it; no route does. */
  readonly vault: Vault;
  /** Injected transport, for tests. Defaults to Node's built-in `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * The JSON the upstream is POSTed. Provisional — see the file header.
 *
 * The channel is **not** in it. The upstream has no business knowing which
 * Slack channel drove a call, and a field carrying it is a field that ends up
 * in someone else's log.
 */
export function toolRequestBody(call: ResolvedToolCall): unknown {
  return { tool: call.tool, arguments: call.arguments };
}

/**
 * What the upstream said, as a result the model can read.
 *
 * A non-2xx becomes `isError: true` rather than a thrown value or a refusal:
 * it is the tool failing, which the model should see and may recover from, and
 * `ToolResult.isError` is exactly that distinction. A refusal would be a lie —
 * nothing was denied — and a `ProxyError` would tell the agent the proxy broke.
 */
function resultOf(response: UpstreamResponse): ToolResult {
  return { content: response.body, isError: response.status < 200 || response.status >= 300 };
}

/**
 * A dispatcher that calls HTTP upstreams with their credentials attached.
 *
 * Real, in the sense `assertServableComposition` means: composing this with
 * `createUnmeteredSpend()` throws, because a proxy that serves calls without
 * metering them never exhausts a budget. `apps/proxy-server` therefore keeps
 * the stand-ins until #38 lands a real meter, and this is exercised against a
 * mock upstream in tests. That is the issue's scope, not an oversight.
 */
export function createHttpDispatcher(options: HttpDispatcherOptions): ToolDispatcher {
  const logger = options.logger ?? createSilentLogger();

  return {
    async dispatch(call: ResolvedToolCall, upstream: McpServer): Promise<Dispatch> {
      // Not built rather than not allowed. A stdio upstream needs a process
      // pool and a lifecycle, which is #39; answering `unavailable` keeps it
      // readable apart from a refusal, exactly as the bare proxy does today.
      if (upstream.transport !== "http") {
        logger.log("warn", {
          event: "dispatch_unsupported_transport",
          channel: call.channel,
          server: call.server,
          tool: call.tool
        });
        return { outcome: "unavailable" };
      }

      // A sheet may declare `transport = "http"` and omit `url` — the schema
      // makes it optional (see the note in packages/schema/src/team-sheet.ts).
      // An operator slip, not a denial, so it reads as unavailable and is
      // logged loudly enough to find.
      if (upstream.url === undefined) {
        logger.log("error", {
          event: "dispatch_upstream_has_no_url",
          channel: call.channel,
          server: call.server,
          tool: call.tool
        });
        return { outcome: "unavailable" };
      }

      // Resolved before any connection is opened, so a sheet naming a
      // credential the vault does not hold refuses without the upstream ever
      // learning the call existed. The test asserts the mock sees zero
      // requests.
      let secret;
      if (upstream.credential !== undefined) {
        const lookup = options.vault.lookup(upstream.credential);
        if (lookup.status === "missing") {
          logger.log("error", {
            event: "credential_unresolved",
            channel: call.channel,
            server: call.server,
            tool: call.tool,
            // By name. The value is what is missing; the name is what an
            // operator needs to fix it.
            credential: upstream.credential
          });
          return {
            outcome: "refused",
            refusal: { reason: "credential_unresolved", credential: upstream.credential }
          };
        }
        secret = lookup.secret;
      }

      // Where the egress allowlist check goes (#73): after the destination is
      // known, before `callUpstream` opens anything. `destinationHost` already
      // returns the string that list is written in.
      const destination = destinationHost(upstream.url);

      try {
        const response = await callUpstream({
          url: upstream.url,
          body: toolRequestBody(call),
          scheme: SCHEME,
          secret,
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        });

        logger.log("info", {
          event: "upstream_call",
          channel: call.channel,
          server: call.server,
          tool: call.tool,
          status: response.status,
          ...(destination !== null ? { destination } : {}),
          ...(upstream.credential !== undefined ? { credential: upstream.credential } : {})
        });

        // Where the redaction pass goes (#52): the result crosses back to the
        // agent from here, and an upstream that echoes its own auth header is
        // the leak class it closes. Until then this is a straight pass-through,
        // which is why the mock upstream in the tests is made to echo.
        return { outcome: "ran", result: resultOf(response) };
      } catch (error) {
        // `UpstreamError` carries a reason from a closed set and nothing else —
        // no `cause`, because the underlying fetch error can hold the request
        // headers and those hold the credential. Anything unexpected is
        // reported as a bare transport failure rather than re-thrown, so no
        // foreign error object reaches the server's log.
        const failure = error instanceof UpstreamError ? error.failure : "unreachable";
        logger.log("error", {
          event: "upstream_failed",
          channel: call.channel,
          server: call.server,
          tool: call.tool,
          reason: failure,
          ...(destination !== null ? { destination } : {})
        });
        return {
          outcome: "ran",
          result: {
            content: `The tool did not answer: ${failure}. The call was made and no result came back.`,
            isError: true
          }
        };
      }
    }
  };
}
