// The rebuild command, against a real store and a stated provider (#282).
//
// ./tasks-cli.test.ts's shape — argv, env and both writers injected, so what is
// under test is the command rather than a process — with one addition it needs
// and that one does not: a fake `EmbeddingClient`.
//
// **The store is real.** A drop is DDL and a re-embed is a `vec0` write, so a
// fake would prove the command agrees with itself and nothing about whether a
// file that held one model's vectors can be made to hold another's. That is the
// property the whole command exists for.
//
// The embedder is fake, and its shape is the one `e2e/README.md` states for a
// fake embedder: deterministic, so a test says what is near what. Here it does
// not even need to be near anything — nothing under test reads a vector back for
// its distance — so it answers a width and counts its calls.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { openMessageStore } from "@getlibero/memory";
import type { MessageStore } from "@getlibero/memory";
import type { CompletedTurn, EmbeddingRequest, EmbeddingResponse } from "@getlibero/agent";
import type { RebuildCliIo } from "./rebuild-cli.js";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  MAX_SUMMARIES_PER_EMBED_CALL,
  MAX_SUMMARIES_PER_REBUILD,
  runRebuildCommand
} from "./rebuild-cli.js";

const CHANNEL = "C0ENGINEERING";
const MODEL = "text-embedding-3-small";
const NOW = Date.UTC(2026, 7, 21, 9, 0, 0);

let root: string;
let store: MessageStore;
/** Every request the command made, so a test can assert on batching and texts. */
let requests: EmbeddingRequest[];
/** Every turn the command reported, so a test can assert on the meter. */
let reported: Array<CompletedTurn & { id: string }>;

/**
 * A provider that answers one vector per text at a stated width.
 *
 * `served` is what it echoes back as the model, which is not always what it was
 * asked for — the one case that matters is asserted below.
 */
function embedder(options: { dims?: number; served?: string; usage?: number } = {}) {
  const dims = options.dims ?? 3;
  return {
    embed: async (request: EmbeddingRequest): Promise<EmbeddingResponse> => {
      requests.push(request);
      return {
        vectors: request.texts.map((_, index) =>
          // Distinct per text so nothing can pass by storing the same vector
          // repeatedly, and deterministic so a rerun is the same file.
          Float32Array.from({ length: dims }, (_unused, axis) => (axis === index % dims ? 1 : 0))
        ),
        ...(options.served === undefined ? {} : { model: options.served }),
        ...(options.usage === undefined ? {} : { usage: { inputTokens: options.usage } })
      };
    }
  };
}

/** A summarized thread, which is what a rebuild has to work from. */
function summarize(thread: string, text = `what was decided in ${thread}`): void {
  store.append({
    ts: thread,
    threadTs: null,
    userId: "U0ALICE",
    displayName: null,
    text: "root",
    at: NOW
  });
  store.putThreadSummary({
    thread,
    shape: "decision",
    text,
    coversThroughTs: thread,
    messageCount: 1,
    at: NOW
  });
}

/**
 * `embeddingModel` takes an explicit `undefined` here and nowhere else. Under
 * `exactOptionalPropertyTypes` absent and present-but-undefined are different,
 * and the no-provider case is the one test that has to say "there is no model
 * id" rather than leaving the default in place.
 */
type RebuildOverrides = Partial<Omit<RebuildCliIo, "embeddingModel">> & {
  embeddingModel?: string | undefined;
};

async function run(
  argv: string[],
  overrides: RebuildOverrides = {}
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const { embeddingModel, ...rest } = overrides;
  const model = "embeddingModel" in overrides ? embeddingModel : MODEL;
  const code = await runRebuildCommand({
    argv,
    env: { AGENT_STORE_ROOT: root },
    out: line => out.push(line),
    err: line => err.push(line),
    embedding: embedder(),
    ...(model === undefined ? {} : { embeddingModel: model }),
    reportTurn: async (_channel, turn) => {
      reported.push(turn);
    },
    now: () => NOW,
    // ./tasks-cli.test.ts's opener and its reason: one handle, so the command's
    // writes are visible to the assertions without two handles racing one file.
    // `close` is stubbed because the command closes what it opens.
    open: () => ({ ...store, close: () => {} }),
    ...rest
  });
  return { code, out, err };
}

/** What the store has a vector for, by thread. */
function embedded(): string[] {
  return store
    .nearest(Float32Array.from([1, 0, 0]), 100, "summary")
    .map(hit => hit.source.ref)
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-rebuild-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  requests = [];
  reported = [];
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("what it refuses before it opens anything", () => {
  it("prints usage for no channel", async () => {
    const { code, err } = await run([]);
    expect(code).toBe(EXIT_USAGE);
    expect(err[0]).toContain("usage: rebuild");
  });

  it("prints usage for a second argument, rather than ignoring it", async () => {
    const { code, err } = await run([CHANNEL, "--all"]);
    expect(code).toBe(EXIT_USAGE);
    expect(err[0]).toContain("usage: rebuild");
  });

  // The id becomes a path segment and it came off a command line.
  it("refuses a channel id that is not one", async () => {
    const { code, err } = await run(["../../etc"]);
    expect(code).toBe(EXIT_USAGE);
    expect(err[0]).toContain("not a valid channel id");
  });

  // A configuration answer rather than anything about this channel, so it is
  // given before a store is opened.
  it("says so when the deployment has configured no embedding provider", async () => {
    const { code, err } = await run([CHANNEL], { embedding: null, embeddingModel: undefined });
    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("no embedding provider");
    expect(err[0]).toContain("AGENT_EMBEDDING_PROVIDER");
  });

  it("says so when AGENT_STORE_ROOT is not set", async () => {
    const { code, err } = await run([CHANNEL], { env: {} });
    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("AGENT_STORE_ROOT");
  });

  // "No such channel" and "nothing to do" are different answers.
  it("says so when the channel has no store", async () => {
    const { code, err } = await run(["C0NOSUCH"], {
      open: () => {
        throw new Error("unable to open database file");
      }
    });
    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("no store for C0NOSUCH");
  });
});

describe("a channel whose summaries were never embedded", () => {
  it("embeds every one and says how many", async () => {
    summarize("1.1");
    summarize("2.2");

    const { code, out } = await run([CHANNEL]);

    expect(code).toBe(EXIT_OK);
    expect(embedded()).toEqual(["1.1", "2.2"]);
    expect(out.at(-1)).toContain("rebuilt C0ENGINEERING: 2 summaries embedded");
    expect(store.embeddingModel()).toEqual({ model: MODEL, dims: 3 });
  });

  // Nothing was dropped, because nothing was held: this is a repair of what was
  // never embedded rather than a rebuild of what was.
  it("drops nothing, and says nothing about dropping", async () => {
    summarize("1.1");
    const { out } = await run([CHANNEL]);
    expect(out.join("\n")).not.toContain("dropped");
  });

  it("says there is nothing to do when every summary already has a vector", async () => {
    summarize("1.1");
    await run([CHANNEL]);
    requests = [];

    const { code, out } = await run([CHANNEL]);

    expect(code).toBe(EXIT_OK);
    expect(requests).toEqual([]);
    expect(out.at(-1)).toContain("nothing to rebuild");
  });

  // A `nothing` summary carries no text and is deliberately out of the corpus,
  // and the read is what enforces that — asserted here as well because this is
  // the command that would otherwise put chatter in front of every question.
  it("never embeds a thread the sweep assessed as nothing", async () => {
    summarize("1.1");
    store.append({
      ts: "2.2",
      threadTs: null,
      userId: "U0ALICE",
      displayName: null,
      text: "deploying now",
      at: NOW
    });
    store.putThreadSummary({
      thread: "2.2",
      shape: "nothing",
      text: "",
      coversThroughTs: "2.2",
      messageCount: 1,
      at: NOW
    });

    await run([CHANNEL]);

    expect(embedded()).toEqual(["1.1"]);
    expect(requests[0]?.texts).toEqual(["what was decided in 1.1"]);
  });
});

describe("a channel whose embedding model changed", () => {
  beforeEach(async () => {
    summarize("1.1");
    summarize("2.2");
    await run([CHANNEL]);
    requests = [];
    reported = [];
  });

  // The whole point. A vec0 table's width is fixed at creation, so the new width
  // is only reachable through the drop — and every summary comes back under it.
  it("drops what was held and re-embeds everything at the new width", async () => {
    const { code, out } = await run([CHANNEL], {
      embedding: embedder({ dims: 4 }),
      embeddingModel: "text-embedding-3-large"
    });

    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain("dropped C0ENGINEERING's vectors");
    expect(out[0]).toContain(`they were ${MODEL} at 3 dimensions`);
    expect(out[0]).toContain("text-embedding-3-large");
    expect(store.embeddingModel()).toEqual({ model: "text-embedding-3-large", dims: 4 });
    expect(store.nearest(Float32Array.from([1, 0, 0, 0]), 100, "summary")).toHaveLength(2);
  });

  // The property the command rests on: this costs embedding calls and no
  // completion ones, which is only true if the corpus outlives the vectors.
  it("leaves the summaries themselves alone, so nothing is re-summarized", async () => {
    await run([CHANNEL], {
      embedding: embedder({ dims: 4 }),
      embeddingModel: "text-embedding-3-large"
    });

    expect(store.readThreadSummary("1.1")?.text).toBe("what was decided in 1.1");
    expect(store.recent(10)).toHaveLength(2);
  });

  // A skill's vector goes in the drop and is not re-embedded here, because the
  // skill-embedding pass picks it up on the channel's next message. Asserted so
  // that a later change putting skills back in the command is a deliberate one.
  it("does not re-embed a skill it dropped", async () => {
    store.putEmbedding({
      source: { kind: "skill", ref: "deploy-runbook" },
      vector: Float32Array.from([0, 1, 0]),
      model: MODEL,
      at: NOW
    });

    await run([CHANNEL], {
      embedding: embedder({ dims: 4 }),
      embeddingModel: "text-embedding-3-large"
    });

    expect(store.nearest(Float32Array.from([0, 1, 0, 0]), 100, "skill")).toEqual([]);
  });
});

describe("what it stamps, and what it reports", () => {
  // The value the file stamps and every later `putEmbedding` is checked against.
  // A rebuild that stamped the requested id while the provider served another
  // would leave the file needing a second rebuild.
  it("stamps the model the provider served, not the one it was asked for", async () => {
    summarize("1.1");

    await run([CHANNEL], { embedding: embedder({ served: "text-embedding-3-small-v2" }) });

    expect(store.embeddingModel()).toEqual({ model: "text-embedding-3-small-v2", dims: 3 });
  });

  it("reports what a batch cost, as input tokens and no output ones", async () => {
    summarize("1.1");
    summarize("2.2");

    await run([CHANNEL], { embedding: embedder({ usage: 412 }) });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ inputTokens: 412, outputTokens: 0 });
  });

  // "Not reported" and "free" are different facts, and the meter is entitled to
  // know which it has.
  it("reports nothing when the provider reported nothing, rather than a zero", async () => {
    summarize("1.1");
    await run([CHANNEL]);
    expect(reported).toEqual([]);
  });

  // The proxy's meter dedupes on (channel, day, turn), so a rerun of the same
  // work has to carry the same id — which is what makes an interrupted rebuild
  // resumable without being counted twice.
  it("gives the same batch the same turn id across two runs", async () => {
    summarize("1.1");
    summarize("2.2");
    await run([CHANNEL], { embedding: embedder({ usage: 1 }) });
    const first = reported.map(turn => turn.id);

    store.dropEmbeddings();
    reported = [];
    await run([CHANNEL], { embedding: embedder({ usage: 1 }) });

    expect(reported.map(turn => turn.id)).toEqual(first);
    expect(first[0]).toMatch(/^rebuild-[0-9a-f]{16}$/);
  });

  it("gives a different batch a different turn id", async () => {
    summarize("1.1");
    await run([CHANNEL], { embedding: embedder({ usage: 1 }) });
    const first = reported[0]?.id;

    store.dropEmbeddings();
    summarize("2.2");
    reported = [];
    await run([CHANNEL], { embedding: embedder({ usage: 1 }) });

    expect(reported[0]?.id).not.toBe(first);
  });
});

describe("bounds", () => {
  it("batches, rather than calling the provider once per summary", async () => {
    for (let index = 0; index < MAX_SUMMARIES_PER_EMBED_CALL + 2; index += 1) {
      summarize(`${index + 1}.0`);
    }

    const { code } = await run([CHANNEL]);

    expect(code).toBe(EXIT_OK);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.texts).toHaveLength(MAX_SUMMARIES_PER_EMBED_CALL);
    expect(requests[1]?.texts).toHaveLength(2);
  });

  // A provider that answered with fewer vectors than texts leaves the rest
  // pending, which the next iteration would read back unchanged — so a batch
  // that stored nothing ends the run rather than spinning on it.
  it("stops rather than spinning when the provider returns no vectors", async () => {
    summarize("1.1");

    const { code, err } = await run([CHANNEL], {
      embedding: { embed: async () => ({ vectors: [] }) }
    });

    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("the provider returned no vector");
    expect(err[0]).toContain("run it again");
    expect(embedded()).toEqual([]);
  });

  // What was embedded before the failure is kept, which is the point of a read
  // that derives what is left rather than remembering it.
  it("keeps what it embedded before the provider stopped answering", async () => {
    for (let index = 0; index < MAX_SUMMARIES_PER_EMBED_CALL + 1; index += 1) {
      summarize(`${index + 1}.0`);
    }
    let calls = 0;
    const failing = embedder();

    const { code } = await run([CHANNEL], {
      embedding: {
        embed: async request => {
          calls += 1;
          if (calls > 1) return { vectors: [] };
          return failing.embed(request);
        }
      }
    });

    expect(code).toBe(EXIT_ERROR);
    expect(embedded()).toHaveLength(MAX_SUMMARIES_PER_EMBED_CALL);
  });

  // A provider failure mid-run is reported with the store's own words and stops
  // the run; what was already written stays written.
  it("reports a provider that threw, and keeps what it had", async () => {
    summarize("1.1");

    const { code, err } = await run([CHANNEL], {
      embedding: {
        embed: async () => {
          throw new Error("upstream refused the connection");
        }
      }
    });

    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("upstream refused the connection");
  });
});

// A backstop rather than a page, and never a silent truncation: a run that
// reaches it says so and says to run it again. Driven at an injected figure,
// because the real one is a thousand summaries and what is under test is the
// wording and the continuation rather than the number.
describe("the run limit", () => {
  beforeEach(() => {
    summarize("1.1");
    summarize("2.2");
    summarize("3.3");
  });

  it("stops at the limit and says it is this run's limit", async () => {
    const { code, out } = await run([CHANNEL], { limit: 2 });

    expect(code).toBe(EXIT_OK);
    expect(embedded()).toEqual(["1.1", "2.2"]);
    expect(out.at(-1)).toContain("this run's limit");
    expect(out.at(-1)).toContain("run it again to continue");
  });

  // Oldest first is what makes this true: the second run reads what the first
  // did not reach rather than the same head again.
  it("continues where it stopped when run again", async () => {
    await run([CHANNEL], { limit: 2 });
    const { code, out } = await run([CHANNEL], { limit: 2 });

    expect(code).toBe(EXIT_OK);
    expect(embedded()).toEqual(["1.1", "2.2", "3.3"]);
    expect(out.at(-1)).toContain("1 summary embedded");
  });

  it("is a figure an ordinary channel never reaches, and several batches wide", () => {
    expect(MAX_SUMMARIES_PER_REBUILD).toBeGreaterThan(MAX_SUMMARIES_PER_EMBED_CALL * 10);
  });
});
