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
rule about what may be written to it. The durable-replace recipe the second of
those uses is `@getlibero/atomic-write` — a leaf under this leaf, `node:`
builtins and no dependencies at all, which is what makes it importable from a
package that may depend on neither service. It lived here as a hand-kept copy
until #272 unified the three that existed. `src/log.ts` is a duplicated `Logger`
interface, and that duplication is argued in the file too — it stayed duplicated
because an interface the gateway also declares has no third home to move to.

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

`openSharedSkillFiles` (#434) is the one opener that closes over a directory
belonging to no channel, and it does not weaken either rule. The rule is about
channel *content* — whose data it is and who reads it — and an operator's
published playbook is neither: it is configuration, it is the same canonical file
for every channel that names it, and nothing in a channel's store or conversation
reaches it. What is per-channel about a shared skill is which ones a sheet named
and what that channel's own index and vectors hold, and both stay on the channel's
side of the seam. The handle is read-only besides, so the direction that would
matter — one channel's agent writing something another channel's agent reads — is
not expressible either.

## Six openers, and what each one may touch

`openMessageStore` is the gateway's: it creates the schema, stamps the version,
and holds the six statements that write and read a channel's messages.

`openMessageReader` is the tool proxy's (#64). It opens the same file
`readOnly`, runs no DDL, stamps nothing, and exposes `search`, `close`, and —
since #323, a reviewed widening documented below — `pendingScheduledTasks`,
which answers an integer. The process holding every tool credential can answer
`search_channel_history` and count waiting checks, and can do nothing else to a
channel's conversation.
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

`openSharedSkillFiles` is the fifth (#434), and it is the only opener here over
a directory that belongs to **no channel**: the operator's shared-skill root,
`<root>/<name>.md`, mounted read-only into the agent service (#433). A team sheet
names which of those skills a channel gets, and the content is one canonical file
rather than a copy per channel.

It has three methods — `list`, `fingerprints`, `read` — and no fourth. `SkillFiles`
has five, and the two that are missing are the point rather than an omission:
there is no `apply` and no `setStatus`, so a write is not something the calling
code can express. That is #373's blast-radius argument made structural. A
compromised agent that poisons a channel-authored skill poisons one channel's
future tasks; a writable shared skill would be one file poisoning every channel at
once, which is the cross-channel amplification the per-channel layout exists to
prevent. The `:ro` mount is the enforcement and this interface is the second lock,
and neither alone is enough — a mount an operator got wrong leaves only the code,
and code in a process an attacker controls is no guard at all.

Two smaller decisions. It answers **`null` for a root that does not exist**,
`openMessageReader`'s shape, so "the operator scaffolded the directory and
published nothing" and "the mount did not happen" are not the same silence — the
first is a working deployment and the second is #433's `doctor` check firing. And
`read` takes the **bare** name, because that is the filename: `shared/<name>` is
an address the index keys on, and the two forms are converted at one seam and
nowhere else.

The read half it shares with `openSkillFiles` — the `SkillName` round-trip on the
stem, the `stat` fingerprint, the parse — lives in `skill-dir.ts`, which is not
exported. A caller holding it could point it at a channel's own `skills/` and get
a reader of it that no team sheet gated.

`openSkillProposals` is the sixth opener and the merge curator's (#295), over
`proposals/` beside `skills/`. **A sibling and never a child**, which is
load-bearing rather than tidy: `openSkillFiles` lists its directory by
round-tripping each filename stem through `SkillName`, so a proposal dropped in
there whose stem happened to parse would be indexed as a skill — a third playbook
quoting two others, retrievable into a later task's context. The `--` in a
proposal's filename is a sequence `SKILL_NAME_PATTERN` cannot produce.

**It has no `read`, and that is the module's central decision.** Nothing in the
process ever reads a proposal back: what stops a pair being raised twice is
`skill_merge_proposal` in the index, what finds a proposal whose skill is gone is
`orphanedSkillMergeProposals`, and what applies one is a person with an editor.
Three things follow, and the middle one is the reason. There is **no path by
which model-authored text in that directory re-enters a model's context** — a
`read` would create one, and "a file the agent wrote, quoting two skills, that
the agent later reads" is exactly the shape the e2e suite's skill attacks exist
to keep closed. The format therefore needs no parser, no version and no
`proposal_unusable` word. And a team can annotate or rewrite a proposal before
applying it with nothing noticing, which is the right relationship with a file
that is a suggestion.

It also has no method that names a skill file, which is the structural half of
"the curator writes no skill file" — the other half being that the merge turn in
`packages/agent` takes no handler at all.

`setStatus` is the fifth operation and the lifecycle job's only write (#294). It
is a method rather than a third `SkillOp` precisely so the model cannot reach it:
the operation shapes are strict and have no `status` field, so what moves one is
either a hand edit or a clock. Three properties are worth stating because each is
a test. It **reads before it writes and refuses a file it could not parse**,
which is what stops a weekly clock overwriting somebody's half-saved edit. It
**creates nothing** — no `mkdir`, no file — so it can never be what brings
`skills/` into being for a channel whose sheet turned the feature off. And it
**answers `unchanged` without touching the file** when the status already
matches, which is what keeps a steady-state pass from renaming every skill in the
library and making the next reconciliation re-read all of them.

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

- **Every write lands by rename.** `@getlibero/atomic-write` writes a whole
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

`idleThreads` is its sibling and answers a different question (#319): threads
quiet since a given `ts` **whose newest message is after a second one**, the
caller's watermark. It exists rather than being a third argument to
`staleThreads` because that read is joined against the summary corpus — a channel
with `[memory] summarize` on would have its quiet threads summarized away and
answer nothing, which would blind the one feature that exists for the question
nobody replied to. Both bounds sit on the aggregate for `staleThreads`' reason,
and both use the same `message_root` index; it adds a read and moves no schema
version.

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

**And #282 built the way out that refusal points at.** `dropEmbeddings` clears
the vectors, the provenance rows, the vec table and the stamp in one transaction,
so the next `putEmbedding` creates the table again at whatever width it is given;
`summariesNeedingEmbedding` is what a rebuild then walks, and `embeddingModel`
is how a caller asks what a file holds without having a vector to be refused
with. Three things are worth knowing about that trio. **The corpus is
untouched** — `thread_summary` rows and the skill index survive a drop, which is
what makes a rebuild cost embedding calls and no completion ones. **The read
excludes a `nothing` summary in SQL** rather than leaving it to the caller,
because there are now two callers of that rule and a rule applied by callers is a
rule forgotten in one of them. And **the drop clears the cached vec statements**:
node:sqlite lets a `DROP TABLE` through with prepared statements live and then
throws `no such table` on the next use, which would be the same handle a rebuild
is writing through. `apps/server`'s `rebuild` entrypoint is the only caller of
any of it — nothing here is reachable from a route or from anything a model can
influence.

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
`reconcileSkillIndex` — with `reconcileSharedSkillIndex` beside it since #434 —
is what keeps them true. The rule they encode is one
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
for free, which is what keeps the lifecycle job's status rewrite from paying for
a vector it does not need. That last is tested rather than asserted as of #294:
ageing a skill and then asking `skillsNeedingEmbedding` answers nothing.

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

### Two halves of one index, and the column that keeps them apart (#434)

Since v0.5.0 a channel's index holds two kinds of skill. One is the kind it grew:
authored by its own tasks into `<store>/<channel>/skills/`, aged by the lifecycle
job, nominated for merges by the curator. The other is the kind an operator
published into the shared root and this channel's team sheet named — the same
canonical file reaching every channel that asked for it.

`skill.origin` is which. `'channel'` or `'shared'`, and it is a column rather than
something derived from the name, which the schema package's `sharedSkillRef`
header settles in a sentence: the column is the fact, the prefix is how it is
addressed. A shared row *is* keyed under the qualified form — `shared/brand-voice`
— and that keying is what stops the two halves colliding on `skill.name`'s UNIQUE
when a channel grows a playbook that shares an operator's name. `/` is not in
`SKILL_NAME_PATTERN`, so no channel-authored name can ever spell it.

**Three queries are scoped to `'channel'`, and each is a rule about who may write
a file.** `skillClocks` is, so the lifecycle job cannot see a shared skill at all
— its next act on what it reads is `setStatus`, which on that half would be a
write into a read-only mount. `SKILL_MERGE_CANDIDATE_SQL` is, so the curator
cannot nominate one; the exclusion is in the `live` CTE rather than in the final
SELECT, because a shared skill left in the candidate set is still some channel
skill's nearest neighbour and would take the `rn = 1` slot its real pair wanted.
And `listSkills` takes the origin as a **required** argument, because both its
callers are diffing one directory against the rows that directory owns.

That last one is not a nicety. `reconcileSkills` deletes every row not in
`present`, and a channel's reconciliation runs four times a task knowing nothing
of the shared root — so an unscoped delete would take the shared half away on the
first of them and the shared pass would put it back on the next, forever. One
pass is one origin, on both the write and the delete.

What is deliberately *not* scoped: `searchSkills`, `nearest` and
`recordSkillUse`. A `retrieved` shared skill belongs in both retrieval legs and
has to earn a vector like any other, and its uses are recorded while no clock
reads them — which is #373's wording exactly.

`skillsNeedingEmbedding` is the fourth of those and is not scoped *by default*
(#436): a caller that omits the origin gets both halves, and the query is
unchanged. What the argument is for is the caller that cannot address one half.
The batch is ten names in name order and `shared/` sorts after every channel name
from `a` to `r`, so a caller filtering the unscoped read afterwards would be
filtering a window the unaddressable half had already filled — and, because it
embeds none of what filled it, would find the same window on the next pass and
every pass after. That is not a wasted call but a permanent stall, and the
channel it stalls is the one with `[skills] enabled = false` and a `[[shared_skill]]`
entry, whose sheet promises exactly that the entry resolves anyway. Scoping
`nearest` or `searchSkills` the same way is a different question and the answer
is no: the first would mean joining `skill` inside a vec0 match on a method that
knows nothing of skills beyond a kind string, and the second would put a
membership rule in the store that the server applies regardless.

The shared pass differs from the channel's in three ways, all in
`reconcileSharedSkillIndex`. The **sheet** bounds the set rather than
`[skills] max_skills`, so a published file this channel did not name never enters
its index. A named skill the root does not hold is simply absent — not an error
and not a row, because saying so out loud belongs where the prompt text is
assembled, which is the one place that knows a channel asked and did not get. And
only `retrieved` entries are indexed at all: an `always` entry is read straight
from its file into the standing region of the prompt, and indexing one would put
it in the retrieval pool as well, so a task near its subject would pay for it
twice in the same prompt. That is why this package never learns what a load mode
is — the caller has spent it before it gets here.

### The column that arrived after its table, and the repair that let it

`db.exec(SCHEMA)` is `CREATE TABLE IF NOT EXISTS` throughout, so a column added to
a DDL reaches new files only, and `readVersion` refuses a version mismatch
outright. Both facts are stated at length in `store-db.ts`, and the conclusion
drawn from them until #434 was that a column cannot be added to an existing table
here at all — which is why `skill_use` landed two columns an issue ahead of their
reader rather than adding them later, and why `skill_merge_notice` is a table
rather than a column on the row beside it.

`origin` is the exception, and `migrateSkillOrigin` is the whole of it: on the
**writer's** open path, `PRAGMA table_info(skill)` and one `ALTER TABLE … ADD
COLUMN origin TEXT NOT NULL DEFAULT 'channel'` if it is absent. Three things make
that defensible rather than a migration framework arriving by the back door.

It is **on a cache**. `skill` holds no fact that is not also in
`skills/<name>.md`, so the default cannot be wrong about a row: every row already
on disk was written by a channel's own reconciliation from that channel's own
directory, which is what `'channel'` means. There is no backfill to compute.

It is **not a version step**. `MESSAGE_STORE_SCHEMA_VERSION` stayed at 1, by the
rule that what is versioned is what a *reader* depends on — and the proxy's reader
names no skill table. That is #229's, #290's, #295's and #323's measurement
reached a fifth time; a bump would have been every store on disk refusing to open
over a column nothing that reads them mentions.

And it is **writers only**. `openMessageReader` does not run it and could not: a
reader does not migrate, because migrating is writing.

What none of this licenses is the next column on a table that is not a cache.
`message` and `thread_summary` rows *are* the fact rather than a copy of one, so a
column there is still a version bump and still needs a migration nobody has
written.

### The clocks, and the two stamps that are not one

`skillClocks` is the lifecycle job's read (#294): one row per indexed skill the
channel itself authored — the shared half is not here at all, for the reason two
sections up — joining the status the *file* carries against the two columns
recording what the job itself last said. Comparing those two is the whole of how the job tells the
team's word from its own, and it is a value comparison rather than a timestamp
one — there is no clock on these files this package trusts, which is why
`mtime_ms` is compared for inequality and never read as a time.

The join is an **inner** one, and that is a claim rather than a shortcut. Every
row in `skill` arrives through `reconcileSkills`' upsert, which runs `seenSkill`
beside it, and `skill_delete` takes the clock row away again — so a skill with no
clock row is a state this schema cannot reach. A `LEFT JOIN` would have to invent
a `first_seen_at` for the row it found, and inventing a clock origin is exactly
what keeping `created` out of the clocks exists to prevent.

`adoptSkillStatus` and `recordSkillStatus` differ in one column and that column is
the design. Adopting sets `status_by_job_at` as well, and that stamp is **part of
the clock** — a skill ages from `max(last_used_at ?? first_seen_at,
status_by_job_at)`, so adopting a status a person set restarts the clock and buys
them a full stale window before the job speaks again. The job's own move must not
restamp it, or its second threshold would be measured from its first decision and
a skill marked stale at thirty days would archive at a hundred and twenty. Two
methods rather than one with a flag, because a boolean parameter is where that
asymmetry would go to get inverted.

Neither is wrapped in a transaction, and the reason is that a transaction could
not help: the file write these stamps follow is outside SQLite, so all it could do
is hide which half landed. What answers the crash between the two is the job's own
arbitration — a file it wrote with a baseline it did not record reads, next pass,
as somebody else's edit, and costs one stale window.

The consequence of folding the stamp into the clock is stated where the column is
defined, because an earlier draft of that comment said otherwise: **a lost index
costs one full stale window** of no-ops rather than one cycle. That is the better
failure, and it is the same mechanism that makes a hand-set status survive, so
the two cannot be had separately.

### The pair table, and why no trigger takes its rows away

`skill_merge_proposal` is the curator's whole bound (#295): one row per pair it
has **considered**, drafted or declined, carrying the two `description_hash`
values it considered them at. `skillMergeCandidate` excludes a pair whose row
still matches, so a pair is raised once and not again until one of the two
descriptions moves. Not a timestamp — a clock would re-propose a merge somebody
declined every N days, which is the behaviour the table exists to prevent — and
not a body hash, because the description is what retrieval matches on and what
the overlap question is about.

A row is written for a declined pair too, and that is the load-bearing half: a
decline with no row is a pair paid for again on every later run, which is the
failure `thread_summary` writes a `nothing` row to avoid.

**No trigger drops these rows when a skill is deleted**, and that is the design.
The surviving row is the only record of which proposal file names a skill that no
longer exists, so `orphanedSkillMergeProposals` can find the file and the caller
can remove it; a trigger would destroy the evidence and orphan the file
permanently, consuming one of the caller's open-proposal slots forever.

It also turned up a hazard worth having written down, because it is the trigger
form of one this schema already records for columns. **`CREATE TRIGGER IF NOT
EXISTS` no-ops against a trigger of that name that already exists**, exactly as
`CREATE TABLE IF NOT EXISTS` does — so *editing the body of an existing trigger
reaches new files only*, and every store on disk keeps the old body with nothing
raising. Extending `skill_delete` here would have looked like it worked. The rule
that leaves: **a change to what a trigger does needs a new trigger name.**

The nomination query itself is the one place this package computes a distance
outside `nearest`. It uses `vec_distance_l2` as a scalar function over the vec0
column rather than a MATCH, so an all-pairs comparison is one statement and no
vector crosses into JS, and it picks the closest **mutual nearest neighbour**
pair — B is A's nearest and A is B's. The argument for that rule, and against the
two alternatives, is on the SQL.

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

### Telling a channel, once (#320)

`skill_merge_notice` is a second table beside `skill_merge_proposal`, and the
reason it is a table rather than a column is mechanical: this schema is applied
with `CREATE TABLE IF NOT EXISTS` and there is no migration path, so a new table
appears on a store already on disk and moves no version, where a new column would
need an `ALTER` nothing here runs.

It also says something true that a column would blur. The row beside it records
that a pair was *considered*, which is a fact about spend; this records that
people were *told*, which is a fact about a channel — and the two are independent
in both directions. `recordSkillMergeNotice` is idempotent and written by the
caller only after its post has landed. `forgetSkillMergeProposal` deliberately
does **not** clear it: a team that deleted a proposal without applying it has
declined, and re-announcing the pair if it came back would make deletion a way to
be asked again.

`SkillProposals` gained `list()` with it, and that is not the `read` this module
refuses. What it answers is the two skill names the curator was given — the same
strings `count()` already round-trips through `SkillName` and throws away — so no
model-authored text leaves the directory, which is the claim the header actually
makes. `skillProposalFilename` is exported beside it, because the heartbeat has to
name the file in a channel and two spellings of the separator would drift.


## Scheduled checks, and the second method the reader has ever had (#323)

`scheduled_task` holds what a governed `schedule_task` create produced and what
the ambient clock will fire. Two rules make it work and they only compose if both
are written down, so the DDL says both.

**Pending is the absence of a fire stamp, never a status value.** There is no
`state` column, because a status enum would need a value meaning "due but not
run" — and that value is the bug: it is what would let a firing that produced no
check consume a ticket that never ran. Absence cannot be consumed by anything
except a fire.

**`outcome` is written only together with `fired_at`.** It says what the one
firing did and is never read to decide whether a ticket may fire again. It is
provisioned now rather than added later because nothing in this module runs an
`ALTER` — which also rules two columns out for whoever writes the firing: no
`attempts`, since a due check fires exactly once, and no `abandoned_at`, since
nothing lingers waiting to be given up on.

Additive DDL, so `MESSAGE_STORE_SCHEMA_VERSION` did not move — the fourth time,
after #229, #290 and #295, and measured the same way: the reader names the table
only behind a guard.

**`MessageReader.pendingScheduledTasks` is a reviewed widening.** That interface
had exactly one operation for a reason its own header states, and this is the
first thing added to it. What admits this one and no successor: it takes no
argument, it is read-only over one file, and it answers an **integer**. The proxy
learns how many checks are waiting and never what any of them says — no prompt, no
instant, no id — so nothing model-authored crosses back into the process holding
every tool credential. A method here returning a *ticket* would, and this is where
that gets refused.

It exists because the pending cap has to be decided at the create, in the process
that governs it, and the process that governs is not the process that writes.
Counting on the agent side would put the cap in the one place enforcement never
lives.

**Zero when the table is absent, and that is the truth rather than fail-open.**
The reader runs no DDL, so a store whose writer has not opened since the deploy
has no `scheduled_task` table — and preparing a statement against it at open would
throw and take `search_channel_history` down with it, for a channel that has no
scheduled checks by definition. The table is looked for once, at open.

Which half writes what is the other half of the story, and it is in
`apps/server/src/session/scheduled.ts`: the proxy governs the create and this
side records it, because the proxy opens these files `readOnly`.

The three reads the clock uses landed with the firing (#324) and are shaped by
what each is for. `nextScheduledTaskDueAt` answers an **instant** rather than a
row, because that is all a plan needs and the ticket itself is read only once
something is due. `dueScheduledTasks` takes an instant and answers what is due *at
or before* it — which is the whole of "late counts as due": a check whose time
passed while the process was down is still due when it comes back, once, because
there is one row and one stamp and therefore nothing to replay per missed window.
And `markScheduledTaskFired` carries `fired_at IS NULL` in its own predicate, so a
second fire cannot move the first one's stamp: a fire is the one act that ends a
ticket, and a second is a bug rather than an update.

Three more landed with the operator surface, and they are the operator's rather
than the clock's. `listScheduledTasks` is the only read here that answers
*pending* rows — `MessageReader` deliberately does not get it, because the proxy
enforces a cap and needs a number, where a person deciding what to cancel needs
to see what a check says. `cancelScheduledTask` is a **delete** and not a
terminal outcome, for `forgetSkillMergeProposal`'s reason — but unlike declining
a proposal it leaves a record (#349): the deleted row's content lands in
`scheduled_task_cancellation` in the same transaction, because a cancel calls
off something a person in the channel approved, and a delete with nothing left
behind was a hole in the account of what happened. `listCancelledScheduledTasks`
is that record's read, newest first — the store is inside a named volume the
host cannot open, so a record with no read here would be recorded and
unreadable.

Every `ScheduledTaskOutcome` is terminal. There is deliberately no value that
leaves a ticket pending — that value is what would let a firing which produced no
check consume a check that never ran.

## What is not here

**Skills are whole as of #291**, storage and both directions. `apps/server`
reconciles this directory at the head of every task, fuses the two retrieval
primitives, renders the winners into the opening context and records a use for
each (#292); after a task heavy enough in served tool calls, the skill-author
turn writes through `openSkillFiles().apply` (#291). A skill somebody adds with
an editor and a skill an operation wrote reach the index by the same road, which
is what this package was built for and is still the only road there is.

`skillsNeedingEmbedding` got its production caller in #305, and until then it had
none: nothing embedded a skill, so `nearest(vector, k, "skill")` answered `[]` in
every deployment and the hybrid retrieval above ran on its lexical leg alone. The
caller is `apps/server/src/session/skill-embed.ts`, on channel activity rather
than at task head — embedding is a provider round trip whose benefit the *next*
task collects. Nothing here changed for it: the LEFT JOIN was always the answer
to "what has no vector", and `description_hash` was always what decides whether
one still stands.

Skills are whole as of #295. Both remaining halves landed in this package as
storage the passes above them use: the lifecycle job's file writer and clock read
(#294), and the curator's proposals directory, its nomination query and its
considered-pair table (#295). Both *jobs* live in `apps/server`, because their
thresholds and intervals are a team sheet's and this package holds no sheet.

`reconcileSkillIndex` has four callers, all in `apps/server` and all inside the
session's lock. `session/skill-recall.ts` runs it at the head of a task, which is
where it belongs: the moment correctness is required is the moment retrieval
runs, and outside the lock the pass would race the quiescence sweep's writes and
the previous task's authoring (#291). `session/skill-embed.ts` runs it on channel
activity as the first half of the embedding pass (#305), and has to: this table
is what says which skills have no vector standing for them, so a pass that only
read it could embed nothing a task had not already indexed — a skill somebody
wrote with an editor would wait for a mention before it could even become a
candidate. `session/skill-lifecycle.ts` runs it before reading the clocks (#294),
because the clocks compare against the status the *file* carried at the last
reconciliation, and again after its writes — that second one is a window
shortened rather than a correctness requirement, since recall reconciles at the
head of the next task either way. `session/skill-curate.ts` runs it before
nominating (#295), because the index holds both the pair and the description
hashes the bound is decided on.

Four callers of one function rather than four paths, and the rule above is
unaffected: `reconcileSkills` is still the only writer, and no caller writes a
file.

`reconcileSharedSkillIndex` has two, both in `apps/server` and both added by
#436: skill retrieval reconciles the shared half at the head of a task, and the
embedding pass reconciles it before asking what needs a vector. `openSharedSkillFiles`
has those two and the standing region's reader (#435), which opens the root and
indexes nothing.

Both callers pass `files: null` where a channel has no shared library — the root
is unset, the root is not there, or the sheet names no `retrieved` entry — rather
than skipping the pass. That is what the null is for. Skipping is what strands a
`shared/<name>` row when an operator deletes a `[[shared_skill]]` block: the row
is returned by both retrieval legs, which are origin-blind on purpose, resolves
through no opener, and spends one of `[skills] top_k`'s slots on every task from
then on. Accepting a null library is what makes the call unconditional, and an
unconditional call is what makes the shared half of the index exactly what the
sheet and the root currently say. It costs a transiently unmounted root the whole
half, re-earned at one embedding per skill per channel when the mount returns.

The fusion itself —
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
