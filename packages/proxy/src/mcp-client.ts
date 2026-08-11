// One upstream's MCP client: settle on a protocol, then `tools/call`.
//
// **The protocol is the official SDK's since #188; what this module owns is the
// translation.** `@modelcontextprotocol/client` frames the messages, negotiates
// the era, and holds the session. This file does three things it will not do:
// it configures the client so that the proxy's refusals are structural rather
// than conventional, it maps the SDK's open error surface onto the closed
// `McpFailure` set below, and it rebuilds the one signal #150 established is
// safe to replay.
//
// **Custody survives adoption, and the argument is one line.** The SDK reaches
// the network only through the `fetch` it is handed, and the one it is handed is
// `createGuardedFetch` from ./outbound.ts — so the credential is still revealed
// in exactly one function, still attached last, and every byte the SDK ever sees
// has already been through the one redaction pass. Nothing here unwraps a
// secret; it is carried as a handle and handed down. The grep test in
// ./outbound.test.ts is what keeps that true.
//
// **What is read off an SDK error, and what is not.** Its class and its numeric
// code, and nothing else — never a message, except on the one path where the
// text is an upstream body this proxy has already scrubbed and the hand-rolled
// client already relayed (`http_error`'s detail). That rule is what makes
// "`connect_failed` carries no upstream bytes" a property of the code rather
// than a hope about the SDK's error-message discipline, and it is why the
// classification functions below take an error and answer a word from a list.
//
// **Four options are inversions of the SDK's defaults**, and each would fail
// quietly if deleted, so each has a test that fails with it:
// `versionNegotiation: { mode: "auto" }` (the SDK defaults to the legacy
// handshake with no probe), `inputRequired: { autoFulfill: false }` (it defaults
// to *on*, which would let an upstream drive elicitation and sampling from
// inside an ordinary `tools/call`), `reconnectionOptions.maxRetries: 0` (it
// defaults to 2), and the absence of an `authProvider` (without one the OAuth
// paths are unreachable rather than merely unused).
//
// **Almost nothing is retried, and the SDK's optimism is switched off
// structurally.** A `tools/call` goes out as a raw `request` rather than
// through `callTool`, so the SDK's header-mismatch recovery — which would
// re-POST an identical `tools/call` and turn one write into two — has no code
// path to run on. The single sanctioned replay is #150's, argued at
// `reopenSession` below.

import { z } from "zod";
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import type { ToolResult } from "@getlibero/schema";
import type { CallLimits } from "./enforce.js";
import {
  type UpstreamToolEntry,
  isInputRequired,
  parseToolsList,
  relayedDetail,
  toolResultText
} from "./mcp-bounds.js";
import {
  type AuthScheme,
  DEFAULT_UPSTREAM_RESPONSE_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_CONTROL_BODY_BYTES,
  SESSION_TERMINATION_TIMEOUT_MS,
  type UpstreamFailure,
  UpstreamError,
  createGuardedFetch
} from "./outbound.js";
import { RedactionError } from "./redact.js";
import type { Secret } from "./vault.js";

/** What this proxy calls itself to an upstream: the product, never the caller. */
const CLIENT_NAME = "libero-proxy";
const CLIENT_VERSION = "0.0.1";

/**
 * The revisions this proxy will agree to speak, newest first.
 *
 * **Passed to the SDK rather than left to its default, and the difference is a
 * transport contract.** The SDK's own list reaches back to `2024-11-05` and
 * `2024-10-07`, whose transport is the two-endpoint HTTP+SSE pair — results
 * arrive on a standalone `GET` stream this proxy answers `405`, because it does
 * not listen. Accepting such a handshake would send a `tools/call` whose answer
 * can never arrive: every call hangs to the timeout and the operator reads
 * "timed out" where the honest word is that the server speaks a version of MCP
 * this proxy does not. The hand-rolled client failed closed on exactly this
 * list; handing it to the SDK is what keeps that a property of the code.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * Which of the two protocol eras a connection settled on.
 *
 * A log field and nothing else — no branch anywhere reads it. It lives here
 * rather than beside the framing it used to describe, because the framing is the
 * SDK's now and this is a word about the answer rather than about the wire.
 */
export type McpDialect = "stateless" | "legacy";

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
  | "unauthorized"
  | "input_required"
  | "closed";

/**
 * What one `tools/call` came to.
 *
 * **`connect_failed` has no `detail` member, by construction.** A failed
 * handshake is as likely to be answered by an auth proxy's error page as by
 * anything MCP, and an error page is where a reflected credential lives. There
 * is no field to put upstream bytes in, so no later edit can put them there.
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
 * What one page of `tools/list` came to.
 *
 * Stricter than `McpOutcome`: **no `detail` on either failure member**, because
 * nothing model-facing reads a listing failure. `status` and `code` stay, since
 * a protocol number is not upstream-authored text.
 */
export type McpListOutcome =
  | { readonly outcome: "listed"; readonly tools: readonly UpstreamToolEntry[]; readonly nextCursor: string | null }
  | { readonly outcome: "connect_failed"; readonly failure: McpFailure }
  | { readonly outcome: "call_failed"; readonly failure: McpFailure; readonly status?: number; readonly code?: number };

export interface McpClient {
  callTool(tool: string, args: Readonly<Record<string, unknown>>, limits: CallLimits): Promise<McpOutcome>;
  listTools(cursor: string | undefined, timeoutMs: number | undefined): Promise<McpListOutcome>;
  /** The era this connection settled on, or `undefined` before it has. */
  readonly protocol: McpDialect | undefined;
  close(): Promise<void>;
}

export interface McpClientOptions {
  readonly url: string;
  readonly scheme: AuthScheme;
  readonly secret: Secret | undefined;
  readonly credentialName?: string;
  readonly timeoutMs?: number;
  /**
   * How many bytes of a response to hold. The deployment's
   * (`PROXY_MAX_RESPONSE_BYTES`), so it is the same number for every channel —
   * a per-channel bound could not be configured here, because two channels share
   * a pooled client. The channel's own bound on a *result* travels per call on
   * `CallLimits`.
   */
  readonly maxResponseBytes?: number;
  /** Injected transport, for tests. Reaches the network by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One page of a catalog, vouched for only as an envelope.
 *
 * **Deliberately not the SDK's own `tools/list` schema, and this is the one
 * place the proxy declines to reuse a parse it is offered.** The SDK validates
 * the page against the specification's shape, so one entry whose `name` is a
 * number fails the *whole page* — which would hand any sloppy or hostile
 * upstream a way to blank the catalog of every tool beside it. `parseToolsList`
 * exists to skip an unreadable entry and keep the page, and this schema is what
 * lets it: vouch for the envelope, leave the entries alone.
 */
const CatalogPage = z.looseObject({
  tools: z.array(z.unknown()),
  // An unknown rather than an optional *string*, for the envelope's own
  // reason: serializers that spell an absent field `null` are commonplace, and
  // a page refused over its cursor blanks the catalog as surely as one refused
  // over an entry. `parseToolsList` reads the cursor and treats anything but a
  // non-empty string as end-of-pagination, which is what the hand-rolled
  // client always did. The `.optional()` is still load-bearing: it frees the
  // *key*, which zod requires present even on an unknown-typed field.
  nextCursor: z.unknown().optional()
});

/**
 * A `tools/call` result, vouched for not at all.
 *
 * CatalogPage's argument, one layer down. Passing no schema would have the SDK
 * validate the result against the specification's own `CallToolResult`, whose
 * content union is closed — one block of a type outside the negotiated
 * revision fails the entire call, deleting `blockText`'s placeholder branch,
 * which exists precisely so a forward-revision block beside ordinary text
 * costs a placeholder rather than the answer. `toolResultText` is the reader
 * and answers `null` for a shape it cannot hold, so nothing is vouched for
 * twice. (On the modern era the SDK validates against the specification before
 * any caller schema — the same narrowing `mcp-catalog.test.ts` pins for a
 * listing page.)
 */
const CallEnvelope = z.looseObject({});

/** Whether this is, or wraps, a redaction failure. Fail-closed, so it is checked first. */
function redactionFailure(error: unknown): RedactionError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof RedactionError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The `UpstreamError` a guarded fetch threw, if this is one.
 *
 * The SDK propagates a `fetch` rejection unwrapped, so depth zero is the answer
 * in practice; the walk is there because "in practice" is not a contract, and
 * the cost of missing one is a `too_large` or a refused destination reported as
 * `unreachable` — a wrong word in a log line about a refusal. Nothing is read
 * off any link but our own class and its `failure`, which is a member of a
 * closed set; `UpstreamError` still carries no `cause` of its own.
 */
function upstreamFailure(error: unknown): UpstreamFailure | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof UpstreamError) return current.failure;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The SDK error's code, or `null` for anything that is not one. */
function sdkCode(error: unknown): SdkErrorCode | null {
  return error instanceof SdkError ? error.code : null;
}

/**
 * Why a handshake did not settle.
 *
 * **`unauthorized` exists because `connect_failed` has no `status` field.** The
 * SDK makes a 401 or 403 on the version probe fatal rather than falling back to
 * the legacy handshake, which is a behaviour change worth reporting accurately:
 * the old ladder reached `unsupported_protocol` here, and "does not speak a
 * version of MCP this proxy supports" is actively misleading for what is nearly
 * always a wrong or expired credential. A status code is a protocol number
 * rather than upstream-authored text, so distinguishing on one relays nothing.
 */
function connectFailure(error: unknown, refused: UpstreamFailure | undefined): McpFailure {
  const upstream = upstreamFailure(error) ?? refused;
  if (upstream !== undefined && upstream !== null) return upstream;

  const code = sdkCode(error);
  if (code === SdkErrorCode.ClientHttpAuthentication || code === SdkErrorCode.ClientHttpForbidden) {
    return "unauthorized";
  }
  if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) return "unauthorized";
  if (code === SdkErrorCode.RequestTimeout) return "timed_out";
  if (code === SdkErrorCode.ConnectionClosed || code === SdkErrorCode.NotConnected) return "unreachable";

  // Everything else that answered and could not agree: a probe the server
  // refused for a reason we do not speak, a version with no overlap, a legacy
  // `initialize` that came back non-2xx. The old ladder reported all of these as
  // `unsupported_protocol` too, so the sentence a model reads is unchanged.
  return "unsupported_protocol";
}

/** Why a call did not answer, and whatever of it is safe to carry. */
function callFailure(error: unknown): {
  readonly failure: McpFailure;
  readonly status?: number;
  readonly code?: number;
  readonly detail?: string;
} {
  const upstream = upstreamFailure(error);
  if (upstream !== null) return { failure: upstream };

  const code = sdkCode(error);
  // The shape `inputRequired: { autoFulfill: false }` produces. An upstream
  // asking for more input is asking the proxy to speak for a channel — to answer
  // a sampling request out of its model budget, or an elicitation nobody was
  // asked. There is no sheet entry and no click behind either, so the answer is
  // no, and there is no retry, since retrying is how the round trip completes.
  if (code === SdkErrorCode.UnsupportedResultType) return { failure: "input_required" };
  if (code === SdkErrorCode.RequestTimeout) return { failure: "timed_out" };
  if (code === SdkErrorCode.ConnectionClosed || code === SdkErrorCode.NotConnected) return { failure: "unreachable" };

  if (error instanceof SdkHttpError) {
    // The one place a string is read off an SDK error, and it is safe for the
    // reason the hand-rolled client relayed the same bytes: the body reached
    // this process through `callUpstream`, which scrubbed it before the SDK ever
    // saw it. Bounded because it is upstream-authored.
    return { failure: "http_error", status: error.status, detail: relayedDetail(error.message) };
  }
  if (error instanceof ProtocolError) {
    return { failure: "rpc_error", code: error.code, detail: relayedDetail(error.message) };
  }

  // Including `InvalidResult`: an answer this proxy could not read as MCP. No
  // detail — the SDK's is a zod issue list, which embeds the offending upstream
  // values, and `failureText` ignores this member's detail anyway.
  return { failure: "protocol_error" };
}

/**
 * A 404 answering a request that carried a session id, and nothing else.
 *
 * A 404 from a client carrying no session is a wrong url, and reconnecting would
 * double every call made against a typo.
 */
function sessionLost(error: unknown, carriedSessionId: string | undefined): boolean {
  if (carriedSessionId === undefined) return false;
  return error instanceof SdkHttpError && error.status === 404;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  type Session = {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport;
    /** Where this connection's guarded fetch leaves what the SDK swallowed. */
    readonly sink: FailureSink;
    readonly generation: number;
  };
  type Opened = { readonly ok: true; readonly session: Session } | { readonly ok: false; readonly failure: McpFailure };

  let session: Session | undefined;
  let opening: Promise<Opened> | undefined;
  let reopening: Promise<Opened> | undefined;
  let generations = 0;
  let closed = false;

  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  /**
   * Where the guarded fetch leaves the reason it refused, for the connect path.
   *
   * **A `callTool` rejection carries our `UpstreamError` unwrapped, and a
   * `connect` rejection does not.** The SDK's version-probe classifier converts
   * anything that went wrong on the wire into its own era-negotiation error, so
   * by the time it reaches us the fact that the host was unreachable, the answer
   * oversized or the destination refused has been flattened into "could not
   * agree on a version" — three different sentences for an operator collapsed
   * into a wrong one.
   *
   * So the fetch records what it threw where the connect path can read it. A
   * plain holder rather than anything cleverer because the lifetime is exactly
   * one `connect`, and `connect` is single-flighted through `opening` and
   * `reopening`: there is never a second one racing it on this client.
   *
   * **`redaction` is the same problem with a sharper edge**, and it is why the
   * holder outlives the handshake. A `RedactionError` means this proxy could not
   * establish that a response is free of the credential, and the only safe
   * answer is to serve nothing — the server's handler catch turns it into a
   * constant 500. If the SDK swallows it the way it swallows a transport
   * failure, that fail-closed path silently becomes a cheerful `isError` result,
   * which is the one degradation this file must not allow. Every catch below
   * therefore consults the holder as well as the thrown value.
   *
   * It is read and cleared, so one failure fails one call rather than poisoning
   * the client. Under concurrency the attribution may land on a sibling — which
   * is the fail-closed direction, and a redaction failure is a fault about the
   * process rather than about one call.
   */
  type FailureSink = {
    failure?: UpstreamFailure;
    redaction: RedactionError | undefined;
    /**
     * Whether this connection is still handshaking.
     *
     * What restores `MAX_CONTROL_BODY_BYTES`. The hand-rolled client chose that
     * bound per call site — the probe, the legacy `initialize`, its
     * acknowledgement and the termination `DELETE` — and a `fetch` has no call
     * sites to choose at. The phase does the choosing instead: a connection is
     * control-plane until `connect` returns, and every request after that is a
     * call and gets the deployment's bound. The termination `DELETE` is *not*
     * this flag flipped back on — it is bounded by its verb in `build` below,
     * because the flag is shared with every in-flight call on the session, and
     * flipping it during `close()` would retroactively cut a legitimate
     * response off mid-read as `too_large`.
     */
    controlPlane: boolean;
  };

  /** A transport and a client, custody-configured. Neither has spoken yet. */
  const build = (sink: FailureSink): { client: Client; transport: StreamableHTTPClientTransport } => {
    const guarded = createGuardedFetch({
        url: options.url,
        scheme: options.scheme,
        secret: options.secret,
        ...(options.credentialName !== undefined ? { credentialName: options.credentialName } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      // A `DELETE` is control-plane by verb — session termination is the only
      // one ever sent, and nobody reads its answer — so the phase flag need
      // never flip back on for shutdown.
      maxBodyBytes: method =>
        method === "DELETE" || sink.controlPlane
          ? MAX_CONTROL_BODY_BYTES
          : (options.maxResponseBytes ?? DEFAULT_UPSTREAM_RESPONSE_BYTES),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });

    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      fetch: async (url, init) => {
        try {
          return await guarded(url, init);
        } catch (error) {
          const failure = upstreamFailure(error);
          if (failure !== null) sink.failure = failure;
          const redaction = redactionFailure(error);
          if (redaction !== null) sink.redaction = redaction;
          throw error;
        }
      },
      // The SDK reconnects a dropped event stream twice by default. A replayed
      // `tools/call` is how one write becomes two, and `2026-07-28` removed
      // stream resumability, so there is nothing to resume toward.
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1
      }
    });

    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      {
        // The SDK defaults to the legacy handshake with no probe. `auto` is the
        // ladder #150 established: `server/discover` first, the legacy
        // `initialize` when the server answers a refusal.
        versionNegotiation: { mode: "auto" },
        // Defaults to *on*. With it on, an upstream answering `input_required`
        // would have its embedded requests dispatched to registered handlers and
        // the call retried — an upstream driving the client. Off, it raises, and
        // `callFailure` turns that into the refusal.
        inputRequired: { autoFulfill: false },
        // The SDK's default list reaches back to the HTTP+SSE revisions this
        // proxy fails closed on — the argument is the constant's, above.
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        // Empty rather than absent: this client offers no sampling, no
        // elicitation and no roots, and nothing below registers a handler for
        // any of them.
        capabilities: {}
      }
    );
    return { client, transport };
  };

  /** Connect, adopting a known era when there is one. Closes the client on failure. */
  const connect = async (prior: "legacy" | undefined): Promise<Opened> => {
    const sink: FailureSink = { redaction: undefined, controlPlane: true };
    const { client, transport } = build(sink);
    try {
      await client.connect(transport, {
        timeout: timeoutMs,
        ...(prior !== undefined ? { prior: { kind: prior } } : {})
      });
    } catch (error) {
      const redaction = redactionFailure(error) ?? sink.redaction;
      if (redaction !== null && redaction !== undefined) throw redaction;
      await client.close().catch(() => undefined);
      return { ok: false, failure: connectFailure(error, sink.failure) };
    }
    // The handshake is over, so responses stop being control-plane sized.
    sink.controlPlane = false;
    return { ok: true, session: { client, transport, sink, generation: ++generations } };
  };

  /**
   * The connection, opened once.
   *
   * Success is cached and failure is not — `opening` is cleared in a `finally`,
   * so a rejection is not memoised and the next caller may try again.
   */
  const ensureOpen = async (): Promise<Opened> => {
    if (session !== undefined) return { ok: true, session };
    if (closed) return { ok: false, failure: "closed" };
    // A reopen in flight *is* the connection being opened. Without this check a
    // fresh call arriving while `reopenSession` has cleared `session` would
    // start a second full ladder — a `server/discover` probe against a server
    // already known to be legacy — racing the reopen's handshake, with the
    // loser's session dropped unterminated at the upstream.
    if (reopening !== undefined) return reopening;
    if (opening === undefined) {
      opening = connect(undefined).finally(() => {
        opening = undefined;
      });
    }
    const result = await opening;
    if (result.ok) session = result.session;
    return result;
  };

  /**
   * Reopen after the server forgot the session, at most once per loss.
   *
   * **Two mechanisms for two races.** The generation check answers the straggler
   * — a call that lost a session another call has already replaced gets the live
   * connection rather than opening a third. The single flight answers the
   * simultaneous case, so N concurrent losses cost one handshake rather than N.
   *
   * **It adopts the legacy era rather than re-probing.** Re-running the ladder
   * on a session loss would be a second `server/discover` against a server that
   * has already answered one; `prior` is the SDK's cached-verdict path and costs
   * exactly `initialize` plus its acknowledgement, which is what the hand-rolled
   * client did here. A session only exists on the legacy era, so the era is
   * known by the fact that there was one to lose.
   */
  const reopenSession = async (used: number): Promise<Opened> => {
    if (closed) return { ok: false, failure: "closed" };
    const current = session;
    if (current !== undefined && current.generation !== used) return { ok: true, session: current };

    if (reopening === undefined) {
      // **The stale client is dropped, never closed**, and that is a
      // correctness requirement rather than laziness. The losers of a session
      // arrive here one at a time: the first call to read its 404 starts the
      // reopen while its siblings are still reading *their* 404s on the same
      // client. `close()` aborts that client's in-flight requests, so closing
      // here would kill the very answers that were about to identify them as
      // session losses too — they would surface as transport failures instead,
      // never reach this function, and never be retried. Three concurrent
      // losers would come back as one result and two errors.
      //
      // Dropping it holds nothing open: every request is its own fetch, the
      // standalone listen stream is refused by the guarded fetch, and
      // `maxRetries: 0` leaves no reconnection timer. There is no `DELETE`
      // either — the server has already forgotten the session, which is what a
      // 404 meant.
      session = undefined;
      reopening = connect("legacy").finally(() => {
        reopening = undefined;
      });
    }
    const result = await reopening;
    if (result.ok) session = result.session;
    return result;
  };

  type Attempt<Outcome> =
    | { readonly kind: "answered"; readonly outcome: Outcome }
    | { readonly kind: "session_lost"; readonly generation: number; readonly outcome: Outcome };

  const attempt = async (
    at: Session,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    limits: CallLimits
  ): Promise<Attempt<McpOutcome>> => {
    // Read before the call, so the replay discriminator is what this request
    // actually carried rather than what the transport holds afterwards.
    const carried = at.transport.sessionId;
    try {
      // `request` rather than `callTool`, and both halves of that are wanted.
      // `callTool` validates the result against the specification's closed
      // content union — see `CallEnvelope` — and it is also where the SDK's
      // header-mismatch recovery lives, the one that re-fetches the catalog and
      // re-POSTs an identical `tools/call`. That recovery is one write becoming
      // two, and it is safe only if the upstream rejected before dispatching,
      // which is trust this proxy does not extend. On this path it is
      // structurally absent rather than disabled by a decoy definition.
      const result = await at.client.request(
        { method: "tools/call", params: { name: tool, arguments: { ...args } } },
        CallEnvelope,
        { timeout: timeoutMs }
      );

      const record = result as unknown as Record<string, unknown>;
      // Belt and braces beside `autoFulfill: false`. The refusal is a security
      // property, so it is held by a read of the bytes as well as by a flag.
      if (isInputRequired(record)) {
        return { kind: "answered", outcome: { outcome: "call_failed", failure: "input_required" } };
      }

      const mapped = toolResultText(record, limits.maxResultChars);
      if (mapped === null) {
        return {
          kind: "answered",
          outcome: { outcome: "call_failed", failure: "protocol_error", detail: "bad_result" }
        };
      }
      return { kind: "answered", outcome: { outcome: "called", result: mapped } };
    } catch (error) {
      const redaction = redactionFailure(error) ?? at.sink.redaction;
      at.sink.redaction = undefined;
      if (redaction !== null && redaction !== undefined) throw redaction;
      const outcome: McpOutcome = { outcome: "call_failed", ...callFailure(error) };
      if (sessionLost(error, carried)) return { kind: "session_lost", generation: at.generation, outcome };
      return { kind: "answered", outcome };
    }
  };

  const attemptList = async (
    at: Session,
    cursor: string | undefined,
    perCallTimeoutMs: number | undefined
  ): Promise<Attempt<McpListOutcome>> => {
    const carried = at.transport.sessionId;
    try {
      const page = await at.client.request(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        CatalogPage,
        { timeout: perCallTimeoutMs ?? timeoutMs }
      );
      const parsed = parseToolsList(page as Record<string, unknown>);
      if (parsed === null) {
        return { kind: "answered", outcome: { outcome: "call_failed", failure: "protocol_error" } };
      }
      return {
        kind: "answered",
        outcome: { outcome: "listed", tools: parsed.tools, nextCursor: parsed.nextCursor }
      };
    } catch (error) {
      const redaction = redactionFailure(error) ?? at.sink.redaction;
      at.sink.redaction = undefined;
      if (redaction !== null && redaction !== undefined) throw redaction;
      const { failure, status, code } = callFailure(error);
      // No `detail`: nothing model-facing reads a listing failure.
      const outcome: McpListOutcome = {
        outcome: "call_failed",
        failure,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {})
      };
      if (sessionLost(error, carried)) return { kind: "session_lost", generation: at.generation, outcome };
      return { kind: "answered", outcome };
    }
  };

  return {
    async callTool(tool, args, limits) {
      const ready = await ensureOpen();
      if (!ready.ok) return { outcome: "connect_failed", failure: ready.failure };

      // Two statements, no counter and no loop: the structure is what bounds the
      // replay at one.
      const first = await attempt(ready.session, tool, args, limits);
      if (first.kind === "answered") return first.outcome;

      const reopened = await reopenSession(first.generation);
      if (!reopened.ok) return { outcome: "call_failed", failure: reopened.failure };
      return (await attempt(reopened.session, tool, args, limits)).outcome;
    },

    async listTools(cursor, perCallTimeoutMs) {
      const ready = await ensureOpen();
      if (!ready.ok) return { outcome: "connect_failed", failure: ready.failure };

      const first = await attemptList(ready.session, cursor, perCallTimeoutMs);
      if (first.kind === "answered") return first.outcome;

      const reopened = await reopenSession(first.generation);
      if (!reopened.ok) return { outcome: "call_failed", failure: reopened.failure };
      return (await attemptList(reopened.session, cursor, perCallTimeoutMs)).outcome;
    },

    get protocol() {
      if (session === undefined) return undefined;
      return session.client.getProtocolEra() === "modern" ? "stateless" : "legacy";
    },

    /**
     * Terminate the session, then the client.
     *
     * State flips before the first await, so a call arriving mid-shutdown is
     * refused rather than reopening a session the process is discarding.
     *
     * The `DELETE` is raced against `SESSION_TERMINATION_TIMEOUT_MS` rather than
     * given its own transport, because a transport's timeout is fixed when it is
     * built and this one runs inside a signal handler: Docker sends SIGKILL ten
     * seconds after SIGTERM, and a thirty-second courtesy to a wedged upstream
     * would mean the budget and audit databases never got their close.
     *
     * Every failure is swallowed, including a `RedactionError` — the one place
     * in this package where that is right, because nothing reads the response.
     */
    async close() {
      const at = session;
      closed = true;
      session = undefined;
      if (at === undefined) return;

      // The `DELETE`'s control-plane bound is chosen by its verb in `build`,
      // not by a flip here: the sink is shared with any call still in flight,
      // and rebounding one mid-read would cut a legitimate answer off as
      // `too_large` for no reason the log names.
      if (at.transport.sessionId !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bounded = new Promise<void>(resolve => {
          timer = setTimeout(resolve, SESSION_TERMINATION_TIMEOUT_MS);
          timer.unref?.();
        });
        try {
          await Promise.race([at.transport.terminateSession().catch(() => undefined), bounded]);
        } finally {
          clearTimeout(timer);
        }
      }
      await at.client.close().catch(() => undefined);
    }
  };
}
