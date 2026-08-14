import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmbeddingError, type EmbeddingClient } from "./types.js";

/**
 * The contract every embedding adapter must satisfy.
 *
 * `runCompletionConformance`'s sibling in ../completion/conformance.ts, and the
 * same promise: an adapter that passes this suite is one a caller cannot tell
 * apart from any other. A native Voyage or Cohere adapter ships with a harness
 * here and no changes to the assertions.
 *
 * There is one adapter today, so this suite runs once. That is worth building
 * anyway rather than after the second: the assertions are what say what the
 * contract *is*, and writing them against two adapters at once is how a
 * contract ends up being whatever the first two happened to agree on.
 */
export type EmbeddingScenario = "batch" | "out-of-order" | "no-usage";

export interface RecordedEmbeddingRequest {
  url: string;
  body: Record<string, unknown>;
}

export interface EmbeddingHarness {
  name: string;
  /** Wire-format response for a scenario, as the provider would return it. */
  fixture(scenario: EmbeddingScenario): URL;
  createClient(fetchImpl: typeof globalThis.fetch): EmbeddingClient;
}

/**
 * A fetch that answers with a recorded response and keeps what it was asked.
 * No adapter under test reaches the network, so no test needs a credential.
 */
export function stubEmbeddingTransport(fixture: URL): {
  fetch: typeof globalThis.fetch;
  calls: RecordedEmbeddingRequest[];
} {
  const payload = readFileSync(fixture, "utf8");
  const calls: RecordedEmbeddingRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
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

export function runEmbeddingConformance(harness: EmbeddingHarness): void {
  const run = async (
    scenario: EmbeddingScenario,
    texts: string[],
    extra: { model?: string; signal?: AbortSignal } = {}
  ) => {
    const transport = stubEmbeddingTransport(harness.fixture(scenario));
    const client = harness.createClient(transport.fetch);
    const response = await client.embed({
      model: extra.model ?? "test-embedding-model",
      texts,
      ...(extra.signal !== undefined ? { signal: extra.signal } : {})
    });
    return { response, calls: transport.calls };
  };

  describe(`${harness.name} embedding conformance`, () => {
    it("returns one vector per text, in the order the texts were given", async () => {
      const { response } = await run("batch", ["the vault ships friday", "who owns deploys"]);

      expect(response.vectors).toHaveLength(2);
      expect(Array.from(response.vectors[0] ?? [])).toEqual([1, 0, 0, 0]);
      expect(Array.from(response.vectors[1] ?? [])).toEqual([0, 1, 0, 0]);
    });

    it("returns vectors as Float32Array, the width the store takes", async () => {
      const { response } = await run("batch", ["a", "b"]);

      expect(response.vectors[0]).toBeInstanceOf(Float32Array);
      expect(response.vectors[0]).toHaveLength(4);
    });

    it("reports input tokens, and no output tokens exist to report", async () => {
      const { response } = await run("batch", ["a", "b"]);

      expect(response.usage).toEqual({ inputTokens: 14 });
    });

    // #62's rule, carried onto this surface for a second reason beyond pricing:
    // `packages/memory` stamps the served model against a channel's vectors and
    // refuses a later one from a different model, so an id quietly substituted
    // from the request would be a file claiming its vectors are comparable when
    // they are not.
    it("carries the model the provider served, not the one that was asked for", async () => {
      const { response } = await run("batch", ["a", "b"], { model: "router-alias" });

      expect(response.model).toBe("test-embedding-model");
    });

    // The failure with no symptom. Nothing errors when a vector is paired with
    // the wrong text — recall just answers with the wrong thing — so the
    // response's own index is what decides the order, never arrival.
    it("orders vectors by the response's index, not by arrival", async () => {
      const { response } = await run("out-of-order", ["first", "second", "third"]);

      expect(response.vectors.map((vector) => Array.from(vector)[0])).toEqual([1, 2, 3]);
    });

    // A provider that reports nothing has not said the call was free. Absent,
    // never zero — `TokenUsage` draws the same distinction.
    it("omits usage rather than reporting zero when the provider reports none", async () => {
      const { response } = await run("no-usage", ["a", "b"]);

      expect(response.usage).toBeUndefined();
      expect(response.vectors).toHaveLength(2);
    });

    // Batching is the whole reason the interface takes an array, so a caller
    // with nothing to embed must not become a request at all.
    it("answers an empty batch without calling the provider", async () => {
      const { response, calls } = await run("batch", []);

      expect(response.vectors).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it("sends the model and every text", async () => {
      const { calls } = await run("batch", ["the vault ships friday", "who owns deploys"]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.body["model"]).toBe("test-embedding-model");
      const sent = JSON.stringify(calls[0]?.body);
      expect(sent).toContain("the vault ships friday");
      expect(sent).toContain("who owns deploys");
    });

    it("rejects when the caller's signal is already aborted", async () => {
      await expect(run("batch", ["a"], { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        EmbeddingError
      );
    });

    // A short batch would leave the caller pairing vectors against a list that
    // no longer lines up, so it is loud rather than silently short.
    it("refuses a response holding fewer vectors than there were texts", async () => {
      await expect(run("batch", ["a", "b", "c"])).rejects.toBeInstanceOf(EmbeddingError);
    });
  });
}
