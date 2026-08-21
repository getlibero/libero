import { z } from "zod";
// A type-only import, which is erased at compile time — ./team-sheet.ts imports
// values from this file, and a runtime edge back would be a cycle whose
// evaluation order decides whether a zod constant exists yet.
import type { ApprovalMode } from "./team-sheet.js";

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
 * ## One provider, so there is nothing to group under
 *
 * There is no server: the provider is the proxy. `[[builtin]]` is therefore a
 * list of tool entries carrying the same two optional fields
 * `[[mcp_server.tool]]` carries, and `BuiltinEntry` lives beside `ToolEntry` in
 * ./team-sheet.ts so the two can be read against each other.
 *
 * It stopped being one flat object in #394. `run_code` needs cpu, memory and
 * wall-time caps that mean nothing to a tool reading a local SQLite file, so
 * `BuiltinEntry` is a union discriminated on `name` — for the reason `McpServer`
 * is one, that a flat shape would let a sheet size a search and be quietly
 * stripped. The two optional fields above are still common to every member; what
 * varies is what else a member may carry.
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
 * block existing — see the header. Adding a member here is the first of four
 * parts of adding a built-in: an entry in `BUILTIN_APPROVAL_DEFAULT` below, a
 * block shape in `BuiltinEntry` in ./team-sheet.ts, a definition in
 * `packages/proxy/src/builtins.ts`, and somewhere for the call to go. Each fails
 * the build on its own if the others land without it — two `Record`s over this
 * enum, a union whose members narrow it, and a switch — so there is no order in
 * which a half-added built-in compiles.
 *
 * "Somewhere for the call to go" is the part that stopped being one place in
 * #394. `search_channel_history` and `schedule_task` are cases in the executor's
 * exhaustive switch; `run_code` is not, and cannot be. It reaches a runner over
 * the network, and the arm holding that switch is the one whose header promises
 * it has no network at all — so #393 gave the sandbox its own arm, and
 * `StoreBuiltinName` in `packages/proxy/src/dispatch.ts` is what makes putting
 * it in the wrong one a type error.
 */
export const BuiltinToolName = z.enum(["search_channel_history", "schedule_task", "run_code"]);

export type BuiltinToolName = z.infer<typeof BuiltinToolName>;

/**
 * What a sheet gets when it lists a built-in and says nothing about approval.
 *
 * **Declared, because a built-in is ours.** `resolveApproval`'s fallback for an
 * `[[mcp_server.tool]]` is the destructive-verb heuristic, and that is the right
 * shape for it: those names were chosen by somebody else, there are thousands of
 * them, and a guess from the verb is the only thing available. These names were
 * chosen here, in this repository, in a diff somebody reviewed — so the default
 * is a decision to write down rather than a property to infer.
 *
 * `run_code` would be the clearest case of the heuristic getting it wrong, which
 * is worth stating rather than leaving to be noticed: "run" is not a destructive
 * verb, so a guess from the name would answer `"none"` for the one tool in this
 * enum that executes arbitrary code. It is `"required"` — the strictest member,
 * for the most powerful one — and the argument is the same shape as
 * `schedule_task`'s rather than a new one. A channel loosens it by writing
 * `approval = "none"`, which is a channel deciding that model-written code needs
 * no click; forgetting the line gets the hold.
 *
 * The sandbox around it is not the reason to default the other way. Read-only
 * rootfs, a tmpfs workdir, cpu/memory/wall-time caps and no network without an
 * `[egress]` block all bound *what a run can do*, and none of them bounds
 * *whether it should have run* — which is the question an approval asks. A
 * governed sandbox is what makes `approval = "none"` a defensible thing for a
 * channel to write, not a reason to write it on the channel's behalf.
 *
 * The consequence is the one #322 asks for: `schedule_task` is `"required"`, so a
 * sheet has to **loosen** it by writing `approval = "none"` rather than remember
 * to tighten it. Forgetting the line gets you the hold.
 *
 * `search_channel_history` is `"none"`, which is exactly what the heuristic
 * already answers for it — stated rather than left resting on the accident that
 * its name contains no destructive verb.
 *
 * **Adding `"schedule"` to `DESTRUCTIVE_VERBS` was the other way to spell this
 * and is wrong twice.** Creating a future check destroys nothing, and that list
 * is matched against upstream tool names — so it would hold an MCP
 * `reschedule_meeting` for every channel in every deployment, to decide something
 * about a tool this process implements itself.
 *
 * A `Record` over the enum for `BUILTIN_TOOLS`' reason: adding a member without
 * deciding its default is a type error rather than a built-in that quietly
 * inherits a guess.
 */
export const BUILTIN_APPROVAL_DEFAULT: Record<BuiltinToolName, ApprovalMode> = {
  search_channel_history: "none",
  schedule_task: "required",
  run_code: "required"
};
