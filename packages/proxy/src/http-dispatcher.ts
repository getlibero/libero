// Serving an allowed call against an HTTP upstream.
//
// This is what fills the dispatcher seam in ./dispatch.ts: it takes the call
// and the team-sheet entry enforcement matched, resolves that entry's named
// credential against the vault, and hands both to ./outbound.ts. It is the only
// module that holds a `Vault` and a network transport at once, which is why the
// one refusal that cannot be answered from a sheet — `credential_unresolved` —
// is discovered at this level.
//
// **The request body shape is provisional and belongs to #39.** What goes on
// the wire below is `{ tool, arguments }` as JSON, which is a placeholder good
// enough to prove a credential reaches an upstream and no further. MCP's
// JSON-RPC framing, session negotiation, and the client pool are #39's, and
// replacing `toolRequestBody` is where that starts. Nothing else in this file
// should need to change for it: the credential path does not depend on the
// protocol.
//
// What this does not do, deliberately: it does not check the egress allowlist.
// `[egress]` governs destinations the sheet does not pin, and this call's
// destination is the `[[mcp_server]]` url that authorized the tool — see the
// header of packages/schema/src/egress.ts. Nor does it redact: that happens a
// level down in ./outbound.ts, for the structural reason set out in that file's
// header: the function that sent the credential is the only one that can be
// certain of catching it echoed back.

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
import { RedactionError } from "./redact.js";
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
 * The channel is **not** in it, and neither is the attribution the agent sent —
 * `requestingUser` and `task`. The upstream has no business knowing which Slack
 * channel drove a call or who asked for it, and a field carrying either is a
 * field that ends up in someone else's log. Both exist so *this* side can write
 * an audit record; forwarding them would turn an internal record into a
 * disclosure.
 *
 * Named explicitly rather than by spreading the call, so a field added to
 * `ToolCall` does not reach an upstream by default.
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

      // `upstream.url` is a string from here down, and by construction rather
      // than by check: `McpServer` is discriminated on transport, so the guard
      // above narrows to the member that requires one (#89). A sheet declaring
      // `transport = "http"` with no url is rejected at load, which is where an
      // operator can still see it.

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

      // For the log lines below, and for nothing else. There is no egress check
      // to make here: this destination is the one the sheet declared.
      const destination = destinationHost(upstream.url);

      try {
        const response = await callUpstream({
          url: upstream.url,
          body: toolRequestBody(call),
          scheme: SCHEME,
          secret,
          // For the redaction marker, so a scrubbed result says which
          // credential the upstream echoed rather than just that one leaked.
          ...(upstream.credential !== undefined ? { credentialName: upstream.credential } : {}),
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

        // Already scrubbed. `callUpstream` redacts before it returns, because
        // it is the only function that ever sent the value and therefore the
        // only one that can be sure of catching it coming back. Nothing here
        // re-scans — there is no second copy of the secret at this level to
        // scan with, which is the point.
        return { outcome: "ran", result: resultOf(response) };
      } catch (error) {
        // Fail closed. A redaction that could not be performed is the proxy
        // unable to guarantee its own boundary, not a tool failing, and the two
        // must not share a `catch` — converting it to a result here would serve
        // the agent a 200 for a response nobody could scrub. Rethrowing sends
        // it to the server's handler catch, which answers a constant 500
        // without inspecting the thrown value, so no upstream bytes cross.
        if (error instanceof RedactionError) throw error;

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
