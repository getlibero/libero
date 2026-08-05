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

/**
 * The Slack user whose mention started the task, as the agent asserts it.
 *
 * Bounded for the same reason a server name is: it lands in a refusal, in the
 * audit log, and in that log's CSV export (#98), so an unbounded value here is
 * an unbounded value in three places a human reads. A Slack user id is a short
 * identifier and fits the alphabet exactly.
 *
 * **This is attribution and can never be authorization.** The full argument is
 * on the field itself, in ./tool-call.ts, which is where someone about to write
 * an authorization rule will be looking.
 */
export const RequestingUser = identifier();

/**
 * The id grouping every tool call one ReAct run made.
 *
 * Minted by the agent loop, once per task, and never by the model — the same
 * rule as `TurnId` in ./spend-report.ts, for the same reason: a model that
 * chooses its own correlation id can split one task across many or collapse
 * many into one, and the audit log is read to answer "what did that one request
 * do".
 *
 * Bounded shorter than `TurnId`, which sits at 128 to match `ToolCall.id`'s
 * bound because that id is model-authored and opaque. This one is not: it is
 * generated in-process, a UUID fits in 36, and there is nothing here that wants
 * the extra room.
 */
export const TaskId = identifier();

/**
 * A channel id — the one name here that is not a name at all but a principal.
 *
 * Load-bearing rather than hygiene. The id becomes a directory name
 * (`channels/<id>/channel.toml`) and a SQLite filename, and the one-file-per-
 * channel layout *is* the isolation boundary. So "." and ".." are rejected by
 * the leading-character rule, and a separator never survives the character
 * class: everything downstream may treat a validated id as a safe path segment.
 *
 * It lives here, in the base package, because two places need the same answer
 * and a channel id that satisfied one but not the other would be a hole. The
 * proxy resolves ids from client certificates and imports the pattern for its
 * hot path; anything that stores or routes on an id validates with the schema.
 * One rule, stated once.
 */
export const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const ChannelId = z
  .string()
  .regex(CHANNEL_ID_PATTERN, "must be a safe path segment: no separator, no leading dot");

export type ChannelId = z.infer<typeof ChannelId>;
