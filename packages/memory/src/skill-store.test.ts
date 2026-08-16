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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
