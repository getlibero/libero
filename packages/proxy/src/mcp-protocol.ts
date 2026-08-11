// The MCP wire format, as pure functions.
//
// No `Secret`, no `fetch`, no `Vault`, no I/O of any kind. The split is the one
// ./redact.ts and ./outbound.ts already draw: the rules live apart from the
// custody, so the rules can be tested exhaustively without standing anything
// up, and a reviewer reading the custody file is not also reading a parser.
//
// **Hand-rolled, and now on the way out (#185/#188).** The original reason was
// custody: the belief that the SDK's streamable-HTTP transport owned its own
// `fetch`, so the credential would be revealed outside `callUpstream`. #130
// established that is false — `StreamableHTTPClientTransport` takes
// `fetch?: FetchLike`, used for all network requests, so `callUpstream` can be
// the injected fetch and the custody argument survives adoption. The stated
// cost model was also wrong by construction: the spec watch that was meant to
// bound it triggered on revision *tags* and structurally could not see a
// within-revision feature, which is exactly the gap (`x-mcp-header`) that #130
// hit while it reported green. It is retired. #185 re-ran the decision on
// that evidence and chose to adopt `@modelcontextprotocol/client` 2.0.0; #188
// is the implementation. Do not extend this module's protocol coverage — a gap
// found here is an argument for finishing #188, not for another function.
//
// **Two dialects, and the split is a transport difference rather than a flag.**
// `2026-07-28` is stateless: a request carries its own version and capabilities
// in `_meta`, and `server/discover` negotiates. Everything before it opens with
// an `initialize`/`notifications/initialized` handshake and may carry a session
// for the rest of the connection's life. The functions below take a
// `WireContext` or an `McpDialect` wherever the two disagree, so which protocol
// a request is written in is a value rather than a mode this module remembers —
// it remembers nothing.
//
// The one import is ./mcp-bounds.ts, for the cap on how much of an upstream's
// error message this module will hand back. Every other bound moved there with
// #188: what an upstream is allowed to say is policy, and it outlives whoever
// frames the bytes.

import { relayedDetail } from "./mcp-bounds.js";

/**
 * The revision this client speaks.
 *
 * A named constant in this module and nowhere else, so that what the proxy
 * claims on the wire is one edit rather than a search. It used to be parsed out
 * of this file by a weekly workflow comparing it against the specification's
 * revision tags; that watcher was retired with #188, because the SDK owns the
 * revision from here and a cron grepping a constant that is about to be deleted
 * can only ever report success. Keeping up is a dependency bump and the security
 * review that goes with one — see this package's README.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * The revisions speakable with no handshake at all.
 *
 * One member, and not by coincidence: `2026-07-28` is the revision that removed
 * sessions, so it is the only one a client holding no connection state can hold
 * up its end of. `server/discover` may only ever negotiate down to a member of
 * this list — see `negotiatedVersion`, which reads this rather than
 * `SUPPORTED_PROTOCOL_VERSIONS` for exactly that reason.
 */
export const STATELESS_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION] as const;

/**
 * The revision the legacy handshake proposes: the newest one below the pinned
 * constant.
 *
 * Named so that it does not end in `MCP_PROTOCOL_VERSION`, which was once a
 * hard requirement — a workflow grepped this file for that constant with an
 * unanchored pattern, so a name merely ending in it matched as a substring and
 * broke the comparison silently. That workflow is gone (#188) and the hazard
 * with it; the name stays because it is the clearer of the two.
 */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/**
 * The revisions reachable through the `initialize` handshake, newest first.
 *
 * `2024-11-05` is deliberately absent, and it is not an arbitrary line: that
 * revision's transport is the deprecated two-endpoint HTTP+SSE pair — a GET for
 * the event stream and a separate POST endpoint the server names in an
 * `endpoint` event — and an `[[mcp_server]]` block holds one url. The POST
 * target would be chosen by the upstream at call time, which is the same shape
 * ./outbound.ts refuses a redirect for. Supporting it is a second transport,
 * not a third entry in a list.
 */
export const LEGACY_PROTOCOL_VERSIONS = [LEGACY_PROTOCOL_VERSION, "2025-06-18", "2025-03-26"] as const;

/**
 * Every revision this client can speak, by either path, newest first.
 *
 * Composed rather than authored, so the two halves cannot drift from it. Which
 * half a revision falls in is what decides whether a session exists, so the
 * halves are what the code branches on and this is for reporting the union.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...STATELESS_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS
];

/**
 * Which of the two protocols a request is written in.
 *
 * The discriminator for everything below that differs between them: whether
 * `_meta` is carried, whether the `Mcp-Method`/`Mcp-Name` transport headers are
 * sent, and whether there is a session at all.
 */
export type McpDialect = "stateless" | "legacy";

/**
 * What a post-handshake request needs to know about the connection it is on.
 *
 * `version` is the *negotiated* revision, never the pinned constant. A server
 * receiving an `MCP-Protocol-Version` it did not agree to MUST answer 400, so
 * hardcoding `MCP_PROTOCOL_VERSION` — which is what this file did before the
 * legacy path existed — is how a legacy upstream comes to refuse every request
 * the proxy sends it.
 */
export interface WireContext {
  readonly dialect: McpDialect;
  readonly version: string;
  /** Legacy only, and only when the server assigned one. */
  readonly sessionId?: string;
}

/** What this proxy calls itself to an upstream. See `clientInfo` below. */
const CLIENT_NAME = "libero-proxy";
const CLIENT_VERSION = "0.0.1";

/** JSON-RPC codes this client discriminates on. Everything else is relayed as a number. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const METHOD_NOT_FOUND = -32601;


export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * A JSON-RPC notification: a message with no `id`, which is the whole of what
 * distinguishes it from a request.
 *
 * The absence is the protocol, so it is expressed as a separate type rather
 * than as an optional `id` — a shape with an `id` that happens to be missing is
 * one a later edit can fill in.
 */
export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * The `_meta` every request carries.
 *
 * **`clientInfo` names the product and nothing about the caller.** The spec
 * invites a client identity here, which makes this the one field on the wire
 * where the channel, the requesting user, or the task id would look like they
 * belonged. They do not: an upstream is a third party, and a field naming who
 * asked is a field that ends up in someone else's log. The proxy identifies
 * itself so an operator reading upstream logs can see which software called;
 * that is the whole purpose it serves here.
 *
 * `clientCapabilities` is empty and says so. The capabilities a client may
 * declare are for features this proxy deliberately does not offer an upstream —
 * sampling, elicitation, roots — and an empty object is the spec's way of
 * saying "none", which is the true answer rather than an omission.
 */
function requestMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: CLIENT_NAME, version: CLIENT_VERSION },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

/**
 * The version probe. Servers MUST implement it; clients MAY call it.
 *
 * This client always does, because the alternative is discovering a version
 * mismatch from a failed `tools/call` — which is a tool the model watched fail
 * for a reason that has nothing to do with the tool.
 */
export function discoverRequest(id: number): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "server/discover", params: { _meta: requestMeta() } };
}

/**
 * The `tools/call` request.
 *
 * **The name and the arguments, and nothing else.** The channel is not in it,
 * and neither is `requestingUser` or `task`: the upstream is a third party, and
 * a field carrying either is a field that ends up in someone else's log. Built
 * by naming the two fields explicitly rather than by spreading a
 * `ResolvedToolCall`, so a field added to that type later cannot reach an
 * upstream by default. (This paragraph moved here from `toolRequestBody`, which
 * this replaces.)
 *
 * `_meta` is the tempting exception and is handled the same way — see
 * `requestMeta`.
 *
 * **`_meta` is present on the stateless dialect and absent on the legacy one,
 * and that is not a simplification.** The three `io.modelcontextprotocol/*`
 * keys are `2026-07-28` inventions carrying what `initialize` has already told
 * a legacy server. Repeating them there would announce a protocol version the
 * server never agreed to, in the one field the transport also carries in a
 * header.
 *
 * The dialect is required rather than defaulted: a default is how a call site
 * comes to send the wrong one silently.
 */
export function toolsCallRequest(
  id: number,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  dialect: McpDialect
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
      ...(dialect === "stateless" ? { _meta: requestMeta() } : {})
    }
  };
}

/**
 * The `tools/list` request: one page of an upstream's catalog.
 *
 * The same `_meta` discipline as `toolsCallRequest`, for the same reason —
 * present on the stateless dialect, absent on the legacy one, because the three
 * `io.modelcontextprotocol/*` keys are `2026-07-28` inventions carrying what
 * `initialize` has already told a legacy server.
 *
 * `cursor` is omitted rather than sent as `null` when there is none. The spec
 * treats an absent cursor as "the first page" and an explicit one as a position
 * the server issued, so a `null` here would be this client inventing a third
 * state.
 *
 * Nothing about the channel travels in it, because there is nothing to send: a
 * catalog is the same for every channel that can reach the server, and which
 * tools a channel may *call* is a question this proxy answers from the team
 * sheet rather than one it asks an upstream.
 */
export function toolsListRequest(id: number, dialect: McpDialect, cursor?: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(dialect === "stateless" ? { _meta: requestMeta() } : {})
    }
  };
}

/**
 * The legacy handshake's opening move.
 *
 * Proposes `LEGACY_PROTOCOL_VERSION` rather than the pinned constant: this
 * request only exists because `server/discover` failed, so the server is by
 * construction not a `2026-07-28` server, and proposing the revision that
 * removed this very method is a proposal it cannot accept. The server names the
 * version it will actually speak in its reply — see `acceptedProtocolVersion`.
 *
 * The same discipline as `toolsCallRequest`: `clientInfo` names the product and
 * nothing about the caller, and `capabilities` is an explicit empty object
 * because sampling, elicitation and roots are features this proxy deliberately
 * does not offer an upstream. An empty object is the spec's way of saying
 * "none", which is the true answer rather than an omission.
 */
export function initializeRequest(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
    }
  };
}

/**
 * The acknowledgement a legacy server waits for before it will serve anything
 * else.
 *
 * A notification, so there is no id and no response to correlate: a server
 * answers 202 Accepted with an empty body. The caller checks the status and
 * reads nothing.
 */
export function initializedNotification(): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
}

/**
 * The headers the transport requires on every POST.
 *
 * `Mcp-Name` carries the tool name, which the spec says must be base64-encoded
 * through a sentinel form when it is not safely ASCII. It always is here:
 * `ResourceName` in the schema is `[A-Za-z0-9][A-Za-z0-9._-]*`, so a tool name
 * that reached this function has already been through a grammar that forbids
 * everything the encoding rule exists for. Stated rather than assumed, because
 * a later widening of `ResourceName` would need this to change with it.
 *
 * `MCP-Protocol-Version` must equal the `_meta` version or the server rejects
 * the request; on the stateless dialect both come from `MCP_PROTOCOL_VERSION`,
 * so they cannot disagree.
 *
 * **The two dialects send different headers because they define different
 * transports.** `Mcp-Method` and `Mcp-Name` are `2026-07-28` transport headers
 * and go out on that dialect alone. `MCP-Protocol-Version` goes out on both,
 * always carrying the *negotiated* revision: it arrived in `2025-06-18`, and a
 * server receiving a value it did not agree to MUST answer 400 — so a legacy
 * upstream sent the pinned constant would refuse every call. Sending it to a
 * `2025-03-26` server, which predates the header, is an unknown header that
 * server ignores, which is cheaper than a branch.
 */
export function requestHeaders(wire: WireContext, method: string, name?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": wire.version,
    ...(wire.dialect === "stateless"
      ? { "mcp-method": method, ...(name !== undefined ? { "mcp-name": name } : {}) }
      : {}),
    ...(wire.sessionId !== undefined ? { "mcp-session-id": wire.sessionId } : {})
  };
}

/**
 * The headers on the `initialize` POST: the one request that names no protocol
 * version.
 *
 * There is no negotiated revision yet — that is what the request is for — and
 * `MCP-Protocol-Version` naming one the server has not agreed to is precisely
 * the case the spec tells a server to answer 400 to. The version being proposed
 * travels in the body, where `initialize` expects it.
 *
 * Both framings are declared because a server may answer either, and may answer
 * 406 to a POST that does not accept both.
 */
export function initializeHeaders(): Record<string, string> {
  return { accept: "application/json, text/event-stream" };
}

/**
 * The headers on the shutdown `DELETE`.
 *
 * The session and the revision it was negotiated at, and nothing else: there is
 * no body to declare a type for and no answer this client reads.
 */
export function sessionTerminationHeaders(sessionId: string, version: string): Record<string, string> {
  return { "mcp-session-id": sessionId, "mcp-protocol-version": version };
}

/**
 * Every `data:` payload in an SSE body, in order.
 *
 * The whole body is already in hand — `callUpstream` reads to completion, so
 * this is string work over a finished stream rather than an incremental reader.
 * That is a deliberate limit: a server that holds its stream open after
 * answering hits the request timeout instead of returning, which fails safe and
 * slowly. Streaming instead of buffering is a filed follow-up, and it is a
 * change to the file holding the credential rather than to this one.
 *
 * Per the SSE grammar: fields are `name: value` with one optional leading
 * space, a line starting `:` is a comment, multiple `data:` lines in one event
 * join with a newline, and a blank line dispatches the event. Fields this
 * client does not use — `event`, `id`, `retry` — are skipped rather than
 * rejected, because a server is entitled to send them.
 */
export function eventStreamPayloads(body: string): string[] {
  const events: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) events.push(current.join("\n"));
    current = [];
  };

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) continue;

    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== "data") continue;

    const value = colon === -1 ? "" : rawLine.slice(colon + 1);
    current.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  // A stream that ends without a trailing blank line still delivered its event.
  flush();

  return events;
}

/** Why a response could not be read as an answer to the request that was sent. */
export type ProtocolFailure = "not_json" | "not_jsonrpc" | "no_message" | "id_mismatch" | "bad_result";

export type ParsedResponse =
  | { readonly kind: "result"; readonly result: Record<string, unknown> }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | { readonly kind: "malformed"; readonly reason: ProtocolFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON-RPC response to the request with this id.
 *
 * The content type decides the framing, rather than sniffing the first byte: a
 * parser that guesses is a parser that can be made to guess wrong, and
 * `callUpstream` hands back the declared type for exactly this.
 *
 * A server may interleave request-scoped notifications — progress, log
 * messages — on the response stream before the result. Those are messages
 * without an `id`, and they are skipped rather than treated as a mismatch. A
 * *response* bearing a different id is a real mismatch: the transport sends one
 * request per POST, so there is no other request it could belong to.
 *
 * Batching is gone as of `2026-07-28`, so a body is one message per event and
 * an array is not a thing to unwrap.
 *
 * **Known limit on the legacy path:** `2025-03-26` permitted batching, so a
 * server there could in principle answer with a single-element array, which
 * `isRecord` reports as `not_jsonrpc`. A server batches responses only in reply
 * to a batched request and this client never sends one, so the case is
 * theoretical — recorded here rather than grown into the parser, because the
 * branch would exist to handle something nothing can provoke.
 */
export function parseRpcResponse(contentType: string | undefined, body: string, id: number): ParsedResponse {
  const frames = (contentType ?? "").toLowerCase().includes("text/event-stream")
    ? eventStreamPayloads(body)
    : [body];

  let sawMessage = false;

  for (const frame of frames) {
    if (frame.trim() === "") continue;

    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      return { kind: "malformed", reason: "not_json" };
    }
    if (!isRecord(message)) return { kind: "malformed", reason: "not_jsonrpc" };
    sawMessage = true;

    // A notification relating to this request. Nothing here consumes them yet.
    if (!("id" in message)) continue;
    if (message["id"] !== id) return { kind: "malformed", reason: "id_mismatch" };

    const error = message["error"];
    if (isRecord(error)) {
      const code = typeof error["code"] === "number" ? error["code"] : 0;
      const raw = typeof error["message"] === "string" ? error["message"] : "";
      // `data` is deliberately not read: it is unbounded arbitrary JSON, where
      // `message` is the field the spec designates human-readable.
      return { kind: "error", code, message: relayedDetail(raw) };
    }

    const result = message["result"];
    if (!isRecord(result)) return { kind: "malformed", reason: "bad_result" };
    return { kind: "result", result };
  }

  return { kind: "malformed", reason: sawMessage ? "no_message" : "not_json" };
}

/**
 * The version to speak with this server over `server/discover`, or `null` if
 * there is no overlap.
 *
 * A server that omits `supportedVersions` is not assumed to agree. Failing here
 * costs one honest refusal; guessing costs a call made at a version the server
 * never accepted, which it may answer wrongly rather than reject.
 *
 * **`STATELESS_PROTOCOL_VERSIONS`, not `SUPPORTED_PROTOCOL_VERSIONS`.** This is
 * the sessionless path: a server answering `server/discover` with a revision
 * that requires a session would be agreed with here and then sent a
 * `tools/call` carrying no session, which it is entitled to answer wrongly
 * rather than reject. The legacy revisions are reachable only through
 * `initialize`, which is where a session comes from.
 */
export function negotiatedVersion(result: Record<string, unknown>): string | null {
  const advertised = result["supportedVersions"];
  if (!Array.isArray(advertised)) return null;
  for (const candidate of STATELESS_PROTOCOL_VERSIONS) {
    if (advertised.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * The revision a legacy server named in its `initialize` reply, or `null` if it
 * is not one this client speaks.
 *
 * The server is entitled to answer with a revision other than the one proposed,
 * and the spec says a client that does not support the answer SHOULD
 * disconnect — which here means failing closed before a call is made, for the
 * same reason `negotiatedVersion` does.
 *
 * `2026-07-28` is rejected here even though it is in
 * `SUPPORTED_PROTOCOL_VERSIONS`: a server answering `initialize` with the
 * revision that removed `initialize` has contradicted itself, and this client
 * has no way to tell which half it meant.
 */
export function acceptedProtocolVersion(result: Record<string, unknown>): string | null {
  const named = result["protocolVersion"];
  if (typeof named !== "string") return null;
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(named) ? named : null;
}

