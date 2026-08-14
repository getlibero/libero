import { describe, expect, it } from "vitest";
import { runEmbeddingConformance, stubEmbeddingTransport } from "./conformance.js";
import { createEmbeddingClient } from "./factory.js";
import {
  createOpenAICompatibleEmbeddingClient,
  OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS
} from "./openai.js";
import { EmbeddingError } from "./types.js";

// The SDK requires a non-empty key to construct. Nothing reaches the network:
// every client below is built on a stub transport.
const PLACEHOLDER_KEY = "placeholder-not-a-credential";

const openaiFixture = (name: string) =>
  new URL(`../../fixtures/embedding/openai/${name}.json`, import.meta.url);

runEmbeddingConformance({
  name: "openai-compatible",
  fixture: openaiFixture,
  createClient: (fetchImpl) =>
    createOpenAICompatibleEmbeddingClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchImpl })
});

describe("the openai-compatible embedding adapter", () => {
  it("asks for float encoding rather than letting the server choose", async () => {
    const transport = stubEmbeddingTransport(openaiFixture("batch"));
    await createOpenAICompatibleEmbeddingClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: transport.fetch
    }).embed({ model: "test-embedding-model", texts: ["a", "b"] });

    // Several compatible servers default to base64, which would arrive as
    // strings where this adapter expects numbers.
    expect(transport.calls[0]?.body["encoding_format"]).toBe("float");
  });

  it("posts to the configured base URL", async () => {
    const transport = stubEmbeddingTransport(openaiFixture("batch"));
    await createOpenAICompatibleEmbeddingClient({
      apiKey: PLACEHOLDER_KEY,
      baseUrl: OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS.voyage,
      fetch: transport.fetch
    }).embed({ model: "voyage-3", texts: ["a", "b"] });

    expect(transport.calls[0]?.url).toBe("https://api.voyageai.com/v1/embeddings");
  });

  // The completions list and the embeddings list are not the same set — Voyage
  // embeds and does not complete, Groq completes and does not embed — which is
  // why there are two constants and not one.
  it("lists endpoints that actually embed", () => {
    expect(OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS).toHaveProperty("voyage");
    expect(OPENAI_COMPATIBLE_EMBEDDING_BASE_URLS).not.toHaveProperty("groq");
  });

  // An error must not carry what was being embedded: the input to this call is
  // a channel's conversation.
  it("names the provider and never the text it was given", async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new Error("upstream exploded");
    };
    const client = createOpenAICompatibleEmbeddingClient({
      apiKey: PLACEHOLDER_KEY,
      fetch: failing
    });

    const error: EmbeddingError = await client
      .embed({ model: "m", texts: ["the vault key is hunter2"] })
      .then(
        () => {
          throw new Error("expected the embed call to reject");
        },
        (thrown: unknown) => thrown as EmbeddingError
      );

    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error.provider).toBe("openai-compatible");
    expect(error.message).not.toContain("hunter2");
    expect(JSON.stringify(error.message)).not.toContain("vault key");
  });
});

describe("the embedding factory", () => {
  it("builds an openai-compatible client", () => {
    const client = createEmbeddingClient({
      provider: "openai-compatible",
      apiKey: PLACEHOLDER_KEY
    });

    expect(typeof client.embed).toBe("function");
  });

  // A structural regression test on the surface: an embedding client embeds and
  // does nothing else. It holds no store and no retrieval.
  it("exposes embedding and nothing else", () => {
    const client = createEmbeddingClient({
      provider: "openai-compatible",
      apiKey: PLACEHOLDER_KEY
    });

    expect(Object.keys(client).sort()).toEqual(["embed"]);
  });
});
