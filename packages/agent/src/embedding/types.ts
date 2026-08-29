// The embedding layer, beside the completion layer and deliberately not inside
// it. What calls this holds an `EmbeddingClient` and never knows which provider
// answered, exactly as the loop holds a `CompletionClient`.
//
// ## Why this is a second surface rather than a method on CompletionClient
//
// **The incumbent provider cannot do it.** Anthropic has no embeddings
// endpoint, so an `embed()` on `CompletionClient` would be a method one of the
// two shipped adapters must throw from — a contract with a hole in it, and the
// conformance suite would have to learn to skip it. Two client types, each
// wholly implemented by whoever implements it, is the shape that stays honest.
//
// It follows that **the embedding provider is configured separately from the
// completion provider** and may be a different vendor entirely. A deployment
// completing against Anthropic and embedding against Voyage or a local Ollama
// is the ordinary case, not an exotic one. See `apps/server`'s environment
// contract.
//
// ## What is not here
//
// No vector store, no chunking, no retrieval. This turns text into vectors and
// reports what that cost. `packages/memory` stores them (#229) and #232 decides
// where recall enters a task.
//
// ## Spend
//
// An embedding call is metered like any other model call, through the same
// `SpendReport` the completion turns use — the proxy is the authoritative meter
// and embedding tokens are tokens. Nothing new crosses the wire for it: a
// report is `{ turn, model, usage }`, and an embedding response fills `usage`
// with input tokens and no output ones. `EmbeddingUsage` therefore names its
// field exactly as `TokenUsage` does, so the mapping stays a copy rather than a
// translation, which is the same promise `TokenUsageReport` makes in
// `packages/schema/src/spend-report.ts`.

/**
 * What to embed, and with what.
 *
 * **Texts, plural, always.** Every compatible endpoint batches, batching is
 * where the cost saving is, and an interface taking one string would make the
 * caller's loop the place batching got forgotten. A caller with one text passes
 * an array of one.
 */
export interface EmbeddingRequest {
  /** Model id, passed through verbatim, exactly as `CompletionRequest.model` is. */
  model: string;
  /** The texts to embed, in order. The response's vectors match this order. */
  texts: string[];
  /** Cancels an in-flight request, so a caller can bound its wall time. */
  signal?: AbortSignal;
}

/**
 * What an embedding call cost.
 *
 * `inputTokens` only, and that is not an omission: an embedding call produces
 * no completion, so there are no output tokens to report and no cache tiers to
 * bill differently. The name matches `TokenUsage.inputTokens` in
 * ../completion/types.ts so that building a `SpendReport` from either is the
 * same field read.
 *
 * A provider that reports nothing omits this rather than reporting zero —
 * `TokenUsage` draws the same distinction, and for the same reason: "not
 * reported" and "free" are different facts, and the proxy's meter is entitled
 * to know which it has.
 */
export interface EmbeddingUsage {
  inputTokens: number;
}

/**
 * The vectors, in the order their texts were given.
 *
 * `Float32Array`, matching `StoredEmbedding.vector` in `@getlibero/memory`, so
 * that a vector reaching the store needs no conversion and no second opinion
 * about its width. Providers return JSON arrays of doubles; the adapter narrows
 * once, here, rather than leaving every caller to.
 */
export interface EmbeddingResponse {
  vectors: Float32Array[];
  /**
   * The model that actually served this call, as the provider echoed it back.
   *
   * `CompletionResponse.model`'s rule exactly (#62), and it matters here for the
   * same two reasons. The proxy prices spend by what *ran*, and a router
   * resolving an alias would otherwise be priced as the alias. And
   * `packages/memory` stamps this id against the vectors it stores, refusing a
   * later vector from a different model — so an id that was quietly substituted
   * would be a file claiming vectors are comparable when they are not.
   *
   * Absent when the provider echoes nothing, and absent is an answer.
   */
  model?: string;
  usage?: EmbeddingUsage;
  /**
   * What the gateway that served this call says it cost, in nano-USD (#239).
   *
   * `CompletionResponse.costNanoUsd`'s rule exactly, read by the same function,
   * and it matters here for a reason of its own: an embedding call is where the
   * unit shows. Nine tokens through LiteLLM cost `1.8e-07` USD — a figure with
   * nothing left of it at the price table's micro-USD, which is why the reported
   * cost is counted in nano.
   */
  costNanoUsd?: number;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/**
 * Every embedding adapter failure a caller sees.
 *
 * `CompletionError`'s sibling and its rule: `provider` names the adapter and
 * never a credential, an endpoint, or the text that was being embedded. The
 * last of those is this class's own addition to the rule — the input to an
 * embedding call is a channel's conversation, and an error message is not a
 * place to put it.
 */
export class EmbeddingError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
    this.provider = provider;
  }
}
