// The one query embedding, faked at the provider's client seam.
//
// These cases lived in `recall.test.ts` until #292 moved the call out of it.
// They are here rather than duplicated in both retrievers' suites because what
// they are about — a provider that fails, one that reports no usage, a question
// with nothing in it — is this file's behaviour and neither retriever's.

import { describe, it } from "node:test";
import { expect } from "expect";
import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { createQueryEmbedder } from "./embed.js";
import type { QueryEmbedderOptions } from "./embed.js";

const CHANNEL = "C0ENGINEERING";

function embeddingClient(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(() => Float32Array.from([1, 0, 0])),
        model: "test-embedding-model",
        usage: { inputTokens: 12 }
      })
  };
}

/** A provider that reports no usage. `TokenUsage`'s "absent is not zero". */
function unmeteredEmbeddingClient(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(() => Float32Array.from([1, 0, 0])),
        model: "test-embedding-model"
      })
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

function embedderWith(overrides: Partial<QueryEmbedderOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  return {
    reported,
    embed: createQueryEmbedder({
      embedding: embeddingClient(),
      embeddingModel: "test-embedding-model",
      reportTurn: (_channel, turn) => {
        reported.push(turn);
        return Promise.resolve();
      },
      ...overrides
    })
  };
}

const ask = (query = "how do we roll a new key for a channel") => ({
  channel: CHANNEL,
  query,
  turnId: "Ev0PV52K25.embed"
});

describe("createQueryEmbedder", () => {
  it("answers the provider's vector for the question", async () => {
    const { embed } = embedderWith();

    expect(await embed(ask())).toEqual(Float32Array.from([1, 0, 0]));
  });

  it("embeds the question and nothing else", async () => {
    const asked: string[][] = [];
    const { embed } = embedderWith({
      embedding: {
        embed: ({ texts }) => {
          asked.push(texts);
          return Promise.resolve({ vectors: [Float32Array.from([1, 0, 0])] });
        }
      }
    });

    await embed(ask("what is the deploy window"));

    expect(asked).toEqual([["what is the deploy window"]]);
  });

  it("meters the call as input tokens with no output", async () => {
    const { embed, reported } = embedderWith();

    await embed(ask());

    expect(reported).toEqual([
      {
        usage: { inputTokens: 12, outputTokens: 0 },
        turn: 0,
        id: "Ev0PV52K25.embed",
        model: "test-embedding-model"
      }
    ]);
  });

  // The loop's ordering, and the reason is the loop's: what was paid for is
  // counted even if what it bought turns out to be nothing.
  it("reports the spend before it hands the vector back", async () => {
    const order: string[] = [];
    const embed = createQueryEmbedder({
      embedding: embeddingClient(),
      embeddingModel: "test-embedding-model",
      reportTurn: () => {
        order.push("reported");
        return Promise.resolve();
      }
    });

    await embed(ask());
    order.push("returned");

    expect(order).toEqual(["reported", "returned"]);
  });

  it("reports nothing when the provider reports no usage", async () => {
    const { embed, reported } = embedderWith({ embedding: unmeteredEmbeddingClient() });

    await embed(ask());

    expect(reported).toEqual([]);
  });

  // #230's degradation. Not logged, because it is a steady state rather than an
  // event — the process says so once at startup.
  it("answers null with no embedding provider configured", async () => {
    const { lines, logger } = capturingLogger();
    const { embed } = embedderWith({ embedding: null, logger });

    expect(await embed(ask())).toBeNull();
    expect(lines).toEqual([]);
  });

  // A client with no model id is what `embeddingConfigFromEnv` returning null
  // half-way would look like. It cannot happen through `index.ts`, where the two
  // are spread from one object — which is exactly why the guard is worth a test
  // rather than being left to that spread.
  it("answers null when the model id is missing beside a client", async () => {
    let called = false;
    const embed = createQueryEmbedder({
      embedding: {
        embed: () => {
          called = true;
          return Promise.resolve({ vectors: [Float32Array.from([1, 0, 0])] });
        }
      },
      reportTurn: () => Promise.resolve()
    });

    expect(await embed(ask())).toBeNull();
    expect(called).toBe(false);
  });

  it("answers null for an empty question, without calling the provider", async () => {
    let called = false;
    const { embed, reported } = embedderWith({
      embedding: {
        embed: () => {
          called = true;
          return Promise.resolve({ vectors: [Float32Array.from([1, 0, 0])] });
        }
      }
    });

    expect(await embed(ask("   "))).toBeNull();
    expect(called).toBe(false);
    expect(reported).toEqual([]);
  });

  // Every retrieval built on this is an improvement to an answer rather than a
  // precondition for one, so a provider outage must not reach the mention path.
  it("answers null rather than throwing when the provider fails", async () => {
    const { lines, logger } = capturingLogger();
    const { embed } = embedderWith({
      embedding: { embed: () => Promise.reject(new Error("embed upstream down")) },
      logger
    });

    await expect(embed(ask())).resolves.toBeNull();
    expect(lines.map(line => line.event)).toContain("query_embedding_failed");
  });

  // The provider's error text can carry the request, and the request is the
  // channel's own question.
  it("logs the error's name and never its message", async () => {
    const { lines, logger } = capturingLogger();
    const { embed } = embedderWith({
      embedding: {
        embed: () => Promise.reject(new Error("failed embedding: how do we roll a new key"))
      },
      logger
    });

    await embed(ask());

    expect(JSON.stringify(lines)).not.toContain("roll a new key");
  });

  // A 200 with an empty array is the same nothing as a failure, and
  // `noUncheckedIndexedAccess` is what makes the case reachable at all.
  it("answers null when the provider returns no vector at all", async () => {
    const { embed } = embedderWith({
      embedding: { embed: () => Promise.resolve({ vectors: [] }) }
    });

    expect(await embed(ask())).toBeNull();
  });
});
