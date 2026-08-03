import { z } from "zod";
import { CHANNEL_ID_PATTERN, ResourceName } from "./names.js";
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
    arguments: z.record(z.string(), z.unknown()).default({})
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
 * What a tool produced, once it ran.
 *
 * `isError` marks a failure the model should see and may recover from — a 404
 * from the tool, a bad argument. It is not an enforcement outcome and not a
 * transport failure; both of those are other variants of `ToolCallResponse`.
 * Mirrors the agent loop's `ToolResult`, which is the shape this becomes on
 * the other side of the wire.
 */
export const ToolResult = z
  .object({
    content: z.string(),
    isError: z.boolean().default(false)
  })
  .strict();

export type ToolResult = z.infer<typeof ToolResult>;

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
 * the approval broker (#37) needs to tell them apart without re-deriving the
 * distinction from the refusal reason. Until that broker exists a client that
 * treats a hold as a refusal is behaving correctly — which is why the hold
 * carries the full refusal rather than a bare marker.
 *
 * Every variant echoes `id` so a client with several calls in flight can match
 * the answer to the tool-use block that asked for it.
 */
export const ToolCallResponse = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ran"),
      id: z.string().min(1).max(128),
      result: ToolResult
    })
    .strict(),
  z
    .object({
      outcome: z.literal("held"),
      id: z.string().min(1).max(128),
      refusal: ToolRefusal
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
