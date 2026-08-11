// `GET /v1/tools` — what this channel may call, and what those tools take.
//
// **This route can ask an upstream what it offers, and can run nothing.** That
// is the claim the module exists to make, and it is made three ways rather than
// asserted once:
//
//   - It closes over `ToolCatalog`, whose only method returns descriptions. The
//     dispatcher — the seam that opens a connection to *do* something — is not
//     in scope, so a listing cannot become a call by an edit that looked
//     reasonable next to the route that does call. ./builtins.ts is imported and
//     ./builtin-dispatcher.ts is banned, which is the same split one file over:
//     the definitions are constants, the executor reads a channel's messages.
//   - It imports no vault, no pool, and no client. The credential behind a
//     `describe` was resolved in ./http-dispatcher.ts, which is still the only
//     module holding a `Vault` and a transport at once, and this file never
//     learns a secret exists.
//   - eslint.config.mjs forbids those imports here, so CI says so before a
//     reviewer has to. Same mechanism ./spend-route.ts uses, for the same
//     reason: the risk is a later change, not this file as written.
//
// **The sheet decides what is listed; the upstream only describes.** The merge
// below iterates the sheet's entries and looks each one up by name. Nothing
// iterates the catalog, so a server naming a tool the sheet does not name has
// no row to attach itself to — the intersection is the loop's shape rather than
// a filter someone has to remember to apply.
//
// **A listing is still not the enforcement**, which is what makes every
// degradation safe. An upstream that is down, slow, ambiguous, or unreachable
// yields the entry as the sheet wrote it: a missing schema costs the model
// accuracy, never the channel a permission, and a tool absent from this answer
// is refused at call time by the same sheet that omitted it.

import type { McpServer, PermittedTool, ToolListing } from "@getlibero/schema";
import { BUILTIN_TOOLS } from "./builtins.js";
import type { ToolCatalog, UpstreamToolDescription } from "./dispatch.js";
import { permittedToolSourcesFromState, upstreamKey } from "./enforce.js";
import type { Logger } from "./log.js";
import type { RequestContext, RouteHandler, RouteResponse } from "./server.js";
import type { TeamSheetStore } from "./team-sheet-store.js";

export interface ListingRouteOptions {
  readonly sheets: TeamSheetStore;
  readonly catalog: ToolCatalog;
  readonly logger: Logger;
  /** The server's `ok`, passed in so this module frames nothing itself. */
  readonly ok: (body: unknown) => RouteResponse;
}

const NOTHING: ReadonlyMap<string, UpstreamToolDescription> = new Map();

export function createListingRoute(options: ListingRouteOptions): RouteHandler {
  return async (ctx: RequestContext): Promise<RouteResponse> => {
    const state = await options.sheets.resolve(ctx.channel);
    const sources = permittedToolSourcesFromState(state);

    // Grouped by upstream identity rather than by block name, so a sheet that
    // splits one server across several `[[mcp_server]]` blocks — the documented
    // way to group tools by approval — asks that upstream once. `upstreamKey`
    // is the pool's own key, shared rather than restated, so "one upstream"
    // means here exactly what it means there.
    const wantedBy = new Map<string, { upstream: McpServer; tools: string[] }>();
    for (const source of sources) {
      // A built-in is described from ./builtins.ts at merge time — this process
      // implements it, so there is nobody to ask and nothing that could fail.
      // It is skipped here rather than logged: `catalog_unavailable` reports an
      // upstream that could not be reached, and this is not one.
      if (source.target?.kind === "builtin") continue;

      if (source.target === null) {
        // The sheet contradicts itself about where this tool goes, so there is
        // no single server to ask. Still listed — `decide` refuses it as
        // `server_ambiguous`, and a listing describes what a call would do
        // rather than deciding it.
        options.logger.log("warn", {
          event: "catalog_unavailable",
          channel: ctx.channel,
          server: source.tool.server,
          tool: source.tool.tool,
          reason: "server_ambiguous"
        });
        continue;
      }
      const key = upstreamKey(source.target.upstream);
      const group = wantedBy.get(key);
      if (group === undefined) wantedBy.set(key, { upstream: source.target.upstream, tools: [source.tool.tool] });
      else group.tools.push(source.tool.tool);
    }

    // `Promise.all`, deliberately not `allSettled`. Every upstream failure is
    // already an empty map by the time it reaches here — that is `ToolCatalog`'s
    // contract — so the only thing that can reject is a `RedactionError`, which
    // is not an upstream failing but this proxy unable to guarantee its own
    // boundary. `allSettled` would swallow it and serve a cheerful thin listing
    // to a channel whose every tool call is about to 500 the same way. It
    // reaches the server's handler, which answers a constant 500 without
    // inspecting the thrown value, so no upstream bytes cross.
    const answers = new Map<string, ReadonlyMap<string, UpstreamToolDescription>>();
    await Promise.all(
      [...wantedBy].map(async ([key, group]) => {
        answers.set(key, await options.catalog.describe(group.upstream, group.tools));
      })
    );

    let described = 0;
    const tools: PermittedTool[] = sources.map(source => {
      // A built-in's definition is this build's own, so it is always present and
      // always counts as described. It comes from a table of constants rather
      // than from an answer, which is why nothing here can degrade it to a thin
      // row the way an unreachable upstream degrades one.
      if (source.target?.kind === "builtin") {
        const definition = BUILTIN_TOOLS[source.target.tool];
        described += 1;
        return {
          ...source.tool,
          description: definition.description,
          inputSchema: definition.inputSchema
        };
      }

      const upstream =
        source.target === null ? NOTHING : (answers.get(upstreamKey(source.target.upstream)) ?? NOTHING);
      const found = upstream.get(source.tool.tool);
      if (found?.inputSchema !== undefined) described += 1;
      return {
        ...source.tool,
        ...(found?.description !== undefined ? { description: found.description } : {}),
        ...(found?.inputSchema !== undefined ? { inputSchema: found.inputSchema } : {})
      };
    });

    options.logger.log("info", {
      event: "tools_listed",
      requestId: ctx.requestId,
      channel: ctx.channel,
      sheet: state.status,
      count: tools.length,
      // The operator's one-glance signal that enrichment is working. A listing
      // whose count and described diverge is an upstream that could not be
      // asked, which the `catalog_unavailable` lines above and beside this one
      // explain.
      described
    });

    return options.ok({ tools } satisfies ToolListing);
  };
}
