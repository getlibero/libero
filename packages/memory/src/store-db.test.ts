import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MESSAGE_STORE_SCHEMA_VERSION,
  READ_MAX_LIMIT,
  SEARCH_MAX_TERMS,
  assertFts5,
  openMessageStore,
  toMatchQuery
} from "./store-db.js";
import type { MessageStore, StoredMessage } from "./store-db.js";

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

  // WAL, and the question #64 has to answer: whether the proxy reads this file
  // as a second process. It can.
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
  it("exposes appending, removing, replacing, reading, and closing, and nothing else", () => {
    expect(Object.keys(store).sort()).toEqual([
      "append",
      "close",
      "recent",
      "recentInThread",
      "remove",
      "replaceText",
      "search"
    ]);
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
