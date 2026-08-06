// What happens to a call that enforcement allowed.
//
// Two seams, both for work that is not built. They are here rather than inside
// the route because the route's job ends at the decision: everything past the
// decision is credentials, connections, and accounting, none of which this
// issue owns.
//
// Both are required options on the server rather than defaulted ones. A
// deployment that silently meters zero spend because someone left an option
// out is exactly the failure worth designing away, and a default is how that
// happens — the omission has to be a type error, not a quiet allow.

import type { BudgetSpend } from "./enforce.js";
import type {
  McpServer,
  ResolvedToolCall,
  TokenUsageReport,
  ToolRefusal,
  ToolResult
} from "@getlibero/schema";

/**
 * How much this channel has spent today.
 *
 * Raw counters, never a verdict: enforcement compares them against the sheet,
 * because the comparison and the weighting are policy and live with the sheet.
 * ./budget-meter.ts is the implementation, and it owns persistence and
 * rollover.
 *
 * **A read can be stale by the calls in flight beside it.** The server reads
 * here, decides, and only then records, so two concurrent calls for one channel
 * can both see the count below the cap and both be served. The overshoot is
 * bounded by that channel's concurrency — a task's loop is sequential — and the
 * property that matters survives it: a runaway loop overshoots once and is then
 * refused for the rest of the day. Tokens lag further by construction, since a
 * turn's tokens are reported after the calls they paid for. Closing the window
 * means holding a per-channel lock across read → decide → record, which is a
 * clean change and not this seam's job.
 */
export interface SpendReader {
  read(channel: string): BudgetSpend | Promise<BudgetSpend>;
}

/**
 * Counts a call the proxy has committed to serving.
 *
 * No count parameter. It is called once per served call, from one place, and a
 * caller that could write "5" is a caller that could write "0".
 */
export interface ToolCallRecorder {
  recordToolCall(channel: string): void | Promise<void>;
}

/**
 * Records what a turn cost, once.
 *
 * Separate from `ToolCallRecorder` rather than one `record({tokens, calls})`,
 * and the split is load-bearing. The tool-call count is written by the proxy
 * from its own observation; the token count is written from a report the agent
 * sends. One method would make it structurally possible for the report route to
 * write a tool-call count — and `daily_tool_calls` holding under agent
 * compromise is precisely the property that would cost.
 *
 * The report route (./spend-route.ts) closes over this interface and nothing
 * wider, so it cannot read a counter either.
 */
export interface TokenRecorder {
  recordTokens(
    channel: string,
    turn: string,
    usage: TokenUsageReport
  ): SpendRecord | Promise<SpendRecord>;
}

/**
 * Whether a report moved the meter. `duplicate` is the right answer to a retry
 * and is not a failure — nothing was denied, because reporting is not asking.
 */
export type SpendRecord = { readonly outcome: "recorded" | "duplicate" };

export interface SpendMeter extends SpendReader, ToolCallRecorder, TokenRecorder {}

/**
 * Marks a provisional implementation.
 *
 * A symbol rather than a name or an `instanceof`, so the mark cannot be set by
 * accident and does not widen the interfaces: a real implementation has no way
 * to acquire it without importing this and saying so.
 */
const PROVISIONAL = Symbol("libero.provisional");

type Provisional<T> = T & { readonly [PROVISIONAL]: true };

export function markProvisional<T extends object>(value: T): Provisional<T> {
  return Object.assign(value, { [PROVISIONAL]: true as const });
}

function isProvisional(value: object): boolean {
  return PROVISIONAL in value;
}

/**
 * What serving an allowed call produced.
 *
 * A result type rather than exceptions, matching `Decision` and
 * `ChannelIdentity`: on this path a thrown value can carry a credential in its
 * message, so the states worth distinguishing are enumerated instead.
 *
 * `refused` is here as well as in `decide` because one refusal reason cannot be
 * answered from the team sheet alone: `credential_unresolved` needs the vault
 * (#51). That is a refusal discovered while serving, not a permission denied
 * before it.
 *
 * `egress_denied` is **not** one of these, though an earlier note here guessed
 * it would be. The destination of an MCP call comes from the `[[mcp_server]]`
 * block that authorized the tool, so nothing about it is discovered at dispatch
 * time; `[egress]` governs the destinations the sheet does not pin, and its
 * first caller is the sandbox runner. See packages/schema/src/egress.ts.
 */
export type Dispatch =
  | { readonly outcome: "ran"; readonly result: ToolResult }
  | { readonly outcome: "refused"; readonly refusal: ToolRefusal }
  /** No upstream is built. Becomes a 501, not a refusal: nothing was denied. */
  | { readonly outcome: "unavailable" };

/**
 * Serves an allowed call.
 *
 * The seam ./http-dispatcher.ts fills, and behind it the MCP client pool. The
 * server calls this **only** on an `allow`,
 * which is the property the tests assert against a recording implementation: a
 * refused or held call must leave no trace here, because reaching this
 * interface at all is what opens a connection and resolves a secret.
 *
 * `upstream` is the team-sheet entry enforcement matched, passed in rather than
 * looked up. A dispatcher that resolved the sheet itself could get a different
 * answer than the decision did — sheets are watched and reload on file change —
 * and would then send the call somewhere nothing approved. See the note on
 * `Decision` in ./enforce.ts. It also keeps this interface free of the sheet
 * store, so a dispatcher cannot read policy it has no business reading.
 */
export interface ToolDispatcher {
  dispatch(call: ResolvedToolCall, upstream: McpServer): Dispatch | Promise<Dispatch>;
}

/**
 * A dispatcher with nothing behind it.
 *
 * The honest state of the current deployment: enforcement is real and works,
 * and a call it permits has nowhere to go. Answering 501 rather than a refusal
 * keeps the two readable apart — an operator seeing `not_implemented` knows
 * their team sheet is correct and the proxy is unfinished, which is true.
 */
export function createUnavailableDispatcher(): Provisional<ToolDispatcher> {
  return markProvisional({ dispatch: () => ({ outcome: "unavailable" }) as Dispatch });
}

/**
 * Refuse to compose a proxy that would serve calls without metering them.
 *
 * The one combination that is not allowed to exist: a dispatcher that really
 * serves a call, alongside a meter that cannot exhaust a budget. Every other
 * pairing is fine — a real meter with the unavailable dispatcher is just a
 * deployment ahead of its upstream.
 *
 * **There is no provisional meter left for this to reject.** `#96` deleted
 * `createUnmeteredSpend()` and wired the real one, so the check currently
 * cannot fire in this repository. It stays because the pairing it guards is the
 * thing that goes wrong next: the approval broker (#37), the MCP client pool
 * (#39), and the message store (#63) each land a seam before they land an
 * implementation, and a stand-in meter is the obvious way to test one of them.
 * The check is what catches that, rather than a reviewer noticing.
 *
 * A thrown error at construction rather than a warning in the log, because the
 * failure this prevents is silent by nature: an unmetered proxy does not
 * misbehave, it just never refuses, and nobody notices until a bill or an
 * incident. A process that will not start is noticed immediately.
 *
 * Deleting this check is a decision someone has to make deliberately, which is
 * the point of it being here rather than in a comment.
 */
export function assertServableComposition(spend: SpendMeter, dispatcher: ToolDispatcher): void {
  if (isProvisional(spend) && !isProvisional(dispatcher)) {
    throw new Error(
      "proxy: a dispatcher that serves tool calls needs a real spend meter — " +
        "a provisional meter never exhausts a budget (see createSqliteSpendMeter)"
    );
  }
}
