# @getlibero/memory

Unpublished workspace package. Layers 1 and 2 of the architecture's *Memory*
section, and Layer 3's storage: one SQLite file per channel holding that
channel's messages, with an FTS5 index answering "what did we decide about X" and
a sqlite-vec table for the embeddings semantic recall will query, and beside it
the `MEMORY.md` the agent curates. See
[the architecture](https://getlibero.com/docs/architecture) (sourced from
`site/src/content/docs/docs/architecture.md`) for the specification.

`src/store-db.ts` is the whole message store — opening the file, its schema, and
every statement run against it. `src/memory-file.ts` is `MEMORY.md` and every
rule about what may be written to it. `src/atomic-write.ts` is the
durable-replace recipe the second of those uses, and it is a copy of
`packages/proxy/src/atomic-write.ts` because a leaf may not import one; #272
unifies them. `src/log.ts` is a duplicated `Logger` interface, and that
duplication is argued in the file too.

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

### `search` takes text, and the index has a tokenizer

Two decisions sit under `search`, and both are the kind that are cheap now and
expensive later.

**It takes text, never an FTS5 expression.** MATCH is a query language: a bare
`AND` is a syntax error, a trailing `*` is a prefix query, and `text:vault` is a
column filter that parses and runs. A caller passing a user's words straight
through would hand a stranger a query language. `toMatchQuery` quotes every
whitespace chunk and is deliberately absent from the barrel, so the only way to
reach it is to edit this package.

**The tokenizer is `porter unicode61 remove_diacritics 2`**, and it is chosen
once because it is baked into the index — changing it means rebuilding every
channel's file. Without stemming, an AND of the terms in "what did we decide
about the vault" does not match "we decided to ship the vault", which is the
first question the proxy's `search_channel_history` built-in (#64) would ask.

## The isolation boundary

CLAUDE.md's one-file-per-channel rule is narrowed for operator-facing data — the
budget meter and the audit log are one file with a `channel` column, because an
operator asking how a workspace is tracking needs the cross-channel query the
per-file layout forbids.

**This package takes the strict reading**, because messages are channel content:
they belong to that channel's members and are read on their behalf, so a
cross-channel join is one channel's members seeing another's conversation. A
curated `MEMORY.md` is the same content distilled, so it is held to the same
rule. Two things make that structural rather than a convention:

- There is **no `channel` column**, and for `MEMORY.md` no schema at all. The
  file is the channel, so there is no column a statement could forget to filter
  on.
- **No operation takes a channel id.** `openMessageStore`, `openMessageReader`
  and `openMemoryFile` each close over one file, so reaching a second channel is
  not something `MessageStore`, `MessageReader` or `MemoryFile` can express.

## Three openers, and what each one may touch

`openMessageStore` is the gateway's: it creates the schema, stamps the version,
and holds the six statements that write and read a channel's messages.

`openMessageReader` is the tool proxy's (#64). It opens the same file
`readOnly`, runs no DDL, stamps nothing, and exposes exactly `search` and
`close` — so the process holding every tool credential can answer
`search_channel_history` and can do nothing else to a channel's conversation.
It answers `null` for a channel with no store yet, which is the ordinary state
of a newly provisioned channel rather than a misconfiguration.

### What `allowExtension` changed about that, and what it did not

#229 gave **both** openers `allowExtension: true`, so that sqlite-vec can be
loaded (see *Node 24 and sqlite-vec* below). That flag reads much wider than it
is, and since one of the two connections it now sits on is the read-only one
held by the process with every tool credential, the difference is worth stating
precisely. Measured against `node:sqlite`, not inferred:

- It enables the `loadExtension()` **method**. This package calls it once per
  open, with a path it computes itself from an installed package. Nothing about
  the call is influenced by the file, the channel, or anything a model wrote.
- It does **not** enable the SQL function `load_extension()`. Node installs an
  authorizer that denies it, set or unset, and nothing here can turn that off —
  so there is no query, however built, that reaches a loader. There is a test
  asserting both states, because the reader holding the flag is only defensible
  while that stays true.
- `enableLoadExtension(false)` runs before either opener returns, so the widening
  lasts for the open sequence rather than for the connection's life. That is
  defence in depth around the authorizer, not the mechanism.
- `readOnly` is untouched by any of it. SQLite still refuses a write before the
  question of what is loaded arises.

What the reader gained is the ability to open a file whose schema contains a
`vec0` table without that table being a landmine. It gained **no vector query**:
the interface is still `search` and `close`. Whether the tool proxy ever runs a
nearest-neighbour search is #232's decision, and a method with no caller was not
written — the same reason there is no read-only `MEMORY.md` opener.

One cost is real and named here because it is easy to miss: the proxy opens a
reader *per* `search_channel_history` call, so a `loadExtension` happens per call
too. `dlopen` is cached by the process after the first, so what recurs is vec0's
per-connection registration rather than a load from disk.

`openMemoryFile` is the agent's, and it is the only opener of `MEMORY.md` in
either direction — the proxy neither reads nor writes that file, so there is no
read-only fourth opener and a type with no caller was not written. It exposes
`read` and `apply`, and no `close`, because it holds no handle to close.

Neither store migrates on the reader's side: a version mismatch names both
numbers and stops, because a reader that repaired a file would be a reader that
changed the evidence — and here the evidence is a transcript a model reasons
over. `MEMORY.md` has no version at all, which is the same argument arriving at
a different answer: it is markdown a person edits, so there is no schema to
stamp and nothing this package could repair without overwriting somebody's work.

## `MEMORY.md`: no lock, and what replaces it

The architecture doc used to say these writes were locked. They are not.

A lock file that outlives a killed process is a worse failure than the one it
would prevent — the vault and the token store both reject one on that ground,
and nothing about this file argues differently. Two properties cover what a lock
would have:

- **Every write lands by rename.** `src/atomic-write.ts` writes a whole
  temporary file and renames it over the target, so a reader holds the old file
  or the new one and no writer's bytes ever land inside another's.
- **Nothing here interleaves.** `apply` is synchronous from the read to the
  rename, and in a single-threaded runtime a function that never awaits has no
  point at which a second operation could run. That is why this module is
  synchronous rather than a stylistic match: `packages/proxy/src/token-store.ts`
  needs a promise-chain mutex for the same read-modify-write because its
  interface is async and a caller can hold a stale view across an `await`. A
  synchronous interface never opens that window.

**What is left is a lost update, not a torn file, and only across processes.**
Two OS processes can each read, compute and rename, and the second rename wins —
the first write is gone rather than mangled. The deployment has exactly one
writer: one `apps/server` container, no clustering, and a proxy that opens no
such file. Within it the per-channel session queue already serializes tasks.
That is a deployment property stated rather than a code property enforced, and
no test in this package would catch a second agent process writing one
`AGENT_STORE_ROOT`.

**The cap refuses and never truncates**, because a silently shortened memory is
a fact the team believes it recorded. It has one deliberate relaxation: a file
already over the cap must stay compactable, so what is refused is an operation
leaving the file both over the cap and bigger than it was. Every intermediate
state of a shrinking rewrite is over the cap too, and without this the model's
own refusal message — "replace something already in the file with a shorter
version of itself to make room" — would be advice this store refused to honour.

Two things worth knowing before you write against it. **`openMemoryFile`
throws** — on an invalid channel id, a cap below one operation's ceiling, and a
missing state directory — whereas `createMessageStoreOpener` in `apps/server`
never does, because `registry.open` is synchronous and uncaught on the path a
mention takes. A caller of this opener needs that same shape, or a mistyped
`[memory] max_file_chars` becomes a mention nobody answers.
`apps/server/src/session/memory.ts` is that caller and has it; a second one needs
it too. And **renaming over
a symlink replaces the symlink**, leaving its referent untouched: right for a
vault, and worth stating for a file the team is invited to edit, since an
operator who symlinked `MEMORY.md` into a git-tracked directory finds a regular
file there after the first curation.

## Semantic recall: what #229 built and what it left

Layer 3 stores vectors here and computes none. `putEmbedding`, `nearest` and
`removeEmbedding` are on `MessageStore` and on nothing else; there is no producer
in the tree yet, because #230 is what gives the completion layer an `embed()` and
#231 is what writes the summaries to embed. **This package never holds a model
provider key** — it is a leaf and the key belongs to the agent.

Three decisions are worth knowing before extending it.

**The vec table is created on the first vector, not at open.** A `vec0`
declaration bakes the dimension in, and the dimension comes from whichever
embedding model a deployment configured — possibly none. So a store under a
deployment running Layers 1 and 2 carries no vec table at all, `nearest` answers
nothing rather than throwing, and the width and the model id are stamped once in
`embedding_model` when the first vector arrives. A later vector under a different
model or width is **refused naming both**, because a `vec0` table's width is
fixed at creation: changing the embedding model is a stated rebuild, not
something a file absorbs.

**Model and dimensions are recorded once per file rather than once per row.**
#229 asked for them per vector. One table holds one width under one model, so per
row would be the same two values repeated with N−1 chances to disagree with the
table describing them.

**Provenance is an ordinary table, and that is what #233 will need.** A virtual
table cannot carry a trigger, so `embedding_source` is where the delete lives and
a trigger created alongside the vec table carries a deletion into the vectors.
`source_kind` is `fact` or `summary` — #223's corpus — and is deliberately *not*
a CHECK constraint: neither producer exists yet, so a constraint now would be a
guess to migrate away from later. `EmbeddingSource` is where the set is stated.
Messages are absent on purpose; Layer 1 answers those with FTS5.

The schema version did **not** move for any of this, which is the rule in
*Three openers* applied rather than forgotten. See the constant's doc block in
`src/store-db.ts`: it was measured first, and a connection with the extension not
loaded still answers every statement this module makes except one naming the vec
table itself.

## The store is a leaf

It depends on `@getlibero/schema` and nothing else **in the workspace**. Both
services open these files — the gateway writes, the proxy reads — so the package
is imported from either side and may name neither. An ESLint block on
`packages/memory/**` enforces that; `src/log.ts` duplicating an interface rather
than importing one is the visible cost. The cost buys something concrete: a
`Logger` imported from the gateway would put the Slack SDK into the proxy's
image through an edge no import in the proxy names.

Outside the workspace it has exactly one dependency, and #229 added it:
`sqlite-vec`. It is the first dependency in this repository whose payload is a
**binary** rather than JavaScript, and because `packages/proxy` imports this
package, that binary is in the image of the process holding every tool
credential. Both Dockerfiles say so rather than leaving it to be discovered.
What bounds it is `loadVec` and the `allowExtension` section above.

## Node 24, and sqlite-vec

The full-text index needs SQLite's FTS5, and the built-in `node:sqlite` was
compiled without it until 22.16 — the define is absent from
`deps/sqlite/sqlite.gyp` through v22.15 and present from v22.16.0 and v24.0.0.
That is why this repo's floor moved from 22.13 to Node 24. `assertFts5` refuses
a build without it at open, naming the floor rather than letting SQLite report
`no such module: fts5`.

`loadVec` is that function's counterpart for sqlite-vec, and differs in one way
that shapes it. FTS5 is a compile-time option, so `sqlite_compileoption_used` can
be *asked* before any DDL runs; a loadable extension has no equivalent, and the
only way to learn whether it loads is to load it. So `loadVec` is a try/catch
that names the package, the file, the platform and the Node version, over two
distinct failures: no prebuild for this platform, and a prebuild that will not
`dlopen`.

The second one is why **the service images are Debian and not Alpine**. Every
published `vec0.so` links glibc — the binary names `libc.so.6` and versioned
GLIBC symbols — and sqlite-vec ships no musl build, so on Alpine it does not load
at all. `apps/proxy-server/Dockerfile` carries the argument, including why
compiling the amalgamation in the build stage was rejected. sqlite-vec's
prebuilds cover linux and darwin on x64 and arm64, and win32 on x64; CI runs
`ubuntu-latest` only, so no CI job would notice a missing darwin-arm64 prebuild
before a maintainer did.

## What is not here

Layer 2 is whole as of #227: the write machinery here (#225), the curation turn
that emits operations (#226), and the read that puts `MEMORY.md` back into the
context a task starts from. Layer 3 has its storage half as of #229 and nothing
above it: no embeddings are computed anywhere in the tree (#230), no summaries
are written (#231), nothing retrieves (#232), and a Slack deletion does not yet
reach a vector or a summary derived from the deleted message (#233). Slack
deletion and edit mirroring of *messages* is not among the gaps: #177 wired
`message_deleted` and `message_changed` onto `remove` and `replaceText`, through
`toRevision` in the gateway and `createRevisionIngest` in `apps/server`.

One rule that belongs here rather than there, because it is about what this
store is: **an edit is not a way in.** `replaceText` answers false for a ts the
file does not hold and the caller leaves it at that. Turning it into an insert
would make a second write door with none of the first one's filters — an app's
own message, a `channel_join`, any subtype the allowlist declined, all
recordable by being edited afterwards.

One thing about the file's location moved with #176 and is worth knowing before
you write a second caller. `openMessageStore` still creates no directory, but
the argument changed: the store lives under `AGENT_STORE_ROOT`, not beside the
channel's `channel.toml`, so the directory existing is no longer the operator's
statement that the channel exists. The check that a channel has a team sheet is
now explicit, in `apps/server/src/session/store.ts`, and a caller that skipped
it would be inventing a channel. The header of `src/store-db.ts` has the full
account.
