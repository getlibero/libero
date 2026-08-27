import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expect } from "expect";
import { CompletionError, type CompletionClient, type CompletionRequest } from "./types.js";

/**
 * The contract every completion adapter must satisfy. One set of assertions is
 * run against each provider, which is what "the same loop code completes
 * against both providers" means in practice: if an adapter passes this suite,
 * the loop cannot tell which provider it is holding.
 *
 * A new adapter (Azure, Bedrock, Gemini's native API) ships with a harness here
 * and no changes to the assertions.
 */
export type CompletionScenario = "text" | "tool-call" | "parallel-tool-calls" | "max-tokens";

export interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

export interface CompletionHarness {
  name: string;
  /** Wire-format response for a scenario, as the provider would return it. */
  fixture(scenario: CompletionScenario): URL;
  createClient(fetchImpl: typeof globalThis.fetch): CompletionClient;
}

/**
 * A fetch that answers with a recorded response and keeps what it was asked.
 * No adapter under test reaches the network, so no test needs a credential.
 */
export function stubTransport(fixture: URL): {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
} {
  const payload = readFileSync(fixture, "utf8");
  const calls: RecordedRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    // Honouring the signal here is what proves the adapter threads it through
    // to the transport, which is what makes the loop's wall-time cap real.
    if (init?.signal?.aborted === true) {
      throw new DOMException("request aborted", "AbortError");
    }
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    });
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  return { fetch: fetchImpl, calls };
}

/** A conversation that exercises every message role the loop produces. */
const CONVERSATION: CompletionRequest = {
  model: "test-model",
  maxTokens: 1024,
  system: "You are the engineering channel assistant.",
  tools: [
    {
      name: "list_prs",
      description: "List open pull requests.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" } },
        required: ["repo"]
      }
    }
  ],
  messages: [
    { role: "user", content: "Which pull requests are open?" },
    {
      role: "assistant",
      content: "Checking.",
      toolCalls: [{ id: "call_1", name: "list_prs", arguments: { repo: "getlibero/libero" } }]
    },
    { role: "tool", toolCallId: "call_1", content: "PR 41 is open." }
  ]
};

export function runCompletionConformance(harness: CompletionHarness): void {
  const run = async (scenario: CompletionScenario, request?: Partial<CompletionRequest>) => {
    const transport = stubTransport(harness.fixture(scenario));
    const client = harness.createClient(transport.fetch);
    const response = await client.complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      ...request
    });
    return { response, calls: transport.calls };
  };

  describe(`${harness.name} completion conformance`, () => {
    it("returns text, no tool calls, and per-call token usage", async () => {
      const { response } = await run("text");

      expect(response.text).toBe("Paris is the capital of France.");
      expect(response.toolCalls).toEqual([]);
      expect(response.stopReason).toBe("end_turn");
    });

    /**
     * The four counts, and the reason this is the strictest case in the suite.
     *
     * **Every `text` fixture describes the same call** — 120 fresh input tokens,
     * 100 read from cache, 20 written to it, 8 out — in whatever dialect its
     * provider speaks. So this asserts one object rather than three fields, and
     * `toEqual` rather than field-by-field, because the failure being guarded
     * against is a count going missing, and a suite that only checks the fields
     * it names cannot see that.
     *
     * **The tiers are disjoint**, which is a claim about the numbers and not
     * only about the field names: 120 is fresh input, not 240 with 100 of it
     * also billed as a cache read. `costMicroUsd` prices the four by adding four
     * independent terms, so an adapter that reported an inclusive input count
     * would charge every cached token twice and still pass a per-field check.
     * OpenAI's `prompt_tokens` *is* inclusive; `toUsage` there converts, and this
     * is the case that says it must.
     *
     * Until #480 this asserted three of the four against fixtures describing two
     * different calls — the openai one had 20 fresh input where the anthropic one
     * had 120 — so the two adapters agreeing here meant nothing and the
     * openai-compatible path was double-charging cache reads into a channel's
     * `daily_usd`. A test that encodes a gap, in this repository's phrase.
     */
    it("reports the four token tiers disjointly, in every provider's dialect", async () => {
      const { response } = await run("text");

      expect(response.usage).toEqual({
        inputTokens: 120,
        outputTokens: 8,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 20
      });
    });

    // #62: the tool proxy service prices a channel's spend by the model that
    // actually served a turn, and only this end can see it.
    //
    // **Asked for one id, served another**, which is the whole case. A router —
    // the LiteLLM sidecar in the compose file — resolves an alias, so the
    // requested id is not the priced one, and an adapter that quietly answered
    // with `request.model` would price a channel's opus turns at its alias's
    // rate and look right doing it. The fixtures echo `test-model`; this asks
    // for something else so the two cannot be confused.
    it("carries the model the provider served, not the one that was asked for", async () => {
      const { response } = await run("text", { model: "router-alias" });

      expect(response.model).toBe("test-model");
    });

    it("returns a tool call with parsed arguments alongside text", async () => {
      const { response } = await run("tool-call");

      expect(response.text).toBe("Checking the open pull requests.");
      expect(response.stopReason).toBe("tool_use");
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]?.name).toBe("list_prs");
      // Parsed, never the raw JSON string the wire may carry.
      expect(response.toolCalls[0]?.arguments).toEqual({ repo: "getlibero/libero" });
      expect(response.toolCalls[0]?.id).toBeTruthy();
      expect(response.usage).toEqual({ inputTokens: 200, outputTokens: 30 });
    });

    it("returns every call when the model calls tools in parallel", async () => {
      const { response } = await run("parallel-tool-calls");

      expect(response.text).toBe("");
      expect(response.stopReason).toBe("tool_use");
      expect(response.toolCalls.map((call) => call.name)).toEqual([
        "list_prs",
        "trigger_workflow"
      ]);
      expect(response.toolCalls[1]?.arguments).toEqual({ workflow: "ci.yml" });
      // Ids must be distinct, or tool results cannot be matched to their calls.
      expect(response.toolCalls[0]?.id).not.toBe(response.toolCalls[1]?.id);
    });

    it("reports a truncated response as max_tokens rather than end_turn", async () => {
      const { response } = await run("max-tokens");

      expect(response.stopReason).toBe("max_tokens");
      expect(response.text).toBe("The deployment runbook begins with");
      expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 16 });
    });

    it("sends the system prompt, conversation, and tool definitions", async () => {
      const { calls } = await run("text", CONVERSATION);

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.body["model"]).toBe("test-model");

      // Providers disagree on where each part goes, so assert only that nothing
      // was dropped on the way out; shape is a per-provider concern.
      const sent = JSON.stringify(call?.body);
      expect(sent).toContain("You are the engineering channel assistant.");
      expect(sent).toContain("Which pull requests are open?");
      expect(sent).toContain("PR 41 is open.");
      expect(sent).toContain("list_prs");
    });

    it("rejects when the caller's signal is already aborted", async () => {
      await expect(run("text", { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        CompletionError
      );
    });
  });
}
