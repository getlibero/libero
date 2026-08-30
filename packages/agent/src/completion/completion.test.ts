import { describe, it } from "node:test";
import { expect } from "expect";
import { each } from "@getlibero/test-kit";
import { textBlock } from "@getlibero/schema";
import type { ToolResultBlock } from "@getlibero/schema";
import { createAnthropicCompletionClient } from "./anthropic.js";
import { runCompletionConformance, stubTransport } from "./conformance.js";
import { createCompletionClient } from "./factory.js";
import {
  createOpenAICompatibleCompletionClient,
  OPENAI_COMPATIBLE_BASE_URLS
} from "./openai.js";
import { CompletionError } from "./types.js";

// The SDKs require a non-empty key to construct. Nothing reaches the network:
// every client below is built on a stub transport.
const PLACEHOLDER_KEY = "placeholder-not-a-credential";

const fixtureFor = (provider: string) => (name: string) =>
  new URL(`../../fixtures/completion/${provider}/${name}.json`, import.meta.url);

const anthropicFixture = fixtureFor("anthropic");
const openaiFixture = fixtureFor("openai");

// The acceptance criterion: one suite, both providers.
runCompletionConformance({
  name: "anthropic",
  fixture: anthropicFixture,
  createClient: (fetchImpl) =>
    createAnthropicCompletionClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchImpl }),
  // A `tool_result` here takes text and image blocks and has no member for
  // audio or a binary resource.
  nativeToolResultBlocks: ["text", "image"]
});

runCompletionConformance({
  name: "openai-compatible",
  fixture: openaiFixture,
  createClient: (fetchImpl) =>
    createOpenAICompatibleCompletionClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchImpl }),
  // A `role: "tool"` message in chat completions is text and nothing else.
  nativeToolResultBlocks: ["text"]
});

interface AnthropicBody {
  messages: { role: string; content: { type?: string; content?: unknown }[] }[];
}

const IMAGE = "aW1hZ2UtcGF5bG9hZA==";

/** One tool result through the Anthropic adapter, and the blocks it sent. */
async function anthropicToolResult(content: ToolResultBlock[]): Promise<unknown> {
  const transport = stubTransport(anthropicFixture("text"));
  await createAnthropicCompletionClient({ apiKey: PLACEHOLDER_KEY, fetch: transport.fetch }).complete({
    model: "test-model",
    maxTokens: 1024,
    messages: [
      { role: "user", content: "Show me the failing check." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_1", name: "screenshot", arguments: {} }]
      },
      { role: "tool", toolCallId: "toolu_1", content }
    ]
  });
  const body = transport.calls[0]?.body as unknown as AnthropicBody;
  return body.messages[2]?.content[0]?.content;
}

describe("anthropic message mapping", () => {
  it("replays reasoning blocks unchanged at the head of the assistant turn", async () => {
    const first = stubTransport(anthropicFixture("reasoning"));
    const response = await createAnthropicCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: first.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "Which pull requests are open?" }]
    });

    expect(response.providerState).toEqual([
      {
        type: "thinking",
        thinking: "The channel asked which pull requests are open.",
        signature: "sig_test"
      }
    ]);

    // Feeding that turn back is what the loop does on the next iteration. The
    // signature is checked server-side, so the block must survive byte-identical.
    const second = stubTransport(anthropicFixture("text"));
    await createAnthropicCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: second.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [
        { role: "user", content: "Which pull requests are open?" },
        {
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
          ...(response.providerState !== undefined
            ? { providerState: response.providerState }
            : {})
        },
        {
          role: "tool",
          toolCallId: response.toolCalls[0]?.id ?? "",
          content: [textBlock("PR 41 is open.")]
        }
      ]
    });

    const body = second.calls[0]?.body as unknown as AnthropicBody;
    expect(body.messages[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "The channel asked which pull requests are open.",
      signature: "sig_test"
    });
  });

  it("sends an image tool result as an image block and an audio one as its placeholder", async () => {
    const sent = await anthropicToolResult([
      textBlock("Here it is."),
      { type: "image", data: IMAGE, mimeType: "image/png" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" }
    ]);

    expect(sent).toEqual([
      { type: "text", text: "Here it is." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE } },
      // The wording is the schema's, and this is the one place in the tree that
      // pins what a provider without an audio member actually sends.
      { type: "text", text: "[audio omitted: audio/wav, 5 bytes]" }
    ]);
  });

  it("degrades an image whose media type this API does not take", async () => {
    const sent = await anthropicToolResult([{ type: "image", data: IMAGE, mimeType: "image/svg+xml" }]);

    // Not the payload in a text block either: the API rejects the block, and a
    // rejected request loses the whole turn where a placeholder loses one image.
    expect(sent).toEqual([{ type: "text", text: "[image omitted: image/svg+xml, 13 bytes]" }]);
  });

  it("sends a result with no blocks as the empty string it always was", async () => {
    expect(await anthropicToolResult([])).toBe("");
  });

  it("merges parallel tool results into a single user turn", async () => {
    const transport = stubTransport(anthropicFixture("text"));
    await createAnthropicCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [
        { role: "user", content: "Check the repo." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_1", name: "list_prs", arguments: { repo: "getlibero/libero" } },
            { id: "toolu_2", name: "trigger_workflow", arguments: { workflow: "ci.yml" } }
          ]
        },
        { role: "tool", toolCallId: "toolu_1", content: [textBlock("PR 41 is open.")] },
        { role: "tool", toolCallId: "toolu_2", content: [textBlock("not permitted")], isError: true }
      ]
    });

    // The API rejects results for one batch of calls split across turns.
    const body = transport.calls[0]?.body as unknown as AnthropicBody;
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]?.role).toBe("user");
    expect(body.messages[2]?.content).toHaveLength(2);
  });

  it("reports cache writes separately from ordinary input tokens", async () => {
    const transport = stubTransport(anthropicFixture("text"));
    const response = await createAnthropicCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    expect(response.usage.cacheCreationInputTokens).toBe(20);
  });
});

describe("openai-compatible message mapping", () => {
  it("renders a result's blocks as one string and never as base64", async () => {
    const transport = stubTransport(openaiFixture("text"));
    await createOpenAICompatibleCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [
        { role: "user", content: "Show me the failing check." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }]
        },
        {
          role: "tool",
          toolCallId: "call_1",
          content: [textBlock("Here it is."), { type: "image", data: IMAGE, mimeType: "image/png" }]
        }
      ]
    });

    const messages = (transport.calls[0]?.body as { messages: { content?: unknown }[] }).messages;
    expect(messages[2]?.content).toBe("Here it is.\n[image omitted: image/png, 13 bytes]");
    expect(JSON.stringify(transport.calls[0]?.body)).not.toContain(IMAGE);
  });
});

describe("openai-compatible failures", () => {
  it("fails loudly when tool call arguments are not parseable", async () => {
    const transport = stubTransport(openaiFixture("malformed-tool-arguments"));
    const complete = createOpenAICompatibleCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    await expect(complete).rejects.toBeInstanceOf(CompletionError);
  });

  it("fails when the server reports no token usage", async () => {
    // Metering a call as zero would silently under-count the channel's budget.
    const transport = stubTransport(openaiFixture("no-usage"));
    const complete = createOpenAICompatibleCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    await expect(complete).rejects.toBeInstanceOf(CompletionError);
  });

  it("sends requests to the configured endpoint", async () => {
    const transport = stubTransport(openaiFixture("text"));
    await createOpenAICompatibleCompletionClient({
      apiKey: PLACEHOLDER_KEY,
      baseUrl: OPENAI_COMPATIBLE_BASE_URLS.groq,
      fetch: transport.fetch
    }).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    expect(transport.calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});

/**
 * `prompt_tokens` is inclusive, `TokenUsage.inputTokens` is exclusive, and these
 * are the cases for the conversion (#480).
 *
 * The conformance suite next door proves the four counts arrive from the one
 * envelope a live sidecar actually emits. These cover the envelopes it does not:
 * stock OpenAI, which has cache reads and no writes; the spellings LiteLLM has
 * used for the write; and a server whose numbers do not add up.
 *
 * They build a response inline rather than adding six fixture files, because
 * what varies between them is four integers in one object and a fixture apiece
 * would bury that.
 */
describe("openai-compatible token accounting", () => {
  const usageTransport = (usage: Record<string, unknown>): typeof globalThis.fetch => {
    const body = JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
      ],
      usage
    });
    return async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };

  const usageOf = async (usage: Record<string, unknown>) =>
    (
      await createOpenAICompatibleCompletionClient({
        apiKey: PLACEHOLDER_KEY,
        fetch: usageTransport(usage)
      }).complete({
        model: "test-model",
        maxTokens: 1024,
        messages: [{ role: "user", content: "hello" }]
      })
    ).usage;

  // Stock OpenAI: implicit caching, a read tier, no write tier. 500 of the 600
  // prompt tokens were a hit, so 100 are fresh and the meter must charge 100 at
  // the input rate — not 600, which is what an unconverted count would give.
  it("subtracts cache reads from the inclusive prompt count", async () => {
    expect(
      await usageOf({
        prompt_tokens: 600,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 500 }
      })
    ).toEqual({ inputTokens: 100, outputTokens: 12, cacheReadInputTokens: 500 });
  });

  // No details at all — every prompt token is fresh, and the two absent tiers
  // stay absent rather than becoming zero. `TokenUsage` draws that distinction:
  // a provider that reports nothing has not reported none.
  it("leaves an envelope with no cache details untouched", async () => {
    expect(await usageOf({ prompt_tokens: 40, completion_tokens: 5 })).toEqual({
      inputTokens: 40,
      outputTokens: 5
    });
  });

  each([
    ["prompt_tokens_details.cache_creation_tokens", { cache_creation_tokens: 20 }, {}],
    ["prompt_tokens_details.cache_write_tokens", { cache_write_tokens: 20 }, {}],
    ["the top-level cache_creation_input_tokens", {}, { cache_creation_input_tokens: 20 }]
  ] as const)("reads the cache-write count from %s", async (_name, details, top) => {
    expect(
      await usageOf({
        prompt_tokens: 240,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 100, ...details },
        ...top
      })
    ).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 20
    });
  });

  // A server whose tiers exceed its own total. The subtraction would go
  // negative, the meter would store it and the price table would multiply it, so
  // the fresh-input term is dropped rather than inverted — the cache tiers are
  // still billed in full.
  it("clamps at zero rather than reporting a negative input count", async () => {
    expect(
      await usageOf({
        prompt_tokens: 50,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 90 }
      })
    ).toEqual({ inputTokens: 0, outputTokens: 4, cacheReadInputTokens: 90 });
  });
});

describe("the completion factory", () => {
  it("builds an anthropic client", async () => {
    const transport = stubTransport(anthropicFixture("text"));
    const response = await createCompletionClient(
      { provider: "anthropic", apiKey: PLACEHOLDER_KEY },
      { fetch: transport.fetch }
    ).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    expect(transport.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(response.text).toBe("Paris is the capital of France.");
  });

  it("builds an openai-compatible client at the configured base url", async () => {
    const transport = stubTransport(openaiFixture("text"));
    const response = await createCompletionClient(
      {
        provider: "openai-compatible",
        apiKey: PLACEHOLDER_KEY,
        baseUrl: OPENAI_COMPATIBLE_BASE_URLS.together
      },
      { fetch: transport.fetch }
    ).complete({
      model: "test-model",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hello" }]
    });

    expect(transport.calls[0]?.url).toBe("https://api.together.xyz/v1/chat/completions");
    expect(response.text).toBe("Paris is the capital of France.");
  });
});
