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
import { reconcileSkillIndex } from "./skill-store.js";
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
    expect(store.listSkills().map(skill => skill.name)).toEqual(["rotate-a-cert"]);
  });

  // #290's acceptance in one line: the file is the source of truth, so a skill
  // nobody wrote through the store joins the index the same way one that was
  // does.
  it("indexes a skill a person added by hand", () => {
    handWrite("hand-written", skillText("hand-written"));

    expect(reconcile()).toMatchObject({ indexed: 1 });
    expect(store.listSkills().map(skill => skill.name)).toEqual(["hand-written"]);
  });

  it("drops a skill a person deleted, and its vector with it", () => {
    create("rotate-a-cert");
    reconcile();
    embed("rotate-a-cert", [1, 0, 0]);
    expect(sources()).toHaveLength(1);

    unlinkSync(join(directory, "rotate-a-cert.md"));

    expect(reconcile()).toMatchObject({ dropped: 1 });
    expect(store.listSkills()).toEqual([]);
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
    expect(store.listSkills().map(skill => skill.name)).toEqual(["rotate-a-cert"]);
    expect(store.searchSkills("findable", 5)).toEqual(["rotate-a-cert"]);
    expect(uses("rotate-a-cert")?.uses).toBe(1);
  });

  it("indexes a file whose frontmatter names a different skill not at all", () => {
    handWrite("deploy", skillText("rollback"));

    expect(reconcile()).toEqual({ indexed: 0, dropped: 0, invalidated: 0 });
    expect(store.listSkills()).toEqual([]);
  });

  // Deterministic rather than directory order, and the rest are left on disk
  // untouched: a team that over-filled the directory loses some retrieval, not
  // all of it.
  it("takes the first max_skills by name and leaves the rest alone", () => {
    for (const name of ["e", "d", "c", "b", "a"]) create(name);

    expect(reconcile(3)).toMatchObject({ indexed: 3 });
    expect(store.listSkills().map(skill => skill.name)).toEqual(["a", "b", "c"]);
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
    // The control: the message index answers the same question conjunctively and
    // finds nothing, which is what makes the paragraph above a difference rather
    // than a restatement.
    store.append({
      ts: "1.1",
      threadTs: null,
      userId: "U0ALICE",
      displayName: null,
      text: "when a certificate is expiring",
      at: 1
    });
    expect(store.search("how do we rotate an expiring certificate?", 5)).toEqual([]);
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

    expect(store.listSkills()).toHaveLength(1);
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

    expect(store.skillClocks()).toHaveLength(store.listSkills().length);
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

    expect(store.listSkills().map(skill => skill.name)).toEqual(["deploy-runbook"]);
    // The merged text is what a later task now matches against, and the dropped
    // name reaches nothing.
    expect(store.searchSkills("rollback smoke test", 5)).toEqual(["deploy-runbook"]);
    expect(store.listSkills()[0]?.name).not.toBe("deploy-rollback");
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
