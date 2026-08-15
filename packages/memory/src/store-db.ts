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
// ## Two processes open this file, and only one of them writes
//
// #64 settled it: `search_channel_history` is answered by the tool proxy
// opening this file as a second reader, not by the gateway answering a callback.
// So `openMessageStore` is the gateway's and `openMessageReader` is the proxy's,
// and the difference between them is not a convenience — the reader opens the
// connection `readOnly` and runs no DDL, because the writer owns the schema and
// a reader that repaired a file would be a reader that changed the evidence.
//
// This package still depends on neither service and still may name neither.
// `./log.ts` duplicates a `Logger` interface for exactly this reason and argues
// it at more length; an ESLint block on `packages/memory/**` enforces it. The
// argument got stronger rather than weaker with the decision: the proxy imports
// this package today, so a `Logger` imported from the gateway would put the
// Slack SDK into the proxy's image through an edge that exists rather than one
// that might.
//
// ## `node:sqlite`, and why the repo's Node floor moved for this file
//
// `node:sqlite` rather than a driver from npm, for the reason
// `packages/proxy/src/budget-db.ts` gives: it is built in, so the driver itself
// is not a dependency. The surface used here is `DatabaseSync`, `prepare`,
// `run`, `get`, `all`, and `exec`, and it is stability 1.2 — a release candidate
// from Node 24.15, experimental below that.
//
// That paragraph used to end "so there is no dependency and the license gate has
// nothing new to check", and #229 made the second half false: `sqlite-vec` is a
// real npm dependency of this package now, and it is the first one in the
// repository whose payload is a **binary** — a loadable SQLite extension, shipped
// as a platform-specific prebuild. Two consequences are worth knowing before the
// next change here.
//
// It lands in **both** service images, because `packages/proxy` depends on this
// package to answer `search_channel_history`. So a binary blob now sits in the
// process that holds every tool credential. What bounds that is below in
// `loadVec`: it is loaded by one explicit call against a path this process
// computed, and there is no path by which SQL text can load anything.
//
// And it is why the images are Debian rather than Alpine. sqlite-vec publishes
// prebuilds for linux and darwin on x64 and arm64 and for win32 on x64, all
// glibc — `vec0.so` links `libc.so.6` with versioned GLIBC symbols — and none
// for musl. The argument for `node:24-slim` over building the amalgamation in
// the image is in the two Dockerfiles.
//
// ## Loading the extension, and what `allowExtension` does not open
//
// Both openers now pass `allowExtension: true` and call `loadVec`. That flag
// reads wider than it is, and the difference is the whole reason the reader may
// have it. Measured against `node:sqlite`:
//
//   - **The SQL function `load_extension()` answers `not authorized` whether or
//     not the flag is set.** Node installs an authorizer that denies it, and
//     nothing here can turn that off. So no SQL string — including one built
//     from a model's words, which is what `toMatchQuery` exists to make
//     impossible anyway — can reach a loader.
//   - The flag enables the `loadExtension()` **method**, which is C API surface
//     this module calls once with a path it computed itself.
//   - `enableLoadExtension(false)` afterwards closes that method again. Both
//     openers do it. It is defence in depth rather than the mechanism — the
//     authorizer above is the mechanism — and what it buys is that the widening
//     lasts for the open sequence rather than for the connection's life.
//
// So the reader gains the ability to *use* vec0 and gains no ability to write.
// It gains no vector query either: whether the tool proxy ever runs a
// nearest-neighbour search is #232's decision, and a method with no caller was
// not written.
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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ChannelId } from "@getlibero/schema";
import type { SkillStatus, SummaryShape } from "@getlibero/schema";
import { getLoadablePath } from "sqlite-vec";
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
 *
 * **What is versioned is what a reader depends on, not everything in the file.**
 * `message_thread` was added at 1 and did not move this number: an index changes
 * which rows SQLite visits and never which rows come back, so no reader of an
 * older file is wrong, and bumping would have refused every store already on
 * disk over a query plan. A column, a constraint, or the tokenizer is the other
 * kind of change and does move it.
 *
 * **#229 added the embeddings tables and this number did not move, which is the
 * rule above applied rather than an omission.** The issue asked for a bump; the
 * rule asks what a reader depends on, so that was measured before it was
 * decided. On a file carrying a `vec0` virtual table, a connection with the
 * extension *not* loaded still prepares and runs every statement in this module
 * — the plain reads and the FTS `MATCH` alike — and fails only on a statement
 * naming the vec table itself, with SQLite's `no such module: vec0`. So no
 * reader of an older build is wrong about anything it asks for, exactly as with
 * `message_thread`, and the two new ordinary tables are additive DDL that
 * `db.exec(SCHEMA)` creates the next time a writer opens the file.
 *
 * What a bump would have cost is concrete and one-directional: `readVersion`
 * refuses any mismatch, so every store already on disk would have had
 * `search_channel_history` fail in the tool proxy until the gateway happened to
 * open that channel and migrate it. Paying an availability regression for a
 * refusal nothing needs is the trade the rule exists to prevent.
 *
 * **#290 added the skill tables and this number did not move either**, measured
 * the same way. `skill`, `skill_fts` and `skill_use` are ordinary additive DDL
 * that `db.exec(SCHEMA)` creates on the next writer open, and the proxy's reader
 * names none of them — it searches messages and nothing else. Skills share the
 * one `vec_embedding` table rather than getting their own, which is what keeps
 * them on this side of the line rather than the other; the cost of sharing is
 * paid in `nearest`'s kind filter, argued there.
 *
 * The next change here probably does move it. Anything that alters what
 * `nearest` means — a second vec table, a distance metric that is not L2, a
 * dimension no longer fixed per file — is a reader depending on it. Whoever
 * makes it should read `readVersion` below before assuming a migration exists.
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
  -- attribution available to the tool proxy, which reads this file to answer
  -- \`search_channel_history\` (#64) and holds no Slack token to resolve a name
  -- with — nor should ever be given one.
  display_name TEXT,
  text         TEXT NOT NULL,
  -- Our clock, in milliseconds, supplied by the caller so a test can be
  -- deterministic. \`ts\` is Slack's and says when the message was sent; this
  -- says when this store learned of it, and the two diverge on a backfill and
  -- on a replay. It is not the transcript's sort key — that is \`ts\`.
  at           INTEGER NOT NULL
);

-- \`recentInThread\` reads a thread as "the root, plus everything whose parent is
-- the root", so it filters on \`thread_ts\` and orders on \`ts\`. Without this the
-- only usable index is the one behind \`ts UNIQUE\`, which makes reading a thread
-- a descending scan of the channel that stops when the LIMIT fills — cheap for
-- a thread near the end of the file and a full table scan for one near the
-- start.
--
-- Adding it moves no schema version. \`db.exec(SCHEMA)\` runs at every open and
-- every statement here is IF NOT EXISTS, so an existing file gains the index the
-- next time it is opened; nothing a reader expects changes, and bumping the
-- version would refuse every store already on disk over a query plan.
CREATE INDEX IF NOT EXISTS message_thread ON message (thread_ts, ts);

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

-- Which model produced every vector in this file, and at what width. **One
-- row**, enforced by the CHECK rather than by a convention.
--
-- #229 asked that a vector's row carry its model id and dimensions. It carries
-- them once instead, and that is stronger rather than weaker: a \`vec0\` table
-- holds exactly one dimension, baked into its declaration at creation, so every
-- vector in this file is necessarily under one model at one width. Storing the
-- pair per row would be storing the same two values N times, which is N-1
-- chances for a copy to disagree with the table it describes.
--
-- The consequence the issue names is what \`putEmbedding\` enforces: changing the
-- embedding model is a **stated rebuild**, not something a file absorbs. There
-- is no rebuild command yet; #231 and #232 are what will need one.
CREATE TABLE IF NOT EXISTS embedding_model (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  model  TEXT NOT NULL,
  dims   INTEGER NOT NULL
);

-- What each vector was derived from. Ordinary SQL rather than \`vec0\` metadata
-- columns, and the reason is #233: deletion mirroring has to reach derived data,
-- a trigger is how this file already keeps a satellite index honest (see the
-- three \`message_fts\` ones above), and **a virtual table cannot carry a
-- trigger**. Provenance living here is what gives #233 somewhere to attach one.
--
-- \`id\` is the vec table's rowid, assigned here and matched there. It never
-- leaves this module, for \`message.id\`'s reason one screen up.
--
-- \`source_kind\` is 'fact' or 'summary' — #223's corpus for Layer 3 — and there
-- is deliberately no CHECK constraint pinning that set. Neither producer exists
-- yet (#231 writes summaries; curated facts live in MEMORY.md, which has no rows
-- at all and whose identity question #233 is the one to settle), and a
-- constraint written now would be a guess encoded as a schema change later.
-- \`EmbeddingSource\` is where the set is stated, in a type that costs nothing to
-- widen.
--
-- UNIQUE on the pair is what makes re-embedding a changed summary a replacement
-- rather than a second answer to the same question.
CREATE TABLE IF NOT EXISTS embedding_source (
  id           INTEGER PRIMARY KEY,
  source_kind  TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  at           INTEGER NOT NULL,
  UNIQUE (source_kind, source_ref)
);

-- One thread, summarized (#231). Layer 3's second corpus, and the one that
-- makes it worth having: curated facts are already injected whole into every
-- task's opening context, so retrieval over them replaces "all of it" with
-- "some of it". Summaries are the corpus too large to inject.
--
-- **Keyed on the thread's root \`ts\`**, which is the identity \`recentInThread\`
-- already takes and the one a caller holds. Deliberately *not* \`message.id\`:
-- the DDL above says that rowid is internal and reused after a delete, so a
-- summary filed under one would later name a different message.
--
-- \`shape\` is \`SummaryShape\` from @getlibero/schema — what kind of durable
-- content the thread produced, so a query can reach a Q&A thread's answer and a
-- decision thread's decision in the terms each was actually said in.
--
-- **A \`nothing\` thread gets a row here and no embedding**, and the split is the
-- point: this table records that a thread was *assessed*, and the vector store
-- is the corpus. Keeping chatter out of the corpus is what protects retrieval —
-- a summary of "deploying now" is a vector sitting in the neighbourhood of every
-- deployment question, diluting all of them. But keeping it out of *this* table
-- would mean the sweep below finds the thread unsummarized on every pass and
-- pays a model call to conclude "nothing" again, forever. One row, no vector.
--
-- No CHECK pinning the shape vocabulary, for \`embedding_source.source_kind\`'s
-- reason: the set lives in the schema package where widening it is a type change
-- rather than a migration.
CREATE TABLE IF NOT EXISTS thread_summary (
  thread_ts     TEXT PRIMARY KEY,
  shape         TEXT NOT NULL,
  text          TEXT NOT NULL,
  -- The newest source message this summary was built from, and the whole
  -- staleness mechanism. A thread whose newest message is later than this has
  -- said something the summary does not know about.
  --
  -- A watermark rather than a list of every source \`ts\`, and the difference is
  -- worth stating because #231 asks that a summary "name its source rows". It
  -- does, and more cheaply than a join table would: a thread is a contiguous
  -- run of messages under one root, so \`(thread_ts, covers_through_ts)\` names
  -- exactly the set — every message of this thread up to that point. A list
  -- would be the same set enumerated, and would go stale differently from the
  -- messages it names.
  covers_through_ts TEXT NOT NULL,
  -- How many messages went in. Not provenance — the pair above is that — but
  -- what lets an operator see a summary standing for far more conversation than
  -- one vector can represent. See the README on the ceiling this leaves.
  message_count INTEGER NOT NULL,
  at            INTEGER NOT NULL
);

-- What the sweep groups on. An expression index, because a thread's identity is
-- \`thread_ts\` for a reply and \`ts\` for the root that started it, so the grouping
-- key is the COALESCE and not a column. Without this, finding quiet threads is a
-- full scan and a sort of the channel on every sweep.
--
-- Adding it moves no schema version, for \`message_thread\`'s reason: an index
-- changes which rows SQLite visits and never which rows come back.
CREATE INDEX IF NOT EXISTS message_root ON message (COALESCE(thread_ts, ts), ts);

-- **A summary does not outlive the text it was built from.** These two are the
-- whole mechanism, and they are the \`message_fts\` triggers' argument applied to
-- a second derived thing: an edit or a deletion that left a summary standing
-- would leave the store asserting a conclusion drawn from words their author
-- retracted, with nothing to show for it.
--
-- They fire on **any** UPDATE rather than one touching \`text\`, exactly as
-- \`message_fts_update\` does and for the same reason — a summary desynchronized
-- from its thread is silently wrong, and a trigger that trusted callers to be
-- careful would be a trigger with a gap in it.
--
-- Invalidate rather than regenerate: regenerating needs a model call, and this
-- is a SQLite trigger. The thread simply becomes unsummarized, and the next
-- sweep picks it up. What that costs is a window where the thread is out of
-- recall; what it buys is that the window is on the side of saying nothing
-- rather than saying something retracted.
CREATE TRIGGER IF NOT EXISTS thread_summary_stale_delete AFTER DELETE ON message BEGIN
  DELETE FROM thread_summary WHERE thread_ts = COALESCE(old.thread_ts, old.ts);
END;

CREATE TRIGGER IF NOT EXISTS thread_summary_stale_update AFTER UPDATE ON message BEGIN
  DELETE FROM thread_summary WHERE thread_ts = COALESCE(new.thread_ts, new.ts);
END;

-- And the summary's vector goes with the summary. This is the second link of a
-- two-level chain — message → summary → embedding_source → vec_embedding — and
-- it does fire under \`recursive_triggers = off\`, which is SQLite's default and
-- this connection's: that pragma governs a trigger re-entering *itself*, not one
-- trigger activating another. Measured, not assumed.
CREATE TRIGGER IF NOT EXISTS thread_summary_delete AFTER DELETE ON thread_summary BEGIN
  DELETE FROM embedding_source WHERE source_kind = 'summary' AND source_ref = old.thread_ts;
END;

-- One skill, as the index knows it (#290). **The file is the source of truth and
-- this is a cache of it**, which is the opposite of every other table above:
-- \`message\` and \`thread_summary\` *are* the thing they hold, and these rows are
-- a copy of \`skills/<name>.md\` maintained by \`reconcileSkills\` below.
--
-- \`id INTEGER PRIMARY KEY\` with \`name\` as a separate UNIQUE, for \`message\`'s
-- reason one screen up: external-content FTS5 joins through \`content_rowid\`,
-- which is an integer rowid, and \`name TEXT PRIMARY KEY\` would leave it nothing
-- to point at. \`name\` is the identity a caller holds, and the id never leaves
-- this module.
--
-- \`description\` and \`body\` are here **for the FTS index and for nothing else.**
-- No read in this module returns either as text, and none should be added: a
-- skill's words are resolved through \`openSkillFiles().read\`, which is the same
-- two-step \`nearest\` and \`readThreadSummary\` already keep. That is what makes a
-- stale index harmless rather than dangerous — a hand-deleted skill still in this
-- table is a candidate that resolves to nothing and is skipped, instead of a
-- deleted playbook's text reaching a model because reconciliation had not run
-- yet. Turning a correctness property into a timing property is the one change
-- to this table that must not be made.
--
-- \`mtime_ms\`, \`size\` and \`ino\` are the change fingerprint —
-- \`packages/proxy/src/team-sheet-store.ts\`'s three fields, and all three are
-- carried because the two kinds of writer this directory has miss different ones.
--
-- A write through \`./skill-file.ts\` lands by rename, so the **inode always
-- moves** and catches a rewrite that changed neither the length nor the
-- millisecond. A person's editor rewrites in place, so the inode does *not* move
-- and what catches that is mtime and size. Neither pair alone covers both
-- writers, which is the whole argument for carrying three.
--
-- What none of them catches is an in-place rewrite of identical length with the
-- timestamp forced back — \`touch -r\`, or a restore that preserves times. There
-- is no cheap fingerprint that would: the exact answer is hashing every file on
-- every pass, which is the cost this column exists to avoid. The consequence is
-- bounded rather than silent, and it is bounded by the rule above: the index
-- holds no text a caller reads, so a row that missed an edit is a candidate that
-- resolves through the file and comes back current or not at all.
--
-- \`mtime_ms\` is compared for inequality and never read as a clock, because a
-- restore or a \`cp -p\` moves it backwards.
--
-- \`description_hash\` is separate from that fingerprint and answers a different
-- question: the fingerprint decides whether to **re-read** the file, this decides
-- whether to **re-embed** it. Only the description is embedded (see
-- \`SKILL_DESCRIPTION_MAX_CHARS\` in the schema package), so a body edit re-indexes
-- without paying for a vector, and — the case this column exists for — the
-- lifecycle job rewriting \`status\` in the frontmatter moves mtime and size and
-- must not cost an embedding call for text that did not change.
--
-- No CHECK pinning \`status\`, for \`thread_summary.shape\`'s reason: the set lives
-- in the schema package where widening it is a type change rather than a
-- migration.
CREATE TABLE IF NOT EXISTS skill (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  body             TEXT NOT NULL,
  created          TEXT NOT NULL,
  status           TEXT NOT NULL,
  mtime_ms         INTEGER NOT NULL,
  size             INTEGER NOT NULL,
  ino              INTEGER NOT NULL,
  description_hash TEXT NOT NULL
);

-- External content over \`skill\`, indexing both columns a query might match:
-- the description says when to reach for a skill, and the body holds the command
-- names and error strings a lexical index is better at than a vector averaged
-- over a whole procedure. The tokenizer is \`message_fts\`'s, for its reasons.
CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
  description,
  body,
  content=skill,
  content_rowid=id,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS skill_fts_insert AFTER INSERT ON skill BEGIN
  INSERT INTO skill_fts (rowid, description, body) VALUES (new.id, new.description, new.body);
END;

CREATE TRIGGER IF NOT EXISTS skill_fts_delete AFTER DELETE ON skill BEGIN
  INSERT INTO skill_fts (skill_fts, rowid, description, body)
    VALUES ('delete', old.id, old.description, old.body);
END;

-- Fires on any UPDATE, exactly as \`message_fts_update\` does and for its reason:
-- an external-content index whose base table can be updated without it is
-- silently corrupt and nothing raises. This is also why every observation about
-- a skill lives in \`skill_use\` below rather than in a column here — recording a
-- use would otherwise delete and reinsert this row's FTS entries on every task.
CREATE TRIGGER IF NOT EXISTS skill_fts_update AFTER UPDATE ON skill BEGIN
  INSERT INTO skill_fts (skill_fts, rowid, description, body)
    VALUES ('delete', old.id, old.description, old.body);
  INSERT INTO skill_fts (rowid, description, body) VALUES (new.id, new.description, new.body);
END;

-- What the runtime observed about a skill, as opposed to what a human wrote in
-- it. The split is stated on \`SkillFrontmatter\` in the schema package and this
-- is its storage half: the file is the source of truth for everything authored,
-- this table for everything observed.
--
-- **A separate table rather than columns on \`skill\`**, for three reasons that
-- converge. An UPDATE on \`skill\` churns the FTS index (see the trigger above),
-- and a use is recorded for every loaded skill on every task — the same
-- write-rate argument that kept \`uses\` out of the frontmatter, reappearing
-- inside the index. These rows must survive a re-index, and here they do
-- structurally: reconciliation upserts \`skill\` and never touches this. And a
-- table can be added later where a column cannot — see the note below.
--
-- \`status_by_job\` and \`status_by_job_at\` are the lifecycle job's (#294) and
-- nothing reads them yet. **Columns are the stated exception to this tree's "a
-- method with no caller was not written" rule**, because \`db.exec(SCHEMA)\`
-- no-ops on a table that already exists: a column added later is one every
-- statement naming it throws \`no such column\` on, at open, for every store
-- already on disk, and this module has no migration. So the columns land with
-- the table or they need a second table to arrive in.
--
-- The rule they encode, recorded here because the job that reads them is not
-- written: **a missing row means the job has not spoken about this skill.** It
-- adopts the file's current status as its baseline and writes the row without
-- changing the file, so a lost index costs one cycle of no-ops rather than
-- freezing the library. The job may then move a skill only in the direction its
-- clock indicates, and never over a status changed after its own last write.
CREATE TABLE IF NOT EXISTS skill_use (
  name             TEXT PRIMARY KEY,
  first_seen_at    INTEGER NOT NULL,
  uses             INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER,
  status_by_job    TEXT,
  status_by_job_at INTEGER
);

-- A skill's vector and its observations go with the skill, and this is the same
-- two-level chain \`thread_summary_delete\` is the first link of:
-- skill -> embedding_source -> vec_embedding.
--
-- **A rename resets the observations**, and that follows from this rather than
-- being decided elsewhere: \`mv deploy.md rollback.md\` is a delete and an add to
-- everything here, so \`uses\`, \`last_used_at\` and the job's baseline start over.
-- Worth knowing before #294 reads those clocks.
--
-- No \`message\` trigger reaches any of this, unlike \`thread_summary\`'s, and the
-- absence is deliberate rather than missing: a skill is a distillation of a model
-- turn with no per-message provenance, so there is no message whose deletion
-- should retract one. That is the same stated exception a curated fact in
-- \`MEMORY.md\` already has.
CREATE TRIGGER IF NOT EXISTS skill_delete AFTER DELETE ON skill BEGIN
  DELETE FROM embedding_source WHERE source_kind = 'skill' AND source_ref = old.name;
  DELETE FROM skill_use WHERE name = old.name;
END;
`;

/**
 * The vec table, and the trigger that keeps provenance and vectors in step.
 *
 * **Not in `SCHEMA`, because its dimension is not known at open.** A `vec0`
 * declaration bakes the width in, and the width comes from whichever embedding
 * model a deployment configured (#230) — which may be none at all, and a
 * deployment running Layers 1 and 2 should not carry a vec table for a model it
 * has no key for. So this runs once, on the first vector, from
 * `ensureEmbeddingSpace`.
 *
 * The trigger is created **here rather than in `SCHEMA`**, and that is not
 * tidiness. A trigger whose body names a table that does not exist creates
 * without complaint and then throws `no such table: main.vec_embedding` when it
 * fires — measured, not assumed — so a `SCHEMA` copy would turn
 * `removeEmbedding` on a store that has never embedded anything into an error.
 * Created in the same act as the table it deletes from, the two cannot exist
 * apart.
 *
 * `%DIMS%` is substituted rather than bound, which is the one place in this
 * module a value reaches a SQL string instead of a parameter. It is unavoidable:
 * a virtual table's declaration is parsed by the module at creation and is not a
 * parameterizable expression. `ensureEmbeddingSpace` is what makes it safe — the
 * value is an integer in `[1, MAX_EMBEDDING_DIMS]` before it gets here, checked
 * against `Number.isInteger` rather than against a pattern.
 */
const VEC_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embedding USING vec0(
  id        integer primary key,
  embedding float[%DIMS%]
);

CREATE TRIGGER IF NOT EXISTS embedding_source_delete AFTER DELETE ON embedding_source BEGIN
  DELETE FROM vec_embedding WHERE id = old.id;
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

/**
 * What a vector was derived from.
 *
 * The pair is this file's identity for an embedding, and `putEmbedding` upserts
 * on it — so re-embedding a summary whose source messages changed replaces the
 * old vector rather than leaving two.
 *
 * `kind` is a union rather than a `string` because the corpus is #223's and is
 * closed: curated facts and thread summaries. It is *not* a CHECK constraint in
 * the DDL, so widening it later is a type change and not a migration. Messages
 * are deliberately absent — Layer 1 answers those with FTS5, and embedding every
 * message would be a different feature with a different cost.
 *
 * `ref` is opaque here and its meaning belongs to whoever writes the kind. #231
 * defines what identifies a summary; #233 is where the harder question lives,
 * because a curated fact lives in `MEMORY.md` as markdown with no id at all.
 * A skill's ref is its name, which is also its filename stem — the one
 * identifier in this file that is model-authored, and `SkillName` is what bounds
 * it.
 *
 * **`skill` joining this union is why `nearest` grew a kind filter.** Widening
 * the type cost nothing, as the comment above promised; what cost something is
 * that every kind now shares one k-NN over one table, so the kinds compete for
 * the same k slots. See `nearest`.
 */
export interface EmbeddingSource {
  readonly kind: "fact" | "summary" | "skill";
  readonly ref: string;
}

/** One nearest-neighbour hit: where it came from, and how far. */
export interface EmbeddingHit {
  readonly source: EmbeddingSource;
  /**
   * L2 distance, smaller is nearer, and it is returned rather than withheld.
   *
   * That departs from `search`, which returns rank order and deliberately no
   * bm25 score, so the difference is worth stating: bm25 is an FTS5
   * implementation detail whose scale means nothing outside it, and exposing it
   * invites thresholding on a number that is negative and unbounded. A vector
   * distance is neither — it is a documented property of the metric, in the
   * units of the vectors themselves, and a caller deciding "near enough to put
   * in the context" has no other way to ask.
   */
  readonly distance: number;
}

/**
 * A vector and everything this file needs to record about it.
 *
 * One object rather than four positional arguments, following `StoredMessage`:
 * this store's other write takes a shape, and `at` is caller-supplied here for
 * exactly `StoredMessage.at`'s reason — it is our clock rather than an upstream
 * one, and a test that cannot set it cannot be deterministic.
 */
export interface StoredEmbedding {
  readonly source: EmbeddingSource;
  /**
   * The vector. `Float32Array` and not `number[]`, because `vec0` reads a blob
   * of float32 and this is that blob without a conversion or a copy — a
   * `number[]` would be a second representation to get the width of wrong.
   */
  readonly vector: Float32Array;
  /**
   * The model that produced it. Recorded once per file, not once per row; a
   * value differing from what the file already holds is refused.
   */
  readonly model: string;
  /** When this store learned of the vector, in ms. */
  readonly at: number;
}

/**
 * One thread's summary, as this file holds it (#231).
 *
 * `shape` and `text` are `ThreadSummary` from `@getlibero/schema` — the turn
 * that produces them and the store that keeps them are two packages that cannot
 * import each other, so the vocabulary lives in the one they share.
 *
 * The other three fields are this store's rather than the model's, which is why
 * they are not on the schema shape: `thread` is where it goes, and
 * `coversThroughTs` with `messageCount` are what the store observed about the
 * rows it was given. A model that could name its own coverage watermark could
 * name one that keeps a stale summary alive.
 */
export interface StoredThreadSummary {
  /** The thread's root `ts`, which is its identity. */
  readonly thread: string;
  readonly shape: SummaryShape;
  /** Empty exactly when `shape` is `nothing`, which `ThreadSummary` enforces. */
  readonly text: string;
  /** The newest message `ts` this summary accounts for. */
  readonly coversThroughTs: string;
  /** How many messages went into it. */
  readonly messageCount: number;
  /** When this store recorded it, in ms. `StoredMessage.at`'s clock. */
  readonly at: number;
}

/**
 * A thread the sweep found quiet and unsummarized.
 *
 * What `staleThreads` answers, and deliberately not the thread's messages:
 * reading those is `recentInThread`'s job and the caller does it for the threads
 * it decides to summarize. Answering with the text would make one sweep pull
 * every quiet thread's whole conversation into memory to decide it wanted three
 * of them.
 */
export interface StaleThread {
  /** The thread's root `ts`. */
  readonly thread: string;
  /** Its newest message's `ts` — what a summary of it would cover through. */
  readonly newestTs: string;
  readonly messageCount: number;
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
  /**
   * The most recent `limit` messages in one thread, **oldest first**.
   *
   * `recent` narrowed to a sub-conversation (#66), and identical in every other
   * respect: same order, same clamp, same reasons.
   *
   * **A thread's identity is its root message's `ts`.** The root is the message
   * that started it and carries `thread_ts = NULL`; every reply carries the
   * root's `ts` in `thread_ts`. So a thread is one row matching on `ts` and the
   * rest matching on `thread_ts`, which is why this is not a single-column
   * lookup.
   *
   * An unknown thread returns nothing rather than throwing — a caller may pass
   * a ts that this store has never seen, and "no messages" is the honest answer
   * for a thread that has not reached this file rather than an error condition.
   */
  recentInThread(thread: string, limit: number): readonly StoredMessage[];
  /**
   * Stores one vector against what it was derived from, replacing any vector
   * already held for that `(kind, ref)`.
   *
   * The first call to this on a file **creates the vec table**, at the width of
   * the vector it was given, and records the model that produced it. Every later
   * call must agree with both.
   *
   * **Throws** on a model or a dimension the file does not already hold, naming
   * what it found and what it was given. That is an exception rather than a
   * result, per `memory-file.ts`'s rule that a result is for the model and an
   * exception is for the operator: nothing a model wrote can reach this, and the
   * only way to arrive here is a deployment whose embedding configuration
   * changed under a file that was already populated. The remedy is a rebuild,
   * which is a decision rather than a retry.
   *
   * There is no writer for it in the tree yet — #231 produces summaries and #232
   * decides where recall enters a task. This is the storage half.
   */
  putEmbedding(embedding: StoredEmbedding): void;
  /**
   * The `limit` nearest vectors to the one given, nearest first.
   *
   * Returns provenance and distance and **never text**: this file holds vectors
   * and what they came from, and resolving a ref to the thing it names belongs
   * to whoever defined the kind.
   *
   * Answers nothing — rather than throwing — for a file with no vec table yet,
   * which is the ordinary state of a channel under a deployment that has
   * configured no embedding provider. A query whose width disagrees with the
   * file's throws, for `putEmbedding`'s reason.
   *
   * `limit` is clamped to `READ_MAX_LIMIT`, like every other read here.
   *
   * **`kind` is not a convenience, and a caller wanting one corpus must pass
   * it.** Every kind shares one `vec_embedding`, so an unfiltered k-NN answers
   * with whatever is nearest — and a channel holding a hundred skills can fill
   * all five of a recall's slots with them, leaving it with nothing. Filtering
   * afterwards does not fix that, because by then the k slots are spent; the
   * filter has to reach vec0 before it picks. It does, so a filtered read is
   * exact rather than best-effort. See `NEAREST_OF_KIND_SQL`.
   */
  nearest(
    vector: Float32Array,
    limit: number,
    kind?: EmbeddingSource["kind"]
  ): readonly EmbeddingHit[];
  /**
   * Forgets one source's vector. False if there was none.
   *
   * The delete goes to `embedding_source` and the trigger carries it into the
   * vec table, so there is no order for a caller to get wrong. #233 is what
   * wires this to a Slack deletion; it exists now so that issue adds a trigger
   * rather than an operation.
   */
  removeEmbedding(source: EmbeddingSource): boolean;
  /**
   * Records one thread's summary, replacing any this store already held.
   *
   * **A `nothing` summary is stored too, and that is not a contradiction.** The
   * row records that the thread was assessed; the vector store is the corpus.
   * Without the row, `staleThreads` would offer the same silent thread on every
   * sweep and a model call would conclude "nothing" again each time. The caller
   * embeds only what has a shape worth retrieving — see the DDL.
   *
   * Replacing rather than appending: a thread that woke up and went quiet again
   * is re-summarized whole, and the old summary is not a second answer to the
   * same question. That is also what makes an over-eager idle threshold degrade
   * to wasted spend rather than to a corpus full of half-finished arguments.
   *
   * Writing a summary does **not** write its vector. The two are separate acts
   * because only one of them needs a model provider, and `packages/memory` has
   * none: the caller embeds `text` and calls `putEmbedding` with
   * `{ kind: "summary", ref: thread }`.
   */
  putThreadSummary(summary: StoredThreadSummary): void;
  /**
   * Threads that have gone quiet and have nothing current standing for them.
   *
   * The sweep's whole read. A thread qualifies when its newest message is older
   * than `idleBefore` **and** no summary covers that message — either because
   * there is none, or because one was invalidated by an edit, or because the
   * thread said more after it was last summarized.
   *
   * `idleBefore` is a Slack `ts`, not a wall clock, and the comparison is the
   * string one this file already relies on: a ts is fixed-width, so
   * lexicographic and numeric order agree. Passing a ts rather than a duration
   * keeps the clock decision — how quiet is quiet — with the caller that reads
   * the channel's sheet, and keeps this module free of one.
   *
   * Newest first, so a bounded sweep summarizes what went quiet most recently
   * rather than working through a backlog oldest-first while new threads pile
   * up behind it. `limit` is clamped to `READ_MAX_LIMIT`.
   */
  staleThreads(idleBefore: string, limit: number): readonly StaleThread[];
  /**
   * One thread's summary, or `null` if it has none.
   *
   * What turns a `nearest` hit back into something a reader can use: that read
   * answers provenance and distance and deliberately never text, so resolving a
   * ref to the thing it names is a second step. This is that step for the
   * `summary` kind.
   *
   * **A separate read rather than a join inside `nearest`**, which would have
   * been one query instead of k+1. Two reasons. `nearest` is the generic
   * primitive over every kind of source, and a join would make it answer one
   * kind's columns; and `k` is a handful — the recall path asks for five — so
   * what a join saves is five prepared-statement lookups against an indexed
   * primary key, in a step that has just spent a network round trip on an
   * embedding.
   *
   * Answers `null` rather than throwing for a thread with no summary, which is
   * a real state and not a broken one: a vector outlives its summary for as long
   * as it takes a trigger to fire, and a caller reading a hit whose summary was
   * invalidated between the two should skip it rather than fail the task.
   */
  readThreadSummary(thread: string): StoredThreadSummary | null;
  /**
   * Every skill this index holds, by name, with the metadata a caller needs to
   * tell whether its file has moved.
   *
   * Metadata and never text, for `StaleThread`'s reason and one sharper: the
   * file is the source of truth, so a caller that could render a skill from this
   * table would be a caller rendering whatever the index last saw.
   */
  listSkills(): readonly StoredSkill[];
  /**
   * Makes the index match the directory, and **it is the only thing that writes
   * the skill tables.**
   *
   * That is the issue's own rule — the files are the source of truth and the
   * index follows them, never the reverse — expressed as a shape rather than as
   * a convention. There is no `putSkill` and no `removeSkill`, because either
   * would be a second path by which this index could come to disagree with the
   * directory, and neither could be reviewed for whether its caller had looked
   * at a file first.
   *
   * It does no filesystem work of its own: the caller stats and parses, this
   * writes. That keeps every SQL string in this module without putting a
   * `readdir` in it.
   *
   * Three things happen, and the third is the one worth reading twice.
   *
   *   - Every entry in `changed` is upserted. An UPDATE rather than a
   *     delete-and-insert, so `skill_use` is untouched and a body edit does not
   *     reset a skill's counters.
   *   - Every row whose name is not in `present` is deleted, and the trigger
   *     takes its vector and its observations with it.
   *   - **A skill whose description changed has its vector invalidated**, and so
   *     does one that is now archived. Invalidate rather than regenerate —
   *     `thread_summary_stale_update`'s rule, for its reason: regenerating needs
   *     a model call and this has none. Without it an edited skill would keep a
   *     vector built from a description the team replaced, forever, because
   *     `putEmbedding` upserts on `(kind, ref)` and an edit does not change the
   *     name.
   *
   * Whether the *body* changed does not matter to the vector, because only the
   * description is embedded. That is what keeps a lifecycle job's weekly status
   * rewrite from costing an embedding call.
   */
  reconcileSkills(state: SkillReconciliation, at: number): SkillReconcileResult;
  /**
   * Full-text search over this channel's skills, best first, by name.
   *
   * Takes text and never an FTS5 expression, for `search`'s reason, and answers
   * names rather than rows for `listSkills`' — resolving a name to a skill is
   * `openSkillFiles().read`, which reads the file rather than this table.
   *
   * No score, exactly as `search` returns none: bm25's scale means nothing
   * outside FTS5, and a caller fusing this with `nearest` fuses on rank.
   * Archived skills never appear.
   */
  searchSkills(text: string, limit: number): readonly string[];
  /**
   * Records that these skills were loaded into a task, at this instant.
   *
   * The signal the lifecycle clocks run on, and the reason it is here rather
   * than in the files: recording a use rewrites nothing a human wrote. Silently
   * ignores a name this index does not hold, which is a skill deleted between
   * retrieval and the record rather than an error.
   */
  recordSkillUse(names: readonly string[], at: number): void;
  /**
   * Skills with no vector standing for them, by name.
   *
   * `staleThreads`' shape and its purpose: what a caller with an embedding
   * provider should spend a call on. Derived by join rather than by a stored
   * flag, so it cannot go out of step with the vectors it describes.
   *
   * Never includes an archived skill, which has no business being embedded.
   */
  skillsNeedingEmbedding(limit: number): readonly string[];
  close(): void;
}

/**
 * What tells this index a skill file has changed.
 *
 * The three `statSync` fields `packages/proxy/src/team-sheet-store.ts` compares,
 * for its reason and one more of this file's own: writes here land by rename, so
 * the inode always moves and is the only one of the three that catches a
 * same-millisecond rewrite of identical length.
 */
export interface SkillFingerprint {
  readonly name: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

/**
 * A skill as the index knows it — metadata only, never its text.
 *
 * What `listSkills` answers, and deliberately not enough to render a skill with:
 * `StaleThread`'s rule, and here it is also what keeps a stale index harmless.
 */
export interface StoredSkill extends SkillFingerprint {
  readonly created: string;
  readonly status: SkillStatus;
}

/** One parsed skill file, as reconciliation hands it to the index. */
export interface SkillEntry extends SkillFingerprint {
  readonly description: string;
  readonly body: string;
  readonly created: string;
  readonly status: SkillStatus;
}

/**
 * The directory as reconciliation observed it.
 *
 * `present` is **every** skill the directory holds and `changed` is the subset
 * whose file moved, so the caller parses only what it must while this module
 * still learns what has gone. The split is what lets a steady-state pass be
 * `stat` calls and nothing else.
 *
 * `present` empty means the directory is genuinely empty — the file layer throws
 * on any readdir failure that is not `ENOENT`, so this can never be the answer to
 * a directory that could not be read. That matters here more than there: this is
 * the value the index is deleted against.
 */
export interface SkillReconciliation {
  readonly present: readonly string[];
  readonly changed: readonly SkillEntry[];
}

/** What one reconciliation did, for the caller's log. */
export interface SkillReconcileResult {
  /** Rows written, whether new or updated. */
  readonly indexed: number;
  /** Rows removed because their file is gone. */
  readonly dropped: number;
  /** Vectors invalidated: an edited description, or a skill now archived. */
  readonly invalidated: number;
}

export interface MessageReaderOptions {
  /** The channel this store belongs to. Validated as a `ChannelId`. */
  readonly channel: string;
  /**
   * The directory holding the per-channel state directories, exactly as
   * `MessageStoreOptions.root` means it. The two processes are configured
   * separately — `AGENT_STORE_ROOT` and `PROXY_STORE_ROOT` — and must name the
   * same directory.
   */
  readonly root: string;
  readonly logger?: Logger;
}

/**
 * One channel's messages, read-only, for a process that does not own them.
 *
 * This is the tool proxy's handle (#64). It is a separate interface rather than
 * a narrowed `MessageStore` for the reason `HistorySource` is one in
 * `apps/server`: what a caller cannot express is the point, and a structural
 * subtype only documents that. The proxy answers `search_channel_history` and
 * has no business appending, removing, editing, or reading a channel's recent
 * traffic wholesale — so `search` is the only operation here, and `recent` is
 * absent on purpose.
 *
 * **No method takes a channel id**, which is `MessageStore`'s invariant and
 * holds here for the same structural reason: the factory closed over one file.
 * That is what makes "no argument the model controls can widen the search beyond
 * the calling channel" a shape rather than a check — the proxy resolves the
 * channel from the client certificate, opens this, and there is no second
 * channel reachable from the handle it gets back.
 */
export interface MessageReader {
  /**
   * Ranked full-text search over this channel's messages, best match first.
   *
   * Identical to `MessageStore.search` — same statement, same clamp, same
   * text-not-an-expression rule. See `toMatchQuery`.
   */
  search(text: string, limit: number): readonly StoredMessage[];
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

/**
 * The ranked search, shared by both openers.
 *
 * Lifted out of `openMessageStore` when `openMessageReader` arrived, because two
 * copies of one statement is the drift this file's "every SQL string lives here"
 * rule cannot catch: both copies would be here, and they could still disagree.
 * The proxy and the gateway must answer the same question the same way.
 *
 * The LIMIT sits inside the subquery so the join runs over `limit` rows rather
 * than over every match. `rank` is FTS5's own hidden column — bm25 by default —
 * and ordering by it inside the subquery lets FTS5 do the sort rather than
 * materializing the whole match set. The outer ORDER BY is what survives the
 * join, which does not preserve the subquery's order.
 */
const SEARCH_SQL = `SELECT m.ts, m.thread_ts, m.user_id, m.display_name, m.text, m.at
     FROM message m
     JOIN (SELECT rowid AS hit_id, rank AS hit_rank
             FROM message_fts
            WHERE message_fts MATCH ?
            ORDER BY rank
            LIMIT ?) AS hit
       ON m.id = hit.hit_id
    ORDER BY hit.hit_rank`;

/**
 * The nearest-neighbour read, joined back to provenance.
 *
 * `SEARCH_SQL`'s shape and for its reason: the LIMIT — `k`, in vec0's spelling —
 * sits inside the subquery so the join runs over `k` rows rather than over the
 * whole table, and the outer ORDER BY is what survives a join that does not
 * preserve the subquery's order.
 *
 * `k = ?` rather than `ORDER BY distance LIMIT ?`: vec0 accepts both, and the
 * first is the one that tells the module how many neighbours to look for rather
 * than asking it for all of them and throwing most away.
 */
const NEAREST_SQL = `SELECT s.source_kind, s.source_ref, hit.distance
     FROM (SELECT id AS hit_id, distance
             FROM vec_embedding
            WHERE embedding MATCH ?
              AND k = ?) AS hit
     JOIN embedding_source s ON s.id = hit.hit_id
    ORDER BY hit.distance`;

/**
 * The nearest-neighbour read of one kind.
 *
 * **The filter is a pre-filter, inside the vec0 match, and that is the whole
 * point.** The corpora share one `vec_embedding`, and `k` is spent *inside* that
 * match — so a caller that asked for five and filtered afterwards would get
 * whatever survived, which against a file dominated by another kind is nothing
 * at all. That is not a degraded answer, it is an empty one, and `apps/server`'s
 * recall path names exactly that as the worst failure available: a channel with
 * no recall looks like a channel with no memory rather than like a bug.
 *
 * `id IN (SELECT ...)` is how vec0 is told to consider only some rows before it
 * picks its k, so this is **exact** rather than a heuristic: a query for five
 * summaries answers with the five nearest summaries, whatever else the file
 * holds. The column is `id` and not `rowid` because that is what `VEC_SCHEMA`
 * declares the primary key as, and vec0 answers `no such column: rowid` for the
 * spelling that would otherwise be the obvious one. Measured, not assumed.
 *
 * The alternative considered and dropped was over-fetching by some multiple and
 * filtering in this module. It is worth knowing why it went: no multiple is
 * enough, because the ratio between two corpora is unbounded — a channel
 * accumulates one summary per quiet thread forever while skills are capped at a
 * hundred — so the failure it leaves is precisely the one this is written to
 * prevent, arriving later and only in the deployments that have been running
 * longest.
 */
const NEAREST_OF_KIND_SQL = `SELECT s.source_kind, s.source_ref, hit.distance
     FROM (SELECT id AS hit_id, distance
             FROM vec_embedding
            WHERE embedding MATCH ?
              AND k = ?
              AND id IN (SELECT id FROM embedding_source WHERE source_kind = ?)) AS hit
     JOIN embedding_source s ON s.id = hit.hit_id
    ORDER BY hit.distance`;

/**
 * The skill index's reads and writes.
 *
 * `SEARCH_SKILLS_SQL` is `SEARCH_SQL`'s shape with `NEAREST_OF_KIND_SQL`'s
 * addition, and for the same reason: an archived skill is out of retrieval
 * entirely, and a filter applied after the subquery's LIMIT would spend slots on
 * rows it then discards. FTS5 takes a `rowid IN (...)` constraint beside its
 * MATCH, so the exclusion happens before the ranking rather than after it and
 * the read is exact.
 *
 * **The filter is in the query rather than left to a caller**, because there are
 * two retrieval paths — this and `nearest` — and a rule applied by callers is a
 * rule forgotten in one of them. `nearest` needs no `status` clause of its own
 * because reconciliation drops an archived skill's vector outright, so there is
 * nothing there to exclude.
 *
 * `SKILLS_NEEDING_EMBEDDING_SQL` is `STALE_THREADS_SQL`'s shape: a LEFT JOIN
 * that finds rows with nothing standing for them, so what needs embedding is
 * *derived* rather than flagged. A dirty bit would be a second fact to keep in
 * step with the first.
 */
const LIST_SKILLS_SQL = `SELECT name, created, status, mtime_ms, size, ino
     FROM skill
    ORDER BY name`;

const UPSERT_SKILL_SQL = `INSERT INTO skill
       (name, description, body, created, status, mtime_ms, size, ino, description_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         description      = excluded.description,
         body             = excluded.body,
         created          = excluded.created,
         status           = excluded.status,
         mtime_ms         = excluded.mtime_ms,
         size             = excluded.size,
         ino              = excluded.ino,
         description_hash = excluded.description_hash`;

const SEARCH_SKILLS_SQL = `SELECT s.name
     FROM skill s
     JOIN (SELECT rowid AS hit_id, rank AS hit_rank
             FROM skill_fts
            WHERE skill_fts MATCH ?
              AND rowid IN (SELECT id FROM skill WHERE status != 'archived')
            ORDER BY rank
            LIMIT ?) AS hit
       ON s.id = hit.hit_id
    ORDER BY hit.hit_rank`;

const SKILLS_NEEDING_EMBEDDING_SQL = `SELECT s.name
     FROM skill s
     LEFT JOIN embedding_source e
       ON e.source_kind = 'skill' AND e.source_ref = s.name
    WHERE e.id IS NULL
      AND s.status != 'archived'
    ORDER BY s.name
    LIMIT ?`;

/**
 * The sweep: quiet threads with nothing current standing for them.
 *
 * The subquery folds a channel's messages into threads — `COALESCE(thread_ts,
 * ts)` puts a root and its replies under one key, which is why `message_root`
 * indexes that expression rather than a column. The LEFT JOIN is what makes
 * "never summarized" and "summarized before it said more" one condition instead
 * of two passes: a thread with no row has `s.thread_ts IS NULL`, and one whose
 * summary predates its newest message fails the watermark comparison.
 *
 * `HAVING` rather than a `WHERE` on `newest`, because the quietness test is
 * about the aggregate — the thread's newest message — and not about any one row.
 * A `WHERE ts < ?` would instead drop recent messages and then summarize the
 * thread as if it had ended earlier, which is the mid-conversation summary this
 * whole trigger design exists to avoid.
 */
const STALE_THREADS_SQL = `SELECT t.thread, t.newest, t.n
     FROM (SELECT COALESCE(thread_ts, ts) AS thread,
                  MAX(ts) AS newest,
                  COUNT(*) AS n
             FROM message
            GROUP BY COALESCE(thread_ts, ts)
           HAVING MAX(ts) < ?) AS t
     LEFT JOIN thread_summary s ON s.thread_ts = t.thread
    WHERE s.thread_ts IS NULL
       OR s.covers_through_ts < t.newest
    ORDER BY t.newest DESC
    LIMIT ?`;

/**
 * A `Float32Array` as the blob `vec0` reads.
 *
 * `byteOffset` and `byteLength` are passed rather than left to default, and that
 * is not defensive noise: a `Float32Array` produced by `subarray` shares its
 * neighbour's backing store, so `Buffer.from(vector.buffer)` would hand vec0 the
 * whole allocation and fail on a dimension the caller never asked for.
 */
function toVectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
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
 * The widest vector this module will build a table for.
 *
 * A bound on what a caller can make this file do rather than a limit of `vec0`,
 * which allows far more. The widest embedding any shipping model produces today
 * is 3072 (`text-embedding-3-large`), so this leaves room without leaving a
 * `float[2000000000]` in a DDL string one arithmetic slip away.
 */
export const MAX_EMBEDDING_DIMS = 4096;

/**
 * Load sqlite-vec into this connection, naming the package rather than the
 * symptom.
 *
 * `assertFts5`'s counterpart and deliberately its shape — same message prefix,
 * the file named, the remedy named, exported for its own test and absent from
 * the barrel. One thing about it is genuinely different and the difference is
 * why this is a try/catch rather than a question.
 *
 * FTS5 is a compile-time option of the SQLite that Node bundles, so
 * `sqlite_compileoption_used` can be asked before any DDL runs. There is no
 * equivalent for a loadable extension: the only way to find out whether it loads
 * is to load it. So the two real failures both arrive as thrown errors, and both
 * are worth telling apart in the message this raises:
 *
 *   - **No prebuild for this platform.** sqlite-vec resolves its loadable path
 *     through a per-platform package and throws its own "Unsupported platform"
 *     before any file is opened. linux and darwin on x64 and arm64, and win32 on
 *     x64, are what it publishes.
 *   - **A prebuild that will not load.** `dlopen` fails, and the case that has
 *     actually bitten this repo is libc: every published `vec0.so` is built
 *     against glibc, so an Alpine image cannot load one. That is why both
 *     services are Debian-based, and the Dockerfiles say so.
 *
 * Both name `process.platform`, `process.arch` and `process.version`, because
 * every one of them is part of "why did it not load here".
 */
export function loadVec(db: Pick<DatabaseSync, "loadExtension">, file: string): void {
  let path: string;
  try {
    path = getLoadablePath();
  } catch (error) {
    throw new Error(
      `memory store: ${file} needs the sqlite-vec extension, and the sqlite-vec package ` +
        `publishes no prebuild for ${process.platform}-${process.arch}. ` +
        `Running ${process.version}. Cause: ${String(error)}`
    );
  }
  try {
    db.loadExtension(path);
  } catch (error) {
    throw new Error(
      `memory store: ${file} needs the sqlite-vec extension, and ${path} would not load on ` +
        `${process.platform}-${process.arch}. The usual cause is a C library mismatch — every ` +
        `published vec0 build links glibc, so a musl image (Alpine) cannot load one; this repo's ` +
        `images are Debian-based for that reason. Running ${process.version}. Cause: ${String(error)}`
    );
  }
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

/** A `thread_summary` row. `MessageRow`'s reasons apply. */
type ThreadSummaryRow = {
  readonly thread_ts: string;
  readonly shape: string;
  readonly text: string;
  readonly covers_through_ts: string;
  readonly message_count: number | bigint;
  readonly at: number | bigint;
};

/**
 * What decides whether a skill's vector is still the right one.
 *
 * A hash rather than the description itself, because the column exists to be
 * *compared* and storing the text twice — once for FTS, once to diff against —
 * is the "one fact in two places" this file already refuses elsewhere. SHA-256
 * rather than something cheaper because `node:crypto` is a builtin and nothing
 * here is hot: reconciliation hashes only the files whose fingerprint moved.
 *
 * Not a security boundary. Nothing is authenticated by it; a collision would
 * cost a skill a re-embedding it needed, which is the same outcome as an
 * embedding provider being briefly unavailable.
 */
function hashOf(description: string): string {
  return createHash("sha256").update(description, "utf8").digest("hex");
}

/** A `LIST_SKILLS_SQL` row. `MessageRow`'s reasons apply. */
type SkillRow = {
  readonly name: string;
  readonly created: string;
  readonly status: string;
  readonly mtime_ms: number | bigint;
  readonly size: number | bigint;
  readonly ino: number | bigint;
};

/** A `STALE_THREADS_SQL` row. `MessageRow`'s reasons apply. */
type StaleThreadRow = {
  readonly thread: string;
  readonly newest: string;
  readonly n: number | bigint;
};

/** A `NEAREST_SQL` row, as SQLite hands it back. `MessageRow`'s reasons apply. */
type HitRow = {
  readonly source_kind: string;
  readonly source_ref: string;
  readonly distance: number;
};

function toEmbeddingHit(row: HitRow): EmbeddingHit {
  return {
    // The cast is the one place this module trusts its own writes. The column
    // has no CHECK — see the DDL on why — so what makes this sound is that
    // `putEmbedding` is the only INSERT and takes an `EmbeddingSource`.
    source: { kind: row.source_kind as EmbeddingSource["kind"], ref: row.source_ref },
    distance: row.distance
  };
}

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
  //
  // `allowExtension` is the first option this call has ever taken. See the
  // header on what it does and does not open — in short, it enables the
  // `loadExtension` method and does not enable the SQL `load_extension()`
  // function, which Node's authorizer denies regardless.
  const db = new DatabaseSync(file, { allowExtension: true });

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
    loadVec(db, file);
    // Shut the door behind us. Defence in depth and not the mechanism — the
    // header says which is which — and what it buys is that the one widening
    // this connection took lasts for the open sequence rather than for its life.
    db.enableLoadExtension(false);
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
    search: db.prepare(SEARCH_SQL),
    listSkills: db.prepare(LIST_SKILLS_SQL),
    upsertSkill: db.prepare(UPSERT_SKILL_SQL),
    readSkillHash: db.prepare(`SELECT description_hash FROM skill WHERE name = ?`),
    deleteSkill: db.prepare(`DELETE FROM skill WHERE name = ?`),
    // Named directly rather than left to `skill_delete`, because this fires
    // where the row *stays* — an edited description, or a skill now archived.
    dropSkillVector: db.prepare(
      `DELETE FROM embedding_source WHERE source_kind = 'skill' AND source_ref = ?`
    ),
    // Created once, when this index first sees a file, and never reset by a
    // re-index: `first_seen_at` is what a never-used skill's clock runs from, so
    // restamping it would make every edit look like a new skill.
    seenSkill: db.prepare(
      `INSERT INTO skill_use (name, first_seen_at, uses) VALUES (?, ?, 0)
         ON CONFLICT (name) DO NOTHING`
    ),
    recordSkillUse: db.prepare(
      `UPDATE skill_use SET uses = uses + 1, last_used_at = ? WHERE name = ?`
    ),
    searchSkills: db.prepare(SEARCH_SKILLS_SQL),
    skillsNeedingEmbedding: db.prepare(SKILLS_NEEDING_EMBEDDING_SQL),
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
    ),
    // The same read narrowed to one thread. `ts = ?` picks up the root, whose
    // own `thread_ts` is NULL, and `thread_ts = ?` picks up its replies — the
    // two halves of what a person sees when they open a thread.
    //
    // The parameter is bound twice rather than named once: `node:sqlite` binds
    // positionally, and a thread id is one value used in two comparisons.
    recentInThread: db.prepare(
      `SELECT ts, thread_ts, user_id, display_name, text, at
         FROM message
        WHERE ts = ? OR thread_ts = ?
        ORDER BY ts DESC
        LIMIT ?`
    ),
    // Provenance only. The three statements against the vec table cannot be
    // prepared here, because that table does not exist until the first vector
    // arrives — `vecStatements` below is where they live.
    //
    // RETURNING gives us the rowid the vector has to be filed under, in the
    // same statement that assigns it. DO UPDATE rather than DO NOTHING, which
    // is the opposite of `append`'s choice and for the opposite reason: a
    // redelivered Slack message is the same message and the first write wins,
    // whereas a re-embedded summary is a *new* vector for a source whose text
    // changed, and the last write is the one that is true.
    putSource: db.prepare(
      `INSERT INTO embedding_source (source_kind, source_ref, at)
         VALUES (?, ?, ?)
         ON CONFLICT (source_kind, source_ref) DO UPDATE SET at = excluded.at
         RETURNING id`
    ),
    removeSource: db.prepare(
      `DELETE FROM embedding_source WHERE source_kind = ? AND source_ref = ?`
    ),
    readModel: db.prepare(`SELECT model, dims FROM embedding_model WHERE id = 1`),
    stampModel: db.prepare(`INSERT INTO embedding_model (id, model, dims) VALUES (1, ?, ?)`),
    // Upsert on the thread, because a thread that woke up and went quiet again
    // gets one summary and not two. The DO UPDATE is every column but the key:
    // a re-summarization is a wholly new reading of the thread, so nothing from
    // the previous one survives it.
    putThreadSummary: db.prepare(
      `INSERT INTO thread_summary
           (thread_ts, shape, text, covers_through_ts, message_count, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_ts) DO UPDATE SET
           shape             = excluded.shape,
           text              = excluded.text,
           covers_through_ts = excluded.covers_through_ts,
           message_count     = excluded.message_count,
           at                = excluded.at`
    ),
    staleThreads: db.prepare(STALE_THREADS_SQL),
    readThreadSummary: db.prepare(
      `SELECT thread_ts, shape, text, covers_through_ts, message_count, at
         FROM thread_summary
        WHERE thread_ts = ?`
    )
  } satisfies Record<string, StatementSync>;

  /**
   * The statements that name `vec_embedding`, prepared on first use.
   *
   * Lazy because the table is: a store under a deployment with no embedding
   * provider never has one, and `db.prepare` against a missing table throws at
   * prepare time rather than at run time. Held in a closure variable rather than
   * beside the others so that the "every SQL string lives in this module" rule
   * is unaffected — these are still here, they are just not all built at open.
   */
  let vecStatements: {
    readonly put: StatementSync;
    readonly remove: StatementSync;
    readonly nearest: StatementSync;
    readonly nearestOfKind: StatementSync;
  } | null = null;

  function prepareVecStatements(): NonNullable<typeof vecStatements> {
    vecStatements ??= {
      put: db.prepare(`INSERT INTO vec_embedding (id, embedding) VALUES (?, ?)`),
      remove: db.prepare(`DELETE FROM vec_embedding WHERE id = ?`),
      nearest: db.prepare(NEAREST_SQL),
      nearestOfKind: db.prepare(NEAREST_OF_KIND_SQL)
    };
    return vecStatements;
  }

  /**
   * The file's model and width, or null if nothing has been embedded yet.
   *
   * Read per call rather than cached, for the reason the proxy re-reads a team
   * sheet per call: a second connection to this file may have stamped it since,
   * and a cached "no model yet" would try to create the table a second time.
   */
  function readEmbeddingModel(): { model: string; dims: number } | null {
    const row = statements.readModel.get() as { model: string; dims: number } | undefined;
    return row ?? null;
  }

  /**
   * Make sure this file can hold a vector of `dims` from `model`, or refuse.
   *
   * The first call creates the vec table and its trigger at that width and
   * stamps the model. Every later call checks agreement and does nothing else.
   *
   * The DDL and the stamp go in one transaction, and that is not ceremony. The
   * vec DDL is `IF NOT EXISTS`, so a crash between the two would leave a table
   * at the old width and no row saying so — and the next call, seeing no row,
   * would stamp *its* width against a table that does not have it. One
   * transaction makes "the table exists" and "the row says how wide" the same
   * fact.
   */
  function ensureEmbeddingSpace(model: string, dims: number): void {
    const held = readEmbeddingModel();
    if (held !== null) {
      if (held.model !== model || held.dims !== dims) {
        throw new Error(
          `memory store: ${file} holds vectors from ${JSON.stringify(held.model)} at ` +
            `${held.dims} dimensions, and was given ${JSON.stringify(model)} at ${dims}. ` +
            `A vec0 table's width is fixed at creation, so changing the embedding model is a ` +
            `rebuild of this file's vectors rather than something it can absorb.`
        );
      }
      return;
    }

    // Checked before it reaches the DDL string, because this is the one value in
    // this module that is substituted rather than bound. See `VEC_SCHEMA`.
    if (!Number.isInteger(dims) || dims < 1 || dims > MAX_EMBEDDING_DIMS) {
      throw new Error(
        `memory store: ${file} was given a ${dims}-dimension vector, and this module builds ` +
          `tables for whole widths in [1, ${MAX_EMBEDDING_DIMS}]`
      );
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(VEC_SCHEMA.replaceAll("%DIMS%", String(dims)));
      statements.stampModel.run(model, dims);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

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

    recentInThread(thread, limit) {
      const rows = statements.recentInThread.all(
        thread,
        thread,
        clampLimit(limit)
      ) as MessageRow[];
      return rows.map(toStoredMessage).reverse();
    },

    putEmbedding(embedding) {
      const { source, vector, model, at } = embedding;
      ensureEmbeddingSpace(model, vector.length);
      const vec = prepareVecStatements();

      const row = statements.putSource.get(source.kind, source.ref, at) as { id: number };
      // **BigInt, and this is the sharp edge of the whole file.** `node:sqlite`
      // binds a JS number as SQLite `real` — `SELECT typeof(?)` with 1 answers
      // "real" — and an ordinary table hides that behind column affinity, which
      // converts on the way in. A vec0 table has no affinity to apply, so it
      // sees a float where it requires an integer and refuses the row with
      // "Only integers are allows for primary key values". A BigInt binds as
      // INTEGER and is the only thing that does.
      const id = BigInt(row.id);

      // Delete-then-insert rather than an upsert: vec0 supports neither
      // ON CONFLICT nor UPDATE on the vector column, so replacing a vector is
      // two statements. The DELETE is a no-op the first time.
      vec.remove.run(id);
      vec.put.run(id, toVectorBlob(vector));
    },

    nearest(vector, limit, kind) {
      // No vec table means nothing has been embedded here, which is the
      // ordinary state under a deployment that configured no embedding provider
      // — so this answers nothing rather than throwing, exactly as
      // `openMessageReader` answers null for a channel with no store. A width
      // disagreement is the other thing entirely and still throws, from vec0
      // itself, because there is a table to disagree with.
      if (readEmbeddingModel() === null) return [];
      const wanted = clampLimit(limit);
      const statement = prepareVecStatements();

      // Unfiltered reads are unchanged — same statement, same `k`, so a caller
      // that wants whatever is nearest pays nothing for a filter it did not ask
      // for. A filtered read is a different statement rather than the same one
      // with a predicate bolted on, because the predicate has to sit inside the
      // vec0 match to mean anything.
      if (kind === undefined) {
        const rows = statement.nearest.all(toVectorBlob(vector), wanted) as HitRow[];
        return rows.map(toEmbeddingHit);
      }

      const rows = statement.nearestOfKind.all(toVectorBlob(vector), wanted, kind) as HitRow[];
      return rows.map(toEmbeddingHit);
    },

    putThreadSummary(summary) {
      statements.putThreadSummary.run(
        summary.thread,
        summary.shape,
        summary.text,
        summary.coversThroughTs,
        summary.messageCount,
        summary.at
      );
    },

    staleThreads(idleBefore, limit) {
      const rows = statements.staleThreads.all(idleBefore, clampLimit(limit)) as StaleThreadRow[];
      return rows.map(row => ({
        thread: row.thread,
        newestTs: row.newest,
        // Number(), because a COUNT(*) arrives as a bigint once a statement has
        // been switched to big-int mode, and a count that silently became one
        // would be a `messageCount` no JSON could carry.
        messageCount: Number(row.n)
      }));
    },

    readThreadSummary(thread) {
      const row = statements.readThreadSummary.get(thread) as ThreadSummaryRow | undefined;
      if (row === undefined) return null;
      return {
        thread: row.thread_ts,
        shape: row.shape as SummaryShape,
        text: row.text,
        coversThroughTs: row.covers_through_ts,
        messageCount: Number(row.message_count),
        at: Number(row.at)
      };
    },

    removeEmbedding(source) {
      // Only the provenance row is deleted here. The trigger created alongside
      // the vec table carries it into the vectors, which is why this needs no
      // branch on whether that table exists: no table means no trigger and no
      // row to delete either.
      return Number(statements.removeSource.run(source.kind, source.ref).changes) === 1;
    },

    listSkills() {
      const rows = statements.listSkills.all() as SkillRow[];
      return rows.map(row => ({
        name: row.name,
        created: row.created,
        status: row.status as SkillStatus,
        mtimeMs: Number(row.mtime_ms),
        size: Number(row.size),
        ino: Number(row.ino)
      }));
    },

    reconcileSkills(state, at) {
      const present = new Set(state.present);
      let indexed = 0;
      let dropped = 0;
      let invalidated = 0;

      // One transaction, so a reconciliation that throws part way leaves the
      // index as it was rather than half-following a directory. `staleThreads`
      // needs no equivalent because it only reads; this is the module's one
      // multi-statement write.
      db.exec("BEGIN");
      try {
        for (const entry of state.changed) {
          const before = statements.readSkillHash.get(entry.name) as
            | { description_hash: string }
            | undefined;
          const hash = hashOf(entry.description);

          statements.upsertSkill.run(
            entry.name,
            entry.description,
            entry.body,
            entry.created,
            entry.status,
            entry.mtimeMs,
            entry.size,
            entry.ino,
            hash
          );
          statements.seenSkill.run(entry.name, at);
          indexed += 1;

          // The vector goes when the text it stands for changed, or when the
          // skill has left retrieval. A first index has no `before` and no
          // vector either, so nothing is deleted and the LEFT JOIN finds it.
          const rewritten = before !== undefined && before.description_hash !== hash;
          if (rewritten || entry.status === "archived") {
            invalidated += Number(statements.dropSkillVector.run(entry.name).changes);
          }
        }

        // Deleted here rather than by a NOT IN over `present`, which would be a
        // placeholder run whose length is the size of the directory. The listing
        // is already bounded by the caller and this is one statement per row that
        // actually goes.
        for (const stored of statements.listSkills.all() as SkillRow[]) {
          if (present.has(stored.name)) continue;
          dropped += Number(statements.deleteSkill.run(stored.name).changes);
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { indexed, dropped, invalidated };
    },

    searchSkills(text, limit) {
      const match = toMatchQuery(text);
      if (match === undefined) return [];
      const wanted = clampLimit(limit);
      const rows = statements.searchSkills.all(match, wanted) as Array<{ readonly name: string }>;
      return rows.map(row => row.name);
    },

    recordSkillUse(names, at) {
      for (const name of names) statements.recordSkillUse.run(at, name);
    },

    skillsNeedingEmbedding(limit) {
      const rows = statements.skillsNeedingEmbedding.all(clampLimit(limit)) as Array<{
        readonly name: string;
      }>;
      return rows.map(row => row.name);
    },

    close() {
      db.close();
    }
  };
}

/**
 * Read the version without claiming the file.
 *
 * `checkVersion`'s counterpart, and the difference is the whole point of having
 * two: that one stamps an unstamped file because a file with no row is one the
 * writer is about to own. A reader owns nothing. It does not migrate in either
 * direction — `openAuditReader` states the rule and it is the same rule here,
 * for a stronger reason: a repaired store is a transcript with text attributed
 * to the wrong person, which the model then reasons over with no error to show
 * for it.
 *
 * A file with no `schema_version` table at all is not a message store, and
 * SQLite's own `no such table` names the table but not the file. This says which
 * file, because the caller passed a root and a channel and never a path.
 *
 * **There is no migration anywhere in this module, in either direction, and this
 * message no longer implies one.** It used to say the gateway migrates an older
 * file the first time it opens one; it does not — `checkVersion` stamps an
 * *unstamped* file and throws on any version it does not recognise. Nothing
 * repairs a store. That is why the rule on `MESSAGE_STORE_SCHEMA_VERSION` is
 * worth following rather than working around: a bump is not a migration to be
 * written later, it is every store on disk refusing to open until one is.
 */
function readVersion(db: DatabaseSync, file: string): void {
  let row: { version: number } | undefined;
  try {
    row = db.prepare("SELECT version FROM schema_version").get() as
      | { version: number }
      | undefined;
  } catch {
    throw new Error(`memory store: ${file} has no schema_version table, so it is not a message store`);
  }
  if (row === undefined || row.version !== MESSAGE_STORE_SCHEMA_VERSION) {
    throw new Error(
      `memory store: ${file} is schema version ${row?.version ?? "unstamped"}, and this build ` +
        `reads version ${MESSAGE_STORE_SCHEMA_VERSION}. A reader does not migrate, because ` +
        `migrating is writing.`
    );
  }
}

/**
 * Open one channel's messages to search them, and nothing else.
 *
 * The tool proxy's opener (#64). Four things it deliberately does not do, each
 * of which `openMessageStore` does, and each because it would be a write to a
 * file this process does not own: it sets no `journal_mode` and no
 * `synchronous`, it runs no `SCHEMA`, it creates no index and no trigger, and it
 * stamps no version. `busy_timeout` is set because it is a property of this
 * connection's patience and of nothing on disk.
 *
 * **#229 added a fifth option to the constructor and took none of that back.**
 * `allowExtension: true` sits beside `readOnly: true` here, and the two are
 * orthogonal in every observable way:
 *
 *   - It grants the `loadExtension` **method**, which this function calls once,
 *     with a path computed by `getLoadablePath()` from an installed package.
 *     Nothing about the call is influenced by the file, the channel, or anything
 *     a model wrote.
 *   - It does **not** grant the SQL function `load_extension()`. Node's
 *     authorizer denies that whether the flag is set or not — measured, in both
 *     states — so there is no SQL string, however constructed, that reaches a
 *     loader from here.
 *   - `enableLoadExtension(false)` closes the method again before this function
 *     returns, so the connection handed to the caller has neither.
 *   - `readOnly` is untouched by any of it. SQLite still refuses a write on this
 *     connection before the question of what is loaded arises.
 *
 * What the extension buys the reader is the ability to *open* a file whose
 * schema contains a `vec0` table without that table being a landmine. It buys no
 * vector query: this interface is still `search` and `close`. Whether the tool
 * proxy ever runs a nearest-neighbour search is #232's, and a method with no
 * caller was not written — the same reason there is no read-only `MEMORY.md`
 * opener.
 *
 * **`null` when the channel has no store yet**, rather than a throw. A channel
 * that has been provisioned but has not yet had a message stored is the ordinary
 * state of a new channel, not a misconfiguration — and it is the one case the
 * writer's absent `mkdir` argument does not cover, because the writer is the one
 * creating the thing whose absence is suspicious. Checked with `existsSync`
 * ahead of the open rather than by catching: a read-only connection to a missing
 * file throws the same generic error as a permissions failure or a corrupt
 * header, and answering `null` to all three would turn a broken deployment into
 * a channel that quietly remembers nothing.
 *
 * The caller closes it. It holds one prepared statement and no cache, so it is
 * cheap enough to open per call — which is what the proxy does, rather than
 * pooling handles it would then have to evict.
 */
export function openMessageReader(options: MessageReaderOptions): MessageReader | null {
  const { channel, root, logger } = options;

  // `ChannelId` for `openMessageStore`'s reason, and it matters more here: this
  // id arrives from a client certificate's CN, and validating it is what keeps
  // the join below one path segment that cannot climb out of `root`.
  if (!ChannelId.safeParse(channel).success) {
    throw new Error(`memory store: ${JSON.stringify(channel)} is not a valid channel id`);
  }

  const file = join(root, channel, STORE_FILENAME);
  if (!existsSync(file)) return null;

  const db = new DatabaseSync(file, { readOnly: true, allowExtension: true });

  try {
    db.exec("PRAGMA busy_timeout = 5000");
    assertFts5(db, file);
    loadVec(db, file);
    db.enableLoadExtension(false);
    readVersion(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const search = db.prepare(SEARCH_SQL);

  logger?.log("info", { event: "store_reader_opened", channel, file });

  return {
    search(text, limit) {
      const query = toMatchQuery(text);
      if (query === undefined) return [];
      const rows = search.all(query, clampLimit(limit)) as MessageRow[];
      return rows.map(toStoredMessage);
    },

    close() {
      db.close();
    }
  };
}
