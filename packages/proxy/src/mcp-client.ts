// One upstream's MCP client: settle on a protocol, then `tools/call`.
//
// Holds a `Secret` and passes it to `callUpstream`, which is still the only
// function that unwraps one and still the only function that redacts a reply.
// Nothing here unwraps a secret; it is carried as a handle and handed down. The
// grep test in ./outbound.test.ts is what keeps that true, and it matches on
// the literal call — which is why this paragraph describes it rather than
// spelling it.
//
// **Two protocols, decided by a ladder rather than by configuration.**
// `2026-07-28` is stateless: it removed protocol-level sessions, the
// `Mcp-Session-Id` header, and the `initialize`/`notifications/initialized`
// handshake, so a request carries its own version and capabilities in `_meta`.
// Everything before it opens with that handshake and may carry a session for
// the connection's life. This client probes with `server/discover` and, if the
// server *answers* with a refusal, attempts the handshake exactly once. The
// result is cached for the client's life, so an upstream is probed once and
// never re-litigated.
//
// **The fallback is not chosen by error code, and that is the design.** A
// server old enough to need `initialize` answers `server/discover` with
// whatever its framework does with an unrouted method — a `-32601`, a 400 over
// a missing session, a 404 from the router, a 406 over the Accept header — and
// no one of those is reliably the signal. The attempt is the discriminator: a
// server that answers `initialize` is a legacy server, and one that does not
// has now said so twice.
//
// **Exactly one signal is ever replayed, and only on the legacy path.** A 404
// answering a request that carried a session id means the server has forgotten
// the session; that 404 is generated before the server dispatches anything, so
// the tool did not run and there is no write to double. Every other failure can
// mean the call ran and the answer was lost, so none of them is retried —
// `2026-07-28` also removed `Last-Event-ID` resumability, and re-issuing a
// `tools/call` is the replay that turns one write into two. At most one
// re-initialize happens per call, and the structure below is what bounds it.
//
// **`tools/list` rides the same ladder and the same session, in its own
// function.** It is a read, so the paragraph above binds it more loosely — but
// it is written as a sibling of `attempt` rather than folded into it, because
// the argument against replaying a write is the argument that function's
// docblock makes, and a listing living inside it is how that argument comes to
// be softened by a later edit.

import type { ToolResult } from "@getlibero/schema";
import {
  MCP_PROTOCOL_VERSION,
  type McpDialect,
  type WireContext,
  acceptedProtocolVersion,
  discoverRequest,
  initializeHeaders,
  initializeRequest,
  initializedNotification,
  negotiatedVersion,
  parseRpcResponse,
  requestHeaders,
  sessionTerminationHeaders,
  toolsCallRequest,
  toolsListRequest
} from "./mcp-protocol.js";
import {
  type UpstreamToolEntry,
  isInputRequired,
  parseToolsList,
  relayedDetail,
  toolResultText
} from "./mcp-bounds.js";
import type { CallLimits } from "./enforce.js";
import {
  type AuthScheme,
  MAX_CONTROL_BODY_BYTES,
  SESSION_TERMINATION_TIMEOUT_MS,
  type UpstreamFailure,
  type UpstreamMethod,
  type UpstreamResponse,
  UpstreamError,
  callUpstream,
  readSessionId
} from "./outbound.js";
import type { Secret } from "./vault.js";

/**
 * Why a call did not produce a tool's answer.
 *
 * A closed set, extending `UpstreamFailure` for the same reason that one is
 * closed: this is the path that holds a secret, so what a caller reports is
 * chosen from a list rather than read off a thrown value.
 */
export type McpFailure =
  | UpstreamFailure
  | "http_error"
  | "rpc_error"
  | "protocol_error"
  | "unsupported_protocol"
  | "input_required"
  | "closed";

/**
 * What a client did with a call.
 *
 * **`connect_failed` has no `detail` member, and that is the type doing the
 * work.** A handshake failure must never relay upstream bytes: the response to
 * a failed handshake is as likely to be an auth proxy's error page as anything
 * MCP, and an error page is exactly where a reflected credential lives. Making
 * the absence structural means a later edit cannot add one by accident — there
 * is no field to fill in. It covers both rungs of the ladder, so an
 * `initialize` that answers 500 with the credential in its body is as silent as
 * a `server/discover` that does.
 */
export type McpOutcome =
  | { readonly outcome: "called"; readonly result: ToolResult }
  | { readonly outcome: "connect_failed"; readonly failure: McpFailure }
  | {
      readonly outcome: "call_failed";
      readonly failure: McpFailure;
      readonly status?: number;
      readonly code?: number;
      readonly detail?: string;
    };

/**
 * What a client did with one page of a `tools/list`.
 *
 * **Neither failure member carries a `detail`, and this is a stricter rule than
 * `McpOutcome`'s.** There, a failing `tools/call` relays a bounded error body
 * because it is often the only thing telling the model what it did wrong. A
 * failing listing produces no model-facing text at all — the tool falls back to
 * the entry the team sheet already produced — so a detail here could only ever
 * be logged, which is upstream bytes written down by the process that holds
 * every credential for no one's benefit. There is no field to fill in.
 *
 * `status` and `code` stay, because a number chosen from the protocol is not
 * upstream-authored text, and an operator asking why a catalog is thin needs
 * one of them.
 */
export type McpListOutcome =
  | {
      readonly outcome: "listed";
      readonly tools: readonly UpstreamToolEntry[];
      readonly nextCursor: string | null;
    }
  | { readonly outcome: "connect_failed"; readonly failure: McpFailure }
  | {
      readonly outcome: "call_failed";
      readonly failure: McpFailure;
      readonly status?: number;
      readonly code?: number;
    };

export interface McpClient {
  /**
   * One `tools/call`.
   *
   * `limits` is the channel's, resolved by the decision that authorized this
   * call — see `CallLimits` in ./enforce.ts. Required for the reason
   * `listTools`'s two arguments are: a default here is a bound spent by a call
   * site that did not choose it.
   */
  callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    limits: CallLimits
  ): Promise<McpOutcome>;
  /**
   * One page of this server's catalog, from `cursor` or from the beginning.
   *
   * `timeoutMs` is per call rather than the client's configured default,
   * because the caller walking the pages is the one holding a budget for the
   * whole walk. Both arguments are required and explicitly nullable: a default
   * is how a call site comes to spend thirty seconds it did not mean to.
   */
  listTools(cursor: string | undefined, timeoutMs: number | undefined): Promise<McpListOutcome>;
  /**
   * Which protocol this client settled on, or `undefined` before the ladder has
   * run and after a handshake that failed. Read by the dispatcher for its log
   * line; nothing branches on it.
   */
  readonly protocol: McpDialect | undefined;
  /**
   * Terminates the legacy session, if there is one, and refuses further calls.
   * Bounded, idempotent, and never rejects.
   */
  close(): Promise<void>;
}

export interface McpClientOptions {
  readonly url: string;
  readonly scheme: AuthScheme;
  readonly secret: Secret | undefined;
  readonly credentialName?: string;
  readonly timeoutMs?: number;
  /**
   * How many bytes of a response to hold before abandoning it. Absent means
   * `DEFAULT_UPSTREAM_RESPONSE_BYTES`.
   *
   * Per client rather than per call, which is the right shape *because* it is a
   * deployment setting: it is identical for every channel this proxy serves, so
   * there is nothing for two channels sharing a pooled client to disagree about.
   * A per-channel bound could not live here — the pool hands one client to every
   * channel naming the same upstream — and would have to be threaded per call
   * like `CallLimits` is. It is not one, deliberately: the heap it spends belongs
   * to the process.
   */
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * How this client talks to this upstream, decided once and kept for its life.
 *
 * Three members rather than a flag plus a nullable session, because a legacy
 * server that assigns no session id is an ordinary legacy server rather than a
 * broken one, and the difference decides two things: whether a 404 can mean the
 * session was lost, and whether `close()` has a `DELETE` to send. Making it a
 * member means neither question is answered by a null check.
 *
 * `generation` is bookkeeping rather than wire — it is what makes N concurrent
 * session losses cost one handshake. See `reopenSession`.
 */
type Mode =
  | { readonly kind: "stateless"; readonly version: string }
  | {
      readonly kind: "legacy_session";
      readonly version: string;
      readonly sessionId: string;
      readonly generation: number;
    }
  | { readonly kind: "legacy_sessionless"; readonly version: string };

type Opened = { readonly ok: true; readonly mode: Mode } | { readonly ok: false; readonly failure: McpFailure };

/**
 * What `server/discover` produced, at the resolution the ladder branches on.
 *
 * `answered_error` deliberately carries nothing. It is the trigger for the
 * fallback rather than a thing anyone reports, and giving it a detail would put
 * bytes from a failed handshake into a value that has to be discarded on every
 * path — which is the guarantee `McpOutcome.connect_failed` makes structurally,
 * made the same way one level down.
 */
type Probe =
  | { readonly kind: "discovered"; readonly version: string }
  | { readonly kind: "answered_error" }
  | { readonly kind: "failed"; readonly failure: McpFailure };

/**
 * One attempt at a request, and whether the session it used has since gone.
 *
 * Generic over the outcome so a call and a listing describe a session loss the
 * same way. The two requests still have their own functions — this is the
 * bookkeeping they share, not the logic.
 */
type Attempt<Outcome> =
  | { readonly kind: "answered"; readonly outcome: Outcome }
  | { readonly kind: "session_lost"; readonly generation: number; readonly outcome: Outcome };

export function createMcpClient(options: McpClientOptions): McpClient {
  let nextId = 1;
  /** Cached on success only — see `ensureOpen`. */
  let mode: Mode | undefined;
  let opening: Promise<Opened> | undefined;
  let reopening: Promise<Opened> | undefined;
  /** Monotonic. Every successful `initialize` that yields a session takes the next. */
  let generations = 0;
  let closed = false;

  /** The one bridge to the pure protocol module. */
  const wireOf = (at: Mode): WireContext => ({
    dialect: at.kind === "stateless" ? "stateless" : "legacy",
    version: at.version,
    ...(at.kind === "legacy_session" ? { sessionId: at.sessionId } : {})
  });

  /**
   * The one `callUpstream` call site in this module.
   *
   * The `exactOptionalPropertyTypes` spreads live here and nowhere else, so
   * adding a request does not mean copying five conditionals. The `DELETE`
   * comes through here too rather than opening a second path — see the note on
   * `callUpstream` about why one function serves both verbs.
   */
  const send = async (call: {
    readonly headers: Record<string, string>;
    readonly method?: UpstreamMethod;
    readonly body?: unknown;
    readonly timeoutMs?: number;
    readonly maxBodyBytes?: number;
  }): Promise<UpstreamResponse> => {
    const timeoutMs = call.timeoutMs ?? options.timeoutMs;
    // The client's configured bound unless the caller named a tighter one, which
    // only the control-plane requests do. Same shape as `timeoutMs` above.
    const maxBodyBytes = call.maxBodyBytes ?? options.maxResponseBytes;
    return callUpstream({
      url: options.url,
      headers: call.headers,
      scheme: options.scheme,
      secret: options.secret,
      ...(call.method !== undefined ? { method: call.method } : {}),
      ...("body" in call ? { body: JSON.stringify(call.body) } : {}),
      ...(options.credentialName !== undefined ? { credentialName: options.credentialName } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });
  };

  /**
   * The version probe, resolved to the three answers the ladder distinguishes.
   *
   * The `failed` rows that are *not* transport failures are decisions worth
   * stating. A well-formed request answered 200 with bytes that are not MCP is
   * a broken server or an edge proxy rather than an old one — falling back
   * there spends a second round trip on something that has already shown it is
   * not speaking the protocol. And a server that implemented `server/discover`,
   * a `2026-07-28` method, and then advertised no stateless revision has
   * *answered successfully*; that is a version disagreement rather than an
   * error, so it is not a trigger.
   *
   * `too_large` joins them on the first of those arguments. The probe is sent
   * under `MAX_CONTROL_BODY_BYTES`, which is far above any list of protocol
   * revisions, so a server that overruns it is not one whose answer would have
   * been readable at any other rung of the ladder.
   */
  const discover = async (): Promise<Probe> => {
    const id = nextId++;
    let response: UpstreamResponse;
    try {
      // The probe is a `2026-07-28` request by definition — it is that
      // revision's own negotiation method — so it goes out at the pinned
      // constant. A server that speaks something older answers it with a
      // refusal, which is exactly the trigger below.
      response = await send({
        headers: requestHeaders({ dialect: "stateless", version: MCP_PROTOCOL_VERSION }, "server/discover"),
        body: discoverRequest(id),
        maxBodyBytes: MAX_CONTROL_BODY_BYTES
      });
    } catch (error) {
      // `UpstreamError` only. A `RedactionError` — the proxy unable to
      // guarantee its own boundary — propagates past here to the server's
      // handler, which answers a constant 500 rather than serving anything.
      //
      // Nothing answered, so there is nothing to fall back *from*: a timeout or
      // a refused connection says nothing about which protocol the server
      // speaks, and attempting the handshake would double the wait on an
      // upstream that is simply down.
      if (!(error instanceof UpstreamError)) throw error;
      return { kind: "failed", failure: error.failure };
    }

    if (response.status < 200 || response.status >= 300) return { kind: "answered_error" };

    const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
    if (parsed.kind === "malformed") return { kind: "failed", failure: "protocol_error" };
    if (parsed.kind === "error") return { kind: "answered_error" };

    const version = negotiatedVersion(parsed.result);
    if (version === null) return { kind: "failed", failure: "unsupported_protocol" };
    return { kind: "discovered", version };
  };

  /**
   * The `initialize` + `notifications/initialized` handshake, and the one place
   * a session is born.
   *
   * The acknowledgement is awaited rather than fired: the spec says a server
   * SHOULD NOT process other requests until it arrives, so a `tools/call`
   * racing it is a call the server is entitled to refuse. Its reply is a 202
   * with an empty body and is **not** parsed — running an empty body through
   * `parseRpcResponse` reports `not_json`, which would fail the handshake
   * against every server that follows the spec.
   */
  const initializeLegacy = async (): Promise<Opened> => {
    const id = nextId++;
    let response: UpstreamResponse;
    try {
      response = await send({
        headers: initializeHeaders(),
        body: initializeRequest(id),
        maxBodyBytes: MAX_CONTROL_BODY_BYTES
      });
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return { ok: false, failure: error.failure };
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, failure: "unsupported_protocol" };

    const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
    if (parsed.kind === "malformed") return { ok: false, failure: "protocol_error" };
    if (parsed.kind === "error") return { ok: false, failure: "unsupported_protocol" };

    const version = acceptedProtocolVersion(parsed.result);
    if (version === null) return { ok: false, failure: "unsupported_protocol" };

    // Read before the acknowledgement, because the acknowledgement is the first
    // request that has to carry it.
    const sessionId = readSessionId(response.headers["mcp-session-id"] ?? null);
    const next: Mode =
      sessionId === null
        ? { kind: "legacy_sessionless", version }
        : { kind: "legacy_session", version, sessionId, generation: ++generations };

    let ack: UpstreamResponse;
    try {
      ack = await send({
        headers: requestHeaders(wireOf(next), "notifications/initialized"),
        body: initializedNotification(),
        maxBodyBytes: MAX_CONTROL_BODY_BYTES
      });
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return { ok: false, failure: error.failure };
    }
    // Status only. There is no body to read, and a server that sent one has
    // said nothing this client would act on.
    if (ack.status < 200 || ack.status >= 300) return { ok: false, failure: "protocol_error" };

    return { ok: true, mode: next };
  };

  /**
   * The ladder: `server/discover`, then — once — the legacy handshake.
   *
   * **Exactly two attempts, and the structure is what bounds it rather than a
   * counter.** There is no loop here and no recursion; the fallback is one
   * statement that runs or does not.
   */
  const open = async (): Promise<Opened> => {
    const probe = await discover();
    if (probe.kind === "discovered") return { ok: true, mode: { kind: "stateless", version: probe.version } };
    if (probe.kind === "failed") return { ok: false, failure: probe.failure };
    return initializeLegacy();
  };

  /**
   * The ladder, at most once at a time.
   *
   * Single-flight so N concurrent first calls probe once rather than N times.
   * **Success is cached; failure is not.** A protocol both ends agreed on does
   * not change under a running process, but a timeout is a moment rather than a
   * property of the upstream — caching one would disable a server for the
   * process lifetime because it was briefly slow.
   *
   * `opening` is cleared on rejection as well as fulfilment. A handshake that
   * threw — a `RedactionError` from an empty vault value is the realistic
   * case — must not leave a permanently rejected promise for every later call
   * to await.
   */
  const ensureOpen = async (): Promise<Opened> => {
    if (mode !== undefined) return { ok: true, mode };
    if (closed) return { ok: false, failure: "closed" };
    if (opening === undefined) {
      opening = open().finally(() => {
        opening = undefined;
      });
    }
    const result = await opening;
    if (result.ok) mode = result.mode;
    return result;
  };

  /**
   * A fresh legacy session, unless someone already made one.
   *
   * **Two mechanisms, because there are two races.** The generation check
   * catches the straggler: a call whose 404 arrived after another call had
   * already re-initialized presents a generation that is no longer current, and
   * takes the session that is rather than starting a second handshake against a
   * healthy one. The single flight catches the simultaneous case: N calls that
   * all lost generation 1 at the same instant all find it current, and all
   * await one promise.
   *
   * Together they are what makes N concurrent losses cost one `initialize` —
   * and, more to the point, what stops a later handshake from invalidating a
   * session an earlier call was about to use.
   *
   * It calls `initializeLegacy` and never `open`: the dialect was settled for
   * the client's life by the ladder, and re-probing `server/discover` on a
   * session loss would be a second ladder.
   */
  const reopenSession = async (used: number): Promise<Opened> => {
    if (closed) return { ok: false, failure: "closed" };

    const current = mode;
    if (current !== undefined && current.kind === "legacy_session" && current.generation !== used) {
      return { ok: true, mode: current };
    }
    if (reopening === undefined) {
      reopening = initializeLegacy().finally(() => {
        reopening = undefined;
      });
    }
    const result = await reopening;
    if (result.ok) mode = result.mode;
    return result;
  };

  /** One `tools/call`, at the protocol this client settled on. */
  const attempt = async (
    at: Mode,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    limits: CallLimits
  ): Promise<Attempt<McpOutcome>> => {
    const id = nextId++;
    const dialect: McpDialect = at.kind === "stateless" ? "stateless" : "legacy";
    let response: UpstreamResponse;
    try {
      response = await send({
        headers: requestHeaders(wireOf(at), "tools/call", tool),
        body: toolsCallRequest(id, tool, args, dialect)
      });
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return { kind: "answered", outcome: { outcome: "call_failed", failure: error.failure } };
    }

    if (response.status < 200 || response.status >= 300) {
      // The body is safe to relay: `callUpstream` already scrubbed it, and a
      // tool endpoint's error text is often the only thing that tells the
      // model what it did wrong. Bounded, though: it is upstream-authored
      // text like every other relay here, and an endpoint answering its
      // error in megabytes should not spend the channel's tokens saying so.
      const outcome: McpOutcome = {
        outcome: "call_failed",
        failure: "http_error",
        status: response.status,
        detail: relayedDetail(response.body)
      };
      // **A session loss is a 404 to a request that carried a session id, and
      // nothing else.** That is the spec's explicit signal, and it is generated
      // before the server dispatches the call, which is what makes replaying
      // this one safe. A 404 from a client that sent no session id is a wrong
      // url — the sheet naming an endpoint that does not exist — and stays an
      // ordinary `http_error`, because reconnecting would not make the url
      // right and would double every call made against a typo.
      if (response.status === 404 && at.kind === "legacy_session") {
        return { kind: "session_lost", generation: at.generation, outcome };
      }
      return { kind: "answered", outcome };
    }

    const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
    if (parsed.kind === "malformed") {
      return { kind: "answered", outcome: { outcome: "call_failed", failure: "protocol_error", detail: parsed.reason } };
    }
    if (parsed.kind === "error") {
      return {
        kind: "answered",
        outcome: { outcome: "call_failed", failure: "rpc_error", code: parsed.code, detail: parsed.message }
      };
    }

    // An upstream asking for more input is asking the proxy to speak for a
    // channel: to answer a sampling request out of the channel's model
    // budget, or an elicitation with something no one was asked. There is no
    // sheet entry and no click behind either, so the answer is no — and no
    // retry, since retrying is how the round trip would be completed.
    if (isInputRequired(parsed.result)) {
      return { kind: "answered", outcome: { outcome: "call_failed", failure: "input_required" } };
    }

    const mapped = toolResultText(parsed.result, limits.maxResultChars);
    if (mapped === null) {
      return {
        kind: "answered",
        outcome: { outcome: "call_failed", failure: "protocol_error", detail: "bad_result" }
      };
    }

    return { kind: "answered", outcome: { outcome: "called", result: mapped } };
  };

  /**
   * One `tools/list` page, at the protocol this client settled on.
   *
   * A sibling of `attempt` rather than a branch inside it. What the two share —
   * `send`, `wireOf`, `ensureOpen`, `reopenSession`, and the session-loss shape
   * — they share by calling the same things; what they do not share is the
   * argument about replaying a write, which belongs to one of them alone.
   *
   * No `input_required` branch: a listing is not a round trip an upstream can
   * ask this proxy to continue, and a result shaped like one has no `tools`
   * array, so it is already a protocol error by the line below.
   */
  const attemptList = async (
    at: Mode,
    cursor: string | undefined,
    timeoutMs: number | undefined
  ): Promise<Attempt<McpListOutcome>> => {
    const id = nextId++;
    const dialect: McpDialect = at.kind === "stateless" ? "stateless" : "legacy";
    let response: UpstreamResponse;
    try {
      response = await send({
        headers: requestHeaders(wireOf(at), "tools/list"),
        body: toolsListRequest(id, dialect, cursor),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      });
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return { kind: "answered", outcome: { outcome: "call_failed", failure: error.failure } };
    }

    if (response.status < 200 || response.status >= 300) {
      // The status and nothing else. `attempt` relays a bounded body here
      // because a model reads it; nobody reads this one.
      const outcome: McpListOutcome = {
        outcome: "call_failed",
        failure: "http_error",
        status: response.status
      };
      // The same signal, and safe here for one more reason than it is there:
      // the 404 precedes dispatch, *and* a listing is a read, so a replay has
      // no write to double.
      if (response.status === 404 && at.kind === "legacy_session") {
        return { kind: "session_lost", generation: at.generation, outcome };
      }
      return { kind: "answered", outcome };
    }

    const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
    if (parsed.kind === "malformed") {
      return { kind: "answered", outcome: { outcome: "call_failed", failure: "protocol_error" } };
    }
    if (parsed.kind === "error") {
      return { kind: "answered", outcome: { outcome: "call_failed", failure: "rpc_error", code: parsed.code } };
    }

    const page = parseToolsList(parsed.result);
    if (page === null) {
      return { kind: "answered", outcome: { outcome: "call_failed", failure: "protocol_error" } };
    }

    return {
      kind: "answered",
      outcome: { outcome: "listed", tools: page.tools, nextCursor: page.nextCursor }
    };
  };

  return {
    get protocol() {
      return mode === undefined ? undefined : mode.kind === "stateless" ? "stateless" : "legacy";
    },

    async callTool(tool, args, limits) {
      const ready = await ensureOpen();
      if (!ready.ok) return { outcome: "connect_failed", failure: ready.failure };

      const first = await attempt(ready.mode, tool, args, limits);
      if (first.kind === "answered") return first.outcome;

      const reopened = await reopenSession(first.generation);
      if (!reopened.ok) return { outcome: "call_failed", failure: reopened.failure };

      // The second and last attempt, and there is no third: this is the whole
      // of the retry budget, spent here, with no counter to get wrong and no
      // branch that can lead back. A server that has forgotten every session
      // answers the model with the plain 404 the second attempt produced.
      return (await attempt(reopened.mode, tool, args, limits)).outcome;
    },

    async listTools(cursor, timeoutMs) {
      const ready = await ensureOpen();
      if (!ready.ok) return { outcome: "connect_failed", failure: ready.failure };

      const first = await attemptList(ready.mode, cursor, timeoutMs);
      if (first.kind === "answered") return first.outcome;

      const reopened = await reopenSession(first.generation);
      if (!reopened.ok) return { outcome: "call_failed", failure: reopened.failure };

      // The same one-shot budget as `callTool`, spent the same way and for the
      // same reason: two statements, no counter, and no branch that leads back.
      return (await attemptList(reopened.mode, cursor, timeoutMs)).outcome;
    },

    /**
     * Hang up.
     *
     * The `DELETE` is a courtesy the spec asks for rather than a correctness
     * requirement — a server expires a session it stops hearing from — so every
     * failure here is swallowed, including a redaction failure. **That is the
     * one place in this package where swallowing one is right**, and the
     * argument is narrow: nothing reads this response, so there is nothing a
     * failed scan could have failed to protect, and the only way the scan
     * throws is a stored value the calls that established this session would
     * already have failed on. A shutdown that throws out of a signal handler is
     * strictly worse than a session the server was going to expire anyway.
     *
     * `SESSION_TERMINATION_TIMEOUT_MS` rather than the configured upstream
     * timeout, because this one runs while the process is trying to exit.
     */
    async close(): Promise<void> {
      const at = mode;
      closed = true;
      mode = undefined;
      if (at === undefined || at.kind !== "legacy_session") return;
      try {
        await send({
          method: "DELETE",
          headers: sessionTerminationHeaders(at.sessionId, at.version),
          timeoutMs: SESSION_TERMINATION_TIMEOUT_MS,
          maxBodyBytes: MAX_CONTROL_BODY_BYTES
        });
      } catch {
        // Nothing is read off the thrown value, per the rule in ./outbound.ts.
      }
    }
  };
}
