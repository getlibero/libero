// The MCP wire format, as pure functions.
//
// No `Secret`, no `fetch`, no `Vault`, no I/O of any kind. The split is the one
// ./redact.ts and ./outbound.ts already draw: the rules live apart from the
// custody, so the rules can be tested exhaustively without standing anything
// up, and a reviewer reading the custody file is not also reading a parser.
//
// **Hand-rolled rather than taken from `@modelcontextprotocol/sdk`, and the
// reason is structural rather than about dependency count.** The SDK's
// streamable-HTTP transport owns its own `fetch` and builds its own headers, so
// the credential would be revealed and attached outside `callUpstream` — which
// is exactly the argument outbound.ts:15-27 makes for why redaction is total.
// A wrapper could restore it, but the guarantee would go from "true by
// construction, checkable with one grep" to "true because we wrapped it
// carefully", in the process that holds every tool credential. The SDK also
// brings express, hono, jose, and cross-spawn into that process's install tree,
// which ./server.ts's dependency rule exists to prevent.
//
// The cost of that choice is that this repo owns a moving protocol. It is paid
// for by keeping the version constants below in one place and by
// .github/workflows/mcp-spec-watch.yml, which opens an issue when the spec
// publishes a revision past the one pinned here.
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
// The one import is `@getlibero/schema`, for two bounds the agent's parser
// enforces from the other end. Shared rather than restated: a proxy truncating
// a description at one number against a schema rejecting at another turns every
// chatty upstream into a parse failure that ends a task.

import { MAX_TOOL_DESCRIPTION, ToolInputSchema } from "@getlibero/schema";

/**
 * The revision this client speaks.
 *
 * Kept as a named constant in this module and nowhere else, because
 * `mcp-spec-watch.yml` parses this file for it and fails loudly if it cannot
 * find it. Renaming it is a CI failure rather than a silently dead watcher.
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
 * **Not named `LEGACY_MCP_PROTOCOL_VERSION`, deliberately.**
 * `.github/workflows/mcp-spec-watch.yml` greps this file for
 * `MCP_PROTOCOL_VERSION = "…"` with an unanchored pattern, so a constant whose
 * name merely *ends* in that would match as a substring and break the
 * comparison without tripping the workflow's missing-constant guard.
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

/** How much upstream-authored text may appear inside a placeholder or an error line. */
const MAX_RELAYED_MESSAGE = 300;
const MAX_LABEL = 64;
const MAX_URI = 200;

/**
 * How large an upstream's input schema may be before this proxy declines to
 * publish it.
 *
 * Bigger than any hand-written schema and small enough that a hundred of them
 * are not a context window. The companion cap on descriptions lives in
 * `@getlibero/schema`, because the agent's parser needs the same number; this
 * one does not cross the wire, because the shape rule already means an
 * oversized schema is simply absent rather than truncated.
 */
const MAX_TOOL_SCHEMA_BYTES = 8192;

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
      return { kind: "error", code, message: truncate(raw, MAX_RELAYED_MESSAGE) };
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

/** How long a session id may be before this client declines to replay it. */
const MAX_SESSION_ID = 512;

/**
 * The session id the server assigned, or `null` if it assigned none this client
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
 */
export function readSessionId(header: string | undefined): string | null {
  if (header === undefined || header.length === 0 || header.length > MAX_SESSION_ID) return null;
  return /^[\x21-\x7E]+$/.test(header) ? header : null;
}

/** Whether a result is the multi-round-trip interim shape rather than an answer. */
export function isInputRequired(result: Record<string, unknown>): boolean {
  return result["resultType"] === "input_required";
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Bound an upstream-authored error body before it becomes a failure detail.
 *
 * `parseRpcResponse` caps a JSON-RPC error's `message`, but a non-2xx body
 * never reaches it, so the caller relaying that body applies the same cap
 * through this. The first few hundred characters are where an endpoint says
 * what went wrong; everything past them is a wall of text spending the
 * channel's tokens on the way to the model. Exported for the client, not for
 * `index.ts` — like the framing helpers, it leaves this module and no further.
 */
export function relayedDetail(text: string): string {
  return truncate(text, MAX_RELAYED_MESSAGE);
}

/** Base64 decodes to three bytes per four characters, less the padding. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function describeBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`;
  return `${Math.round(count / (1024 * 1024))} MB`;
}

/**
 * One content block, as the one line of text a `ToolResult` can carry.
 *
 * **Binary payloads are named, not inlined.** `ToolResult.content` is a string
 * that becomes a `tool_result` block in the model's context, where a base64
 * blob is neither viewable as an image nor cheap: it would spend the channel's
 * token budget and inflate the audit row's byte count to deliver something the
 * model cannot use. Naming the type and the size tells the model a thing came
 * back and what it was, which is what lets it say so rather than retry.
 *
 * Every label here is upstream-authored text entering the model's context, so
 * every one is truncated. A hostile `mimeType` gets 64 characters, not a
 * paragraph.
 */
function blockText(block: unknown): string | null {
  if (!isRecord(block)) return null;

  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? block["text"] : null;

    case "image":
    case "audio": {
      const kind = block["type"] === "image" ? "image" : "audio";
      const mime = typeof block["mimeType"] === "string" ? truncate(block["mimeType"], MAX_LABEL) : "unknown";
      const size = typeof block["data"] === "string" ? describeBytes(base64Bytes(block["data"])) : "unknown size";
      return `[${kind} omitted: ${mime}, ${size}]`;
    }

    case "resource": {
      const resource = block["resource"];
      if (!isRecord(resource)) return null;
      if (typeof resource["text"] === "string") return resource["text"];
      const mime = typeof resource["mimeType"] === "string" ? truncate(resource["mimeType"], MAX_LABEL) : "unknown";
      const size = typeof resource["blob"] === "string" ? describeBytes(base64Bytes(resource["blob"])) : "unknown size";
      return `[resource omitted: ${mime}, ${size}]`;
    }

    case "resource_link": {
      const uri = typeof block["uri"] === "string" ? truncate(block["uri"], MAX_URI) : "unknown";
      return `[resource: ${uri}]`;
    }

    default: {
      const type = typeof block["type"] === "string" ? truncate(block["type"], MAX_LABEL) : "unnamed";
      return `[unsupported content block: ${type}]`;
    }
  }
}

/**
 * A `CallToolResult` as the one string and one flag a `ToolResult` holds.
 *
 * `null` when the shape is not a `CallToolResult` at all, which the caller
 * reports as a protocol error rather than as an empty answer.
 *
 * **`structuredContent` is a fallback, not a supplement.** The spec tells
 * servers to mirror structured content into a text block, so reading both would
 * hand the model every well-behaved server's answer twice. It is used only when
 * the content array produced no text at all.
 *
 * Relaying only text is a documented limit rather than an oversight: images,
 * audio, and binary resources need `ToolResult.content` to stop being a string,
 * which is a change across the schema, the agent, and every provider adapter.
 * That is a filed follow-up.
 */
export function toolResultText(result: Record<string, unknown>): { content: string; isError: boolean } | null {
  const blocks = result["content"];
  if (!Array.isArray(blocks)) return null;

  const rendered: string[] = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (text === null) return null;
    rendered.push(text);
  }

  const isError = result["isError"] === true;
  const joined = rendered.join("\n");

  // Empty text rather than an empty array: a server that sends an empty text
  // block alongside structured content has still said nothing in text.
  if (joined === "" && result["structuredContent"] !== undefined) {
    return { content: JSON.stringify(result["structuredContent"]), isError };
  }

  return { content: joined, isError };
}

/**
 * One tool as an upstream described it, before any of it is believed.
 *
 * `description` and `inputSchema` are `unknown` rather than typed, and that is
 * the point: the only field this module vouches for is `name`, because a name
 * is what a page of a catalog is indexed by. The two describing fields go
 * through `boundedToolDescription` and `boundedToolInputSchema` before anything
 * publishes them, and keeping them `unknown` here means a caller cannot skip
 * that by accident.
 */
export interface UpstreamToolEntry {
  readonly name: string;
  readonly description: unknown;
  readonly inputSchema: unknown;
}

/**
 * One page of a `tools/list` result, or `null` when the shape is not one at all.
 *
 * **An unreadable entry is skipped; an unreadable page is refused.** That is the
 * opposite of `toolResultText`, which fails a whole result on one bad block, and
 * the difference is what the two are for. A partial tool *answer* misleads —
 * the model reads it as everything the tool said. A partial *catalog* does not:
 * every tool it omits falls back to the entry the team sheet already produced,
 * which is a defined state with a defined meaning. Refusing the page over one
 * malformed entry would cost every other tool on it its schema.
 *
 * `nextCursor` is `null` unless the server sent a non-empty string. An empty
 * one is the spec's own end-of-pagination signal read the safe way: a cursor
 * this client cannot distinguish from the one it just used is a loop.
 */
export function parseToolsList(
  result: Record<string, unknown>
): { tools: UpstreamToolEntry[]; nextCursor: string | null } | null {
  const listed = result["tools"];
  if (!Array.isArray(listed)) return null;

  const tools: UpstreamToolEntry[] = [];
  for (const entry of listed) {
    if (!isRecord(entry)) continue;
    const name = entry["name"];
    if (typeof name !== "string" || name === "") continue;
    tools.push({ name, description: entry["description"], inputSchema: entry["inputSchema"] });
  }

  const cursor = result["nextCursor"];
  return { tools, nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null };
}

/**
 * An upstream's description, bounded to what may enter a model's context.
 *
 * Truncated rather than dropped, because a cut-off sentence still tells the
 * model more about `create_issue` than silence does — the opposite call from
 * the schema below, which cannot be shortened and stay valid. `undefined` for
 * anything that is not a non-empty string, so the absence the caller sees means
 * one thing rather than three.
 */
export function boundedToolDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : truncate(trimmed, MAX_TOOL_DESCRIPTION);
}

/** Why an upstream's input schema will not be published. */
export type SchemaRejection = "not_an_object" | "not_type_object" | "too_large";

/**
 * An upstream's input schema, or the reason it will not be published.
 *
 * **Returns the value it was given, not zod's output.** The shape rule is a
 * gate, never a rewrite: what reaches the provider is the bytes the upstream
 * wrote, so "passed through unmodified" is a fact about this function rather
 * than a claim about it.
 *
 * All-or-nothing, unlike a description. A schema cannot be shortened and stay a
 * schema, and half of one is worse than none — the model would form arguments
 * against a contract nobody holds. Its absence is a defined state: the agent
 * falls back to the open object it published before any of this existed.
 *
 * The `JSON.stringify` is wrapped because a self-referential or BigInt-bearing
 * value throws rather than returning a string, and a schema this proxy cannot
 * even measure is one it will not relay. `too_large` is the honest answer to
 * both — the caller does nothing different for either, and inventing a fourth
 * reason would be a distinction with no consequence.
 */
export function boundedToolInputSchema(
  value: unknown
): { readonly ok: true; readonly schema: ToolInputSchema } | { readonly ok: false; readonly reason: SchemaRejection } {
  if (!isRecord(value)) return { ok: false, reason: "not_an_object" };
  if (!ToolInputSchema.safeParse(value).success) return { ok: false, reason: "not_type_object" };

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return { ok: false, reason: "too_large" };
  }
  if (bytes > MAX_TOOL_SCHEMA_BYTES) return { ok: false, reason: "too_large" };

  // The value that arrived, asserted rather than reparsed. `safeParse` has just
  // established the one thing the type claims, and taking zod's output instead
  // would make "passed through unmodified" false — zod builds a new object.
  return { ok: true, schema: value as ToolInputSchema };
}
