// The loop is faked at the CompletionClient seam, not at the transport.
//
// completion/conformance.ts drives a real adapter through fetch-level fixtures
// to prove it maps a provider's wire format correctly. Reusing it here would
// tie every loop test to Anthropic or OpenAI JSON and need a fixture file per
// case — which is exactly the coupling the completion layer exists to remove.
// Keep the two apart.

import { describe, expect, it } from "vitest";
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
import type { AgentLoopCaps, AgentTaskOptions, ToolExecutor, ToolResult, ToolSource } from "./types.js";

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
): { executor: ToolExecutor; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    executor: {
      async execute(call: ToolCall): Promise<ToolResult> {
        calls.push(call);
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
  it.each([
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
