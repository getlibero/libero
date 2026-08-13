import { z } from "zod";
import { refusalMessage } from "./refusal.js";
import type { BudgetLimit, RefusalReason } from "./refusal.js";

/**
 * One row of the audit log: what the proxy did with one tool call.
 *
 * This shape never crosses the wire. The proxy constructs it from its own
 * observation of a call it has already decided, and reads it back out of SQLite
 * on the operator's path. It lives here because the row is written by one
 * mapping and read by another and the two must agree: a column renamed on one
 * side and not the other is a type error rather than a silently empty CSV
 * column.
 *
 * It is deliberately *not* in `packages/cli`, and the reason is worth keeping
 * because it decided where the read path went. `@getlibero/cli` is npm-published
 * and this package is `private`, so a published command could not import these
 * names at all. The audit command is therefore a second entrypoint of the proxy
 * process (`node dist/audit.js`), like the vault and the budget — and the
 * stronger reason is the same one they give: the file it reads lives in a
 * container volume the operator's host cannot see.
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
   * Which daily limit stopped the call, on a `budget_exhausted` row (#62).
   *
   * The one fact `budget_exhausted` carries that the table had no column for,
   * which is why `auditRefusalMessage` answered `null` for it. Three limits made
   * that gap worse — "the budget ran out" without saying which sends an operator
   * to one of three numbers — so the column exists and the sentence completes.
   *
   * Absent on every row that is not a budget refusal. It is not a summary of the
   * channel's position; it is which comparison came back false.
   */
  readonly budgetLimit?: BudgetLimit;
  /**
   * The channel's spend so far **today**, in integer micro-USD, as the decision
   * saw it (#62).
   *
   * **Not what this call cost.** There is no such quantity, for the reason
   * `resultBytes` gives about tokens: money is spent by model turns, not by tool
   * calls, and a per-call figure would be an apportionment invented for the
   * column. This is the running total the comparison was made against — the
   * number that answers "why was this refused" and "how close was this one".
   *
   * Absent whenever nothing was priced: a channel whose sheet sets no
   * `daily_usd` consults no price table, and one whose spend includes a model
   * the table cannot price has no total to record. Absent therefore means "no
   * figure exists", never "zero".
   *
   * Micro-USD because a budget is money and money is not a float. As a JS number
   * it is exact past nine billion dollars, which is not a bound anyone will meet.
   */
  readonly daySpendMicroUsd?: number;
  /**
   * Which price table produced `daySpendMicroUsd`: the digest of its bytes.
   *
   * Without it the figure is unreproducible — prices change, and a number with
   * no record of what computed it cannot be checked against anything later. With
   * it, the row plus the operator's git history is enough to re-derive the
   * decision.
   *
   * Set exactly when `daySpendMicroUsd` is, and for the same reason: it records
   * what priced a figure, so a row with no figure has nothing to attribute.
   */
  readonly priceVersion?: string;
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

/**
 * The sentence a human was given for this row's refusal, or `null` when the row
 * does not carry the facts that sentence needs.
 *
 * **It writes no prose.** It rebuilds a `ToolRefusal` from the row's columns and
 * hands it to `refusalMessage`, so the operator reading the log and the channel
 * that saw the refusal get the same words. A second vocabulary here is how the
 * two start describing one event differently, which is the thing `refusal.ts`'s
 * "no free-text field" rule exists to prevent — and this is the one place with
 * both the motive and the columns to break it.
 *
 * **The gap is structural, and `null` is the honest answer to it.**
 * `refusalReason` above is a bare `RefusalReason`, while three members of
 * `ToolRefusal` carry a fact the table has no column for: `budget_exhausted`'s
 * limit, `egress_denied`'s destination, `credential_unresolved`'s credential.
 * Inventing one to satisfy the type would make the reader assert which budget
 * ran out, or which host was blocked, when the row does not say — a fabricated
 * fact in a record whose whole value is that it was observed. The caller prints
 * the enumerated reason alone, which is less and is true.
 *
 * That `credential_unresolved` is one of the three is worth noticing rather than
 * regretting: the vault's own rule is that a credential is referenced by name
 * and never by value, and the table holds neither. There is nothing for this
 * function to reconstruct, and nothing it could leak if it tried.
 *
 * Total over the union, as `refusalMessage` is, so a new reason cannot be added
 * without deciding what an operator reading the log is told about it.
 *
 * `server` and `tool` come from the row's own columns, which every variant that
 * needs them is satisfied by.
 */
export function auditRefusalMessage(
  reason: RefusalReason,
  server: string,
  tool: string,
  budgetLimit?: BudgetLimit
): string | null {
  switch (reason) {
    case "no_team_sheet":
    case "team_sheet_unreadable":
      return refusalMessage({ reason });
    case "server_not_allowed":
      return refusalMessage({ reason, server });
    case "tool_not_allowed":
    case "server_ambiguous":
    case "approval_required":
    case "approval_pending":
    case "approval_unknown":
    case "approval_expired":
    case "approval_spent":
    case "approval_denied":
    case "approval_mismatch":
      return refusalMessage({ reason, server, tool });
    // Completed by the row's own `budget_limit` column since #62. It stays
    // `null` when that column is absent rather than guessing: rows written
    // before version 4 have no limit recorded, and naming one would be the
    // fabricated fact this function exists to refuse.
    case "budget_exhausted":
      return budgetLimit === undefined ? null : refusalMessage({ reason, limit: budgetLimit });
    // Carries no facts beyond the reason, so the row is already complete (#62).
    // It is the one of the two pricing faults that can be reconstructed, and
    // that asymmetry is the point: "no model was reported" is the whole fact,
    // where "this model has no price" is not.
    case "model_unreported":
      return refusalMessage({ reason });
    // The three the table cannot complete. Listed rather than defaulted, so a
    // new reason is a compile error here and a decision rather than a silent
    // `null` — `refusalMessage`'s totality would otherwise stop at this door.
    //
    // `model_not_priced` stays here even now the table has a `budget_limit`
    // column: that column says which *limit* bound, and this needs the *model*,
    // which is a different fact and not one a row about a tool call has any
    // business carrying. Inventing one would name a model the record never
    // observed.
    case "model_not_priced":
    case "egress_denied":
    case "credential_unresolved":
      return null;
  }
}
