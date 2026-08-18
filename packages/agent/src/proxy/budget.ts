// Whether a channel can afford one more turn, asked before spending it (#335).
//
// The read half of the meter, and the exact counterpart of ./spend.ts beside it:
// that one tells the tool proxy service what a turn cost and can read nothing,
// this one asks what the channel's position is and can write nothing. The
// asymmetry is deliberate on both ends — the service narrows each route to one
// direction, and so does each client here.
//
// ## Why a read exists at all
//
// The service enforces `[budget]` on a tool call, which is the only spend it
// ever observes. A model completion does not pass through it: the process that
// runs the model talks to the provider directly and reports the counts
// afterwards, so a turn that calls no tool meets no gate, however far over its
// caps the channel is. Four background passes run on a clock with nobody waiting
// on them and three of those spend exactly that way. This is how such a pass
// declines.
//
// **It is advisory and not a boundary.** A compromised agent process simply does
// not ask. What it buys is a correctly-functioning deployment not spending a
// channel's budget on work nobody requested — the same standing `[ambient]` has,
// honoured by this process and by nothing else. Nothing about the tool gate
// changes, and that is still the part that survives compromise.
//
// ## The deadline, and why this takes a signal where ./spend.ts refuses one
//
// That file states its rule and the rule inverts here. It takes no caller signal
// because the only one in scope cancels a task, and *a cancelled task still
// spent tokens* — discarding the report would lose a real count. This client is
// consulted **before** anything is spent, so a caller shutting down is a caller
// that should not spend: cancelling the question is exactly right, and the
// signal is passed through.
//
// It carries its own short deadline as well, and that is not belt-and-braces.
// The only signal a background pass holds is process shutdown, which bounds
// nothing during normal running, and those passes run on their channel's session
// mutex — so a question left hanging on an unresponsive service would hold that
// channel's mutex and stall the next task's context read behind it. The deadline
// is what makes "asking is cheap" true rather than hoped for.
//
// ## A failure throws, and what it means is the caller's
//
// ./spend.ts's rule, and ./tools.ts's: this file has no way to log and should
// not gain one. Whether an unanswerable question means "spend anyway"
// or "do not spend" is policy, and it belongs where the logger and the channel's
// settings already are.

import { BudgetStatus, type ToolRefusal } from "@getlibero/schema";
import { proxyErrorFrom } from "./errors.js";
import { ProxyClientError, type ProxyTransport } from "./transport.js";

/**
 * How long the question may take before it is abandoned.
 *
 * ./spend.ts's figure and most of its argument: an order of magnitude under the
 * transport's own default, because the work at the other end is one sheet read
 * and one row. What differs is who is waiting — there, a Slack thread waits on
 * bookkeeping; here, a channel's session mutex is held while a background pass
 * asks whether to start. Neither wants five seconds, and neither is helped by
 * thirty.
 */
export const DEFAULT_BUDGET_TIMEOUT_MS = 5_000;

export interface ProxyBudgetClientOptions {
  transport: ProxyTransport;
  /** Whose certificate every question presents. Fixed for the life of this object. */
  channel: string;
  timeoutMs?: number;
}

export interface ProxyBudgetClient {
  /**
   * What the tool gate would say about spending in this channel right now.
   *
   * `null` is "go ahead". A `ToolRefusal` is why not, in the vocabulary the gate
   * itself answers in — the same reason code an operator would find in the audit
   * log for a call refused at the same moment.
   *
   * **Do not word it with `refusalMessage`.** Every sentence that function
   * produces is written for a call that was attempted; none of it is true of a
   * turn asking whether to begin.
   *
   * `signal` cancels the question. Passing the one that means "this process is
   * stopping" is correct here and is not correct for a spend report — see the
   * header.
   */
  status(signal?: AbortSignal): Promise<ToolRefusal | null>;
}

export function createProxyBudgetClient(options: ProxyBudgetClientOptions): ProxyBudgetClient {
  const { transport, channel } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUDGET_TIMEOUT_MS;

  return {
    async status(signal?: AbortSignal): Promise<ToolRefusal | null> {
      const deadline = AbortSignal.timeout(timeoutMs);
      // Both, because they mean different things and the caller's is the one
      // whose meaning must survive: `AbortSignal.any` fires on whichever comes
      // first, and the catch below tells them apart.
      const abort = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

      let response;
      try {
        response = await transport.request({ channel, method: "GET", path: "/v1/budget", signal: abort });
      } catch (cause) {
        // Any aborted signal reaches us as a cancellation, and here two things
        // could have aborted. Only the deadline is renamed: a caller that
        // genuinely cancelled gets `cancelled`, which is what happened, and an
        // operator reading `timed_out` learns the service did not answer rather
        // than that the process was shutting down.
        if (
          cause instanceof ProxyClientError &&
          cause.reason === "cancelled" &&
          deadline.aborted &&
          signal?.aborted !== true
        ) {
          throw new ProxyClientError("proxy client: the budget question timed out", "timed_out");
        }
        throw cause;
      }

      if (response.status !== 200) {
        throw proxyErrorFrom(response.body, "the budget question failed", response.status);
      }

      const parsed = BudgetStatus.safeParse(response.body);
      if (!parsed.success) {
        throw new ProxyClientError(
          "proxy client: the budget answer was not a valid status",
          "malformed_response"
        );
      }

      return parsed.data.spendable ? null : parsed.data.refusal;
    }
  };
}
