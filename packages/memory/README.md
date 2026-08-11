# @getlibero/memory

Unpublished workspace package. Layer 1 of the architecture's *Memory* section:
one SQLite file per channel holding that channel's messages, with an FTS5 index
answering "what did we decide about X". See
[the architecture](https://getlibero.com/docs/architecture) (sourced from
`site/src/content/docs/docs/architecture.md`) for the specification.

`src/store-db.ts` is the whole store — opening the file, its schema, and every
statement run against it. `src/log.ts` is a duplicated `Logger` interface, and
the duplication is argued in the file.

## Three reads, and they are not each other

`search(text, limit)` answers "what was said about this": ranked full-text,
best match first, and it takes **text and never an FTS5 expression**.

`recent(limit)` answers "what was said here lately": the newest N, returned
**oldest first**. It is what a transcript is assembled from (#67). Reading order
rather than newest-first is the API's decision, not the caller's — the statement
sorts descending because that is the only way to ask SQLite for a tail, and a
caller made to reverse it is a caller that can forget to.

`recentInThread(thread, limit)` is that read narrowed to one sub-conversation
(#66), and identical in every other respect. **A thread's identity is its root
message's `ts`**: the root carries `thread_ts = NULL` and every reply carries the
root's `ts`, so a thread is one row matching on `ts` and the rest matching on
`thread_ts`. An unknown thread answers nothing rather than throwing — a caller
may hold a ts from a conversation that started before this file did.

Ordering is on `ts`, compared as a string, and that is correct because a Slack
timestamp is fixed-width: ten digits of seconds, a dot, six more. The two
alternatives are both wrong. `id` is insertion order, which a redelivery or a
late event reorders; `at` is when this store *learned* of a message, which is a
different clock.

All three are clamped to `READ_MAX_LIMIT`, which is one ceiling rather than
three because what it bounds is the same thing every time: how much of this file
a single call can pull into a model's context.

## The isolation boundary

CLAUDE.md's one-file-per-channel rule is narrowed for operator-facing data — the
budget meter and the audit log are one file with a `channel` column, because an
operator asking how a workspace is tracking needs the cross-channel query the
per-file layout forbids.

**This package takes the strict reading**, because messages are channel content:
they belong to that channel's members and are read on their behalf, so a
cross-channel join is one channel's members seeing another's conversation. Two
things make that structural rather than a convention:

- There is **no `channel` column**. The file is the channel, so there is no
  column a statement could forget to filter on.
- **No operation takes a channel id.** `openMessageStore` and `openMessageReader`
  each close over one file, so a query spanning two channels is not something
  `MessageStore` or `MessageReader` can express.

## Two openers, and only one of them writes

`openMessageStore` is the gateway's: it creates the schema, stamps the version,
and holds the six statements that write and read a channel's messages.

`openMessageReader` is the tool proxy's (#64). It opens the same file
`readOnly`, runs no DDL, stamps nothing, and exposes exactly `search` and
`close` — so the process holding every tool credential can answer
`search_channel_history` and can do nothing else to a channel's conversation.
It answers `null` for a channel with no store yet, which is the ordinary state
of a newly provisioned channel rather than a misconfiguration.

Neither migrates on the reader's side: a version mismatch names both numbers and
stops, because a reader that repaired a file would be a reader that changed the
evidence — and here the evidence is a transcript a model reasons over.

## The store is a leaf

It depends on `@getlibero/schema` and nothing else in the workspace. Both
services open these files — the gateway writes, the proxy reads — so the package
is imported from either side and may name neither. An ESLint block on
`packages/memory/**` enforces that; `src/log.ts` duplicating an interface rather
than importing one is the visible cost. The cost buys something concrete: a
`Logger` imported from the gateway would put the Slack SDK into the proxy's
image through an edge no import in the proxy names.

## Node 24

The full-text index needs SQLite's FTS5, and the built-in `node:sqlite` was
compiled without it until 22.16 — the define is absent from
`deps/sqlite/sqlite.gyp` through v22.15 and present from v22.16.0 and v24.0.0.
That is why this repo's floor moved from 22.13 to Node 24. `assertFts5` refuses
a build without it at open, naming the floor rather than letting SQLite report
`no such module: fts5`.

## What is not here

The mirroring of Slack deletions and edits onto `remove` and `replaceText` is
#177: `message_changed` and `message_deleted` reach the process today and are
dropped with their own reason code, so the two paths built here are still
unused. Layers 2 and 3 of the spec (`MEMORY.md` curation, sqlite-vec recall) are
phase 2.

One thing about the file's location moved with #176 and is worth knowing before
you write a second caller. `openMessageStore` still creates no directory, but
the argument changed: the store lives under `AGENT_STORE_ROOT`, not beside the
channel's `channel.toml`, so the directory existing is no longer the operator's
statement that the channel exists. The check that a channel has a team sheet is
now explicit, in `apps/server/src/session/store.ts`, and a caller that skipped
it would be inventing a channel. The header of `src/store-db.ts` has the full
account.
