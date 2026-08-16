// One embedding of the incoming request, at the head of a task, shared by
// everything that retrieves against it (#292).
//
// This was inside `./recall.ts` until skills needed the same vector. Two callers
// each embedding the same sentence would be two provider round trips and two
// spend reports for one question, and the second would be invisible — a channel
// paying twice with nothing in the meter saying why. So the call moved out here
// and the two retrievers take a vector.
//
// ## What it is not
//
// Not a cache. It embeds once per invocation and holds nothing between them: the
// router calls it once inside the session's lock and hands the result to both
// retrievers, so the sharing is a local variable rather than state this file
// keeps. A cache keyed on request text would be a second thing to invalidate for
// a saving that a single call site already gets for free.
//
// Not a decision about whether retrieval should happen. It embeds what it is
// given; the two retrievers decide, from the sheet, whether they want anything
// searched. The router is what asks the cheaper question first — see its own
// comment on why it may skip this call entirely.
//
// ## What it costs and who pays
//
// One embedding call per task, metered through the same `SpendReport` path a
// completion turn uses, on the argument `./recall.ts` made when this code lived
// there: an embedding is spend whether it was spent writing the corpus or
// reading it.
//
// **Reported before the vector is returned**, which is the loop's ordering and
// matters for the loop's reason: what was paid for is counted even if what it
// bought turns out to be nothing. An embedding call has input tokens and no
// output ones.

import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";

export interface QueryEmbedderOptions {
  /** How this deployment embeds, or `null` when it does not (#230). */
  embedding: EmbeddingClient | null;
  /** The embedding model id. Absent alongside a null client. */
  embeddingModel?: string;
  /** Reports the query embedding's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  logger?: Logger;
}

export interface QueryEmbedRequest {
  readonly channel: string;
  /** What was asked. This is what gets embedded. */
  readonly query: string;
  /** The turn id this task's embedding spend is keyed under, so the meter dedupes. */
  readonly turnId: string;
}

/**
 * Embed the incoming request, or answer `null`.
 *
 * **Never rejects and never throws.** It runs on the path a mention takes, in
 * front of the model, and every retrieval built on it is an improvement to an
 * answer rather than a precondition for one. `null` covers a deployment with no
 * embedding provider, an empty question, and a provider that failed — the three
 * are indistinguishable to a caller on purpose, because the response to all
 * three is the same: retrieve without a vector, or not at all.
 */
export type QueryEmbedder = (request: QueryEmbedRequest) => Promise<Float32Array | null>;

export function createQueryEmbedder(options: QueryEmbedderOptions): QueryEmbedder {
  const logger = options.logger ?? createSilentLogger();

  return async request => {
    const client = options.embedding;
    const model = options.embeddingModel;
    // No provider is #230's stated degradation; an empty question has nothing to
    // match on. Neither is a failure and neither is logged, because both are
    // steady states rather than events.
    if (client === null || model === undefined) return null;
    if (request.query.trim() === "") return null;

    try {
      const response = await client.embed({ model, texts: [request.query] });

      if (response.usage !== undefined) {
        await options.reportTurn(request.channel, {
          usage: { inputTokens: response.usage.inputTokens, outputTokens: 0 },
          turn: 0,
          id: request.turnId,
          ...(response.model === undefined ? {} : { model: response.model })
        });
      }

      // `?? null` rather than the raw index: `noUncheckedIndexedAccess` makes
      // this `Float32Array | undefined`, and a provider that answered 200 with an
      // empty array is the same nothing as one that failed.
      return response.vectors[0] ?? null;
    } catch (error) {
      // A new event word rather than `./recall.ts`'s `recall_failed`, because
      // the failure is no longer recall's alone: one of these now costs a task
      // its summaries *and* its skills, and an operator reading `recall_failed`
      // beside a task with no skills would be looking for a second cause that
      // does not exist. `recall_failed` stays for what is still recall's — a
      // store that could not answer.
      //
      // The reason is the error's name and never its message: a provider's error
      // text can carry the request, and the request is the channel's own
      // question.
      logger.log("warn", {
        event: "query_embedding_failed",
        channel: request.channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return null;
    }
  };
}
