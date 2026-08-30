// What an upstream is allowed to say, and how much of it.
//
// This module is policy, not protocol. It was the second half of the
// hand-rolled `mcp-protocol.ts`, and #188 kept it while retiring that file's
// wire format: the MCP SDK frames the messages now, but nothing in a protocol
// library has an opinion about how many characters of a tool result a *channel*
// may spend, or whether a description an upstream wrote is short enough for the
// listing schema the agent parses against. Those are this proxy's questions and
// they outlive whoever speaks the wire.
//
// **Two bounds, two owners, and neither substitutes for the other.** How many
// bytes come off the socket is the deployment's, lives in ./outbound.ts, and is
// the same number for every channel because the heap is. How much of a *result*
// reaches the model is the channel's, arrives per call on `CallLimits`, and is
// charged against its own token budget. A sheet cannot raise the first and the
// deployment does not care about the second.
//
// Everything here treats its input as hostile text. An upstream's description
// and schema enter the model's context on every turn, and a tool result enters
// it once — so every label is truncated, every unknown block type is named
// rather than inlined, and the one thing this module vouches for about a catalog
// entry is its name.

import { MAX_TOOL_DESCRIPTION, ToolInputSchema, base64Bytes, describeBytes } from "@getlibero/schema";
import type { ToolResultBlock } from "@getlibero/schema";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a result is the multi-round-trip interim shape rather than an answer.
 *
 * Kept after #188 even though the SDK, configured with
 * `inputRequired: { autoFulfill: false }`, raises rather than returning one.
 * The refusal it backs is a security property — the proxy does not answer
 * sampling or elicitation for a channel, because there is no sheet entry and no
 * click behind either — and a property like that is worth holding in two places.
 * The SDK's behaviour is a configuration flag; this is a read of the bytes.
 */
export function isInputRequired(result: Record<string, unknown>): boolean {
  return result["resultType"] === "input_required";
}

/**
 * At most `limit` characters, marker included.
 *
 * **The marker is inside the budget, not on top of it**, and that is a
 * correctness requirement rather than tidiness. `MAX_TOOL_DESCRIPTION` is
 * shared with `PermittedTool`'s `description: z.string().max(…)` precisely so
 * the proxy's bound and the agent's parse agree — its own comment says a proxy
 * bounding above the schema "would turn every chatty upstream into a
 * `malformed_response` on the agent side, which ends the task rather than
 * costing it a sentence". An ellipsis appended past the slice made that off by
 * one, so an upstream with a 1,025-character description took down every task
 * in every channel whose sheet named it. GitHub's `pull_request_read`
 * documents nine `method` values inline and is comfortably past the line, which
 * is how #130 found this.
 */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Bound an upstream-authored error body before it becomes a failure detail.
 *
 * A JSON-RPC error's `message` and a non-2xx body are both upstream-authored
 * text on their way into the model's context, and the first few hundred
 * characters are where an endpoint says what went wrong; everything past them is
 * a wall of text spending the channel's tokens on the way. Exported for the
 * client, not for `index.ts`.
 */
export function relayedDetail(text: string): string {
  return truncate(text, MAX_RELAYED_MESSAGE);
}

/**
 * One content block, as the one line of text a `ToolResult` can carry.
 *
 * **Binary payloads are named, not inlined — for now, and for a smaller
 * reason than before.** Inlining base64 into text was never the fix: it is not
 * viewable as an image, and it would spend the channel's token budget and
 * inflate the audit row's byte count to deliver something the model cannot use.
 * That argument is untouched. What has changed is that naming is no longer the
 * only alternative — #500 gave the wire a block for the payload itself, and
 * #501 is this function learning to reach for it. Every placeholder below
 * survives that as the answer for a type no provider can be handed, and for a
 * payload the channel's cap will not pay for.
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
 * A `CallToolResult` as the blocks and the one flag a `ToolResult` holds.
 *
 * `null` when the shape is not a `CallToolResult` at all, which the caller
 * reports as a protocol error rather than as an empty answer.
 *
 * **`structuredContent` is a fallback, not a supplement.** The spec tells
 * servers to mirror structured content into a text block, so reading both would
 * hand the model every well-behaved server's answer twice. It is used only when
 * the content array produced no text at all.
 *
 * **This still relays only text, and that is now a half-finished change rather
 * than a documented limit.** `ToolResult.content` stopped being a string in
 * #500, so the shape no longer forbids an image; what has not happened yet is
 * this function learning to promote one, which is #501. Until it does, every
 * result is the single text block below and `blockText` still names what it
 * cannot carry. The bound that promotion has to respect is already decided and
 * written down — see `resultCost` in `@getlibero/schema`.
 *
 * **`maxChars` is required and has no default here.** It is the channel's, from
 * `[llm] max_result_chars` and whatever the tool's own entry overrode it with,
 * and a default in this signature is how a call site comes to spend a bound it
 * did not choose. The companion bound, on the bytes read off the wire, is the
 * deployment's and lives in ./outbound.ts; the two answer different questions
 * for different owners and neither substitutes for the other.
 */
export function toolResultText(
  result: Record<string, unknown>,
  maxChars: number
): { content: ToolResultBlock[]; isError: boolean } | null {
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
  //
  // One exit rather than two, so the bound below covers the structured fallback
  // as well. Before this it covered only the ordinary path, which is the branch
  // an upstream would have picked to get around it.
  const content =
    joined === "" && result["structuredContent"] !== undefined
      ? JSON.stringify(result["structuredContent"])
      : joined;

  // One text block, which is every result this function can still produce.
  // #501 is what makes it emit more than one; until then the array is the
  // shape and the flattening above is unchanged.
  return { content: [{ type: "text", text: boundedResult(content, maxChars) }], isError };
}

/**
 * Bound the one string a `ToolResult` carries, and say where it was cut.
 *
 * **Characters, not bytes.** Every bound in this module counts characters —
 * `truncate`, `MAX_RELAYED_MESSAGE`, `MAX_LABEL`, `MAX_URI` — and so does
 * `[llm] max_history_chars`, the sheet field this one sits beside. Slicing on
 * bytes would also mean cutting mid-sequence, and this text survives all the way
 * to a provider. The audit row's `result_bytes` still counts bytes, and that is
 * not an inconsistency: it answers a different question, existing to correlate
 * with the next turn's input tokens, and tokenizers are byte-shaped.
 *
 * **What a binary block will cost is decided and is not this function's.** Since
 * #500 the cap is one number over the whole result, where a text block pays its
 * character count and a binary block pays its decoded bytes; `resultCost` in
 * `@getlibero/schema` is that rule and carries the argument for it. The
 * asymmetry to know before writing #501 is that binary has no equivalent of
 * what happens here — a payload past the cap degrades to `blockText`'s
 * placeholder rather than being sliced, because half a base64 payload is a
 * corrupt image rather than a short one, and there is no notice to append that
 * would make it decode.
 *
 * **The number recorded in the audit row is therefore the truncated length**,
 * which is the right one for what that column is for: the next turn's input
 * tokens are driven by what the model was handed, not by what the upstream sent.
 * The original size is not lost — it is in the notice, which the model reads.
 *
 * The notice is added past the limit rather than fitted inside it, as
 * `truncate`'s ellipsis already is. What the limit bounds is what the upstream
 * said; the notice is this proxy's own and is a fixed shape under sixty
 * characters. It says so in plain text rather than trailing off, because a
 * silently short answer is one the model has no reason to doubt.
 */
function boundedResult(content: string, limit: number): string {
  if (content.length <= limit) return content;

  let kept = content.slice(0, limit);
  // A cut that lands between a surrogate pair leaves a lone high surrogate,
  // which is not a character and is not something to hand a provider. One code
  // unit dropped, and only when the cut actually split one.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);

  return `${kept}\n[result truncated: ${String(kept.length)} of ${String(content.length)} characters]`;
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
 * **This function is why the client asks the SDK for a page against a permissive
 * result schema rather than the SDK's own.** The SDK validates `tools/list`
 * against the specification's shape, so a single entry whose `name` is a number
 * fails the *whole page* — which would hand any sloppy or hostile upstream a way
 * to blank the catalog of every tool beside it. Vouching for the envelope and
 * leaving the entries to this function is what keeps the rule above true after
 * #188, and it is the one place the proxy declines to reuse a parse the SDK
 * offers.
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
