// The loop is faked at the CompletionClient seam, not at the transport.
//
// completion/conformance.ts drives a real adapter through fetch-level fixtures
// to prove it maps a provider's wire format correctly. Reusing it here would
// tie every loop test to Anthropic or OpenAI JSON and need a fixture file per
// case — which is exactly the coupling the completion layer exists to remove.
// Keep the two apart.

import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { CompletionError } from "../completion/types.js";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
  ToolDefinition
} from "../completion/types.js";
import { runAgentTask } from "./loop.js";
import { createStubToolSource, createUnavailableToolExecutor } from "./stub-tools.js";
import { DEFAULT_AGENT_LOOP_CAPS } from "./types.js";
import type {
  AgentLoopCaps,
  AgentTaskOptions,
  ToolCallAttribution,
  ToolCallStep,
  ToolExecutor,
  ToolResult,
  ToolSource
} from "./types.js";

const MODEL = "test-model";

const CAPS: AgentLoopCaps = {
  maxToolCalls: 10,
  maxWallTimeMs: 60_000,
  maxTokens: 100_000,
  maxOutputTokensPerTurn: 1024
};

function response(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial
  };
}

/** Replays a script of responses. Throws when it runs out, so a loop that
 *  should have stopped fails the test loudly instead of hanging. */
function fakeCompletion(script: Array<CompletionResponse | (() => Promise<CompletionResponse>)>): {
  client: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    client: {
      async complete(request: CompletionRequest): Promise<CompletionResponse> {
        requests.push(request);
        const next = script[index++];
        if (next === undefined) throw new Error(`unscripted completion call #${index}`);
        return typeof next === "function" ? await next() : next;
      }
    }
  };
}

/** Resolves only once the request's signal aborts. Lets the wall-time cases
 *  use a real 1 ms deadline — fake timers do not drive AbortSignal.timeout. */
function hangingCompletion(): { client: CompletionClient; sawAbort: () => boolean } {
  let aborted = false;
  return {
    sawAbort: () => aborted,
    client: {
      complete: (request: CompletionRequest) =>
        new Promise<CompletionResponse>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new CompletionError("completion request failed", "fake"));
          });
        })
    }
  };
}

function fakeExecutor(
  handlers: Record<string, (call: ToolCall) => ToolResult | Promise<ToolResult>> = {}
): { executor: ToolExecutor; calls: ToolCall[]; attributions: ToolCallAttribution[] } {
  const calls: ToolCall[] = [];
  const attributions: ToolCallAttribution[] = [];
  return {
    calls,
    attributions,
    executor: {
      async execute(call: ToolCall, attribution: ToolCallAttribution): Promise<ToolResult> {
        calls.push(call);
        attributions.push(attribution);
        const handler = handlers[call.name];
        if (handler === undefined) return { content: "no such tool", isError: true };
        return await handler(call);
      }
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toolCall(id: string, name = "lookup"): ToolCall {
  return { id, name, arguments: {} };
}

const DEFINITION: ToolDefinition = {
  name: "lookup",
  description: "look something up",
  inputSchema: { type: "object", properties: {} }
};

function task(overrides: Partial<AgentTaskOptions> & Pick<AgentTaskOptions, "completion">): AgentTaskOptions {
  return {
    toolSource: createStubToolSource(),
    toolExecutor: fakeExecutor().executor,
    model: MODEL,
    requestingUser: "U0ASKER",
    messages: [{ role: "user", content: "hello" }],
    caps: CAPS,
    ...overrides
  };
}

describe("the agent loop, happy path", () => {
  it("answers in one turn and sends no tools when there are none", async () => {
    const { client, requests } = fakeCompletion([response({ text: "hi", stopReason: "end_turn" })]);

    const result = await runAgentTask(task({ completion: client }));

    expect(result.stopReason).toBe("completed");
    expect(result.text).toBe("hi");
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]?.maxTokens).toBe(CAPS.maxOutputTokensPerTurn);
  });

  it("threads a tool result back into the next turn", async () => {
    const { client, requests } = fakeCompletion([
      response({ text: "checking", stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor, calls } = fakeExecutor({ lookup: () => ({ content: "42" }) });

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: executor, toolSource: createStubToolSource([DEFINITION]) })
    );

    expect(result.stopReason).toBe("completed");
    expect(result.text).toBe("done");
    expect(result.toolCalls).toBe(1);
    expect(calls).toHaveLength(1);

    // The seed, the assistant turn carrying the call, then its result.
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "checking", toolCalls: [toolCall("call-1")] },
      { role: "tool", toolCallId: "call-1", content: "42" }
    ]);
  });

  it("replays providerState untouched, and omits the key when there is none", async () => {
    const state = [{ type: "thinking", thinking: "…", signature: "sig" }];
    const { client, requests } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")], providerState: state }),
      response({ text: "done", stopReason: "end_turn" })
    ]);

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor })
    );

    const replayed = requests[1]?.messages[1];
    expect(replayed).toMatchObject({ role: "assistant" });
    // Identity, not a structural copy: signatures are verified server-side.
    expect((replayed as { providerState?: unknown }).providerState).toBe(state);

    const last = result.messages.at(-1);
    expect(last).toBeDefined();
    // exactOptionalPropertyTypes: absent, not present-and-undefined.
    expect("providerState" in (last as object)).toBe(false);
  });

  it("runs a parallel batch in emission order", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("a"), toolCall("b"), toolCall("c")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor, calls } = fakeExecutor({ lookup: async (call) => {
      // The first call is the slowest: sequential dispatch preserves order anyway.
      await sleep(call.id === "a" ? 5 : 0);
      return { content: call.id };
    } });

    const result = await runAgentTask(task({ completion: client, toolExecutor: executor }));

    expect(calls.map((call) => call.id)).toEqual(["a", "b", "c"]);
    expect(result.messages.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", toolCallId: "a", content: "a" },
      { role: "tool", toolCallId: "b", content: "b" },
      { role: "tool", toolCallId: "c", content: "c" }
    ]);
  });

  it("sends the tool definitions on every turn, not only the first", async () => {
    const { client, requests } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);

    await runAgentTask(
      task({
        completion: client,
        toolSource: createStubToolSource([DEFINITION]),
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor
      })
    );

    expect(requests[0]?.tools).toEqual([DEFINITION]);
    expect(requests[1]?.tools).toEqual([DEFINITION]);
  });

  it("sums usage across turns and keeps unreported cache fields absent", async () => {
    const { client } = fakeCompletion([
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("call-1")],
        usage: { inputTokens: 10, outputTokens: 5 }
      }),
      response({ text: "done", stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 7 } })
    ]);

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor })
    );

    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(result.totalTokens).toBe(42);
  });
});

// What a turn cost is settled when the provider answers, and the caller's meter
// should hear it then rather than when the task happens to end.
describe("telling the caller what each turn cost", () => {
  it("reports each turn's own usage, numbered from one", async () => {
    const seen: Array<{ usage: unknown; turn: number }> = [];
    const { client } = fakeCompletion([
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("call-1")],
        usage: { inputTokens: 10, outputTokens: 5 }
      }),
      response({
        text: "done",
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 4096 }
      })
    ]);

    await runAgentTask(
      task({
        completion: client,
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
        onTurn: ({ usage, turn }) => {
          seen.push({ usage, turn });
        }
      })
    );

    // Each turn's own numbers, not the running total: summing is the meter's,
    // and a caller handed totals could not tell a retry from a new turn.
    expect(seen).toEqual([
      { usage: { inputTokens: 10, outputTokens: 5 }, turn: 1 },
      { usage: { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 4096 }, turn: 2 }
    ]);
  });

  describe("onToolCall", () => {
    /** Every step, flattened to `<ordinal> <name> <state>` for readable assertions. */
    const trace = (steps: ToolCallStep[]): string[] =>
      steps.map(step => `${String(step.ordinal)} ${step.name} ${step.state}`);

    it("reports each call running and then how it ended", async () => {
      const steps: ToolCallStep[] = [];
      const { client } = fakeCompletion([
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-1"), toolCall("call-2")] }),
        response({ text: "done", stopReason: "end_turn" })
      ]);

      await runAgentTask(
        task({
          completion: client,
          toolExecutor: fakeExecutor({
            lookup: call =>
              call.id === "call-1" ? { content: "ok" } : { content: "no", isError: true }
          }).executor,
          onToolCall: step => {
            steps.push(step);
          }
        })
      );

      expect(trace(steps)).toEqual([
        "1 lookup running",
        "1 lookup ok",
        "2 lookup running",
        "2 lookup error"
      ]);
    });

    // A refusal from the proxy arrives as an ordinary `isError` result, and a
    // throw becomes one in the loop. Both read as a failed step.
    it("reports a thrown tool failure as an error, not as a lost step", async () => {
      const steps: ToolCallStep[] = [];
      const { client } = fakeCompletion([
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
        response({ text: "done", stopReason: "end_turn" })
      ]);

      await runAgentTask(
        task({
          completion: client,
          toolExecutor: {
            execute: () => Promise.reject(new Error("upstream down"))
          },
          onToolCall: step => {
            steps.push(step);
          }
        })
      );

      expect(trace(steps)).toEqual(["1 lookup running", "1 lookup error"]);
    });

    // Ordinals number what the task attempted, so a capped call still gets one
    // — and it is never reported running, because it never was.
    it("numbers a capped call and reports it skipped, never running", async () => {
      const steps: ToolCallStep[] = [];
      const { client } = fakeCompletion([
        response({
          stopReason: "tool_use",
          toolCalls: [toolCall("call-1"), toolCall("call-2"), toolCall("call-3")]
        })
      ]);

      const result = await runAgentTask(
        task({
          completion: client,
          caps: { ...CAPS, maxToolCalls: 1 },
          toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
          onToolCall: step => {
            steps.push(step);
          }
        })
      );

      expect(result.stopReason).toBe("tool_call_cap");
      expect(trace(steps)).toEqual([
        "1 lookup running",
        "1 lookup ok",
        "2 lookup skipped",
        "3 lookup skipped"
      ]);
    });

    // Ordinals are task-global: a second turn's first call is not ordinal 1
    // again, or a consumer keyed on it would overwrite the first turn's row.
    it("numbers across turns, not within one", async () => {
      const steps: ToolCallStep[] = [];
      const { client } = fakeCompletion([
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-2")] }),
        response({ text: "done", stopReason: "end_turn" })
      ]);

      await runAgentTask(
        task({
          completion: client,
          toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
          onToolCall: step => {
            steps.push(step);
          }
        })
      );

      expect(steps.map(step => step.ordinal)).toEqual([1, 1, 2, 2]);
    });

    // The name is the model's own text, relayed as a value. A name that decodes
    // to no tool is refused by the client rather than here, and still counts.
    it("reports the name the model emitted, whatever it was", async () => {
      const steps: ToolCallStep[] = [];
      const { client } = fakeCompletion([
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-1", "<!channel>")] }),
        response({ text: "done", stopReason: "end_turn" })
      ]);

      await runAgentTask(
        task({
          completion: client,
          toolExecutor: { execute: () => Promise.resolve({ content: "no such tool", isError: true }) },
          onToolCall: step => {
            steps.push(step);
          }
        })
      );

      expect(steps.map(step => step.name)).toEqual(["<!channel>", "<!channel>"]);
    });

    it("is optional: a task with no hook runs exactly as before", async () => {
      const { client } = fakeCompletion([
        response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
        response({ text: "done", stopReason: "end_turn" })
      ]);

      const result = await runAgentTask(
        task({
          completion: client,
          toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor
        })
      );

      expect(result.stopReason).toBe("completed");
      expect(result.toolCalls).toBe(1);
    });
  });

  it("is not called when no turn was taken", async () => {
    const seen: number[] = [];
    const { client } = fakeCompletion([response({ text: "unreachable" })]);

    const result = await runAgentTask(
      task({
        completion: client,
        signal: AbortSignal.abort(),
        onTurn: ({ turn }) => {
          seen.push(turn);
        }
      })
    );

    expect(result.stopReason).toBe("cancelled");
    expect(seen).toEqual([]);
  });

  // The ordering the meter is being told about: turn 2 must not be under way
  // while turn 1 is still being recorded.
  it("waits for the hook before taking the next turn", async () => {
    const order: string[] = [];
    const { client } = fakeCompletion([
      () => {
        order.push("turn-1");
        return Promise.resolve(
          response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] })
        );
      },
      () => {
        order.push("turn-2");
        return Promise.resolve(response({ text: "done", stopReason: "end_turn" }));
      }
    ]);

    await runAgentTask(
      task({
        completion: client,
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
        onTurn: async ({ turn }) => {
          await Promise.resolve();
          order.push(`reported-${turn}`);
        }
      })
    );

    expect(order).toEqual(["turn-1", "reported-1", "turn-2", "reported-2"]);
  });

  // The whole point of reporting per turn rather than per task. A task that
  // dies mid-flight has already told the caller what its finished turns cost,
  // so nothing has to be recovered from the rejection.
  it("has already reported the turns a task took before the provider failed", async () => {
    const seen: number[] = [];
    const failure = new CompletionError("completion request failed", "fake");
    const { client } = fakeCompletion([
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("call-1")],
        usage: { inputTokens: 10, outputTokens: 5 }
      }),
      () => Promise.reject(failure)
    ]);

    await expect(
      runAgentTask(
        task({
          completion: client,
          toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
          onTurn: ({ turn }) => {
            seen.push(turn);
          }
        })
      )
    ).rejects.toBe(failure);

    expect(seen).toEqual([1]);
  });

  // Stated as a contract in types.ts rather than defended against here: this
  // file has no way to log, so catching would make the failure vanish. The
  // test records the consequence so nobody has to discover it in production.
  it("ends the task when the hook throws, which is why the contract forbids it", async () => {
    const { client } = fakeCompletion([response({ text: "done", stopReason: "end_turn" })]);

    await expect(
      runAgentTask(
        task({
          completion: client,
          onTurn: () => {
            throw new Error("meter exploded");
          }
        })
      )
    ).rejects.toThrow("meter exploded");
  });
});

describe("the agent loop, attribution", () => {
  const threeCalls = (): CompletionResponse[] => [
    response({ stopReason: "tool_use", toolCalls: [toolCall("call-1"), toolCall("call-2")] }),
    response({ stopReason: "tool_use", toolCalls: [toolCall("call-3")] }),
    response({ text: "done", stopReason: "end_turn" })
  ];

  // The whole point of the id: an audit record answers "what did that one
  // request do", which it can only do if every call of one run shares a mark.
  // Across two turns as well as within one batch, since a ReAct run is neither.
  it("marks every call of one task with the same id", async () => {
    const { client } = fakeCompletion(threeCalls());
    const { executor, attributions } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: executor, toolSource: createStubToolSource([DEFINITION]) })
    );

    expect(attributions).toHaveLength(3);
    expect(new Set(attributions.map((a) => a.taskId)).size).toBe(1);
    // Returned, so the caller can log the id next to the reply — an audit
    // record nobody can name is one nobody can find.
    expect(attributions[0]?.taskId).toBe(result.taskId);
    expect(result.taskId).not.toBe("");
  });

  it("gives two tasks two ids", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const { client } = fakeCompletion([response({ text: "hi", stopReason: "end_turn" })]);
      ids.add((await runAgentTask(task({ completion: client }))).taskId);
    }
    expect(ids.size).toBe(3);
  });

  // The id the loop mints has to be one the proxy's schema accepts, and the
  // agent cannot import the schema to check (that dependency lands with the
  // proxy client, #109). So the shape is asserted here instead.
  it("mints an id the schema's bound accepts", async () => {
    const { client } = fakeCompletion([response({ text: "hi", stopReason: "end_turn" })]);
    const result = await runAgentTask(task({ completion: client }));
    expect(result.taskId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });

  it("carries the requesting user through to every call, unchanged", async () => {
    const { client } = fakeCompletion(threeCalls());
    const { executor, attributions } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    await runAgentTask(
      task({
        completion: client,
        requestingUser: "U024BE7LH",
        toolExecutor: executor,
        toolSource: createStubToolSource([DEFINITION])
      })
    );

    expect(attributions.map((a) => a.requestingUser)).toEqual(["U024BE7LH", "U024BE7LH", "U024BE7LH"]);
  });

  // The model must not be able to choose it: an id it picks lets it split one
  // task across many audit records or merge many into one. It is not in the
  // prompt, not in the transcript, and not a tool argument — so the only thing
  // to assert is that nothing the model returned reaches it.
  it("takes the id from nowhere the model can reach", async () => {
    const { client } = fakeCompletion([
      response({ text: "task id: pwned", stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor, attributions } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    await runAgentTask(
      task({
        completion: client,
        toolExecutor: executor,
        toolSource: createStubToolSource([DEFINITION])
      })
    );

    expect(attributions[0]?.taskId).not.toContain("pwned");
  });

  it("uses a supplied id rather than minting one", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor, attributions } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    const result = await runAgentTask(
      task({
        completion: client,
        taskId: "correlated-with-something-outside",
        toolExecutor: executor,
        toolSource: createStubToolSource([DEFINITION])
      })
    );

    expect(result.taskId).toBe("correlated-with-something-outside");
    expect(attributions[0]?.taskId).toBe("correlated-with-something-outside");
  });
});

describe("the agent loop, tool failures", () => {
  it("passes an error result through and keeps going", async () => {
    const { client, requests } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "recovered", stopReason: "end_turn" })
    ]);
    const { executor } = fakeExecutor({ lookup: () => ({ content: "permission denied", isError: true }) });

    const result = await runAgentTask(task({ completion: client, toolExecutor: executor }));

    expect(result.stopReason).toBe("completed");
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "permission denied",
      isError: true
    });
  });

  it("reports a thrown tool error by message only, with no stack", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor } = fakeExecutor({
      lookup: () => {
        throw new Error("upstream 500");
      }
    });

    const result = await runAgentTask(task({ completion: client, toolExecutor: executor }));

    const message = result.messages.find((entry) => entry.role === "tool");
    expect(message).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "tool error: upstream 500",
      isError: true
    });
    expect(result.stopReason).toBe("completed");
  });

  it("does not leak the shape of a non-Error throw", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "done", stopReason: "end_turn" })
    ]);
    const { executor } = fakeExecutor({
      lookup: () => {
        throw { secret: "sk-live-not-a-real-key" };
      }
    });

    const result = await runAgentTask(task({ completion: client, toolExecutor: executor }));

    const message = result.messages.find((entry) => entry.role === "tool");
    expect(message?.content).toBe("tool error: tool execution failed");
    expect(JSON.stringify(result.messages)).not.toContain("sk-live");
  });
});

describe("the agent loop, caps", () => {
  it("stops at the tool call cap and still answers every call", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("a"), toolCall("b")] }),
      response({ stopReason: "tool_use", toolCalls: [toolCall("c")] })
    ]);
    const { executor, calls } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: executor, caps: { ...CAPS, maxToolCalls: 2 } })
    );

    expect(result.stopReason).toBe("tool_call_cap");
    expect(result.toolCalls).toBe(2);
    expect(calls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "c",
      content: "not executed: tool call cap reached",
      isError: true
    });
    expectResumableTranscript(result.messages);
  });

  it("refuses the rest of a batch that straddles the cap", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("a"), toolCall("b")] })
    ]);
    const { executor, calls } = fakeExecutor({ lookup: () => ({ content: "ok" }) });

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: executor, caps: { ...CAPS, maxToolCalls: 1 } })
    );

    expect(result.stopReason).toBe("tool_call_cap");
    expect(calls.map((call) => call.id)).toEqual(["a"]);
    expectResumableTranscript(result.messages);
  });

  it("cancels a request still in flight when wall time runs out", async () => {
    const { client, sawAbort } = hangingCompletion();

    const result = await runAgentTask(
      task({ completion: client, caps: { ...CAPS, maxWallTimeMs: 1 } })
    );

    expect(result.stopReason).toBe("wall_time_cap");
    expect(sawAbort()).toBe(true);
    expect(result.turns).toBe(0);
  });

  it("does not start another turn once wall time has run out", async () => {
    const { client, requests } = fakeCompletion([
      async () => {
        await sleep(20);
        return response({ text: "slow", stopReason: "tool_use", toolCalls: [toolCall("a")] });
      }
    ]);

    const result = await runAgentTask(
      task({
        completion: client,
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
        caps: { ...CAPS, maxWallTimeMs: 5 }
      })
    );

    expect(result.stopReason).toBe("wall_time_cap");
    expect(requests).toHaveLength(1);
  });

  it("stops a tool batch when wall time runs out mid-batch", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("a"), toolCall("b")] })
    ]);
    const { executor, calls } = fakeExecutor({
      lookup: async () => {
        await sleep(20);
        return { content: "ok" };
      }
    });

    const result = await runAgentTask(
      task({ completion: client, toolExecutor: executor, caps: { ...CAPS, maxWallTimeMs: 5 } })
    );

    expect(result.stopReason).toBe("wall_time_cap");
    expect(calls.map((call) => call.id)).toEqual(["a"]);
    expectResumableTranscript(result.messages);
  });

  it("stops at the token cap and clamps the last turn's output ceiling", async () => {
    const { client, requests } = fakeCompletion([
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("a")],
        usage: { inputTokens: 40, outputTokens: 20 }
      }),
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("b")],
        usage: { inputTokens: 40, outputTokens: 20 }
      })
    ]);

    const result = await runAgentTask(
      task({
        completion: client,
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
        caps: { ...CAPS, maxTokens: 100 }
      })
    );

    expect(result.stopReason).toBe("token_cap");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.maxTokens).toBe(100);
    // 60 of 100 spent, so the second turn may only ask for the remaining 40.
    expect(requests[1]?.maxTokens).toBe(40);
    expect(result.totalTokens).toBe(120);
  });

  it("counts cache tokens against the cap", async () => {
    const { client, requests } = fakeCompletion([
      response({
        stopReason: "tool_use",
        toolCalls: [toolCall("a")],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cacheReadInputTokens: 70,
          cacheCreationInputTokens: 15
        }
      })
    ]);

    const result = await runAgentTask(
      task({
        completion: client,
        toolExecutor: fakeExecutor({ lookup: () => ({ content: "ok" }) }).executor,
        caps: { ...CAPS, maxTokens: 100 }
      })
    );

    // 20 tokens of input and output alone would not have tripped a cap of 100.
    expect(result.stopReason).toBe("token_cap");
    expect(result.totalTokens).toBe(105);
    expect(result.usage.cacheReadInputTokens).toBe(70);
    expect(requests).toHaveLength(1);
  });
});

describe("the agent loop, non-cap terminations", () => {
  each([
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
    ["other", "stopped_other"]
  ] as const)("maps a %s stop reason to %s", async (stopReason, expected) => {
    const { client, requests } = fakeCompletion([response({ text: "…", stopReason })]);

    const result = await runAgentTask(task({ completion: client }));

    expect(result.stopReason).toBe(expected);
    expect(requests).toHaveLength(1);
  });

  it("does not spin on a tool-use turn with no tool calls", async () => {
    const { client, requests } = fakeCompletion([response({ stopReason: "tool_use", toolCalls: [] })]);

    const result = await runAgentTask(task({ completion: client }));

    expect(result.stopReason).toBe("stopped_other");
    expect(requests).toHaveLength(1);
  });

  it("stops before the first turn when the caller has already cancelled", async () => {
    const { client, requests } = fakeCompletion([]);

    const result = await runAgentTask(
      task({ completion: client, signal: AbortSignal.abort() })
    );

    expect(result.stopReason).toBe("cancelled");
    expect(requests).toHaveLength(0);
    expect(result.turns).toBe(0);
  });

  it("reports a mid-flight caller cancel as cancelled, not as a wall-time cap", async () => {
    const controller = new AbortController();
    const { client, sawAbort } = hangingCompletion();
    setTimeout(() => controller.abort(), 5);

    const result = await runAgentTask(task({ completion: client, signal: controller.signal }));

    expect(result.stopReason).toBe("cancelled");
    expect(sawAbort()).toBe(true);
  });
});

describe("the agent loop, propagated failures", () => {
  it("does not retry a provider failure", async () => {
    const failure = new CompletionError("completion request failed", "fake");
    const { client, requests } = fakeCompletion([
      () => Promise.reject(failure),
      response({ text: "unreachable", stopReason: "end_turn" })
    ]);

    await expect(runAgentTask(task({ completion: client }))).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
  });

  it("does not run a task whose tool list could not be fetched", async () => {
    const { client, requests } = fakeCompletion([response({ text: "unreachable" })]);
    const toolSource: ToolSource = { list: () => Promise.reject(new Error("proxy unreachable")) };

    await expect(runAgentTask(task({ completion: client, toolSource }))).rejects.toThrow(
      "proxy unreachable"
    );
    expect(requests).toHaveLength(0);
  });
});

describe("the tool stubs", () => {
  it("lists nothing by default, so no tools reach the request", async () => {
    const { client, requests } = fakeCompletion([response({ text: "hi" })]);

    await runAgentTask(task({ completion: client, toolSource: createStubToolSource() }));

    expect(await createStubToolSource().list()).toEqual([]);
    expect(requests[0]).not.toHaveProperty("tools");
  });

  it("refuses rather than throws when no executor is wired up", async () => {
    const { client } = fakeCompletion([
      response({ stopReason: "tool_use", toolCalls: [toolCall("call-1")] }),
      response({ text: "understood", stopReason: "end_turn" })
    ]);

    const result = await runAgentTask(
      task({
        completion: client,
        toolSource: createStubToolSource([DEFINITION]),
        toolExecutor: createUnavailableToolExecutor()
      })
    );

    expect(result.stopReason).toBe("completed");
    expect(result.messages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "tool execution is not configured",
      isError: true
    });
  });
});

describe("the default caps", () => {
  it("bounds every dimension", () => {
    for (const value of Object.values(DEFAULT_AGENT_LOOP_CAPS)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

/** Every tool call in the transcript has a matching result, so the transcript
 *  can seed a later turn. A batch cut short by a cap is where this breaks. */
function expectResumableTranscript(messages: AgentTaskOptions["messages"]): void {
  const answered = new Set(
    messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)
  );
  const asked = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.toolCalls ?? [])
    .map((call) => call.id);

  expect(asked.length).toBeGreaterThan(0);
  for (const id of asked) expect(answered).toContain(id);
}
