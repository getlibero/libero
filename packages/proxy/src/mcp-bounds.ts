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

import {
  MAX_RESULT_MIME_TYPE,
  MAX_RESULT_URI,
  MAX_TOOL_DESCRIPTION,
  ToolInputSchema,
  ToolResultBlock,
  base64Bytes,
  describeBytes,
  omittedText,
  resultCost,
  resultText,
  textBlock
} from "@getlibero/schema";
import { RedactionError, type SecretScan } from "./redact.js";

/** How much upstream-authored text may appear inside a placeholder or an error line. */
const MAX_RELAYED_MESSAGE = 300;

/**
 * How long a label this module writes into a sentence of its own may be.
 *
 * The mime-type and URI bounds used to sit beside this one. They are
 * `MAX_RESULT_MIME_TYPE` and `MAX_RESULT_URI` in `@getlibero/schema` since #500,
 * because they stopped being this module's rendering detail the moment a label
 * started travelling inside a block the agent parses. This one stayed: what it
 * bounds is a block *type* name inside `[unsupported content block: …]`, which
 * never becomes a field of anything.
 */
const MAX_LABEL = 64;

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
  return text.length <= limit ? text : `${cutAt(text, limit - 1)}…`;
}

/**
 * At most `limit` code units, and never half a character.
 *
 * **One guard, one function, every site that cuts.** A cut that lands between a
 * surrogate pair leaves a lone high surrogate, which is not a character and is
 * not something to hand a provider: it survives `JSON.stringify` as `\ud83d`,
 * and what a tokenizer does with it is the provider's business rather than
 * something this proxy should be finding out per upstream. One code unit is
 * dropped, and only when the cut actually split one.
 *
 * The guard was `boundedText`'s alone until #509, which is how `truncate` above
 * and `render` in ./sandbox-dispatcher.ts — arbitrary program output, the
 * likeliest of the three to hold an emoji at an arbitrary offset — came to slice
 * without it. A caller still owns its notice and its ellipsis; what none of them
 * owns any more is where the cut lands, so a fourth cutting site is a call to
 * this rather than a fourth re-derivation.
 *
 * **The kept length is the number a notice reports**, not `limit`. They differ
 * by one on exactly the cases the guard fires for, and the kept length is what
 * the audit row's `result_bytes` counts.
 */
export function cutAt(text: string, limit: number): string {
  const kept = text.slice(0, Math.max(0, limit));
  const last = kept.charCodeAt(kept.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept;
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
 * One content block, as the block a `ToolResult` carries.
 *
 * **Binary payloads are relayed rather than named, which is #501 and is what
 * the placeholders were always waiting for.** Inlining base64 into text was
 * never the fix — it is not viewable as an image, and it would spend the
 * channel's token budget and inflate the audit row's byte count to deliver
 * something the model cannot use. That argument stands and is not what changed.
 * What changed is that #500 gave the wire a block for the payload itself, so
 * "name it" stopped being the only alternative to "inline it".
 *
 * The placeholders below survive as the answer for the three things a block
 * cannot be:
 *
 * - **a type no provider can be handed** — `resource_link`, and any block from
 *   a protocol revision newer than this tree knows. `ToolResultBlock` is a
 *   closed union for exactly this reason, and the placeholder is what keeps a
 *   forward-revision block costing a sentence rather than the whole call.
 * - **a payload that is not what it claims to be**, which is the load-bearing
 *   one. The agent parses `ToolCallResponse` with zod, so a block this proxy
 *   emits that does not satisfy `ToolResultBlock` is not a degraded result on
 *   the other side — it is a `malformed_response` that loses the call. The
 *   payload is therefore validated *here*, against the same schema the agent
 *   will parse it with, and anything that fails becomes a placeholder. Handing
 *   the parse the whole candidate rather than re-deriving its rules is what
 *   makes "everything this function emits parses over there" true by
 *   construction rather than by two files agreeing.
 * - **a payload the channel's cap will not pay for**, which is the caller's
 *   question rather than this one's; see `boundedToolResult`.
 *
 * Every label here is upstream-authored text, and truncating it is no longer
 * only about what enters the model's context. A `mimeType` over
 * `MAX_RESULT_MIME_TYPE` or a `uri` over `MAX_RESULT_URI` would fail the agent's
 * parse, so `truncate` is what keeps a hostile label a cosmetic problem instead
 * of a lost call.
 */
function toResultBlock(block: unknown): ToolResultBlock | null {
  if (!isRecord(block)) return null;

  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? textBlock(block["text"]) : null;

    case "image":
    case "audio": {
      const kind = block["type"] === "image" ? "image" : "audio";
      const mime = label(block["mimeType"], MAX_RESULT_MIME_TYPE);
      return relayed({ type: kind, data: block["data"], mimeType: mime }, kind, mime, block["data"]);
    }

    case "resource": {
      const resource = block["resource"];
      if (!isRecord(resource)) return null;
      // The text half of MCP's embedded resource renders as its own text, which
      // is why `ToolResultBlock`'s `resource` is the blob case alone: two shapes
      // for one thing would make every consumer know both.
      if (typeof resource["text"] === "string") return textBlock(resource["text"]);
      const mime = label(resource["mimeType"], MAX_RESULT_MIME_TYPE);
      return relayed(
        {
          type: "resource",
          uri: label(resource["uri"], MAX_RESULT_URI),
          ...(mime === undefined ? {} : { mimeType: mime }),
          blob: resource["blob"]
        },
        "resource",
        mime,
        resource["blob"]
      );
    }

    case "resource_link": {
      const uri = label(block["uri"], MAX_RESULT_URI) ?? "unknown";
      return textBlock(`[resource: ${uri}]`);
    }

    default: {
      const type = label(block["type"], MAX_LABEL) ?? "unnamed";
      return textBlock(`[unsupported content block: ${type}]`);
    }
  }
}

/** An upstream-authored label, bounded — or `undefined` where there was no string. */
function label(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? truncate(value, limit) : undefined;
}

/**
 * A candidate block if the agent will be able to parse it, and the placeholder
 * naming it if not.
 *
 * The size in the placeholder is the decoded one, as it has always been —
 * `describeBytes(base64Bytes(…))` — except where there is no payload string to
 * measure, which is `unknown size` exactly as before. A payload that failed the
 * parse because it is not base64 still gets a number from that arithmetic; it
 * is a length rather than a lie, and no better one exists for bytes nobody can
 * decode.
 */
function relayed(
  candidate: Record<string, unknown>,
  kind: "image" | "audio" | "resource",
  mimeType: string | undefined,
  payload: unknown
): ToolResultBlock {
  const parsed = ToolResultBlock.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const size = typeof payload === "string" ? describeBytes(base64Bytes(payload)) : "unknown size";
  return textBlock(omittedText(kind, mimeType, size));
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
 * the blocks produced no text at all — which since #501 includes a result whose
 * only blocks are binary, because those no longer render a sentence on the way
 * past. A server that answers with a screenshot and a structured summary now
 * relays both, and that is the reading rather than an accident: it said nothing
 * in text, and the fallback exists for exactly that.
 *
 * **The cap is one number over the whole result, walked in order.** Each block
 * is charged `resultCost`'s rule — a text block its characters, a binary block
 * its decoded bytes — against what is left of `maxChars`, and the two halves do
 * not degrade alike:
 *
 * - a **text** block past what remains is truncated and says where it was cut;
 * - a **binary** block that does not fit becomes its placeholder, because half
 *   a base64 payload is a corrupt image rather than a short one and there is no
 *   notice to append that would make it decode.
 *
 * In order, rather than by some best-fit over the array, because the order is
 * the server's own and the first thing it said is the thing it led with. The
 * consequence worth knowing is the ordinary one: with the default 32,768 a
 * screenshot does not fit, so **nothing binary reaches a model until an operator
 * raises a number** — the shape every other capability here takes.
 *
 * The walk stops once the budget is gone and says how many blocks it emitted of
 * how many there were, rather than degrading every remaining block to a
 * placeholder: how many blocks an upstream sends is the upstream's choice, and
 * a sentence per block is a way to spend a channel's budget the cap would not
 * otherwise permit. That notice is only reachable on a multi-block result, so
 * a single-block one — which is every result any producer in this tree emits —
 * carries exactly the characters it always did.
 *
 * **`maxChars` is required and has no default here.** It is the channel's, from
 * `[llm] max_result_chars` and whatever the tool's own entry overrode it with,
 * and a default in this signature is how a call site comes to spend a bound it
 * did not choose. The companion bound, on the bytes read off the wire, is the
 * deployment's and lives in ./outbound.ts; the two answer different questions
 * for different owners and neither substitutes for the other.
 *
 * **`scan` is what a payload costs on the way past, and it can end the call.**
 * The wire scan in ./outbound.ts has already redacted everything spelled
 * literally in this response, base64 included — but a credential *inside* a
 * decoded payload is a byte sequence no spelling of the value matches on the
 * wire. So a binary block that is about to cross is decoded and searched, and a
 * match throws `RedactionError`, which fails the whole result closed rather than
 * degrading one block: see `findSecret` for why there is no edit to make
 * instead, and ./http-dispatcher.ts for the rethrow that carries it out. Only
 * blocks that actually cross are scanned — one that the cap already degraded to
 * a placeholder has no bytes going anywhere, and paying for a decode to prove
 * something about bytes nobody will see is the wrong trade.
 */
export function boundedToolResult(
  result: Record<string, unknown>,
  maxChars: number,
  scan: SecretScan
): { content: ToolResultBlock[]; isError: boolean } | null {
  const blocks = result["content"];
  if (!Array.isArray(blocks)) return null;

  const promoted: ToolResultBlock[] = [];
  for (const block of blocks) {
    const mapped = toResultBlock(block);
    if (mapped === null) return null;
    promoted.push(mapped);
  }

  // Empty text rather than an empty array: a server that sends an empty text
  // block alongside structured content has still said nothing in text.
  //
  // Appended before the walk rather than after it, so the bound below covers the
  // structured fallback as well. Before #124 it covered only the ordinary path,
  // which is the branch an upstream would have picked to get around it.
  if (
    !promoted.some(block => block.type === "text" && block.text !== "") &&
    result["structuredContent"] !== undefined
  ) {
    promoted.push(textBlock(JSON.stringify(result["structuredContent"])));
  }

  const content: ToolResultBlock[] = [];
  let spent = 0;
  let emitted = 0;
  for (const block of promoted) {
    const remaining = maxChars - spent;
    if (remaining <= 0) break;

    if (block.type === "text") {
      const bounded = boundedText(block.text, remaining);
      content.push(textBlock(bounded.text));
      spent += bounded.spent;
      emitted += 1;
      // A cut text block has spent the rest of the budget by definition, so
      // there is nothing left for the blocks after it. Stopping here is what
      // makes the tail notice below reachable rather than decorative.
      if (bounded.spent < block.text.length) break;
      continue;
    }

    const cost = resultCost([block]);
    if (cost <= remaining) {
      // Only a block that is actually crossing is decoded and searched.
      if (scan(Buffer.from(payloadOf(block), "base64").toString("latin1")) !== null) {
        throw new RedactionError("binary_payload");
      }
      content.push(block);
      spent += cost;
      emitted += 1;
      continue;
    }

    // The placeholder is charged, unlike the truncation notice: the notice
    // reports a cut already made, while a placeholder is what the result now
    // says instead. A placeholder that does not itself fit ends the walk rather
    // than being emitted anyway, so an upstream cannot spend an unbounded
    // amount of a channel's budget by sending an unbounded number of blocks.
    const placeholder = resultText([block]);
    if (placeholder.length > remaining) break;
    content.push(textBlock(placeholder));
    spent += placeholder.length;
    emitted += 1;
  }

  // Only ever reachable on a multi-block result, so the single-block result
  // every producer in this tree emits today says exactly what it always did.
  if (emitted < promoted.length) {
    content.push(
      textBlock(`[result truncated: ${String(emitted)} of ${String(promoted.length)} content blocks]`)
    );
  }

  return { content, isError: result["isError"] === true };
}

/** The base64 a non-text block carries. */
function payloadOf(block: Extract<ToolResultBlock, { type: "image" | "audio" | "resource" }>): string {
  return block.type === "resource" ? block.blob : block.data;
}

/**
 * Bound one text block, and say where it was cut.
 *
 * **Characters, not bytes.** Every bound in this module counts characters —
 * `truncate`, `MAX_RELAYED_MESSAGE`, `MAX_LABEL` — and so does
 * `[llm] max_history_chars`, the sheet field this one sits beside. Slicing on
 * bytes would also mean cutting mid-sequence, and this text survives all the way
 * to a provider. The audit row's `result_bytes` still counts bytes, and that is
 * not an inconsistency: it answers a different question, existing to correlate
 * with the next turn's input tokens, and tokenizers are byte-shaped.
 *
 * **`spent` is the upstream's text that was kept, not the string returned.** The
 * notice is added past the limit rather than fitted inside it, as `truncate`'s
 * ellipsis already is — what the limit bounds is what the upstream said, and the
 * notice is this proxy's own, a fixed shape under sixty characters. Charging it
 * to the budget would let a long result's first cut eat the allowance of the
 * blocks after it.
 *
 * **The number recorded in the audit row is therefore the truncated length**,
 * which is the right one for what that column is for: the next turn's input
 * tokens are driven by what the model was handed, not by what the upstream sent.
 * The original size is not lost — it is in the notice, which the model reads.
 *
 * A `limit` of zero or less is reachable once an earlier block has spent the
 * whole allowance, and it yields the notice alone. That is a block saying "there
 * was more and you are not getting it", which is the same thing the notice
 * always said and better than a silently absent block.
 */
function boundedText(content: string, limit: number): { text: string; spent: number } {
  if (content.length <= limit) return { text: content, spent: content.length };

  const kept = cutAt(content, limit);

  return {
    text: `${kept}\n[result truncated: ${String(kept.length)} of ${String(content.length)} characters]`,
    spent: kept.length
  };
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
