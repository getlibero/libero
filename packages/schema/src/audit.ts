import { z } from "zod";
import type { RefusalReason } from "./refusal.js";

/**
 * One row of the audit log: what the proxy did with one tool call.
 *
 * This shape never crosses the wire. The proxy constructs it from its own
 * observation of a call it has already decided, and it is read back out of
 * SQLite by the operator's CLI. It lives here anyway because three packages
 * have to agree on the column names — `packages/cli` is npm-published and
 * `@getlibero/proxy` is private, so the audit CLI (#98) opens the database
 * itself rather than importing the proxy. A shared type is what stops it
 * redefining the columns.
 *
 * `AuditRecord` is a type with **no zod object schema**, for the reason
 * `ResolvedToolCall` has none (see ./tool-call.ts): a schema has a `.parse()`,
 * and `AuditRecord.parse(body)` on some future ingest route is one
 * plausible-looking line that forges an audit row with a channel taken from a
 * request body. Nothing needs the parse. The proxy builds the record, and on
 * the way back out the table's DDL is the schema.
 *
 * `AuditOutcome` does get one, because #98 parses it off `argv` as a filter and
 * that is a real parse of real user input.
 */

/**
 * What the proxy did with a call.
 *
 * The first three are `ToolCallResponse`'s discriminator, so a log line, the
 * answer the agent got, and the row all say the same word. `unavailable` is the
 * fourth: a call the sheet permitted that this proxy had no upstream to serve,
 * which is a 501 rather than a `ToolCallResponse` and still a thing that
 * happened.
 *
 * Not a success/failure flag. Whether the tool itself reported an error is
 * `resultIsError` below, and the two are different questions.
 */
export const AuditOutcome = z.enum(["ran", "held", "refused", "unavailable"]);

export type AuditOutcome = z.infer<typeof AuditOutcome>;

export interface AuditRecord {
  /** When the proxy resolved the call. Epoch milliseconds, the server's clock. */
  readonly at: number;
  /** From the client certificate's `CN=channel:<id>`. Never from a request body. */
  readonly channel: string;
  /**
   * Who asked, and which task. **Asserted by the agent, not proved**, and
   * recorded here precisely because this is the log that reads them — see their
   * doc comments on `ToolCall`. Nothing decides anything from either.
   */
  readonly requestingUser: string;
  readonly task: string;
  /** Ties the row to the proxy's log lines for the same request. */
  readonly requestId: string;
  /** The model's tool-use id. Opaque, echoed, and not unique: a retry reuses it. */
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  /**
   * SHA-256 over canonical JSON of the call's arguments, lowercase hex.
   *
   * The arguments themselves are not stored. What this answers is "was that the
   * same call as this one" — a retry, a loop, two channels asking for the same
   * thing — without putting model-authored text into a durable record that
   * nothing on the write path is able to redact.
   */
  readonly argumentsSha256: string;
  readonly outcome: AuditOutcome;
  /** Set when the call did not run. The enumerated reason, never prose. */
  readonly refusalReason?: RefusalReason;
  /**
   * The size of the result handed back, in bytes, when the call ran.
   *
   * Not tokens. Tokens are spent by model turns rather than by tool calls, so a
   * per-call token count would be an apportionment invented for the column; the
   * meter records the real numbers per turn. This is the thing the proxy
   * actually observes, and it is the largest single driver of the *next* turn's
   * input tokens, which is what makes "which call caused the spike" answerable.
   *
   * To ask what a request cost, join on `task`: the meter's turn ids are
   * `<task>.<n>`.
   */
  readonly resultBytes?: number;
  /**
   * Whether the tool reported its own failure. Distinct from `outcome`, which is
   * the proxy's verdict: a call the proxy served perfectly can carry a 404 from
   * the tool, and collapsing the two would make `ran` mean "ran successfully".
   */
  readonly resultIsError?: boolean;
  /**
   * The human who approved a held call, once the approval broker (#37) exists.
   *
   * Always absent today, and it cannot be back-filled: the table refuses UPDATE,
   * so an approval is written when the approved call is recorded or it is never
   * written at all. The column ships now so the CLI's column set does not churn
   * one issue after it stabilises.
   */
  readonly approver?: string;
}
