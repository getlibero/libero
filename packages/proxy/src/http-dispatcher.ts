// Serving an allowed call against an HTTP upstream.
//
// This is what fills the dispatcher seam in ./dispatch.ts: it takes the call
// and the team-sheet entry enforcement matched, resolves that entry's named
// credential against the vault, and hands both to the client pool. It is the
// only module that holds a `Vault` and a network transport at once, which is
// why the one refusal that cannot be answered from a sheet —
// `credential_unresolved` — is discovered at this level.
//
// The protocol lives in ./mcp-protocol.ts and the session-free client in
// ./mcp-client.ts. This file is the same shape it was when the wire format was
// a placeholder, which is what the old header promised: the credential path does
// not depend on the protocol. What it owns that those do not is the prose a
// model reads when a call did not produce an answer.
//
// The file is still called `http-dispatcher` because the name discriminates
// transport — http against stdio — and that is still exactly what the guard
// below does.
//
// What this does not do, deliberately: it does not check the egress allowlist.
// `[egress]` governs destinations the sheet does not pin, and this call's
// destination is the `[[mcp_server]]` url that authorized the tool — see the
// header of packages/schema/src/egress.ts. Nor does it redact: that happens two
// levels down in ./outbound.ts, for the structural reason set out in that file's
// header: the function that sent the credential is the only one that can be
// certain of catching it echoed back.

import type { McpServer, ResolvedToolCall, ToolResult } from "@getlibero/schema";
import type { Dispatch, ToolDispatcher } from "./dispatch.js";
import { createSilentLogger, type Logger } from "./log.js";
import type { McpFailure, McpOutcome } from "./mcp-client.js";
import { type McpPool, createMcpPool } from "./mcp-pool.js";
import { type AuthScheme, UpstreamError, destinationHost } from "./outbound.js";
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
 * A dispatcher that owns its client pool.
 *
 * `ToolDispatcher` itself is unchanged and stays the narrow seam
 * `createProxyServer` takes. An optional `close?()` on the interface would put
 * an optional-chained call in the composition root and imply every dispatcher
 * owns connections; a wider concrete return type gives the one composition root
 * that builds this a `close()` it can call without asking whether it exists.
 */
export interface HttpDispatcher extends ToolDispatcher {
  /** Drops every client. Idempotent, and never throws. */
  close(): void;
}

/**
 * The prose a model reads when a call produced no tool answer.
 *
 * Every one of these is a fixed template chosen from a closed set, never a
 * string that came back from an upstream — except where the text says
 * otherwise, and where it does the value has already been through
 * `redactSecrets` inside `callUpstream`.
 *
 * A failure is still `outcome: "ran"` with `isError: true` rather than a
 * refusal or a `ProxyError`. Nothing was denied, and the proxy did not break;
 * the tool did not answer, and that is a thing the model should see and may
 * recover from. `ToolResult.isError` draws exactly that line.
 */
function failureText(outcome: Extract<McpOutcome, { outcome: "connect_failed" | "call_failed" }>): string {
  if (outcome.outcome === "connect_failed") {
    // No upstream bytes, ever. A failed handshake is as likely to be answered
    // by an auth proxy's error page as by anything MCP, and an error page is
    // where a reflected credential lives. The type has no `detail` to relay.
    return outcome.failure === "unsupported_protocol"
      ? "The tool server does not speak a version of MCP this proxy supports. The call was not made."
      : `The tool server could not be reached: ${outcome.failure}. The call was not made.`;
  }

  switch (outcome.failure) {
    case "http_error":
      return `The tool endpoint answered HTTP ${String(outcome.status ?? 0)}.\n${outcome.detail ?? ""}`.trimEnd();
    case "rpc_error":
      return `The tool call failed: ${outcome.detail ?? "no reason given"} (code ${String(outcome.code ?? 0)}).`;
    case "protocol_error":
      return "The tool server's answer could not be read as MCP.";
    case "input_required":
      return "The tool server asked for more input before answering. The proxy does not answer for a channel, so the call was abandoned.";
    default:
      // The wording the placeholder path used, kept verbatim: it is accurate
      // for a timeout, an unreachable host, and a refused redirect alike.
      return `The tool did not answer: ${outcome.failure}. The call was made and no result came back.`;
  }
}

/** Which log line a failure deserves, and under what reason code. */
function failureEvent(failure: McpFailure): "mcp_protocol_error" | "mcp_input_required" | "upstream_failed" {
  if (failure === "protocol_error" || failure === "unsupported_protocol") return "mcp_protocol_error";
  if (failure === "input_required") return "mcp_input_required";
  return "upstream_failed";
}

export function createHttpDispatcher(options: HttpDispatcherOptions): HttpDispatcher {
  const logger = options.logger ?? createSilentLogger();
  const pool: McpPool = createMcpPool({
    scheme: SCHEME,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  });

  return {
    close() {
      pool.close();
      logger.log("info", { event: "mcp_pool_closed" });
    },

    async dispatch(call: ResolvedToolCall, upstream: McpServer): Promise<Dispatch> {
      // Not built rather than not allowed. A stdio upstream needs a process
      // pool and a sandbox, which is a filed follow-up; answering `unavailable`
      // keeps it readable apart from a refusal.
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

      // Resolved before anything is opened, so a sheet naming a credential the
      // vault does not hold refuses without the upstream ever learning the call
      // existed — not even a discovery probe. The test asserts the fake sees
      // zero requests.
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

      const client = pool.acquire(upstream, secret);
      if (client === null) {
        // Shutting down. Answered rather than served over a pool the process is
        // dismantling, and never a refusal: nothing was denied.
        return {
          outcome: "ran",
          result: { content: "The proxy is shutting down. The call was not made.", isError: true }
        };
      }

      try {
        const outcome = await client.callTool(call.tool, call.arguments);

        if (outcome.outcome === "called") {
          logger.log("info", {
            event: "upstream_call",
            channel: call.channel,
            server: call.server,
            tool: call.tool,
            ...(destination !== null ? { destination } : {}),
            ...(upstream.credential !== undefined ? { credential: upstream.credential } : {})
          });

          // Already scrubbed. `callUpstream` redacts before it returns, because
          // it is the only function that ever sent the value and therefore the
          // only one that can be sure of catching it coming back. Nothing here
          // re-scans — there is no second copy of the secret at this level to
          // scan with, which is the point.
          return { outcome: "ran", result: outcome.result };
        }

        logger.log(outcome.failure === "input_required" ? "warn" : "error", {
          event: failureEvent(outcome.failure),
          channel: call.channel,
          server: call.server,
          tool: call.tool,
          reason: outcome.failure,
          ...(outcome.outcome === "call_failed" && outcome.status !== undefined ? { status: outcome.status } : {}),
          ...(destination !== null ? { destination } : {})
        });

        const result: ToolResult = { content: failureText(outcome), isError: true };
        return { outcome: "ran", result };
      } catch (error) {
        // Fail closed. A redaction that could not be performed is the proxy
        // unable to guarantee its own boundary, not a tool failing, and the two
        // must not share a `catch` — converting it to a result here would serve
        // the agent a 200 for a response nobody could scrub. Rethrowing sends
        // it to the server's handler catch, which answers a constant 500
        // without inspecting the thrown value, so no upstream bytes cross.
        if (error instanceof RedactionError) throw error;

        // The client turns `UpstreamError` into an outcome, so reaching here at
        // all means something unforeseen. It is reported as a bare transport
        // failure rather than re-thrown, so no foreign error object — which may
        // hold the request, which holds the credential — reaches the log.
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
