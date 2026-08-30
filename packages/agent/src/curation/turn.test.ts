// Faked at the CompletionClient seam, the way loop.test.ts is and for the same
// reason: what is under test is which tools the turn offers, what it does with
// what the model asks for, and what it reports — none of which is a provider's
// wire format.

import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { textBlock } from "@getlibero/schema";
import { MEMORY_OP_MAX_TEXT_CHARS, MemoryToolName } from "@getlibero/schema";
import type { MemoryOp, MemoryOpResult } from "@getlibero/schema";
import { CompletionError } from "../completion/types.js";
import type {
  CompletionClient,
  CompletionMessage,
  CompletionRequest,
  CompletionResponse,
  ToolCall
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";
import {
  CURATION_SYSTEM_PROMPT,
  curationTranscript,
  memoryToolDefinitions,
  runCurationTurn
} from "./turn.js";
import type { CurationTurnOptions } from "./turn.js";

const MODEL = "test-model";

function response(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial
  };
}

/** One response, and the request that asked for it. */
function fakeCompletion(next: CompletionResponse | (() => Promise<CompletionResponse>)): {
  client: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      complete(request) {
        requests.push(request);
        return typeof next === "function" ? next() : Promise.resolve(next);
      }
    }
  };
}

function call(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
  return { id, name, arguments: args };
}

/** Records what it was asked to do and answers written. */
function recordingHandler(): { applyOp: (op: MemoryOp) => MemoryOpResult; seen: MemoryOp[] } {
  const seen: MemoryOp[] = [];
  return {
    seen,
    applyOp(op) {
      seen.push(op);
      return { outcome: "written", chars: 10, limit: 32_768 };
    }
  };
}

function options(partial: Partial<CurationTurnOptions> = {}): CurationTurnOptions {
  const { client } = fakeCompletion(response());
  return {
    completion: client,
    model: MODEL,
    messages: [{ role: "user", content: "when do we deploy?" }],
    memory: "",
    maxFileChars: 32_768,
    applyOp: () => ({ outcome: "written", chars: 1, limit: 32_768 }),
    maxTokens: 1024,
    turn: 4,
    ...partial
  };
}

describe("what the turn offers the model", () => {
  it("offers both memory tools and nothing else", async () => {
    const { client, requests } = fakeCompletion(response());

    await runCurationTurn(options({ completion: client }));

    expect(requests[0]?.tools?.map(tool => tool.name).sort()).toEqual([
      "memory_append",
      "memory_replace"
    ]);
  });

  // The definitions are the schema's, not restated here, so a description edited
  // in one place is the one a model reads.
  it("publishes the schema's own descriptions and input schemas", () => {
    const definitions = memoryToolDefinitions();

    for (const name of MemoryToolName.options) {
      const definition = definitions.find(candidate => candidate.name === name);
      expect(definition?.description.length).toBeGreaterThan(0);
      expect(definition?.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("sends the instructions as the system prompt", async () => {
    const { client, requests } = fakeCompletion(response());

    await runCurationTurn(options({ completion: client }));

    expect(requests[0]?.system).toBe(CURATION_SYSTEM_PROMPT);
  });

  it("bounds the turn by the ceiling it was given", async () => {
    const { client, requests } = fakeCompletion(response());

    await runCurationTurn(options({ completion: client, maxTokens: 512 }));

    expect(requests[0]?.maxTokens).toBe(512);
  });

  it("puts the file and its remaining room in front of the model", async () => {
    const { client, requests } = fakeCompletion(response());

    await runCurationTurn(
      options({ completion: client, memory: "- Deploys go out Thursdays.\n", maxFileChars: 4_096 })
    );

    const last = requests[0]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("- Deploys go out Thursdays.");
    expect(last?.content).toContain("28 characters");
    expect(last?.content).toContain("4096");
  });

  it("says so when there is no file yet", async () => {
    const { client, requests } = fakeCompletion(response());

    await runCurationTurn(options({ completion: client, memory: "" }));

    expect(requests[0]?.messages.at(-1)?.content).toContain("no MEMORY.md yet");
  });
});

describe("the transcript the model sees", () => {
  const transcript: CompletionMessage[] = [
    { role: "user", content: "when do we deploy?" },
    { role: "assistant", content: "Let me look.", toolCalls: [call("search", {})] },
    { role: "tool", toolCallId: "call-1", content: [textBlock("a page of search results")] },
    { role: "assistant", content: "", toolCalls: [call("search", {}, "call-2")] },
    { role: "tool", toolCallId: "call-2", content: [textBlock("more results")] },
    { role: "assistant", content: "Thursdays, after standup.", providerState: { opaque: true } }
  ];

  it("drops tool results", () => {
    expect(curationTranscript(transcript).some(message => message.role === "tool")).toBe(false);
  });

  // Dropping results forces dropping the calls: a tool-use block with no
  // matching result is not a conversation a provider will accept.
  it("drops the tool calls that produced them", () => {
    for (const message of curationTranscript(transcript)) {
      expect(message).not.toHaveProperty("toolCalls");
    }
  });

  // An assistant turn that was only tool calls becomes an empty message, which
  // providers reject too.
  it("drops an assistant turn that said nothing but called tools", () => {
    expect(curationTranscript(transcript)).toEqual([
      { role: "user", content: "when do we deploy?" },
      { role: "assistant", content: "Let me look." },
      { role: "assistant", content: "Thursdays, after standup." }
    ]);
  });

  it("carries no provider replay state into a different conversation", () => {
    for (const message of curationTranscript(transcript)) {
      expect(message).not.toHaveProperty("providerState");
    }
  });

  it("does not mutate what it was given", () => {
    const messages = [...transcript];
    const before = JSON.stringify(messages);

    curationTranscript(messages);

    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe("a model that emits valid operations", () => {
  it("executes an append and reports what it did", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({ toolCalls: [call("memory_append", { text: "Deploys go out Thursdays." })] })
    );

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([{ op: "memory_append", text: "Deploys go out Thursdays." }]);
    expect(result.ops).toEqual([
      {
        tool: "memory_append",
        result: { outcome: "written", chars: 10, limit: 32_768 },
        message: expect.stringContaining("Written")
      }
    ]);
  });

  it("executes several operations in the order the model asked", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [
          call("memory_append", { text: "first" }, "a"),
          call("memory_replace", { find: "first", replace: "second" }, "b")
        ]
      })
    );

    await runCurationTurn(options({ completion: client, applyOp: handler.applyOp }));

    expect(handler.seen).toEqual([
      { op: "memory_append", text: "first" },
      { op: "memory_replace", find: "first", replace: "second" }
    ]);
  });

  it("carries the store's own answer through, refusals included", async () => {
    const refusal: MemoryOpResult = {
      outcome: "failed",
      reason: "find_ambiguous",
      matches: 3
    };
    const { client } = fakeCompletion(
      response({ toolCalls: [call("memory_replace", { find: "- ", replace: "* " })] })
    );

    const result = await runCurationTurn(options({ completion: client, applyOp: () => refusal }));

    expect(result.ops[0]?.result).toEqual(refusal);
    expect(result.ops[0]?.message).toContain("3 times");
  });
});

describe("a model that emits nothing", () => {
  // The prompt says doing nothing is the right outcome for most tasks, so this
  // is the ordinary path rather than an edge case.
  it("calls no handler and reports no operations", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(response({ text: "Nothing worth recording." }));

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([]);
    expect(result.ops).toEqual([]);
  });
});

describe("a model that emits garbage", () => {
  // The acceptance criterion, at the layer that makes it structural. There is no
  // executor here a proxied tool could reach, and the name never gets past
  // `parseMemoryOp`.
  it("cannot invoke a proxied tool", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [
          call("search_channel_history", { query: "vault" }, "a"),
          call("merge_pull_request", { number: 1 }, "b")
        ]
      })
    );

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([]);
    expect(result.ops.map(op => op.result)).toEqual([
      { outcome: "failed", reason: "unknown_tool" },
      { outcome: "failed", reason: "unknown_tool" }
    ]);
  });

  each([
    ["a missing field", "memory_append", {}],
    ["a wrong type", "memory_append", { text: 42 }],
    ["an unknown key", "memory_append", { text: "x", path: "../other/MEMORY.md" }],
    ["an empty replacement target", "memory_replace", { find: "", replace: "x" }]
  ])("refuses %s without reaching the store", async (_name, tool, args) => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(response({ toolCalls: [call(tool, args)] }));

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([]);
    expect(result.ops[0]?.result).toMatchObject({ outcome: "failed" });
  });

  it("keeps executing the operations that were well formed", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [
          call("nonsense", {}, "a"),
          call("memory_append", { text: "still recorded" }, "b")
        ]
      })
    );

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([{ op: "memory_append", text: "still recorded" }]);
    expect(result.ops.map(op => op.result.outcome)).toEqual(["failed", "written"]);
  });
});

describe("a model that emits oversize operations", () => {
  // Bounded before anything is asked to write it. The store bounds it too, and
  // the two owners are named in @getlibero/schema — this is the one that keeps
  // the handler from ever seeing it.
  it("refuses text past the per-operation ceiling without reaching the store", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [call("memory_append", { text: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS + 1) })]
      })
    );

    const result = await runCurationTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([]);
    expect(result.ops[0]?.result).toEqual({ outcome: "failed", reason: "text_too_long" });
  });

  it("relays a cap refusal the store made", async () => {
    const { client } = fakeCompletion(
      response({ toolCalls: [call("memory_append", { text: "one more fact" })] })
    );

    const result = await runCurationTurn(
      options({
        completion: client,
        applyOp: () => ({
          outcome: "failed" as const,
          reason: "file_cap_exceeded" as const,
          chars: 40_000,
          limit: 32_768
        })
      })
    );

    expect(result.ops[0]?.message).toContain("32768");
  });
});

describe("what the turn reports", () => {
  it("reports its spend once, with the turn number it was given", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(
      response({
        usage: { inputTokens: 900, outputTokens: 40 },
        model: "claude-sonnet-4-6"
      })
    );

    const result = await runCurationTurn(
      options({ completion: client, turn: 7, onTurn: turn => void turns.push(turn) })
    );

    expect(turns).toEqual([
      { usage: { inputTokens: 900, outputTokens: 40 }, turn: 7, model: "claude-sonnet-4-6" }
    ]);
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  // Absent is an answer — the same rule the spend report keeps. A provider that
  // echoed no model must not be reported as the one that was asked for.
  it("omits the model when the provider echoed none", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(response());

    const result = await runCurationTurn(
      options({ completion: client, onTurn: turn => void turns.push(turn) })
    );

    expect("model" in (turns[0] ?? {})).toBe(false);
    expect("model" in result).toBe(false);
  });

  // A turn that was paid for is counted even if what it asked for then fails.
  // The loop reports in this order for the same reason.
  it("reports the spend before running any operation", async () => {
    const order: string[] = [];
    const { client } = fakeCompletion(
      response({ toolCalls: [call("memory_append", { text: "x" })] })
    );

    await runCurationTurn(
      options({
        completion: client,
        onTurn: () => void order.push("reported"),
        applyOp: () => {
          order.push("applied");
          return { outcome: "written", chars: 1, limit: 32_768 };
        }
      })
    );

    expect(order).toEqual(["reported", "applied"]);
  });

  it("still reports the spend when an operation throws", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(
      response({ toolCalls: [call("memory_append", { text: "x" })] })
    );

    await expect(
      runCurationTurn(
        options({
          completion: client,
          onTurn: turn => void turns.push(turn),
          applyOp: () => {
            throw new Error("memory store: ENOSPC");
          }
        })
      )
    ).rejects.toThrow(/ENOSPC/);

    expect(turns).toHaveLength(1);
  });

  // Rejects the way runAgentTask does. This file has no logger, and swallowing
  // here would make a broken provider look like a channel that never remembers.
  it("rejects when the provider fails", async () => {
    const { client } = fakeCompletion(() =>
      Promise.reject(new CompletionError("upstream is down", "anthropic"))
    );

    await expect(runCurationTurn(options({ completion: client }))).rejects.toThrow(
      /upstream is down/
    );
  });
});
