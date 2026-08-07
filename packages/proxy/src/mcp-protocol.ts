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

/**
 * The revision this client speaks.
 *
 * Kept as a named constant in this module and nowhere else, because
 * `mcp-spec-watch.yml` parses this file for it and fails loudly if it cannot
 * find it. Renaming it is a CI failure rather than a silently dead watcher.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * The revisions this client can speak, newest first.
 *
 * One member today. `2026-07-28` removed sessions and the
 * `initialize`/`notifications/initialized` handshake, so an older server needs
 * a genuinely different client rather than a flag — that is #150, which extends
 * this list rather than reinterpreting it.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION];

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

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
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
 */
export function toolsCallRequest(
  id: number,
  tool: string,
  args: Readonly<Record<string, unknown>>
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args, _meta: requestMeta() }
  };
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
 * the request; both come from `MCP_PROTOCOL_VERSION`, so they cannot disagree.
 */
export function requestHeaders(method: string, name?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name !== undefined ? { "mcp-name": name } : {})
  };
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
 * The version to speak with this server, or `null` if there is no overlap.
 *
 * A server that omits `supportedVersions` is not assumed to agree. Failing here
 * costs one honest refusal; guessing costs a call made at a version the server
 * never accepted, which it may answer wrongly rather than reject.
 */
export function negotiatedVersion(result: Record<string, unknown>): string | null {
  const advertised = result["supportedVersions"];
  if (!Array.isArray(advertised)) return null;
  for (const candidate of SUPPORTED_PROTOCOL_VERSIONS) {
    if (advertised.includes(candidate)) return candidate;
  }
  return null;
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
