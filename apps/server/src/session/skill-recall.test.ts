// Skill retrieval, against a real store and a real directory.
//
// Both halves are opened for real rather than faked, for `recall.test.ts`'s
// reason and one more of this file's own. Recall's is that the part worth
// testing lives in SQL. This file's is that **the whole feature is the seam**:
// files on disk, an index that follows them, and a fusion over two queries into
// that index. A fake `SkillFiles` or a fake `MessageStore` would leave every
// interesting claim here — a hand-edit re-indexing, an archived skill having no
// vector to find — asserted against the fake rather than against the mechanism.
//
// The embedding provider is not here at all. Since #292 the vector arrives as an
// argument, so what these cases supply is a point out of the same hand-built
// space the skills were embedded with — see `EMBEDDINGS`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, SkillFiles } from "@getlibero/memory";
import { openMessageStore, openSkillFiles } from "@getlibero/memory";
import { SKILLS_MAX_CHARS, createSkillRecall, interleaveCandidates } from "./skill-recall.js";
import type { SkillRecallRequest } from "./skill-recall.js";

const CHANNEL = "C0ENGINEERING";
const MAX_SKILLS = 100;
const MAX_SKILL_CHARS = 8_192;
const AT = 1_700_000_000_000;

let root: string;
let store: MessageStore;
let files: SkillFiles;

/**
 * A hand-built embedding space, on `recall.test.ts`'s pattern.
 *
 * The paired phrases in each cluster sit together and **share not one token with
 * each other**, which is what lets the vector cases below be real tests of
 * vector retrieval: the lexical leg is run beside each one and finds nothing.
 *
 * "Not one token" is stricter than `recall.test.ts` needs, and #292 is why.
 * `searchSkills` ORs its terms rather than AND-ing them, so a single shared
 * `a` or `is` is a lexical hit — which makes any phrase pair sharing a stop word
 * useless as a control here. Every string below was chosen against that.
 */
const EMBEDDINGS: Record<string, number[]> = {
  // Cluster one: rolling client credentials, said two different ways.
  "how do we roll a new key for a channel": [1, 0, 0],
  "Swapping client credentials before they expire.": [0.98, 0.02, 0],
  // Cluster two: something else entirely.
  "container base images": [0, 1, 0],
  "When somebody asks which base image the containers use.": [0, 0.98, 0.02],
  // Cluster three, far from both.
  unrelated: [0, 0, 1]
};

function vectorFor(text: string): Float32Array {
  const point = EMBEDDINGS[text];
  if (point === undefined) throw new Error(`the fixture has no embedding for: ${text}`);
  return Float32Array.from(point);
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/**
 * Writes a skill file the way a team member with an editor would.
 *
 * Through `apply` rather than `writeFileSync` where the frontmatter is ordinary,
 * so the fixture goes down the same checked path the author turn will — and by
 * hand where a case needs a `status` no operation can set.
 */
function skill(name: string, description: string, body = "Step one. Step two."): void {
  const result = files.apply({ op: "skill_create", name, description, body });
  if (result.outcome !== "written") {
    throw new Error(`the fixture could not write ${name}: ${result.reason}`);
  }
}

/** The same, written straight to disk, for the frontmatter an operation cannot produce. */
function handWritten(name: string, frontmatter: string, body: string): void {
  mkdirSync(join(root, CHANNEL, "skills"), { recursive: true });
  writeFileSync(join(root, CHANNEL, "skills", `${name}.md`), `---\n${frontmatter}---\n\n${body}\n`);
}

/**
 * Gives a skill a vector, which is what reconciliation deliberately does not do.
 *
 * `reconcileSkillIndex` embeds nothing — `packages/memory` has no model provider
 * — so it leaves rows for `skillsNeedingEmbedding` to surface. In production that
 * is `./skill-embed.ts`'s job since #305; here it stays a fixture, because what
 * these cases are about is what retrieval does with a vector rather than where
 * one came from, and going through the pass would put a fake embedding provider
 * between every case and the thing it asserts.
 */
function embed(name: string, description: string): void {
  store.putEmbedding({
    source: { kind: "skill", ref: name },
    vector: vectorFor(description),
    model: "test-embedding-model",
    at: AT
  });
}

function retrieverWith(overrides: { logger?: Logger; now?: () => number } = {}) {
  return createSkillRecall({ now: () => AT, ...overrides });
}

/**
 * What the index observed, read past the store's own API.
 *
 * `listSkills` deliberately answers metadata and not the use columns, so there
 * is no public read for this — and #290's own suite says why a second raw
 * connection is the right answer rather than a new method: the columns are the
 * mechanism, and asserting through a surface that does not expose them would
 * assert nothing. A read-only connection, so nothing here can move a counter it
 * is checking.
 */
function usesOf(name: string): { uses: number; last_used_at: number | null } | undefined {
  const db = new DatabaseSync(join(root, CHANNEL, "store.db"), { readOnly: true });
  try {
    return db.prepare("SELECT uses, last_used_at FROM skill_use WHERE name = ?").get(name) as
      | { uses: number; last_used_at: number | null }
      | undefined;
  } finally {
    db.close();
  }
}

/** A question, already embedded, with the sheet's three numbers at their defaults. */
function ask(query: string, partial: Partial<SkillRecallRequest> = {}): SkillRecallRequest {
  return {
    channel: CHANNEL,
    store,
    files,
    vector: query in EMBEDDINGS ? vectorFor(query) : null,
    query,
    topK: 3,
    maxSkillChars: MAX_SKILL_CHARS,
    maxSkills: MAX_SKILLS,
    ...partial
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-skill-recall-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS, now: () => AT });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("interleaveCandidates", () => {
  it("alternates the two lists, vector first", () => {
    expect(interleaveCandidates(["a", "b"], ["c", "d"], 4)).toEqual(["a", "c", "b", "d"]);
  });

  it("keeps a name found by both at its better position", () => {
    expect(interleaveCandidates(["a", "b"], ["b", "c"], 4)).toEqual(["a", "b", "c"]);
  });

  it("stops at the limit", () => {
    expect(interleaveCandidates(["a", "b", "c"], ["d", "e", "f"], 3)).toEqual(["a", "d", "b"]);
  });

  it("runs one list alone when the other is empty", () => {
    expect(interleaveCandidates([], ["a", "b"], 3)).toEqual(["a", "b"]);
    expect(interleaveCandidates(["a", "b"], [], 3)).toEqual(["a", "b"]);
  });

  it("answers nothing when both are empty", () => {
    expect(interleaveCandidates([], [], 3)).toEqual([]);
  });

  it("keeps taking from the longer list once the shorter runs out", () => {
    expect(interleaveCandidates(["a", "b", "c"], ["d"], 4)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("createSkillRecall", () => {
  // **#292's acceptance criterion, first half.** A task on a subject with a
  // matching skill gets it — here through the vector leg alone, against a query
  // that shares no word with the skill's description.
  it("loads a skill that shares no stem with the question", async () => {
    skill("rotate-a-certificate", "Swapping client credentials before they expire.");
    const retrieve = retrieverWith();
    // Reconcile once so the vector has a row to hang off.
    await retrieve(ask("unrelated"));
    embed("rotate-a-certificate", "Swapping client credentials before they expire.");

    const query = "how do we roll a new key for a channel";
    // The control: the lexical leg cannot answer this. Not one word of the query
    // appears in the skill, so there is nothing for FTS5 to match.
    expect(store.searchSkills(query, 3)).toEqual([]);

    const loaded = await retrieve(ask(query));

    expect(loaded.map(entry => entry.name)).toEqual(["rotate-a-certificate"]);
    expect(loaded[0]?.body).toContain("Step one.");
  });

  // **The second half**, and it has to be stated carefully, because there is no
  // distance cutoff on this path any more than on recall's — a channel holding
  // one skill with a vector contributes it to every embedded question, relevant
  // or not, and that is recall.ts's recorded decision rather than an oversight
  // here. So what "an unrelated task does not get it" means is: nothing matched
  // *lexically*, and there was no vector to fall back on. A deployment with
  // embeddings gets the weak hit, bounded by `top_k` and the character ceiling.
  it("loads nothing for an unrelated question with no vector to fall back on", async () => {
    skill("rotate-a-certificate", "Swapping client credentials before they expire.");
    const retrieve = retrieverWith();
    await retrieve(ask("unrelated"));

    // The control: the lexical leg finds nothing for this question.
    expect(store.searchSkills("bikeshed colour preferences", 3)).toEqual([]);

    // `ask` supplies a null vector for a phrase the fixture has no point for,
    // which is what a deployment with no embedding provider looks like.
    const loaded = await retrieve(ask("bikeshed colour preferences"));

    expect(loaded).toEqual([]);
  });

  // The other side of the same coin, asserted so the absence of a cutoff is a
  // decision somebody changed on purpose rather than discovered.
  it("applies no distance cutoff, so an embedded question reaches the only skill there is", async () => {
    skill("rotate-a-certificate", "Swapping client credentials before they expire.");
    const retrieve = retrieverWith();
    await retrieve(ask("unrelated"));
    embed("rotate-a-certificate", "Swapping client credentials before they expire.");

    // `unrelated` sits on the third axis, far from the skill's cluster, and no
    // word of it appears in the description — so this hit is the vector leg
    // answering with whatever is nearest.
    expect(store.searchSkills("unrelated", 3)).toEqual([]);

    const loaded = await retrieve(ask("unrelated"));

    expect(loaded.map(entry => entry.name)).toEqual(["rotate-a-certificate"]);
  });

  it("loads nothing for a channel with no skills at all", async () => {
    expect(await retrieverWith()(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  // The team sheet's number, and the count the block is bounded by first.
  it("loads at most top_k skills", async () => {
    for (let i = 0; i < 6; i += 1) {
      skill(`deploy-step-${String(i)}`, "How the deploy is done, end to end.");
    }

    const loaded = await retrieverWith()(ask("how is the deploy done", { topK: 2 }));

    expect(loaded).toHaveLength(2);
  });

  // The schema says this is a behaviour rather than a setting: a skill has an
  // FTS5 index over its description and body, so it retrieves without a vector.
  // **`recall.test.ts` asserts the opposite for the same input**, which is the
  // asymmetry both headers name.
  it("retrieves on full text alone when there is no vector", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");

    const loaded = await retrieverWith()(ask("how is a release cut", { vector: null }));

    expect(loaded.map(entry => entry.name)).toEqual(["cut-a-release"]);
  });

  // **The known weakness, pinned so it cannot change quietly.** `searchSkills`
  // ORs its terms, so a question sharing one ordinary word with a skill produces
  // a hit — and `store-db.ts` records why the obvious bm25 rank floor was tried
  // and rejected. This is the same shape as recall's absent distance cutoff, and
  // what bounds it is `top_k` and the character ceiling rather than a threshold.
  it("loads a weak lexical match, which is what having no cutoff means", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");

    // "is" and nothing else. Whether that is worth loading is precisely what no
    // number in this tree can currently answer.
    const loaded = await retrieverWith()(ask("is the bikeshed green"));

    expect(loaded.map(entry => entry.name)).toEqual(["cut-a-release"]);
  });

  it("carries each skill's name, description and body", async () => {
    skill("cut-a-release", "How a release is cut and tagged.", "1. Tag.\n2. Watch the workflow.");

    const loaded = await retrieverWith()(ask("how is a release cut"));

    expect(loaded[0]).toEqual({
      name: "cut-a-release",
      description: "How a release is cut and tagged.",
      body: "1. Tag.\n2. Watch the workflow."
    });
  });
});

describe("what reconciliation does for retrieval", () => {
  // The roadmap's definition of done: the files are the source of truth. This is
  // the whole of how a hand edit takes effect — there is no watcher and no
  // second path.
  it("picks up a skill added by hand between two tasks", async () => {
    const retrieve = retrieverWith();
    expect(await retrieve(ask("how is a release cut"))).toEqual([]);

    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      "1. Tag.\n2. Watch the workflow."
    );

    const loaded = await retrieve(ask("how is a release cut"));
    expect(loaded.map(entry => entry.name)).toEqual(["cut-a-release"]);
  });

  it("picks up a hand edit to a skill's body", async () => {
    skill("cut-a-release", "How a release is cut and tagged.", "1. Tag.");
    const retrieve = retrieverWith();
    expect((await retrieve(ask("how is a release cut")))[0]?.body).toBe("1. Tag.");

    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      "1. Tag.\n2. Then watch the workflow."
    );

    expect((await retrieve(ask("how is a release cut")))[0]?.body).toContain("watch the workflow");
  });

  // The other half of the same criterion: one the team deletes is gone.
  it("drops a skill the team deleted", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const retrieve = retrieverWith();
    expect(await retrieve(ask("how is a release cut"))).toHaveLength(1);

    rmSync(join(root, CHANNEL, "skills", "cut-a-release.md"));

    expect(await retrieve(ask("how is a release cut"))).toEqual([]);
  });

  // A candidate can be nominated by an index that was current a moment ago and
  // then vanish. The index holds no text a caller reads, by #290's decision,
  // precisely so this degrades to a skip rather than to a stale body reaching a
  // model.
  it("skips a candidate the index still claims but the directory no longer has", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    skill("roll-back-a-release", "How a release is cut back out again.");

    const retrieve = retrieverWith();
    // The positive control: both are reachable while both files are there.
    expect(await retrieve(ask("how is a release cut"))).toHaveLength(2);

    // The race, staged rather than described: a directory that still *reports*
    // the file to reconciliation but cannot hand it over when the candidate is
    // resolved. That is the window between the index being written and the file
    // being opened, and the real deletion below cannot produce it, because
    // reconciliation would drop the row first.
    const vanishing: SkillFiles = {
      list: () => files.list(),
      fingerprints: () => files.fingerprints(),
      read: name => (name === "cut-a-release" ? null : files.read(name)),
      apply: op => files.apply(op)
    };

    const loaded = await retrieve(ask("how is a release cut", { files: vanishing }));

    expect(loaded.map(entry => entry.name)).toEqual(["roll-back-a-release"]);
    // And nothing recorded a use for a skill that never reached a model.
    expect(usesOf("cut-a-release")?.uses).toBe(1);
  });
});

describe("what never loads", () => {
  // **Excluded structurally on both legs, which is why this asserts the property
  // rather than a filter.** `searchSkills` carries its own `status != 'archived'`
  // clause inside the FTS5 match, and `reconcileSkills` drops the vector of a
  // skill it sees archived, so `nearest` has nothing to answer with.
  it("never loads an archived skill, on either leg", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const retrieve = retrieverWith();

    // **Two positive controls, one per leg**, because "the attack failed" reads
    // the same as "nothing was ever reachable". The lexical leg first:
    expect(await retrieve(ask("how is a release cut"))).toHaveLength(1);

    // Then the vector leg, given a point in a cluster whose words appear nowhere
    // in the skill — so this hit can only have come from the vector.
    embed("cut-a-release", "When somebody asks which base image the containers use.");
    expect(store.searchSkills("container base images", 3)).toEqual([]);
    expect(await retrieve(ask("container base images"))).toHaveLength(1);

    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: archived\n',
      "1. Tag."
    );

    // The vector leg goes quiet because reconciliation dropped the vector; the
    // lexical leg goes quiet because `searchSkills` excludes archived rows
    // inside its own match. Neither is a filter in `skill-recall.ts`.
    expect(await retrieve(ask("container base images"))).toEqual([]);
    expect(await retrieve(ask("how is a release cut"))).toEqual([]);
  });

  // `stale` is left exactly alone until #294 says what it means. The test exists
  // so that changing it is a deliberate act rather than a silent one.
  it("still loads a stale skill, because what stale means to retrieval is #294's", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const retrieve = retrieverWith();
    await retrieve(ask("how is a release cut"));

    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: stale\n',
      "1. Tag."
    );

    expect(await retrieve(ask("how is a release cut"))).toHaveLength(1);
  });

  // The channel's own per-skill cap, which `packages/memory` declined to take on
  // the grounds that refusing an over-cap file is the indexer's outcome to name.
  it("never loads a skill whose body is past max_skill_chars", async () => {
    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      "x".repeat(600)
    );
    const { lines, logger } = capturingLogger();

    const loaded = await retrieverWith({ logger })(
      ask("how is a release cut", { maxSkillChars: 500 })
    );

    expect(loaded).toEqual([]);
    expect(lines.map(line => line.event)).toContain("skill_oversize");
  });

  // `continue` rather than `break`: one file being too long says nothing about
  // what comes after it in the ranking.
  it("keeps going past an over-cap skill to the next candidate", async () => {
    handWritten(
      "cut-a-release",
      'name: cut-a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      "x".repeat(600)
    );
    handWritten(
      "roll-back-a-release",
      'name: roll-back-a-release\ndescription: How a release is cut back out again.\ncreated: 2026-08-01\nstatus: active\n',
      "short enough"
    );

    const loaded = await retrieverWith()(ask("how is a release cut", { maxSkillChars: 500 }));

    expect(loaded.map(entry => entry.name)).toEqual(["roll-back-a-release"]);
  });

  // Dropped from the least similar end, unlike the transcript's bound which
  // drops the oldest: here the ordering is relevance and not time.
  it("stops at SKILLS_MAX_CHARS, keeping the nearest", async () => {
    const long = "x".repeat(SKILLS_MAX_CHARS - 200);
    handWritten(
      "a-release",
      'name: a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      long
    );
    handWritten(
      "b-release",
      'name: b-release\ndescription: How a release is cut and tagged as well.\ncreated: 2026-08-01\nstatus: active\n',
      "y".repeat(500)
    );

    const loaded = await retrieverWith()(
      ask("how is a release cut", { maxSkillChars: SKILLS_MAX_CHARS })
    );

    expect(loaded.map(entry => entry.name)).toEqual(["a-release"]);
  });
});

describe("what retrieval records", () => {
  // **The signal #294's clocks run on.** A use has to mean "this skill reached a
  // model", or the lifecycle is measuring the ranker rather than the library.
  it("records a use for the skill it loaded, stamped with the pass's own instant", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const at = 1_700_000_999_000;

    const loaded = await createSkillRecall({ now: () => at })(ask("how is a release cut"));

    expect(loaded).toHaveLength(1);
    expect(usesOf("cut-a-release")).toEqual({ uses: 1, last_used_at: at });
  });

  it("counts one use per task, not one per lifetime", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const retrieve = retrieverWith();

    await retrieve(ask("how is a release cut"));
    await retrieve(ask("how is a release cut"));
    await retrieve(ask("how is a release cut"));

    expect(usesOf("cut-a-release")?.uses).toBe(3);
  });

  // Recorded for what loaded, not for what was nominated — otherwise the clocks
  // #294 will run measure the ranker rather than the library.
  it("records nothing for a skill that was reconciled but never loaded", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");

    const loaded = await retrieverWith()(ask("bikeshed colour preferences"));

    expect(loaded).toEqual([]);
    // Reconciliation still ran, so the row exists — with nothing observed on it.
    expect(usesOf("cut-a-release")).toEqual({ uses: 0, last_used_at: null });
  });

  // The aggregate bound sheds the least similar, and what it sheds must not be
  // recorded as having reached a model.
  it("records nothing for a candidate the character bound cut", async () => {
    handWritten(
      "a-release",
      'name: a-release\ndescription: How a release is cut and tagged.\ncreated: 2026-08-01\nstatus: active\n',
      "x".repeat(SKILLS_MAX_CHARS - 200)
    );
    handWritten(
      "b-release",
      'name: b-release\ndescription: How a release is cut and tagged as well.\ncreated: 2026-08-01\nstatus: active\n',
      "y".repeat(500)
    );

    await retrieverWith()(ask("how is a release cut", { maxSkillChars: SKILLS_MAX_CHARS }));

    expect(usesOf("a-release")?.uses).toBe(1);
    expect(usesOf("b-release")?.uses).toBe(0);
  });

  it("logs a count and never the playbooks themselves", async () => {
    skill("cut-a-release", "How a release is cut and tagged.", "run ./scripts/tag.sh --force");
    const { lines, logger } = capturingLogger();

    await retrieverWith({ logger })(ask("how is a release cut"));

    const loaded = lines.find(line => line.event === "skills_loaded");
    expect(loaded?.totalTokens).toBe(1);
    expect(JSON.stringify(lines)).not.toContain("tag.sh");
  });
});

describe("what a failure costs", () => {
  // A skill is an improvement to an answer, not a precondition for one.
  it("answers nothing rather than throwing when the directory cannot be read", async () => {
    const { lines, logger } = capturingLogger();
    const broken: SkillFiles = {
      list: () => [],
      fingerprints: () => {
        throw new Error("EACCES");
      },
      read: () => null,
      apply: () => ({ outcome: "failed", reason: "malformed_arguments" })
    };

    await expect(
      retrieverWith({ logger })(ask("how is a release cut", { files: broken }))
    ).resolves.toEqual([]);
    expect(lines.map(line => line.event)).toContain("skill_reconcile_failed");
  });

  it("answers nothing rather than throwing when the store cannot answer", async () => {
    skill("cut-a-release", "How a release is cut and tagged.");
    const { lines, logger } = capturingLogger();
    const broken = {
      ...store,
      searchSkills: () => {
        throw new Error("database is locked");
      }
    } as unknown as MessageStore;

    await expect(
      retrieverWith({ logger })(ask("how is a release cut", { store: broken }))
    ).resolves.toEqual([]);
    expect(lines.map(line => line.event)).toContain("skill_recall_failed");
  });

  // Two words rather than one, because the fixes differ: a directory this
  // process cannot read is a mount or a permission, a store that cannot answer
  // is a database.
  it("names the two failures differently", async () => {
    const { lines, logger } = capturingLogger();
    const broken: SkillFiles = {
      list: () => [],
      fingerprints: () => {
        throw new Error("EACCES");
      },
      read: () => null,
      apply: () => ({ outcome: "failed", reason: "malformed_arguments" })
    };

    await retrieverWith({ logger })(ask("how is a release cut", { files: broken }));

    expect(lines.map(line => line.event)).not.toContain("skill_recall_failed");
  });
});
