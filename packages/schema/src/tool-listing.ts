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
 * **This is a permission manifest, not a tool catalog.** A team sheet lists
 * names and approval, and nothing else: there is no description and no input
 * schema on a `ToolEntry`, so nothing here can be handed to a model as a tool
 * definition. #129 is what fetches real definitions from
 * upstream servers and intersects them with this manifest. The thinness is the
 * accurate shape of what a team sheet knows, not an unfinished edge.
 */

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
    approval: ApprovalMode
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
