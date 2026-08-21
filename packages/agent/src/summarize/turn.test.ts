import { describe, it } from "node:test";
import { expect } from "expect";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  ToolCall
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";
import { SUMMARIZATION_SYSTEM_PROMPT, runSummarizationTurn } from "./turn.js";
import type { SummarizationMessage } from "./turn.js";

const THREAD: SummarizationMessage[] = [
  { author: "alice", text: "how do we rotate a channel's client cert?" },
  { author: "bob", text: "dev-certs.sh --rotate, edit the sheet, then --promote" },
  { author: "alice", text: "and both pins stay live across the overlap?" },
  { author: "bob", text: "yes, that's the point of the two-step" }
];

/**
 * A completion client answering with one recorded response, keeping what it was
 * asked. The loop is faked at this seam everywhere in this package, for the
 * reason `conformance.ts` states: tying a turn's tests to one provider's JSON is
 * the coupling the completion layer exists to remove.
 */
function fakeCompletion(toolCalls: ToolCall[], text = ""): {
  completion: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    completion: {
      complete: (request: CompletionRequest): Promise<CompletionResponse> => {
        requests.push(request);
        return Promise.resolve({
          text,
          toolCalls,
          stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
          usage: { inputTokens: 900, outputTokens: 40 },
          model: "served-model"
        });
      }
    }
  };
}

const recorded = (args: Record<string, unknown>): ToolCall[] => [
  { id: "call_1", name: "record_thread_summary", arguments: args }
];

function run(
  toolCalls: ToolCall[],
  messages: readonly SummarizationMessage[] = THREAD
): Promise<{ result: Awaited<ReturnType<typeof runSummarizationTurn>>; turns: CompletedTurn[] }> {
  const turns: CompletedTurn[] = [];
  const { completion } = fakeCompletion(toolCalls);
  return runSummarizationTurn({
    completion,
    model: "test-model",
    messages,
    maxTokens: 1024,
    turn: 1,
    onTurn: turn => {
      turns.push(turn);
    }
  }).then(result => ({ result, turns }));
}

describe("runSummarizationTurn", () => {
  it("returns the recorded summary and its shape", async () => {
    const { result } = await run(
      recorded({
        shape: "question_answered",
        text: "Q: how do you rotate a channel's client certificate? A: dev-certs.sh --rotate, edit the sheet, --promote."
      })
    );

    expect(result.summary.shape).toBe("question_answered");
    expect(result.summary.text).toContain("--promote");
    expect(result.malformed).toBeUndefined();
  });

  // The shape vocabulary is the whole design: a Q&A thread must not have to be
  // called a decision, because nobody decided how a tool already works.
  it("carries every shape the schema admits", async () => {
    for (const shape of ["question_answered", "decision", "incident", "open_question"] as const) {
      const { result } = await run(recorded({ shape, text: "something durable" }));
      expect(result.summary.shape).toBe(shape);
    }
  });

  // The load-bearing member. A pass that must always produce a summary
  // manufactures one for "deploying now", and that vector then dilutes every
  // deployment question's neighbourhood.
  it("carries `nothing` as a first-class answer, not a failure", async () => {
    const { result } = await run(recorded({ shape: "nothing", text: "" }));

    expect(result.summary).toEqual({ shape: "nothing", text: "" });
    expect(result.malformed).toBeUndefined();
  });

  it("reports what the turn cost before anything is read", async () => {
    const { result, turns } = await run(recorded({ shape: "nothing", text: "" }));

    expect(turns).toEqual([{ usage: { inputTokens: 900, outputTokens: 40 }, turn: 1, model: "served-model" }]);
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    expect(result.model).toBe("served-model");
  });

  // A turn that was paid for is counted even when what it produced is unusable.
  // The loop's ordering, and curation's.
  it("reports spend even when the model records nothing usable", async () => {
    const { turns } = await run([]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.usage.inputTokens).toBe(900);
  });

  it("falls back to `nothing` and says so when the model records no summary", async () => {
    const { result } = await run([]);

    expect(result.summary.shape).toBe("nothing");
    expect(result.malformed).toMatch(/recorded no summary/);
  });

  it("falls back to `nothing` when the recorded summary does not fit the schema", async () => {
    const { result } = await run(recorded({ shape: "gossip", text: "who said what" }));

    expect(result.summary.shape).toBe("nothing");
    expect(result.malformed).toMatch(/did not fit the schema/);
  });

  // `ThreadSummary` refuses a shape with no content, because an empty summary
  // would be embedded as a vector standing for nothing and retrieved against
  // everything.
  it("refuses a shape with no text", async () => {
    const { result } = await run(recorded({ shape: "decision", text: "   " }));

    expect(result.summary.shape).toBe("nothing");
    expect(result.malformed).toMatch(/must say what it was/);
  });

  // A `malformed` line reaches an operator's log, and the thing that failed to
  // parse is a channel's conversation restated by a model.
  it("keeps the thread's words out of the malformed reason", async () => {
    const { result } = await run(
      recorded({ shape: "decision", text: "" , secret: "dev-certs.sh --rotate" })
    );

    expect(result.malformed).toBeDefined();
    expect(result.malformed).not.toContain("dev-certs");
  });

  it("sends the thread oldest first, speaker-prefixed", async () => {
    const turns: CompletedTurn[] = [];
    const { completion, requests } = fakeCompletion(recorded({ shape: "nothing", text: "" }));
    await runSummarizationTurn({
      completion,
      model: "test-model",
      messages: THREAD,
      maxTokens: 1024,
      turn: 1,
      onTurn: turn => {
        turns.push(turn);
      }
    });

    const sent = String(requests[0]?.messages[0]?.content ?? "");
    expect(sent.indexOf("alice: how do we rotate")).toBeLessThan(sent.indexOf("bob: dev-certs.sh"));
    expect(requests[0]?.system).toBe(SUMMARIZATION_SYSTEM_PROMPT);
  });

  // One tool, and it writes nothing. This turn cannot reach a proxied tool
  // because there is no executor here that could.
  it("offers exactly one tool", async () => {
    const { completion, requests } = fakeCompletion(recorded({ shape: "nothing", text: "" }));
    await runSummarizationTurn({
      completion,
      model: "test-model",
      messages: THREAD,
      maxTokens: 1024,
      turn: 1,
      onTurn: () => {}
    });

    expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(["record_thread_summary"]);
  });

  // A thread whose every message was deleted between the sweep and the read is a
  // real race, and finding out should not cost a model call.
  it("answers without calling the provider when the thread is empty", async () => {
    const { completion, requests } = fakeCompletion(recorded({ shape: "nothing", text: "" }));
    const result = await runSummarizationTurn({
      completion,
      model: "test-model",
      messages: [],
      maxTokens: 1024,
      turn: 1,
      onTurn: () => {
        throw new Error("nothing was spent, so nothing should be reported");
      }
    });

    expect(requests).toHaveLength(0);
    expect(result.summary.shape).toBe("nothing");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  // The provider failing is not the same as the model answering badly: it
  // propagates, and the caller writes no row so the thread is swept again.
  it("rejects when the provider does", async () => {
    await expect(
      runSummarizationTurn({
        completion: { complete: () => Promise.reject(new Error("upstream down")) },
        model: "test-model",
        messages: THREAD,
        maxTokens: 1024,
        turn: 1,
        onTurn: () => {}
      })
    ).rejects.toThrow(/upstream down/);
  });
});

describe("the summarization prompt", () => {
  // Each of these is a failure mode the corpus actually has, so each is asserted
  // rather than left to survive a rewrite by accident.
  it("says that most threads produce nothing", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/most threads produce nothing/i);
  });

  it("forbids inventing a decision the thread did not reach", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/never write that something was decided/i);
  });

  it("asks for the question to be written out in searchable words", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/words someone would search for/i);
  });

  it("asks for specifics rather than a description of the discussion", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/name the specifics/i);
  });
});
