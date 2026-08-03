import { z } from "zod";

/**
 * The names that cross the agent/proxy boundary: servers, tools, credentials.
 *
 * Constrained rather than left as free strings, for two reasons.
 *
 * The first is that a server or tool name in a call is model-authored. It comes
 * back out in a refusal, which is relayed to a Slack channel and written to the
 * audit log. An unconstrained name means the model chooses what those two
 * surfaces display. Bounded to a short identifier, a nonsense name is a parse
 * failure at the edge instead of arbitrary text echoed downstream.
 *
 * The second is that a credential name is bounded, which limits — but does not
 * decide — what can appear where one belongs. The alphabet rejects PEM blocks,
 * base64 with padding, URLs, and anything long. It does **not** distinguish a
 * name from a token that happens to look like one: `ghp_16C7e42F...` and
 * `xoxb-2401-3982-Zk9qW` are short and use exactly these characters, and both
 * parse. There is no lexical test that would catch them without also rejecting
 * real names, so this is not the thing keeping credential values out.
 *
 * What keeps them out is structural: the only values that ever reach a
 * `CredentialName` are names the operator wrote in a team sheet, and no code
 * path carries a vault value to one. The bound is worth having anyway, because
 * it caps what a refusal can put into a Slack channel and the audit log — but
 * read it as a bound, not as a filter.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const identifier = (): z.ZodString =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(IDENTIFIER, "must be a short identifier: letters, digits, dot, dash, underscore");

/** An MCP server or tool name, as written in a team sheet and in a call. */
export const ResourceName = identifier();

/**
 * The name of a credential in the proxy's vault. Never the value. Used in team
 * sheets, in refusals, and anywhere else a credential is mentioned at all.
 */
export const CredentialName = identifier();

/**
 * A host the proxy would have to reach to serve a call, as it appears in an
 * egress refusal.
 *
 * Host only — never a URL. A URL carries a path and a query string, and a
 * credential in a query string is a well-worn way for a secret to end up in a
 * log line. There is no field on any shape here that a full URL can be parsed
 * into.
 */
export const DestinationHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:_-]+$/, "must be a host, without scheme, path, or query");
