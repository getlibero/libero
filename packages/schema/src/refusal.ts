import { z } from "zod";
import { CredentialName, DestinationHost, ModelId, ResourceName } from "./names.js";

/**
 * A refusal: the proxy's answer when a call is not permitted.
 *
 * A refusal is a normal result, not an exception. Enforcement returning "no" is
 * the system working, so the agent parses one, relays it to the channel, and
 * carries on — it is not a `ProxyError`, which is the shape of a request that
 * failed. The two never overlap: a refused call is a served request.
 *
 * The variants are the questions the proxy answers on every call — is this
 * server allowed for this channel, is this tool on the allowlist, does the call
 * need a human, is the budget spent, is the destination permitted — plus the
 * two operator failures the agent must be able to report precisely: a
 * credential the team sheet names that the vault cannot resolve, and a sheet
 * whose duplicate server entries disagree about where a tool goes.
 *
 * **There is no free-text field on any variant.** The relayable sentence is
 * derived from the enumerated fields by `refusalMessage`, so the text cannot
 * disagree with the reason and there is no prose a credential value could ride
 * along in. This is stricter than `ProxyError`, which does carry an
 * author-supplied message: refusals are produced on the path that touches the
 * vault, and the discipline of "the message is written carefully at each call
 * site" is not one worth relying on there. Each variant carries exactly the
 * facts its sentence needs, and a credential appears only as a name.
 */

export const RefusalReason = z.enum([
  /** The channel has no team sheet. Not provisioned, or revoked. */
  "no_team_sheet",
  /**
   * A team sheet exists, has never parsed, and no earlier version is in force.
   *
   * Kept apart from `no_team_sheet` even though both refuse every call, because
   * the two send an operator to different places. Collapsing them tells someone
   * their channel has no sheet while they are looking at the file.
   */
  "team_sheet_unreadable",
  /** The channel's team sheet does not list this MCP server at all. */
  "server_not_allowed",
  /** The server is listed; this tool is not on its allowlist. */
  "tool_not_allowed",
  /**
   * The sheet lists this server more than once, and the entries that carry the
   * tool disagree about where it goes or what it authenticates with.
   *
   * Duplicate server names are legitimate — a sheet may split one server's
   * tools across blocks, and the allowlist unions them. What is not legitimate
   * is two blocks of the same name pointing at different upstreams: the entry
   * whose allowlist permitted the tool would not be the entry the call was sent
   * to, and that gap is a bypass. There is no safe way to pick, so neither is
   * picked.
   */
  "server_ambiguous",
  /** Permitted, but held for a human. The approval broker takes it from here. */
  "approval_required",
  /**
   * The six ways a re-submission can fail to be the call a human approved.
   *
   * They stay six rather than collapsing into one, because each sends its reader
   * somewhere different: wait, ask again, you already used this, a human said no,
   * and — the one that matters most — the call you re-sent is not the call that
   * was approved. Collapsing any of them into `approval_unknown` would make a
   * replay, a restart, and an approve-then-mutate indistinguishable in the log.
   *
   * A held call carrying *no* ticket is not in this list and needs no reason: it
   * is a first submission, so it mints a ticket and is answered
   * `approval_required` as it always was.
   */
  "approval_pending",
  /**
   * No such ticket in this channel.
   *
   * One answer for three situations — a ticket that never existed, one another
   * channel holds, and one this process lost to a restart — and with the
   * proxy's per-channel ticket map they are structurally one rather than
   * deliberately conflated: the lookup cannot reach another channel's tickets.
   */
  "approval_unknown",
  /** The ticket died before the call came back. Asking again mints a new one. */
  "approval_expired",
  /** The ticket was already redeemed. One approval runs one call. */
  "approval_spent",
  /** A human declined this call. */
  "approval_denied",
  /**
   * The re-submitted call is not the call the ticket was minted for.
   *
   * Approve-then-mutate is the attack the whole re-submission design exists to
   * stop, so it gets its own reason, its own sentence, and its own audit row.
   */
  "approval_mismatch",
  /** The channel's daily meter is spent. Authoritative in the proxy. */
  "budget_exhausted",
  /**
   * The channel caps spend in dollars, and some of today's spend is on a model
   * the proxy's price table does not list (#62).
   *
   * **The fail-closed answer**, and the decision that keeps a router from
   * quietly becoming an uncapped spend path: a model absent from the table is
   * like a tool absent from the allowlist, so the call is refused rather than
   * metered at zero. It reads oddly the first time — the channel may be nowhere
   * near its cap — but a cap whose position cannot be computed is not a cap, and
   * the alternative prices unknown models free.
   *
   * Only ever raised for a channel whose sheet sets `budget.daily_usd`. One that
   * caps tokens and tool calls needs no prices and never meets this.
   */
  "model_not_priced",
  /**
   * The same fault with nothing to name: some of today's spend arrived in a
   * report that named no model at all (#62).
   *
   * Kept apart from `model_not_priced` for the reason `no_team_sheet` and
   * `team_sheet_unreadable` are kept apart — both refuse every call, and the two
   * send an operator to different places. That one means "add a price for this
   * model"; this one means "find out why the agent is not reporting one", which
   * is an agent older than the field, a provider that echoes nothing, or a
   * gateway that strips it. The proxy's log names the reports.
   */
  "model_unreported",
  /** Serving the call means reaching a host the egress allowlist omits. */
  "egress_denied",
  /** The sheet names a credential the vault has no entry for. */
  "credential_unresolved"
]);

export type RefusalReason = z.infer<typeof RefusalReason>;

/**
 * Which daily limit ran out. Mirrors the `[budget]` keys in a team sheet.
 *
 * Three since #62, and `daily_usd` is the one that is optional in the sheet: a
 * channel that never sets it can never be refused for it, and a channel that
 * does is capped by whichever of the three binds first.
 */
export const BudgetLimit = z.enum(["daily_tokens", "daily_tool_calls", "daily_usd"]);

export type BudgetLimit = z.infer<typeof BudgetLimit>;

export const ToolRefusal = z.discriminatedUnion("reason", [
  // These two carry no facts beyond the reason. Naming the channel would add
  // nothing a reader of the message does not already have: they are in it.
  z.object({ reason: z.literal("no_team_sheet") }).strict(),
  z.object({ reason: z.literal("team_sheet_unreadable") }).strict(),
  z
    .object({
      reason: z.literal("server_not_allowed"),
      server: ResourceName
    })
    .strict(),
  z
    .object({
      reason: z.literal("tool_not_allowed"),
      server: ResourceName,
      tool: ResourceName
    })
    .strict(),
  z
    .object({
      reason: z.literal("server_ambiguous"),
      server: ResourceName,
      tool: ResourceName
    })
    .strict(),
  z
    .object({
      reason: z.literal("approval_required"),
      server: ResourceName,
      tool: ResourceName
    })
    .strict(),
  // The broker's six. Each carries the call it is about and nothing else — in
  // particular a mismatch does not carry what the *ticket* was for, because the
  // reader is in the channel that raised both and a second server/tool pair in
  // the sentence would add length rather than information.
  z.object({ reason: z.literal("approval_pending"), server: ResourceName, tool: ResourceName }).strict(),
  z.object({ reason: z.literal("approval_unknown"), server: ResourceName, tool: ResourceName }).strict(),
  z.object({ reason: z.literal("approval_expired"), server: ResourceName, tool: ResourceName }).strict(),
  z.object({ reason: z.literal("approval_spent"), server: ResourceName, tool: ResourceName }).strict(),
  z.object({ reason: z.literal("approval_denied"), server: ResourceName, tool: ResourceName }).strict(),
  z.object({ reason: z.literal("approval_mismatch"), server: ResourceName, tool: ResourceName }).strict(),
  z
    .object({
      reason: z.literal("budget_exhausted"),
      limit: BudgetLimit
    })
    .strict(),
  // The pricing faults (#62). One carries the model it could not price, because
  // that is the whole remedy — an operator reads it and writes a line in the
  // price table. The other carries nothing, because there is nothing to name:
  // that is what "unreported" means, and a placeholder in the sentence would be
  // the meter's own bucket id leaking into a channel as though it were a model.
  z.object({ reason: z.literal("model_not_priced"), model: ModelId }).strict(),
  z.object({ reason: z.literal("model_unreported") }).strict(),
  z
    .object({
      reason: z.literal("egress_denied"),
      destination: DestinationHost
    })
    .strict(),
  z
    .object({
      reason: z.literal("credential_unresolved"),
      /** The name from the team sheet. Never the value; see `CredentialName`. */
      credential: CredentialName
    })
    .strict()
]);

export type ToolRefusal = z.infer<typeof ToolRefusal>;

/**
 * The sentence to put in the channel.
 *
 * Total over the union, so a new reason cannot be added without deciding what
 * a human is told about it. Plain and terse by house style: name the call, say
 * what is not permitted, say whether it ran.
 */
/**
 * Which of the three daily limits, in the words a channel reads.
 *
 * Its own function rather than an arm of the switch below, so both are total
 * over their own union and neither needs a fallthrough. **No figure in any of
 * the three**: the number lives in the sheet, the sentence is read in a
 * channel, and the audit table has no column for it — so a message that quoted
 * one would be the only place it could disagree with the meter.
 */
function budgetExhaustedMessage(limit: BudgetLimit): string {
  switch (limit) {
    case "daily_tokens":
      return "This channel has spent its daily token budget. No further calls run until the budget resets.";
    case "daily_tool_calls":
      return "This channel has spent its daily tool-call budget. No further calls run until the budget resets.";
    case "daily_usd":
      return "This channel has spent its daily spend budget. No further calls run until the budget resets.";
  }
}

export function refusalMessage(refusal: ToolRefusal): string {
  switch (refusal.reason) {
    case "no_team_sheet":
      return "This channel has no team sheet, so no tool call is permitted. An admin provisions one at `channels/<channel id>/channel.toml`.";
    case "team_sheet_unreadable":
      return "This channel's team sheet could not be read and no earlier version is in force, so no tool call is permitted. The proxy log names the file and the fault.";
    case "server_not_allowed":
      return `This channel's team sheet does not list the server \`${refusal.server}\`. The call was not made.`;
    case "tool_not_allowed":
      return `This channel's team sheet lists \`${refusal.server}\` but not the tool \`${refusal.tool}\`. The call was not made.`;
    case "server_ambiguous":
      return `This channel's team sheet lists \`${refusal.server}\` more than once, and the entries carrying \`${refusal.tool}\` point at different upstreams. An admin resolves it in the sheet. The call was not made.`;
    case "approval_required":
      return `\`${refusal.server}.${refusal.tool}\` requires approval from a human before it runs. The call is held.`;
    case "approval_pending":
      return `The approval for \`${refusal.server}.${refusal.tool}\` has not been decided yet. The call was not made.`;
    case "approval_unknown":
      return `This channel has no approval for \`${refusal.server}.${refusal.tool}\`. It may have expired, or the proxy may have restarted. The call was not made.`;
    case "approval_expired":
      return `The approval for \`${refusal.server}.${refusal.tool}\` expired before the call was made. Asking again raises a new one.`;
    case "approval_spent":
      return `The approval for \`${refusal.server}.${refusal.tool}\` has already been used. One approval runs one call. The call was not made.`;
    case "approval_denied":
      return `A human declined \`${refusal.server}.${refusal.tool}\`. The call was not made.`;
    case "approval_mismatch":
      return `This approval was not for \`${refusal.server}.${refusal.tool}\` with these arguments. An approval covers one exact call. The call was not made.`;
    case "budget_exhausted":
      return budgetExhaustedMessage(refusal.limit);
    case "model_not_priced":
      return `This channel caps spend in dollars, and it has spent tokens on \`${refusal.model}\`, which is not in the proxy's price table. Spend that cannot be priced cannot be capped, so no call runs until an admin prices it. The call was not made.`;
    case "model_unreported":
      return "This channel caps spend in dollars, and some of today's spend was reported without naming a model, so it cannot be priced. No call runs until the budget resets or an admin looks into it. The proxy log names the reports. The call was not made.";
    case "egress_denied":
      return `\`${refusal.destination}\` is not on this channel's egress allowlist. The call was not made.`;
    case "credential_unresolved":
      return `The credential \`${refusal.credential}\` is named in this channel's team sheet but is not in the vault. The call was not made.`;
  }
}
