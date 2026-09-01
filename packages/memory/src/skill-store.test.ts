// Reconciliation, against a real directory and a real store.
//
// Both halves are opened for real rather than faked, for `summarize.test.ts`'s
// reason: what this module does is almost entirely expressed in the two things
// it composes — a `stat` comparison on one side and SQL on the other — and a
// fake of either would let both sides agree with each other and with nothing.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { openSkillFiles } from "./skill-file.js";
import type { SkillFiles } from "./skill-file.js";
import { openSharedSkillFiles } from "./shared-skill-file.js";
import type { SharedSkillFiles } from "./shared-skill-file.js";
import { reconcileSharedSkillIndex, reconcileSkillIndex } from "./skill-store.js";
import { openMessageStore } from "./store-db.js";
import type { MessageStore } from "./store-db.js";

const CHANNEL = "C0ENGINEERING";
const MAX_SKILLS = 8;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let root: string;
let file: string;
let directory: string;
let files: SkillFiles;
let store: MessageStore;

const reconcile = (maxSkills = MAX_SKILLS, at = NOW) =>
  reconcileSkillIndex({ files, store, maxSkills, at, channel: CHANNEL });

const create = (name: string, description = "When the thing breaks.", body = "Do the thing.") =>
  files.apply({ op: "skill_create", name, description, body });

const skillText = (name: string, over: Record<string, string> = {}, body = "Do the thing."): string => {
  const front = {
    name,
    description: "When the thing breaks.",
    created: "2026-01-01",
    status: "active",
    ...over
  };
  return `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\n${body}\n`;
};

/** Writes behind the store's back. The team's text editor. */
const handWrite = (name: string, text: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), text, "utf8");
};

/** Reads past the module's API, the way the rest of this package's tests do. */
const raw = <T>(query: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
};

const sources = (): Array<{ source_kind: string; source_ref: string }> =>
  raw(db =>
    db
      .prepare("SELECT source_kind, source_ref FROM embedding_source ORDER BY source_ref")
      .all()
  ) as Array<{ source_kind: string; source_ref: string }>;

const uses = (name: string): { uses: number; first_seen_at: number } | undefined =>
  raw(db => db.prepare("SELECT uses, first_seen_at FROM skill_use WHERE name = ?").get(name)) as
    | { uses: number; first_seen_at: number }
    | undefined;

/** Gives a skill a vector, so invalidation has something to take away. */
const embed = (name: string, vector: number[]): void => {
  store.putEmbedding({
    source: { kind: "skill", ref: name },
    vector: Float32Array.from(vector),
    model: "test-embedding-model",
    at: NOW
  });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-skill-index-"));
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  directory = join(root, CHANNEL, "skills");
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS, now: () => NOW });
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the index follows the directory", () => {
  it("indexes a skill written through the store", () => {
    create("rotate-a-cert");

    expect(reconcile()).toEqual({ indexed: 1, dropped: 0, invalidated: 0 });
    expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["rotate-a-cert"]);
  });

  // #290's acceptance in one line: the file is the source of truth, so a skill
  // nobody wrote through the store joins the index the same way one that was
  // does.
  it("indexes a skill a person added by hand", () => {
    handWrite("hand-written", skillText("hand-written"));

    expect(reconcile()).toMatchObject({ indexed: 1 });
    expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["hand-written"]);
  });

  it("drops a skill a person deleted, and its vector with it", () => {
    create("rotate-a-cert");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);
    expect(sources()).toHaveLength(1);

    unlinkSync(join(directory, "rotate-a-cert.md"));

    expect(reconcile()).toMatchObject({ dropped: 1 });
    expect(store.listSkills("channel")).toEqual([]);
    // Through a second connection rather than the interface: the trigger is the
    // mechanism, and asserting it through `listSkills` would assert nothing.
    expect(sources()).toEqual([]);
  });

  it("does nothing at all when nothing changed", () => {
    create("rotate-a-cert");
    reconcile();

    expect(reconcile()).toEqual({ indexed: 0, dropped: 0, invalidated: 0 });
  });

  it("re-indexes a hand-edited skill", () => {
    create("rotate-a-cert", "before", "original body");
    reconcile();

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { description: "after" }, "new body"));

    expect(reconcile()).toMatchObject({ indexed: 1 });
    expect(store.searchSkills("after", 5)).toEqual(["rotate-a-cert"]);
    expect(store.searchSkills("before", 5)).toEqual([]);
  });

  // The case `(mtime, size)` alone would miss, and the whole reason `ino` is in
  // the fingerprint: a write through the store lands by rename, so the inode
  // moves even when neither the length nor the millisecond did.
  it("re-indexes a store write of identical length at an identical timestamp", () => {
    create("rotate-a-cert", "aaaa", "body");
    reconcile();

    const path = join(directory, "rotate-a-cert.md");
    const before = raw(db =>
      db.prepare("SELECT mtime_ms, size FROM skill WHERE name = ?").get("rotate-a-cert")
    ) as { mtime_ms: number; size: number };

    // Same lengths on both fields, so the file's size cannot change; then the
    // timestamp is forced back to what it was, so neither can mtime.
    files.apply({
      op: "skill_revise",
      name: "rotate-a-cert",
      description: "bbbb",
      body: "body"
    });
    const seconds = before.mtime_ms / 1000;
    utimesSync(path, seconds, seconds);

    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtime_ms);

    expect(reconcile()).toMatchObject({ indexed: 1 });
    expect(store.searchSkills("bbbb", 5)).toEqual(["rotate-a-cert"]);
  });

  // The ordinary hand edit, which moves mtime and usually size. It is caught by
  // those two rather than by the inode: `writeFileSync` rewrites in place, so an
  // editor's save keeps the file it had.
  it("re-indexes a hand edit that keeps the same inode", () => {
    create("rotate-a-cert", "before", "body");
    reconcile();
    const path = join(directory, "rotate-a-cert.md");
    const before = statSync(path).ino;

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { description: "after" }, "body"));

    expect(statSync(path).ino).toBe(before);
    expect(reconcile()).toMatchObject({ indexed: 1 });
    expect(store.searchSkills("after", 5)).toEqual(["rotate-a-cert"]);
  });

  // A half-saved edit must not erase what the index observed about a skill.
  it("keeps the last good row for a file that stops parsing", () => {
    create("rotate-a-cert", "findable", "body");
    reconcile();
    store.recordSkillUse(["rotate-a-cert"], NOW);

    handWrite("rotate-a-cert", "no frontmatter at all");

    expect(reconcile()).toEqual({ indexed: 0, dropped: 0, invalidated: 0 });
    expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["rotate-a-cert"]);
    expect(store.searchSkills("findable", 5)).toEqual(["rotate-a-cert"]);
    expect(uses("rotate-a-cert")?.uses).toBe(1);
  });

  it("indexes a file whose frontmatter names a different skill not at all", () => {
    handWrite("deploy", skillText("rollback"));

    expect(reconcile()).toEqual({ indexed: 0, dropped: 0, invalidated: 0 });
    expect(store.listSkills("channel")).toEqual([]);
  });

  // Deterministic rather than directory order, and the rest are left on disk
  // untouched: a team that over-filled the directory loses some retrieval, not
  // all of it.
  it("takes the first max_skills by name and leaves the rest alone", () => {
    for (const name of ["e", "d", "c", "b", "a"]) create(name);

    expect(reconcile(3)).toMatchObject({ indexed: 3 });
    expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["a", "b", "c"]);
    expect(readdirSync(directory).sort()).toHaveLength(5);
  });
});

describe("what a re-index costs", () => {
  it("invalidates the vector when the description changed", () => {
    create("rotate-a-cert", "before", "body");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { description: "after" }, "body"));

    expect(reconcile()).toMatchObject({ indexed: 1, invalidated: 1 });
    expect(sources()).toEqual([]);
    expect(store.skillsNeedingEmbedding(10)).toEqual(["rotate-a-cert"]);
  });

  // Only the description is embedded, so a body edit re-indexes for free.
  it("keeps the vector when only the body changed", () => {
    create("rotate-a-cert", "unchanged", "original body");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { description: "unchanged" }, "new body"));

    expect(reconcile()).toMatchObject({ indexed: 1, invalidated: 0 });
    expect(sources()).toEqual([{ source_kind: "skill", source_ref: "rotate-a-cert" }]);
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);
    // And the new body is searchable, so the row really was rewritten.
    expect(store.searchSkills("new", 5)).toEqual(["rotate-a-cert"]);
  });

  // The case this column exists for: a lifecycle job rewriting `status` weekly
  // must not cost an embedding call for text that did not change.
  it("keeps the vector when only the status changed", () => {
    create("rotate-a-cert", "unchanged", "body");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    handWrite(
      "rotate-a-cert",
      skillText("rotate-a-cert", { description: "unchanged", status: "stale" }, "body")
    );

    expect(reconcile()).toMatchObject({ indexed: 1, invalidated: 0 });
    expect(sources()).toHaveLength(1);
  });

  // Archived is out of retrieval entirely, and dropping the vector is what makes
  // that exact on the `nearest` side rather than best-effort.
  it("invalidates the vector when a skill is archived", () => {
    create("rotate-a-cert", "unchanged", "body");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    handWrite(
      "rotate-a-cert",
      skillText("rotate-a-cert", { description: "unchanged", status: "archived" }, "body")
    );

    expect(reconcile()).toMatchObject({ invalidated: 1 });
    expect(sources()).toEqual([]);
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);
  });

  // The rule `SkillFrontmatter` states: observations are about the skill, not
  // about its current wording.
  it("does not reset the use counters on a re-index", () => {
    create("rotate-a-cert", "before", "body");
    reconcile(MAX_SKILLS, 1_000);
    store.recordSkillUse(["rotate-a-cert"], 2_000);
    store.recordSkillUse(["rotate-a-cert"], 3_000);

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { description: "after" }));
    reconcile(MAX_SKILLS, 9_000);

    expect(uses("rotate-a-cert")).toEqual({ uses: 2, first_seen_at: 1_000 });
  });

  // A rename is a delete and an add to everything here, so the clocks start
  // over. Stated rather than discovered, because #294 reads them.
  it("resets the observations when a skill is renamed", () => {
    create("deploy");
    reconcile(MAX_SKILLS, 1_000);
    store.recordSkillUse(["deploy"], 2_000);

    handWrite("rollback", skillText("rollback"));
    unlinkSync(join(directory, "deploy.md"));
    reconcile(MAX_SKILLS, 9_000);

    expect(uses("deploy")).toBeUndefined();
    expect(uses("rollback")).toEqual({ uses: 0, first_seen_at: 9_000 });
  });
});

describe("searching skills", () => {
  it("matches the description and the body alike", () => {
    create("rotate-a-cert", "when a certificate is expiring", "run dev-certs.sh --rotate");
    create("deploy", "when shipping to staging", "run the deploy script");
    reconcile();

    expect(store.searchSkills("certificate", 5)).toEqual(["rotate-a-cert"]);
    expect(store.searchSkills("dev-certs.sh", 5)).toEqual(["rotate-a-cert"]);
    expect(store.searchSkills("staging", 5)).toEqual(["deploy"]);
  });

  // The filter is in the query and not left to a caller, because there are two
  // retrieval paths and a rule applied by callers is a rule forgotten in one.
  it("never answers with an archived skill", () => {
    create("rotate-a-cert", "when a certificate is expiring", "body");
    reconcile();
    expect(store.searchSkills("certificate", 5)).toEqual(["rotate-a-cert"]);

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { status: "archived" }, "body"));
    reconcile();

    expect(store.searchSkills("certificate", 5)).toEqual([]);
  });

  it("answers nothing for a query with no terms in it", () => {
    create("rotate-a-cert");
    reconcile();

    expect(store.searchSkills("   ", 5)).toEqual([]);
  });

  it("answers names and never text", () => {
    create("rotate-a-cert", "when a certificate is expiring", "secret body");
    reconcile();

    expect(store.searchSkills("certificate", 5)).toEqual(["rotate-a-cert"]);
    expect(JSON.stringify(store.searchSkills("certificate", 5))).not.toContain("secret");
  });

  // **The difference from `search`, and the case #292 exists against.** What
  // reaches this is a whole question somebody asked in Slack, not words a person
  // chose — so the terms are OR-ed. Under `search`'s implicit AND this answers
  // nothing, always, because no playbook contains every word of a sentence.
  it("matches a whole question, not only a query every term of which appears", () => {
    create("rotate-a-cert", "when a certificate is expiring", "run dev-certs.sh --rotate");
    reconcile();

    expect(store.searchSkills("how do we rotate an expiring certificate?", 5)).toEqual([
      "rotate-a-cert"
    ]);
    // **The control, and #522 moved it.** The message index used to answer this
    // question with nothing at all — it ANDs, and no message holds every word
    // of a sentence — which is what made the paragraph above a difference
    // rather than a restatement. That was measured as a real failure and
    // `search` now widens to OR when the AND finds nothing, for exactly the
    // reason this one never ANDed at all.
    //
    // So what is left of the difference is the *order*: `search` asks
    // conjunctively first and a hit there shuts the wider set out, where this
    // ORs outright and lets bm25 decide. The case below is that difference.
    store.append({
      ts: "1.1",
      threadTs: null,
      userId: "U0ALICE",
      displayName: null,
      text: "when a certificate is expiring",
      at: 1
    });
    expect(store.search("how do we rotate an expiring certificate?", 5).map(hit => hit.ts)).toEqual(
      ["1.1"]
    );
  });

  it("ORs where the message index would first try to AND", () => {
    // Two skills and one message, all mentioning certificates. Given a query
    // every word of which one message holds, `search` answers that message and
    // stops; `searchSkills` has no conjunctive pass to stop at, so both skills
    // stay in contention and rank decides.
    create("rotate-a-cert", "when a certificate is expiring", "run dev-certs.sh --rotate");
    create("read-a-cert", "when reading a certificate", "run openssl x509");
    reconcile();
    store.append({
      ts: "2.1",
      threadTs: null,
      userId: "U0ALICE",
      displayName: null,
      text: "a certificate is expiring",
      at: 1
    });

    expect(store.search("a certificate is expiring", 5).map(hit => hit.ts)).toEqual(["2.1"]);
    expect([...store.searchSkills("a certificate is expiring", 5)].sort()).toEqual([
      "read-a-cert",
      "rotate-a-cert"
    ]);
  });

  // What OR costs, stated as a test so it is a known trade rather than a
  // surprise: a question sharing one word retrieves weakly. bm25 ranks it below
  // a real match and the caller's `top_k` cuts the tail.
  it("ranks a skill matching two terms above one matching a single common word", () => {
    create("rotate-a-cert", "when a certificate is expiring", "run dev-certs.sh --rotate");
    create("deploy", "when shipping to staging", "run the deploy script");
    reconcile();

    expect(store.searchSkills("run the expiring certificate rotation", 5)[0]).toBe("rotate-a-cert");
  });
});

describe("skills needing embedding", () => {
  it("lists a newly indexed skill and forgets it once embedded", () => {
    create("rotate-a-cert");
    reconcile();
    expect(store.skillsNeedingEmbedding(10)).toEqual(["rotate-a-cert"]);

    embed("rotate-a-cert", [1, 0, 0]);
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);
  });

  it("never lists an archived skill", () => {
    handWrite("rotate-a-cert", skillText("rotate-a-cert", { status: "archived" }));
    reconcile();

    expect(store.listSkills("channel")).toHaveLength(1);
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);
  });
});

describe("the lifecycle clocks", () => {
  const DAY = 86_400_000;

  it("answers one row per indexed skill, in name order", () => {
    create("rotate-a-cert");
    create("deploy-to-staging");
    reconcile();

    expect(store.skillClocks().map(clock => clock.name)).toEqual([
      "deploy-to-staging",
      "rotate-a-cert"
    ]);
  });

  // A never-used, never-judged skill: the clock it has is the one the index
  // stamped, and everything the job would have recorded is null.
  it("carries nulls for a skill nothing has used and nothing has judged", () => {
    create("rotate-a-cert");
    reconcile();

    expect(store.skillClocks()).toEqual([
      {
        name: "rotate-a-cert",
        status: "active",
        firstSeenAt: NOW,
        lastUsedAt: null,
        statusByJob: null,
        statusByJobAt: null
      }
    ]);
  });

  // The file's status, not the job's — which is what makes comparing the two a
  // test of whether somebody else has written since the job last did.
  it("reports the status the file carries", () => {
    handWrite("rotate-a-cert", skillText("rotate-a-cert", { status: "archived" }));
    reconcile();

    expect(store.skillClocks()[0]?.status).toBe("archived");
  });

  it("reports a use", () => {
    create("rotate-a-cert");
    reconcile();
    store.recordSkillUse(["rotate-a-cert"], NOW + DAY);

    expect(store.skillClocks()[0]?.lastUsedAt).toBe(NOW + DAY);
  });

  // The pair of assertions the whole design turns on. Adopting restarts the
  // clock a skill ages from; the job's own move must not, or its second
  // threshold would be measured from its first decision.
  it("stamps both columns when the job adopts a status it read", () => {
    create("rotate-a-cert");
    reconcile();

    store.adoptSkillStatus([{ name: "rotate-a-cert", status: "active" }], NOW + DAY);

    expect(store.skillClocks()[0]).toMatchObject({
      statusByJob: "active",
      statusByJobAt: NOW + DAY
    });
  });

  it("leaves the stamp alone when the job records a status it wrote", () => {
    create("rotate-a-cert");
    reconcile();
    store.adoptSkillStatus([{ name: "rotate-a-cert", status: "active" }], NOW);

    store.recordSkillStatus([{ name: "rotate-a-cert", status: "stale" }]);

    expect(store.skillClocks()[0]).toMatchObject({
      statusByJob: "stale",
      statusByJobAt: NOW
    });
  });

  // `recordSkillUse`'s behaviour, for its reason: a skill deleted between the
  // clock read and the write is gone, which is not an error.
  each([
    ["adopting", (name: string) => store.adoptSkillStatus([{ name, status: "stale" }], NOW)],
    ["recording", (name: string) => store.recordSkillStatus([{ name, status: "stale" }])]
  ])("ignores a name the index does not hold when %s", (_label, write) => {
    create("rotate-a-cert");
    reconcile();

    expect(() => write("never-indexed")).not.toThrow();
    expect(store.skillClocks()[0]?.statusByJob).toBeNull();
  });

  // Every indexed skill has a clock row, structurally — the inner join in
  // `SKILL_CLOCKS_SQL` depends on it, and `seenSkill` beside the upsert is what
  // makes it true.
  it("holds a row for every skill the index does", () => {
    create("rotate-a-cert");
    handWrite("hand-written", skillText("hand-written"));
    reconcile();

    expect(store.skillClocks()).toHaveLength(store.listSkills("channel").length);
  });

  it("loses the clock when the file goes", () => {
    create("rotate-a-cert");
    reconcile();
    unlinkSync(join(directory, "rotate-a-cert.md"));

    reconcile();

    expect(store.skillClocks()).toEqual([]);
  });

  // Reconciliation writes `skill` and never these observations, which is what
  // lets a job rewrite a status without resetting the clock it just read.
  it("survives a re-index of the file it describes", () => {
    create("rotate-a-cert");
    reconcile();
    store.recordSkillUse(["rotate-a-cert"], NOW);
    store.adoptSkillStatus([{ name: "rotate-a-cert", status: "active" }], NOW);

    files.setStatus("rotate-a-cert", "stale");
    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.skillClocks()[0]).toEqual({
      name: "rotate-a-cert",
      status: "stale",
      firstSeenAt: NOW,
      lastUsedAt: NOW,
      statusByJob: "active",
      statusByJobAt: NOW
    });
  });

  // The property that keeps a weekly status rewrite free: only a moved
  // *description* costs a vector, and a status is not one.
  it("costs no embedding when a status is rewritten", () => {
    create("rotate-a-cert");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    files.setStatus("rotate-a-cert", "stale");

    expect(reconcile(MAX_SKILLS, NOW + DAY)).toMatchObject({ indexed: 1, invalidated: 0 });
    expect(sources()).toEqual([{ source_kind: "skill", source_ref: "rotate-a-cert" }]);
  });

  // Archiving is the exception, and it is the one that has to hold: an archived
  // skill leaves retrieval by having nothing for `nearest` to answer with.
  it("drops the vector when the status written is archived", () => {
    create("rotate-a-cert");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    files.setStatus("rotate-a-cert", "archived");

    expect(reconcile(MAX_SKILLS, NOW + DAY)).toMatchObject({ invalidated: 1 });
    expect(sources()).toEqual([]);
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);
  });

  // And the road back: un-archiving by hand puts the skill in front of whatever
  // embeds, so its vector comes back for the price of one call.
  it("offers an un-archived skill for embedding again", () => {
    handWrite("rotate-a-cert", skillText("rotate-a-cert", { status: "archived" }));
    reconcile();
    expect(store.skillsNeedingEmbedding(10)).toEqual([]);

    handWrite("rotate-a-cert", skillText("rotate-a-cert", { status: "active" }));
    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.skillsNeedingEmbedding(10)).toEqual(["rotate-a-cert"]);
  });
});

describe("nominating a pair to merge", () => {
  const DAY = 86_400_000;

  /** Three skills in a hand-built space: a and b are each other's nearest. */
  const nominatable = (): void => {
    handWrite("a-deploy", skillText("a-deploy", { description: "How we ship a release." }));
    handWrite("b-deploys", skillText("b-deploys", { description: "How we ship releases." }));
    handWrite("c-oncall", skillText("c-oncall", { description: "Who to wake at 3am." }));
    reconcile();
    embed("a-deploy", [1, 0, 0]);
    embed("b-deploys", [1, 0.1, 0]);
    embed("c-oncall", [1, 0.6, 0]);
  };

  // The guard `nearest` has, for its reason: a store with no embedding provider
  // behind it has no `vec_embedding` table at all, and preparing a statement
  // that names one throws. This is the case that would otherwise fire in every
  // deployment that configured no embeddings.
  it("answers nothing, without throwing, on a store that has embedded nothing", () => {
    create("rotate-a-cert");
    reconcile();

    expect(store.skillMergeCandidate()).toBeNull();
  });

  it("answers nothing for a library of one", () => {
    create("rotate-a-cert");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);

    expect(store.skillMergeCandidate()).toBeNull();
  });

  // The case a directed "each skill's nearest" rule would get wrong: c's nearest
  // is b, but b's nearest is a, so only (a, b) is mutual.
  it("nominates the mutual pair and not the one-sided one", () => {
    nominatable();

    expect(store.skillMergeCandidate()).toMatchObject({ a: "a-deploy", b: "b-deploys" });
  });

  it("answers the pair in name order, with the texts it nominated them as", () => {
    nominatable();
    const pair = store.skillMergeCandidate();

    expect(pair?.a).toBe("a-deploy");
    expect(pair?.b).toBe("b-deploys");
    // The hashes are the index's own, so a caller never computes one.
    expect(pair?.hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(pair?.hashB).toMatch(/^[0-9a-f]{64}$/);
    expect(pair?.hashA).not.toBe(pair?.hashB);
  });

  // The bound: considered once, at these texts, and not raised again. Deleting
  // the proposal file is the decline and this table never hears about it, so
  // ignoring and declining come to the same thing.
  it("does not nominate a pair it has already been asked about", () => {
    nominatable();
    const pair = store.skillMergeCandidate();
    if (pair === null) throw new Error("the fixture nominated nothing");

    store.recordSkillMergeConsidered(pair, NOW);

    expect(store.skillMergeCandidate()).toBeNull();
  });

  // And what un-bounds it: an edit to one of the two descriptions, which is new
  // evidence. A body edit is not — see the DDL.
  it("nominates it again once a description moves", () => {
    nominatable();
    const pair = store.skillMergeCandidate();
    if (pair === null) throw new Error("the fixture nominated nothing");
    store.recordSkillMergeConsidered(pair, NOW);

    handWrite("a-deploy", skillText("a-deploy", { description: "How we ship a release, revised." }));
    reconcile(MAX_SKILLS, NOW + DAY);
    embed("a-deploy", [1, 0, 0]);

    expect(store.skillMergeCandidate()).toMatchObject({ a: "a-deploy", b: "b-deploys" });
  });

  it("does not nominate it again when only a body moved", () => {
    nominatable();
    const pair = store.skillMergeCandidate();
    if (pair === null) throw new Error("the fixture nominated nothing");
    store.recordSkillMergeConsidered(pair, NOW);

    handWrite(
      "a-deploy",
      skillText("a-deploy", { description: "How we ship a release." }, "A longer body now.")
    );
    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.skillMergeCandidate()).toBeNull();
  });

  // Archiving the nearer of the two takes it out of the running entirely: what
  // is left is the pair among the live skills, not a pair naming the archived
  // one. (Reconciliation also drops an archived skill's vector, so the status
  // join is belt to that braces — but a rule applied by its callers is a rule
  // one of them forgets.)
  it("never nominates an archived skill", () => {
    nominatable();
    handWrite(
      "b-deploys",
      skillText("b-deploys", { description: "How we ship releases.", status: "archived" })
    );
    reconcile(MAX_SKILLS, NOW + DAY);

    const pair = store.skillMergeCandidate();
    expect(pair?.a).not.toBe("b-deploys");
    expect(pair?.b).not.toBe("b-deploys");
  });

  it("answers nothing when archiving leaves nothing to pair", () => {
    nominatable();
    for (const name of ["b-deploys", "c-oncall"]) {
      handWrite(name, skillText(name, { description: `About ${name}.`, status: "archived" }));
    }
    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.skillMergeCandidate()).toBeNull();
  });

  // `ROW_NUMBER` over a partial order picks arbitrarily, so the window's
  // tiebreak on the neighbour's name is what keeps this from depending on the
  // query plan.
  it("answers the same pair every time when two are equally near", () => {
    for (const name of ["a-one", "b-two", "c-three"]) {
      handWrite(name, skillText(name, { description: `About ${name}.` }));
    }
    reconcile();
    embed("a-one", [1, 0, 0]);
    embed("b-two", [0, 1, 0]);
    embed("c-three", [0, 1, 0]);

    const answers = [0, 1, 2, 3, 4].map(() => JSON.stringify(store.skillMergeCandidate()));
    expect(new Set(answers).size).toBe(1);
  });

  it("forgets a pair on request, so a later pair of the same names is fresh", () => {
    nominatable();
    const pair = store.skillMergeCandidate();
    if (pair === null) throw new Error("the fixture nominated nothing");
    store.recordSkillMergeConsidered(pair, NOW);
    expect(store.skillMergeCandidate()).toBeNull();

    store.forgetSkillMergeProposal({ a: pair.a, b: pair.b });

    expect(store.skillMergeCandidate()).toMatchObject({ a: "a-deploy", b: "b-deploys" });
  });
});

describe("a merge somebody applied by hand", () => {
  const DAY = 86_400_000;

  // The acceptance this issue turns on, and there is no product code in step
  // four: a person replaces one file and deletes the other, and reconciliation
  // is the whole of how that takes effect.
  it("takes effect through reconciliation, and the kept skill keeps its observations", () => {
    handWrite("deploy-rollback", skillText("deploy-rollback", { description: "How we undo a ship." }));
    handWrite("deploy-runbook", skillText("deploy-runbook", { description: "How we ship." }));
    reconcile();
    store.recordSkillUse(["deploy-runbook"], NOW);
    embed("deploy-runbook", [1, 0, 0]);
    embed("deploy-rollback", [1, 0.1, 0]);
    const before = uses("deploy-runbook");

    // The human act. Nothing this package exports is involved.
    handWrite(
      "deploy-runbook",
      skillText(
        "deploy-runbook",
        { description: "How to ship, and how to roll back when it goes wrong." },
        "Deploy, then rollback if the smoke test fails."
      )
    );
    unlinkSync(join(directory, "deploy-rollback.md"));

    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["deploy-runbook"]);
    // The merged text is what a later task now matches against, and the dropped
    // name reaches nothing.
    expect(store.searchSkills("rollback smoke test", 5)).toEqual(["deploy-runbook"]);
    expect(store.listSkills("channel")[0]?.name).not.toBe("deploy-rollback");
    // The dropped skill took its observations and its vector with it.
    expect(uses("deploy-rollback")).toBeUndefined();
    expect(sources()).toEqual([]);
    // And the kept skill did not: that is why a merge keeps one of the two names
    // rather than inventing a third.
    expect(uses("deploy-runbook")).toEqual(before);
    // Its description moved, so its vector was invalidated and it is offered for
    // embedding again.
    expect(store.skillsNeedingEmbedding(5)).toEqual(["deploy-runbook"]);
  });

  // Half-applied: one file deleted, the other left alone. The row outliving its
  // skill is what lets a caller find the proposal file and clean it up — which
  // is why no trigger takes these rows away.
  it("leaves the considered pair findable when only one file went", () => {
    handWrite("deploy-rollback", skillText("deploy-rollback", { description: "How we undo a ship." }));
    handWrite("deploy-runbook", skillText("deploy-runbook", { description: "How we ship." }));
    reconcile();
    store.recordSkillMergeConsidered(
      { a: "deploy-rollback", b: "deploy-runbook", hashA: "h", hashB: "h" },
      NOW
    );
    expect(store.orphanedSkillMergeProposals(10)).toEqual([]);

    unlinkSync(join(directory, "deploy-rollback.md"));
    reconcile(MAX_SKILLS, NOW + DAY);

    expect(store.orphanedSkillMergeProposals(10)).toEqual([
      { a: "deploy-rollback", b: "deploy-runbook" }
    ]);

    store.forgetSkillMergeProposal({ a: "deploy-rollback", b: "deploy-runbook" });
    expect(store.orphanedSkillMergeProposals(10)).toEqual([]);
  });

  it("bounds how many orphans it answers at once", () => {
    for (const index of [0, 1, 2]) {
      store.recordSkillMergeConsidered(
        { a: `gone-${String(index)}`, b: "also-gone", hashA: "h", hashB: "h" },
        NOW
      );
    }

    expect(store.orphanedSkillMergeProposals(2)).toHaveLength(2);
  });
});

// The shared half of the index (#434).
//
// One store, two directories, and the whole of what this block is about is that
// the two halves cannot reach each other: not through reconciliation's delete,
// not through the lifecycle clocks, and not through the merge curator's
// nomination. Both directories are real, for this file's stated reason.
describe("the shared half of the index", () => {
  const DAY = 86_400_000;

  let sharedRoot: string;
  let shared: SharedSkillFiles;

  /** The operator's act, from outside this package entirely. */
  const publish = (name: string, description = "How this company writes.", body = "Say it plainly."): void => {
    writeFileSync(
      join(sharedRoot, `${name}.md`),
      skillText(name, { description }, body),
      "utf8"
    );
  };

  /** One shared pass, over the names a channel's sheet asked for. */
  const reconcileShared = (names: string[], at = NOW) =>
    reconcileSharedSkillIndex({ files: shared, store, names, at });

  /** The same pass on a channel that has no shared library at all (#436). */
  const reconcileWithNoLibrary = (at = NOW) =>
    reconcileSharedSkillIndex({ files: null, store, names: [], at });

  beforeEach(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), "libero-shared-root-"));
    const files = openSharedSkillFiles({ root: sharedRoot });
    if (files === null) throw new Error("the fixture shared root did not open");
    shared = files;
  });

  afterEach(() => {
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  describe("what a pass indexes", () => {
    // The address is the key, and it is applied at this seam and nowhere else:
    // the file is `brand-voice.md` and the row is `shared/brand-voice`.
    it("indexes a named skill under its address", () => {
      publish("brand-voice");

      expect(reconcileShared(["brand-voice"])).toMatchObject({ indexed: 1, dropped: 0 });
      expect(store.listSkills("shared").map(skill => skill.name)).toEqual(["shared/brand-voice"]);
      expect(store.listSkills("shared")[0]?.origin).toBe("shared");
    });

    // The sheet bounds the set, not a cap: a published file this channel did not
    // ask for is not this channel's skill.
    it("passes over a file the sheet did not name", () => {
      publish("brand-voice");
      publish("code-review-standards");

      reconcileShared(["brand-voice"]);

      expect(store.listSkills("shared").map(skill => skill.name)).toEqual(["shared/brand-voice"]);
    });

    // Not an error and not a row. Saying so out loud belongs where the prompt
    // text is assembled — this pass has nothing of its own to say.
    it("indexes nothing for a name the root does not hold", () => {
      expect(reconcileShared(["brand-voice"])).toMatchObject({ indexed: 0, dropped: 0 });
      expect(store.listSkills("shared")).toEqual([]);
    });

    it("drops the row when the sheet stops naming it", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(reconcileShared([], NOW + DAY)).toMatchObject({ dropped: 1 });
      expect(store.listSkills("shared")).toEqual([]);
    });

    it("drops the row when the operator unpublishes the file", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      unlinkSync(join(sharedRoot, "brand-voice.md"));

      expect(reconcileShared(["brand-voice"], NOW + DAY)).toMatchObject({ dropped: 1 });
      expect(store.listSkills("shared")).toEqual([]);
    });

    // A steady-state pass is `stat` calls: the fingerprint has not moved, so
    // nothing is re-read and nothing is re-indexed.
    it("re-indexes nothing when no file moved", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(reconcileShared(["brand-voice"], NOW + DAY)).toMatchObject({
        indexed: 0,
        dropped: 0
      });
    });

    // The same rule the channel half keeps: a half-deployed file keeps its last
    // good row rather than taking a vector down with it.
    it("keeps the last good row for a file that stopped parsing", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      writeFileSync(join(sharedRoot, "brand-voice.md"), "half a deploy\n", "utf8");
      reconcileShared(["brand-voice"], NOW + DAY);

      expect(store.listSkills("shared").map(skill => skill.name)).toEqual(["shared/brand-voice"]);
    });
  });

  describe("the two halves do not reach each other", () => {
    // The hazard the origin scoping exists for: a channel's own reconciliation
    // runs four times a task and knows nothing of the shared root, so an
    // unscoped delete would read the shared half as a directory that emptied.
    it("survives the channel's own pass", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);
      create("rotate-a-cert");

      expect(reconcile(MAX_SKILLS, NOW + DAY)).toMatchObject({ dropped: 0 });
      expect(store.listSkills("shared").map(skill => skill.name)).toEqual(["shared/brand-voice"]);
    });

    it("leaves the channel's own skills alone", () => {
      create("rotate-a-cert");
      reconcile();
      publish("brand-voice");

      expect(reconcileShared(["brand-voice"], NOW + DAY)).toMatchObject({ dropped: 0 });
      expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["rotate-a-cert"]);
    });

    // `/` is not in `SKILL_NAME_PATTERN`, so no channel-grown name can spell the
    // qualified form and the UNIQUE on `skill.name` never has to arbitrate.
    it("holds a shared and a channel skill of the same name at once", () => {
      publish("brand-voice");
      handWrite("brand-voice", skillText("brand-voice", { description: "How this channel writes." }));
      reconcile();
      reconcileShared(["brand-voice"]);

      expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["brand-voice"]);
      expect(store.listSkills("shared").map(skill => skill.name)).toEqual(["shared/brand-voice"]);
    });
  });

  describe("no clock acts on a shared skill", () => {
    // The acceptance criterion in two halves: uses are recorded, and no clock
    // reads them. The lifecycle job's next act on what it reads is `setStatus`,
    // which on this half would be a write into a read-only mount.
    it("keeps a shared skill out of the clocks", () => {
      publish("brand-voice");
      create("rotate-a-cert");
      reconcile();
      reconcileShared(["brand-voice"]);

      expect(store.skillClocks().map(clock => clock.name)).toEqual(["rotate-a-cert"]);
    });

    it("records its uses all the same", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      store.recordSkillUse(["shared/brand-voice"], NOW + DAY);

      expect(uses("shared/brand-voice")).toMatchObject({ uses: 1 });
      expect(store.skillClocks()).toEqual([]);
    });
  });

  describe("the merge curator cannot see one", () => {
    // A proposal naming a shared skill would be a draft to rewrite a file in a
    // read-only root, so the pair has to be unreachable rather than declined.
    //
    // One skill on each side, which is the only shape in which "no pair at all"
    // is a meaningful answer: among two or more live skills the closest pair is
    // always mutual, so what excluding the shared half does to a larger library
    // is the case below rather than this one.
    it("does not nominate a mutual pair that crosses the origin line", () => {
      handWrite("a-deploy", skillText("a-deploy", { description: "How we ship a release." }));
      publish("b-deploys", "How we ship releases.");
      reconcile();
      reconcileShared(["b-deploys"]);
      embed("a-deploy", [1, 0, 0]);
      embed("shared/b-deploys", [1, 0.1, 0]);

      expect(store.skillMergeCandidate()).toBeNull();
    });

    // And the reason the exclusion is in `live` rather than in the final SELECT.
    // Left in the candidate set, the shared skill is a-deploy's nearest at 0.1
    // and c-oncall's pair with a-deploy at 0.6 never reaches `rn = 1` — so the
    // curator would answer nothing while a real pair stood there.
    it("does not let one suppress a pair it stands between", () => {
      handWrite("a-deploy", skillText("a-deploy", { description: "How we ship a release." }));
      handWrite("c-oncall", skillText("c-oncall", { description: "Who to wake at 3am." }));
      publish("b-deploys", "How we ship releases.");
      reconcile();
      reconcileShared(["b-deploys"]);
      embed("a-deploy", [1, 0, 0]);
      embed("shared/b-deploys", [1, 0.1, 0]);
      embed("c-oncall", [1, 0.6, 0]);

      expect(store.skillMergeCandidate()).toMatchObject({ a: "a-deploy", b: "c-oncall" });
    });

    // The same pair with both halves the channel's own is nominated, which is
    // what proves the fixture would otherwise have produced one.
    it("nominates the same pair when both are the channel's own", () => {
      handWrite("a-deploy", skillText("a-deploy", { description: "How we ship a release." }));
      handWrite("b-deploys", skillText("b-deploys", { description: "How we ship releases." }));
      handWrite("c-oncall", skillText("c-oncall", { description: "Who to wake at 3am." }));
      reconcile();
      embed("a-deploy", [1, 0, 0]);
      embed("b-deploys", [1, 0.1, 0]);
      embed("c-oncall", [1, 0.6, 0]);

      expect(store.skillMergeCandidate()).toMatchObject({ a: "a-deploy", b: "b-deploys" });
    });
  });

  // Retrieval is the point of a `retrieved` entry, so both legs and the
  // embedding pass see a shared skill exactly as they see a channel one.
  describe("retrieval reaches one", () => {
    it("answers it from the lexical leg", () => {
      publish("brand-voice", "How this company writes its release notes.");
      reconcileShared(["brand-voice"]);

      expect(store.searchSkills("how do we write release notes", 5)).toEqual(["shared/brand-voice"]);
    });

    it("offers it to whoever has an embedding provider", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(store.skillsNeedingEmbedding(10)).toEqual(["shared/brand-voice"]);
    });

    it("answers it from the vector leg, under its address", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);
      embed("shared/brand-voice", [1, 0, 0]);

      expect(store.nearest(Float32Array.from([1, 0, 0]), 5, "skill").map(hit => hit.source.ref)).toEqual([
        "shared/brand-voice"
      ]);
    });
  });

  // #436. `null` is the third thing a caller can say, and it is what lets both
  // passes call this unconditionally rather than skipping it — skipping is what
  // strands a row that no opener can resolve and that both legs keep returning.
  describe("a channel with no shared library", () => {
    it("empties the half when the root goes away", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(reconcileWithNoLibrary(NOW + DAY)).toMatchObject({ indexed: 0, dropped: 1 });
      expect(store.listSkills("shared")).toEqual([]);
    });

    it("leaves the channel's own skills alone doing it", () => {
      create("rotate-a-cert");
      reconcile();
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      reconcileWithNoLibrary(NOW + DAY);

      expect(store.listSkills("channel").map(skill => skill.name)).toEqual(["rotate-a-cert"]);
    });

    // The ordinary case, and the one that has to be cheap: no third root
    // configured anywhere, on every task, forever.
    it("is a no-op on a half that holds nothing", () => {
      expect(reconcileWithNoLibrary()).toMatchObject({ indexed: 0, dropped: 0, invalidated: 0 });
    });
  });

  // The acceptance's "a body edit … without resetting its use counters", against
  // the mechanism that actually decides it: the vector stands for the
  // description, so only a description edit invalidates one. See
  // `apps/server/src/session/skill-embed.ts` for why that is the wanted answer
  // here rather than a gap — one operator typo fix would otherwise charge every
  // channel that named the skill for a vector identical to the one it replaced.
  describe("what an operator's edit costs", () => {
    it("re-indexes a body edit without invalidating the vector", () => {
      publish("brand-voice", "How this company writes.", "Say it plainly.");
      reconcileShared(["brand-voice"]);
      embed("shared/brand-voice", [1, 0, 0]);
      store.recordSkillUse(["shared/brand-voice"], NOW);

      publish("brand-voice", "How this company writes.", "Say it plainly, and once.");

      expect(reconcileShared(["brand-voice"], NOW + DAY)).toMatchObject({
        indexed: 1,
        dropped: 0,
        invalidated: 0
      });
      expect(store.skillsNeedingEmbedding(10)).toEqual([]);
      expect(uses("shared/brand-voice")).toMatchObject({ uses: 1 });
      expect(store.searchSkills("plainly and once", 5)).toEqual(["shared/brand-voice"]);
    });

    it("invalidates the vector when the description moves", () => {
      publish("brand-voice", "How this company writes.");
      reconcileShared(["brand-voice"]);
      embed("shared/brand-voice", [1, 0, 0]);
      store.recordSkillUse(["shared/brand-voice"], NOW);

      publish("brand-voice", "How this company writes its release notes.");

      expect(reconcileShared(["brand-voice"], NOW + DAY)).toMatchObject({ invalidated: 1 });
      expect(store.skillsNeedingEmbedding(10)).toEqual(["shared/brand-voice"]);
      expect(uses("shared/brand-voice")).toMatchObject({ uses: 1 });
    });
  });

  // #436. Both halves compete for one batch of ten in name order, which is fine
  // on a channel that can address both — and is a permanent stall on one that
  // cannot. `shared/` sorts after every channel name from `a` to `r`.
  describe("embedding one half of the library", () => {
    it("answers only the half the caller asked for", () => {
      create("rotate-a-cert");
      reconcile();
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(store.skillsNeedingEmbedding(10, "shared")).toEqual(["shared/brand-voice"]);
      expect(store.skillsNeedingEmbedding(10, "channel")).toEqual(["rotate-a-cert"]);
      expect(store.skillsNeedingEmbedding(10)).toEqual(["rotate-a-cert", "shared/brand-voice"]);
    });

    // The stall, exactly: ten unembeddable channel rows sort ahead of the one
    // shared row and fill the window, so the unscoped read never reaches it and
    // the next pass finds the same ten.
    it("reaches a shared skill the channel half would hold the window against", () => {
      // Written rather than created, and reconciled against a cap of its own:
      // the fixture's `[skills] max_skills` is below the batch size, and the
      // stall needs a full window of channel rows to be a stall.
      const filling = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
      for (const name of filling) handWrite(`${name}-runbook`, skillText(`${name}-runbook`));
      reconcile(filling.length);
      publish("brand-voice");
      reconcileShared(["brand-voice"]);

      expect(store.skillsNeedingEmbedding(10)).not.toContain("shared/brand-voice");
      expect(store.skillsNeedingEmbedding(10, "shared")).toEqual(["shared/brand-voice"]);
    });

    it("never lists an archived skill of the half either", () => {
      publish("brand-voice");
      reconcileShared(["brand-voice"]);
      writeFileSync(
        join(sharedRoot, "brand-voice.md"),
        skillText("brand-voice", { status: "archived" }),
        "utf8"
      );
      reconcileShared(["brand-voice"], NOW + DAY);

      expect(store.listSkills("shared")).toHaveLength(1);
      expect(store.skillsNeedingEmbedding(10, "shared")).toEqual([]);
    });
  });
});
