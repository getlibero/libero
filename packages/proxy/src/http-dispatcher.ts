// Serving an allowed call against an HTTP upstream.
//
// This is what fills the dispatcher seam in ./dispatch.ts: it takes the call
// and the team-sheet entry enforcement matched, resolves that entry's named
// credential against the vault, and hands both to the client pool. It is the
// only module that holds a `Vault` and a network transport at once, which is
// why the one refusal that cannot be answered from a sheet —
// `credential_unresolved` — is discovered at this level.
//
// The protocol is the official SDK's, adapted in ./mcp-client.ts, with what an
// upstream may say bounded in ./mcp-bounds.ts. This file is the same shape it
// was when the wire format was a placeholder, which is what the old header
// promised: the credential path does not depend on the protocol. What it owns
// that those do not is the prose a model reads when a call did not produce an
// answer.
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
import type { Dispatch, McpToolDispatcher, ToolCatalog, UpstreamCallDefinition } from "./dispatch.js";
import type { CallLimits } from "./enforce.js";
import { createSilentLogger, type Logger } from "./log.js";
import { type ClientLease, createMcpCatalog } from "./mcp-catalog.js";
import type { McpFailure, McpOutcome } from "./mcp-client.js";
import { type McpPool, createMcpPool } from "./mcp-pool.js";
import { type CredentialSource, UpstreamError, constantCredential, destinationHost } from "./outbound.js";
import { RedactionError } from "./redact.js";
import { type TokenEngine, createTokenEngine } from "./token-engine.js";
import type { TokenStore } from "./token-store.js";
import type { Vault } from "./vault.js";

// The scheme travels on the CredentialSource now — the vault's is a constant
// bearer source built at the two resolution sites below — so there is no
// module-wide SCHEME any more. What its old comment promised still holds:
// which header a scheme uses is not a sheet field, and the auth block (#255)
// declares *that* an upstream speaks OAuth, never how a header is spelled.

/**
 * The store a deployment without one behaves as: every grant is absent.
 *
 * Fail closed, not an error — an auth-carrying sheet block against a proxy
 * with no token store is a grant that has not been run, and the answer to
 * that is `unavailable`, the same one it gets when the store exists and is
 * empty. The write paths are unreachable: nothing on the serving path calls
 * them, and the engine only rotates inside an exchange no absent grant can
 * start.
 */
function absentTokenStore(): TokenStore {
  return {
    read: () => ({ status: "missing", reason: "absent" }),
    rotate: () => Promise.reject(new Error("this deployment has no token store")),
    putGrant: () => Promise.reject(new Error("this deployment has no token store")),
    close: () => undefined,
    size: 0
  };
}

export interface HttpDispatcherOptions {
  /** Opened once at startup. The dispatcher holds it; no route does. */
  readonly vault: Vault;
  /**
   * The token store beside it (#256), for upstreams whose sheet block carries
   * `auth`. Which store a credential name resolves in is the scheme's
   * decision, never a fallback: a bearer name resolves in the vault, an OAuth
   * name here, and neither ever falls through to the other. Absent means a
   * deployment with no OAuth upstream — an auth-carrying block then finds no
   * grant and is answered `unavailable`, fail closed.
   */
  readonly tokens?: TokenStore;
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
  /**
   * The deployment's bound on concurrent calls to one upstream, from
   * `PROXY_MAX_UPSTREAM_CONCURRENCY`. Absent means
   * `DEFAULT_UPSTREAM_CONCURRENCY`.
   *
   * Beside `maxResponseBytes` and for its reason: it bounds what this process
   * spends against one upstream, which every channel naming that upstream
   * shares. See the note on `McpPoolOptions`.
   */
  readonly maxUpstreamConcurrency?: number;
  /** How long a call waits for a permit. For tests; see `QUEUE_WAIT_MS`. */
  readonly queueWaitMs?: number;
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
 * `McpToolDispatcher` and `ToolCatalog` are both unchanged and both stay the
 * narrow seams the composition root wires; this is the concrete type the one
 * place that builds it sees. Same move `close()` already made: an
 * optional `close?()` on the interface would put an optional-chained call in
 * the composition root and imply every dispatcher owns connections, and a
 * `describe` on the dispatcher seam would put listing traffic on the one whose
 * whole property is that a refused call leaves no trace on it.
 *
 * **It is the MCP seam and not `ToolDispatcher`** (#64). The server holds a
 * `ToolDispatcher`, which takes a `Target` that may be a built-in;
 * `createToolDispatcher` narrows and hands this arm an `McpServer`. So the
 * object that owns the vault and the pool structurally cannot be handed a
 * built-in call, and there is no branch in here that could mistake one for an
 * upstream with a missing url.
 */
export interface HttpDispatcher extends McpToolDispatcher, ToolCatalog {
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
    // Its own sentence because the one below would name the wrong party: the
    // tool server could have been reached perfectly well, and was not asked.
    // This proxy was already running as many calls to it as it allows and none
    // finished while this one waited. Worth saying plainly rather than as a
    // reachability failure, because the two have opposite fixes — one is the
    // operator's upstream, the other is `PROXY_MAX_UPSTREAM_CONCURRENCY` or a
    // channel making more calls at once than the deployment was sized for.
    if (outcome.failure === "busy") {
      return "This proxy is already running as many calls to that tool server as it allows, and none finished in time. The call was not made.";
    }
    // The `call_failed` arm has had this sentence since the legacy handshake
    // landed; this arm needs it since #159, which made this the *designed*
    // shutdown path rather than a narrow race. `close()` opens the pool's
    // limiters so a call queued for a permit is woken rather than stranded, and
    // what it is woken into is a client that has already flipped closed — so it
    // never reaches a request and the outcome is a connect failure. The default
    // below would say the server could not be reached, which names a server that
    // is fine and was never asked.
    if (outcome.failure === "closed") {
      return "The proxy is shutting down. The call was not made.";
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
    case "unauthorized":
      // Reachable on this branch, not only on `connect_failed`: a session the
      // upstream forgot is reopened mid-call, and the re-handshake can be
      // answered 401 — a token revoked while the session lived. Both of the
      // default's clauses are false here (the 404 precedes dispatch, so the
      // tool never ran), and the wording matches the connect-time case because
      // the operator's fix is the same either way.
      return "The tool server rejected this proxy's credential for it. The call was not made.";
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
function failureEvent(
  failure: McpFailure
): "mcp_protocol_error" | "mcp_input_required" | "upstream_saturated" | "upstream_failed" {
  if (failure === "protocol_error" || failure === "unsupported_protocol") return "mcp_protocol_error";
  if (failure === "input_required") return "mcp_input_required";
  // Not `upstream_failed`, which would file this under the upstream's name for
  // something the upstream did not do — it was never asked. An operator grepping
  // for a failing server should not find these, and an operator wondering
  // whether to raise `PROXY_MAX_UPSTREAM_CONCURRENCY` should find nothing else.
  if (failure === "busy") return "upstream_saturated";
  return "upstream_failed";
}

/**
 * How loudly a failure is written down.
 *
 * `error` is the default because a call that produced no answer usually means
 * something an operator has to fix. The two exceptions are the conditions that
 * clear on their own: an upstream asking for input, and an upstream this proxy
 * is already running its full allowance of calls against. Saturation at a
 * healthy deployment under load is a capacity fact, and one `error` line per
 * queued call is how a working system pages somebody.
 *
 * A function rather than a second ternary at the call site, because the list of
 * exceptions is now long enough to be a decision rather than a special case.
 */
function failureLevel(failure: McpFailure): "warn" | "error" {
  return failure === "input_required" || failure === "busy" ? "warn" : "error";
}

export function createHttpDispatcher(options: HttpDispatcherOptions): HttpDispatcher {
  const logger = options.logger ?? createSilentLogger();
  // Built here rather than injected, so this file stays the only module
  // holding credential stores and a transport at once. A deployment with no
  // token store gets an engine over an empty one: every OAuth binding then
  // reads `absent`, which is the fail-closed answer, not an error.
  const engine: TokenEngine = createTokenEngine({
    store: options.tokens ?? absentTokenStore(),
    logger,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  });
  const pool: McpPool = createMcpPool({
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.maxUpstreamConcurrency !== undefined
      ? { maxUpstreamConcurrency: options.maxUpstreamConcurrency }
      : {}),
    ...(options.queueWaitMs !== undefined ? { queueWaitMs: options.queueWaitMs } : {}),
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

    // The OAuth arm, before the vault lookup, deliberately: an OAuth name
    // resolves in the token store and never falls through to the vault. This
    // path is synchronous, so the source is built without I/O and the engine
    // mints lazily at the listing's first request — a grantless upstream still
    // never sees a probe, because no-grant is decided at the store read,
    // before any network.
    if (upstream.auth !== undefined) {
      // The schema refuses an auth block with no credential at parse; this
      // guard narrows the type, and answers a hand-built server the way the
      // sheet's loader would have.
      if (upstream.credential === undefined) {
        return { ok: false, reason: "credential_unresolved" };
      }
      const client = pool.acquire(
        upstream,
        engine.source({
          credential: upstream.credential,
          issuer: upstream.auth.issuer,
          scopes: upstream.auth.scopes
        })
      );
      return client === null ? { ok: false, reason: "shutting_down" } : { ok: true, client };
    }

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

    const client = pool.acquire(upstream, constantCredential("bearer", secret, upstream.credential));
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

      // For the log lines below, and for nothing else. There is no egress check
      // to make here: this destination is the one the sheet declared.
      const destination = destinationHost(upstream.url);

      let source: CredentialSource;
      if (upstream.auth !== undefined) {
        // The OAuth arm. The scheme selects the store: this arm never consults
        // the vault, and the bearer arm below never consults the token store.
        // The pre-flight lease is the fail-before-connecting shape
        // `credential_unresolved` has — a dead grant never sends the upstream
        // so much as a discovery probe, and the test asserts the fake sees
        // zero requests.
        if (upstream.credential === undefined) {
          // Unreachable from a parsed sheet — the schema requires a credential
          // beside an auth block — so this narrows the type and fails closed.
          return { outcome: "unavailable", reason: "no_grant" };
        }
        const leased = await engine.lease({
          credential: upstream.credential,
          issuer: upstream.auth.issuer,
          scopes: upstream.auth.scopes
        });
        if (leased.status !== "ok") {
          // The engine already logged the precise failure by name; this line
          // adds what the engine cannot know — which call went unserved.
          logger.log("warn", {
            event: "dispatch_grant_unavailable",
            channel: call.channel,
            server: call.server,
            tool: call.tool,
            credential: upstream.credential,
            reason: leased.status === "mint_failed" ? leased.failure : leased.status
          });
          return {
            outcome: "unavailable",
            reason: leased.status === "mint_failed" ? "mint_failed" : leased.status
          };
        }
        source = leased.source;
      } else {
        // Resolved before anything is opened, so a sheet naming a credential
        // the vault does not hold refuses without the upstream ever learning
        // the call existed — not even a discovery probe. The test asserts the
        // fake sees zero requests.
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
        source = constantCredential("bearer", secret, upstream.credential);
      }

      const client = pool.acquire(upstream, source);
      if (client === null) {
        // Shutting down. Answered rather than served over a pool the process is
        // dismantling, and never a refusal: nothing was denied.
        return {
          outcome: "ran",
          result: { content: "The proxy is shutting down. The call was not made.", isError: true }
        };
      }

      try {
        // **Inside the try, deliberately.** This can throw a `RedactionError`
        // exactly as the call below can — a catalog walk is a credentialed
        // request like any other — and the catch beneath is what rethrows one
        // rather than answering with a result nobody could scrub. Outside it,
        // the fail-closed path would have a hole in it the width of a listing.
        //
        // Everything else it can go wrong with answers with no declarations, so
        // a cold cache, a dead upstream or a tool that declares nothing all send
        // the call anyway. A thin catalog has never been allowed to block a
        // permitted call, and this is the path where that rule earns its keep.
        //
        // **Its own catch, because the outer one speaks for the call.** A throw
        // from here reaching the catch below would be answered "the call was
        // made and no result came back" and audited `ran` — for a call that was
        // never dispatched, which is exactly the over-claim `unanswered` exists
        // to rule out. An unforeseen failure to *describe* degrades to the thin
        // definition like every foreseen one; only a `RedactionError` crosses.
        let definition: UpstreamCallDefinition;
        try {
          definition = await catalog.definitionFor(upstream, call.tool);
        } catch (error) {
          if (error instanceof RedactionError) throw error;
          logger.log("warn", {
            event: "catalog_definition_failed",
            channel: call.channel,
            server: call.server,
            tool: call.tool
          });
          definition = { paramDeclarations: [] };
        }
        const outcome = await client.callTool(call.tool, call.arguments, limits, definition);
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

        logger.log(failureLevel(outcome.failure), {
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
