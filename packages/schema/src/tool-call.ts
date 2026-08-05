import { z } from "zod";
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
