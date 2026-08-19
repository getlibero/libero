import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EMBEDDING_DIMS,
  MESSAGE_STORE_SCHEMA_VERSION,
  READ_MAX_LIMIT,
  SEARCH_MAX_TERMS,
  assertFts5,
  loadVec,
  openMessageReader,
  openMessageStore,
  toAnyMatchQuery,
  toMatchQuery
} from "./store-db.js";
import type { MessageStore, StoredMessage, StoredScheduledTask } from "./store-db.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";

let root: string;
let file: string;
let store: MessageStore;

/** A message with everything but ts and text defaulted, so a test names only what it means. */
function message(ts: string, text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    ts,
    threadTs: null,
    userId: "U0ALICE",
    displayName: null,
    text,
    at: 1_700_000_000_000,
    ...extra
  };
}

/** The ts of every hit, in rank order. What almost every search assertion wants. */
function found(query: string, limit = 10): string[] {
  return store.search(query, limit).map(hit => hit.ts);
}

/**
 * Every row, read the way a second process would: its own handle, its own SQL.
 *
 * Reaching past the module's API is the point — these assert on the *file's*
 * properties, which is the only way to check a trigger did what the API cannot
 * show.
 */
function raw<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * `raw`, for a statement that names the vec table.
 *
 * A separate helper rather than a flag on `raw`, because needing it is itself a
 * fact about the file: a connection without sqlite-vec loaded cannot query a
 * vec0 table, which is what "a file that holds vectors, read by a build that
 * cannot" asserts at the bottom of this file. Every other `raw` call proves it
 * did not need this.
 */
function rawVec<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    loadVec(db, path);
    return read(db);
  } finally {
    db.close();
  }
}

/** How many entries the index holds for a term, counted through the index alone. */
function indexedRows(path: string, match: string): number {
  return raw(path, db =>
    Number(
      (
        db.prepare(`SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH ?`).get(match) as {
          n: number | bigint;
        }
      ).n
    )
  );
}

/** Reaches past the module's API on purpose: nothing else can forge a version. */
function bumpVersionTo(path: string, version: number): void {
  raw(path, db => {
    db.prepare("UPDATE schema_version SET version = ?").run(version);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-memory-"));
  // The store does not create this — that is a tested property below, so here
  // the test does the operator's job of declaring the channel exists.
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the file", () => {
  it("lands in the channel's own directory", () => {
    store.append(message("1.1", "hello"));
    expect(raw(file, db => db.prepare("SELECT count(*) AS n FROM message").get())).toEqual({ n: 1 });
  });

  // No mkdir. The channel's directory existing is the operator's statement that
  // the channel exists; a store that created one would invent a channel with no
  // team sheet and quietly log a conversation into it.
  it("refuses a channel directory that does not exist", () => {
    expect(() => openMessageStore({ channel: "C0NOSUCH", root })).toThrow();
  });

  // The isolation boundary is a path segment, so the character class is the
  // boundary. Each of these would climb out of `root` or collide if it did not
  // throw.
  it.each([["dot-dot", ".."], ["separator", "a/b"], ["empty", ""], ["leading dot", ".hidden"]])(
    "refuses a channel id that is not a safe path segment: %s",
    (_name, channel) => {
      expect(() => openMessageStore({ channel, root })).toThrow(/not a valid channel id/);
    }
  );

  it("refuses a channel id longer than the schema allows", () => {
    expect(() => openMessageStore({ channel: "C".repeat(65), root })).toThrow(
      /not a valid channel id/
    );
  });

  it("keeps what it stored across a close and reopen", () => {
    store.append(message("1.1", "the vault is locked"));
    store.close();

    store = openMessageStore({ channel: CHANNEL, root });
    expect(found("vault")).toEqual(["1.1"]);
  });

  // WAL. The proxy reads this file as a second process (#64) — that is
  // `openMessageReader`'s suite below; this is the weaker property it rests on.
  it("lets a second handle read while the first is open", () => {
    store.append(message("1.1", "the vault is locked"));

    const reader = openMessageStore({ channel: CHANNEL, root });
    expect(reader.search("vault", 10).map(hit => hit.ts)).toEqual(["1.1"]);
    reader.close();
  });

  it("stamps its schema version and refuses a file from the future", () => {
    store.close();
    bumpVersionTo(file, MESSAGE_STORE_SCHEMA_VERSION + 1);

    expect(() => openMessageStore({ channel: CHANNEL, root })).toThrow(/schema version/);

    // Reopened only so afterEach has something to close.
    bumpVersionTo(file, MESSAGE_STORE_SCHEMA_VERSION);
    store = openMessageStore({ channel: CHANNEL, root });
  });
});

describe("the interface", () => {
  // A structural regression test on the surface. The isolation claim is that no
  // operation can name a channel, and the cheapest way to keep that true is to
  // notice when a new one appears.
  it("exposes appending, removing, replacing, reading, embedding, summarizing, indexing, ageing and pairing skills, scheduling, and closing, and nothing else", () => {
    expect(Object.keys(store).sort()).toEqual([
      "adoptSkillStatus",
      "append",
      "close",
      "forgetSkillMergeProposal",
      "idleThreads",
      "listSkills",
      "nearest",
      "orphanedSkillMergeProposals",
      "putEmbedding",
      "putThreadSummary",
      "readThreadSummary",
      "recent",
      "recentInThread",
      "reconcileSkills",
      "recordSkillMergeConsidered",
      "recordSkillMergeNotice",
      "recordSkillStatus",
      "recordSkillUse",
      "remove",
      "removeEmbedding",
      "replaceText",
      "scheduleTask",
      "search",
      "searchSkills",
      "skillClocks",
      "skillMergeCandidate",
      "skillMergeNoticed",
      "skillsNeedingEmbedding",
      "staleThreads"
    ]);
  });

  // The three the lifecycle job added (#294) write `skill_use` and nothing else,
  // which is why the rule below still holds with them present: the job records
  // what it observed and what it wrote, and the index's own rows still come from
  // reconciliation alone.
  it("offers the lifecycle job a clock read and two stamps, and no skill writer", () => {
    for (const method of ["skillClocks", "adoptSkillStatus", "recordSkillStatus"]) {
      expect(Object.keys(store)).toContain(method);
    }
  });

  // The four the merge curator added (#295) write `skill_merge_proposal` and
  // read `vec_embedding`, and none of them touches a skill row or a skill file —
  // which is what keeps the rule below true with them present too.
  it("offers the curator a nomination, a record, and a way to clean up after one", () => {
    for (const method of [
      "skillMergeCandidate",
      "recordSkillMergeConsidered",
      "orphanedSkillMergeProposals",
      "forgetSkillMergeProposal"
    ]) {
      expect(Object.keys(store)).toContain(method);
    }
  });

  // The index has exactly one writer, and it is reconciliation. A `putSkill` or
  // a `removeSkill` would be a second path by which the index could come to
  // disagree with the directory, and neither could be reviewed for whether its
  // caller had looked at a file first. This still passes unchanged after #294
  // and #295, which is the argument their writers are legitimate: one writes
  // `skill_use`, the other `skill_merge_proposal`, and neither writes `skill`.
  it("offers no way to write a skill row except by reconciling", () => {
    for (const forbidden of ["putSkill", "removeSkill", "deleteSkill", "readSkill"]) {
      expect(Object.keys(store)).not.toContain(forbidden);
    }
  });

  // The file is the channel, so there is no channel column and no argument that
  // could name one. Two stores under one root cannot see each other.
  it("cannot reach another channel's store", () => {
    mkdirSync(join(root, OTHER));
    const other = openMessageStore({ channel: OTHER, root });
    other.append(message("2.1", "the vault in another channel"));

    expect(found("vault")).toEqual([]);
    expect(other.search("vault", 10).map(hit => hit.ts)).toEqual(["2.1"]);

    other.close();
  });
});

// The tool proxy's half of #64. What these assert is not that search works —
// that is covered exhaustively below against the writer's own handle, and the
// statement is literally the same one — but that a *second process* can open the
// file, that it opens it without touching it, and that the isolation invariant
// survives the second opener.
describe("reading with openMessageReader", () => {
  it("reads what the writer has already stored", () => {
    store.append(message("1.1", "we decided to ship the vault"));

    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(reader?.search("vault", 10).map(hit => hit.ts)).toEqual(["1.1"]);
    reader?.close();
  });

  // WAL's actual promise, and the one the proxy depends on: a reader opened
  // before a write sees it, without reopening and without blocking the writer.
  it("sees a message appended after it opened", () => {
    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(reader?.search("vault", 10)).toEqual([]);

    store.append(message("1.1", "the vault is locked"));

    expect(reader?.search("vault", 10).map(hit => hit.ts)).toEqual(["1.1"]);
    reader?.close();
  });

  it("returns every field the writer stored", () => {
    const sent = message("1.1", "we shipped it", {
      threadTs: "1.0",
      userId: "U0SAM",
      displayName: "Sam",
      at: 42
    });
    store.append(sent);

    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(reader?.search("shipped", 10)).toEqual([sent]);
    reader?.close();
  });

  // A provisioned channel that has not yet had a message is the ordinary state
  // of a new channel, so it is null rather than a throw — and null rather than
  // an empty result, because the proxy says something different to the model for
  // "nothing matched" than for "nothing has been stored".
  it("answers null for a channel with no store yet", () => {
    mkdirSync(join(root, OTHER));
    expect(openMessageReader({ channel: OTHER, root })).toBeNull();
  });

  it("answers null rather than creating the file", () => {
    mkdirSync(join(root, OTHER));
    openMessageReader({ channel: OTHER, root });

    expect(existsSync(join(root, OTHER, "store.db"))).toBe(false);
  });

  // A structural regression test, `MessageStore`'s counterpart. The proxy
  // answers two questions and this is the surface that says which: no append, no
  // remove, no replaceText, and no `recent` — reading a channel's traffic
  // wholesale is not what search_channel_history is.
  //
  // #229 gave this opener `allowExtension: true` and it still read exactly the
  // same. That was the acceptance criterion in structural form: loading
  // sqlite-vec did not add a vector query here, because whether the proxy ever
  // runs one is #232's question.
  //
  // #323 is the first thing that did widen it, and this line moving is the review
  // it was supposed to trigger. What admits `pendingScheduledTasks` and no
  // successor: it takes no argument, it answers an integer, and the cap it serves
  // has to be decided by the process that governs the create rather than the one
  // that writes the row. A method here that returned a *ticket* — its prompt, its
  // instant — would be model-authored text crossing back into the process holding
  // every tool credential, and this list is where that gets stopped.
  it("exposes searching, counting scheduled checks, and closing, and nothing else", () => {
    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(Object.keys(reader ?? {}).sort()).toEqual([
      "close",
      "pendingScheduledTasks",
      "search"
    ]);
    reader?.close();
  });

  // The isolation invariant, against the opener that runs in the process
  // holding every tool credential. The factory closed over one file, so there is
  // no argument that could reach the other channel.
  it("cannot reach another channel's store", () => {
    store.append(message("1.1", "the vault in this channel"));
    mkdirSync(join(root, OTHER));
    const other = openMessageStore({ channel: OTHER, root });
    other.append(message("2.1", "the vault in another channel"));

    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(reader?.search("vault", 10).map(hit => hit.text)).toEqual(["the vault in this channel"]);

    reader?.close();
    other.close();
  });

  it.each([["dot-dot", ".."], ["separator", "a/b"], ["empty", ""], ["leading dot", ".hidden"]])(
    "refuses a channel id that is not a safe path segment: %s",
    (_name, channel) => {
      expect(() => openMessageReader({ channel, root })).toThrow(/not a valid channel id/);
    }
  );

  // It does not migrate in either direction, so both mismatches are refused and
  // the message names both numbers.
  it("refuses a file whose schema version it does not read", () => {
    store.close();
    bumpVersionTo(file, MESSAGE_STORE_SCHEMA_VERSION + 1);

    expect(() => openMessageReader({ channel: CHANNEL, root })).toThrow(
      new RegExp(`schema version ${MESSAGE_STORE_SCHEMA_VERSION + 1}.*reads version ${MESSAGE_STORE_SCHEMA_VERSION}`, "s")
    );

    bumpVersionTo(file, MESSAGE_STORE_SCHEMA_VERSION);
    store = openMessageStore({ channel: CHANNEL, root });
  });

  it("refuses a file that is not a message store", () => {
    mkdirSync(join(root, OTHER));
    const stray = join(root, OTHER, "store.db");
    raw(stray, db => db.exec("CREATE TABLE something (x INTEGER)"));

    expect(() => openMessageReader({ channel: OTHER, root })).toThrow(/not a message store/);
  });
});

describe("storing a message", () => {
  it("keeps every field it was given", () => {
    const sent = message("1.1", "we shipped it", {
      threadTs: "1.0",
      userId: "U0SAM",
      displayName: "Sam",
      at: 42
    });
    store.append(sent);

    expect(store.search("shipped", 10)).toEqual([sent]);
  });

  it("stores a top-level message with no thread", () => {
    store.append(message("1.1", "standalone"));
    expect(store.search("standalone", 10).map(hit => hit.threadTs)).toEqual([null]);
  });

  it("stores a message whose author has no display name", () => {
    store.append(message("1.1", "anonymous"));
    expect(store.search("anonymous", 10).map(hit => hit.displayName)).toEqual([null]);
  });

  // Slack's Events API delivers at least once. A redelivery must not be a
  // constraint error thrown out of an event handler, and must not rewrite what
  // is already stored.
  it("refuses the same ts twice and keeps the first text", () => {
    expect(store.append(message("1.1", "the original text"))).toBe(true);
    expect(store.append(message("1.1", "a replacement nobody asked for"))).toBe(false);

    expect(found("original")).toEqual(["1.1"]);
    expect(raw(file, db => db.prepare("SELECT count(*) AS n FROM message").get())).toEqual({ n: 1 });
  });

  it("does not index the text of a redelivery it ignored", () => {
    store.append(message("1.1", "the original text"));
    store.append(message("1.1", "a replacement nobody asked for"));

    expect(found("replacement")).toEqual([]);
    expect(indexedRows(file, '"text"')).toBe(1);
  });
});

describe("reading recent messages", () => {
  // Real Slack timestamps here, not the short `1.1` the search tests use. The
  // ordering claim is specifically about Slack's fixed-width format, and
  // asserting it on `1.1`/`1.2` would prove something weaker than what ships.
  const TS = {
    first: "1758000000.000100",
    second: "1758000060.000200",
    third: "1758000120.000300",
    fourth: "1758000180.000400"
  };

  function recent(limit = 10): string[] {
    return store.recent(limit).map(hit => hit.ts);
  }

  it("returns the newest messages, oldest first", () => {
    // Both halves matter and they pull in opposite directions: the *selection*
    // is the tail, and the *order* it comes back in is reading order.
    store.append(message(TS.first, "one"));
    store.append(message(TS.second, "two"));
    store.append(message(TS.third, "three"));

    expect(recent(2)).toEqual([TS.second, TS.third]);
  });

  it("returns everything, oldest first, when there is less than the limit", () => {
    store.append(message(TS.second, "two"));
    store.append(message(TS.first, "one"));

    expect(recent(10)).toEqual([TS.first, TS.second]);
  });

  it("orders by when a message was sent, not by when it was stored", () => {
    // `at` is when this store learned of a message and `id` is insertion order;
    // both diverge from send order the moment an event arrives late or is
    // redelivered. A row inserted last but sent first belongs at the front.
    store.append(message(TS.third, "sent last", { at: 1 }));
    store.append(message(TS.first, "sent first", { at: 9_999 }));

    expect(recent()).toEqual([TS.first, TS.third]);
  });

  it("orders a full Slack timestamp correctly as a string", () => {
    // The assumption the statement rests on: ten digits of seconds, a dot, six
    // more, so lexicographic and numeric order agree. These four differ only in
    // the fractional part, which is where a naive numeric cast loses precision.
    store.append(message(TS.fourth, "four"));
    store.append(message(TS.second, "two"));
    store.append(message(TS.third, "three"));
    store.append(message(TS.first, "one"));

    expect(recent()).toEqual([TS.first, TS.second, TS.third, TS.fourth]);
  });

  it("keeps every field, the way search does", () => {
    const sent = message(TS.first, "we shipped it", {
      threadTs: "1757999999.000000",
      userId: "U0SAM",
      displayName: "Sam",
      at: 42
    });
    store.append(sent);

    expect(store.recent(10)).toEqual([sent]);
  });

  it("returns nothing for an empty channel", () => {
    expect(store.recent(10)).toEqual([]);
  });

  it("does not return a message that was removed", () => {
    store.append(message(TS.first, "one"));
    store.append(message(TS.second, "two"));
    store.remove(TS.first);

    expect(recent()).toEqual([TS.second]);
  });

  it("returns an edited message with its new text", () => {
    store.append(message(TS.first, "the original"));
    store.replaceText(TS.first, "the correction");

    expect(store.recent(10).map(hit => hit.text)).toEqual(["the correction"]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("clamps a limit that is out of range: %s", (_name, limit) => {
    store.append(message(TS.first, "one"));
    store.append(message(TS.second, "two"));

    expect(store.recent(limit).length).toBeGreaterThanOrEqual(1);
    expect(store.recent(limit).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  it("caps the limit at the maximum", () => {
    store.append(message(TS.first, "one"));

    expect(store.recent(10_000).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  it("cannot reach another channel's store", () => {
    // The same claim the search test makes, on the other read. A new read is
    // exactly where a cross-channel query would appear.
    mkdirSync(join(root, OTHER));
    const other = openMessageStore({ channel: OTHER, root });
    other.append(message(TS.first, "in another channel"));

    expect(store.recent(10)).toEqual([]);
    expect(other.recent(10).map(hit => hit.ts)).toEqual([TS.first]);

    other.close();
  });
});

describe("reading one thread", () => {
  // Two threads interleaved in the channel, which is the arrangement that makes
  // the read worth having: reading the channel here returns both conversations
  // shuffled together, and the point of #66 is to answer a reply from its own.
  const ROOT_A = "1758000000.000100";
  const ROOT_B = "1758000030.000100";
  const REPLY_A1 = "1758000060.000200";
  const REPLY_B1 = "1758000090.000200";
  const REPLY_A2 = "1758000120.000300";

  function inThread(thread: string, limit = 10): string[] {
    return store.recentInThread(thread, limit).map(hit => hit.ts);
  }

  beforeEach(() => {
    store.append(message(ROOT_A, "how do we roll back"));
    store.append(message(ROOT_B, "lunch?"));
    store.append(message(REPLY_A1, "revert the tag", { threadTs: ROOT_A }));
    store.append(message(REPLY_B1, "the usual place", { threadTs: ROOT_B }));
    store.append(message(REPLY_A2, "and redeploy", { threadTs: ROOT_A }));
  });

  it("returns the root and its replies, oldest first", () => {
    // The root matches on `ts` and the replies on `thread_ts`. A read that only
    // did the second would drop the message that started the conversation,
    // which is usually the question.
    expect(inThread(ROOT_A)).toEqual([ROOT_A, REPLY_A1, REPLY_A2]);
  });

  it("leaves out another thread in the same channel", () => {
    expect(inThread(ROOT_A)).not.toContain(REPLY_B1);
    expect(inThread(ROOT_B)).toEqual([ROOT_B, REPLY_B1]);
  });

  it("leaves out a top-level message that is in no thread", () => {
    store.append(message("1758000150.000400", "unrelated"));

    expect(inThread(ROOT_A)).toEqual([ROOT_A, REPLY_A1, REPLY_A2]);
  });

  it("returns the newest of a long thread, still oldest first", () => {
    expect(inThread(ROOT_A, 2)).toEqual([REPLY_A1, REPLY_A2]);
  });

  it("keeps every field, the way the other reads do", () => {
    const sent = message("1758000200.000500", "one more", {
      threadTs: ROOT_A,
      userId: "U0SAM",
      displayName: "Sam",
      at: 42
    });
    store.append(sent);

    expect(store.recentInThread(ROOT_A, 1)).toEqual([sent]);
  });

  it("returns nothing for a thread this store has never seen", () => {
    // Not an error: a caller may hold a ts from a conversation that started
    // before this file did, or in a channel whose messages were never stored.
    expect(store.recentInThread("1700000000.000000", 10)).toEqual([]);
  });

  it("does not return a message that was removed", () => {
    store.remove(REPLY_A1);

    expect(inThread(ROOT_A)).toEqual([ROOT_A, REPLY_A2]);
  });

  it("caps the limit at the maximum", () => {
    expect(store.recentInThread(ROOT_A, 10_000).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("clamps a limit that is out of range: %s", (_name, limit) => {
    expect(store.recentInThread(ROOT_A, limit).length).toBeGreaterThanOrEqual(1);
    expect(store.recentInThread(ROOT_A, limit).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  it("cannot reach another channel's store", () => {
    // The third read, and the same claim. A thread id is not a channel id and
    // carries no way to become one: it selects rows inside the one file this
    // store was opened on, and another channel's identical thread is another
    // file.
    mkdirSync(join(root, OTHER));
    const other = openMessageStore({ channel: OTHER, root });
    other.append(message(ROOT_A, "a thread with the same root elsewhere"));

    expect(inThread(ROOT_A)).toEqual([ROOT_A, REPLY_A1, REPLY_A2]);
    expect(other.recentInThread(ROOT_A, 10).map(hit => hit.ts)).toEqual([ROOT_A]);

    other.close();
  });
});

describe("searching", () => {
  beforeEach(() => {
    store.append(message("1.1", "we decided to ship the vault on friday"));
    store.append(message("1.2", "the vault is locked"));
    store.append(message("1.3", "unrelated chatter about lunch"));
    store.append(message("1.4", "Kündigung notice filed"));
  });

  it("finds a message by one of its words", () => {
    expect(found("locked")).toEqual(["1.2"]);
  });

  // The issue's FTS acceptance criterion: a ranked answer over several stored
  // messages.
  it("ranks messages best-match first", () => {
    expect(found("vault")).toEqual(["1.2", "1.1"]);
  });

  it("requires every term rather than any", () => {
    expect(found("vault friday")).toEqual(["1.1"]);
    expect(found("vault lunch")).toEqual([]);
  });

  // Porter. Without stemming this is [], which is the failure mode #64 would
  // hit on its very first question — "what did we decide about the vault".
  it("matches across an inflection", () => {
    expect(found("decide")).toEqual(["1.1"]);
    expect(found("decide vault")).toEqual(["1.1"]);
  });

  it("matches across a diacritic", () => {
    expect(found("Kundigung")).toEqual(["1.4"]);
  });

  it("honours the limit", () => {
    expect(found("vault", 1)).toEqual(["1.2"]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("clamps a limit that is out of range: %s", (_name, limit) => {
    expect(found("vault", limit).length).toBeGreaterThanOrEqual(1);
    expect(found("vault", limit).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  it("caps the limit at the maximum", () => {
    expect(found("vault", 10_000).length).toBeLessThanOrEqual(READ_MAX_LIMIT);
  });

  // An empty MATCH is a syntax error in FTS5. Answering with no rows is the
  // only sane thing for a caller that typed nothing.
  it.each([["empty", ""], ["whitespace", "   "]])(
    "answers nothing for a query with no terms: %s",
    (_name, query) => {
      expect(() => store.search(query, 10)).not.toThrow();
      expect(found(query)).toEqual([]);
    }
  );

  it("answers nothing for a query that is only punctuation", () => {
    expect(found("---")).toEqual([]);
  });

  // A zero-token chunk is a no-op inside the implicit AND rather than a term
  // that matches nothing. Stated as a test so nobody rediscovers it as a bug.
  it("ignores a punctuation-only term beside a real one", () => {
    expect(found("vault ---")).toEqual(found("vault"));
  });
});

describe("the query is text and not an expression", () => {
  it("quotes every term and doubles an embedded quote", () => {
    expect(toMatchQuery("vault friday")).toBe('"vault" "friday"');
    expect(toMatchQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it("answers undefined for a query with no terms", () => {
    expect(toMatchQuery("")).toBeUndefined();
    expect(toMatchQuery("   ")).toBeUndefined();
  });

  it("caps the number of terms", () => {
    const query = toMatchQuery("term ".repeat(SEARCH_MAX_TERMS + 10));
    expect(query?.split(" ").length).toBe(SEARCH_MAX_TERMS);
  });

  // The second builder, added for `searchSkills` in #292. Same escaping, same
  // bounds, different joiner — and the joiner is the whole of the difference,
  // which is why these assert against `toMatchQuery` rather than in isolation.
  describe("toAnyMatchQuery", () => {
    it("escapes exactly as the conjunctive builder does", () => {
      expect(toAnyMatchQuery('say "hi"')).toBe('"say" OR """hi"""');
    });

    it("joins the terms with OR", () => {
      expect(toAnyMatchQuery("vault friday")).toBe('"vault" OR "friday"');
    });

    it("answers undefined for a query with no terms", () => {
      expect(toAnyMatchQuery("")).toBeUndefined();
      expect(toAnyMatchQuery("   ")).toBeUndefined();
    });

    it("caps the number of terms on the same bound", () => {
      const query = toAnyMatchQuery("term ".repeat(SEARCH_MAX_TERMS + 10));
      expect(query?.split(" OR ").length).toBe(SEARCH_MAX_TERMS);
    });

    it("is one term, indistinguishable from the other builder, for a single word", () => {
      expect(toAnyMatchQuery("vault")).toBe(toMatchQuery("vault"));
    });

    // The operators `toMatchQuery`'s own table covers, checked again here
    // because a joiner that is itself an FTS5 keyword is the one place these two
    // could diverge in behaviour rather than only in shape.
    it.each([["AND"], ["OR"], ["NOT"], ["NEAR"]])("still quotes a bare %s", operator => {
      expect(toAnyMatchQuery(`vault ${operator}`)).toBe(`"vault" OR "${operator}"`);
    });
  });

  // Each of these is a syntax error, or a different query than the caller
  // meant, if it reaches MATCH unescaped. None may throw and none may change
  // the semantics.
  describe("against a corpus", () => {
    beforeEach(() => {
      store.append(message("1.1", "the vault holds a secret"));
      store.append(message("1.2", "vaulted arches"));
      store.append(message("1.3", "we shipped it"));
    });

    it.each([["AND"], ["OR"], ["NOT"], ["NEAR"]])("survives a bare %s", operator => {
      expect(() => store.search(operator, 10)).not.toThrow();
      expect(found(operator)).toEqual([]);
    });

    it("survives an unbalanced quote", () => {
      expect(() => store.search('"unbalanced', 10)).not.toThrow();
      expect(found('"unbalanced')).toEqual([]);
    });

    // The star must be inert. Note the corpus: `vault` and `vaulted` stem
    // together under porter, so asserting on those two would pass whether or
    // not the star survived. `ship` and `shipment` do not both appear, so a
    // prefix query is the only way `shi*` could match anything.
    it("does not let a trailing star become a prefix query", () => {
      expect(found("shipped")).toEqual(["1.3"]);
      expect(found("shi*")).toEqual([]);
    });

    it("does not let a leading caret anchor to the column start", () => {
      // `^the` as an expression anchors; as a term it is the word `the`, which
      // is in 1.1 but not at the start of 1.3. Either way it must not throw,
      // and it must find by word rather than by position.
      expect(() => store.search("^holds", 10)).not.toThrow();
      expect(found("^holds")).toEqual(["1.1"]);
    });

    // The dangerous one: a colon outside quotes is a column filter, and it
    // parses and runs. This is why wrapping the whole query in one pair of
    // quotes is not enough.
    it("does not let a colon become a column filter", () => {
      expect(found("text:vault")).toEqual([]);
      // Sorted: what matters here is that the bare term still reaches both
      // messages, not which of them bm25 puts first.
      expect(found("vault").sort()).toEqual(["1.1", "1.2"]);
    });
  });
});

describe("the index follows the table", () => {
  beforeEach(() => {
    store.append(message("1.1", "the vault is locked"));
    store.append(message("1.2", "the vault is open"));
  });

  // The issue's deletion acceptance criterion: the row leaving takes its index
  // entry with it.
  it("drops the index entry when a message is deleted", () => {
    expect(indexedRows(file, '"locked"')).toBe(1);

    expect(store.remove("1.1")).toBe(true);

    expect(indexedRows(file, '"locked"')).toBe(0);
    expect(raw(file, db => db.prepare("SELECT count(*) AS n FROM message").get())).toEqual({ n: 1 });
  });

  it("leaves other messages searchable after a deletion", () => {
    store.remove("1.1");
    expect(found("vault")).toEqual(["1.2"]);
  });

  it("answers false for deleting a ts it does not hold", () => {
    expect(store.remove("9.9")).toBe(false);
  });

  it("reindexes on an edit and forgets the old text", () => {
    expect(store.replaceText("1.1", "the vault was decommissioned")).toBe(true);

    expect(found("locked")).toEqual([]);
    expect(found("decommissioned")).toEqual(["1.1"]);
  });

  it("answers false for editing a ts it does not hold", () => {
    expect(store.replaceText("9.9", "nothing to replace")).toBe(false);
  });

  // The trigger fires on any UPDATE, not only one this module made. That
  // breadth is the reason it is written the way it is: an external-content
  // index desynchronized by an outside write raises nothing at all.
  it("keeps the index in step for an update made outside this module", () => {
    raw(file, db => {
      db.prepare("UPDATE message SET text = ? WHERE ts = ?").run("rewritten by hand", "1.1");
    });

    expect(found("locked")).toEqual([]);
    expect(found("rewritten")).toEqual(["1.1"]);
  });

  // The only assertion that would catch a trigger written correctly for the
  // cases above and wrongly for one they do not reach.
  it("passes an integrity check after inserts, deletes, and edits", () => {
    store.replaceText("1.1", "edited once");
    store.remove("1.2");
    store.append(message("1.3", "and one more"));

    expect(() =>
      raw(file, db => {
        db.exec("INSERT INTO message_fts(message_fts) VALUES('integrity-check')");
      })
    ).not.toThrow();
  });
});

describe("FTS5 availability", () => {
  // A canary. If a CI image ever ships a Node without FTS5, this is the test
  // that says so in one line instead of thirty failing on `no such module`.
  it("is present in this Node build", () => {
    expect(() => assertFts5(new DatabaseSync(":memory:"), "canary")).not.toThrow();
  });

  // The branch this Node cannot reach, which is the one an operator would hit.
  it("names the Node floor when the build has no FTS5", () => {
    const without = { prepare: () => ({ get: () => ({ enabled: 0 }) }) };

    expect(() => assertFts5(without as never, "/state/C0ENG/store.db")).toThrow(/FTS5/);
    expect(() => assertFts5(without as never, "/state/C0ENG/store.db")).toThrow(/Node >= 24/);
  });
});

describe("sqlite-vec availability", () => {
  // `assertFts5`'s canary, one layer down. If a base image or a platform ever
  // stops carrying a loadable vec0, this is the line that says which.
  it("loads into this build", () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      expect(() => loadVec(db, "canary")).not.toThrow();
      expect(db.prepare("SELECT vec_version() AS v").get()).toMatchObject({
        v: expect.stringMatching(/^v\d+\.\d+\.\d+/) as unknown as string
      });
    } finally {
      db.close();
    }
  });

  // The branch a musl image reaches and this machine cannot: `dlopen` refuses.
  // The message has to name the libc cause, because that is the whole reason the
  // images are Debian and the next person to try Alpine needs to be told.
  it("names the platform and the libc cause when the extension will not load", () => {
    const failing = {
      loadExtension: () => {
        throw new Error("Error relocating vec0.so: __memcpy_chk: symbol not found");
      }
    };

    expect(() => loadVec(failing as never, "/state/C0ENG/store.db")).toThrow(/sqlite-vec/);
    expect(() => loadVec(failing as never, "/state/C0ENG/store.db")).toThrow(/glibc/);
    expect(() => loadVec(failing as never, "/state/C0ENG/store.db")).toThrow(
      new RegExp(`${process.platform}-${process.arch}`)
    );
    expect(() => loadVec(failing as never, "/state/C0ENG/store.db")).toThrow(
      /\/state\/C0ENG\/store\.db/
    );
  });

  // The flag both openers now pass widens one thing and not the other, and this
  // is the assertion that pins which. If a future Node authorized the SQL
  // function, the header's argument for letting the *reader* hold the flag would
  // stop being true — so it is asserted rather than described.
  it("does not authorize the SQL load_extension() function, with or without the flag", () => {
    for (const allowExtension of [false, true]) {
      const db = new DatabaseSync(":memory:", { allowExtension });
      try {
        expect(() => db.exec("SELECT load_extension('/anything.so')")).toThrow(/not authorized/);
      } finally {
        db.close();
      }
    }
  });

  // And the door closes behind the open sequence. Defence in depth rather than
  // the mechanism, but a test because it is one line to delete by accident.
  it("can be closed again with enableLoadExtension(false)", () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      db.enableLoadExtension(false);
      expect(() => db.loadExtension("/anything.so")).toThrow(/not allowed/);
    } finally {
      db.close();
    }
  });
});

describe("storing embeddings", () => {
  const vector = (...values: number[]): Float32Array => Float32Array.from(values);

  /** The names of every vec0 table in the file, read past the module's API. */
  function vecTables(path: string): string[] {
    return raw(path, db =>
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%'`)
        .all()
        .map(row => (row as { name: string }).name)
    );
  }

  /** What `nearest` found, as `kind/ref`, nearest first. */
  function near(query: Float32Array, limit = 10): string[] {
    return store.nearest(query, limit).map(hit => `${hit.source.kind}/${hit.source.ref}`);
  }

  /** The same, of one kind only. */
  function nearOfKind(
    query: Float32Array,
    limit: number,
    kind: "fact" | "summary" | "skill"
  ): string[] {
    return store.nearest(query, limit, kind).map(hit => `${hit.source.kind}/${hit.source.ref}`);
  }

  // **The regression this filter exists to prevent, and the reason it is a
  // parameter rather than something a caller does afterwards.** Every kind
  // shares one `vec_embedding`, and `k` is spent inside the vec0 match — so a
  // caller asking for five and filtering after the fact gets whatever survives,
  // which against a corpus dominated by another kind is nothing at all. A recall
  // that quietly returns nothing looks like a channel with no memory rather than
  // like a bug, which is why this is asserted here rather than left to the
  // caller's own tests.
  describe("one corpus among several", () => {
    beforeEach(() => {
      // Every skill is nearer to the query than any summary is, so an unfiltered
      // k-NN of five is five skills.
      for (let index = 0; index < 100; index += 1) {
        store.putEmbedding({
          source: { kind: "skill", ref: `skill-${String(index).padStart(3, "0")}` },
          vector: vector(1, 0.001 * index, 0),
          model: "text-embedding-3-small",
          at: 1
        });
      }
      for (let index = 0; index < 3; index += 1) {
        store.putEmbedding({
          source: { kind: "summary", ref: `1.${String(index)}` },
          vector: vector(0, 1, 0.001 * index),
          model: "text-embedding-3-small",
          at: 1
        });
      }
    });

    it("would answer entirely in the wrong kind without a filter", () => {
      const unfiltered = near(vector(1, 0, 0), 5);
      expect(unfiltered).toHaveLength(5);
      expect(unfiltered.every(hit => hit.startsWith("skill/"))).toBe(true);
    });

    it("still finds every summary with a hundred skill vectors present", () => {
      const hits = nearOfKind(vector(1, 0, 0), 5, "summary");
      expect(hits).toHaveLength(3);
      expect(hits.every(hit => hit.startsWith("summary/"))).toBe(true);
    });

    it("finds skills without summaries getting in the way", () => {
      const hits = nearOfKind(vector(0, 1, 0), 5, "skill");
      expect(hits).toHaveLength(5);
      expect(hits.every(hit => hit.startsWith("skill/"))).toBe(true);
    });

    it("answers nothing for a kind this file holds none of", () => {
      expect(nearOfKind(vector(1, 0, 0), 5, "fact")).toEqual([]);
    });

    // Over-fetch is best-effort and the file says so; what it must never do is
    // hand back more than was asked for, or a hit of another kind.
    it("never answers with more than the limit", () => {
      expect(nearOfKind(vector(1, 0, 0), 2, "skill")).toHaveLength(2);
    });

    // An unfiltered read is unchanged, so nothing already calling it pays for a
    // filter it did not ask for.
    it("leaves an unfiltered read exactly as it was", () => {
      expect(near(vector(1, 0, 0), 3)).toHaveLength(3);
    });
  });

  // The lazy half of the design, and the reason it is lazy: a deployment running
  // Layers 1 and 2 has no embedding provider and should carry no table for one.
  it("creates no vec table until the first vector arrives", () => {
    store.append(message("1.1", "a message, but no embedding"));
    expect(vecTables(file)).toEqual([]);

    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "text-embedding-3-small",
      at: 1
    });

    expect(vecTables(file)).toContain("vec_embedding");
  });

  // The case FTS cannot answer, in the only form this layer can be tested in:
  // synthetic vectors. Whether a real model puts "we shipped the vault" near
  // "what did we decide about deployment" is #230's and #232's to demonstrate;
  // what this file owes is that the nearest vector comes back first.
  it("answers nearest-neighbour queries in distance order, with provenance", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "s1" },
      vector: vector(0.9, 0.1, 0),
      model: "m1",
      at: 2
    });
    store.putEmbedding({
      source: { kind: "fact", ref: "f2" },
      vector: vector(0, 1, 0),
      model: "m1",
      at: 3
    });

    expect(near(vector(1, 0, 0))).toEqual(["fact/f1", "summary/s1", "fact/f2"]);
    expect(near(vector(0, 1, 0))).toEqual(["fact/f2", "summary/s1", "fact/f1"]);
  });

  it("returns a distance, ascending", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });
    store.putEmbedding({
      source: { kind: "fact", ref: "f2" },
      vector: vector(0, 1, 0),
      model: "m1",
      at: 2
    });

    const hits = store.nearest(vector(1, 0, 0), 2);
    expect(hits[0]?.distance).toBe(0);
    expect(hits[1]?.distance).toBeGreaterThan(0);
  });

  // The UNIQUE on (kind, ref) doing its job. #231 re-embeds a summary whose
  // source messages changed, and two answers to one question is the failure.
  it("replaces the vector for a source it already holds", () => {
    const source = { kind: "summary", ref: "s1" } as const;
    store.putEmbedding({ source, vector: vector(1, 0, 0), model: "m1", at: 1 });
    store.putEmbedding({ source, vector: vector(0, 0, 1), model: "m1", at: 2 });

    expect(near(vector(0, 0, 1))).toEqual(["summary/s1"]);
    expect(store.nearest(vector(0, 0, 1), 50)).toHaveLength(1);
    expect(store.nearest(vector(0, 0, 1), 50)[0]?.distance).toBe(0);
  });

  // The trigger, which is what #233 will attach a Slack deletion to. Asserted
  // through the file rather than through `nearest`, because the thing at stake
  // is that no vector row outlives its provenance.
  it("removes the vector with the source, through the trigger", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });
    store.putEmbedding({
      source: { kind: "fact", ref: "f2" },
      vector: vector(0, 1, 0),
      model: "m1",
      at: 2
    });

    // The positive control: both are there before anything is deleted.
    expect(near(vector(1, 0, 0))).toEqual(["fact/f1", "fact/f2"]);

    expect(store.removeEmbedding({ kind: "fact", ref: "f2" })).toBe(true);

    expect(near(vector(1, 0, 0))).toEqual(["fact/f1"]);
    expect(
      rawVec(file, db =>
        Number((db.prepare("SELECT count(*) AS n FROM vec_embedding").get() as { n: number }).n)
      )
    ).toBe(1);
  });

  it("answers false when removing a source it does not hold", () => {
    expect(store.removeEmbedding({ kind: "fact", ref: "never-stored" })).toBe(false);
  });

  // A store under a deployment with no embedding provider. Neither read nor
  // delete may throw on it — the vec table's absence is the ordinary state, not
  // a broken file, exactly as `openMessageReader` answers null rather than
  // throwing for a channel with no store.
  it("reads and deletes without a vec table, rather than throwing", () => {
    expect(store.nearest(vector(1, 0, 0), 5)).toEqual([]);
    expect(store.removeEmbedding({ kind: "fact", ref: "f1" })).toBe(false);
  });

  it("clamps the neighbour count to READ_MAX_LIMIT", () => {
    for (let i = 0; i < 5; i++) {
      store.putEmbedding({
        source: { kind: "fact", ref: `f${i}` },
        vector: vector(i, 1, 0),
        model: "m1",
        at: i
      });
    }

    expect(store.nearest(vector(0, 1, 0), READ_MAX_LIMIT + 1_000)).toHaveLength(5);
    expect(store.nearest(vector(0, 1, 0), 0)).toHaveLength(1);
  });

  // The width is baked into the vec table at creation, so the file can only hold
  // one. Both halves of the refusal name what was found and what was given,
  // because the remedy is a rebuild and an operator cannot decide on that
  // without both numbers.
  it("refuses a vector of a different width, naming both", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });

    expect(() =>
      store.putEmbedding({
        source: { kind: "fact", ref: "f2" },
        vector: vector(1, 0),
        model: "m1",
        at: 2
      })
    ).toThrow(/holds vectors from "m1" at 3 dimensions, and was given "m1" at 2/);
  });

  it("refuses a vector from a different model, naming both", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });

    expect(() =>
      store.putEmbedding({
        source: { kind: "fact", ref: "f2" },
        vector: vector(0, 1, 0),
        model: "m2",
        at: 2
      })
    ).toThrow(/holds vectors from "m1" at 3 dimensions, and was given "m2" at 3/);
  });

  // `dims` is the one value in the module substituted into SQL rather than
  // bound, so the check that keeps it a whole number in range is the check that
  // keeps that safe.
  it("refuses a width outside the buildable range, before any DDL runs", () => {
    expect(() =>
      store.putEmbedding({
        source: { kind: "fact", ref: "f1" },
        vector: new Float32Array(MAX_EMBEDDING_DIMS + 1),
        model: "m1",
        at: 1
      })
    ).toThrow(new RegExp(`whole widths in \\[1, ${MAX_EMBEDDING_DIMS}\\]`));

    expect(() =>
      store.putEmbedding({
        source: { kind: "fact", ref: "f1" },
        vector: new Float32Array(0),
        model: "m1",
        at: 1
      })
    ).toThrow(/whole widths/);

    expect(vecTables(file)).toEqual([]);
  });

  // A vector produced by `subarray` shares its neighbour's backing store, which
  // is why `toVectorBlob` passes byteOffset and byteLength. Without them this
  // hands vec0 the whole allocation and the insert fails on a width nobody asked
  // for — still true on 24.0.0, 24.19.0 and 26.7.0, so this case discriminates.
  //
  // What it does not discriminate, and #309 is where that was measured: deleting
  // `toVectorBlob` outright and binding the `Float32Array` itself passes on all
  // three, because `node:sqlite` honours a view's offset and length. The case is
  // a guard on how the conversion is written, not on there being one.
  it("stores a vector that is a view into a larger buffer", () => {
    const backing = Float32Array.from([9, 9, 1, 0, 0, 9]);
    const view = backing.subarray(2, 5);

    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: view,
      model: "m1",
      at: 1
    });

    expect(store.nearest(vector(1, 0, 0), 1)[0]?.distance).toBe(0);
  });

  // Two indexes over one file, neither aware of the other. The FTS canary is the
  // existing test one describe up; running it against a file that also has a vec
  // table is what says adding the second did not corrupt the first.
  it("leaves the FTS index intact on a file that also holds vectors", () => {
    store.append(message("1.1", "the vault ships friday"));
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });

    expect(() =>
      raw(file, db => {
        db.exec("INSERT INTO message_fts(message_fts) VALUES('integrity-check')");
      })
    ).not.toThrow();
    expect(found("vault")).toEqual(["1.1"]);
  });

  // Survives a close. The vec table and the model stamp are on disk, so a second
  // open holds a file it must agree with rather than one it may re-stamp.
  it("holds its model and vectors across a reopen", () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: vector(1, 0, 0),
      model: "m1",
      at: 1
    });
    store.close();

    store = openMessageStore({ channel: CHANNEL, root });

    expect(near(vector(1, 0, 0))).toEqual(["fact/f1"]);
    expect(() =>
      store.putEmbedding({
        source: { kind: "fact", ref: "f2" },
        vector: vector(1, 0),
        model: "m1",
        at: 2
      })
    ).toThrow(/holds vectors from "m1" at 3 dimensions/);
  });
});

describe("a file that holds vectors, read by a build that cannot", () => {
  // The measurement the version constant's doc block rests on, kept as a test so
  // that the decision not to bump the schema version stays checkable rather than
  // remembered. A connection with vec0 *not* loaded still answers every question
  // this module asks of the file, and fails only on the vec table itself.
  it("still answers every non-vector statement", () => {
    store.append(message("1.1", "the vault ships friday"));
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "m1",
      at: 1
    });
    store.close();

    const blind = new DatabaseSync(file, { readOnly: true });
    try {
      expect(blind.prepare("SELECT text FROM message").all()).toEqual([
        { text: "the vault ships friday" }
      ]);
      expect(
        blind.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH ?").all("vault")
      ).toHaveLength(1);
      expect(() => blind.prepare("SELECT id FROM vec_embedding").all()).toThrow(
        /no such module: vec0/
      );
    } finally {
      blind.close();
    }

    store = openMessageStore({ channel: CHANNEL, root });
  });
});

describe("thread summaries", () => {
  /** Every summary row, read past the module's API. */
  function rows(): Array<{ thread_ts: string; shape: string; covers_through_ts: string }> {
    return raw(file, db =>
      db
        .prepare("SELECT thread_ts, shape, covers_through_ts FROM thread_summary ORDER BY thread_ts")
        .all()
    ) as Array<{ thread_ts: string; shape: string; covers_through_ts: string }>;
  }

  const summary = (thread: string, through: string, shape = "decision" as const) => ({
    thread,
    shape,
    text: "Chose slim over alpine.",
    coversThroughTs: through,
    messageCount: 2,
    at: 1_700_000_000_000
  });

  it("finds a thread with no summary", () => {
    store.append(message("1.1", "how do we rotate a cert?"));
    store.append(message("1.2", "--rotate then --promote", { threadTs: "1.1" }));

    expect(store.staleThreads("9.9", 10)).toEqual([
      { thread: "1.1", newestTs: "1.2", messageCount: 2 }
    ]);
  });

  // A root carries `thread_ts = NULL` and its replies carry the root's `ts`, so
  // the grouping key is the COALESCE and not a column — which is why
  // `message_root` indexes the expression.
  it("groups a root with its replies and a top-level message alone", () => {
    store.append(message("1.1", "root"));
    store.append(message("1.2", "reply", { threadTs: "1.1" }));
    store.append(message("2.1", "unrelated"));

    expect(store.staleThreads("9.9", 10).map(thread => thread.thread)).toEqual(["2.1", "1.1"]);
  });

  // Quietness is a property of the thread's newest message, not of any one row —
  // which is why the statement uses HAVING. A WHERE would drop the recent
  // messages and then summarize the thread as though it had ended earlier.
  it("excludes a thread whose newest message is not yet old enough", () => {
    store.append(message("1.1", "started long ago"));
    store.append(message("5.5", "said something just now", { threadTs: "1.1" }));

    expect(store.staleThreads("3.0", 10)).toEqual([]);
  });

  it("excludes a thread whose summary covers its newest message", () => {
    store.append(message("1.1", "root"));
    store.append(message("1.2", "reply", { threadTs: "1.1" }));
    store.putThreadSummary(summary("1.1", "1.2"));

    expect(store.staleThreads("9.9", 10)).toEqual([]);
  });

  it("finds a thread again once it has said more than its summary covers", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary(summary("1.1", "1.1"));
    store.append(message("1.2", "and one more thing", { threadTs: "1.1" }));

    expect(store.staleThreads("9.9", 10)).toEqual([
      { thread: "1.1", newestTs: "1.2", messageCount: 2 }
    ]);
  });

  // Without the row, the sweep offers the same silent thread every time and pays
  // a model call to conclude "nothing" again, forever.
  it("keeps a `nothing` row, so the thread is not offered again", () => {
    store.append(message("1.1", "deploying now"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "nothing",
      text: "",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });

    expect(store.staleThreads("9.9", 10)).toEqual([]);
    expect(rows()).toEqual([
      { thread_ts: "1.1", shape: "nothing", covers_through_ts: "1.1" }
    ]);
  });

  it("replaces a thread's summary rather than keeping two", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary(summary("1.1", "1.1"));
    store.putThreadSummary({ ...summary("1.1", "1.1"), shape: "incident" });

    expect(rows()).toEqual([{ thread_ts: "1.1", shape: "incident", covers_through_ts: "1.1" }]);
  });

  it("answers newest first, so a backlog is worked from the recent end", () => {
    store.append(message("1.1", "oldest"));
    store.append(message("2.1", "middle"));
    store.append(message("3.1", "newest"));

    expect(store.staleThreads("9.9", 10).map(thread => thread.thread)).toEqual([
      "3.1",
      "2.1",
      "1.1"
    ]);
  });

  it("clamps the sweep's limit to READ_MAX_LIMIT", () => {
    store.append(message("1.1", "one"));
    expect(store.staleThreads("9.9", READ_MAX_LIMIT + 1_000)).toHaveLength(1);
  });

  // The triggers. A summary must not outlive the words it was drawn from, and
  // this is `message_fts`'s argument applied to a second derived thing.
  it("drops a summary when one of its messages is deleted", () => {
    store.append(message("1.1", "root"));
    store.append(message("1.2", "reply", { threadTs: "1.1" }));
    store.putThreadSummary(summary("1.1", "1.2"));

    expect(rows()).toHaveLength(1);
    store.remove("1.2");
    expect(rows()).toEqual([]);
  });

  it("drops a summary when one of its messages is edited", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary(summary("1.1", "1.1"));

    expect(rows()).toHaveLength(1);
    store.replaceText("1.1", "actually, something else");
    expect(rows()).toEqual([]);
  });

  // The second link of the chain, and the reason `thread_summary_delete` exists:
  // a vector standing for a retracted summary is the same failure one level down.
  it("drops the summary's vector with the summary", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary(summary("1.1", "1.1"));
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "m1",
      at: 1
    });

    // The positive control: it was reachable before the edit.
    expect(store.nearest(Float32Array.from([1, 0, 0]), 5)).toHaveLength(1);

    store.replaceText("1.1", "actually, something else");

    expect(store.nearest(Float32Array.from([1, 0, 0]), 5)).toEqual([]);
  });

  // A fact's vector is not a summary's, and one thread's edit must not reach it.
  it("leaves other sources' vectors alone", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary(summary("1.1", "1.1"));
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "m1",
      at: 1
    });
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: Float32Array.from([0, 1, 0]),
      model: "m1",
      at: 1
    });

    store.replaceText("1.1", "edited");

    expect(store.nearest(Float32Array.from([0, 1, 0]), 5).map(hit => hit.source)).toEqual([
      { kind: "fact", ref: "f1" }
    ]);
  });
});

// #319's pregate. The sweep's read answers "quiet and unsummarized"; this one
// answers "quiet and new since the caller last looked", and the difference is
// what these cases are about.
describe("idle threads, for a caller with a watermark", () => {
  const summary = (thread: string, through: string) => ({
    thread,
    shape: "decision" as const,
    text: "Chose slim over alpine.",
    coversThroughTs: through,
    messageCount: 2,
    at: 1_700_000_000_000
  });

  it("finds a thread that has gone quiet", () => {
    store.append(message("1.1", "how do we rotate a cert?"));
    store.append(message("1.2", "--rotate then --promote", { threadTs: "1.1" }));

    expect(store.idleThreads("9.9", "0.0", 10)).toEqual([{ thread: "1.1", newestTs: "1.2" }]);
  });

  // The load-bearing difference from `staleThreads`. A channel that summarizes
  // its quiet threads would answer nothing there, which would blind the one
  // feature that exists for the question nobody replied to.
  it("still finds a thread that has already been summarized", () => {
    store.append(message("1.1", "how do we rotate a cert?"));
    store.append(message("1.2", "--rotate then --promote", { threadTs: "1.1" }));
    store.putThreadSummary(summary("1.1", "1.2"));

    expect(store.staleThreads("9.9", 10)).toEqual([]);
    expect(store.idleThreads("9.9", "0.0", 10)).toEqual([{ thread: "1.1", newestTs: "1.2" }]);
  });

  it("excludes a thread that has not gone quiet yet", () => {
    store.append(message("1.1", "started long ago"));
    store.append(message("5.5", "said something just now", { threadTs: "1.1" }));

    expect(store.idleThreads("3.0", "0.0", 10)).toEqual([]);
  });

  // The watermark, which is what makes a finding say-once: a thread the caller
  // has already weighed sits below it and never comes back.
  it("excludes a thread the caller has already looked past", () => {
    store.append(message("1.1", "asked on Friday"));
    store.append(message("1.2", "still nothing", { threadTs: "1.1" }));

    expect(store.idleThreads("9.9", "1.2", 10)).toEqual([]);
    expect(store.idleThreads("9.9", "1.1", 10)).toEqual([{ thread: "1.1", newestTs: "1.2" }]);
  });

  // And a thread that says something more rises back above the watermark, goes
  // quiet again, and is offered again. Say-once is per silence, not forever.
  it("offers a thread again once it has said something new", () => {
    store.append(message("1.1", "asked on Friday"));
    store.append(message("1.2", "still nothing", { threadTs: "1.1" }));
    expect(store.idleThreads("9.9", "1.2", 10)).toEqual([]);

    store.append(message("3.0", "any update?", { threadTs: "1.1" }));

    expect(store.idleThreads("9.9", "1.2", 10)).toEqual([{ thread: "1.1", newestTs: "3.0" }]);
  });

  // Both bounds are on the aggregate, for the sweep's reason: the question is
  // about the thread's newest message, so a filter on rows would answer it about
  // a thread that only looked idle because its recent messages were dropped.
  it("bounds on the thread's newest message and not on any one row", () => {
    store.append(message("1.1", "root, long ago"));
    store.append(message("8.8", "and a reply just now", { threadTs: "1.1" }));

    // A row-level filter would see "1.1" alone, call the thread idle, and offer
    // it. The aggregate sees "8.8" and does not.
    expect(store.idleThreads("5.0", "0.0", 10)).toEqual([]);
  });

  it("groups a root with its replies, newest first, and clamps the limit", () => {
    store.append(message("1.1", "root"));
    store.append(message("1.2", "reply", { threadTs: "1.1" }));
    store.append(message("2.1", "unrelated"));

    expect(store.idleThreads("9.9", "0.0", 10).map(thread => thread.thread)).toEqual(["2.1", "1.1"]);
    expect(store.idleThreads("9.9", "0.0", 1)).toHaveLength(1);
  });
});

describe("reading one thread's summary", () => {
  it("answers what was stored", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "question_answered",
      text: "Q: how do you rotate a cert? A: --rotate then --promote.",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1_700_000_000_000
    });

    expect(store.readThreadSummary("1.1")).toEqual({
      thread: "1.1",
      shape: "question_answered",
      text: "Q: how do you rotate a cert? A: --rotate then --promote.",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1_700_000_000_000
    });
  });

  // A real state and not a broken one: a vector outlives its summary for as long
  // as it takes a trigger to fire, so a caller resolving a hit whose summary has
  // gone should skip it rather than fail.
  it("answers null for a thread it has no summary for", () => {
    expect(store.readThreadSummary("1.1")).toBeNull();
  });

  it("answers null once an edit has invalidated the summary", () => {
    store.append(message("1.1", "root"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "decision",
      text: "Chose slim.",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });

    expect(store.readThreadSummary("1.1")).not.toBeNull();
    store.replaceText("1.1", "actually, something else");
    expect(store.readThreadSummary("1.1")).toBeNull();
  });
});

// #320's say-once ledger. The row beside it records that a pair was considered,
// which is a fact about spend; this records that people were told, which is a
// fact about a channel.
describe("telling a channel about a proposal, once", () => {
  const pair = { a: "deploy-runbook", b: "deploy-rollback" };

  it("answers no before anything was said, and yes after", () => {
    expect(store.skillMergeNoticed(pair)).toBe(false);

    store.recordSkillMergeNotice(pair, 1_700_000_000_000);

    expect(store.skillMergeNoticed(pair)).toBe(true);
  });

  it("is idempotent, so a retried notice is not a second row", () => {
    store.recordSkillMergeNotice(pair, 1_700_000_000_000);
    store.recordSkillMergeNotice(pair, 1_700_000_009_999);

    expect(store.skillMergeNoticed(pair)).toBe(true);
  });

  it("is per pair, and the two names are ordered by the caller", () => {
    store.recordSkillMergeNotice(pair, 1_700_000_000_000);

    expect(store.skillMergeNoticed({ a: "deploy-runbook", b: "cert-rotation" })).toBe(false);
    // The caller names the pair in the order the filename does, so this is the
    // other pair rather than the same one backwards.
    expect(store.skillMergeNoticed({ a: pair.b, b: pair.a })).toBe(false);
  });

  // Declining a proposal is deleting the file. If forgetting the considered row
  // also forgot the notice, deletion would become a way to be asked again — the
  // one thing declining must not mean.
  it("survives the considered row being forgotten", () => {
    store.recordSkillMergeConsidered({ ...pair, hashA: "h1", hashB: "h2" }, 1_700_000_000_000);
    store.recordSkillMergeNotice(pair, 1_700_000_000_000);

    store.forgetSkillMergeProposal(pair);

    expect(store.skillMergeNoticed(pair)).toBe(true);
  });

  it("is independent of whether the pair was ever considered", () => {
    // Both directions: a considered pair that produced no draft is never
    // announced, and this table knows nothing about that one.
    store.recordSkillMergeConsidered({ ...pair, hashA: "h1", hashB: "h2" }, 1_700_000_000_000);

    expect(store.skillMergeNoticed(pair)).toBe(false);
  });
});

// #323. What the tool proxy service governs and this side records, and the two
// halves are deliberately tested through two handles on one file: the writer is
// the agent's and the count is the proxy's, and a test that used one handle for
// both would prove the module agrees with itself rather than that the two
// processes agree.
describe("scheduled checks", () => {
  const ticket = (id: string, extra: Partial<StoredScheduledTask> = {}): StoredScheduledTask => ({
    id,
    task: "task-7",
    prompt: "check whether the release branch is still red",
    dueAt: 1_800_000_000_000,
    createdAt: 1_700_000_000_000,
    ...extra
  });

  const pending = (): number => {
    const reader = openMessageReader({ channel: CHANNEL, root });
    const count = reader?.pendingScheduledTasks() ?? -1;
    reader?.close();
    return count;
  };

  it("is counted by a reader on the same file", () => {
    expect(pending()).toBe(0);

    store.scheduleTask(ticket("a"));
    store.scheduleTask(ticket("b"));

    expect(pending()).toBe(2);
  });

  // First-write-wins on the proxy's minted id: an approved re-submission carries
  // the same ticket, and scheduling the check twice would be one click buying
  // two.
  it("writes one row for one id, however often it is written", () => {
    store.scheduleTask(ticket("a"));
    store.scheduleTask(ticket("a", { prompt: "something else entirely" }));

    expect(pending()).toBe(1);
    const rows = new DatabaseSync(file, { readOnly: true })
      .prepare(`SELECT prompt FROM scheduled_task WHERE id = 'a'`)
      .all() as Array<{ prompt: string }>;
    expect(rows[0]?.prompt).toContain("release branch");
  });

  // Pending is the absence of a fire stamp, which is the rule the DDL argues:
  // there is no status value, so nothing but a fire can consume a ticket.
  it("stops counting a row once it has fired", () => {
    store.scheduleTask(ticket("a"));
    store.scheduleTask(ticket("b"));

    const db = new DatabaseSync(file);
    db.prepare(`UPDATE scheduled_task SET fired_at = ?, outcome = ? WHERE id = 'a'`).run(1, "posted");
    db.close();

    expect(pending()).toBe(1);
  });

  // The guard the reader opens with. A store written before this table existed
  // is the ordinary state of every channel on the day this deploys, and a
  // reader that threw would take `search_channel_history` down with it — for a
  // channel that has no scheduled checks by definition.
  it("answers zero, and still searches, on a store with no such table", () => {
    store.append(message("1.1", "the vault is locked"));
    store.close();

    const db = new DatabaseSync(file);
    db.exec("DROP TABLE scheduled_task");
    db.close();

    const reader = openMessageReader({ channel: CHANNEL, root });
    expect(reader?.pendingScheduledTasks()).toBe(0);
    expect(reader?.search("vault", 10).map(hit => hit.ts)).toEqual(["1.1"]);
    reader?.close();

    // Reopened so `afterEach` has a live handle to close.
    store = openMessageStore({ channel: CHANNEL, root });
  });

  // Additive DDL, and the version is what a reader depends on. #229, #290 and
  // #295 each added tables without moving it; this is the fourth, measured the
  // same way.
  it("did not move the schema version", () => {
    expect(MESSAGE_STORE_SCHEMA_VERSION).toBe(1);
  });
});
