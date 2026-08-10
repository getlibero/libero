// One channel's messages on disk: opening the file, its schema, and every
// statement run against it.
//
// **Every SQL string that runs against this file lives here.** That is the
// proxy's rule (see `packages/proxy/src/budget-db.ts`, which states it for the
// two databases on that side) and it holds for the same reason: a claim about
// what the statements can reach should be checkable by reading one screen. A
// statement prepared anywhere else in this package is a review failure.
//
// ## The isolation invariant, in its strict form
//
// The proxy narrowed CLAUDE.md's one-file-per-channel rule for operator-facing
// data — the budget meter and the audit log are one file with a `channel`
// column, because an operator asking how a workspace is tracking needs exactly
// the cross-channel query the per-file layout forbids.
//
// **This is the case the invariant was written for, and it takes the strict
// reading.** Messages are channel content: they belong to that channel's
// members and are read on their behalf, so a cross-channel join is one
// channel's members seeing another's conversation. The layout has to make that
// impossible rather than merely unwise, and here it does, twice over:
//
//   - There is no `channel` column. The file *is* the channel, so there is no
//     column a statement could forget to filter on — which is why this module
//     needs no equivalent of the proxy's "no statement omits `WHERE channel =
//     ?`" review rule. The rule has nothing to check.
//   - No operation below takes a channel id. The factory closed over one file
//     when it was called, so a cross-channel query is not something
//     `MessageStore` can express. That is stronger than a convention: it is not
//     a rule a reviewer applies, it is a shape the type system has.
//
// ### Why a caller-supplied `root` does not undo that
//
// `openMessageStore` takes a directory, which looks like the caller-supplied
// path the invariant warns about. It is not, and the argument is structural:
// the last two segments are fixed — `<channel>/store.db` — and `channel` is
// validated as a single safe path segment by `ChannelId`, whose character class
// admits no separator and whose leading-character rule rejects `.` and `..`. So
// there is no `root` for which one channel's join resolves to another channel's
// file. Only a symlink planted by someone who already has write access to the
// state directory defeats it, and that is a different threat.
//
// ### No mkdir
//
// `packages/proxy/src/budget-db.ts` refuses to create its directory because a
// budget file invented under a path nobody meant is a channel with a
// permanently fresh budget — the failure that fails open. The argument here is
// the same shape and a channel's conversation is the thing at stake: a store
// created for an id nobody provisioned is a channel with no team sheet, and
// therefore no authorization at all, quietly logging a conversation into a file
// nothing else knows about. A missing directory is a misconfiguration and says
// so here, at open, with the path named.
//
// **The gate this leaves to the caller is now explicit, and #176 moved it.**
// The original argument was that `channels/<id>/` is where the operator wrote
// `channel.toml`, so the directory existing *was* the statement that the
// channel exists. That stopped being true when the store moved to its own root:
// `AGENT_STORE_ROOT` is separate from the team sheets, because the sheets
// directory is where the tool proxy reads its authorization from and an agent
// able to write there could widen its own permissions. Nothing an operator does
// creates `<storeRoot>/<channel>/`.
//
// So the rule here is unchanged and its justification lives one layer out:
// `apps/server/src/session/store.ts` checks the channel has a sheet, and only
// then creates the directory this function opens in. The gate is a line of code
// with a test rather than a property of a filesystem layout, which is strictly
// better — but it means a caller that skipped the check would be inventing a
// channel, and this file cannot stop it. That is the one thing a reviewer of a
// second caller has to look for.
//
// ## This package depends on neither service, and must not start
//
// #64 has not decided whether `search_channel_history` is answered by the proxy
// opening this file as a second reader, or by the gateway answering a callback.
// Both are live, so this package has to be importable from either side, which
// means it may name neither. `./log.ts` duplicates a `Logger` interface for
// exactly this reason and argues it at more length. An ESLint block on
// `packages/memory/**` enforces it.
//
// ## `node:sqlite`, and why the repo's Node floor moved for this file
//
// `node:sqlite` rather than a driver from npm, for the reason
// `packages/proxy/src/budget-db.ts` gives: it is built in, so there is no
// dependency and the license gate has nothing new to check. The surface used
// here is `DatabaseSync`, `prepare`, `run`, `get`, `all`, and `exec`, and it is
// stability 1.2 — a release candidate from Node 24.15, experimental below that.
//
// The floor is Node 24 **because of this file**. `node:sqlite`'s bundled SQLite
// was compiled without `SQLITE_ENABLE_FTS5` until 22.16 — the define is absent
// from `deps/sqlite/sqlite.gyp` through v22.15 and present from v22.16.0 and
// v24.0.0 — so the old 22.13 floor named a Node on which this module cannot
// create its index. `assertFts5` below refuses such a build by name rather than
// letting it fail as `no such module: fts5` halfway through creating a file.
//
// ## The store takes text, never an FTS5 expression
//
// `MATCH` is a query language, not a pattern. `search` therefore takes what a
// human or a model typed and escapes it here; nothing outside this module ever
// builds a MATCH expression. The whole argument, with the measured behaviour it
// rests on, is on `toMatchQuery`. It is the thing a later reader is most likely
// to "simplify" by passing the query straight through, so read that comment
// before touching it.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { join } from "node:path";
import { ChannelId } from "@getlibero/schema";
import type { Logger } from "./log.js";

/**
 * The schema version this build writes.
 *
 * Checked at open; a file from the future is a startup failure rather than
 * something to work around. The cost of getting this wrong is particular here:
 * a store whose columns have moved is a transcript with the wrong text
 * attributed to the wrong person, which the model then reasons over
 * confidently. There is no error, only a wrong answer.
 *
 * A version 2 that changed the tokenizer would need to rebuild the index rather
 * than alter a column — the tokenizer is baked into the index at creation — so
 * expect the next migration to be shaped like `audit-db.ts`'s rebuild rather
 * than like an `ALTER TABLE`.
 */
export const MESSAGE_STORE_SCHEMA_VERSION = 1;

/**
 * The file's name inside the channel's directory.
 *
 * Module-private, and there is deliberately no exported helper that builds the
 * path: a test that computes `join(root, channel, "store.db")` itself is
 * asserting the layout, and one that called our own helper would assert
 * nothing.
 */
const STORE_FILENAME = "store.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  -- A real rowid, deliberately not WITHOUT ROWID: external-content FTS5 joins
  -- the index to this table through \`content_rowid\`, and there is nothing for
  -- it to point at without one.
  --
  -- It is internal and never leaves this module. SQLite reuses a rowid after a
  -- delete, and this table deletes, so an id that escaped as a cursor would
  -- come back naming a different message. (\`audit-db.ts\` calls its own \`id\`
  -- "the cursor the audit CLI bookmarks" — that precedent does not transfer,
  -- because the audit log never deletes.) No operation returns it. \`ts\` is the
  -- identity a caller holds.
  id           INTEGER PRIMARY KEY,
  -- Slack's message ts. UNIQUE because it is the identity, and because the
  -- Events API delivers at least once: \`append\` conflicts on it and a
  -- redelivery becomes a no-op rather than a constraint error thrown out of an
  -- event handler.
  ts           TEXT NOT NULL UNIQUE,
  -- The parent thread, or NULL for a top-level message. NULL rather than a
  -- copy of \`ts\`: the gateway's SlackMention coalesces the two and loses the
  -- distinction, and "did this start a thread" is a question the assembler
  -- (#67) has to be able to ask.
  thread_ts    TEXT,
  user_id      TEXT NOT NULL,
  -- The author's name as observed when the message was stored, not the name
  -- they have now, and it does not become the resolver #67 builds. Those
  -- answer different questions: #67 answers "what is this user called today",
  -- and a user who has left the workspace has no today. It is also the only
  -- attribution available to #64, which runs in a process that holds no Slack
  -- token and must never be given one.
  display_name TEXT,
  text         TEXT NOT NULL,
  -- Our clock, in milliseconds, supplied by the caller so a test can be
  -- deterministic. \`ts\` is Slack's and says when the message was sent; this
  -- says when this store learned of it, and the two diverge on a backfill and
  -- on a replay. It is not the transcript's sort key — that is \`ts\`.
  at           INTEGER NOT NULL
);

-- External content: the index stores no copy of the text and reads through to
-- \`message\`. The three triggers below are the entire mechanism keeping the two
-- in step; nothing rebuilds the index on any path.
--
-- \`porter\` over \`unicode61\`, and this is the one choice here that is expensive
-- to reverse, because the tokenizer is baked into the index. Without stemming,
-- an AND of the terms in "what did we decide about the vault" does not match
-- "we decided to ship the vault" — decide is not decided — and #64 feeds
-- model-authored questions straight in, so the unstemmed version is a search
-- that silently returns nothing for the queries it exists to answer. Porter
-- only rewrites ASCII tokens, so other languages are unaffected.
--
-- \`remove_diacritics 2\` so "Kundigung" finds "Kündigung".
--
-- \`detail\` is left at its default of \`full\`, and that default is load-bearing.
-- \`toMatchQuery\` emits one quoted string per whitespace chunk, so any chunk
-- containing punctuation becomes a multi-token phrase — and \`detail=column\` or
-- \`detail=none\` answers a phrase query with "fts5: phrase queries are not
-- supported (detail!=full)". Do not set it to shrink the index.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content=message,
  content_rowid=id,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, text) VALUES (new.id, new.text);
END;

-- The 'delete' command must be given the text exactly as it was indexed, which
-- is why this reads \`old.text\` rather than re-reading the table: by AFTER
-- DELETE the row is gone. Getting it wrong raises nothing — it leaves an orphan
-- in the index that only 'integrity-check' would ever notice.
CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Fires on any UPDATE rather than only one touching \`text\`, and that breadth is
-- the point: an external-content index whose base table can be updated without
-- this is silently corrupt, and nothing raises. \`replaceText\` is its only
-- caller in this module, but the trigger exists so that an UPDATE from anywhere
-- else — a later issue, an operator with the sqlite3 CLI — cannot desynchronize
-- the index either.
CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO message_fts (rowid, text) VALUES (new.id, new.text);
END;
`;

/**
 * A message as this channel's file holds it.
 *
 * One shape for both writing and reading, following `AuditRecord`'s precedent:
 * the columns and the arguments are the same set, and two interfaces that never
 * differ are two things to keep in step. Split them when a read shape first
 * gains something a write does not.
 *
 * `null` rather than optional on the two nullable fields. Under
 * `exactOptionalPropertyTypes` an optional property makes "absent" and "present
 * and undefined" two different things, and a top-level message genuinely has no
 * thread — so the caller writes `threadTs: event.thread_ts ?? null` once
 * instead of a conditional spread.
 *
 * There is no `id`. See the DDL.
 */
export interface StoredMessage {
  /** Slack's message ts. The identity: `remove` and `replaceText` take it. */
  readonly ts: string;
  /** The parent thread's ts, or null for a top-level message. */
  readonly threadTs: string | null;
  readonly userId: string;
  /** The author's name when the message was stored. A snapshot, not a lookup. */
  readonly displayName: string | null;
  readonly text: string;
  /** When this store learned of the message, in ms. Not when it was sent. */
  readonly at: number;
}

export interface MessageStoreOptions {
  /**
   * The channel this store belongs to. Validated as a `ChannelId`, which is
   * what makes it safe as a path segment.
   */
  readonly channel: string;
  /**
   * The directory holding the per-channel state directories. The file is
   * `<root>/<channel>/store.db`, and `<root>/<channel>` must already exist —
   * see the header on why this does not create it.
   */
  readonly root: string;
  readonly logger?: Logger;
}

/**
 * One channel's messages, as a set of named operations rather than a handle.
 *
 * A handle would let a caller prepare its own statement, and the one thing this
 * module is for is that nobody does — the same argument `BudgetDb` makes.
 *
 * **No method takes a channel id, and none returns one.** The factory closed
 * over exactly one file, so a query spanning two channels is not something this
 * interface can express. That is the acceptance criterion in structural form,
 * and it is why this file needs no per-statement review rule.
 */
export interface MessageStore {
  /**
   * Stores a message. False if this `ts` is already stored, which is not an
   * error: Slack delivers events at least once and the first write wins.
   */
  append(message: StoredMessage): boolean;
  /**
   * Deletes a message and its index entry. False if there was no such message.
   *
   * This is how a Slack deletion is mirrored, so retention is respected rather
   * than quietly outlived.
   */
  remove(ts: string): boolean;
  /**
   * Replaces a message's text and reindexes it. False if there was no such
   * message.
   *
   * This is how a Slack edit is mirrored. It matters for the same reason
   * `remove` does: an unmirrored edit means the store keeps text its author
   * retracted.
   */
  replaceText(ts: string, text: string): boolean;
  /**
   * Ranked full-text search over this channel's messages, best match first.
   *
   * **Takes text, never an FTS5 expression** — see `toMatchQuery`. An empty
   * query, or one that is all punctuation, returns no rows rather than
   * throwing. `limit` is clamped to `READ_MAX_LIMIT`.
   *
   * Returns order and not a score: bm25 is negative, which no caller expects,
   * and exposing it invites thresholding on an FTS5 implementation detail.
   */
  search(text: string, limit: number): readonly StoredMessage[];
  /**
   * The most recent `limit` messages in this channel, **oldest first**.
   *
   * The other read, and the one a transcript is built from (#67). It answers
   * "what was said here lately" where `search` answers "what was said about
   * this", and neither is the other with a different argument.
   *
   * Reading order rather than newest-first, deliberately. The statement takes
   * the newest N — that is the only way to ask SQLite for a tail — and this
   * reverses before returning, because descending is an implementation detail
   * of "the newest N" and every caller renders a conversation forwards. A
   * caller that had to reverse it would be a caller that could forget to.
   *
   * `limit` is clamped to `READ_MAX_LIMIT`. Fewer rows than asked for means
   * the channel has no more, not that anything was dropped.
   */
  recent(limit: number): readonly StoredMessage[];
  close(): void;
}

/**
 * The most terms one query may carry, and the longest it may be.
 *
 * Bounds on what a caller can make this process do rather than tuning, because
 * #64 feeds model-authored text through here. Both clamp silently, and the
 * direction is why that is safe: dropping terms from an AND *removes*
 * constraints, so a truncated query returns more of this channel's messages —
 * which the caller was already entitled to — and never a row from another one.
 * Nothing here is an authorization decision, so neither broadening nor
 * narrowing an answer is a failure mode.
 */
export const SEARCH_MAX_TERMS = 32;
export const SEARCH_MAX_QUERY_CHARS = 1024;

/**
 * The most rows any one read may return, whichever read it is.
 *
 * One ceiling for `search` and `recent` rather than two, because what it bounds
 * is the same thing in both cases: how much of this file one call can pull into
 * memory and hand to a caller that will put it in a model's context.
 *
 * **Keep this in step with `[llm] max_history_messages`'s upper bound in
 * `packages/schema`.** That field is how an operator asks for more history, and
 * a sheet permitted to name a number above this one would be silently clamped —
 * which is the one place a silent clamp here would be surprising rather than
 * benign, because it is an operator's stated intent rather than a model's
 * argument. Schema is the base package and cannot import this, so the two are
 * kept in step by hand, as `DEFAULT_AGENT_LOOP_CAPS` and the `[llm]` caps
 * already are.
 */
export const READ_MAX_LIMIT = 200;

/**
 * Plain text into an FTS5 MATCH expression, or undefined if there is nothing to
 * search for.
 *
 * **This function is the reason `search` takes text and not a query.** MATCH is
 * a query language, and every one of these is a real thing a person types into
 * Slack or a model writes into a tool call. Measured against `node:sqlite`:
 *
 *   - a bare `AND`, `OR`, `NOT` or `NEAR` is `fts5: syntax error`, and an
 *     unbalanced `"` is `unterminated string` — thrown out of a tool call;
 *   - so is a lone `---`, because `-` is a syntax character;
 *   - a trailing `*` is a prefix query;
 *   - a leading `^` anchors to the start of a column;
 *   - and `text:vault` is a **column filter**: it parses and runs.
 *
 * That last one is why wrapping the whole query in one pair of quotes is not
 * enough — the colon ends up outside them.
 *
 * The rule: one double-quoted string per whitespace-delimited chunk, embedded
 * `"` doubled, chunks joined by spaces. Everything above then sits inside
 * quotes, where the tokenizer treats it as a separator and it means nothing.
 *
 * Two properties fall out, and both are what a person means by search:
 *
 *   - **Within a chunk, adjacency.** `don't-worry` becomes the phrase
 *     `[don, t, worry]`. Doubling really is an escape and not a way out of the
 *     string: `"alpha""beta"` matches `alpha beta` and not `beta alpha`.
 *   - **Between chunks, AND.** Adjacent quoted strings are an implicit AND and
 *     are order-independent. A single phrase would be near-useless — "vault
 *     friday" as one phrase matches nothing in a corpus where both words appear
 *     apart.
 *
 * Two edges, stated here so nobody rediscovers them as bugs. A query with no
 * terms returns undefined, and `search` answers with no rows rather than
 * running an empty MATCH, which throws. And a chunk of pure punctuation
 * tokenizes to nothing, which FTS5 treats as a **no-op inside the implicit
 * AND** rather than as a term that matches nothing — so `vault ---` answers the
 * same as `vault`. That is the benign direction.
 *
 * Exported so it can be tested directly, since it carries more hazard than the
 * operations around it. It is deliberately absent from the package barrel: a
 * caller holding it would be a caller building its own MATCH expression.
 */
export function toMatchQuery(text: string): string | undefined {
  const terms = text
    .slice(0, SEARCH_MAX_QUERY_CHARS)
    .split(/\s+/u)
    .filter(term => term.length > 0)
    .slice(0, SEARCH_MAX_TERMS)
    .map(term => `"${term.replaceAll('"', '""')}"`);
  return terms.length === 0 ? undefined : terms.join(" ");
}

/** Clamps to `[1, READ_MAX_LIMIT]`, and treats a non-number as 1. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(READ_MAX_LIMIT, Math.trunc(limit)));
}

/**
 * Refuse a Node build with no FTS5, naming the floor rather than the symptom.
 *
 * Without this the failure is `db.exec(SCHEMA)` throwing `no such module: fts5`
 * — a SQLite message that tells an operator nothing about what to install, and
 * which arrives midway through creating a file this module then has to close.
 *
 * `sqlite_compileoption_used`, rather than matching on that message: it is a
 * question about the build instead of a string SQLite could reword, and it can
 * be asked before any DDL runs. The one case it does not catch is a build that
 * defines the option without registering the module, which no shipped Node
 * does; that would fail on the DDL with SQLite's own message.
 *
 * Exported for its own test — the interesting branch is the one this Node
 * cannot reach.
 */
export function assertFts5(db: Pick<DatabaseSync, "prepare">, file: string): void {
  const row = db.prepare("SELECT sqlite_compileoption_used(?) AS enabled").get("ENABLE_FTS5") as
    | { enabled: number }
    | undefined;
  if (row?.enabled === 1) return;
  throw new Error(
    `memory store: ${file} needs SQLite FTS5, and this Node build has none. ` +
      `node:sqlite gained SQLITE_ENABLE_FTS5 in Node 22.16 and 24.0, and this repo ` +
      `requires Node >= 24 (see engines.node). Running ${process.version}.`
  );
}

/**
 * Read the version, or claim the file if it has none.
 *
 * A file with no row is either brand new or one this build just created, and
 * both are ours to stamp. A row we do not recognise is not.
 */
function checkVersion(db: DatabaseSync, file: string): void {
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
      MESSAGE_STORE_SCHEMA_VERSION
    );
    return;
  }
  if (row.version !== MESSAGE_STORE_SCHEMA_VERSION) {
    throw new Error(
      `memory store: ${file} is schema version ${row.version}, and this build writes ` +
        `version ${MESSAGE_STORE_SCHEMA_VERSION}`
    );
  }
}

/**
 * A row as SQLite hands it back. Module-private, and snake_case like the DDL.
 *
 * A type alias rather than an interface, which is not style: `all()` is typed
 * `Record<string, SQLOutputValue>[]`, and only a type literal gets the implicit
 * index signature that makes the cast at the call site legal. An interface here
 * fails to compile. `budget-db.ts` casts its own `all()` to an inline literal
 * for the same reason.
 */
type MessageRow = {
  readonly ts: string;
  readonly thread_ts: string | null;
  readonly user_id: string;
  readonly display_name: string | null;
  readonly text: string;
  readonly at: number;
};

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    ts: row.ts,
    threadTs: row.thread_ts,
    userId: row.user_id,
    displayName: row.display_name,
    text: row.text,
    at: row.at
  };
}

export function openMessageStore(options: MessageStoreOptions): MessageStore {
  const { channel, root, logger } = options;

  // `ChannelId`, not the raw `CHANNEL_ID_PATTERN`. The proxy imports the
  // pattern for its certificate hot path; anything that *stores* on an id
  // validates with the schema, and this is the storing case. It is what makes
  // the join below safe — a validated id is one path segment and cannot climb
  // out of `root`.
  if (!ChannelId.safeParse(channel).success) {
    throw new Error(`memory store: ${JSON.stringify(channel)} is not a valid channel id`);
  }

  const file = join(root, channel, STORE_FILENAME);

  // No mkdir. See the header: the channel's directory existing is the
  // operator's statement that the channel exists.
  const db = new DatabaseSync(file);

  try {
    // WAL because #64 may make a second process a reader of this file, and a
    // reader must not block the gateway writing an inbound message. It also
    // means SQLite writes `-wal` and `-shm` beside the file, so the directory
    // has to be writable and not just the file.
    db.exec("PRAGMA journal_mode = WAL");
    // FULL, not NORMAL. Under WAL, NORMAL survives a process crash but can lose
    // the last commits on a host crash, and a lost commit here is a message
    // missing from a transcript the model then reasons over — a wrong answer
    // with no symptom. It is also what makes a hard kill safe without closing
    // the database. One fsync per inbound message sits behind a socket.
    db.exec("PRAGMA synchronous = FULL");
    // Waiting is the right answer for a store a second process may be reading;
    // SQLITE_BUSY back to an event handler is not.
    db.exec("PRAGMA busy_timeout = 5000");
    assertFts5(db, file);
    db.exec(SCHEMA);
    checkVersion(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    // ON CONFLICT DO NOTHING rather than DO UPDATE, for two reasons. An upsert
    // would fire the update trigger for a redelivery that changed nothing, and
    // first-write-wins is the right answer for an at-least-once event stream.
    // The conflicting insert reports 0 changes and does not fire the insert
    // trigger, so the index is untouched.
    append: db.prepare(
      `INSERT INTO message (ts, thread_ts, user_id, display_name, text, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ts) DO NOTHING`
    ),
    remove: db.prepare(`DELETE FROM message WHERE ts = ?`),
    replaceText: db.prepare(`UPDATE message SET text = ? WHERE ts = ?`),
    // The LIMIT sits inside the subquery so the join runs over `limit` rows
    // rather than over every match. `rank` is FTS5's own hidden column — bm25
    // by default — and ordering by it inside the subquery lets FTS5 do the sort
    // rather than materializing the whole match set. The outer ORDER BY is what
    // survives the join, which does not preserve the subquery's order.
    search: db.prepare(
      `SELECT m.ts, m.thread_ts, m.user_id, m.display_name, m.text, m.at
         FROM message m
         JOIN (SELECT rowid AS hit_id, rank AS hit_rank
                 FROM message_fts
                WHERE message_fts MATCH ?
                ORDER BY rank
                LIMIT ?) AS hit
           ON m.id = hit.hit_id
        ORDER BY hit.hit_rank`
    ),
    // DESC because the only way to ask SQLite for a tail is to sort backwards
    // and take the head; `recent` reverses the rows before returning them.
    //
    // **Ordering on `ts` is ordering by when the message was sent, and it is
    // correct as a string comparison.** A Slack ts is fixed-width — ten digits
    // of seconds, a dot, six more — so lexicographic and numeric order agree,
    // and will until the seconds field gains a digit in 2286. The two
    // alternatives are both wrong: `id` is insertion order, which a redelivery
    // or a slow event reorders, and `at` is when this store *learned* of a
    // message, which is a different clock and diverges the moment anything
    // backfills.
    recent: db.prepare(
      `SELECT ts, thread_ts, user_id, display_name, text, at
         FROM message
        ORDER BY ts DESC
        LIMIT ?`
    )
  } satisfies Record<string, StatementSync>;

  logger?.log("info", { event: "store_opened", channel, file });

  return {
    append(message) {
      // Number(), because node:sqlite reports `changes` as a bigint once a
      // statement has been switched to big-int mode, and a `=== 1` that
      // silently stopped matching would report every write as a duplicate.
      return (
        Number(
          statements.append.run(
            message.ts,
            message.threadTs,
            message.userId,
            message.displayName,
            message.text,
            message.at
          ).changes
        ) === 1
      );
    },

    remove(ts) {
      return Number(statements.remove.run(ts).changes) === 1;
    },

    replaceText(ts, text) {
      return Number(statements.replaceText.run(text, ts).changes) === 1;
    },

    search(text, limit) {
      const query = toMatchQuery(text);
      if (query === undefined) return [];
      const rows = statements.search.all(query, clampLimit(limit)) as MessageRow[];
      return rows.map(toStoredMessage);
    },

    recent(limit) {
      const rows = statements.recent.all(clampLimit(limit)) as MessageRow[];
      // Newest-first out of SQLite, oldest-first out of here. `reverse` after
      // the map rather than a second sort: the statement already ordered them
      // and re-sorting would be a second opinion about what order means.
      return rows.map(toStoredMessage).reverse();
    },

    close() {
      db.close();
    }
  };
}
