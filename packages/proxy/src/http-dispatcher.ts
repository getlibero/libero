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
// **It now answers two questions for two routes**: what an allowed call
// produced, and what an upstream says its tools are. The second lives in
// ./mcp-catalog.ts and reaches a client through a *lease* this file hands it —
// the transport guard and the vault lookup stay here, so the paragraph above
// stays true word for word and there is still one module to audit for
// credential resolution. The catalog holds no vault and no secret, and the
// listing route holds neither a pool nor a method that runs anything.
//
// What this does not do, deliberately: it does not check the egress allowlist.
// `[egress]` governs destinations the sheet does not pin, and this call's
// destination is the `[[mcp_server]]` url that authorized the tool — see the
// header of packages/schema/src/egress.ts. Nor does it redact: that happens two
// levels down in ./outbound.ts, for the structural reason set out in that file's
// header: the function that sent the credential is the only one that can be
// certain of catching it echoed back.

import type { McpServer, ResolvedToolCall, ToolResult } from "@getlibero/schema";
import type { Dispatch, ToolCatalog, ToolDispatcher } from "./dispatch.js";
import type { CallLimits } from "./enforce.js";
import { createSilentLogger, type Logger } from "./log.js";
import { type ClientLease, createMcpCatalog } from "./mcp-catalog.js";
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
  /**
   * The deployment's bound on a response body, from `PROXY_MAX_RESPONSE_BYTES`.
   * Absent means `DEFAULT_UPSTREAM_RESPONSE_BYTES`.
   *
   * Here beside `timeoutMs` rather than anywhere a sheet can reach, because it
   * bounds this process's heap rather than a channel's spend. See the note on
   * `McpPoolOptions`.
   */
  readonly maxResponseBytes?: number;
  readonly logger?: Logger;
  /**
   * The catalog cache's clock, for tests.
   *
   * A second clock in this process, and worth one sentence: this one decides
   * when to ask an upstream again. It is not a security deadline, which is why
   * approval tickets deliberately share the *server's* clock and this does not.
   */
  readonly now?: () => number;
}

/**
 * A dispatcher that owns its client pool, and the catalog that leases from it.
 *
 * `ToolDispatcher` and `ToolCatalog` are both unchanged and both stay the
 * narrow seams `createProxyServer` takes; this is the concrete type the one
 * composition root that builds it sees. Same move `close()` already made: an
 * optional `close?()` on the interface would put an optional-chained call in
 * the composition root and imply every dispatcher owns connections, and a
 * `describe` on `ToolDispatcher` would put listing traffic on the seam whose
 * whole property is that a refused call leaves no trace on it.
 */
export interface HttpDispatcher extends ToolDispatcher, ToolCatalog {
  /**
   * Terminates every legacy session, drops every client, and forgets every
   * cached catalog. Idempotent, bounded, and never rejects.
   */
  close(): Promise<void>;
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
    if (outcome.failure === "unsupported_protocol") {
      return "The tool server does not speak a version of MCP this proxy supports. The call was not made.";
    }
    // Its own sentence since #188, and the reason is that the alternative is a
    // lie an operator would act on. The SDK settles the protocol in one round
    // trip and treats a 401 or 403 on it as final, so this case is reachable
    // where the old ladder reported `unsupported_protocol` — and telling
    // somebody their server speaks the wrong MCP revision, when what actually
    // happened is that their token expired, is the most expensive wrong word in
    // this function. Still no upstream bytes: a status code is a protocol number.
    if (outcome.failure === "unauthorized") {
      return "The tool server rejected this proxy's credential for it. The call was not made.";
    }
    // Its own sentence rather than the "could not be reached" one below, which
    // would be false: the server answered, at length. Reachable because a
    // handshake runs under `MAX_CONTROL_BODY_BYTES` and `discover` reports an
    // overrun as an ordinary failure.
    if (outcome.failure === "too_large") {
      return "The tool server's handshake was larger than this proxy will accept. The call was not made.";
    }
    return `The tool server could not be reached: ${outcome.failure}. The call was not made.`;
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
    case "closed":
      // Reachable since the legacy handshake landed: a client whose session was
      // terminated mid-call refuses rather than reopening one during shutdown.
      // Without this case the default below would claim the call was made,
      // which is wrong in both clauses.
      return "The proxy is shutting down. The call was not completed.";
    case "too_large":
      // The default below is wrong in its second clause here: an answer did come
      // back, and this proxy declined to hold it. Saying which is what lets a
      // model narrow its next request rather than retry the same one — and it is
      // the only account of the response anyone gets, since a body past the cap
      // is dropped undecoded and there is nothing of it to relay.
      return "The tool server's answer was larger than this proxy will accept. The call was made and the answer was discarded.";
    default:
      // The wording the placeholder path used, kept verbatim: it is accurate
      // for a timeout, an unreachable host, and a refused redirect alike.
      //
      // A `default` rather than an exhaustive switch, and the cost is real: a
      // new `McpFailure` member compiles straight through to this sentence, so
      // adding one means checking whether both of its clauses are true. They
      // were not for `closed` or for `too_large`, which is why each has a case.
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
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  });

  /**
   * A client for this upstream, or the reason there is none.
   *
   * The dispatch path's first two guards, lifted so the catalog can share them
   * without learning what a `Vault` is. It carries none of `dispatch`'s
   * call-shaped log fields — there is no call — and it logs nothing itself: the
   * caller has the one `catalog_unavailable` event, and putting a second line
   * here would report every thin listing twice.
   */
  const lease = (upstream: McpServer): ClientLease => {
    if (upstream.transport !== "http") return { ok: false, reason: "unsupported_transport" };

    let secret;
    if (upstream.credential !== undefined) {
      const lookup = options.vault.lookup(upstream.credential);
      // The same fail-before-connecting shape `dispatch` has: an upstream whose
      // credential is missing never learns a listing was attempted, not even
      // through a discovery probe.
      if (lookup.status === "missing") {
        return { ok: false, reason: "credential_unresolved", credential: upstream.credential };
      }
      secret = lookup.secret;
    }

    const client = pool.acquire(upstream, secret);
    return client === null ? { ok: false, reason: "shutting_down" } : { ok: true, client };
  };

  const catalog = createMcpCatalog({
    lease,
    logger,
    ...(options.now !== undefined ? { now: options.now } : {})
  });

  return {
    // Logged after the await rather than before it, so the line means the
    // sessions are gone rather than that they were asked to go.
    async close() {
      // Before the first await, matching the pool's rule that it hands out
      // nothing from the instant closing begins: an entry surviving a close
      // would describe tools against a client that no longer exists.
      catalog.clear();
      await pool.close();
      logger.log("info", { event: "mcp_pool_closed" });
    },

    describe(upstream, wanted) {
      return catalog.describe(upstream, wanted);
    },

    async dispatch(call: ResolvedToolCall, upstream: McpServer, limits: CallLimits): Promise<Dispatch> {
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
        const outcome = await client.callTool(call.tool, call.arguments, limits);
        // Read after the call, when the ladder has run. The protocol is settled
        // for the client's life, so there is no read-after-write hazard here.
        const protocol = client.protocol;

        if (outcome.outcome === "called") {
          logger.log("info", {
            event: "upstream_call",
            channel: call.channel,
            server: call.server,
            tool: call.tool,
            ...(destination !== null ? { destination } : {}),
            ...(protocol !== undefined ? { protocol } : {}),
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
          ...(destination !== null ? { destination } : {}),
          ...(protocol !== undefined ? { protocol } : {})
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
