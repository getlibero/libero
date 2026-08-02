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

export const ToolEntry = z.object({
  name: z.string().min(1),
  approval: ApprovalMode.optional(),
});

export const McpServer = z.object({
  name: z.string().min(1),
  transport: z.enum(["http", "stdio"]),
  url: z.url().optional(),
  /** Name of a credential in the proxy vault. Never a secret value. */
  credential: z.string().min(1).optional(),
  tool: z.array(ToolEntry).default([]),
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
      max_tokens_per_task: z.number().int().positive().optional(),
    })
    .prefault({}),
  budget: z
    .object({
      daily_tokens: z.number().int().positive().default(1_000_000),
      daily_tool_calls: z.number().int().positive().default(200),
    })
    .prefault({}),
  mcp_server: z.array(McpServer).default([]),
  egress: z
    .object({
      allow: z.array(z.string()).default([]),
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
