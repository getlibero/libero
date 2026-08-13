// The ReAct loop: model turn, tool calls, results, repeat until the model
// stops or a cap ends the task.
//
// Two things this file deliberately does not do. It does not decide which
// tools exist or whether a call is permitted — those resolve in the tool
// proxy service, from the channel's team sheet, without this process's
// cooperation. And it does not construct a completion client or a tool
// client; both arrive as interfaces, which is what keeps the only path from
// here to a tool a network call to that service.

import { randomUUID } from "node:crypto";
import type { CompletionResponse, StopReason, ToolCall } from "../completion/types.js";
import { createCapTracker, type AbortStop, type CapTracker } from "./caps.js";
import type {
  AgentStopReason,
  AgentTaskOptions,
  AgentTaskResult,
  ToolCallAttribution,
  ToolCallStep,
  ToolExecutor,
  ToolResult
} from "./types.js";

/** Tool error text goes to the model and into the stored transcript, so it is
 *  bounded. A tool that returns a megabyte of stack trace should not become a
 *  megabyte of context. */
const MAX_TOOL_ERROR_CHARS = 2048;

/** What ended a batch of tool calls part-way. */
type DispatchStop = AbortStop | "tool_call_cap";

const STOP_NOTE: Record<DispatchStop, string> = {
  cancelled: "task cancelled",
  wall_time_cap: "task wall-time cap reached",
  tool_call_cap: "tool call cap reached"
};

/**
 * Runs one task to completion or to a cap.
 *
 * Never rejects for a cap or a tool failure — those are results, because the
 * channel needs to be told which limit stopped the task. It does reject when
 * the tool list cannot be fetched or the provider fails for a reason that is
 * not cancellation: an unreachable provider is an operator problem, not
 * something to paper over with a synthesized answer.
 */
export async function runAgentTask(options: AgentTaskOptions): Promise<AgentTaskResult> {
  const { completion, toolSource, toolExecutor, model, caps } = options;
  const now = options.now ?? Date.now;
  const tracker = createCapTracker(caps, options.signal, now);

  // Minted once, here, before the first turn. Every call this task dispatches
  // carries it, which is what makes the audit log answer "what did that one
  // request do" rather than "which calls happened to arrive together". A UUID
  // satisfies `TaskId`'s alphabet in packages/schema as it stands.
  //
  // The model never sees it and never supplies it: it is not in the system
  // prompt, not in the transcript, and not a tool argument.
  const attribution: ToolCallAttribution = {
    requestingUser: options.requestingUser,
    taskId: options.taskId ?? randomUUID()
  };

  const messages = [...options.messages];
  let text = "";
  let turns = 0;

  /**
   * Ordinals for the progress hook, allocated across the whole task rather than
   * per batch. A box because `dispatchToolCalls` is called once per turn and the
   * numbering has to survive between calls; there is nowhere else to keep it
   * that does not put turn-shaped state on the tracker, which counts caps.
   */
  const ordinals = { dispatched: 0 };

  const finish = (stopReason: AgentStopReason): AgentTaskResult => {
    const counted = tracker.snapshot();
    return {
      stopReason,
      taskId: attribution.taskId,
      text,
      messages,
      usage: counted.usage,
      totalTokens: counted.totalTokens,
      toolCalls: counted.toolCalls,
      turns,
      elapsedMs: counted.elapsedMs
    };
  };

  const preflight = tracker.abortStop();
  if (preflight !== undefined) return finish(preflight);

  const definitions = await toolSource.list(tracker.signal);

  for (;;) {
    const aborted = tracker.abortStop();
    if (aborted !== undefined) return finish(aborted);
    if (tracker.tokensExhausted()) return finish("token_cap");

    let response: CompletionResponse;
    try {
      response = await completion.complete({
        model,
        // A snapshot, not the loop's own array: the transcript keeps growing
        // after the call is made, and an adapter must see the turn it was
        // handed.
        messages: [...messages],
        maxTokens: tracker.outputCeiling(),
        signal: tracker.signal,
        ...(options.system !== undefined ? { system: options.system } : {}),
        // Omitted rather than sent empty: some OpenAI-compatible endpoints
        // reject an empty tools array.
        ...(definitions.length > 0 ? { tools: definitions } : {})
      });
    } catch (cause) {
      // A cancelled request is a reportable outcome, not an error. Anything
      // else propagates: no retry, because a task's tool calls may be
      // non-idempotent and may already have cost a human an approval click,
      // both provider SDKs already retry transport failures internally, and a
      // retry here would multiply spend against caps the tool proxy service
      // meters. If retry ever belongs anywhere it is in the adapter or that
      // service, which know idempotency; not here.
      const stopped = tracker.abortStop();
      if (stopped !== undefined) return finish(stopped);
      throw cause;
    }

    turns += 1;
    tracker.recordTurn(response.usage);
    // Before the transcript grows and before any tool runs: what this turn
    // cost is settled the moment the provider answered, and the caller's meter
    // should hear it while the task is still running rather than after. A hook
    // that throws ends the task — see its contract in ./types.ts.
    await options.onTurn?.({
      usage: response.usage,
      turn: turns,
      // Absent when the provider echoed nothing, and absent it stays: the loop
      // knows `request.model` and deliberately does not substitute it. See
      // `CompletedTurn.model`.
      ...(response.model === undefined ? {} : { model: response.model })
    });
    if (response.text !== "") text = response.text;

    messages.push({
      role: "assistant",
      content: response.text,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      // Copied by reference and never inspected. Providers verify reasoning
      // blocks server-side and require them replayed unchanged; only the
      // adapter that produced this may read it.
      ...(response.providerState !== undefined ? { providerState: response.providerState } : {})
    });

    if (response.stopReason !== "tool_use") return finish(fromStopReason(response.stopReason));

    // A tool-use turn with nothing to call would spin forever if fed back.
    if (response.toolCalls.length === 0) return finish("stopped_other");

    const stopped = await dispatchToolCalls(
      response.toolCalls,
      toolExecutor,
      attribution,
      tracker,
      messages,
      ordinals,
      options.onToolCall
    );
    if (stopped !== undefined) return finish(stopped);
  }
}

/**
 * Runs a batch of tool calls in the order the model emitted them, appending one
 * tool message per call. Returns the stop reason if a cap ended the batch.
 *
 * Sequential, not concurrent. Dispatching the batch at once would let a cap
 * with one call of allowance left run all of them, would put every call of a
 * batch in front of a human at the same moment when approvals land, and would
 * make the order of metering and audit records nondeterministic. The cost is
 * latency on parallel calls, which is not the binding constraint on a task
 * answering in a Slack thread.
 */
async function dispatchToolCalls(
  calls: ToolCall[],
  executor: ToolExecutor,
  attribution: ToolCallAttribution,
  tracker: CapTracker,
  messages: AgentTaskResult["messages"],
  ordinals: { dispatched: number },
  onToolCall: ((step: ToolCallStep) => void) | undefined
): Promise<DispatchStop | undefined> {
  let stopped: DispatchStop | undefined;

  for (const call of calls) {
    // Checked per call rather than per batch: with a cap of N, calls 1..N run
    // and N+1 is refused, even when the batch straddles the boundary.
    stopped ??= tracker.abortStop() ?? (tracker.toolCallsExhausted() ? "tool_call_cap" : undefined);

    // Allocated for every call the model asked for, including the ones a cap
    // stops. The numbering is what the task attempted.
    ordinals.dispatched += 1;
    const ordinal = ordinals.dispatched;

    if (stopped !== undefined) {
      // Every call gets a result even when it never ran. A transcript holding
      // a tool call with no matching result is not a valid conversation to
      // continue from, so skipping these would make a capped task unresumable.
      onToolCall?.({ ordinal, name: call.name, state: "skipped" });
      messages.push(note(call, `not executed: ${STOP_NOTE[stopped]}`));
      continue;
    }

    tracker.recordToolCall();
    onToolCall?.({ ordinal, name: call.name, state: "running" });

    let result: ToolResult;
    try {
      result = await executor.execute(call, attribution, tracker.signal);
    } catch (cause) {
      const aborted = tracker.abortStop();
      if (aborted !== undefined) {
        stopped = aborted;
        // Dispatched and never answered, which is `skipped`'s sibling rather
        // than an error: the call may well have run at the far end, and this
        // side has no result to call a failure.
        onToolCall?.({ ordinal, name: call.name, state: "skipped" });
        messages.push(note(call, `not completed: ${STOP_NOTE[aborted]}`));
        continue;
      }
      result = { content: toolErrorContent(cause), isError: true };
    }

    // A refusal from the proxy arrives here as an ordinary `isError` result, so
    // it shows as a failed step. That is the reading a reader wants: the call
    // did not do anything, and why is in the thread.
    onToolCall?.({ ordinal, name: call.name, state: result.isError === true ? "error" : "ok" });

    messages.push({
      role: "tool",
      toolCallId: call.id,
      content: result.content,
      ...(result.isError === true ? { isError: true } : {})
    });
  }

  return stopped;
}

function note(call: ToolCall, content: string): AgentTaskResult["messages"][number] {
  return { role: "tool", toolCallId: call.id, content, isError: true };
}

/**
 * A thrown tool failure, as the model will see it.
 *
 * The message only — no stack, no cause chain, no serialized error object.
 * This string reaches the model and the stored transcript, and an error is one
 * of the paths a credential leaks out of a process that holds one.
 */
function toolErrorContent(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  return `tool error: ${message === "" ? "tool execution failed" : message}`.slice(
    0,
    MAX_TOOL_ERROR_CHARS
  );
}

function fromStopReason(reason: Exclude<StopReason, "tool_use">): AgentStopReason {
  switch (reason) {
    case "end_turn":
      return "completed";
    case "refusal":
      return "refusal";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stopped_other";
  }
}
