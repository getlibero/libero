import { z } from "zod";
import { ResourceName } from "./names.js";

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
 * Never parse an incoming request body with this schema: the channel would then
 * be coming from the body, which is the one thing it may never come from.
 */
export const ResolvedToolCall = ToolCall.extend({
  /** From the client certificate's `CN=channel:<id>`. Not from the request. */
  channel: z.string().min(1)
}).strict();

export type ResolvedToolCall = z.infer<typeof ResolvedToolCall>;
