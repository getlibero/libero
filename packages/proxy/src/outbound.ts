// The outbound call: where a credential stops being a name and becomes a header.
//
// This is the one file in the tree that takes a secret out of either store.
// Every other module moves credentials as `Secret` handles or as names, and the
// whole design of ./vault.ts — no `get`, no iteration, `toString` and `toJSON`
// fixed at `[redacted]` — exists so that this is true and so that checking it
// is one grep. Two `reveal()` sites live here, each deliberate, and a third
// appearing anywhere is the thing a reviewer should stop:
//
// - `callUpstreamStream` spends a credential on an upstream call and scrubs the
//   reply as it arrives. `callUpstream` is that function read to completion, so
//   the two are one site rather than two.
// - `exchangeRefreshToken` spends a refresh token at the issuer its record
//   binds, and returns the reply to no caller at all — the reply *is* the
//   credential, wrapped into a `Secret` before it leaves.
//
// `exchangeAuthorizationCode` is a third exchange but deliberately not a third
// site: its inputs (the code, the PKCE verifier) are plaintext locals that
// never lived in a store, and its output is plaintext headed for the token
// store's write path, which takes plaintext by design. Nothing there has a
// `Secret` to open, so "two `reveal()` sites" stays true verbatim.
//
// Nothing third-party, per the rule at the top of ./server.ts. The transport is
// Node's built-in `fetch`, injected so tests never open a socket they did not
// stand up themselves — the same shape `packages/agent/src/completion/*.ts`
// uses for provider clients.
//
// **The secret does not come back, either.** The response is redacted before it
// reaches a caller, and the reason that is sufficient rather than merely helpful
// is structural: a credential value can only appear in a
// response if it was sent in a request, the only place a credential is revealed
// and sent is this file, so scrubbing here covers every path by which a
// stored secret can be echoed back. That is why redaction lives at this level
// and not in a dispatcher — `ToolDispatcher` is an injected interface, so a
// pass inside one implementation would leave #39's client pool and every test
// double uncovered, and it would need a second `reveal()` to do it.
//
// Since #156 the body is scrubbed chunk by chunk rather than in one pass over a
// finished string, and the sentence above survives that intact — `redact.ts`'s
// `StreamingRedactor` holds back the tail a match could still be completed from,
// so a needle split across two of an upstream's TCP writes is still caught. That
// is argued where it is implemented; what matters here is that no byte reaches a
// caller without having been through it.
//
// The same argument is why `credentialHeader` and `injectCredential` are not
// exported from the package index: `callUpstream` and the guarded fetch built on
// it are the only exported ways to send a credential, and both redact what comes
// back.
//
// **What this file does not do.** It does not check the egress allowlist, and
// that is not an omission. `[egress]` governs destinations the sheet does not
// pin; the url below comes from an `[[mcp_server]]` block, which is where an
// admin authorized it. See the header of packages/schema/src/egress.ts for why
// merging the two lists would widen both. What this file does own is the one
// destination nothing declared — a redirect target — and it refuses to follow.

import { type RedactionPass, StreamingRedactor, applyPasses, redactionPasses } from "./redact.js";
import { makeSecret } from "./vault.js";
import type { Secret } from "./vault.js";

/**
 * How the credential is attached.
 *
 * An enum rather than a bare boolean because the shape of the question is
 * "which scheme", and the destination decides. Call sites name the scheme
 * explicitly, so adding a member is a compile error at each site rather than a
 * silently changed default.
 *
 * `bearer` is a service token an operator wrote into the vault. `oauth` (#255)
 * is an access token the proxy mints from stored grant material — same header
 * on the wire, different provenance, and which store the credential name
 * resolves in is the scheme's decision, never a fallback. See "Two credential
 * stores" in the package README.
 */
export type AuthScheme = "bearer" | "oauth";

/**
 * Where a request's credential comes from, asked per request.
 *
 * The pool keys one client per upstream and keeps it for the process's life,
 * and until #256 that client captured a `Secret` at construction — correct for
 * a vault value, whose name names one immutable entry, and wrong for a minted
 * token, which expires mid-lifetime of the client holding it. This seam is the
 * repair: the client captures the *source*, which is stable per key, and asks
 * it before each request. What the token behind it is doing — living in
 * memory, refreshing, rotating — is the source's business.
 *
 * `acquire` is async because for an OAuth source it may be a mint: a
 * token-endpoint round trip. It resolves *before* header assembly, which is
 * what keeps `callUpstream`'s reveal synchronous and single.
 *
 * `refresh` is the 401 path: the upstream rejected the credential of
 * generation `rejected`. A successor means "retry once with this"; `null`
 * means the 401 stands — which is every bearer source, where the value cannot
 * be freshened by asking again. The generation is what keeps a straggler from
 * forcing a second refresh when its rejection was already answered by one:
 * a source holding generation n+1 hands it back rather than minting n+2.
 */
export interface CredentialSource {
  readonly scheme: AuthScheme;
  /** The credential's team-sheet name, for the redaction marker. */
  readonly name?: string;
  acquire(): Promise<{ secret: Secret; generation: number } | undefined>;
  refresh(rejected: number): Promise<{ secret: Secret; generation: number } | null>;
}

/**
 * The vault's form: one value for the client's life, nothing to refresh.
 *
 * `undefined` in, `undefined` out of `acquire` — "this upstream needs no
 * credential" stays the ordinary case it has always been, one source shape
 * rather than a second path.
 */
export function constantCredential(
  scheme: AuthScheme,
  secret: Secret | undefined,
  name?: string
): CredentialSource {
  return {
    scheme,
    ...(name !== undefined ? { name } : {}),
    acquire: () => Promise.resolve(secret === undefined ? undefined : { secret, generation: 0 }),
    refresh: () => Promise.resolve(null)
  };
}

/**
 * The verbs this function will send.
 *
 * A closed union rather than a string, for the reason `AuthScheme` is one: this
 * is the function that attaches a credential, so what it can do is chosen from
 * a list and adding a member is a decision. Both members take the identical
 * path below — the same redirect refusal, the same timeout, the same single
 * redaction pass on the way out. The only branch on this value in the whole
 * function is whether a body is written.
 */
export type UpstreamMethod = "POST" | "DELETE";

/** How long the proxy waits on an upstream before giving up. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * How many bytes of a response body the proxy will hold, when nothing says
 * otherwise.
 *
 * The sibling of the timeout above, and it exists for the same reason: an
 * upstream that answers forever and an upstream that answers enormously are the
 * same failure wearing different clothes, and neither is bounded by anything
 * else on this path. Until this landed, the body was read to completion with no
 * bound at all — so a fifty-megabyte answer was buffered, scanned fifteen times,
 * parsed, and handed to a model that spent a channel's whole task budget reading
 * it. Since #156 the count is kept as the body streams, which is where the
 * refusal now happens; the number and its argument are unchanged.
 *
 * **Four megabytes, and deliberately not `MAX_BODY_BYTES`'s one.** That number
 * bounds an *inbound* request, which is one tool call's arguments; this bounds
 * an outbound response, which since #129 may be a `tools/list` catalog — a
 * hundred tools carrying full JSON Schema is half a megabyte before anything
 * exotic happens. Four leaves room for that and still refuses to hold a file
 * transfer.
 *
 * **The real cost is a multiple of this number per concurrent call**, and an
 * operator changing it should know that. #156 took one term out of it: the body
 * is no longer held as a decoded string while it is scanned, so the redaction
 * peak is now one chunk plus a held-back tail rather than the whole body plus a
 * copy per needle matched. What remains is the SDK's own buffer and the object
 * graph `JSON.parse` builds beside it, which still scale with the response. The
 * cap is on the bytes off the wire because that is the quantity this code can
 * actually refuse, not because it is the whole bill.
 *
 * A default rather than a constant: `PROXY_MAX_RESPONSE_BYTES` overrides it, for
 * the reason argued on `maxBodyBytes` below.
 */
export const DEFAULT_UPSTREAM_RESPONSE_BYTES = 4_194_304;

/**
 * How many calls the proxy will run against one upstream at once.
 *
 * The third of these bounds and the one that makes the other two add up. The
 * timeout says how long a single call may hold a socket and the cap above says
 * how much heap it may hold while it does — but until this landed there was no
 * bound on *how many* held either at the same time, so the worst case an
 * operator could compute against one black-holing upstream was thirty seconds
 * times four megabytes times an unbounded count. This is the missing factor.
 *
 * **Eight, and the number is a guess about upstreams rather than about this
 * process.** It is high enough that no ordinary deployment reaches it — a task's
 * tool calls run one at a time, so the ceiling is roughly how many channels are
 * mid-task at once — and low enough that a single busy channel cannot spend a
 * shared upstream's rate limit on behalf of every other channel naming it. An
 * operator who knows their upstream's actual limit should set
 * `PROXY_MAX_UPSTREAM_CONCURRENCY`; this is what to do when nobody has said.
 *
 * A default rather than a constant, on `DEFAULT_UPSTREAM_RESPONSE_BYTES`'s
 * argument: what one upstream tolerates is a deployment fact this repo cannot
 * know. No ceiling, for its reason too — capping the principal who owns the
 * heap would be advice rather than a boundary.
 */
export const DEFAULT_UPSTREAM_CONCURRENCY = 8;

/**
 * How much of a control-plane answer the proxy will read.
 *
 * The version probe, the legacy `initialize` handshake, its acknowledgement, and
 * the session-termination `DELETE`. A fixed constant rather than the configured
 * cap, on `SESSION_TERMINATION_TIMEOUT_MS`'s argument: these are not a
 * deployment's business, because nothing about them scales with what an
 * operator's upstreams return. A `server/discover` result is a list of protocol
 * revisions and an `initialize` result is a capabilities object; both are
 * kilobytes by construction, and a `DELETE`'s answer is read by nobody at all.
 *
 * Sixty-four kilobytes is far above any of them and far below the tool-result
 * cap, which is the point: a server answering the *handshake* with megabytes has
 * shown it is not speaking MCP, and `McpOutcome.connect_failed` structurally has
 * no `detail` field to relay a word of it. Cutting that off early costs nothing
 * that could have been used.
 */
export const MAX_CONTROL_BODY_BYTES = 65_536;

/**
 * How long a session-termination `DELETE` gets.
 *
 * Two seconds rather than `DEFAULT_UPSTREAM_TIMEOUT_MS`, because this one runs
 * inside a signal handler: Docker sends SIGKILL ten seconds after SIGTERM by
 * default, and a thirty-second courtesy `DELETE` to a wedged upstream would
 * mean the budget and audit databases never got their close. Every termination
 * runs concurrently, so this is the cost of the whole pass rather than the cost
 * per upstream.
 */
export const SESSION_TERMINATION_TIMEOUT_MS = 2_000;

/**
 * The statuses that mean "go somewhere else", which the proxy will not do.
 *
 * Enumerated rather than tested as a 3xx range so that 304 — not a redirect —
 * is not swept in with them.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The header name and value a scheme produces.
 *
 * Takes the already-revealed value rather than the `Secret`. The single
 * `reveal()` moved up into `callUpstream` when redaction landed, because the
 * same value is needed twice — once to attach to the request and once to scan
 * the response for — and revealing it twice would put a second call site in the
 * tree, which is the thing the grep test forbids.
 */
export function credentialHeader(scheme: AuthScheme, value: string): readonly [string, string] {
  switch (scheme) {
    case "bearer":
      return ["authorization", `Bearer ${value}`];
    // A minted access token is a bearer token on the wire (OAuth 2.1's own
    // framing). What differs is the value's provenance — the token store, not
    // the vault — and provenance is not this function's business.
    case "oauth":
      return ["authorization", `Bearer ${value}`];
  }
}

/**
 * Put the credential on the request headers.
 *
 * Returns a fresh object rather than mutating the caller's: a headers map that
 * has been through here holds a secret, and one that is shared or reused is a
 * secret that outlives the request. The caller passes this straight to `fetch`
 * and drops it.
 *
 * A `string | undefined` rather than two functions, because "this upstream
 * needs no credential" is an ordinary case — an MCP server on the private
 * network may want none — and making it a separate path is how the no-auth
 * branch stops being tested.
 */
export function injectCredential(
  headers: Readonly<Record<string, string>>,
  scheme: AuthScheme,
  value: string | undefined
): Record<string, string> {
  if (value === undefined) return { ...headers };
  const [header, headerValue] = credentialHeader(scheme, value);
  return { ...headers, [header]: headerValue };
}

/**
 * Why an outbound call produced no response.
 *
 * A closed set, like `VaultFailure`, and for the same reason: this is the path
 * that holds a secret, so the failure a caller reports has to be something the
 * caller chose from a list rather than a string that came back from the stack.
 */
export type UpstreamFailure = "timed_out" | "unreachable" | "redirected" | "too_large";

/**
 * An outbound call that did not complete.
 *
 * **No `cause`, deliberately.** A `TypeError` out of `fetch` or undici can carry
 * the request in it, and the request is where the credential is — `util.inspect`
 * on an error chain is how that reaches a log line. The original is read for a
 * reason and then dropped, exactly as `VaultError` does at ./vault.ts.
 */
export class UpstreamError extends Error {
  readonly failure: UpstreamFailure;

  constructor(failure: UpstreamFailure) {
    super(`proxy upstream: ${failure}`);
    this.name = "UpstreamError";
    this.failure = failure;
  }
}

/**
 * The response headers a caller may read.
 *
 * An allowlist rather than a passthrough. Every header returned is a surface an
 * upstream can echo into — a debug proxy reflecting `Authorization` into a
 * response header is not exotic — so the set is small enough to read, and every
 * member goes through the same redaction pass as the body. Adding one is a
 * decision, not a convenience.
 *
 * `content-type` is here because the MCP client has to know whether a body is
 * JSON or an event stream before it can frame it, and guessing from the bytes
 * is how a parser gets confused deliberately.
 *
 * `mcp-session-id` is here because the legacy MCP handshake has nowhere else to
 * learn it: a server assigns the session on the `initialize` response and in
 * that header alone, so a client that cannot read it cannot make a second
 * request to that server at all. It earns the entry on `content-type`'s terms —
 * read by the transport and by nothing above it, never logged, never put in a
 * result, never compared against anything.
 *
 * **Widening this list is safe here for a structural reason worth saying out
 * loud rather than inferring:** every member goes through the same `scrub` as
 * the body before the one return below. A server that answered with the
 * credential *as* its session id hands back a redaction marker; the proxy then
 * replays a marker, the server refuses it, and the call fails — which is the
 * right outcome, and none of it is the value.
 */
const READABLE_RESPONSE_HEADERS = ["content-type", "mcp-session-id"] as const;

export interface UpstreamRequest {
  /** Absolute URL of the upstream. Comes from the team sheet, never the model. */
  readonly url: string;
  /**
   * The verb. Absent means `POST`, which is every MCP request. `DELETE` is the
   * legacy session termination, and is the only thing here that carries no
   * body.
   *
   * Optional-with-a-default rather than required, unlike `scheme`: that one is
   * explicit at every call site because attaching a credential one way or
   * another is a security-relevant choice, and a verb is not.
   */
  readonly method?: UpstreamMethod;
  /**
   * The request body, already serialized. Absent only for a `DELETE`.
   *
   * A string rather than a value this function stringifies, since #188: the one
   * caller is `createGuardedFetch` below, which is handed a body the MCP SDK has
   * already framed. Serializing here as well would double-encode it, and a
   * function that both accepts bytes and invents them is a function with two
   * contracts.
   */
  readonly body?: string;
  /**
   * Extra request headers, lowercase-named. Merged over the defaults and *under*
   * the credential, so nothing here can displace or forge the authorization
   * header — and `authorization` itself is dropped from this map before the
   * merge. The only way to authenticate an outbound call is `scheme` + `secret`,
   * because that is the path that also redacts the reply; a second way to set
   * the header would be a second way to send a credential without scrubbing
   * what comes back.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly scheme: AuthScheme;
  /** Resolved from the vault by the caller. `undefined` for an unauthenticated upstream. */
  readonly secret: Secret | undefined;
  /**
   * The credential's team-sheet name, for the redaction marker. Required
   * whenever `secret` is set — a response scrubbed of a value has to say which
   * credential it was, and `[redacted:undefined]` is not an answer.
   */
  readonly credentialName?: string;
  readonly timeoutMs?: number;
  /**
   * The caller's abort, joined with the timeout rather than replacing it. The
   * MCP SDK cancels through the signal it hands its `fetch` — its per-request
   * timeout, `transport.close()`, a session termination racing shutdown — and
   * dropping it here would leave every such abort a bookkeeping fiction: the
   * caller's promise settles while the socket runs on to the full timeout,
   * holding the event loop open past the window a `docker stop` allows.
   */
  readonly signal?: AbortSignal;
  /**
   * How many bytes of the response body to hold before abandoning it. Absent
   * means `DEFAULT_UPSTREAM_RESPONSE_BYTES`.
   *
   * Optional-with-a-default like `timeoutMs`, and settled by the same principal
   * for the same reason. Which upstreams a channel may call is the team sheet's
   * business; how much memory this process will spend on one of their answers is
   * not — the heap is shared by every channel the proxy serves, so a sheet able
   * to raise this would be one channel degrading service for all of them. It is
   * a deployment setting (`PROXY_MAX_RESPONSE_BYTES`) rather than a constant
   * because the operator who sized the container is the one who should say how
   * much of it a response may occupy.
   *
   * That is the whole of the split this file cares about. The companion bound —
   * how much of a *result* reaches the model — is the channel's own token spend
   * and does live in the sheet; it is applied in ./mcp-bounds.ts, and nothing
   * here knows about it.
   */
  readonly maxBodyBytes?: number;
  /** Injected transport. Tests pass a stub; nothing here reaches the network by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What the upstream said. Status and text; interpreting them is the caller's job. */
/**
 * One upstream call, with the body still arriving.
 *
 * The shape `callUpstreamStream` returns and `callUpstream` drains. Status and
 * headers are final — both are in hand before a body byte is read, and the
 * headers are already scrubbed. The body is not: it is bounded and redacted as
 * it arrives, and it is where every remaining failure of the call shows up, as
 * an `UpstreamError`.
 */
interface UpstreamStreamResponse {
  readonly status: number;
  /** `null` for a response that had no body at all — a 202 ack, a 204 `DELETE`. */
  readonly body: ReadableStream<Uint8Array> | null;
  /** The allowlisted response headers, lowercased and redacted. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly body: string;
  /**
   * The allowlisted response headers, lowercased and redacted. A header the
   * upstream did not send is absent rather than empty.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Caller headers, lowercased, with `authorization` removed.
 *
 * Lowercased because two spellings of one name in a plain object become two
 * headers on the wire in undici, and an upstream reading the first one gets to
 * choose which. The credential is attached after this runs, so a caller cannot
 * reach the authorization header by any spelling of it.
 */
function safeRequestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lowered = name.toLowerCase();
    if (lowered === "authorization") continue;
    out[lowered] = value;
  }
  return out;
}

/**
 * The body, decoded, or `null` if it ran past the limit.
 *
 * **The credential-shaped read**, and the reason it is not `callUpstream`: the
 * three callers are the token exchange and the issuer discovery beside it, where
 * the body *is* the credential. It must not be redacted — there are no needles
 * for a value that has not been minted yet — and it must not be returned to
 * anybody. So they read a body directly rather than spending one through the
 * function that scrubs and relays.
 *
 * A drain of `boundedRedactedBody` with no passes rather than a second loop, so
 * the bound, the decode and the abort classification have one implementation.
 * The `null` return is what the callers were already written against: overflow
 * is a value rather than a throw, because their `catch` maps to
 * `TokenExchangeFailure` and would report the bound as a transport failure.
 */
async function readBoundedText(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  const body = boundedRedactedBody(stream, limit, []);
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error instanceof UpstreamError && error.failure === "too_large") return null;
      throw error;
    }
    if (chunk.done) break;
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

/**
 * The classifier both reads share: whether a thrown value was the abort.
 *
 * Nothing else about it is kept — see the note on `UpstreamError`.
 */
function transportFailure(error: unknown): UpstreamFailure {
  return wasTimeout(error) ? "timed_out" : "unreachable";
}

/**
 * The response body, bounded and redacted, as it arrives.
 *
 * **Why this is a stream since #156, and what did not change.** It used to read
 * to completion and hand back a string, which made "every byte passes the
 * redaction before anything parses it" true by construction — nothing could
 * parse what had not finished arriving. It cost the two things #128 wrote down:
 * a server that leaves its event stream open after delivering the result hit
 * `AbortSignal.timeout` and was reported `timed_out` rather than returning the
 * answer it had already sent, and a progress notification was read only after
 * the whole body landed, which is not progress. The statement survives the
 * change intact — every byte still passes the same scan, in the same order,
 * before this function emits it — because `StreamingRedactor` holds back the
 * tail a match could still be completed from. That is the entire difficulty and
 * ./redact.ts is where it is argued.
 *
 * **Counted on the wire bytes, before decoding**, exactly as it was: that is the
 * quantity the heap is spent in and the only one available before the spending
 * happens. Chunks are decoded, scanned and emitted rather than accumulated, so
 * the peak is one chunk plus the held-back tail — which is *lower* than the
 * whole-body string the buffered version held.
 *
 * **Decoding is `response.text()`'s, and that is a fact about the specification
 * rather than an approximation.** `Response.text()` is defined as "consume body"
 * followed by *UTF-8 decode* — the declared charset is never consulted, unlike
 * `XMLHttpRequest` — and *UTF-8 decode* is exactly `TextDecoder("utf-8")` at its
 * defaults: `ignoreBOM: false`, so a leading byte order mark is stripped, and
 * `fatal: false`, so an invalid sequence becomes U+FFFD rather than throwing.
 * `{ stream: true }` holds an incomplete sequence back across a chunk boundary,
 * including a BOM split across the first two chunks. The suite proves this
 * rather than trusting it, by feeding the same bytes through both paths.
 *
 * The re-encode on the way out is lossy in exactly one direction and it is the
 * one the buffered path was already lossy in: a byte sequence that was not valid
 * UTF-8 became U+FFFD at the decode, so it leaves as U+FFFD's bytes. A consumer
 * sees the characters `response.text()` would have given it, which is what it
 * would have received before.
 *
 * **Every failure is an `UpstreamError` on the stream**, including the bound and
 * including a socket that broke mid-body. The consumer is the SDK, several
 * layers above; `upstreamFailure` in ./mcp-client.ts walks the cause chain to
 * find one, so what a channel is told stays a member of the closed set rather
 * than becoming whatever word a library chose.
 */
function boundedRedactedBody(
  source: ReadableStream<Uint8Array> | null,
  limit: number,
  passes: readonly RedactionPass[]
): ReadableStream<Uint8Array> | null {
  // What `response.text()` answers for a bodiless response, which is an ordinary
  // case here rather than an edge: the 202 an MCP server acknowledges a
  // notification with, and the 204 a session `DELETE` is answered by.
  if (source === null) return null;

  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const redactor = new StreamingRedactor(passes);
  let total = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loops rather than returning after one read: a chunk whose every
      // character is still inside the hold-back yields nothing final, and
      // enqueuing an empty array would tell the consumer a body ended.
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          // The response began and then failed mid-stream. Still a transport
          // failure, and it matters more here than at the headers: an event
          // stream spends most of a call's life in this read, so the timeout
          // usually fires during the body.
          controller.error(new UpstreamError(transportFailure(error)));
          return;
        }

        if (chunk.done) {
          // Flushes a trailing incomplete sequence to U+FFFD, as one
          // whole-buffer decode would, then the tail the scan was holding.
          const rest = redactor.push(decoder.decode()) + redactor.flush();
          if (rest.length > 0) controller.enqueue(encoder.encode(rest));
          controller.close();
          return;
        }

        total += chunk.value.byteLength;
        // Strictly greater, so a body of exactly the limit is a body that fits.
        // And before the decode below, so the chunk that crosses the line is
        // never scanned, never emitted, and never held.
        if (total > limit) {
          // Tells the transport to stop pulling rather than draining a body
          // nobody will read, and awaited so the socket is released first. Its
          // rejection is swallowed on purpose: cancelling an already-errored
          // stream rejects, and that rejection is not the failure to report.
          await reader.cancel().catch(() => undefined);
          controller.error(new UpstreamError("too_large"));
          return;
        }

        const text = redactor.push(decoder.decode(chunk.value, { stream: true }));
        if (text.length > 0) {
          controller.enqueue(encoder.encode(text));
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    }
  });
}

/**
 * Call the upstream with the credential attached.
 *
 * **One function for both verbs, rather than a second one for the `DELETE`.**
 * A session termination carries the same credential to the same destination as
 * every other request, so giving it its own path would mean a second place a
 * secret leaves the vault and a second thing to check when reasoning about
 * redaction. Everything below the verb branch is shared by construction: the
 * refused redirect, both transport-failure classifications, the body read and
 * the bound on it, and the single redaction pass before the one return.
 *
 * The timeout is not optional in effect — `AbortSignal.timeout` is always
 * applied — because an upstream that accepts a connection and never answers
 * would otherwise pin a request, and through it a channel, indefinitely. It is
 * a fixed ceiling rather than one read from the team sheet: per-task wall time
 * is the agent loop's cap and the budget meter's business (#38), while this is
 * the proxy refusing to hold a socket open forever, which is not a policy an
 * operator should be able to raise from a sheet. A caller's `signal` joins it
 * via `AbortSignal.any` — it can only end a request sooner, never extend one.
 *
 * Throws `UpstreamError` for transport failures and returns non-2xx responses
 * as ordinary results — a 404 from a tool is something the model should see and
 * may recover from, which is the distinction `ToolResult.isError` draws.
 */
async function callUpstreamStream(request: UpstreamRequest): Promise<UpstreamStreamResponse> {
  const send = request.fetch ?? globalThis.fetch;

  // The first of this file's two `reveal()` sites — the header lists both. It
  // is held in this local for the length of one request and used twice: to
  // build the header going out, and to build the needle list for the response
  // coming back. Both uses are inside this function, so there is still exactly
  // one place a value leaves a store to be *spent on an upstream*.
  const value = request.secret?.reveal();
  // Branched on the verb rather than on whether `body` happens to be set:
  // `JSON.stringify(undefined)` is `undefined`, so keying off the value would
  // send a bodiless POST silently instead of failing to compile.
  const method = request.method ?? "POST";
  // Defaults, then the caller's, then the credential. That order is the point:
  // the credential is attached last, so no caller header can displace it, and
  // `safeRequestHeaders` has already dropped any attempt to set it directly.
  const headers = injectCredential(
    {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      accept: "application/json",
      ...safeRequestHeaders(request.headers)
    },
    request.scheme,
    value
  );

  let response: Response;
  try {
    response = await send(request.url, {
      method,
      headers,
      ...(method === "POST" ? { body: request.body ?? "" } : {}),
      // Not followed. A redirect target is the only destination in the system
      // that nothing declared: the url above comes from the team sheet, and
      // `[egress]` covers the hosts an operator wrote down, but a 302 is chosen
      // by the upstream at call time. Following one opens a connection to a
      // host no sheet named and hands its body back to the agent with every
      // check already passed.
      //
      // Refused outright rather than checked against the egress list, because
      // the two are different questions: an MCP call redirecting is still MCP
      // traffic, so the list it would have to satisfy is the server's own
      // declared host — and an upstream that needs to move has an operator who
      // can change the url. Following manually would also mean owning loop
      // limits, the method rewrite on 303, and which headers survive a hop,
      // all on the one path in the tree that holds a credential.
      //
      // `manual` rather than `error`: both decline to follow, but `error`
      // reports it as a generic fetch failure whose only distinguishing mark is
      // the wording of a nested cause, and classifying a redirect by matching
      // an undici message string is a test that passes until Node rewords it.
      // `manual` hands back the 3xx itself, so the check below is a status
      // code. The response is refused unread either way.
      redirect: "manual",
      signal:
        request.signal === undefined
          ? AbortSignal.timeout(request.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS)
          : AbortSignal.any([
              AbortSignal.timeout(request.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS),
              request.signal
            ])
    });
  } catch (error) {
    // The only thing read off the thrown value is whether it was the abort.
    // Nothing else about it is kept — see the note on `UpstreamError`.
    throw new UpstreamError(transportFailure(error));
  }

  // Before the body is read, so nothing from the 3xx is parsed, scanned, or
  // returned. 304 is deliberately not in the set: it is not a redirect, and the
  // proxy sends no conditional headers that could provoke one.
  if (REDIRECT_STATUSES.has(response.status)) {
    throw new UpstreamError("redirected");
  }

  const limit = request.maxBodyBytes ?? DEFAULT_UPSTREAM_RESPONSE_BYTES;

  // Built before a byte of the body is read, which is what keeps the one
  // failure this scan has fail-*closed* on a streamed response: a body already
  // half-emitted cannot be un-emitted, so the value is checked while there is
  // still nothing to take back.
  //
  // Throws `RedactionError` on a value the scan cannot be run for. That is
  // deliberately *not* caught — see the fail-closed note in ./redact.ts. It
  // unwinds past the dispatcher to the server's handler catch, which answers a
  // constant 500 without inspecting the thrown value, so a redaction that could
  // not be performed produces no response rather than an unscrubbed one.
  const passes = redactionPasses(
    value === undefined ? [] : [{ name: request.credentialName ?? "credential", value }]
  );

  // The allowlisted headers are selected here rather than returned wholesale,
  // and scrubbed with the same needles as the body — the same `passes`, not a
  // second construction of them. Headers are in hand now, so they are scrubbed
  // now; the body is scrubbed as it arrives. Neither leaves without the scan.
  const responseHeaders: Record<string, string> = {};
  for (const name of READABLE_RESPONSE_HEADERS) {
    const header = response.headers.get(name);
    if (header !== null) responseHeaders[name] = applyPasses(header, passes);
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: boundedRedactedBody(response.body, limit, passes)
  };
}

/**
 * The same call, read to completion.
 *
 * **A wrapper rather than a second path, which is the whole point of the
 * split.** Every caller that is not the MCP transport wants a string — the
 * token exchange, and anything reading a control-plane answer nobody streams —
 * and giving them their own request function would mean a second place a
 * credential is revealed and a second thing to check when reasoning about
 * redaction. There is still exactly one of each; this drains what that one
 * produces.
 *
 * Throws `UpstreamError` for transport failures and returns non-2xx responses
 * as ordinary results — a 404 from a tool is something the model should see and
 * may recover from, which is the distinction `ToolResult.isError` draws.
 */
export async function callUpstream(request: UpstreamRequest): Promise<UpstreamResponse> {
  const streamed = await callUpstreamStream(request);
  if (streamed.body === null) return { status: streamed.status, body: "", headers: streamed.headers };

  const reader = streamed.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // Rethrown unchanged when it is already ours. `boundedRedactedBody`
      // classifies transport failures and raises the bound itself, and both
      // arrive here as an `UpstreamError`; re-running the abort classifier over
      // one would turn `too_large` into `unreachable` and silently undo the
      // bound. Anything else reaching here came from the stream machinery rather
      // than from that function, and is classified as it always was.
      throw error instanceof UpstreamError ? error : new UpstreamError(transportFailure(error));
    }
    if (chunk.done) break;
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());

  return { status: streamed.status, body: parts.join(""), headers: streamed.headers };
}

/**
 * The host an upstream URL names, for the log line.
 *
 * Host only. A full URL in a log line is a place a query-string token ends up,
 * and hosts are also what an operator compares against when reading one.
 * Returns `null` for a URL that does not parse — the sheet's `url` is
 * `z.url()` so that should not happen, but the caller decides what to do about
 * it rather than being handed an exception on the credential path.
 */
/** How long a session id may be before this proxy declines to hand it onward. */
const MAX_SESSION_ID = 512;

/**
 * The session id the server assigned, or `null` if it assigned none this proxy
 * will replay.
 *
 * **Validated rather than trusted, and this is the one place it can be.** The
 * value is upstream-authored and its only use is to be written back into an
 * outbound request header — which makes a CR or LF in it request smuggling, on
 * the one path that also carries a credential, and a megabyte of it a header no
 * proxy in the path will accept. The spec is precise about the shape: visible
 * ASCII, 0x21 to 0x7E, which excludes space and every control character. So
 * this is the spec's own rule enforced at the boundary rather than a guess at a
 * safe character set.
 *
 * A server whose id fails it is treated as a server that assigned none: the
 * handshake still succeeded, and the calls that follow carry no session, which
 * is a legitimate legacy shape rather than an error.
 *
 * **It lives here since #188 rather than beside the framing it used to serve**,
 * because the MCP client no longer reads this header — the SDK's transport does,
 * off the `Response` synthesized below. Dropping a bad id there is what keeps
 * the guarantee: the value never becomes a header the SDK writes, so there is no
 * downstream `Headers` constructor to depend on for the check.
 */
export function readSessionId(header: string | null): string | null {
  if (header === null || header.length === 0 || header.length > MAX_SESSION_ID) return null;
  return /^[\x21-\x7E]+$/.test(header) ? header : null;
}

/**
 * The transport the MCP client is given.
 *
 * Structurally the SDK's `FetchLike`, declared here rather than imported so that
 * this file — the one that holds a revealed credential — names no third-party
 * type. The SDK's own declaration is `(url: string | URL, init?: RequestInit) =>
 * Promise<Response>`; a mismatch is a compile error at the one place the two
 * meet, in ./mcp-client.ts.
 */
export type GuardedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** One upstream's transport settings. Everything per-request arrives on the call. */
export interface GuardedFetchOptions {
  /**
   * The upstream's URL from the team sheet. Its **origin** is the pin: a request
   * to anything else is refused unsent.
   */
  readonly url: string;
  readonly source: CredentialSource;
  readonly timeoutMs?: number;
  /**
   * How many bytes of a response to hold, or a function asked per request.
   *
   * **The function form is what restores the control-plane bound.** The
   * hand-rolled client chose this per call site — 64 KiB for the version probe,
   * the legacy handshake, its acknowledgement and the session-termination
   * `DELETE`, and the deployment's full bound for everything else — because a
   * server answering the *handshake* with megabytes has shown it is not speaking
   * MCP, and cutting that off early costs nothing that could have been used.
   *
   * A `fetch` has no call sites to choose at: every request arrives through the
   * one function. It cannot tell a handshake from a call either, short of
   * parsing the body it is carrying. So the caller — which knows exactly which
   * phase its connection is in — answers the question per request instead, and
   * is handed the verb, which is the one phase marker the request itself
   * carries: a `DELETE` is always session termination, whatever phase the
   * connection believes it is in.
   */
  readonly maxBodyBytes?: number | ((method: UpstreamMethod) => number);
  /** Injected transport. Tests pass a stub; nothing here reaches the network by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * `callUpstream`'s discipline, worn as the MCP client's `fetch`.
 *
 * **This is what makes adopting a protocol library safe rather than a leap of
 * faith.** The SDK frames the messages; every byte it puts on the wire and every
 * byte it reads back passes through here first, so the credential is still
 * revealed in exactly one function, still attached last, and the reply is still
 * scrubbed before anything upstream of the socket can see it. #185's spike is
 * the evidence; the e2e suite is what keeps it true.
 *
 * Four things it does that `callUpstream` alone does not, each a decision:
 *
 * **The origin is pinned.** `callUpstream` refuses a redirect, which covers the
 * destination an upstream chooses at call time; this covers the destination a
 * *library* chooses. Today the SDK has one — no `authProvider` is configured, so
 * its OAuth discovery paths are unreachable, and that stays true with the token
 * engine (#256): OAuth is this proxy's own machinery beneath the SDK, which is
 * never handed a token to manage. Pinning is what keeps that a property of the
 * code rather than of the configuration. A violation is `"redirected"`: the
 * same category, an undeclared destination, and not a new word in a closed set
 * that `failureText` reads.
 *
 * **Only `POST` and `DELETE` go out.** Anything else is answered `405` without a
 * socket. The SDK opens a standalone `GET` event stream to listen for
 * server-initiated messages whenever a request is answered `202` with no body —
 * which the legacy `notifications/initialized` acknowledgement is. That stream
 * stays open for the connection's life and nothing here would ever read it to an
 * end, so it would hold a socket until the timeout and then report a failure
 * that nothing asked for. #156 does not soften that: streaming a body the SDK is
 * waiting on is not the same as listening on one nobody asked for, and the
 * paragraph below is why this proxy declines the second at any speed.
 *
 * `405` is the answer a server offering no listen endpoint already gives, and
 * the SDK treats it as benign on that path. Measured rather than assumed: on the
 * legacy era exactly one attempt is made and refused, on the modern era none is
 * made at all (there is no `initialized` ack to provoke it), the handshake,
 * listing and call complete in both, and neither `transport.onerror` nor
 * `client.onerror` fires — a run that lets the `GET` through to a server's own
 * `405` behaves identically, which is what says this answer is indistinguishable
 * from the real thing rather than a shape the SDK special-cases.
 *
 * The consequence, stated because it is the only one: a server that *does* offer
 * a listen stream is refused it too, so nothing server-initiated ever arrives —
 * `notifications/tools/list_changed` included. That is not a regression. The
 * hand-rolled client never opened one either, and ./mcp-catalog.ts has always
 * re-asked on a TTL rather than waiting to be told. It preserves what this proxy
 * has always done: it does not listen, because nothing it would hear has a sheet
 * entry behind it.
 *
 * **The `Response` is the allowlist.** It is built from
 * `READABLE_RESPONSE_HEADERS` rather than filtered down to them, so
 * `www-authenticate`, `set-cookie` and everything else are *absent* from what
 * the SDK receives rather than present and ignored. That is why adopting a
 * library did not widen the allowlist.
 *
 * **A session id is validated before it is exposed**, per `readSessionId` above.
 */
export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const origin = originOf(options.url);

  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "DELETE") {
      return new Response(null, { status: 405 });
    }

    // Before the credential is revealed, so a request to somewhere the sheet did
    // not name never reaches the code that would attach one.
    if (origin === null || originOf(String(url)) !== origin) {
      throw new UpstreamError("redirected");
    }

    const bound = typeof options.maxBodyBytes === "function" ? options.maxBodyBytes(method) : options.maxBodyBytes;

    // Resolved before header assembly — for an OAuth source this may be a
    // token-endpoint round trip — so the reveal inside `callUpstream` stays
    // synchronous and single.
    const acquired = await options.source.acquire();

    const call = (secret: Secret | undefined): Promise<UpstreamStreamResponse> =>
      callUpstreamStream({
        url: String(url),
        method,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        // `RequestInit.signal` admits `null`; both absences mean the same thing.
        ...(init?.signal != null ? { signal: init.signal } : {}),
        headers: headersToRecord(init?.headers),
        scheme: options.source.scheme,
        secret,
        ...(options.source.name !== undefined ? { credentialName: options.source.name } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(bound !== undefined ? { maxBodyBytes: bound } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      });

    let response = await call(acquired?.secret);

    // The one retry on a 401, and it sits below the SDK on purpose: a
    // connect-time rejection and a mid-call one take the identical path.
    // Retrying is safe because a 401 means the upstream refused authentication
    // and executed nothing. A bearer source answers `null` — the 401 stands,
    // exactly as it did before this seam existed — and the generation keeps a
    // straggler from forcing a second refresh past one already made.
    if (response.status === 401 && acquired !== undefined) {
      const fresh = await options.source.refresh(acquired.generation);
      if (fresh !== null) {
        // The refused response's body is never read, and since #156 it is a
        // live stream rather than a string already in hand — so it is cancelled
        // rather than dropped, which releases the socket instead of leaving it
        // held until the transport times it out.
        await response.body?.cancel().catch(() => undefined);
        response = await call(fresh.secret);
      }
    }

    const exposed = new Headers();
    const contentType = response.headers["content-type"];
    if (contentType !== undefined) exposed.set("content-type", contentType);
    const session = readSessionId(response.headers["mcp-session-id"] ?? null);
    if (session !== null) exposed.set("mcp-session-id", session);

    // A body is forbidden on these statuses by the `Response` constructor, and
    // `boundedRedactedBody` already answers `null` for a stream that was never
    // there. Cancelled rather than dropped on the forbidden statuses, for the
    // reason the 401 retry cancels: a stream nobody will read still holds a
    // socket.
    const bodyless = response.status === 204 || response.status === 205 || response.status === 304;
    if (bodyless) await response.body?.cancel().catch(() => undefined);
    return new Response(bodyless ? null : response.body, { status: response.status, headers: exposed });
  };
}

/** The origin a URL names, or `null` if it does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Why a refresh-token exchange produced no access token.
 *
 * A closed set that never carries a byte of the response body, the
 * `VaultError` no-`cause` argument applied to HTTP: this path holds two
 * credentials at once, so the failure a caller reports has to be something
 * safe to log by construction. The transport members are `UpstreamFailure`'s;
 * `invalid_grant` gets its own member because the engine treats it as a
 * different fact — a dead grant, and a theft signal when rotation's reuse
 * detection fired — where everything else is a failure to ask.
 */
export type TokenExchangeFailure =
  | "timed_out"
  | "unreachable"
  | "redirected"
  | "too_large"
  | "discovery_failed"
  | "issuer_mismatch"
  | "invalid_grant"
  | "exchange_failed"
  | "malformed_token_response"
  | "rotation_unpersisted";

export class TokenExchangeError extends Error {
  readonly failure: TokenExchangeFailure;

  constructor(failure: TokenExchangeFailure) {
    super(`token exchange: ${failure}`);
    this.name = "TokenExchangeError";
    this.failure = failure;
  }
}

export interface TokenExchangeRequest {
  /** The declared issuer, exactly as the sheet wrote it. Every fetch is pinned to its origin. */
  readonly issuer: string;
  /** The Client ID Metadata Document URL the grant was made under, sent as `client_id`. */
  readonly clientId: string;
  readonly refreshToken: Secret;
  readonly credentialName: string;
  /**
   * Awaited between receiving a rotated refresh token and returning the access
   * token — persist-before-use made structural: the authorization server
   * invalidated the predecessor at the exchange, so the gap between exchange
   * and persist is the one window that can lose a grant, and nothing else is
   * permitted inside it. A throw here fails the exchange as
   * `rotation_unpersisted` rather than serving on a token whose grant would be
   * gone at the next restart.
   */
  readonly persistRotation: (rotatedRefreshToken: string) => Promise<void>;
  /** One budget over the whole exchange, discovery included. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface MintedAccessToken {
  /** Wrapped before it leaves this function; the raw reply reaches no caller. */
  readonly accessToken: Secret;
  /** Absent when the issuer named no lifetime: live until a 401 says otherwise. */
  readonly expiresInSeconds: number | undefined;
  /** Whether the issuer rotated the refresh token — already persisted if so. */
  readonly rotated: boolean;
}

/**
 * Spend a refresh token at its issuer; get a live access token back.
 *
 * An outbound call with the guard inverted: `callUpstream` spends a credential
 * and scrubs the reply, this spends a refresh token and returns the reply to
 * no caller at all, because the reply *is* the credential. Same discipline
 * otherwise — origin pinned to the declared issuer, redirects refused (a
 * redirected token request is a refresh token sent to the one host neither
 * list names), bodies bounded at the control-plane cap, failures mapped to the
 * closed set above.
 *
 * The token endpoint is discovered (RFC 8414) rather than declared: the sheet
 * holds one name for the authority, and the metadata's own `issuer` must equal
 * it byte for byte or the grant is treated as absent. A discovered endpoint
 * off the issuer's origin is refused the same way — this proxy does not send
 * refresh tokens to a second host, whatever the metadata says.
 */
export async function exchangeRefreshToken(request: TokenExchangeRequest): Promise<MintedAccessToken> {
  const send = request.fetch ?? globalThis.fetch;
  const issuerOrigin = originOf(request.issuer);
  if (issuerOrigin === null) throw new TokenExchangeError("discovery_failed");

  // One budget over both round trips, so a slow discovery cannot grant the
  // exchange more time than the caller offered.
  const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);

  const { tokenEndpoint } = await discoverAuthorizationServer(send, request.issuer, issuerOrigin, signal);

  // The second of this file's two `reveal()` sites — see the header. Held in a
  // local for the length of one request, used once.
  const refreshValue = request.refreshToken.reveal();
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshValue,
    client_id: request.clientId
  });
  // No `scope` parameter, deliberately: the record's scopes are grant-time
  // facts, and the sheet⊆grant check already ran at the store read. Asking
  // again here could only narrow by accident or widen by bug.

  let response: Response;
  try {
    response = await send(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual",
      signal
    });
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }

  if (REDIRECT_STATUSES.has(response.status)) throw new TokenExchangeError("redirected");

  let body: string | null;
  try {
    body = await readBoundedText(response.body, MAX_CONTROL_BODY_BYTES);
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }
  // A token response is control-plane sized by construction; an issuer
  // answering the *exchange* with megabytes is not one to keep talking to.
  if (body === null) throw new TokenExchangeError("too_large");

  if (!response.ok) {
    // The only thing read off a failed exchange is the body's `error` member,
    // checked against the one word the engine branches on. Everything else —
    // the description, the status text, the body itself — is discarded unread.
    throw new TokenExchangeError(oauthErrorOf(body) === "invalid_grant" ? "invalid_grant" : "exchange_failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (typeof parsed !== "object" || parsed === null) throw new TokenExchangeError("malformed_token_response");
  const token = parsed as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in))) {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (token.refresh_token !== undefined && typeof token.refresh_token !== "string") {
    throw new TokenExchangeError("malformed_token_response");
  }

  const rotated = token.refresh_token !== undefined && token.refresh_token !== refreshValue;
  if (rotated && typeof token.refresh_token === "string") {
    // Before the access token is constructed, let alone returned. See the
    // field's doc comment: this ordering is the persistence guarantee.
    try {
      await request.persistRotation(token.refresh_token);
    } catch {
      throw new TokenExchangeError("rotation_unpersisted");
    }
  }

  return {
    accessToken: makeSecret(token.access_token),
    expiresInSeconds: typeof token.expires_in === "number" ? token.expires_in : undefined,
    rotated
  };
}

export interface CodeExchangeRequest {
  /** The declared issuer, exactly as the sheet wrote it. Every fetch is pinned to its origin. */
  readonly issuer: string;
  /** The Client ID Metadata Document URL the grant is being made under, sent as `client_id`. */
  readonly clientId: string;
  /** Must be byte-for-byte the URI the authorization request named. */
  readonly redirectUri: string;
  /** The authorization code off the pasted redirect. A plaintext local; single-use at the issuer. */
  readonly code: string;
  /** The PKCE verifier generated in-process. Never left it; never will. */
  readonly codeVerifier: string;
  /** One budget over the whole exchange, discovery included. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GrantedTokens {
  /**
   * Plaintext, headed for the token store's write path and nowhere else.
   * Absent when the issuer declined to issue one — the caller's fact to rule
   * on, because a headless proxy cannot hold a grant without it.
   */
  readonly refreshToken: string | undefined;
  /** The response's `scope`, verbatim: what was granted, which may be narrower than what was asked. */
  readonly grantedScope: string | undefined;
}

/**
 * Spend a single-use authorization code at its issuer; get grant material back.
 *
 * The grant flow's half of what `exchangeRefreshToken` is to the serving path,
 * under the same discipline: origin pinned to the declared issuer, redirects
 * refused, bodies bounded at the control-plane cap, failures the closed set
 * above with no response byte kept. The access token in the reply is validated
 * for shape and then discarded — the flow has no call to make with it, and a
 * value not returned is a value no caller can leak.
 *
 * Exported for the grant flow (./grant-flow.ts); not on the package index.
 */
export async function exchangeAuthorizationCode(request: CodeExchangeRequest): Promise<GrantedTokens> {
  const send = request.fetch ?? globalThis.fetch;
  const issuerOrigin = originOf(request.issuer);
  if (issuerOrigin === null) throw new TokenExchangeError("discovery_failed");

  // Its own budget over both round trips: a human paste separates this from
  // the authorization request, so no signal could span the whole grant anyway.
  const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);

  const { tokenEndpoint } = await discoverAuthorizationServer(send, request.issuer, issuerOrigin, signal);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    code_verifier: request.codeVerifier
  });
  // No `scope` parameter: RFC 6749 §4.1.3 defines none for the code exchange —
  // scope was asked at authorization, and the response says what was granted.

  let response: Response;
  try {
    response = await send(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual",
      signal
    });
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }

  if (REDIRECT_STATUSES.has(response.status)) throw new TokenExchangeError("redirected");

  let body: string | null;
  try {
    body = await readBoundedText(response.body, MAX_CONTROL_BODY_BYTES);
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }
  if (body === null) throw new TokenExchangeError("too_large");

  if (!response.ok) {
    // As the sibling: the one word the caller branches on, everything else
    // discarded unread. `invalid_grant` here is a dead, used, or forged code.
    throw new TokenExchangeError(oauthErrorOf(body) === "invalid_grant" ? "invalid_grant" : "exchange_failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (typeof parsed !== "object" || parsed === null) throw new TokenExchangeError("malformed_token_response");
  const token = parsed as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
  };
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in))) {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (token.refresh_token !== undefined && typeof token.refresh_token !== "string") {
    throw new TokenExchangeError("malformed_token_response");
  }
  if (token.scope !== undefined && typeof token.scope !== "string") {
    throw new TokenExchangeError("malformed_token_response");
  }

  return {
    refreshToken: token.refresh_token,
    grantedScope: token.scope
  };
}

/**
 * The abort classifier, shared by every read in this file.
 *
 * **It recognises this file's own error class as well as the runtime's**, which
 * it has to since #156: a body read now runs inside `boundedRedactedBody`, which
 * classifies a mid-stream abort and raises an `UpstreamError` for it, so a
 * caller draining that stream is handed our word rather than the runtime's
 * `TimeoutError`. Without this branch the token exchange would report a timeout
 * as `unreachable` — the same failure, told to the operator wrong.
 */
function wasTimeout(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.failure === "timed_out";
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The `error` member of an OAuth error body, or `null`. Nothing else is read. */
function oauthErrorOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const code = (parsed as { error?: unknown }).error;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * What discovery answers with. The token endpoint is required — nothing here
 * works without one — but the authorization endpoint is the grant flow's
 * concern alone, so its absence is the caller's fact to rule on, not a
 * discovery failure.
 */
export interface AuthorizationServerMetadata {
  readonly tokenEndpoint: string;
  readonly authorizationEndpoint: string | undefined;
  readonly codeChallengeMethodsSupported: readonly string[] | undefined;
}

/**
 * RFC 8414 discovery, pinned to the issuer.
 *
 * The well-known path is inserted between the host and the issuer's path, per
 * the RFC. The response must name the declared issuer byte for byte — that is
 * both the RFC's own rule and how Client ID Metadata's
 * re-registration-by-issuer is kept without a registry — and the token
 * endpoint it offers must sit on the issuer's origin, or the grant is treated
 * as absent rather than the refresh token following the metadata elsewhere.
 *
 * Exported for the grant flow (./grant-flow.ts), which needs the
 * authorization endpoint; not on the package index.
 */
export async function discoverAuthorizationServer(
  send: typeof globalThis.fetch,
  issuer: string,
  issuerOrigin: string,
  signal: AbortSignal
): Promise<AuthorizationServerMetadata> {
  const parsed = new URL(issuer);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const wellKnown = `${issuerOrigin}/.well-known/oauth-authorization-server${path}`;

  let response: Response;
  try {
    response = await send(wellKnown, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal
    });
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }

  if (REDIRECT_STATUSES.has(response.status)) throw new TokenExchangeError("redirected");

  let body: string | null;
  try {
    body = await readBoundedText(response.body, MAX_CONTROL_BODY_BYTES);
  } catch (error) {
    throw new TokenExchangeError(wasTimeout(error) ? "timed_out" : "unreachable");
  }
  if (body === null) throw new TokenExchangeError("too_large");
  if (!response.ok) throw new TokenExchangeError("discovery_failed");

  let metadata: unknown;
  try {
    metadata = JSON.parse(body);
  } catch {
    throw new TokenExchangeError("discovery_failed");
  }
  if (typeof metadata !== "object" || metadata === null) throw new TokenExchangeError("discovery_failed");
  const fields = metadata as {
    issuer?: unknown;
    token_endpoint?: unknown;
    authorization_endpoint?: unknown;
    code_challenge_methods_supported?: unknown;
  };

  // Byte for byte, never normalized — a trailing slash is a different issuer.
  if (fields.issuer !== issuer) throw new TokenExchangeError("issuer_mismatch");
  if (typeof fields.token_endpoint !== "string") throw new TokenExchangeError("discovery_failed");
  if (originOf(fields.token_endpoint) !== issuerOrigin) throw new TokenExchangeError("issuer_mismatch");

  // The optional members are surfaced or absent, never guessed at: a
  // non-string endpoint or a non-string-array methods list reads as absent,
  // and the caller rules on absence.
  const authorizationEndpoint =
    typeof fields.authorization_endpoint === "string" ? fields.authorization_endpoint : undefined;
  const methods = fields.code_challenge_methods_supported;
  const codeChallengeMethodsSupported =
    Array.isArray(methods) && methods.every((member): member is string => typeof member === "string")
      ? methods
      : undefined;

  return {
    tokenEndpoint: fields.token_endpoint,
    authorizationEndpoint,
    codeChallengeMethodsSupported
  };
}

/**
 * `HeadersInit` in whatever shape the caller used, as the flat record
 * `callUpstream` takes.
 *
 * `safeRequestHeaders` lowercases and drops `authorization` on the other side,
 * so this only has to flatten. A `Headers` instance already joins repeats with
 * `, `, which is what the wire would carry anyway.
 */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  new Headers(headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export function destinationHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
