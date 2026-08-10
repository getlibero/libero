// The model, scripted.
//
// Each case is a deterministic sequence of completions, so a hostile model is a
// list rather than a prompt — no live provider, no sampling, no flakes. The
// fake sits at the `CompletionClient` seam and nowhere lower, which is the
// convention packages/agent/src/loop/loop.test.ts sets: faking at fetch would
// be testing a provider adapter, which is that adapter's own suite's job.
//
// `seen` is not a debugging convenience. The model's transcript is where a
// leaked credential actually lands — a tool result carrying one becomes a
// `tool` message on the very next turn — so it is one of the surfaces the
// canary scan reads, and the most important one.

import type { CompletionClient, CompletionRequest, CompletionResponse, ToolCall } from "@getlibero/agent";

export interface ScriptedModel {
  readonly client: CompletionClient;
  /** Every request the model was given, in order, across every task. */
  readonly seen: CompletionRequest[];
}

/** Token counts have to be non-zero, or `daily_tokens` never moves and proves nothing. */
const USAGE = { inputTokens: 12, outputTokens: 7 } as const;

/** One turn's answer: text and stop. */
export function says(text: string): CompletionResponse {
  return { text, toolCalls: [], stopReason: "end_turn", usage: { ...USAGE } };
}

/** One turn's answer: call a tool. `name` is the flat name the listing published. */
export function calls(name: string, args: Record<string, unknown>, id = "call-1"): CompletionResponse {
  const toolCall: ToolCall = { id, name, arguments: args };
  return { text: "", toolCalls: [toolCall], stopReason: "tool_use", usage: { ...USAGE } };
}

/**
 * Replays `script` one entry per turn.
 *
 * Running off the end throws rather than looping or returning something
 * plausible: a task that took more turns than the case scripted has stopped
 * being the scenario under test, and the error says which turn it was.
 */
export function scriptedModel(script: readonly CompletionResponse[]): ScriptedModel {
  const seen: CompletionRequest[] = [];
  return {
    seen,
    client: {
      complete(request: CompletionRequest): Promise<CompletionResponse> {
        const next = script[seen.length];
        seen.push(request);
        if (next === undefined) {
          throw new Error(`e2e: the model was asked for turn ${seen.length}; the script has ${script.length}`);
        }
        return Promise.resolve(next);
      }
    }
  };
}
