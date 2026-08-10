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
 * answer the agent got, and the row all say the same word.
 *
 * `unavailable` and `unanswered` are the proxy's own, and neither has a wire
 * counterpart. `unavailable` is a call the sheet permitted that this proxy had
 * no upstream to serve, which is a 501 rather than a `ToolCallResponse` and
 * still a thing that happened.
 *
 * `unanswered` is the one the proxy writes about *itself*: the call was decided
 * and metered, the handler then threw, and the agent got a 500 rather than any
 * answer at all. **It asserts nothing about whether the upstream acted**, and
 * that is the honest content of the word rather than a hedge — the realistic
 * cause is a failure on the result's way back, by which time the tool has run.
 * So `ran` undercounts upstream effects by exactly the `unanswered` rows, which
 * is what an incident review needs the word for. There is no wire counterpart
 * because there was no answer to carry one.
 *
 * The last three are the approval broker's, and they are the only outcomes in
 * this table that no `/v1/tools/call` request produced: `approved` and `denied`
 * are written by the decision route when a human clicks, and `expired` by
 * whichever request first observes a ticket that died undecided. A `held` row
 * therefore has a successor row rather than being amended — the table refuses
 * UPDATE — and the two are tied together by `ticket` below.
 *
 * **There is no sweep and no timer**, so a ticket nobody ever touches leaves its
 * `held` row and no successor at all. An operator counting `expired` rows is
 * counting *observed* expiries; the honest query for "held and never resolved"
 * is a `held` row with no later row for its ticket.
 *
 * `approved` is a decision, not an execution. The call it approved runs on a
 * later request and gets its own `ran` row, which carries the same approver —
 * so an approval that was never redeemed is visible as an `approved` row with
 * nothing after it, which is exactly the state an agent that died between the
 * click and the call leaves behind.
 *
 * Not a success/failure flag. Whether the tool itself reported an error is
 * `resultIsError` below, and the two are different questions.
 */
export const AuditOutcome = z.enum([
  "ran",
  "held",
  "refused",
  "unavailable",
  "unanswered",
  "approved",
  "denied",
  "expired"
]);

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
   *
   * **Absent does not mean "did not run".** On an `unanswered` row both this and
   * `resultIsError` are absent because the proxy could not measure a result, not
   * because there was none — the bytes it failed on are bytes nobody could
   * scrub. A reader summing this column is summing served calls; a reader asking
   * what the upstream did has to count `unanswered` separately.
   */
  readonly resultBytes?: number;
  /**
   * Whether the tool reported its own failure. Distinct from `outcome`, which is
   * the proxy's verdict: a call the proxy served perfectly can carry a 404 from
   * the tool, and collapsing the two would make `ran` mean "ran successfully".
   *
   * Absent on an `unanswered` row, for the reason above rather than as a `false`.
   */
  readonly resultIsError?: boolean;
  /**
   * The human who decided a held call, as the gateway observed them.
   *
   * On the `approved` or `denied` row the decision route writes, and again on
   * the `ran` row of the call that approval let through — or on its `unanswered`
   * row, which is the case worth having the field for: a human approved a call,
   * the ticket was spent, and the proxy then answered nothing. It cannot be
   * back-filled onto the `held` row — the table refuses UPDATE — which is why a
   * decision is a new row rather than an amendment to the one it answers.
   *
   * **Attribution, and a stronger claim than `requestingUser` — but not
   * authentication.** The click is read out of a Socket Mode interactive
   * envelope by gateway code, which is not model output, so a prompt-injected
   * model cannot forge one. It reaches the proxy through the agent process, over
   * a route the model has no tool for, so a *compromised agent process* can.
   * That is the same narrower claim `daily_tokens` makes, for the same reason.
   *
   * Nothing authorizes on it. It gates no call and selects no policy; it is
   * written here so an operator can see who said yes.
   */
  readonly approver?: string;
  /**
   * The approval ticket this row belongs to, when the call passed through the
   * broker: on the `held` row that minted it, on the `approved` or `denied` row
   * that decided it, on the `expired` row that observed it dead, and on the
   * `ran` — or `unanswered` — row that spent it. A ticket is spent by the
   * re-submission rather than by the answer, so a lifecycle stays joined even
   * when the last request in it failed.
   *
   * The correlation key, and the reason it is a column rather than a join on
   * something already here: `callId` is model-authored and a retry reuses it, so
   * it cannot key a lifecycle, and the four rows are four requests with four
   * different `requestId`s.
   *
   * A live ticket id is therefore in this table for as long as the ticket lives.
   * It is worth nothing without the channel's client certificate — which already
   * permits every call the sheet allows — and reading this file means being on
   * the proxy host, where the vault already is.
   */
  readonly ticket?: string;
}
