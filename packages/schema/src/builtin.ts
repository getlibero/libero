import { z } from "zod";

/**
 * The tools the proxy implements itself, rather than dialling an upstream for.
 *
 * A built-in is not a bypass. It is named in the team sheet like any other tool,
 * refused when the sheet does not name it, held when the sheet asks for a click,
 * charged to the channel's meter, and written to the audit log — the only thing
 * that differs is where the call goes when every one of those has passed. The
 * shape that carries that claim is `Target` in `packages/proxy/src/enforce.ts`:
 * one `decide` produces both kinds, so a dispatcher cannot serve a built-in
 * without having gone through the same gate.
 *
 * ## Why these are their own block and not an `[[mcp_server]]`
 *
 * `transport = "builtin"` under `[[mcp_server]]` would reuse a union that
 * already has a member carrying no url, and would need no `Target` at all. It
 * was rejected on what the sheet would then permit: `credential` on a block that
 * dials nothing, any `name` at all for a namespace this process owns, and — the
 * one that decided it — any `ResourceName` as a tool, because
 * `[[mcp_server.tool]]`'s `name` is the same field for every server in the file.
 * A typo would parse, list as permitted, and be refused at dispatch, which is a
 * sheet saying a tool is allowed and a proxy saying it is not. Here the name is
 * a closed enum, so the typo is a parse error at `builtin.<n>.name` and the
 * operator sees it at edit time.
 *
 * ## One provider, so the block is flat
 *
 * There is no server to group under: the provider is the proxy. `[[builtin]]` is
 * therefore a list of tool entries with the same two optional fields
 * `[[mcp_server.tool]]` carries, and `BuiltinEntry` lives beside `ToolEntry` in
 * ./team-sheet.ts so the two can be read against each other.
 */

/**
 * The server name a built-in call carries on the wire.
 *
 * `ToolCall.server` is required and is a `ResourceName`, so a built-in needs a
 * name to travel under even though nothing is being dialled. This is it, and it
 * is reserved: ./team-sheet.ts refuses a sheet whose `[[mcp_server]]` claims it,
 * because a channel that pointed this name at an http upstream would be one
 * whose `search_channel_history` reached the network.
 *
 * It parses as a `ResourceName`, which `builtin.test.ts` asserts rather than
 * assumes — the two definitions are in different files and only a test keeps
 * them in step.
 */
export const BUILTIN_SERVER = "libero";

/**
 * Every tool the proxy implements, as a closed set.
 *
 * A `z.enum` rather than `ResourceName`, and that is the whole argument for this
 * block existing — see the header. Adding a member here is the first half of
 * adding a built-in; the second is a definition in
 * `packages/proxy/src/builtins.ts`, and the exhaustive switch in the executor is
 * what fails the build if only one half lands.
 */
export const BuiltinToolName = z.enum(["search_channel_history"]);

export type BuiltinToolName = z.infer<typeof BuiltinToolName>;
