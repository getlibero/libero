import { z } from "zod";
import { ApprovalMode } from "./team-sheet.js";
import { ResourceName } from "./names.js";

/**
 * What the proxy tells an agent it may call.
 *
 * Fetched once per session, before the first model turn. The agent does not
 * decide what is on this list and cannot add to it — and the list is not the
 * enforcement. A tool absent here is refused at call time by the same team
 * sheet that omitted it, so a client that skips this endpoint entirely gains
 * nothing. Listing keeps an unlisted tool out of the model's context in the
 * first place; the call-time check is what holds.
 *
 * **The sheet decides membership; the upstream describes.** A team sheet lists
 * names and approval and knows nothing about arguments, so `description` and
 * `inputSchema` come from the server the sheet named — fetched by the proxy's
 * MCP client, intersected with this manifest, and attached to rows the sheet
 * already produced. Nothing an upstream says can add a tool here, because the
 * intersection iterates the sheet.
 *
 * **Both describing fields are optional, and their absence is a state rather
 * than a gap.** An upstream that is down, slow, ambiguous, or speaking a
 * transport the proxy cannot reach degrades to the entry as the sheet wrote it.
 * That is safe because the listing is not the enforcement: a missing schema
 * costs the model accuracy, never the channel a permission, and a tool absent
 * here is still refused at call time by the same sheet that omitted it.
 *
 * **They are also third-party text entering the model's context on every
 * turn** — the tool-poisoning surface. Nothing here mitigates it, and nothing
 * should pretend to: a rule that reads a description is a rule the upstream
 * phrases around. The bounds below cap the blast radius and are not a
 * mitigation. What accepts the exposure is the team sheet naming the server.
 */

/**
 * How long a tool description may be by the time a model sees it.
 *
 * Here rather than in the proxy because both ends need the same number. The
 * proxy truncates an upstream's description to this before it publishes one,
 * and the shape below rejects anything longer — so a proxy bounding at 2048
 * against a schema rejecting at 1024 would turn every chatty upstream into a
 * `malformed_response` on the agent side, which ends the task rather than
 * costing it a sentence. One constant, imported by the module that truncates.
 *
 * The value is a budget, not a style rule. Tool definitions are fetched once
 * per task and re-sent on every model turn, so a description's cost is paid
 * per turn and multiplied by the tool count.
 */
export const MAX_TOOL_DESCRIPTION = 1024;

/**
 * The only shape an input schema may have on its way to a provider.
 *
 * Loose on purpose: everything past `type` is passed through unmodified, so
 * this is a shape rule and never a judgement about content. What it rules out
 * is the class that breaks a whole turn rather than one tool —
 * `packages/agent` casts this value straight into the provider's tool
 * definition, and a provider answering 400 fails the turn, not the tool. One
 * upstream publishing `{"type":"string"}`, by malice or by bug, would take
 * every channel whose sheet names it down with it.
 */
export const ToolInputSchema = z.looseObject({ type: z.literal("object") });

export type ToolInputSchema = z.infer<typeof ToolInputSchema>;

export const PermittedTool = z
  .object({
    server: ResourceName,
    tool: ResourceName,
    /**
     * Resolved, not copied. A team sheet's `approval` is optional and the
     * default depends on the tool's name, so the raw field answers the
     * question only sometimes. The proxy runs the same rule enforcement runs
     * and reports the answer, so a client never re-derives it — and cannot
     * derive it differently.
     */
    approval: ApprovalMode,
    /**
     * What the upstream says the tool does, bounded and absent when it said
     * nothing this proxy would publish.
     *
     * Never the sheet's words — a sheet has none — so this field is exactly as
     * trustworthy as the server the sheet named, which is the trade an
     * `[[mcp_server]]` block makes.
     */
    description: z.string().min(1).max(MAX_TOOL_DESCRIPTION).optional(),
    /**
     * The tool's arguments as JSON Schema, absent when the upstream published
     * none this proxy would relay.
     *
     * All-or-nothing where the description truncates: a schema cannot be
     * shortened and stay a schema, and half of one would have the model form
     * arguments against a contract nobody holds.
     */
    inputSchema: ToolInputSchema.optional()
  })
  .strict();

export type PermittedTool = z.infer<typeof PermittedTool>;

export const ToolListing = z
  .object({
    /**
     * Empty is a real answer, not an error: a channel with no team sheet, or
     * with one that has never parsed, permits nothing. Default deny reads the
     * same here as it does at call time.
     */
    tools: z.array(PermittedTool)
  })
  .strict();

export type ToolListing = z.infer<typeof ToolListing>;
