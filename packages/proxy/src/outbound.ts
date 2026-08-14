// The outbound call: where a credential stops being a name and becomes a header.
//
// This is the one file in the tree that takes a secret out of the vault. Every
// other module moves credentials as `Secret` handles or as names, and the whole
// design of ./vault.ts — no `get`, no iteration, `toString` and `toJSON` fixed
// at `[redacted]` — exists so that this is true and so that checking it is one
// grep. `injectCredential` below holds the only `reveal()` call, and a second
// one appearing anywhere is the thing a reviewer should stop.
//
// Nothing third-party, per the rule at the top of ./server.ts. The transport is
// Node's built-in `fetch`, injected so tests never open a socket they did not
// stand up themselves — the same shape `packages/agent/src/completion/*.ts`
// uses for provider clients.
//
// **The secret does not come back, either.** `callUpstream` redacts the
// response before returning it, and the reason that is sufficient rather than
// merely helpful is structural: a credential value can only appear in a
// response if it was sent in a request, the only place a credential is revealed
// and sent is this function, so scrubbing here covers every path by which a
// stored secret can be echoed back. That is why redaction lives at this level
// and not in a dispatcher — `ToolDispatcher` is an injected interface, so a
// pass inside one implementation would leave #39's client pool and every test
// double uncovered, and it would need a second `reveal()` to do it.
//
// The same argument is why `credentialHeader` and `injectCredential` are not
// exported from the package index: `callUpstream` is the only exported way to
// send a credential, and it always redacts what comes back.
//
// **What this file does not do.** It does not check the egress allowlist, and
// that is not an omission. `[egress]` governs destinations the sheet does not
// pin; the url below comes from an `[[mcp_server]]` block, which is where an
// admin authorized it. See the header of packages/schema/src/egress.ts for why
// merging the two lists would widen both. What this file does own is the one
// destination nothing declared — a redirect target — and it refuses to follow.

import { redactSecrets } from "./redact.js";
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
 * else on this path. Until this landed, `response.text()` read a body to
 * completion — so a fifty-megabyte answer was buffered, scanned fifteen times by
 * `redactSecrets`, parsed, and handed to a model that spent a channel's whole
 * task budget reading it.
 *
 * **Four megabytes, and deliberately not `MAX_BODY_BYTES`'s one.** That number
 * bounds an *inbound* request, which is one tool call's arguments; this bounds
 * an outbound response, which since #129 may be a `tools/list` catalog — a
 * hundred tools carrying full JSON Schema is half a megabyte before anything
 * exotic happens. Four leaves room for that and still refuses to hold a file
 * transfer.
 *
 * **The real cost is three to five times this number per concurrent call**, and
 * an operator changing it should know that: the decoded string is up to two
 * bytes per character, `redactSecrets` builds an output copy per needle it
 * matches, and `JSON.parse` then builds an object graph beside both. The cap is
 * on the bytes off the wire because that is the quantity this function can
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
 * **Equivalent to `response.text()` for anything under the limit, and that is a
 * fact about the specification rather than an approximation.** `Response.text()`
 * is defined as "consume body" followed by *UTF-8 decode* — the declared charset
 * is never consulted, unlike `XMLHttpRequest` — and *UTF-8 decode* is exactly
 * `TextDecoder("utf-8")` at its defaults: `ignoreBOM: false`, so a leading byte
 * order mark is stripped, and `fatal: false`, so an invalid sequence becomes
 * U+FFFD rather than throwing. `{ stream: true }` holds an incomplete sequence
 * back across a chunk boundary, including a BOM split across the first two
 * chunks, so the joined result is character-for-character what one decode of the
 * whole buffer produces. The suite proves this rather than trusting it, by
 * feeding the same bytes through both paths three at a time.
 *
 * **Counted on the wire bytes, before decoding**, because that is the quantity
 * the heap is spent in and the only one available before the spending happens.
 * Chunks are decoded and dropped as they arrive rather than accumulated, so the
 * peak is one chunk plus the string built so far.
 *
 * **Overflow is this return value and never a thrown error**, which is load
 * bearing rather than stylistic. The caller runs this inside the try that
 * classifies transport failures, and that catch reads `error.name` to tell an
 * abort from a broken socket: an `UpstreamError` thrown from in here would be
 * caught, found not to be a `TimeoutError`, and rethrown as `unreachable`. The
 * bound would vanish, and every test asserting only that the call failed would
 * go on passing. A value the catch cannot see is the version of this that cannot
 * be undone by an edit somewhere else.
 */
async function readBoundedText(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  // What `response.text()` answers for a bodiless response, which is an ordinary
  // case here rather than an edge: the 202 an MCP server acknowledges a
  // notification with, and the 204 a session `DELETE` is answered by.
  if (stream === null) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let total = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    // Strictly greater, so a body of exactly the limit is a body that fits. And
    // before the decode below, so the chunk that crosses the line is never added
    // to what is being accumulated.
    if (total > limit) {
      // Tells the transport to stop pulling rather than draining a body nobody
      // will read, and awaited so the socket is released before this returns.
      // Its rejection is swallowed on purpose: cancelling an already-errored
      // stream rejects, and letting that escape would land in the caller's
      // transport catch and be reported as `unreachable` — the exact confusion
      // the return value above exists to avoid.
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }

  // Flushes a trailing incomplete sequence to U+FFFD, as one whole-buffer decode
  // would.
  parts.push(decoder.decode());
  return parts.join("");
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
export async function callUpstream(request: UpstreamRequest): Promise<UpstreamResponse> {
  const send = request.fetch ?? globalThis.fetch;

  // The one `reveal()` in the tree. It is held in this local for the length of
  // one request and used twice: to build the header going out, and to build the
  // needle list for the response coming back. Both uses are inside this
  // function, so there is still exactly one place a value leaves the vault.
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
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UpstreamError(timedOut ? "timed_out" : "unreachable");
  }

  // Before the body is read, so nothing from the 3xx is parsed, scanned, or
  // returned. 304 is deliberately not in the set: it is not a redirect, and the
  // proxy sends no conditional headers that could provoke one.
  if (REDIRECT_STATUSES.has(response.status)) {
    throw new UpstreamError("redirected");
  }

  const limit = request.maxBodyBytes ?? DEFAULT_UPSTREAM_RESPONSE_BYTES;

  let body: string | null;
  try {
    body = await readBoundedText(response.body, limit);
  } catch (error) {
    // The response began and then failed mid-stream. Still a transport
    // failure, and still nothing from the error is kept beyond whether it was
    // the abort — which matters here rather than only above, because an event
    // stream spends most of a call's life in this read, so the timeout usually
    // fires during the body rather than during the headers.
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UpstreamError(timedOut ? "timed_out" : "unreachable");
  }

  // Outside the catch, deliberately: this is a limit this function chose to
  // enforce, not a transport failure it was handed, and the classifier above
  // would turn it into `unreachable`. See the note on `readBoundedText`.
  //
  // Nothing was decoded and nothing is returned, so there is no body to redact
  // and none to relay — which is also why no caller can report what the upstream
  // said. That is the same shape `McpOutcome.connect_failed` takes one level up:
  // bytes the proxy declined to hold are bytes it has nothing to say about.
  if (body === null) throw new UpstreamError("too_large");

  // Before the body goes anywhere. Not at the caller's discretion and not
  // behind a flag: the return statement below is the only way out of this
  // function, so a response cannot leave without passing through here.
  //
  // Throws `RedactionError` on a value the scan cannot be run for. That is
  // deliberately *not* caught — see the fail-closed note in ./redact.ts. It
  // unwinds past the dispatcher to the server's handler catch, which answers a
  // constant 500 without inspecting the thrown value, so a redaction that could
  // not be performed produces no response rather than an unscrubbed one.
  const secrets = value === undefined ? [] : [{ name: request.credentialName ?? "credential", value }];
  const scrub = (text: string): string => (secrets.length === 0 ? text : redactSecrets(text, secrets));

  // The allowlisted headers are selected here rather than returned wholesale,
  // and scrubbed with the same needles as the body. Both happen before the one
  // return, so neither can leave without passing through the same pass.
  const responseHeaders: Record<string, string> = {};
  for (const name of READABLE_RESPONSE_HEADERS) {
    const header = response.headers.get(name);
    if (header !== null) responseHeaders[name] = scrub(header);
  }

  return { status: response.status, body: scrub(body), headers: responseHeaders };
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
  readonly scheme: AuthScheme;
  readonly secret: Secret | undefined;
  readonly credentialName?: string;
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
 * its OAuth discovery paths are unreachable — and pinning is what keeps that a
 * property of the code rather than of the configuration. A violation is
 * `"redirected"`: the same category, an undeclared destination, and not a new
 * word in a closed set that `failureText` reads.
 *
 * **Only `POST` and `DELETE` go out.** Anything else is answered `405` without a
 * socket. The SDK opens a standalone `GET` event stream to listen for
 * server-initiated messages whenever a request is answered `202` with no body —
 * which the legacy `notifications/initialized` acknowledgement is. That stream
 * stays open for the connection's life, and the read below is bounded and
 * buffered, so it would sit on a socket until the timeout and then report a
 * failure that nothing asked for.
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

    const response = await callUpstream({
      url: String(url),
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      // `RequestInit.signal` admits `null`; both absences mean the same thing.
      ...(init?.signal != null ? { signal: init.signal } : {}),
      headers: headersToRecord(init?.headers),
      scheme: options.scheme,
      secret: options.secret,
      ...(options.credentialName !== undefined ? { credentialName: options.credentialName } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(bound !== undefined ? { maxBodyBytes: bound } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });

    const exposed = new Headers();
    const contentType = response.headers["content-type"];
    if (contentType !== undefined) exposed.set("content-type", contentType);
    const session = readSessionId(response.headers["mcp-session-id"] ?? null);
    if (session !== null) exposed.set("mcp-session-id", session);

    // A body is forbidden on these statuses by the `Response` constructor, and
    // `readBoundedText` already answers `""` for a stream that was never there.
    const bodyless = response.status === 204 || response.status === 205 || response.status === 304;
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
