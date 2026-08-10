# @getlibero/memory

Unpublished workspace package. Layer 1 of the architecture's *Memory* section:
one SQLite file per channel holding that channel's messages, with an FTS5 index
answering "what did we decide about X". See
[the architecture](https://getlibero.com/docs/architecture) (sourced from
`site/src/content/docs/docs/architecture.md`) for the specification.

`src/store-db.ts` is the whole store — opening the file, its schema, and every
statement run against it. `src/log.ts` is a duplicated `Logger` interface, and
the duplication is argued in the file.

## Two reads, and they are not each other

`search(text, limit)` answers "what was said about this": ranked full-text,
best match first, and it takes **text and never an FTS5 expression**.

`recent(limit)` answers "what was said here lately": the newest N, returned
**oldest first**. It is what a transcript is assembled from (#67). Reading order
rather than newest-first is the API's decision, not the caller's — the statement
sorts descending because that is the only way to ask SQLite for a tail, and a
caller made to reverse it is a caller that can forget to.

Ordering is on `ts`, compared as a string, and that is correct because a Slack
timestamp is fixed-width: ten digits of seconds, a dot, six more. The two
alternatives are both wrong. `id` is insertion order, which a redelivery or a
late event reorders; `at` is when this store *learned* of a message, which is a
different clock.

Both are clamped to `READ_MAX_LIMIT`, which is one ceiling for both because what
it bounds is the same thing either way: how much of this file a single call can
pull into a model's context.

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
- **No operation takes a channel id.** `openMessageStore` closes over one file,
  so a query spanning two channels is not something `MessageStore` can express.

## The store is a leaf

It depends on `@getlibero/schema` and nothing else in the workspace. #64 has not
decided whether `search_channel_history` is answered by the proxy opening this
file as a second reader or by the gateway answering a callback, so the package
has to be importable from either side — which means it may name neither. An
ESLint block on `packages/memory/**` enforces that; `src/log.ts` duplicating an
interface rather than importing one is the visible cost.

## Node 24

The full-text index needs SQLite's FTS5, and the built-in `node:sqlite` was
compiled without it until 22.16 — the define is absent from
`deps/sqlite/sqlite.gyp` through v22.15 and present from v22.16.0 and v24.0.0.
That is why this repo's floor moved from 22.13 to Node 24. `assertFts5` refuses
a build without it at open, naming the floor rather than letting SQLite report
`no such module: fts5`.

## What is not here

`search` has no caller yet. #176 fills a store and #67 reads one back with
`recent`, both from `apps/server` — but who answers `search_channel_history` as
a *tool* is still #64's to settle: the proxy opening `store.db` as a second
reader, or the gateway answering a callback. That is the open question the
ESLint block on this package exists to keep open.

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
