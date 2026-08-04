import { z } from "zod";

/**
 * What one turn cost, as the agent reports it to the proxy's budget meter.
 *
 * The proxy meters `daily_tool_calls` from calls it serves — it needs nobody's
 * cooperation to count those. `daily_tokens` is different: only the process
 * that talked to the model knows what the turn cost, so it says so, and this is
 * the shape it says it in.
 *
 * **That is not the same as trusting the model.** These numbers are parsed out
 * of the provider's HTTP response envelope — `toUsage()` in
 * packages/agent/src/completion/anthropic.ts reads `message.usage` — and a
 * prompt-injected model emits text, which has no reach into the envelope its
 * own tokens are counted in. The report is forgeable only under full compromise
 * of the agent *process*, which the security model already states as an
 * assumption whose consequences (the union of that agent's channel tool
 * surfaces) are larger than an under-reported token count. Token metering does
 * not add a weakness; it inherits one that is already written down.
 *
 * **Strict, with no `channel` and no `day`.** The channel comes from the client
 * certificate, exactly as it does for a tool call, and the day is the proxy's
 * own UTC clock at arrival. An agent that tries to assert either does not get
 * the field quietly dropped — the parse fails and the attempt is visible in the
 * proxy's log. Same argument as `ToolCall`; see ./tool-call.ts.
 *
 * **Four counts, not a total.** The proxy is the authoritative meter, so the
 * proxy decides what a token is worth: cache reads and cache writes bill
 * differently from ordinary input tokens, and the weights are per-channel team
 * sheet fields (`[budget] cache_read_weight`, `cache_write_weight`). A total
 * would put that weighting in the agent, where changing it would need an agent
 * release rather than a sheet edit.
 */

/**
 * The id of the turn this report is for.
 *
 * The whole idempotency story. A report can be retried — the network fails, the
 * process restarts mid-flight — and a retry must not spend the budget twice, so
 * the meter records the id and a second report under it is a no-op. Generated
 * by the agent process, not by the model.
 *
 * The identifier alphabet, at 128, matching `ToolCall.id`'s bound: it lands in
 * a SQLite key and in log lines, and an unbounded string in either is how a
 * caller ends up choosing what those surfaces hold.
 */
export const TurnId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a short identifier: letters, digits, dot, dash, underscore");

/**
 * The ceiling on any one count in a report.
 *
 * Not a plausibility check — no provider bills a single turn near this — but a
 * bound, so a wrong or hostile number cannot make the counter meaningless or
 * overflow the arithmetic it feeds. It fails closed either way: an agent that
 * reports its own daily cap in one turn locks its channel out until the day
 * rolls over or an operator resets it.
 */
export const MAX_REPORTED_TOKENS = 10_000_000;

const count = (): z.ZodNumber => z.number().int().nonnegative().max(MAX_REPORTED_TOKENS);

/**
 * The four counts, named as `TokenUsage` in packages/agent/src/completion/types.ts
 * names them, so the agent's parse of a provider response maps onto this
 * without a translation step that could quietly drop a field.
 *
 * The cache fields default to 0 rather than staying optional: a provider that
 * does not report them has not spent them, and a meter column cannot hold
 * `undefined`. The agent side keeps them optional, because there "not reported"
 * and "zero" are worth telling apart.
 */
export const TokenUsageReport = z
  .object({
    inputTokens: count(),
    outputTokens: count(),
    cacheReadInputTokens: count().default(0),
    cacheCreationInputTokens: count().default(0)
  })
  .strict();

export const SpendReport = z
  .object({
    turn: TurnId,
    usage: TokenUsageReport
  })
  .strict();

/**
 * Whether this report moved the meter.
 *
 * `duplicate` is a success: it means the turn was already counted, which is the
 * answer a retry should get. It is not an error and not a refusal — nothing was
 * denied, because reporting spend is not asking for anything.
 */
export const SpendReportResponse = z
  .object({
    outcome: z.enum(["recorded", "duplicate"])
  })
  .strict();

export type TurnId = z.infer<typeof TurnId>;
export type TokenUsageReport = z.infer<typeof TokenUsageReport>;
export type SpendReport = z.infer<typeof SpendReport>;
export type SpendReportResponse = z.infer<typeof SpendReportResponse>;
