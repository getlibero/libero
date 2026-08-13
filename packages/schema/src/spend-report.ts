import { z } from "zod";
import { ModelId } from "./names.js";

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

/**
 * Which model spent them, as the provider echoed it back — a sibling of `usage`
 * rather than a field inside it.
 *
 * `TokenUsageReport` promises a field-for-field correspondence with `TokenUsage`
 * in packages/agent/src/completion/types.ts, so that the agent's parse of a
 * provider response maps onto it without a translation step. A model id is not
 * one of those counts and putting it there would either break the promise or
 * force the agent's type to grow a field it has no use for.
 *
 * **The served model, not the requested one** (#62). The agent asks for whatever
 * `[llm] model` or `AGENT_MODEL` says; a router may serve something else, and it
 * is what actually ran that has a price. Both adapters read it off the response
 * envelope beside the counts. So this is exactly as forgeable as they are — a
 * prompt-injected model has no reach into the envelope, and a compromised agent
 * process could write anything, which is the assumption the security model
 * already states.
 *
 * **Optional, and absent is not free.** A provider that echoes nothing, an agent
 * older than this field, or a gateway that strips it all produce a report with no
 * model. The proxy meters those tokens under a reserved bucket that no price
 * table can name, so a channel whose sheet sets `budget.daily_usd` is refused
 * until the day rolls over or an operator resets it, while a channel that caps
 * only tokens and tool calls is unaffected. That asymmetry is the point: the
 * cheapest lie available to a compromised agent — name no model, be metered at
 * zero — is the one that stops it, and naming a *cheaper* model buys only what
 * under-reporting the counts already buys.
 *
 * The field must stay optional rather than required. A required one would make
 * every report from a provider that echoes nothing a 400, which loses the token
 * counts entirely and fails **open** on `daily_tokens` — the limit that catches
 * a runaway loop.
 */
export const SpendReport = z
  .object({
    turn: TurnId,
    model: ModelId.optional(),
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
