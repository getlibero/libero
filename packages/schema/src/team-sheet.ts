import { BUILTIN_SERVER, BuiltinToolName } from "./builtin.js";
import { EgressPattern } from "./egress.js";
import { CredentialName, ResourceName } from "./names.js";
import { z } from "zod";

/**
 * The team sheet — the per-channel manifest declaring which tools exist,
 * which credentials (by name only) they use, what needs human approval,
 * and how much the channel may spend. See the architecture doc,
 * site/src/content/docs/docs/architecture.md ("The team sheet").
 *
 * This schema is the single source of truth: the proxy validates sheets
 * against it on file change, and invalid sheets are rejected loudly while
 * the previous valid version stays active.
 */

export const ApprovalMode = z.enum(["required", "none"]);

// Server, tool, and credential names are the same shapes the proxy accepts in a
// call and returns in a refusal — imported, not restated, so a name that parses
// in a sheet is a name that survives the round trip. See ./names.ts.
export const ToolEntry = z.object({
  name: ResourceName,
  approval: ApprovalMode.optional(),
  // This tool's own ceiling on what its answer may spend of the channel's
  // context, overriding `[llm] max_result_chars`. Optional because most tools
  // want the channel's number; a tool that returns file listings or diffs is
  // where an operator needs a different one, in either direction.
  //
  // Two entries naming one tool are an operator slip rather than a policy, so
  // they resolve the way `resolveApproval` resolves a disagreement about
  // approval: the most restrictive wins. See packages/proxy/src/enforce.ts.
  max_result_chars: z.number().int().positive().optional(),
});

/**
 * One entry in `[[builtin]]` — a tool the proxy implements itself (#64).
 *
 * The same two optional fields `ToolEntry` carries, resolved by the same two
 * functions in packages/proxy/src/enforce.ts on the same most-restrictive-wins
 * rule. That is deliberate rather than convenient: a built-in is not a bypass,
 * so it earns its approval and its result bound the way every other tool does.
 * It is structurally assignable to `ToolEntry` — `name` is narrower — which is
 * what lets `resolveApproval` and `resolveLimits` take it unchanged.
 *
 * `name` is the one difference, and it is why this block exists at all: a closed
 * enum, so a misspelled tool is an issue at `builtin.<n>.name` rather than an
 * entry that parses, lists as permitted, and is refused at dispatch. See
 * ./builtin.ts for the argument in full.
 *
 * There is no `server` field. The provider is the proxy, there is one of it, and
 * the name it answers to is `BUILTIN_SERVER`.
 */
export const BuiltinEntry = z.object({
  name: BuiltinToolName,
  approval: ApprovalMode.optional(),
  max_result_chars: z.number().int().positive().optional(),
});

// Everything a server block carries whatever it speaks. Spread into both
// members below rather than restated, so the two transports cannot drift in
// what they allow beyond the one field that distinguishes them.
const mcpServerBase = {
  name: ResourceName,
  /** Name of a credential in the proxy vault. Never a secret value. */
  credential: CredentialName.optional(),
  tool: z.array(ToolEntry).default([]),
};

/**
 * An MCP server, discriminated on transport so `url` cannot be wrong.
 *
 * A union rather than one object with an optional `url`, because a flat shape
 * admits two sheets that parse and cannot serve a call: `http` with nothing to
 * call, and `stdio` with a field that is silently ignored. The sheet is the
 * admin surface and the loader's promise is that an invalid sheet is rejected
 * loudly while the previous valid version stays in force — a sheet that parses
 * and then fails at dispatch moves the failure from the operator's terminal at
 * edit time to the far end of a Slack thread.
 *
 * The `stdio` member declares `url` as undefined rather than relying on
 * `.strict()`. Zod strips keys it does not know, so an undeclared `url` on a
 * stdio block would be dropped in silence, which is the failure this exists to
 * prevent. Declared, a present `url` is an issue at `mcp_server.<n>.url` —
 * `.strict()` would report `unrecognized_keys` against the block and name no
 * field, and the field name is what an operator needs.
 */
export const McpServer = z.discriminatedUnion("transport", [
  z.object({
    ...mcpServerBase,
    transport: z.literal("http"),
    /** Required: an HTTP upstream with no address is not addressable. */
    url: z.url(),
  }),
  z.object({
    ...mcpServerBase,
    transport: z.literal("stdio"),
    /** Not permitted: a stdio upstream is a process, not an address. */
    url: z.undefined().optional(),
  }),
]);

// Inferred types alongside the schemas, as TeamSheet already has. Enforcement
// reads a sheet apart from parsing one, and reaching for
// TeamSheet["mcp_server"][number] at each of those sites is how two names for
// the same thing get started.
export type ApprovalMode = z.infer<typeof ApprovalMode>;
export type ToolEntry = z.infer<typeof ToolEntry>;
export type BuiltinEntry = z.infer<typeof BuiltinEntry>;
export type McpServer = z.infer<typeof McpServer>;

/**
 * The `[[mcp_server]]` list, refusing a block that claims the built-in name.
 *
 * `BUILTIN_SERVER` is the name a built-in call travels under, and nothing in
 * `decide` consults a transport before it matches on it — so a sheet naming an
 * http server `libero` would be a channel whose `search_channel_history` left
 * the process. Refused at parse rather than resolved at dispatch, because the
 * sheet is the admin surface and this is exactly the class of mistake the
 * discriminated union above exists to catch: one that parses and then cannot
 * serve a call.
 *
 * The issue lands at `mcp_server.<n>.name`, which is what an operator needs.
 * `parseTeamSheet` reports the path and the code and deliberately not the
 * message, so the path is the whole diagnosis and the message below is for
 * whoever calls zod directly.
 */
const McpServerList = z.array(McpServer).check(ctx => {
  ctx.value.forEach((server, index) => {
    if (server.name !== BUILTIN_SERVER) return;
    ctx.issues.push({
      code: "custom",
      input: server.name,
      path: [index, "name"],
      message: `"${BUILTIN_SERVER}" is reserved for the proxy's own built-in tools; declare those in [[builtin]]`,
    });
  });
});

export const TeamSheet = z.object({
  channel: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
  }),
  // prefault, not default: an absent section is parsed through the inner
  // schema so nested defaults resolve (zod 4's default() short-circuits).
  llm: z
    .object({
      model: z.string().min(1).optional(),
      // The four per-task hard caps, mirroring DEFAULT_AGENT_LOOP_CAPS in
      // packages/agent/src/loop/types.ts — what the loop uses when no sheet
      // resolved. Keep the two in step by hand: schema is the base package and
      // cannot import from agent. Seconds here, milliseconds in the loop; the
      // conversion belongs to whoever maps sheet to caps.
      max_tool_calls_per_task: z.number().int().positive().default(25),
      max_task_seconds: z.number().int().positive().default(300),
      max_tokens_per_task: z.number().int().positive().default(200_000),
      max_tokens_per_turn: z.number().int().positive().default(8_192),
      // The two bounds on assembled context (#67), and they are not caps in the
      // sense the four above are. A cap stops a task that is already running;
      // these decide how much of the channel's conversation the task *starts*
      // with, and every character of it is charged against
      // `max_tokens_per_task` before the model has done anything. They live
      // here for the reason the caps do — a channel spending its own budget,
      // able to widen nothing — and they are deliberately not `AgentLoopCaps`,
      // because the loop never sees them: the context assembler is above it and
      // hands it a finished transcript.
      //
      // The upper bound on `max_history_messages` mirrors `READ_MAX_LIMIT` in
      // packages/memory, which is the most rows one read of a store returns.
      // Kept in step by hand, as the caps above are, and for the same reason:
      // this is the base package and cannot import either. Without it a sheet
      // could name a number the store would silently clamp — the one place that
      // clamp would surprise, since it is an operator's stated intent rather
      // than a model's argument.
      max_history_messages: z.number().int().nonnegative().max(200).default(40),
      max_history_chars: z.number().int().nonnegative().default(12_000),
      // How much of one tool answer reaches the model (#151), and here for the
      // reason the two bounds above are: it is charged against
      // `max_tokens_per_task`, so it spends the channel's own budget and can
      // widen nothing. A tool result past this is truncated and says so, rather
      // than being refused — a large answer is usually still a useful one, and a
      // short answer that admits it is better than a silently short one.
      //
      // `positive`, not `nonnegative`, unlike `max_history_chars`. Zero history
      // is a real answer — send the model the question and nothing around it —
      // but a zero-character result cap means every tool call returns nothing but
      // a truncation notice, which is not a policy anyone holds.
      //
      // **The companion bound is deliberately not here.** How many bytes the
      // proxy will read off an upstream before abandoning the response is
      // `PROXY_MAX_RESPONSE_BYTES`, a deployment setting, because the heap it
      // spends belongs to the process and is shared by every channel it serves —
      // a sheet able to raise it would be one channel degrading service for all
      // of them. That also means this field needs no upper bound of its own: the
      // wire cap admits at most N bytes, so the string this bounds is at most N
      // characters however large a number a sheet names.
      max_result_chars: z.number().int().positive().default(32_768),
      // How long a thread the agent has worked in goes on accepting replies
      // with no mention (#66). Here rather than in the process for the reason
      // the two bounds above are: it spends the channel's own budget and can
      // widen nothing, and whether an agent answers messages nobody addressed
      // to it is a channel's policy rather than a deployment's. `0` turns
      // follow-ups off, which is the only way to say so short of removing the
      // sheet.
      //
      // The upper bound mirrors `SESSION_IDLE_MS` in
      // apps/server/src/session/registry.ts, which is how long a session — and
      // therefore its set of active threads — survives with nothing to do. A
      // window longer than that would be cut short by eviction, so the sheet
      // refuses one loudly rather than advertising a number it cannot keep.
      // Kept in step by hand, as `max_history_messages` and `READ_MAX_LIMIT`
      // are, and for the same reason.
      follow_up_window_seconds: z.number().int().nonnegative().max(1800).default(900),
    })
    .prefault({}),
  // The daily caps the proxy meters, and the weights it counts them with.
  //
  // The two limits rest on different things, and the difference matters more
  // than the numbers. `daily_tool_calls` is counted by the proxy from calls it
  // serves, so it holds even under full compromise of the agent process.
  // `daily_tokens` is counted from what the agent reports — from the provider's
  // response envelope, not from anything the model writes, so it holds against
  // a prompt-injected model but not against a compromised agent process. See
  // ./spend-report.ts.
  budget: z
    .object({
      daily_tokens: z.number().int().positive().default(1_000_000),
      daily_tool_calls: z.number().int().positive().default(200),
      // What a cached token is worth against `daily_tokens`. Cache reads and
      // cache writes bill differently from ordinary input tokens, and by how
      // much is the provider's decision, not ours — so it is an operator
      // setting rather than a constant. The defaults are Anthropic's ratios;
      // a channel pins its provider by pinning `[llm] model`, which is what
      // makes a per-channel weight a per-provider weight.
      //
      // The meter stores the raw counts, so a weight edit applies to spend
      // already recorded today, on the next call. `0` is legal and means a
      // cache read costs nothing against the budget.
      cache_read_weight: z.number().nonnegative().max(100).default(0.1),
      cache_write_weight: z.number().nonnegative().max(100).default(1.25),
      // Where the soft limit sits, as a fraction of each hard limit above. At
      // `0.8` a channel is told once, in its thread, when it has spent four
      // fifths of either budget, and the call that told it still runs — a
      // warning is not a refusal. `0` turns it off, which is
      // `follow_up_window_seconds`'s spelling for the same thing.
      //
      // **A fraction rather than a pair of absolute soft values**, because then
      // the contradiction has nowhere to live: there is no way to write a soft
      // limit above the hard limit it belongs to, so this needs no cross-field
      // refinement and a sheet cannot express a warning that fires after the
      // refusal it exists to precede. `1` is excluded on the same ground rather
      // than as a range preference — a warning delivered at the moment the meter
      // is spent is the refusal, said twice. And a fraction follows an edit to
      // the number above it, where an absolute pair goes stale the day
      // `daily_tokens` moves and says nothing about it.
      //
      // One number for both limits. They are counted differently and hold
      // against different attackers, but "four fifths spent" reads the same
      // against either, and the warning names which one crossed.
      warn_at: z.number().min(0).lt(1).default(0.8),
    })
    .prefault({}),
  mcp_server: McpServerList.default([]),
  // The tools the proxy implements itself (#64) — flat, because there is one
  // provider and it is the proxy. Named here for the same reason an
  // [[mcp_server.tool]] is named: a channel gets exactly the tools its sheet
  // lists, and a built-in is not an exception to that. See ./builtin.ts.
  builtin: z.array(BuiltinEntry).default([]),
  // Where traffic may go when the sheet does not already pin the destination —
  // the code-execution sandbox today. An [[mcp_server]] url is not listed here;
  // declaring it there is what authorizes it. See ./egress.ts.
  egress: z
    .object({
      allow: z.array(EgressPattern).default([]),
    })
    .prefault({}),
  ambient: z
    .object({
      enabled: z.boolean().default(false),
      schedule: z.string().optional(),
    })
    .prefault({}),
});

export type TeamSheet = z.infer<typeof TeamSheet>;
