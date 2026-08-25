// The skill-embedding pass, against a real store and a real directory.
//
// `skill-recall.test.ts`'s setup and its reason: the whole feature is the seam —
// files on disk, an index that follows them, and vectors written against what the
// index says is missing one. A fake `SkillFiles` or a fake `MessageStore` would
// leave every claim here asserted against the fake instead of the mechanism, and
// the mechanism is exactly what #305 found unwired.
//
// The embedding provider *is* faked, at the client seam where every other test in
// this tree fakes it. Two fakes rather than one, deliberately: `spaced` answers
// only for texts the hand-built space knows and throws otherwise, so the semantic
// case cannot pass by accident; `flat` answers one vector for anything, for the
// structural cases where what is being counted is calls and rows.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, SkillFiles } from "@getlibero/memory";
import { openMessageStore, openSkillFiles, reconcileSkillIndex } from "@getlibero/memory";
import { MAX_SKILLS_PER_EMBED_PASS, createSkillEmbedSweep } from "./skill-embed.js";
import type { SkillEmbedSweepOptions } from "./skill-embed.js";
import { createSkillRecall } from "./skill-recall.js";
import { createSharedSkillPoolOpener } from "./skill-pool.js";
import { SWEEP_INTERVAL_MS } from "./summarize.js";

const CHANNEL = "C0ENGINEERING";
const MAX_SKILLS = 100;
const AT = 1_700_000_000_000;

let root: string;
let sharedRoot: string;
let file: string;
let store: MessageStore;
let files: SkillFiles;

/** Cluster one, as a question somebody would type. */
const QUESTION = "how do we roll a new key for a channel";
/** Cluster one, as a skill's description. Not one token in common with it. */
const CREDENTIALS = "Swapping client credentials before they expire.";
/** The same skill after an edit — still cluster one, so a re-embedding is visible. */
const CREDENTIALS_REWRITTEN = "Rotating client credentials ahead of expiry.";
/** Cluster two, far from both. */
const CONTAINERS = "When somebody asks which base image the containers use.";

/**
 * A hand-built embedding space, borrowed wholesale from `skill-recall.test.ts`.
 *
 * The paired phrases sit together and **share not one token with each other**,
 * which is what makes the semantic case below a real test: the lexical leg is run
 * beside it as the control and finds nothing. `searchSkills` ORs its terms, so a
 * single shared `a` or `is` would be a lexical hit and the control would be
 * worthless.
 */
const EMBEDDINGS: Record<string, number[]> = {
  [QUESTION]: [1, 0, 0],
  [CREDENTIALS]: [0.98, 0.02, 0],
  [CREDENTIALS_REWRITTEN]: [0.97, 0.03, 0],
  [CONTAINERS]: [0, 0.98, 0.02]
};

function vectorFor(text: string): Float32Array {
  const point = EMBEDDINGS[text];
  if (point === undefined) throw new Error(`the fixture has no embedding for: ${text}`);
  return Float32Array.from(point);
}

/**
 * A mutable clock, for the cases that need two passes separated by an interval.
 *
 * `clock()` hands out the reader and resets it, so a test that asks for one
 * starts at `AT` regardless of what ran before it.
 */
let clockAt = AT;

function clock(): () => number {
  clockAt = AT;
  return () => clockAt;
}

function tick(ms: number): void {
  clockAt += ms;
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/** An embedding client over the hand-built space. A text it does not know is a bug. */
function spaced(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(vectorFor),
        model: "test-embedding-model",
        usage: { inputTokens: 10 }
      })
  };
}

/** An embedding client answering one vector for anything, and counting its calls. */
function flat(options: { reportsUsage?: boolean } = {}): {
  client: EmbeddingClient;
  calls: () => number;
  batches: () => string[][];
} {
  let calls = 0;
  const batches: string[][] = [];
  return {
    calls: () => calls,
    batches: () => batches,
    client: {
      embed: ({ texts }) => {
        calls += 1;
        batches.push(texts);
        return Promise.resolve({
          vectors: texts.map(() => Float32Array.from([1, 0, 0])),
          model: "test-embedding-model",
          ...(options.reportsUsage === false ? {} : { usage: { inputTokens: 10 } })
        });
      }
    }
  };
}

/** Writes a skill the way the author turn does — through the checked path. */
function skill(name: string, description: string, body = "Step one. Step two."): void {
  const result = files.apply({ op: "skill_create", name, description, body });
  if (result.outcome !== "written") {
    throw new Error(`the fixture could not write ${name}: ${result.reason}`);
  }
}

/**
 * The same, written straight to disk, the way a team member with an editor
 * would.
 *
 * `skill-recall.test.ts` takes raw frontmatter here because its cases vary the
 * shape of it; every case in this file varies one of the four fields, so this
 * takes them apart and keeps the call sites legible.
 */
function handWritten(
  name: string,
  description: string,
  status: string,
  body = "Step one. Step two."
): void {
  mkdirSync(join(root, CHANNEL, "skills"), { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    `description: ${description}`,
    "created: 2026-08-01",
    `status: ${status}`
  ].join("\n");
  writeFileSync(join(root, CHANNEL, "skills", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/**
 * Which skills have a vector, read past the store's own API.
 *
 * `nearest` would answer the same question through a ranking, which is a second
 * thing that can be wrong. `skill-recall.test.ts` reads the use columns the same
 * way and for the same reason: the row is the mechanism. A read-only connection,
 * so nothing here can write what it is checking.
 */
function embedded(): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare(`SELECT source_ref FROM embedding_source WHERE source_kind = 'skill' ORDER BY source_ref`)
      .all() as Array<{ source_ref: string }>;
    return rows.map(row => row.source_ref);
  } finally {
    db.close();
  }
}

function sweepWith(overrides: Partial<SkillEmbedSweepOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const base: SkillEmbedSweepOptions = {
    embedding: spaced(),
    embeddingModel: "test-embedding-model",
    files: () => files,
    settings: () => Promise.resolve({ enabled: true, maxSkills: MAX_SKILLS, sharedSkills: [] }),
    reportTurn: (_channel, turn) => {
      reported.push(turn);
      return Promise.resolve();
    },
    // The channel is under its caps unless a case says otherwise (#335).
    maySpend: () => Promise.resolve(true),
    now: () => AT,
    ...overrides
  };
  return { sweep: createSkillEmbedSweep(base), reported };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-skill-embed-"));
  sharedRoot = mkdtempSync(join(tmpdir(), "libero-skill-embed-shared-"));
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  store = openMessageStore({ channel: CHANNEL, root });
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(sharedRoot, { recursive: true, force: true });
});

describe("createSkillEmbedSweep", () => {
  it("indexes and embeds a skill no task has ever seen", async () => {
    skill("rotate-a-cert", CREDENTIALS);

    // Nothing has run: no reconciliation, so the index does not know the file.
    expect(store.listSkills("channel")).toHaveLength(0);

    const { sweep } = sweepWith();
    expect(await sweep(CHANNEL, store)).toBe(1);

    // Both halves of the pass, and the first is what makes the second possible.
    expect(store.listSkills("channel").map(entry => entry.name)).toEqual(["rotate-a-cert"]);
    expect(embedded()).toEqual(["rotate-a-cert"]);
  });

  it("embeds a skill a person wrote with an editor", async () => {
    handWritten("cut-a-release", CONTAINERS, "active", "1. Tag.");

    expect(await sweepWith().sweep(CHANNEL, store)).toBe(1);
    expect(embedded()).toEqual(["cut-a-release"]);
  });

  it("gives the vector leg something to answer with — a question sharing no stem", async () => {
    skill("rotate-a-cert", CREDENTIALS);

    await sweepWith().sweep(CHANNEL, store);

    // The control, and it runs first so the case cannot be read as "both legs
    // found it". Not one token in common, so the lexical leg has nothing.
    expect(store.searchSkills(QUESTION, 3)).toEqual([]);

    const loaded = await createSkillRecall({ now: () => AT })({
      channel: CHANNEL,
      store,
      files,
      shared: null,
      vector: vectorFor(QUESTION),
      query: QUESTION,
      topK: 3,
      maxSkillChars: 8_192,
      maxSkills: MAX_SKILLS
    });

    expect(loaded.channel.map(entry => entry.name)).toEqual(["rotate-a-cert"]);
  });

  it("never embeds an archived skill", async () => {
    handWritten("cut-a-release", CONTAINERS, "archived", "1. Tag.");

    expect(await sweepWith().sweep(CHANNEL, store)).toBe(0);
    expect(embedded()).toEqual([]);
  });

  it("drops the vector of a skill archived after it was embedded, and does not put it back", async () => {
    skill("base-images", CONTAINERS);

    const { sweep } = sweepWith({ now: clock() });
    await sweep(CHANNEL, store);
    expect(embedded()).toEqual(["base-images"]);

    handWritten("base-images", CONTAINERS, "archived", "1. Tag.");

    tick(SWEEP_INTERVAL_MS);
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(embedded()).toEqual([]);
  });

  it("re-embeds an edited description and nothing else", async () => {
    skill("rotate-a-cert", CREDENTIALS);

    const { sweep, reported } = sweepWith({ now: clock() });
    await sweep(CHANNEL, store);
    expect(reported).toHaveLength(1);

    // A body edit. Same description, so the fingerprint moves, the row is
    // re-read, and `description_hash` says the vector still stands.
    handWritten("rotate-a-cert", CREDENTIALS, "active", "1. Rotate. 2. Promote.");
    tick(SWEEP_INTERVAL_MS);
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(reported).toHaveLength(1);

    // A rewritten status — what the lifecycle job (#294) will do weekly, and the
    // case `description_hash` exists for.
    handWritten("rotate-a-cert", CREDENTIALS, "stale", "1. Rotate. 2. Promote.");
    tick(SWEEP_INTERVAL_MS);
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(reported).toHaveLength(1);

    // The description itself. This one costs a call.
    handWritten("rotate-a-cert", CREDENTIALS_REWRITTEN, "stale", "1. Rotate. 2. Promote.");
    tick(SWEEP_INTERVAL_MS);
    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(reported).toHaveLength(2);
    expect(reported[1]?.id).not.toBe(reported[0]?.id);
  });

  it("meters the call on an id that is the same for a retry of the same work", async () => {
    skill("rotate-a-cert", CREDENTIALS);

    const { sweep, reported } = sweepWith({ now: clock() });
    await sweep(CHANNEL, store);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      turn: 0,
      model: "test-embedding-model",
      usage: { inputTokens: 10, outputTokens: 0 }
    });
    expect(reported[0]?.id).toMatch(/^skills-embed-[0-9a-f]{16}$/);

    // The crash this shape is for: the call was paid for and the vector never
    // landed. The same batch of the same text is the same id, so the proxy's
    // meter counts it once.
    store.removeEmbedding({ kind: "skill", ref: "rotate-a-cert" });
    tick(SWEEP_INTERVAL_MS);
    await sweep(CHANNEL, store);

    expect(reported).toHaveLength(2);
    expect(reported[1]?.id).toBe(reported[0]?.id);
  });

  it("stores the vector but reports nothing when the provider reports no usage", async () => {
    skill("base-images", CONTAINERS);
    const { client } = flat({ reportsUsage: false });

    const { sweep, reported } = sweepWith({ embedding: client });
    expect(await sweep(CHANNEL, store)).toBe(1);

    // Not reported rather than reported as zero: "the provider did not say" and
    // "it was free" are different facts.
    expect(reported).toEqual([]);
    expect(embedded()).toEqual(["base-images"]);
  });

  it("embeds at most one pass's worth, in name order, in one call", async () => {
    const total = MAX_SKILLS_PER_EMBED_PASS + 2;
    for (let index = 0; index < total; index += 1) {
      skill(`playbook-${String(index).padStart(2, "0")}`, `Playbook number ${String(index)}.`);
    }
    const { client, calls, batches } = flat();

    const { sweep } = sweepWith({ embedding: client, now: clock() });
    expect(await sweep(CHANNEL, store)).toBe(MAX_SKILLS_PER_EMBED_PASS);

    // One provider call, not one per skill: `EmbeddingRequest` takes texts plural
    // for exactly this.
    expect(calls()).toBe(1);
    expect(batches()[0]).toHaveLength(MAX_SKILLS_PER_EMBED_PASS);
    expect(embedded()).toEqual(
      Array.from(
        { length: MAX_SKILLS_PER_EMBED_PASS },
        (_unused, index) => `playbook-${String(index).padStart(2, "0")}`
      )
    );

    // And the rest on the next pass, so a full library is worked through rather
    // than dropped.
    tick(SWEEP_INTERVAL_MS);
    expect(await sweep(CHANNEL, store)).toBe(2);
    expect(embedded()).toHaveLength(total);
  });

  it("does not run twice inside one interval", async () => {
    skill("base-images", CONTAINERS);
    const { client, calls } = flat();

    const { sweep } = sweepWith({ embedding: client, now: clock() });
    await sweep(CHANNEL, store);
    expect(calls()).toBe(1);

    skill("rotate-a-cert", CREDENTIALS);
    tick(SWEEP_INTERVAL_MS - 1);
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(calls()).toBe(1);

    tick(1);
    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(calls()).toBe(2);
  });

  // #335, and the placement is the assertion. The gate sits inside `embed()`,
  // after reconciliation, because the index is what the *next task* reads —
  // stopping it because the channel is over a token cap would degrade a reply
  // somebody is waiting on in order to save a call this pass was going to skip
  // anyway.
  it("still reconciles the index for a channel over its caps, and embeds nothing", async () => {
    skill("base-images", CONTAINERS);
    const { sweep, reported } = sweepWith({ maySpend: () => Promise.resolve(false) });

    expect(await sweep(CHANNEL, store)).toBe(0);

    // The vector was not bought…
    expect(embedded()).toEqual([]);
    expect(reported).toEqual([]);
    // …and the library is still indexed, which is the half that must survive.
    expect(store.listSkills("channel").map(entry => entry.name)).toEqual(["base-images"]);
  });

  it("does not ask about a budget when there is nothing to embed", async () => {
    // Everything above `embed()` is free, and a channel whose skills all carry
    // a current vector reaches no provider call — so there is nothing to ask
    // about and no round trip to pay for.
    skill("base-images", CONTAINERS);
    let asked = 0;
    const gate = (): Promise<boolean> => {
      asked += 1;
      return Promise.resolve(true);
    };

    const first = sweepWith({ maySpend: gate });
    expect(await first.sweep(CHANNEL, store)).toBe(1);
    expect(asked).toBe(1);

    // Second pass: reconciliation runs, nothing needs a vector, no question.
    tick(SWEEP_INTERVAL_MS);
    const second = sweepWith({ maySpend: gate });
    expect(await second.sweep(CHANNEL, store)).toBe(0);
    expect(asked).toBe(1);
  });

  it("does nothing at all, and asks nothing, with no embedding provider", async () => {
    skill("base-images", CONTAINERS);
    let asked = 0;
    const { lines, logger } = capturingLogger();

    const { sweep, reported } = sweepWith({
      embedding: null,
      settings: () => {
        asked += 1;
        return Promise.resolve({ enabled: true, maxSkills: MAX_SKILLS, sharedSkills: [] });
      },
      logger
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    // No sheet read, no reconciliation, no log line, and nothing to report. The
    // deployment behaves exactly as it did before this file existed.
    expect(asked).toBe(0);
    expect(store.listSkills("channel")).toEqual([]);
    expect(lines).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("does nothing for a channel whose sheet turns skills off", async () => {
    skill("base-images", CONTAINERS);
    const { client, calls } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      settings: () => Promise.resolve({ enabled: false, maxSkills: MAX_SKILLS, sharedSkills: [] })
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(calls()).toBe(0);
    // Not reconciled either: a channel that turned skills off should not acquire
    // an index of them.
    expect(store.listSkills("channel")).toEqual([]);
  });

  it("does nothing for a channel with no sheet, and nothing for a directory it cannot open", async () => {
    skill("base-images", CONTAINERS);

    expect(await sweepWith({ settings: () => Promise.resolve(null) }).sweep(CHANNEL, store)).toBe(0);
    expect(await sweepWith({ files: () => null }).sweep(CHANNEL, store)).toBe(0);
    expect(embedded()).toEqual([]);
  });

  it("stores nothing when the provider fails, and tries again on the next pass", async () => {
    skill("base-images", CONTAINERS);
    const { lines, logger } = capturingLogger();
    const failing: EmbeddingClient = {
      embed: () => Promise.reject(new Error("upstream is down"))
    };

    const { sweep } = sweepWith({ embedding: failing, logger, now: clock() });
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(embedded()).toEqual([]);
    expect(lines.map(line => line.event)).toContain("skill_embed_failed");
    // The reason code and never the message, which would carry the provider's
    // URL or the channel's own words into a log line.
    expect(lines.some(line => JSON.stringify(line).includes("upstream is down"))).toBe(false);

    // Nothing was marked, so the skill is still owed a vector.
    const { sweep: second } = sweepWith({ now: clock() });
    tick(SWEEP_INTERVAL_MS);
    expect(await second(CHANNEL, store)).toBe(1);
    expect(embedded()).toEqual(["base-images"]);
  });

  it("never rejects when the store cannot answer", async () => {
    skill("base-images", CONTAINERS);
    const { lines, logger } = capturingLogger();
    const broken = {
      ...store,
      skillsNeedingEmbedding: () => {
        throw new Error("database is locked");
      }
    } as unknown as MessageStore;

    expect(await sweepWith({ logger }).sweep(CHANNEL, broken)).toBe(0);
    expect(lines.map(line => line.event)).toContain("skill_embed_failed");
  });
});

// #436. The shared half earns a vector the same way, in the same batch, and on
// the channels whose own half is switched off as well — the team sheet promises
// a `retrieved` entry resolves either way, and this is the pass that keeps that
// promise on the vector leg.
describe("the shared half of the library", () => {
  /** The operator's act, from outside this process entirely. */
  function publish(name: string, description: string, body = "Say it plainly."): void {
    writeFileSync(
      join(sharedRoot, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-01-01\nstatus: active\n---\n\n${body}\n`
    );
  }

  const HOUSE_STYLE = "How this company writes its release notes.";

  /** The sweep's opener over the fixture's shared root. */
  const opener = () => createSharedSkillPoolOpener({ root: sharedRoot });

  /** A sheet naming these in `retrieved` mode. */
  const retrieved = (...names: string[]) =>
    names.map(name => ({ name, load: "retrieved" as const }));

  it("embeds a retrieved shared skill under its address", async () => {
    publish("brand-voice", HOUSE_STYLE);
    const { client, batches } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings: () =>
        Promise.resolve({
          enabled: true,
          maxSkills: MAX_SKILLS,
          sharedSkills: retrieved("brand-voice")
        })
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(embedded()).toEqual(["shared/brand-voice"]);
    expect(batches()).toEqual([[HOUSE_STYLE]]);
  });

  // One call for a mixed batch, which is what the batching already bought — and
  // the turn id hashes the addresses, so the two halves cannot collide on a stem.
  it("carries both halves in one provider call", async () => {
    skill("brand-voice", CONTAINERS);
    publish("brand-voice", HOUSE_STYLE);
    const { client, calls, batches } = flat();

    const { sweep, reported } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings: () =>
        Promise.resolve({
          enabled: true,
          maxSkills: MAX_SKILLS,
          sharedSkills: retrieved("brand-voice")
        })
    });

    expect(await sweep(CHANNEL, store)).toBe(2);
    expect(calls()).toBe(1);
    expect(batches()[0]).toHaveLength(2);
    expect(embedded().sort()).toEqual(["brand-voice", "shared/brand-voice"]);
    expect(reported[0]?.id).toMatch(/^skills-embed-[0-9a-f]{16}$/);
  });

  // The standing region's half is never indexed, so it is never embedded: a task
  // near its subject would otherwise pay for it twice in one prompt.
  it("never embeds an always entry", async () => {
    publish("brand-voice", HOUSE_STYLE);
    const { client, calls } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings: () =>
        Promise.resolve({
          enabled: true,
          maxSkills: MAX_SKILLS,
          sharedSkills: [{ name: "brand-voice", load: "always" as const }]
        })
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(calls()).toBe(0);
    expect(embedded()).toEqual([]);
  });

  it("runs for a channel whose own skills are switched off", async () => {
    publish("brand-voice", HOUSE_STYLE);
    let opened = 0;
    const { client } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      files: () => {
        opened += 1;
        return files;
      },
      settings: () =>
        Promise.resolve({
          enabled: false,
          maxSkills: MAX_SKILLS,
          sharedSkills: retrieved("brand-voice")
        })
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(embedded()).toEqual(["shared/brand-voice"]);
    // The switch still holds over the channel's own half: its directory is never
    // opened, so a channel that turned skills off does not acquire an index of
    // them by way of the shared pass.
    expect(opened).toBe(0);
    expect(store.listSkills("channel")).toEqual([]);
  });

  it("still does nothing for a switched-off channel that named none", async () => {
    skill("base-images", CONTAINERS);
    const { client, calls } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings: () =>
        Promise.resolve({ enabled: false, maxSkills: MAX_SKILLS, sharedSkills: [] })
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(calls()).toBe(0);
    expect(store.listSkills("channel")).toEqual([]);
  });

  // The stall the origin argument exists for: a full window of channel rows this
  // pass can no longer resolve would hold the batch against the shared skills the
  // sheet did name, on this pass and on every pass after it.
  it("reaches a shared skill a full window of unreachable rows would hold back", async () => {
    for (let index = 0; index < MAX_SKILLS_PER_EMBED_PASS; index += 1) {
      skill(`a${index}-runbook`, `When the ${index} thing breaks.`);
    }
    // Indexed directly, because the pass that would index them is the one this
    // case turns off: what the stall needs is a full window of rows already in
    // the index with no vector and no opener left to resolve them.
    reconcileSkillIndex({ files, store, maxSkills: MAX_SKILLS, at: AT, channel: CHANNEL });
    expect(store.skillsNeedingEmbedding(MAX_SKILLS_PER_EMBED_PASS)).toHaveLength(
      MAX_SKILLS_PER_EMBED_PASS
    );
    publish("brand-voice", HOUSE_STYLE);
    const { client } = flat();

    const { sweep } = sweepWith({
      embedding: client,
      sharedPool: opener(),
      now: () => AT + SWEEP_INTERVAL_MS,
      settings: () =>
        Promise.resolve({
          enabled: false,
          maxSkills: MAX_SKILLS,
          sharedSkills: retrieved("brand-voice")
        })
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(embedded()).toEqual(["shared/brand-voice"]);
  });

  // The acceptance's "a body edit re-embeds it" landed differently, on purpose:
  // the vector stands for the *description*, so a body edit re-indexes FTS5 and
  // costs no call — and the counters, which the clause is protecting, survive
  // either way. Re-embedding on a body edit would charge every channel that
  // named the skill for a vector identical to the one it replaced.
  it("re-indexes a shared body edit without a second embedding call", async () => {
    publish("brand-voice", HOUSE_STYLE, "Say it plainly.");
    const { client, calls } = flat();
    const settings = () =>
      Promise.resolve({
        enabled: true,
        maxSkills: MAX_SKILLS,
        sharedSkills: retrieved("brand-voice")
      });

    await sweepWith({ embedding: client, sharedPool: opener(), settings }).sweep(CHANNEL, store);
    expect(calls()).toBe(1);

    publish("brand-voice", HOUSE_STYLE, "Say it plainly, and once.");
    await sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings,
      now: () => AT + SWEEP_INTERVAL_MS
    }).sweep(CHANNEL, store);

    expect(calls()).toBe(1);
    expect(embedded()).toEqual(["shared/brand-voice"]);
    expect(store.searchSkills("plainly and once", 5)).toEqual(["shared/brand-voice"]);
  });

  it("re-embeds when the operator rewrites the description", async () => {
    publish("brand-voice", CREDENTIALS);
    const { client, calls } = flat();
    const settings = () =>
      Promise.resolve({
        enabled: true,
        maxSkills: MAX_SKILLS,
        sharedSkills: retrieved("brand-voice")
      });

    await sweepWith({ embedding: client, sharedPool: opener(), settings }).sweep(CHANNEL, store);

    publish("brand-voice", CREDENTIALS_REWRITTEN);
    await sweepWith({
      embedding: client,
      sharedPool: opener(),
      settings,
      now: () => AT + SWEEP_INTERVAL_MS
    }).sweep(CHANNEL, store);

    expect(calls()).toBe(2);
  });
});
