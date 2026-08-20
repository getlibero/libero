// The seam the tool-call route writes its audit record through, and the hash
// that stands in for the arguments it does not store.
//
// Apart from ./audit-db.ts so that file stays what it claims to be — every
// statement against the audit file, and nothing else — and so the route closes
// over an interface with one method on it.
//
// ## Why the interface is one write-only method
//
// `AuditDb` can `append` and `close`. `AuditWriter` can only `append`. That
// narrowing is the same move ./dispatch.ts makes when it hands the spend route
// a `TokenRecorder` rather than a `SpendMeter`: the process serving tool calls
// should not hold the ability to close the database it is being audited into,
// and the way to be sure it does not is for the ability to be absent from the
// type. The handle stays with the composition root, which opened it and is what
// shuts it down.
//
// There is no read method here and there should never be one. Reading the audit
// log is an operator concern (#98); the serving path writes.
//
// ## Why the arguments are hashed rather than stored
//
// #97 asked for optional argument capture behind a config flag, redacted
// through ./redact.ts. #122 designed it and **declined it**, so this is settled
// rather than pending — do not read the paragraphs below as a gap waiting for
// someone with an afternoon.
//
// The mechanical obstacle came first: `redactSecrets` takes the credential
// *values*, and the only place values exist is ./outbound.ts, inside the
// dispatcher. This module and ./server.ts hold none — that is what their import
// lists are for, and an ESLint rule now enforces it for ./redact.ts too.
//
// But the obstacle that decided it is not mechanical, and it would survive any
// amount of rearranging:
//
//   1. **Redaction is a backstop, not a boundary**, and ./redact.ts's own header
//      says so at length: a scan for a value finds the value, and misses a
//      transformation of it. The threat capture exists to investigate is a
//      prompt-injected model putting a secret into a tool call — an adversary,
//      not a careless upstream — so the mechanism is weakest exactly where it
//      would be leaned on. "A redaction set the design argues is complete" was
//      the acceptance criterion, and a complete *set* is not complete
//      *redaction*.
//   2. **The plausible set has a side effect.** Every credential the channel's
//      sheet names would have to be *acquired* to yield values, and acquiring an
//      OAuth credential is a token-endpoint round trip (see `CredentialSource`
//      in ./outbound.ts). A refused call resolves no credential today; under
//      that design it would mint tokens over the network in order to have
//      something to redact against.
//   3. **A captured secret would be permanent.** Rows are hash-chained (#354),
//      so removing one after the fact breaks the chain from that row to the tip
//      and destroys the evidentiary value of the rest of the file. The remedy
//      would be rotating the credential *and* the log.
//
// Incomplete redaction on a durable row is worse than storing nothing, because
// an operator reading a column labelled redacted believes it. So: a hash, which
// answers whether two calls were the same and claims nothing else.
//
// What the decision costs is written down rather than waved off: a call that was
// *refused* reached no upstream, so nothing anywhere records what it attempted.
// For a call that ran, the upstream has its own record. That gap is parked, not
// solved.
//
// ## Why a hash of the arguments is not the fingerprint ./log.ts forbids
//
// That rule — no field may hold a credential value, "and that includes a hash
// or fingerprint of one" — is about a credential: a value the vault holds, in
// this process's custody, whose confidentiality is the reason the proxy exists.
// `arguments` is none of those things. It is text the agent already holds in
// plaintext and that the proxy is about to send to a third-party upstream.
//
// The preimage is the **whole argument object**, and that is load-bearing
// rather than incidental. A per-field hash of `{"token": "ghp_…"}` really would
// be an offline-crackable hash of exactly one low-entropy secret. Canonical
// JSON over the whole object puts the tool's other arguments and every key name
// into the preimage alongside it.
//
// The attacker model also does not close: reading `audit.db` means being on the
// proxy host, where the vault file and this process's memory already are.
//
// The residual, stated rather than argued away: a one-argument call whose only
// value is a short secret someone pasted into a channel hashes a short secret
// plus a fixed key name. That is a reason to store no arguments, which is what
// this does.

import { createHash } from "node:crypto";
import type { AuditRecord } from "@getlibero/schema";
import { openAuditDb, type AuditDb } from "./audit-db.js";
import type { Logger } from "./log.js";

/**
 * Where the tool-call route sends what it observed.
 *
 * `void | Promise<void>` as the meter's methods are: the SQLite implementation
 * is synchronous, the interface tolerates one that is not, and the caller
 * awaits either way.
 *
 * An implementation that cannot write must throw rather than swallow. The route
 * is built on that — see the argument at its call site in ./server.ts.
 */
export interface AuditWriter {
  append(record: AuditRecord): void | Promise<void>;
}

/**
 * JSON with object keys sorted, at every depth, and no whitespace.
 *
 * So that two calls differing only in the order their arguments were serialised
 * hash the same, which is what makes the hash answer "was that the same call".
 * Array order is preserved: it is meaningful to the tool, so two different
 * orders are two different calls.
 *
 * The input came from `JSON.parse` of a request body, so there are no cycles,
 * no BigInt, and no functions in it. What that does not bound is depth: a body
 * under the size cap can still nest deeply enough to overflow the stack here,
 * and the RangeError fails the audit write, which refuses the call. That is
 * fail-closed and deliberate — a body shaped to break the audit path gets no
 * answer, not an unrecorded one.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // `undefined` cannot appear in parsed JSON; the fallback is for a caller
    // that reached here another way, and "null" is the honest rendering.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

/**
 * The audit row's stand-in for the arguments: SHA-256 over `canonicalJson`,
 * lowercase hex.
 *
 * Hashed here, in the proxy, over what the proxy actually received — never
 * asserted by the agent. A hash the agent computed would describe whatever the
 * agent chose to describe, which is the opposite of what an audit record is.
 *
 * `ToolCall.arguments` defaults to `{}`, so an absent `arguments` and an empty
 * one hash identically. They are the same call.
 */
export function hashArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

export interface AuditWriterOptions {
  readonly db: AuditDb;
}

/** The writer the route gets: the database's append, and nothing else of it. */
export function createSqliteAuditWriter(options: AuditWriterOptions): AuditWriter {
  const { db } = options;
  return {
    append(record) {
      db.append(record);
    }
  };
}

/**
 * Open the file and take a writer off it, for the composition root.
 *
 * Mirrors `openSpendMeter`, and returns the handle for the same reason: it has
 * to be closed on shutdown, and the writer deliberately cannot.
 */
export function openAuditWriter(options: { readonly file: string; readonly logger?: Logger }): {
  readonly writer: AuditWriter;
  readonly db: AuditDb;
} {
  const { file, logger } = options;
  const db = openAuditDb({ file, ...(logger !== undefined ? { logger } : {}) });
  return { writer: createSqliteAuditWriter({ db }), db };
}
