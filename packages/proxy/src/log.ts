// Structured logging for the proxy.
//
// The field set is closed, and that is the point. The proxy is the process
// that holds every credential, so a logger taking free-form text is a standing
// invitation for a secret to be interpolated into a log line by some future
// call site. There is no `message` field and no metadata bag: if something new
// needs logging, it gets a named field here and a reviewer looks at it.
//
// One rule for that reviewer: no field may ever hold a credential value — and
// that includes a hash or fingerprint of one, which is crackable when the
// secret is low-entropy and would immediately attract "just log the
// fingerprint". Credential *names* are fine, in the same sense `server` and
// `tool` are names; `credential` below is that field, and it holds the name out
// of the team sheet and nothing else.
//
// One JSON object per line on stdout — the shape a container log collector
// wants, and greppable without a parser.

import type { AuditOutcome } from "@getlibero/schema";
// A type-only edge, so no cycle and no runtime dependency — the same reason
// `AuditOutcome` comes from the schema above. It moved here from the retired
// wire-format module with #188: the SDK frames the messages now, and the era a
// connection settled on is a word about the answer rather than about the wire.
import type { McpDialect } from "./mcp-client.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /** Fixed vocabulary, e.g. "listening", "request", "identity_rejected". */
  event: string;
  requestId?: string;
  /** The channel id. An id, never a credential, and safe to log. */
  channel?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Why an identity or a request was rejected. A code, not prose. */
  reason?: string;
  /** The certificate subject of a rejected connection. Never in a response. */
  commonName?: string;
  /**
   * The SHA-256 fingerprint of the client certificate a connection presented.
   *
   * This file's rule is that no field may hold a credential value **or a hash of
   * one**, so this field owes the argument. A certificate is a public document:
   * it is sent in the clear at the start of every handshake, anyone holding it
   * can compute this value, and holding this value gets you nothing — the
   * private key is what speaks, and it is not here and never was. The hazard the
   * rule is about is a low-entropy secret whose digest is crackable; there is no
   * secret behind this digest to crack.
   *
   * It is logged because it is the one fact an operator needs when a rotation
   * goes wrong: the sheet pins fingerprints, the connection presented one, and
   * "these two differ" is a sentence only this field can finish.
   */
  fingerprint?: string;
  /**
   * How many certificates the channel's sheet pinned when a connection was
   * judged against them. A count, not the list — enough to answer "did my sheet
   * edit land", which is what the line above will be read to answer.
   */
  pins?: number;
  host?: string;
  port?: number;
  /**
   * A path on disk. Separate from `path`, which is a request path — one field
   * carrying both would make either one ambiguous to grep for.
   */
  file?: string;
  /**
   * Validation failures in a team sheet, as `path: code` — the schema's own
   * field names and zod's issue codes. Both closed vocabularies; neither
   * carries a value out of the file. See `parseTeamSheet`.
   */
  issues?: string[];
  /** Position of a TOML syntax error. */
  line?: number;
  column?: number;
  /** What a rejected team sheet left in force. A code, not prose. */
  effect?: "previous_sheet_retained" | "no_sheet_in_force";
  /**
   * The MCP server and tool a call named. Both are `ResourceName`s out of the
   * team sheet — names, never a URL and never a credential. A call for a server
   * the sheet does not list is logged with the name it asked for, which is how
   * an operator sees what an agent is reaching for.
   */
  server?: string;
  tool?: string;
  /**
   * Who a call says asked for it, and which task it says it was part of (#95).
   *
   * **Asserted by the agent, not proved.** Everything else identifying a call on
   * this line comes from the certificate or the team sheet; these two come from
   * the request body, which the process running the model writes. They are
   * logged because an operator reading the audit trail needs to know who asked,
   * and they are two ids rather than a name or any message text.
   *
   * Nothing decides anything from them. That is what makes logging an
   * agent-asserted value acceptable here and would not make it acceptable to
   * branch on one — see the fields' doc comments in packages/schema.
   */
  requestingUser?: string;
  task?: string;
  /**
   * The credential a call used, **by name**. A `CredentialName` out of the team
   * sheet — the same string an operator typed into `libero vault set`, which is
   * why it is safe and why it is useful: it is how "which credential did that
   * call authenticate with" gets answered without the value going anywhere.
   *
   * Never the value, never a hash of it. See the rule at the top of this file.
   */
  credential?: string;
  /**
   * A destination host, for the outbound side. Host only — no scheme, no path,
   * no query — because a URL is a place a token gets put by a careless caller
   * and a query string is where it would land. Team sheets name destinations
   * as hosts too, so this is the string an operator compares against.
   */
  destination?: string;
  /**
   * Which MCP protocol a call was served over.
   *
   * Two values, which is what earns it the field: while the client spoke one
   * revision the value was a constant, and a field with one value tells an
   * operator nothing. Now it answers the question an operator actually asks
   * when an upstream misbehaves — did the proxy fall back? — and a fleet-wide
   * count of `legacy` is how the fallback's eventual removal gets scheduled.
   *
   * Not the negotiated revision string. That is the upstream's business and
   * would make this a cardinality problem; this is the proxy's own branch, and
   * the branch has two arms.
   *
   * Written as ./mcp-client.ts's type rather than repeated here, for the
   * reason `outcome` below is written as the schema's.
   */
  protocol?: McpDialect;
  /**
   * What the proxy did with a tool call, or what it did with a decision about
   * one. The audit log's vocabulary, of which the first four are also the
   * wire's, so a log line and the response a client got say the same word.
   *
   * `unanswered` is the one member no client ever sees, because there was no
   * answer to carry it: the call was decided and metered and the handler then
   * threw, so what the client got was the 500 `handler_failed` describes. A line
   * with this outcome and a `handler_failed` line sharing a `requestId` are the
   * two halves of one failure.
   *
   * Written as the schema's type rather than repeated here, which makes the two
   * agreeing a compile error rather than a review question — ./server.ts types
   * its audit closure on the same union and passes the value to both.
   */
  outcome?: AuditOutcome;
  /** Which team-sheet state a request resolved against. */
  sheet?: "active" | "absent" | "unusable";
  /** How many tools a listing returned. A count, not the list. */
  count?: number;
  /**
   * How many of a listing's tools carried an input schema. A count, not the
   * schemas.
   *
   * The operator's one-glance signal that enrichment is working: a listing
   * where this is below `count` had an upstream it could not ask, and the
   * `catalog_unavailable` lines beside it say which and why.
   */
  described?: number;
  /**
   * How many tools the sheet permitted and the listing withheld anyway (#200).
   *
   * The field this one owes an argument to is `count` above, which was the
   * number of tools the sheet named until a listing could drop a row. A tool
   * whose `x-mcp-header` annotations do not validate is left out entirely rather
   * than degraded to the sheet's thin row, so `count + excluded` is what now
   * equals the sheet — and without this an operator would see a listing quietly
   * shrink with nothing on the line to say why.
   *
   * A count, not the names: the `catalog_tool_excluded` lines name each one. It
   * is here because those fire on a walk and this fires on a listing, so a
   * cached exclusion has no line beside it and would otherwise be invisible —
   * which is the failure mode #200 exists to end, not to reproduce one level up.
   *
   * Withheld from the model, never from the channel. Nothing about this number
   * is a permission: ./enforce.ts decides a call on the sheet either way.
   */
  excluded?: number;
  /**
   * Whether a token report moved the meter. `duplicate` is a retry of a turn
   * already counted, which is a success — so this is not a `reason`.
   */
  report?: "recorded" | "duplicate";
  /**
   * How many tokens a report carried, unweighted. The report route knows no
   * team sheet and therefore no weights, so this is the raw sum of the four
   * counts and not what the budget was charged. A number out of a provider's
   * response envelope; nothing about it is a secret.
   */
  tokens?: number;
  /**
   * The model a report named, as the provider echoed it back (#62).
   *
   * Same trust class as `tokens` above and logged for the same reason: it comes
   * out of the provider's response envelope rather than from anything the model
   * wrote, and nothing about a model id is a secret. Bounded by `ModelId` at the
   * parse, so it cannot become an unbounded string in a log line.
   *
   * **This is what an operator reads to write a price.** The team sheet's
   * `[llm] model` records what was asked for; under a router the served id
   * differs, and it is the served one a price table has to be keyed by. Absent
   * when the report named none — the bucket the meter files those under is the
   * meter's business, and printing it here would read as this route's choice.
   */
  model?: string;
  /**
   * Which price table produced a figure: the digest of the file's bytes (#62).
   *
   * Observed rather than declared, so it cannot be wrong about what it
   * summarises — see `digestOf` in ./price-table-store.ts. Logged at load so an
   * operator can tie a running proxy's prices to a commit in the repository they
   * keep the file in. A price table holds model ids and integers and no secret.
   */
  version?: string;
  /**
   * An approval ticket id.
   *
   * This file's rule is that no field may hold a credential value or a hash of
   * one, so this one owes an argument. A ticket is **not** a credential: it is a
   * capability the proxy minted, and it is worth nothing on its own. Spending
   * one needs the channel's client certificate — which already permits every
   * call the sheet allows — and a call matching the approved one byte for byte,
   * and it stops working the moment it is used or fifteen minutes pass.
   *
   * What logging it buys is the join. A hold, a decision, and the call that ran
   * are three requests with three different request ids, and the ticket is the
   * only thing they share. The audit row carries the same id, and that file is
   * the more sensitive of the two.
   */
  ticket?: string;
  /** Who decided a held call. Attribution; see `ApproverId` in packages/schema. */
  approver?: string;
  /** Which way a human decided. */
  decision?: "approve" | "deny";
  /**
   * What the broker did with a decision. Not a `reason`, for the same shape of
   * argument `report` above makes: `already_decided` is a double click and
   * `unknown` is a ticket that expired out of memory, and neither is a failure
   * of the request that reported it.
   */
  approval?: "recorded" | "already_decided" | "expired" | "unknown";
}

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
}

/**
 * The default logger. `write` is injected so tests can capture lines and
 * assert on what the proxy does and does not emit.
 */
export function createJsonLogger(write: (line: string) => void = line => process.stdout.write(line)): Logger {
  return {
    log(level: LogLevel, fields: LogFields): void {
      write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`);
    }
  };
}

/** Drops everything. For tests that are not asserting on log output. */
export function createSilentLogger(): Logger {
  return { log: () => {} };
}
