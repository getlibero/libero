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

## Four openers, and what each one may touch

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
read-only counterpart and a type with no caller was not written. It exposes
`read` and `apply`, and no `close`, because it holds no handle to close.

`openSkillFiles` is the agent's too (#290), over `skills/` beside `MEMORY.md`.
Same shape and the same reasons — no channel id on any method, no `close`, no
cache — with three differences that come from its being a *directory* rather than
a path:

- **A name becomes a path segment**, and `SkillName` in `@getlibero/schema` is
  the one rule about that, the way `ChannelId` is the one rule about a channel
  id. A name that parses is already canonical, so it is the filename stem on
  every filesystem and there is no slug function here — which matters more than
  it sounds, because this repo is developed on a case-insensitive filesystem and
  deployed on a case-sensitive one.
- **`list()` enumerates**, which nothing else in this package does. It is not the
  cross-channel iteration the proxy's sheet store refuses: the factory closed
  over one directory, no method takes a channel id, and listing one channel's own
  skills is the class of act `recent(limit)` already is. It answers names and
  never text, which is what keeps it cheap enough to be the count an operation is
  bounded against.
- **The filter is a name round-trip, not a `.md` suffix.** A stem that does not
  parse is not a skill, so `Deploy-Runbook.md`, `deploy_runbook.md`,
  `.hidden.md`, `deploy.md.md` and the temporary file `replaceFileAtomically`
  plants mid-write are all the same refusal.

Two rules that file settles, because they are hand-edit outcomes rather than edge
cases. **The filename is the identity**: a `skills/deploy.md` whose frontmatter
says `name: rollback` is skipped and logged, never re-keyed and never repaired.
And **existence is a fact about the file, not its contents**, so a create on a
name whose file is unparseable is `name_taken` while a revise on it succeeds —
a revision replaces the whole document, so repairing a broken file is what it is
for, and deciding it the other way would leave a name on which neither operation
could run.

A revision carries `created` and `status` forward from the file it replaces.
Neither is the model's — the operation shapes have no field for either — so
restamping them would reset a date the team can see and un-archive a skill the
lifecycle job had retired.

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

## Thread summaries, and why a thread has a *shape*

`thread_summary` is Layer 3's second corpus and the one that makes it worth
having (#231). Curated facts are already injected whole into every task's
opening context, so retrieval over them replaces "all of it" with "some of it";
summaries are the corpus too large to inject.

**The summary's frame follows what the thread produced.** A single "summarize
this" prompt retrieves badly, because work threads do not all produce the same
kind of durable thing. Some reach a decision; many more are a question that got
answered, which is FAQ material by construction; some are an incident; some end
unresolved. One frame forced onto all of them either distorts the Q&A threads
into decisions nobody made — "the team decided rotation uses `--rotate`", when
that is simply how the tool works — or flattens everything into topic labels
that embed on top of each other. `SummaryShape` in `@getlibero/schema` carries
the vocabulary and the full argument.

**A `nothing` thread gets a row here and no vector**, and the split is the
point. This table records that a thread was *assessed*; the vector store is the
corpus. Keeping "deploying now" out of the corpus is what protects retrieval — a
vector for it sits in the neighbourhood of every deployment question and dilutes
all of them. Keeping it out of *this* table would instead mean the sweep offers
the thread again on every pass and pays a model call to conclude "nothing"
forever.

**Provenance is `(thread_ts, covers_through_ts)`.** #231 asks that a summary
name its source rows, and that pair does: a thread is a contiguous run of
messages under one root, so the thread and a watermark name exactly the set.
A list of every source `ts` would be the same set enumerated, and would go stale
differently from the messages it names. The key is the root `ts` and never
`message.id`, because that rowid is internal and reused after a delete.

**A summary does not outlive the text it was drawn from.** Two triggers on
`message` drop the summary on any edit or deletion — any UPDATE, not one
touching `text`, exactly as `message_fts_update` does and for the same reason —
and a third carries that into `embedding_source`, whose own trigger drops the
vector. That chain is two levels deep and fires under `recursive_triggers = off`,
which is SQLite's default: that pragma governs a trigger re-entering *itself*,
not one trigger activating another. It invalidates rather than regenerating,
because regenerating needs a model call and this is a SQLite trigger; the thread
becomes unsummarized and the next sweep picks it up. The window that leaves is on
the side of saying nothing rather than saying something retracted.

`staleThreads` is the read the sweep runs: threads whose newest message is older
than a given `ts` and which have no summary covering it. It takes a `ts` rather
than a duration, so the decision about how quiet is quiet stays with the caller
that reads the channel's sheet and this module holds no clock.

**The ceiling this leaves.** One vector stands for one summary, so a very long
thread becomes a centroid averaged over several topics and retrieves none of
them well. `SUMMARY_MAX_TEXT_CHARS` bounds the text and `MAX_THREAD_MESSAGES` in
`apps/server` bounds what goes in, but neither *segments* — a thread that should
be several summaries is still one. That is a known limit rather than an oversight,
and `message_count` is on the row so an operator can see when it is being hit.

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

## The skill index, and the one rule it exists to keep

`skill`, `skill_fts` and `skill_use` are the retrieval half of #290, and
`reconcileSkillIndex` is what keeps them true. The rule they encode is one
sentence: **the file is the source of truth for everything a human authored, the
index for everything the runtime observed about it, and reconciliation reads
files and never writes them.**

That is a shape rather than a convention. `reconcileSkills` is the *only* thing
that writes the skill tables — there is no `putSkill` and no `removeSkill` —
because either would be a second path by which the index could come to disagree
with the directory, and neither could be reviewed for whether its caller had
looked at a file first. A skill written through `apply` and a skill somebody
added with an editor reach the index by exactly the same road.

**The index holds no text a caller reads.** `description` and `body` are columns
so FTS5 has something to match; nothing returns either. A candidate is resolved
through `openSkillFiles().read`, the way a `nearest` hit is resolved through
`readThreadSummary` — which is what makes a stale index harmless rather than
dangerous. A row standing for a file that was deleted or broken resolves to
nothing and is skipped; it can never put a deleted playbook's words in front of a
model because reconciliation had not run yet. That is the one change to this
table that must not be made.

**Detection is cheap and repair is not, so they are separate.** A steady-state
pass is a `readdir` and a `stat` per entry: no file is opened and nothing is
parsed. Only an entry whose fingerprint moved is read, and only a skill whose
*description* moved costs an embedding — the body and the status can both change
for free, which is what keeps a lifecycle job's weekly status rewrite from
paying for a vector it does not need.

The fingerprint is `mtime_ms`, `size` and `ino`, and all three are carried
because this directory has two kinds of writer that miss different ones. A write
through `apply` lands by rename, so the inode always moves and catches a rewrite
that changed neither length nor millisecond; a person's editor rewrites in place,
so the inode does *not* move and mtime and size are what catch it. What none of
them catches is an in-place rewrite of identical length with the timestamp forced
back — `touch -r`, or a restore that preserves times. There is no cheap
fingerprint that would, and the consequence is bounded by the paragraph above.

**Reconciliation embeds nothing.** This package has no model provider, exactly as
`putThreadSummary` writes no vector, so what a pass leaves behind is rows with no
vector standing for them and `skillsNeedingEmbedding` is how a caller that has a
provider finds them. The honest consequence: a just-edited skill is findable by
full text on the very next task and semantically only after something has
embedded it.

Two failures here are not errors. A file that stops parsing **keeps its last good
row** — a half-saved edit does not erase a skill's use counters — at the cost of
one parse attempt per pass until somebody fixes it. And a directory holding more
skills than the sheet allows is **truncated rather than refused**: the first
`max_skills` by name are the library and the rest are logged and left on disk,
because losing retrieval entirely is a worse answer than a deterministic subset.

### `nearest` grew a kind, and it was not optional

All three corpora share one `vec_embedding`. `k` is spent *inside* the vec0
match, so a caller that asked for five and filtered afterwards would get whatever
survived — and against a file dominated by another kind, that is nothing. A
recall that quietly returns nothing looks like a channel with no memory rather
than like a bug, which is the worst failure this layer has.

So `nearest` takes a kind and pushes it into the search as `id IN (SELECT ...)`,
which vec0 applies *before* it picks its neighbours. That makes a filtered read
exact rather than a heuristic. Over-fetching some multiple and filtering here was
the obvious alternative and it is wrong for a reason worth recording: no multiple
is enough, because the ratio between two corpora is unbounded — a channel
accumulates one summary per quiet thread forever while skills are capped at a
hundred — so it would fail exactly where it was needed, and only in the
deployments that had been running longest. `searchSkills` excludes archived
skills the same way, with FTS5's `rowid IN (...)` beside its MATCH.

Note the spelling: the vec table's key column is `id`, and `rowid` answers
`no such column`. Measured rather than assumed.

### `searchSkills` ORs its terms where `search` ANDs them

Two builders, `toMatchQuery` and `toAnyMatchQuery`, sharing their escaping and
differing only in the joiner — and the difference is that the two answer
different questions.

`search` is handed words a person chose and means conjunctively; dropping it to
OR would drown a real search in documents matching one common word.
`searchSkills` is handed a **whole question somebody asked in Slack**, because
what calls it is retrieval at the head of a task. Under the implicit AND, "how do
we cut a release?" requires every one of `how`, `do`, `we`, `cut`, `a` and
`release` to appear in the skill, which no real playbook does — so the lexical
leg of skill retrieval answered nothing, always. That was #292's finding, and it
mattered most exactly where it hurt most: the team sheet points this path at
deployments with no embedding provider, where full text is the only leg there is.

**What OR costs is a weak match, and the obvious fix does not work.** A question
sharing only `a` or `is` with a skill is a hit. Filtering those out looks like a
one-line `AND rank < ?`, FTS5 does accept one beside the MATCH, and on a
three-skill corpus the separation is clean — a content-word match scores −1.46, a
stop-word match −1.3e-6. It is still wrong: bm25's IDF is floored at `1e-6` when
a term appears in every document, so on a channel holding *one* skill every term
takes the floor and every match scores `1e-6`. Any threshold that excludes a
stop-word match in a large library also excludes the only skill a small one has,
and a skill library is small by design. Tried, measured, reverted; the DDL says
so where someone would otherwise add it back.

So the weak match stands, which is the position `session/recall.ts` already holds
for having no distance cutoff, reached independently and pointing the same way:
something weak and visible beats a channel that looks like it has no playbooks.
What bounds it is the caller's — `[skills] top_k` and a character ceiling.

## What is not here

**Skills are whole as of #291**, storage and both directions. `apps/server`
reconciles this directory at the head of every task, fuses the two retrieval
primitives, renders the winners into the opening context and records a use for
each (#292); after a task heavy enough in served tool calls, the skill-author
turn writes through `openSkillFiles().apply` (#291). A skill somebody adds with
an editor and a skill an operation wrote reach the index by the same road, which
is what this package was built for and is still the only road there is.

What is not here is the lifecycle job that runs the stale and archive clocks over
`skill_use` (#294), and the curator that proposes merges of overlapping skills
(#295). `status_by_job` and `status_by_job_at` are the columns waiting for the
first of those.

`reconcileSkillIndex`'s caller is `apps/server/src/session/skill-recall.ts`, and
it is the only one. It runs at the head of a task inside the session's lock,
which is where it belongs: the moment correctness is required is the moment
retrieval runs, and outside the lock the pass would race the quiescence sweep's
writes and, once #291 lands, the previous task's authoring. The fusion itself —
a round-robin interleave over the two rank lists, on the argument that an L2
distance and an FTS5 rank are not comparable — is over there rather than here,
with the bounds it applies. See `apps/server/README.md`.

Layer 2 is whole as of #227: the write machinery here (#225), the curation turn
that emits operations (#226), and the read that puts `MEMORY.md` back into the
context a task starts from. Layer 3 has its storage half as of #229, an
embedding surface as of #230, and thread summaries as of #231. Retrieval landed with #232: `apps/server`
embeds the incoming request at the head of a task and renders the nearest
summaries into its opening context. That is context assembly rather than a tool,
and the argument — including why a model-invoked recall tool was rejected as an
ungoverned twin of `search_channel_history` — is in `apps/server/README.md`. #233 closed the loop on deletion: the triggers
here drop a summary and its vector on an edit or a delete, `e2e/` now drives
that through real Slack events in all three wire shapes, and the one thing
deletion deliberately does **not** reach — a curated fact in `MEMORY.md`, which
carries no per-message provenance because curation is a model turn rather than a
join — is argued on the security page rather than left to be assumed. Slack
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
