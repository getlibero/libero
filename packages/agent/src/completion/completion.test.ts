import { describe, expect, it } from "vitest";
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
    createAnthropicCompletionClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchImpl })
});

runCompletionConformance({
  name: "openai-compatible",
  fixture: openaiFixture,
  createClient: (fetchImpl) =>
    createOpenAICompatibleCompletionClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchImpl })
});

interface AnthropicBody {
  messages: { role: string; content: { type?: string }[] }[];
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
          content: "PR 41 is open."
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
        { role: "tool", toolCallId: "toolu_1", content: "PR 41 is open." },
        { role: "tool", toolCallId: "toolu_2", content: "not permitted", isError: true }
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
