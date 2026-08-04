import { z } from "zod";
import { CredentialName, DestinationHost, ResourceName } from "./names.js";

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
  /** The channel's daily meter is spent. Authoritative in the proxy. */
  "budget_exhausted",
  /** Serving the call means reaching a host the egress allowlist omits. */
  "egress_denied",
  /** The sheet names a credential the vault has no entry for. */
  "credential_unresolved"
]);

export type RefusalReason = z.infer<typeof RefusalReason>;

/** Which daily limit ran out. Mirrors the `[budget]` keys in a team sheet. */
export const BudgetLimit = z.enum(["daily_tokens", "daily_tool_calls"]);

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
  z
    .object({
      reason: z.literal("budget_exhausted"),
      limit: BudgetLimit
    })
    .strict(),
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
    case "budget_exhausted":
      return refusal.limit === "daily_tokens"
        ? "This channel has spent its daily token budget. No further calls run until the budget resets."
        : "This channel has spent its daily tool-call budget. No further calls run until the budget resets.";
    case "egress_denied":
      return `\`${refusal.destination}\` is not on this channel's egress allowlist. The call was not made.`;
    case "credential_unresolved":
      return `The credential \`${refusal.credential}\` is named in this channel's team sheet but is not in the vault. The call was not made.`;
  }
}
