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
import type { ResolvedToolCall, ToolRefusal, ToolResult } from "@getlibero/schema";

/**
 * How much this channel has spent today.
 *
 * The seam for the budget meter (#38), which owns persistence, rollover, and
 * the counting itself. Enforcement compares these numbers against the sheet —
 * the comparison is policy and lives with the sheet; the numbers are
 * accounting and live here.
 */
export interface SpendMeter {
  read(channel: string): BudgetSpend | Promise<BudgetSpend>;
}

/**
 * Marks the two provisional implementations below.
 *
 * A symbol rather than a name or an `instanceof`, so the mark cannot be set by
 * accident and does not widen the interfaces: an implementation written by #38
 * or #51 has no way to acquire it without importing it and saying so.
 */
const PROVISIONAL = Symbol("libero.provisional");

type Provisional<T> = T & { readonly [PROVISIONAL]: true };

function isProvisional(value: object): boolean {
  return PROVISIONAL in value;
}

/**
 * A meter that reports nothing spent, ever.
 *
 * Stands in until #38. **It is not a stub that fails safe** — a channel served
 * by this meter never exhausts its budget, so `budget_exhausted` is
 * unreachable and one of the five things a team sheet promises is not being
 * kept. That is acceptable only because no deployment can currently make a tool
 * call at all: the dispatcher below refuses to serve one.
 *
 * The pairing is not left to whoever lands #51 to remember.
 * `assertServableComposition` refuses to build a proxy that has a real
 * dispatcher and this meter, so the day tool calls start working is the day
 * this either gets replaced or the process does not start.
 */
export function createUnmeteredSpend(): Provisional<SpendMeter> {
  return { [PROVISIONAL]: true, read: () => ({ tokens: 0, toolCalls: 0 }) };
}

/**
 * What serving an allowed call produced.
 *
 * A result type rather than exceptions, matching `Decision` and
 * `ChannelIdentity`: on this path a thrown value can carry a credential in its
 * message, so the states worth distinguishing are enumerated instead.
 *
 * `refused` is here as well as in `decide` because two refusal reasons cannot
 * be answered from the team sheet alone — `credential_unresolved` needs the
 * vault (#51) and `egress_denied` needs the resolved destination (#73). Those
 * are refusals discovered while serving, not permissions denied before it.
 */
export type Dispatch =
  | { readonly outcome: "ran"; readonly result: ToolResult }
  | { readonly outcome: "refused"; readonly refusal: ToolRefusal }
  /** No upstream is built. Becomes a 501, not a refusal: nothing was denied. */
  | { readonly outcome: "unavailable" };

/**
 * Serves an allowed call.
 *
 * The seam for credential injection (#51) and the MCP client pool (#39). The
 * server calls this **only** on an `allow`, which is the property the tests
 * assert against a recording implementation: a refused or held call must leave
 * no trace here, because reaching this interface at all is what opens a
 * connection and resolves a secret.
 */
export interface ToolDispatcher {
  dispatch(call: ResolvedToolCall): Dispatch | Promise<Dispatch>;
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
  return { [PROVISIONAL]: true, dispatch: () => ({ outcome: "unavailable" }) };
}

/**
 * Refuse to compose a proxy that would serve calls without metering them.
 *
 * The one combination that is not allowed to exist: a dispatcher that really
 * serves a call, alongside the meter that reports nothing spent. Every other
 * pairing is fine — a real meter with the unavailable dispatcher is just a
 * deployment ahead of its upstream, and both provisional together is what ships
 * today.
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
        "createUnmeteredSpend() never exhausts a budget (see #38)"
    );
  }
}
