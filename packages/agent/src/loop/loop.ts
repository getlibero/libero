// The ReAct loop: model turn, tool calls, results, repeat until the model
// stops or a cap ends the task.
//
// Two things this file deliberately does not do. It does not decide which
// tools exist or whether a call is permitted — those resolve in the tool
// proxy service, from the channel's team sheet, without this process's
// cooperation. And it does not construct a completion client or a tool
// client; both arrive as interfaces, which is what keeps the only path from
// here to a tool a network call to that service.

import type { CompletionResponse, StopReason, ToolCall } from "../completion/types.js";
import { createCapTracker, type AbortStop, type CapTracker } from "./caps.js";
import type { AgentStopReason, AgentTaskOptions, AgentTaskResult, ToolExecutor, ToolResult } from "./types.js";

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

  const messages = [...options.messages];
  let text = "";
  let turns = 0;

  const finish = (stopReason: AgentStopReason): AgentTaskResult => {
    const counted = tracker.snapshot();
    return {
      stopReason,
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

    const stopped = await dispatchToolCalls(response.toolCalls, toolExecutor, tracker, messages);
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
  tracker: CapTracker,
  messages: AgentTaskResult["messages"]
): Promise<DispatchStop | undefined> {
  let stopped: DispatchStop | undefined;

  for (const call of calls) {
    // Checked per call rather than per batch: with a cap of N, calls 1..N run
    // and N+1 is refused, even when the batch straddles the boundary.
    stopped ??= tracker.abortStop() ?? (tracker.toolCallsExhausted() ? "tool_call_cap" : undefined);

    if (stopped !== undefined) {
      // Every call gets a result even when it never ran. A transcript holding
      // a tool call with no matching result is not a valid conversation to
      // continue from, so skipping these would make a capped task unresumable.
      messages.push(note(call, `not executed: ${STOP_NOTE[stopped]}`));
      continue;
    }

    tracker.recordToolCall();

    let result: ToolResult;
    try {
      result = await executor.execute(call, tracker.signal);
    } catch (cause) {
      const aborted = tracker.abortStop();
      if (aborted !== undefined) {
        stopped = aborted;
        messages.push(note(call, `not completed: ${STOP_NOTE[aborted]}`));
        continue;
      }
      result = { content: toolErrorContent(cause), isError: true };
    }

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
