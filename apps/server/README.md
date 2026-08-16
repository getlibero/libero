# @getlibero/server

The gateway + agent process. It holds the Slack socket and runs the model loop:
a mention arrives over Socket Mode, one agent task runs, the answer goes back
into the thread.

Unpublished workspace package. See
[the architecture spec](../../site/src/content/docs/docs/architecture.md) — it
is the design of record and is ahead of what is built.

## What it holds, and what it does not

This process holds the Slack app token, the Slack bot token, and the model
provider key. It holds **no tool credential** and has no way to reach a tool
except one: a mutual-TLS call to the tool proxy service, which owns every
credential and decides every call from the channel's team sheet.

Which channel a call is attributed to comes from the client certificate the
agent presents — `client-<channel id>.pem` out of `PROXY_CLIENT_CERT_DIR` — and
from nothing in the request. A channel whose certificate this process does not
hold is a channel it cannot call as.

The tools the model is offered are whatever the proxy lists for that channel,
unfiltered. Each carries the description and input schema the upstream server
published, which the proxy fetched and intersected with the sheet — this process
never asks a server anything and never filters what it was given. A tool the
proxy could not describe, because its upstream was down or slow or the sheet
contradicts itself, arrives with an open object schema and a sentence saying the
arguments are not described. That costs the model accuracy and costs the channel
nothing: the sheet still decides what may be called, and the proxy still
enforces it at call time.

Descriptions and schemas are written by third-party servers and enter the
model's context on every turn. Nothing here reads or annotates them — a rule
that read a description would be a rule the upstream phrases around. The proxy
bounds their size; what accepts the exposure is the team sheet naming the
server. The one thing an upstream cannot describe is approval, so "this call is
held for approval from a human" always comes from the manifest.

## The live checklist

A task that calls a tool posts one message into its thread and edits it as it
goes: a row per call, each `running`, `done`, `failed`, or `not run`. A task that
answers from what the model knows posts nothing but its answer — the card goes up
on the first tool call, not at task start, which is why there is no sheet field
to turn it off.

Two things about it are decisions rather than mechanics.

**It wears no colour while it is working.** The design system's vocabulary is
three — green allowed and executed, amber a human who still has to click, red
blocked — and a task in flight is none of them. Green arrives when the task
reaches its own end and red when a cap stopped it, and the card then names which
cap, in the same sentence the reply uses. A cancelled task is uncoloured too:
shutdown concluded nothing.

**Edits are coalesced against a one-second floor**, so a task making twenty calls
makes a handful of edits rather than twenty. A write renders whatever is true
when it runs, so a burst that lands during one write is covered by the next. The
terminal write skips the floor and is awaited, because it is the state a reader
is left looking at.

It rides `CardPoster`, the same seam the approval card does, and degrades the
same way: a front-end with nowhere to put a card runs tasks that post only their
answer.

## Approvals, from this side

The proxy holds every ticket and decides every redemption. What lives here is the
half that asks a human and relays what they said — `src/approvals/`, three files:

- `registry.ts` — which tickets this process is waiting on. One map at process
  scope, because a click arrives at process scope with nothing but a ticket id
  and the channel it was clicked in. Entries are task-scoped, so a ticket nobody
  is waiting on looks the same as one that never existed. Keyed by channel then
  id, so a lookup cannot reach another channel's entry.
- `prompter.ts` — posts the card, waits, repaints it, resolves.
- `decisions.ts` — click → `POST /v1/approvals` → settle with **what the proxy
  said**, never with what was clicked. Unknown-ticket and wrong-channel clicks
  are dropped before the proxy is asked.

**The task closes its own card.** Every exit — a click, the ticket's deadline,
the task's wall clock, shutdown — repaints out of amber before the wait resolves,
so a card never outlives the wait it belongs to. A repaint that fails fails safe:
a stale amber card's clicks find no registry entry, and the proxy answers a
re-submission from its own ticket state regardless of what any card shows.

**Green means the call ran, not that a human clicked.** An approve repaints to an
uncoloured `running` face and the card is finished by a second phase, when the
re-submission answers — green if it ran, red naming the approver and the proxy's
own refusal if it did not, and `unanswered` if the task ended first. The sheet is
enforced again at redemption, so an operator's edit during the hold beats a click
that preceded it, and painting green at decision time put green above calls that
never ran.

**The hold spends the task's wall clock by design.** Under default caps — a
five-minute wall clock against a fifteen-minute ticket — the wall cap usually
wins: the card goes red, the task ends on `wall_time_cap`, and an operator who
wants longer holds sizes the channel's `[llm]` caps for it. The wait's deadline
is the wire's `expiresAt` on the proxy's clock; skew is relayed, not corrected.

The trust claim is worth stating precisely, because it is not the same one tool
credentials get: the click is observed by gateway code rather than produced by a
model, so approver identity holds against a **prompt-injected model** and not
against a **compromised agent process**, which relays it. Tool credentials
survive process compromise; approvals survive prompt injection.

## Configuration

Environment only. Nothing is read from a file and nothing is baked into the
image. Every variable below is required unless marked optional, and a missing
one is a startup failure naming the variable — not a task that fails later at
the far end of a thread.

| Variable | Notes |
| --- | --- |
| `SLACK_APP_TOKEN` | App-level token, `xapp-…`. Opens the socket; cannot post. |
| `SLACK_BOT_TOKEN` | Bot token, `xoxb-…`. Posts; cannot open the socket. |
| `PROXY_URL` | The tool proxy. Must be `https://…`. |
| `PROXY_TLS_CA` | Verifies the proxy's certificate, and nothing else does. |
| `PROXY_CLIENT_CERT_DIR` | Holds `client-<channel id>.pem` and `.key` per channel. |
| `AGENT_PROVIDER` | `anthropic` or `openai-compatible`. |
| `AGENT_MODEL` | Model id, passed to the provider verbatim. The fallback for a channel whose sheet names none. |
| `AGENT_CHANNELS_ROOT` | The team sheets: one directory per channel, each with a `channel.toml`. Read only. |
| `AGENT_STORE_ROOT` | The agent's own state: one directory per channel, each with a `store.db` and a curated `MEMORY.md`. Written. Not the same root. |
| `ANTHROPIC_API_KEY` | Required when `AGENT_PROVIDER=anthropic`. |
| `OPENAI_API_KEY` | Required when `AGENT_PROVIDER=openai-compatible`. |
| `ANTHROPIC_BASE_URL` | Optional. Anthropic's own endpoint when unset. |
| `OPENAI_BASE_URL` | Optional. Reaches Together, Fireworks, Groq, Ollama, Gemini's compatibility endpoint, or a LiteLLM sidecar. |
| `AGENT_EMBEDDING_PROVIDER` | Optional, `openai-compatible`. Unset turns semantic recall off. |
| `AGENT_EMBEDDING_MODEL` | Required once a provider is named. Stamped against the channel's vectors. |
| `AGENT_EMBEDDING_API_KEY` | The embedding vendor's key. Falls back to `OPENAI_API_KEY`. |
| `AGENT_EMBEDDING_BASE_URL` | Optional. Reaches Voyage, Together, Ollama, or a LiteLLM sidecar. |

`AGENT_PROVIDER` is required and never inferred from whichever key happens to
be set: `deploy/docker-compose.yml` declares both keys on this service, so
inference would resolve on the order the arms are written in and bill an
account nobody chose. `AGENT_MODEL` has no default for the same class of
reason — a defaulted model id goes stale on the provider's schedule and pins a
price the operator never picked.

### Embeddings are configured separately, and are optional

The four `AGENT_EMBEDDING_*` variables are a **second provider**, not a mode of
the first, because Anthropic publishes no embeddings endpoint at all. The
ordinary deployment completes against one vendor and embeds against another —
Voyage, OpenAI, a local Ollama — so deriving this from `AGENT_PROVIDER` would
make the commonest configuration the one that cannot be expressed.
`AGENT_EMBEDDING_API_KEY` falls back to `OPENAI_API_KEY` only for the deployment
where they genuinely are one account, so that case needs one variable rather
than two copies of one secret.

**Unset is a supported deployment, and the only optional provider here.** Memory
Layers 1 and 2 — full-text search and the curated `MEMORY.md` — are whole
without embeddings, so a process with `AGENT_EMBEDDING_PROVIDER` unset answers
every mention exactly as before and simply has no semantic recall. It logs
`embeddings_unconfigured` once at startup and carries on. That is the opposite
of the `PROXY_*` rule below, and deliberately: a missing proxy is a misconfigured
deployment, a missing embedding provider is a smaller one.

Partial configuration is still an error. A provider named without a model, or
without a key it can reach, is someone who meant to turn this on — and answering
"off" to that would be the silent downgrade the whole arrangement avoids.

The three `PROXY_*` variables are required together, with no fallback to a
toolless agent. A process missing one of them is not a deployment that answers
without tools, it is a misconfigured one — and a silent downgrade would be a
model saying it cannot do something the channel in fact permits, with nothing in
the logs to say why. `PROXY_URL` must be `https`: mutual TLS is the proxy's only
authentication, so a plaintext URL means no certificate is presented, no channel
is resolved, and every call is refused.

`AGENT_CHANNELS_ROOT` is required too, and advisory is not a reason to soften
that. This process reads the same team sheets the proxy does and reads them
differently: for the proxy they are the authorization source, and here they are
a model id and four per-task caps the loop applies to its own turns as defence
in depth. Unset, every channel would silently run on the built-in caps with its
`[llm]` block ignored and nothing in the log to say so — the same silent
downgrade the three `PROXY_*` variables refuse, and indistinguishable from a
path that is merely typed wrong. Nothing is read from the directory at startup:
a root that does not exist is a channel whose sheet falls back, not a process
that will not boot.

`AGENT_STORE_ROOT` is where this process writes, and **it is deliberately a
different root from the sheets**. That is a security decision rather than a
filing preference. The obvious layout puts a channel's `store.db` beside its
`channel.toml`, but `deploy/docker-compose.yml` mounts the channels directory
into both services and it is where the proxy reads its authorization from — so
making it writable here would mean the process that runs the model could rewrite
a `channel.toml`. The proxy re-reads the sheet per call, so that is a compromised
agent widening its own permissions. The channels root stays read-only to both
services and everything this process writes goes somewhere else.

It is required, with no default, and the reason is different from the others: it
holds message text. `PROXY_BUDGET_DB` and `PROXY_AUDIT_DB` hold counts and
outcomes and say "nothing in it is a secret"; this holds what people said, and
an operator should be choosing where a channel's conversation lands rather than
inheriting a path. Nothing is read or created from the directory at startup —
whether a channel gets a store is decided per channel, on first use, and is
gated on that channel having a team sheet: the app is in most channels of a
workspace and provisioned for few, and an unprovisioned one is recorded nowhere.

The Slack app needs Socket Mode enabled; the `app_mentions:read` and
`chat:write` scopes, plus `channels:history` (and `groups:history` for private
channels); and the `app_mention` and `message.channels` events subscribed (plus
`message.groups`). The two are separate concerns: mentions are what the app
answers, and `message.*` is what fills the per-channel store the context
assembler reads back and what carries a follow-up in an active thread. Without
the history scope the app answers mentions and remembers nothing.

The process also calls `auth.test` once before opening the socket, to learn its
own user id. It needs no scope, and it is what tells the two deliveries of one
mention apart — so a bot token Slack will not accept is now a startup failure
rather than a reply that never appears.

## Running it

The proxy is not optional, so mint certificates first — one per channel the bot
answers in, plus the CA both processes trust:

The fingerprint it prints goes into that channel's `channel.toml` under
`[channel] certificate_sha256`; without it the sheet does not parse and every
call is answered 401.

```sh
sh scripts/dev-certs.sh --channels C024BE91L
pnpm -r build
SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… \
PROXY_URL=https://localhost:8443 \
PROXY_TLS_CA=./deploy/certs/ca.pem \
PROXY_CLIENT_CERT_DIR=./deploy/certs/agent \
AGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… AGENT_MODEL=claude-sonnet-4-6 \
AGENT_CHANNELS_ROOT=./channels \
node apps/server/dist/index.js
```

It logs one JSON object per line on stdout: `connecting`, `connected`, then
`mention`, one `spend_reported` per model turn, `task`, and `replied` per
answered mention — plus `queued` when a mention waited on another task in the
same channel. No line carries a token value or any message text — ids only.

## Sessions

One session per `(workspace, channel)`, created on first mention. A session owns
a queue, and a channel's mentions run through it one at a time: a second mention
arriving while the first is still working **queues rather than interleaves**, and
sees whatever the first left behind. Channels share nothing, so a channel waiting
on a slow task delays only itself.

The queueing happens below the gateway, not in it. The gateway acknowledges an
inbound event within about three seconds or Slack redelivers it, so a mention
waiting its turn must not be holding that acknowledgement — everything below the
ack queues and nothing above it does. A mention that waited is logged as `queued`
with a `queuedMs`, which is also what tells a backed-up channel apart from a slow
model: `replied`'s `durationMs` now includes the wait.

A task's own wall-time cap is unaffected by the wait — the loop starts its clock
when the task starts — so end-to-end latency is queue plus cap.

Sessions are evicted after 30 minutes idle, and never while they have work
running or queued, however old. Eviction is lazy: it happens on the path a
mention takes anyway, so nothing here keeps a timer alive to free memory nobody
is waiting on. Eviction closes the session's `store.db`, which is the one thing
a session holds that is more than a timestamp. A restart drops every session at
no cost: the store is the durable half and a session is only a handle to it,
reopened on demand.

**A message opens a session too, and the write does not take its queue.**
Ordinary channel messages are recorded, so ingest opens the session — which is
what makes a message in a channel nobody has mentioned the app in still get
stored — and writes straight through. The queue exists to serialize model turns;
a store write is one synchronous statement with nothing to serialize, and behind
the queue a message arriving mid-task would wait out a whole model turn to be
filed. The consequence is deliberate: message traffic defers eviction, so a
chatty channel keeps a warm handle, which is the point of holding one.

A message that is *answered* — see below — does take the queue, because it is a
model turn like any other. The write happens first either way, so the transcript
its own task assembles already holds the thing it was asked about.

### Where the curation turn sits in the queue

After a task's reply has been produced, the router enqueues a **curation turn**
on that same session queue — one extra model call, offered the memory tools and
nothing else, which decides whether anything about the task was worth keeping in
the channel's `MEMORY.md`. It is **not awaited**: the reply goes back to the
gateway and into the thread at the moment it always did, and the person who asked
waits for nothing extra.

Enqueueing it rather than detaching it buys three things at once. The next task's
context read is *serialized against* this write rather than racing it, which is
the invariant the transcript read already depends on. `pending` stays above zero,
so the session cannot be evicted while curation is in flight — and eviction is
what closes the store handle underneath it. And the ordering becomes a queue
position rather than a timing accident.

**The ordering it produces, stated rather than left to be discovered.** In the
ordinary case — a channel that goes quiet after an answer — curation is next in
line, so the following mention sees what it wrote. A follow-up that queued *while
the task was still running* is already ahead of it: that task reads `MEMORY.md`
as it was, answers, and enqueues its own curation behind the first one. Nothing
is lost and nothing races; a fact can simply be one task late in a channel that
is talking faster than it is remembering.

Note that "after the reply" here means after the reply was *produced*, not after
Slack accepted it. This process is not told when a post lands — it holds
`CardPoster` and never `MessagePoster`, on purpose — and the queue releases
before the post either way, so a task queued behind one has always started before
the previous answer was in the channel. Shutdown is handled by the same signal
the task runner takes: a curation turn that wakes up during a drain does nothing,
because the reply it would have been remembering was never posted.

A curation failure is a `curation_failed` line and nothing else. The reply has
already been produced, nothing is awaiting the turn, and the session goes on
answering.

**Messages are deduplicated by the store's `ts`, and never by the gateway's
`seen` set.** The store's insert is `ON CONFLICT DO NOTHING` on a UNIQUE column,
so a redelivered event is a no-op. That key is also the better one: it is the
message's own identity and it survives a restart, where `seen` is an in-memory
FIFO bounded at 1000 — message traffic would flush every remembered mention id in
seconds. Two idempotency mechanisms that can disagree is the thing to avoid, and
the reason `seen` exists at all (nothing downstream of a *mention* is idempotent)
does not apply here.

### A message can leave again

Slack delivers a deletion and an edit on the same subscription, as subtypes of
`message`, so they arrive on the same path and land on the same session — which
is what puts the delete on the file handle the append opened rather than on a
second one. `createRevisionIngest` is the mirror: `remove(ts)` for a deletion,
`replaceText(ts, text)` for an edit, index entry included either way. It takes no
router and no card poster, because nothing here is answered and nothing is
posted. It does not take the mutex, for the reason the append does not.

**An edit is not a way into the store.** `replaceText` answers false for a ts the
store never held, and that is left as a no-op rather than turned into an insert.
The rows are the messages the message path agreed to record, and inserting here
would be a second write door with none of that path's filters — an app's own
message, a `channel_join`, any declined subtype, all recordable by being edited
afterwards. It reads honestly too: a channel provisioned today has no history
from last week, and back-filling one message out of it because somebody fixed a
typo is an arbitrary transcript rather than a fuller one.

One ordering limit is stated rather than implied. The store is keyed on `ts` and
holds no tombstone, so a deletion that arrived *before* the message it deletes
would find nothing and the message would then be filed by the later event. Slack
sends a message before its own revision, so this needs a redelivery to reorder
them; closing it means a second table every read would have to consult, and that
trade is not phase 1's.

### Follow-ups in a thread the agent is working in

A reply in a thread the agent has already worked in reaches it **with no
mention**. Everywhere else in the channel still needs one: this is a second door
into a session, not the agent reading the channel.

A session holds the threads it is active in and when each stops being active. A
task marks its thread active when it starts and refreshes it when it finishes, so
the window a person actually gets is measured from the answer rather than from
the question, and a conversation that keeps going keeps going.

**The window is the channel's**, from `[llm] follow_up_window_seconds`
(default 900, `0` to switch follow-ups off entirely). It belongs in the sheet for
the reason the two history bounds do — it spends the channel's own budget and can
widen nothing — and because whether an agent answers messages nobody addressed to
it is a channel's policy rather than a deployment's. The schema caps it at 1800
seconds because a session is evicted after 30 minutes idle, and evicting a
session deactivates its threads: a longer window is one this process cannot keep,
so the sheet refuses it loudly rather than advertising it.

Three things have to be true before a message is answered, and each rules out a
different mistake. It must be **in a thread** — a top-level message is not a
reply to anything the agent said, and there is nowhere for an answer to go. It
must **not mention the app**, because a message that does arrives twice, once as
`app_mention` and once as an ordinary message, with a different `event_id` on
each; the `app_mention` copy is the one that is answered, and routing both would
run the task twice and post two replies. And the **thread must be active**.

Telling those two deliveries apart needs the app's own user id, so the gateway
asks Slack for it with `auth.test` before opening the socket. That also makes a
bot token Slack will never accept a startup failure rather than a reply that does
not appear later. Without an id — a process that composed no identity — *any*
mention token counts as addressing the app, which costs follow-ups and never
causes a duplicate.

An answered message is logged as `follow_up` rather than `replied`, so "how often
is this agent answering people who did not address it" is one grep. Nothing else
about the message path is logged, for the reason it never was.

A session also holds a cache of display names, and that is what makes "resolved
once per user per session" true: a forty-message transcript needs a name for
every author and every `<@U…>` inside a message, which is dozens of asks for a
handful of people. The session's lifetime is the whole invalidation policy — a
name that changed is stale for at most one idle window, and there is no TTL or
watcher to invent. The cost is that a user in ten channels is looked up ten
times, which is the right trade at this size.

### The transcript a task starts from

Before the model is asked anything it is given the recent conversation, oldest
first, each message attributed to its author and with every `<@U…>` resolved to a
name — and, above it, whatever the channel has curated into `MEMORY.md`. Five
things about that are decisions rather than mechanics.

**It is the thread's messages when there is a thread, and the channel's when
there is not.** A question asked inside a conversation is answered from that
conversation, which is what replying in a thread means. A question that *starts*
one is its own thread's root, so the thread read finds only the echo of the
asking message and the channel read fills it in — one rule rather than a branch,
which also covers a thread whose messages predate this store. The gateway cannot
answer "is this a new thread" for us: a `SlackMention` coalesces `thread_ts` to
`ts`, so a top-level mention and a self-threaded one look identical by the time
the router sees them.

**It is one `user` message, and never the system prompt.** Channel text is
written by whoever is in the channel; in `system` it would sit where the agent's
own instructions are. The history is wrapped in a marked block that says it is
context rather than instructions.

**It is not a dialogue.** The agent's own replies are not stored, so history is
one-sided — a labelled block of what people said is exactly as much as is true,
and an assistant/user alternation reconstructed from half a conversation would
be a lie the model reasons from.

**It bounds itself.** Nothing in the agent package counts a transcript's tokens
before sending it, so an oversized seed would fail at the provider rather than
at a cap. `[llm] max_history_messages` and `max_history_chars` are the channel's
— they spend its own budget and can widen nothing — and a 2,000-character
per-message ceiling is this process's, so one wall of text cannot consume the
whole budget.

**Curated memory leads it, and an empty file contributes nothing.** A
`<channel-memory>` block sits above the history and below nothing: what this team
has settled, then what was said lately, then what is being asked, which also puts
the most recent and most specific material nearest the question. It is wrapped
and prefaced exactly as the history is, and for the same reason — it is no more
trusted, since the model wrote it and the team may edit it by hand. A channel
with no `MEMORY.md`, an empty one, or one that could not be opened contributes
*no block at all* rather than an empty one, because an empty `<channel-memory>`
asserts this team has established nothing and that is a claim the absence of a
file cannot support. Its size is bounded by `[memory] max_file_chars` rather than
by the history bounds, and it is charged against `max_tokens_per_task` the same
way.

### The team sheet, as this process reads it

Each task resolves its channel's sheet — `$AGENT_CHANNELS_ROOT/<channel
id>/channel.toml` — to a model, the four per-task caps, the two context bounds,
the follow-up window, and the `[memory]` block, and runs on those. `[llm] model`
wins over `AGENT_MODEL`; everything in the schema has a default, so a channel
whose sheet has no `[llm]` block still gets all eight of those. `max_task_seconds` and
`follow_up_window_seconds` are seconds in the sheet and milliseconds in the
process, which are the two fields that are a conversion rather than a rename.

The sheet is read once per task, with no cache and no watcher, so an operator's
edit lands on the next mention. And every failure to read one — missing,
unreadable, no longer valid TOML, rejected by the schema — falls back to the
built-in defaults and logs a reason code rather than refusing to run. That is
safe precisely because **what is resolved here is advisory**: the proxy enforces
what a channel may do from its own copy of the same file, and its meter is
authoritative. A fallback here cannot widen anything. The opposite policy would
put an authorization decision on the wrong side of the boundary and take a whole
deployment dark the first time a volume was mounted at the wrong path.

**`[memory]` is the one exception, and it falls back to *off*.** Everything above
is advisory because the proxy holds a second copy; the proxy never opens
`MEMORY.md` and holds no copy of those two numbers, so for that block the
fallback is not defence in depth — it *is* the decision. The two failures are not
symmetric: a typo costing a channel its memory is a degradation the reply
survives and an operator notices, while a typo switching curation *on* for a
channel that wrote `enabled = false` would be a policy violation this process
committed by itself. So a sheet that parsed gets exactly what it says, including
`enabled = true` by omission, and a sheet that could not be read gets curation
off.

The sheet picks a model id, not a provider. `AGENT_PROVIDER` is the process's,
and a sheet naming a model the configured provider does not serve fails at the
provider like any other outage.

## Semantic recall: where it enters a task, and why not as a tool

`src/session/recall.ts` answers #232. At the head of every task the incoming
request is embedded, matched against this channel's thread summaries, and the
nearest few are rendered into the opening context as `<channel-recall>` beside
`<channel-memory>` and `<channel-history>`. That is the whole shape: **agent-local
context assembly, not a tool.**

The issue named three candidates and the two rejected ones are recorded here
rather than dropped, because a decision nobody wrote down is one the next person
makes again.

**A model-invoked recall tool was rejected as an ungoverned twin.** #64
deliberately made `search_channel_history` a *proxied built-in*: granted by a
`[[builtin]]` block, refused when the sheet omits it, approval-gatable, metered,
and audited — its own source insisting "a built-in is not a bypass". A second
model-invoked read of the same channel's content, executed agent-side and
answering to none of that, would not extend that decision but route around it.
That the agent process *could* read the store directly is not a counter-argument:
it is precisely why the built-in exists, to make the model's reads observable.

**Context assembly is a different act, and is already ungoverned by the sheet.**
`assembleContext` reads this channel's store for the transcript, bounded by
`[llm] max_history_messages` and by no `[[builtin]]` grant, and injects the whole
of `MEMORY.md` beside it. Adding retrieved summaries is the same class of thing
the process already does — the *agent* decides what its own task starts from.
Nothing in recall is invoked by the model, parameterised by the model, or
reachable from a tool call.

**The hybrid built-in remains the right shape if mid-task recall is ever
wanted**, and it is rejected on cost rather than principle: it puts a vector on
the wire, grows `MessageReader` a nearest-neighbour query, and leaves an audit
row recording a vector rather than a question — an operator reading `searched for
[0.02, -0.5, …]` learns nothing. If it is built, extending the governed built-in
is the consistent move; adding a twin is not.

What it costs: one embedding call per task, metered through the same
`SpendReport` path a completion turn uses, and then a block occupying part of
every turn's input for the rest of the task. `RECALL_LIMIT` and
`RECALL_MAX_CHARS` bound the second and are deliberately small, because the
transcript and `MEMORY.md` compete for the same context.

Since #292 the embedding call is **not recall's own**. It lives in
`src/session/embed.ts`, the router makes it once per task, and both retrievers
take the vector — one call, two searches, one line in the meter. What reaches
`createRecall` is a `Float32Array | null`, and `null` ends recall because a
summary has no index but its vector.

Two limits are stated rather than hidden. There is **no distance cutoff** — the
argument is in the file, and it comes down to the number not being writable
honestly across providers that may or may not normalize — so a channel with a
small corpus contributes all of it to every task, relevant or not. And recall is
gated on `[memory] summarize`, the same switch that writes the corpus, rather
than a third one of its own: a channel that turned summarization off should not
go on being answered out of summaries it asked to stop producing.

## Skill retrieval: the same shape, and the three things that differ

`src/session/skill-recall.ts` answers #292, and it is recall's sibling in every
respect that matters — task head, inside the session's lock, never throws,
rendered into the opening context as `<channel-skills>`, **not a tool.** Every
argument above about where retrieval belongs applies unchanged and is not
restated: a model-invoked skill search would be the same ungoverned twin of the
same governed built-in.

**It is where reconciliation runs, and the only place it runs.**
`reconcileSkillIndex` had no caller until this file. The moment correctness is
required is the moment retrieval runs, and outside the lock the pass would race
the quiescence sweep's writes and, once #291 lands, the previous task's
authoring. That pass is the whole of how a hand-edited or hand-deleted skill
takes effect: no watcher, no second path, and the team's directory is the truth.
Its steady-state cost is a `readdir` and a `stat` per file — a file is re-read
only when its fingerprint moved, and re-embedded only when its *description*
moved.

**Two legs, fused by a round-robin interleave.** `nearest` answers by L2 distance
and `searchSkills` by FTS5 rank, which are not comparable — the same argument
that stops recall writing down a distance cutoff also stops a weighted blend
here, and stops reciprocal-rank fusion, whose damping constant would be exactly
the magic number that argument refuses. So: vector rank 1, lexical rank 1, vector
rank 2, and so on, deduped by name, cut at `[skills] top_k`. A skill both legs
found surfaces once at its better position, which is a mild agreement bonus
falling out of the shape rather than a knob.

**A missing vector does not end it.** Recall stops dead without one; a skill also
carries a full-text index over its description and body, so with no embedding
provider the lexical leg runs alone. The team sheet says this is the intended
behaviour and refuses to make it a field.

Bounded three times, and the third is this process's: `top_k` from the sheet,
`max_skill_chars` per skill — read here because `packages/memory` declined the
figure on the grounds that refusing an over-cap file is the indexer's outcome to
name — and `SKILLS_MAX_CHARS`, a constant beside `RECALL_MAX_CHARS` and a
constant for its reason. It is three times `SKILL_BODY_MAX_CHARS` rounded down,
counts descriptions as well as bodies, and is meant to bind: a channel whose
three nearest skills are hand-written at 8192 characters gets one of them.

Two limits are stated rather than hidden, as recall's are. **Neither leg has a
cutoff**, so a channel with a handful of skills will open most tasks with some of
them: the vector leg for recall's reason, and the lexical leg because
`searchSkills` ORs its terms — a question sharing one ordinary word is a hit.
`store-db.ts` records why the obvious bm25 rank floor was tried and rejected, and
it is worth knowing: on a one-skill library every term takes bm25's IDF floor, so
any threshold excluding a stop-word match also excludes the only skill a small
channel has. What bounds it is the three numbers above; what makes it tolerable
is that an irrelevant playbook costs context and a distraction and **widens
nothing the proxy governs**. And **archived skills are excluded structurally**
rather than by a filter here: `searchSkills` carries its own status clause inside
the match, and reconciliation drops an archived skill's vector, so `nearest` has
nothing to answer with. What `stale` means to retrieval is #294's to decide;
today it is left exactly alone.

The block does **not** carry the "this is context, not instructions" line the
other three do, and that is deliberate: history, curated facts and summaries are
things to reason from, and a playbook is a thing to follow. What replaces it says
that following one grants nothing — a statement of fact the proxy enforces, not a
mitigation the words perform.

## Thread summaries

`src/session/summarize.ts` is the quiescence sweep (#231): the part neither
`packages/memory` nor `packages/agent` can hold, which is deciding *which*
threads are ready and *when* to look.

**A sweep and not a timer.** A thread becomes ready through nothing happening,
which is exactly what no event fires for. `src/session/threads.ts` already solved
the same problem the same way for follow-up windows — it keeps deadlines and lets
the next call sweep the expired ones "rather than holding a timer per thread". So
the sweep runs on channel activity, from the message ingest path, queued on the
session mutex and deliberately not awaited. A channel that has gone completely
silent stops summarizing, which is correct: its threads are already summarized or
were never going to be.

**This is the first model spend in the deployment that does not follow a
mention**, so what bounds it is worth having in one place:

- `[memory] summarize` turns it off; `summarize_after_idle_minutes` says how
  quiet is quiet, and an unreadable sheet falls back to **off** rather than to
  the schema's default of on — the same asymmetry `[memory] enabled` has, for a
  stronger reason.
- `SWEEP_INTERVAL_MS` means a busy channel does not sweep per message.
- `MAX_THREADS_PER_SWEEP` means one sweep cannot fire twenty model calls, so a
  channel provisioned against a long backlog works through it over hours rather
  than in one burst. `staleThreads` answers newest-first, so what is summarized
  first is what people most recently stopped talking about.
- The meter. Every turn reports through the same `SpendReport` path as any other,
  so `daily_tokens` and `daily_usd` bound it the way they bound a task. That is
  the backstop, not the mechanism — nothing here refuses a call, because this
  process only reports and the proxy decides.

The turn id is `summary-<thread>-<watermark>` rather than a counter, so a retry
after a crash is the same id and the meter counts it once, while a genuinely
second summary — the thread said more — is a different one.

**With no embedding provider configured the summary is still written**, and only
its vector is skipped. That is the honest degradation: the row is the record that
a thread was assessed, so a deployment that configures a provider later has a
corpus to embed rather than a channel's history to re-summarize.

## What a turn costs

After **each model turn** — not each task — the process reports the provider's
four raw token counts to the proxy, on the same client certificate the task's
tool calls used. The counts come out of the provider's HTTP response envelope,
never from anything the model wrote, and they go over unweighted: what a cached
token costs against `daily_tokens` is the channel's team sheet's answer, applied
where the budget is, so the agent sends numbers and never a total.

Per turn rather than per task, for two reasons. A task-end report means a long
task spends its whole cost before the meter hears any of it, so a channel
already over its cap is refused starting with the next mention rather than this
task's next tool call. And a task that dies mid-flight — the provider fails
after a few good turns — would spend those turns silently, because the loop
propagates the failure and the accumulated count goes with it.

The turn id is `<task id>.<n>`, so each turn is its own idempotency key: a retry
of turn 3 is answered `duplicate` and turn 4 is not. The task id root is minted
by this process, never shown to the model, and shared with the task's tool
calls, so one grep spans a task's reply, its calls, and its spend.

A meter that refuses the report or cannot be reached is logged as
`spend_report_failed` with the count it did not learn, and the thread still gets
its answer — an operator's counter is not worth a user's reply.

## When the proxy cannot be reached

The channel is told, in one line, and the task ends there. This is a departure
from how an unreachable model provider behaves — that one posts nothing — and
the reason is that one of these failures is permanent: a channel whose client
certificate was never minted will never answer again, which is a first-run
configuration mistake rather than an outage. Silence there is indistinguishable
from being ignored, by the people who cannot see the log.

| What happened | What the channel sees | Log line |
| --- | --- | --- |
| No `client-<channel>.pem` for this channel | Names the certificate, and the script that mints one | `tools_unavailable`, `reason: no_client_certificate` |
| Proxy down, or it refused this certificate | Says the proxy could not be reached | `tools_unavailable`, `reason: connection_reset` or `unreachable` |
| Shutting down mid-listing | Nothing | none |
| It refused the spend report, or could not be reached for it | The answer, unchanged | `spend_report_failed`, with `reason` and the count the meter did not learn |

Neither message answers what was asked. A synthesized answer to the question is
the thing this process will not do when something is broken.

A failed tool *call* is different and never ends a task: a refusal, a hold, or
an upstream error comes back to the model as tool-result content and the task
carries on.

Under compose it is the `server` service, built from `apps/server/Dockerfile`
with the repository root as its context — the pnpm workspace is what installs,
not one package. The image runs as `node`, carries the built JavaScript and its
production dependencies and nothing else, and sets no ENTRYPOINT, so `CMD` is
`node dist/index.js` and an operator's own command line replaces it whole.

## Shutting down

`SIGTERM` or `SIGINT` aborts every task in flight, closes the socket, and then
waits up to `SHUTDOWN_DRAIN_MS` — eight seconds — for the cancelled tasks to
finish unwinding before exiting.

**A cancelled task still posts nothing, and the drain does not change that.**
The reason is policy rather than plumbing: a reply goes out over the Web API and
not the socket, so a post after the close would in fact succeed. The gateway
refuses it anyway (`state !== "running"` on both dispatch paths) and `replyFor`
has nothing to return for a `cancelled` task. The operator asked for quiet, and
an answer landing in a thread minutes after the person asked — from a process
that is on its way out — is worse than silence.

**What the drain saves is the accounting.** A cancelled task does two things on
its way out: it reports the turn it had already completed to the proxy's meter,
and it repaints its checklist card terminal. Both were being killed mid-flight
by the exit (#118). Eight seconds is sized from their own deadlines — the spend
client's is five seconds, and the card is one Slack call — not from how long a
task can run. That number is the channel's `max_task_seconds`, five minutes by
default, and no shutdown waits for it: `deploy/docker-compose.yml` sets
`stop_grace_period: 20s` and SIGKILL follows it. **A task that was mid-turn
loses its answer, and always did.**

Exceeding the bound is logged, not silent: `drain_timeout` carries the bound and
how many dispatches were abandoned. What that costs is the last turn's spend for
each of them — the meter under-reports rather than over-reports, so the budget
fails open, and the proxy's own tool-call meter is unaffected either way.

A second signal exits immediately, cutting the drain short. Exiting with a
session's `store.db` still open is safe rather than merely tolerated: the store
runs in WAL with `synchronous = FULL`, so a committed row survives a hard kill
and nothing is buffered waiting for a close.

If Slack refuses the credentials after startup — a revoked or rotated token —
the process logs `gateway_dead` and exits non-zero rather than staying up
healthy and never answering again. Under compose, `restart: unless-stopped`
brings it back once the environment is fixed.

## Layout

- `src/env.ts` — every environment rule, apart from `index.ts` so the failure
  modes are testable without a process.
- `src/handler.ts` — the Slack adapter, and the only file here besides
  `index.ts` that knows what Slack is. A `SlackMention` becomes a `TaskRequest`
  and a reply goes back; a second front-end writes its own version of exactly
  this file.
- `src/ingest.ts` — the other half of that seam, and the shorter one: a
  `SlackMessage` becomes a row in its channel's store, and a `SlackRevision`
  deletes or reindexes one. Out here rather than under `session/` because it
  names both a Slack type and a session, which is the pair the ESLint rule
  forbids in one file.
- `src/session/types.ts` — what everything below the adapter works in:
  `SessionKey`, `TaskRequest`, `TaskSettings`. No Slack type appears in it, and
  an ESLint rule on `src/session/**` is what keeps that true.
- `src/session/mutex.ts` — one at a time, in arrival order.
- `src/session/registry.ts` — the sessions, and when they are torn down.
- `src/session/sheet.ts` — a channel's team sheet to a model and four caps.
- `src/session/store.ts` — a channel's message store, gated on it having a
  sheet. Symmetric with `sheet.ts`, and total in the same way: it answers `null`
  rather than throwing, because `registry.open` is synchronous and uncaught.
- `src/session/memory.ts` — a channel's `MEMORY.md`, gated the same way and total
  for the same reason. Opened per task rather than per session, because its cap
  comes from the team sheet; and it absorbs the three throws `openMemoryFile`
  makes, which is the never-throw shape that package's README asks its caller
  for by name.
- `src/session/names.ts` — one display-name lookup per user per session. Takes
  the lookup as a parameter rather than holding one, so nothing under
  `session/` has to name a Slack type.
- `src/session/context.ts` — the context assembler: a channel's recent messages
  become the transcript a task starts from, attributed.
- `src/session/router.ts` — request in, reply out: which session, what it waits
  for, which sheet the task runs on.
- `src/session/task.ts` — one agent task. One proxy tool client and one spend
  client per task, both pinned to the request's channel. It also turns the
  agent package's callbacks into log lines, which is where a model naming a tool
  the channel was never given becomes visible as `tool_not_permitted` — the
  proxy never saw that call and rightly writes no audit row, so this is the only
  record of it.
- `src/approvals/` — the client half of the approval broker: the pending-wait
  registry, the card prompter, and the decision route. Out here rather than under
  `session/` because a card needs the mention's channel and thread, and what
  crosses into the router is a closure.
- `src/checklist/checklist.ts` — the live checklist's coalescer. Same shape and
  the same reason: the Slack facts are captured on the adapter's side, and the
  router carries a reporter that names none of them.
- `src/compose.ts` — the wiring, as a function of its dependencies:
  `createServer(deps)` returns a gateway that has not connected. It holds no
  environment, no token, and no default that could stand in for one. This is the
  package's entry point (`main`/`exports`), because it is the half another
  process can compose; `dist/index.js` is reached by path.
- `src/index.ts` — the environment and the lifecycle. Reads the variables,
  builds the adapters, calls `createServer`, connects, stops cleanly. Running it
  is a side effect of importing it, which is why it is not what the package
  exports.

  The split is what lets the e2e suite (`e2e/`) and `held-call.test.ts` run the
  *production* composition rather than a restatement of it — the Slack surface
  arrives as a factory, so a test passes one over `createStubSlack` and gets the
  same graph. What stays here is what belongs to a process: the tokens, and an
  `onFatal` that exits.
