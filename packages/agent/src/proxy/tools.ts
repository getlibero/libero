// The `ToolSource` and `ToolExecutor` the loop actually runs against: the
// channel's permitted tools over `GET /v1/tools`, and its calls over
// `POST /v1/tools/call`.
//
// Both halves are one object because they share one thing — the mapping from
// the flat name a model calls to the (server, tool) pair the proxy takes, built
// by `list()` from what the proxy listed and read by `execute()`. A model can
// only call a tool the proxy published, and it can only be decoded to the pair
// that published it. See ./tool-names.ts for why that is a lookup and not a
// parse.
//
// **Pinned to one channel at construction.** The channel is not a parameter on
// `execute`, so there is no call this object can make that a different
// certificate would authenticate. The transport takes a channel per request
// because the process serves many; this does not, because one task serves one.
//
// **The agent does not filter the list.** The proxy has already resolved it
// against the channel's team sheet, and a second opinion here would either
// agree — in which case it is dead code that can drift — or disagree, in which
// case the model's tools are decided by the process running the model. There is
// exactly one enforcement point and it is not this one.
//
// **A held call is waited out here, and decided nowhere near here.** With an
// `onHeld` prompter, `execute` pauses on a hold and then re-submits the
// identical call carrying the ticket — whatever the wait's outcome, because the
// proxy is the authority on what the call became and answers a re-submission
// with either the result or the precise refusal (denied, expired, still
// pending). The model sees one tool result either way and never the ticket id.
// The wait spends the task's wall clock by design: the deadline composed into
// the signal this method is handed is what bounds it, and a cap sized in
// minutes colliding with an approval that takes ten of them is the operator's
// trade in the sheet, not a special case here (#127).

import {
  ToolCallResponse,
  ToolListing,
  refusalMessage,
  type ApprovalTicket,
  type BudgetWarning,
  type ToolCall as WireToolCall
} from "@getlibero/schema";
import type { ToolCall, ToolDefinition } from "../completion/types.js";
import type { ToolCallAttribution, ToolExecutor, ToolResult, ToolSource } from "../loop/types.js";
import { proxyErrorFrom } from "./errors.js";
import { mapPermittedTools, type MappedTool } from "./tool-names.js";
import { ProxyClientError, type ProxyTransport } from "./transport.js";

/**
 * A held call, as the prompter is told about it.
 *
 * The `(server, tool)` pair rather than the flat model name, because what a
 * human is asked to approve is what the proxy will run — the pair — and the
 * flat name is a modelism this type's consumer has no use for. The arguments
 * are for rendering only: the ticket already binds their hash, so nothing
 * downstream needs to compare them, and a prompter that displays them displays
 * what the proxy hashed.
 */
export interface HeldToolCall {
  readonly server: string;
  readonly tool: string;
  /** The model's arguments as sent. Render-only — the ticket binds their hash. */
  readonly arguments: Record<string, unknown>;
  readonly ticket: ApprovalTicket;
  /** Attribution, as on the wire call. For log lines and the card, never a gate. */
  readonly requestingUser: string;
  readonly taskId: string;
}

/**
 * Asks a human about a held call and resolves when the wait is over — decided,
 * expired, aborted, or unaskable. It resolves to nothing, deliberately: the
 * re-submission is the authority on what the call became, so there is no
 * verdict a prompter could return that `execute` would be right to act on. A
 * rejection is treated exactly as a resolution, and nothing it carries reaches
 * the model.
 */
export type HeldCallPrompter = (held: HeldToolCall, signal?: AbortSignal) => Promise<void>;

/**
 * A call refused here rather than by the proxy, because the name the model used
 * decoded to no `(server, tool)` pair.
 *
 * There is no `(server, tool)` on it — that is the whole condition — and no
 * arguments either: what an operator needs is that a name was tried and which
 * one, and the arguments of a call that was never made are the model's own
 * text with nothing to correlate them against.
 *
 * `name` is **model-authored text**, the only field on this object that did not
 * originate in this system. It is a value here rather than a sentence so that a
 * consumer puts it in a structured field and never interpolates it into a
 * message.
 */
export interface UnmappedToolCall {
  /** The flat name as the model emitted it. Model-authored; see above. */
  readonly name: string;
  /** Attribution, as it would have gone on the wire call. Never a gate. */
  readonly requestingUser: string;
  readonly taskId: string;
}

export interface ProxyToolClientOptions {
  transport: ProxyTransport;
  /** Whose certificate every request presents. Fixed for the life of this object. */
  channel: string;
  /**
   * What to do with a held call. Absent, a hold is relayed to the model as the
   * refusal-shaped result it is — safe, and it abandons a call a human could
   * have approved. Present, the hold is waited out and the call re-submitted
   * with its ticket, whatever the wait's outcome; see `execute`.
   */
  onHeld?: HeldCallPrompter;
  /**
   * Told about a call refused here rather than by the proxy. Absent, nothing
   * records it — which is what every caller did before #170, and still the
   * right default for a caller with nowhere to put it.
   *
   * A callback rather than a logger because this package has no way to log and
   * should not gain one: `./spend.ts` argues that for the sibling client in
   * this directory, and it is why `spend_reported` is a word in `apps/server`
   * rather than in the client that provokes it. The composer also holds what a
   * line wants and this object does not — the channel, and the front-end's own
   * trace id.
   *
   * **It must not throw.** Nothing catches it: `execute` would propagate, and
   * the loop would turn a refusal that was working correctly into an error
   * result. Catching here is worse than the throw, for the reason `onTurn`
   * gives in ../loop/types.ts — this file cannot log, so a swallowed failure
   * vanishes rather than being reported.
   */
  onUnmappedCall?: (call: UnmappedToolCall) => void;
  /**
   * Told when a served call came back carrying the channel's soft budget
   * warning (#99). Absent, the notice is dropped and the result is unaffected.
   *
   * A callback for `onUnmappedCall`'s reasons — this package cannot log and must
   * not learn how, and the composer is what holds somewhere to put it. **It must
   * not throw**, on the same terms: nothing catches it, so a rejection would
   * turn a call that ran into an error result because a *notice* could not be
   * filed.
   *
   * It does not reach the model, and that is a decision rather than an omission.
   * The warning is addressed to the people in the channel, whose remedy is an
   * edit to the sheet; a model told it is near a budget has no lever the loop's
   * own caps do not already pull, and the sentence would then be re-sent as
   * context on every subsequent turn of the task.
   */
  onBudgetWarning?: (warning: BudgetWarning) => void;
}

/** Both halves, so a caller cannot wire one to the proxy and the other to a stub. */
export interface ProxyToolClient extends ToolSource, ToolExecutor {}

export function createProxyToolClient(options: ProxyToolClientOptions): ProxyToolClient {
  const { transport, channel, onHeld, onUnmappedCall, onBudgetWarning } = options;
  let byModelName = new Map<string, MappedTool>();

  /**
   * A call that ran: pass the notice out, hand the result to the loop.
   *
   * One function for both submissions, because either can carry the warning —
   * the proxy decides on the call it serves, and an approved call is served by
   * the second. It cannot arrive twice for one channel in a day, and this side
   * does not enforce that: the claim is the proxy's, made once against its own
   * meter, which is the only place that could know.
   */
  function served(answer: Extract<ToolCallResponse, { outcome: "ran" }>): ToolResult {
    if (answer.warning !== undefined) onBudgetWarning?.(answer.warning);
    return answer.result;
  }

  /** One submission: POST the body, insist on an answer that parses. */
  async function submit(body: WireToolCall, signal?: AbortSignal): Promise<ToolCallResponse> {
    const response = await transport.request({
      channel,
      method: "POST",
      path: "/v1/tools/call",
      body,
      ...(signal !== undefined ? { signal } : {})
    });

    if (response.status !== 200) throw proxyErrorFrom(response.body, "the tool call failed");

    const parsed = ToolCallResponse.safeParse(response.body);
    if (!parsed.success) {
      throw new ProxyClientError(
        "proxy client: the tool call answer was not a valid response",
        "malformed_response"
      );
    }
    return parsed.data;
  }

  return {
    /**
     * The channel's permitted tools.
     *
     * Throws rather than degrading to an empty list, and the loop propagates it
     * — which ends the task with no reply in the thread. That is the honest
     * outcome: a proxy that cannot be reached is an operator problem, and an
     * agent that answers as though the channel had no tools is a worse failure
     * than one that answers nothing, because it looks like it worked.
     */
    async list(signal?: AbortSignal): Promise<ToolDefinition[]> {
      const response = await transport.request({
        channel,
        method: "GET",
        path: "/v1/tools",
        ...(signal !== undefined ? { signal } : {})
      });

      if (response.status !== 200) throw proxyErrorFrom(response.body, "the tool listing failed");

      // Parsed, not trusted. The proxy is ours, and the reason to parse anyway
      // is that "ours" is an assumption about the network and this is the
      // process on the exposed side of it.
      const parsed = ToolListing.safeParse(response.body);
      if (!parsed.success) {
        throw new ProxyClientError(
          "proxy client: the tool listing was not a valid listing",
          "malformed_response"
        );
      }

      const mapped = mapPermittedTools(parsed.data.tools);
      byModelName = mapped.byModelName;
      return mapped.definitions;
    },

    /**
     * One tool call.
     *
     * Never throws for a refusal, and that is the contract the loop is built
     * on: a refusal is a served request, so it comes back as `isError: true`
     * content the model relays to the channel and the task carries on. What
     * does throw is a request that was not answered — an unreachable proxy, a
     * rejected certificate, a response that does not parse — which the loop
     * turns into an error result of its own, so even that does not drop a task.
     */
    async execute(
      call: ToolCall,
      attribution: ToolCallAttribution,
      signal?: AbortSignal
    ): Promise<ToolResult> {
      const mapped = byModelName.get(call.name);
      if (mapped === undefined) {
        // Not a pair, so there is nothing to send. A model that invented a name
        // is told so and may try something else; the proxy is not asked about a
        // tool it never published.
        //
        // Reported before it is returned, because otherwise this is the one
        // refusal in the system that only the model ever sees: the proxy never
        // saw the call and rightly writes no audit row, so without this a model
        // can probe fifty names and the audit log shows a task that made no
        // tool calls (#170). The listing is fetched once per task on a client
        // built for that task, so a name outside the map is invented rather
        // than stale — which is what makes this worth a line at all.
        onUnmappedCall?.({
          name: call.name,
          requestingUser: attribution.requestingUser,
          taskId: attribution.taskId
        });
        return {
          content: `\`${call.name}\` is not a tool this channel permits. The call was not made.`,
          isError: true
        };
      }

      const body: WireToolCall = {
        id: call.id,
        server: mapped.server,
        tool: mapped.tool,
        arguments: call.arguments,
        // Attribution, not authentication. The proxy writes it down and decides
        // nothing from it — see the fields' doc comments in @getlibero/schema.
        requestingUser: attribution.requestingUser,
        task: attribution.taskId
      };
      // No `channel` key, and none is possible: `ToolCall` is strict, so a body
      // carrying one is rejected by the proxy rather than having the field
      // dropped. The channel comes from the certificate this request presents.

      const answer = await submit(body, signal);
      switch (answer.outcome) {
        case "ran":
          return served(answer);
        case "refused":
          // Relayed as what it is. `refusalMessage` words it, so the sentence a
          // channel sees cannot disagree with the reason the proxy gave.
          return { content: refusalMessage(answer.refusal), isError: true };
        case "held": {
          // With nothing to ask a human through, a hold is relayed like a
          // refusal — safe, and it abandons a call a human could have
          // approved. The hold's own sentence says it is held.
          if (onHeld === undefined) {
            return { content: refusalMessage(answer.refusal), isError: true };
          }

          try {
            await onHeld(
              {
                server: mapped.server,
                tool: mapped.tool,
                arguments: call.arguments,
                ticket: answer.ticket,
                requestingUser: attribution.requestingUser,
                taskId: attribution.taskId
              },
              signal
            );
          } catch {
            // A rejection means the wait ended badly rather than well; either
            // way it ended. Nothing the prompter threw reaches the model — the
            // re-submission below is the whole answer, and the proxy's refusal
            // for an undecided ticket says "not decided" better than any error
            // text would.
          }

          // The identical body plus the ticket, on the same signal. Identical
          // is load-bearing: redemption matches server, tool, and the argument
          // hash, so any drift here turns an approval into a mismatch refusal.
          // An aborted signal rejects in the transport as `cancelled`, which
          // the loop maps to the task's stop reason — the wait itself never
          // decides what the abort meant.
          const redeemed = await submit({ ...body, ticket: answer.ticket.id }, signal);
          switch (redeemed.outcome) {
            case "ran":
              return served(redeemed);
            // A second `held` for a ticketed call is a proxy the contract says
            // cannot exist; relaying its refusal abandons the call, which is
            // the safe reading of an impossible answer. The refusal cases are
            // the point: approved-then-run is `ran` above, and denial, expiry,
            // a sheet edit during the hold, and a lost ticket each come back as
            // the precise refusal the proxy wrote. The model sees one tool
            // result either way, and no sentence in it carries the ticket id.
            case "held":
            case "refused":
              return { content: refusalMessage(redeemed.refusal), isError: true };
          }
        }
      }
    }
  };
}
