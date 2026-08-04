import { EgressPattern } from "./egress.js";
import { CredentialName, ResourceName } from "./names.js";
import { z } from "zod";

/**
 * The team sheet — the per-channel manifest declaring which tools exist,
 * which credentials (by name only) they use, what needs human approval,
 * and how much the channel may spend. See docs/ARCHITECTURE.md ("The team sheet").
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
export type McpServer = z.infer<typeof McpServer>;

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
    })
    .prefault({}),
  mcp_server: z.array(McpServer).default([]),
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
