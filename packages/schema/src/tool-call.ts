import { z } from "zod";
import { ApprovalTicket } from "./approval.js";
import { BudgetWarning } from "./budget-warning.js";
import { ApprovalTicketId, CHANNEL_ID_PATTERN, RequestingUser, ResourceName, TaskId } from "./names.js";
import { ToolRefusal } from "./refusal.js";

/**
 * The tool call the agent sends the proxy, and what it becomes once the proxy
 * has bound it to a channel.
 *
 * These are two shapes on purpose. The channel id comes from the client
 * certificate and from nowhere else — the process on the other end runs the
 * model, so anything the model can influence is not a boundary. `ToolCall` is
 * therefore what travels on the wire and it has no channel field, while
 * `ResolvedToolCall` is what enforcement consumes and is constructed only
 * inside the proxy, from an identity the TLS layer already proved.
 *
 * `ToolCall` is strict, which is the part that matters. An agent that tries to
 * assert a channel in the request body does not get the field quietly dropped;
 * the parse fails and the attempt is visible in the proxy's log. A field that
 * must be ignored to stay safe is a trap for whoever wires up the next
 * endpoint, so there is no such field.
 *
 * `ToolCall` does carry two fields the agent asserts — `requestingUser` and
 * `task` — and they are not a hole in that argument, because nothing
 * authorizes on them. The line to hold is the one this file draws: what a
 * decision reads must be proved, and what the audit log reads may be asserted.
 * Each field says which it is; see their doc comments before adding a third.
 */

export const ToolCall = z
  .object({
    /**
     * Correlates the proxy's answer with the model's tool-use block. Opaque to
     * the proxy: it is echoed back, never parsed for meaning.
     */
    id: z.string().min(1).max(128),
    server: ResourceName,
    tool: ResourceName,
    /**
     * The model's arguments, passed through to the tool. Open by necessity —
     * the shape is the tool's JSON Schema, which the proxy validates against
     * the definition it published rather than against anything fixed here.
     */
    arguments: z.record(z.string(), z.unknown()).default({}),

    /**
     * Who asked: the Slack user behind the mention that started the task.
     *
     * **Attribution, not authentication — and nothing may ever authorize on
     * it.** The channel id is different, and the difference is the whole point.
     * A channel is proved: it comes from the client certificate's
     * `CN=channel:<id>` and from nowhere else, so the process running the model
     * cannot assert one. There is no per-user certificate, so this field is
     * asserted by the agent process, and an agent under an attacker's control
     * can put any user id here it likes.
     *
     * That is acceptable *only* because no decision reads it. It is written to
     * the audit log so a human can see who asked, and it must never become an
     * input to enforcement: no per-user allowlists, no "these users skip
     * approval", nothing in packages/proxy/src/enforce.ts that branches on it.
     * A rule built on this field would be a rule a compromised agent rewrites
     * by editing a string.
     *
     * Approval identity is a different thing and a stronger one. The broker
     * takes the approver from a Slack interaction payload, which gateway code
     * observes rather than the model producing it — so it holds against a
     * prompt-injected model, where this field does not. It is still relayed by
     * the agent process, so it does not hold against a compromised one; see
     * `ApproverId`. Stronger, and not unconditional.
     */
    requestingUser: RequestingUser,

    /**
     * Which task this call was part of: the id grouping every call one ReAct
     * run made.
     *
     * Minted by the agent loop, once per task, and never by the model. Same
     * standing as `requestingUser` above — the audit log reads it to reconstruct
     * one request's work, and enforcement does not read it at all. A model that
     * could choose this id could make two tasks look like one, which changes
     * what a log says without changing what a decision does; keeping it out of
     * the decision is what keeps that harmless.
     */
    task: TaskId,

    /**
     * The approval ticket this call is a re-submission of, when it is one.
     *
     * Optional, and **explicitly declared** — this object is `.strict()`, and a
     * field that had to be tolerated rather than designed is exactly the trap
     * that strictness exists to remove. Absent on a first submission, which is
     * the only kind of call there was before the approval broker.
     *
     * Unlike the two fields above, a decision **does** read this one, so the
     * rule they state — what a decision reads must be proved — has to hold for
     * it. It does, in a way neither of them could: the ticket proves nothing by
     * itself. It is matched against a record the proxy minted from its own
     * observation of the held call, in the channel the certificate named,
     * single-use, and expiring; and the team sheet is enforced again at
     * redemption, so redeeming one never widens what this channel may call. All
     * it can answer is "a human approved this exact call", and a compromised
     * agent inventing a value here gets a refusal, not a call.
     */
    ticket: ApprovalTicketId.optional()
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCall>;

/**
 * A call bound to the channel that made it.
 *
 * Every enforcement decision is a pure function of (team sheet, resolved call),
 * so this is the shape the allowlist, approval, budget, and egress checks take.
 *
 * A type and a constructor, deliberately, with **no zod schema** — because a
 * schema would have a `.parse()`, and `ResolvedToolCall.parse(requestBody)`
 * is a single plausible-looking line that takes the channel from the body and
 * puts the whole design back where it started. A comment saying "don't" is the
 * kind of care this shape is supposed to make unnecessary, so the parse surface
 * is not there to misuse. `resolveToolCall` takes an already-parsed `ToolCall`,
 * which means a raw body cannot be handed to it either.
 */
export type ResolvedToolCall = ToolCall & {
  /** From the client certificate's `CN=channel:<id>`. Not from the request. */
  readonly channel: string;
};

/**
 * Bind a parsed call to the channel the connection authenticated as.
 *
 * The channel is re-checked against `CHANNEL_ID_PATTERN` even though the proxy
 * resolved it from a certificate and already validated it there. This is the
 * second of two, not the only one: the id becomes a directory name and a
 * SQLite filename downstream, and a caller reaching this with an id from
 * anywhere but an identity resolver is the mistake worth catching loudly.
 *
 * Throws rather than returning a result. Every caller is inside the proxy with
 * an id it has already validated, so a failure here is a wiring bug and not a
 * condition to handle — and the thrown value carries no id, because in this
 * process an exception is a thing that gets logged.
 */
export function resolveToolCall(call: ToolCall, channel: string): ResolvedToolCall {
  if (!CHANNEL_ID_PATTERN.test(channel)) {
    throw new Error("resolveToolCall: channel is not a valid channel id");
  }
  return { ...call, channel };
}

/**
 * How much upstream-authored label text one block may carry.
 *
 * These are the proxy's own `MAX_LABEL` and `MAX_URI`, and they live here now
 * because they stopped being one module's rendering detail the moment a block
 * became a shape both ends parse. The agent's adapters hand these strings to a
 * provider, so the bound belongs to the contract rather than to a promise the
 * proxy makes on its way out.
 */
export const MAX_RESULT_MIME_TYPE = 64;
export const MAX_RESULT_URI = 200;

/**
 * One part of what a tool produced (#160).
 *
 * `ToolResult.content` was a single string until this union existed, and the
 * cost of that was written down where it was paid: `blockText` in
 * `packages/proxy/src/mcp-bounds.ts` rendered every image, every audio clip and
 * every binary resource as a sentence naming the type and the size, because a
 * string is the only thing it had to render into. A tool whose whole answer is
 * a screenshot was therefore second-class, and a proxy that governs tool use
 * should not be the reason a capability is unavailable.
 *
 * ## Four types, and what is deliberately not among them
 *
 * `text`, `image`, `audio`, `resource` — the vocabulary #160 names, defined
 * once here so that #501 and #502 relay into it rather than each widening the
 * wire again.
 *
 * MCP's `resource_link`, its deprecated `tool_use`, and any block from a
 * protocol revision newer than the one this tree knows are **not** members, and
 * that is not an omission. The proxy flattens each of them to a `text` block
 * carrying the placeholder it already writes. This is `CallEnvelope`'s bargain
 * one layer on (`packages/proxy/src/mcp-client.ts`): that reader passes
 * `z.looseObject({})` precisely so a forward-revision block costs a placeholder
 * rather than the whole call, and a closed union here is what keeps that true
 * on this side of the wire too. A block type earns membership when a provider
 * can be handed it, not when a server can emit it.
 *
 * `resource` is the **blob** case alone. MCP's embedded resource is a union of
 * text-or-blob, and the text half already renders as its own text — promoting
 * it would be two shapes for one thing, and a consumer would have to know both.
 *
 * ## The payload is validated as base64, not merely as a string
 *
 * `z.base64()` rather than `z.string()`. Nothing downstream can decode a
 * payload that is not base64, so the alternative is not leniency but a failure
 * moved later, into a provider's SDK or a provider's API — past the point where
 * this proxy could say which tool produced it. This parse is the last place the
 * question can be asked cheaply.
 *
 * ## Array-only, and no bare string beside it
 *
 * `ToolResult.content` is an array and nothing else. A union that still
 * accepted a string would buy tolerance of a version skew this deployment
 * cannot have — one `v*` tag releases both services together (`RELEASING.md`) —
 * and would charge every consumer a branch, forever, on a shape that is
 * normalized on read. That is the trap this file's own header names: a field
 * whose two forms must be reconciled to be safe is one the next endpoint gets
 * wrong. The empty array is legal and is what the old `content: ""` becomes.
 */
export const ToolResultBlock = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      /** The image itself, base64. Bounded by the channel's cap; see `resultCost`. */
      data: z.base64(),
      mimeType: z.string().min(1).max(MAX_RESULT_MIME_TYPE)
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      data: z.base64(),
      mimeType: z.string().min(1).max(MAX_RESULT_MIME_TYPE)
    })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      uri: z.string().min(1).max(MAX_RESULT_URI),
      mimeType: z.string().min(1).max(MAX_RESULT_MIME_TYPE).optional(),
      blob: z.base64()
    })
    .strict()
]);

export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

/**
 * What a tool produced, once it ran.
 *
 * `isError` marks a failure the model should see and may recover from — a 404
 * from the tool, a bad argument. It is not an enforcement outcome and not a
 * transport failure; both of those are other variants of `ToolCallResponse`.
 * Mirrors the agent loop's `ToolResult`, which is the shape this becomes on
 * the other side of the wire — and as of #160 that sentence is true again only
 * once #502 lands, because the loop still holds a string until it does.
 *
 * `content` is a block array; see `ToolResultBlock` for why it is only that.
 */
export const ToolResult = z
  .object({
    content: z.array(ToolResultBlock),
    isError: z.boolean().default(false)
  })
  .strict();

export type ToolResult = z.infer<typeof ToolResult>;

/**
 * The degenerate result: one block, holding one string.
 *
 * Every producer on both sides of the wire that answers in text builds this —
 * the proxy's built-ins, its sandbox, its transport failures, the agent loop's
 * cap notes and tool errors, and every test that stands a result up. Before
 * #501 there were six copies of the same two-line literal, which is the shape
 * that drifts: the day a text block gains a field, five of them are still
 * right and one is not.
 *
 * Named for what it makes rather than for what it takes, because the reason to
 * reach for it is that a block is the unit now.
 */
export function textBlock(text: string): ToolResultBlock {
  return { type: "text", text };
}

/** Base64 decodes to three bytes per four characters, less the padding. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A byte count as the model is told it: `bytes` under a kilobyte, then `KB`, then `MB`. */
export function describeBytes(count: number): string {
  if (count < 1024) return `${String(count)} bytes`;
  if (count < 1024 * 1024) return `${String(Math.round(count / 1024))} KB`;
  return `${String(Math.round(count / (1024 * 1024)))} MB`;
}

/**
 * What one result costs against the channel's `[llm] max_result_chars`.
 *
 * **One cap, over the whole result, and a non-text block pays its decoded
 * bytes.** A text block contributes `text.length` — UTF-16 code units, which is
 * exactly the number the cap counted when content was a string, so no channel's
 * existing setting changes meaning. A binary block contributes the size of what
 * it actually carries, not the four-thirds of it that base64 spells.
 *
 * Two readings were available and are worth recording as declined. **Per
 * block** is simpler to state and wrong: a result of forty blocks would then be
 * forty times a cap the operator agreed to once. **A second, byte-denominated
 * bound for binary alone** keeps the units honest — `max_result_chars` would go
 * on meaning characters of text — but it introduces a number that exists in no
 * sheet and no environment variable today, and an operator cannot reason about
 * a ceiling they have never seen. One number they already tune is worth more
 * than two that are each individually cleaner.
 *
 * The unit mismatch inside this sum is real and is the price: it means the cap
 * is a budget rather than a measurement. What it buys is that the default of
 * 32768 already bounds an image, so **nothing binary reaches a model until an
 * operator raises a number**, which is the same shape as every other capability
 * in this tree being off until a sheet says otherwise.
 *
 * What happens past the cap is the proxy's (`mcp-bounds.ts`), and it is not
 * symmetric: text truncates and says where it was cut, while a binary block
 * degrades to its placeholder rather than being sliced. Half a base64 payload
 * is a corrupt image, not a short one, and there is no notice to append that
 * would make it decode.
 */
export function resultCost(content: readonly ToolResultBlock[]): number {
  let total = 0;
  for (const block of content) {
    total += block.type === "text" ? block.text.length : blockBytes(block);
  }
  return total;
}

/**
 * What the audit row's `result_bytes` records: the wire cost of what crossed.
 *
 * Bytes, not `String.length`, for the reason that column has always given —
 * it exists to correlate with the next turn's input tokens, and tokenizers are
 * byte-shaped. Text is counted utf8; a binary block is counted **decoded**,
 * which is the second decision worth writing down.
 *
 * Encoded length was the alternative, and it is closer to what the transport
 * actually moved. It loses on two counts. It disagrees with the sentence the
 * model is handed — `[image omitted: image/png, 4823 bytes]` has always been
 * decoded — so an operator reading the audit log and a model reading the
 * placeholder would be quoting different numbers for one payload. And it would
 * inflate the column by a third against every row already written, on a
 * measure whose whole purpose is comparison over time.
 *
 * This is deliberately **not** `resultCost`. They agree on binary and differ on
 * text, because one answers "what may this channel spend" and the other answers
 * "what did this call move"; a single function serving both would have to pick
 * a wrong answer for one of them.
 */
export function resultBytes(content: readonly ToolResultBlock[]): number {
  let total = 0;
  for (const block of content) {
    total += block.type === "text" ? Buffer.byteLength(block.text, "utf8") : blockBytes(block);
  }
  return total;
}

/**
 * The same total, split by block type: what the audit row records as *what*
 * crossed (#501).
 *
 * The same per-block rule as `resultBytes` — this is that function grouped, not
 * a third measure — so the values sum to it exactly and a reader can check one
 * against the other. A type with no block is **absent rather than zero**: the
 * row is a record of what crossed, and a zero would be a claim that an empty
 * image crossed.
 *
 * Text is included even though its count is the same utf8 length the total
 * already gives for a text-only result, because the reader's question is a
 * proportion. A result that is 400 bytes of text and 40 KB of image is a
 * different thing from one that is 40 KB of text, and the total alone cannot
 * tell them apart.
 */
export function resultBytesByType(
  content: readonly ToolResultBlock[]
): Partial<Record<ToolResultBlock["type"], number>> {
  const totals: Partial<Record<ToolResultBlock["type"], number>> = {};
  for (const block of content) {
    const bytes = block.type === "text" ? Buffer.byteLength(block.text, "utf8") : blockBytes(block);
    totals[block.type] = (totals[block.type] ?? 0) + bytes;
  }
  return totals;
}

/** The decoded size of a block's payload. Zero for text, which has none. */
function blockBytes(block: ToolResultBlock): number {
  switch (block.type) {
    case "text":
      return 0;
    case "image":
    case "audio":
      return base64Bytes(block.data);
    case "resource":
      return base64Bytes(block.blob);
  }
}

/**
 * A result as the one string a text-only consumer can take.
 *
 * Two callers need this and they are on opposite sides of the wire: the proxy,
 * wherever it still owes a string, and the agent's OpenAI adapter, whose
 * `role: "tool"` message has no block form to relay into. The placeholder
 * sentences are therefore written **once, here**, rather than in each — they
 * are text a model reads and reasons about, which makes their wording a
 * compatibility surface rather than a rendering detail. They match what
 * `mcp-bounds.ts` has always emitted, character for character.
 *
 * Blocks join with a newline, as the proxy's own join always has.
 */
export function resultText(content: readonly ToolResultBlock[]): string {
  return content.map(blockToText).join("\n");
}

function blockToText(block: ToolResultBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
    case "audio":
      return omittedText(block.type, block.mimeType, describeBytes(base64Bytes(block.data)));
    case "resource":
      return omittedText("resource", block.mimeType, describeBytes(base64Bytes(block.blob)));
  }
}

/**
 * The sentence naming a payload a consumer was not handed.
 *
 * **The one writer, because there are two kinds of caller and only one
 * wording.** `blockToText` above renders a well-formed block this way for a
 * text-only provider. The proxy renders the same sentence for something that
 * never became a block at all — an upstream's `resource_link`, a block type
 * from a protocol revision this tree does not know, a payload that is not
 * valid base64 — where there is no `ToolResultBlock` to hand this function's
 * sibling. Both are text a model reads and reasons about, so the wording is a
 * compatibility surface rather than a rendering detail, and two writers of it
 * would agree on the day they were written.
 *
 * `size` is pre-rendered rather than a number because the second kind of caller
 * may not know it: a payload it could not decode has no size to describe, and
 * `unknown size` is what the proxy has always said in that case.
 *
 * An absent or empty `mimeType` reads as `unknown`. The schema requires one on
 * an image or an audio block, so that case only arises on the degraded path.
 */
export function omittedText(
  kind: "image" | "audio" | "resource",
  mimeType: string | undefined,
  size: string
): string {
  return `[${kind} omitted: ${mimeType === undefined || mimeType === "" ? "unknown" : mimeType}, ${size}]`;
}

/**
 * The proxy's answer to a tool call.
 *
 * All three variants are **served requests** — HTTP 200 — because a refusal is
 * the system working rather than a failure. `ProxyError` stays what it was:
 * the shape of a request that could not be answered at all. Keeping refusals
 * off that shape is what lets the agent relay one to the channel without
 * having to tell "the call was not permitted" apart from "the proxy broke".
 *
 * `held` is separate from `refused` on purpose. Both mean the call did not
 * run, but a hold is a question put to a human and a refusal is an answer, and
 * the approval broker needs to tell them apart without re-deriving the
 * distinction from the refusal reason.
 *
 * A hold now carries the ticket that makes it answerable, and still carries the
 * full refusal beside it. That is the degradation rather than the point: a
 * client that ignores the ticket and relays the hold as an ordinary refusal is
 * **safe** — it abandons the call, and nothing runs — but it abandons a call a
 * human could have approved. Waiting on the ticket is what #127 adds.
 *
 * Every variant echoes `id` so a client with several calls in flight can match
 * the answer to the tool-use block that asked for it.
 */
export const ToolCallResponse = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ran"),
      id: z.string().min(1).max(128),
      result: ToolResult,
      /**
       * The channel crossed its soft budget limit on this call, which ran (#99).
       *
       * **Only on this variant.** A refusal and a hold are answers about a call
       * that did not happen, and a channel told "you are near your limit" in the
       * same breath as "that tool is not listed" learns nothing about either. It
       * is also why this is not a refusal reason: the soft limit is crossed by a
       * call the sheet permits and the meter allows, so there is a result beside
       * it.
       *
       * **Optional, where a hold's ticket is required**, and the asymmetry is
       * the point. A hold without a ticket is a question nobody can answer, so
       * it must not be representable; a `ran` without a warning is the ordinary
       * case — most calls are nowhere near a limit, and a channel that has
       * already been told today is not told again. A client that ignores this
       * field loses a notice and no result.
       */
      warning: BudgetWarning.optional()
    })
    .strict(),
  z
    .object({
      outcome: z.literal("held"),
      id: z.string().min(1).max(128),
      refusal: ToolRefusal,
      /**
       * What the client renders on the card, and what a re-submission carries
       * back.
       *
       * **Required, not optional.** A held response without a ticket is a hold
       * nobody can act on, and every deployment mints one — an optional field
       * here would be a hole for a proxy that forgot to, and the client would
       * have to handle a case that must not exist.
       */
      ticket: ApprovalTicket
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      id: z.string().min(1).max(128),
      refusal: ToolRefusal
    })
    .strict()
]);

export type ToolCallResponse = z.infer<typeof ToolCallResponse>;
