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
| `AGENT_STORE_ROOT` | The agent's own state: one directory per channel, each holding a `store.db`, a curated `MEMORY.md`, a `skills/` directory of playbooks, and a `proposals/` one of merge drafts. Written. Not the same root. |
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
every mention exactly as before and simply has no semantic recall. Skills still
retrieve, on their full-text leg alone, which the team sheet calls a behaviour
rather than a setting — nothing embeds a skill in that deployment and nothing
tries. It logs `embeddings_unconfigured` once at startup and carries on. That is the opposite
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

### Where the post-reply turns sit in the queue

After a task's reply has been produced, the router enqueues **one thunk** on that
same session queue, and it runs whichever post-reply turns this channel earned:
the **curation turn**, which decides whether anything about the task belongs in
`MEMORY.md`, and then the **skill-author turn**, which decides whether the task
left behind a reusable playbook. It is **not awaited**: the reply goes back to
the gateway and into the thread at the moment it always did, and the person who
asked waits for nothing extra.

**One thunk rather than one each (#291), and the reason is the turn id.** A turn
reports its spend under `<task>.<n>`, which is the meter's idempotency key.
Curation takes the task's turn count plus one; a sibling thunk for authoring
could not know whether curation had run, so it would have to claim `+ 2`
unconditionally and leave a gap whenever `[memory] enabled = false` — which is
exactly what `CurationTurnOptions.turn` promises will not happen. One closure
holds the counter and the promise survives every combination. Curation runs
first, which mostly settles that a process asked to stop mid-way drops the newer
feature rather than the shipped one; neither reads what the other writes.

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

A failure in either turn is a `curation_failed` or `authoring_failed` line and
nothing else. The reply has already been produced, nothing is awaiting the thunk,
and the session goes on answering.

**What triggers the author turn is a count, and it is not the loop's count.**
`[skills] author_after_tool_calls` says it counts tool calls the proxy *served*,
strictly more than the figure — and `AgentTaskResult.toolCalls` is a different
number, because the loop increments it the moment it dispatches a call, before
the executor runs. A refused tool, a name this channel was never granted and an
upstream 500 are all in it. So the runner counts `onToolCall` steps that reached
`ok` instead, which adds nothing to the loop and reuses a callback the checklist
already needed. A task whose calls were all refused learned that this channel's
sheet does not grant those tools, and a playbook written from it would be a
playbook about tools that do not work here.

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
context rather than instructions. The sheet's `[channel] description` is the
deliberate exception (#369) — it does sit in the system prompt, composed by
`systemPromptFor` in `task.ts`, and may, because it is operator-authored: it
arrives through a file in the operator's git repo, never through the channel.

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

**It is where reconciliation runs for the task about to start.**
`reconcileSkillIndex` had no caller until this file. The moment correctness is
required is the moment retrieval runs, and outside the lock the pass would race
the quiescence sweep's writes and, once #291 lands, the previous task's
authoring. That pass is the whole of how a hand-edited or hand-deleted skill
takes effect: no watcher, and the team's directory is the truth. Its steady-state
cost is a `readdir` and a `stat` per file — a file is re-read only when its
fingerprint moved, and re-embedded only when its *description* moved. Since #305
`src/session/skill-embed.ts` calls it too, on channel activity; that is a second
caller of one function inside the same lock rather than a second path, and it is
below.

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
behaviour and refuses to make it a field. Between #292 and #305 that was *every*
deployment rather than only the ones with no provider — nothing embedded a skill,
so `nearest` answered nothing and the fusion below ran on one leg everywhere.
That is what the next section is.

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
nothing to answer with.

**What `stale` means to retrieval is nothing**, which is #294's call and worth the
sentence it takes. A stale skill is retrieved exactly as an active one is: no
marker rendered into the context, no demotion in the fusion. The reason is that
there is nothing to express a demotion *in* — the interleave is round-robin with
no weights and no RRF constant, deliberately, because an L2 distance and a bm25
rank are not comparable. Introducing a first weight in order to demote a playbook
nobody has opened lately would be paying exactly the cost that block avoided, to
express a judgement the team can already read in their own git history. So `stale`
is for the people who own the directory, and it is the waypoint on the way to
`archived` — which *is* a retrieval fact.

The block does **not** carry the "this is context, not instructions" line the
other three do, and that is deliberate: history, curated facts and summaries are
things to reason from, and a playbook is a thing to follow. What replaces it says
that following one grants nothing — a statement of fact the proxy enforces, not a
mitigation the words perform.

## The skill-embedding pass: what makes the vector leg answer

`src/session/skill-embed.ts` answers #305. `reconcileSkillIndex` writes no
vector — `packages/memory` has no model provider, by design — so it leaves rows
for `skillsNeedingEmbedding` to surface, and until this file nothing surfaced
them. This is the caller that does.

**It runs where the sweep runs, and for the same reason.** A skill file changes
through somebody saving a file, which fires no event this process can see, so the
reliable moment to look is when something else happens in the channel: the
message ingest path, queued on the session mutex, deliberately not awaited. It
shares `SWEEP_INTERVAL_MS` rather than restating it — that constant is how often
this process bothers to look, and there is one such number.

**The head of a task is the wrong place, and it is worth writing down so nobody
re-derives it.** Reconciliation runs there because correctness is required at
that moment; embedding is a provider round trip whose benefit the *next* task
collects, so putting one in front of every reply buys latency for a benefit
nobody in that thread receives. A task already pays for one embedding call at its
head — a second is a different trade.

**A separate pass rather than a leg of the sweep**, because the two answer to
different blocks of the sheet: `[memory] summarize` against `[skills] enabled`.
Folding them together would mean a channel that turned thread summaries off lost
skill embedding with them.

**It reconciles first**, which is why it is `reconcileSkillIndex`'s second
caller. The index is what says which skills need a vector, so a pass that only
read it could embed nothing a task had not already indexed — a skill somebody
wrote with an editor would wait for a mention before it could even become a
candidate, and one the author turn wrote would wait for the task after the one
that wrote it. Reconciling first is also what makes the archived rule structural:
`skillsNeedingEmbedding` excludes archived rows, and reconciliation is what puts
a hand-set `status: archived` into that column.

What bounds it: `[skills] enabled` and `max_skills` from the sheet;
`SWEEP_INTERVAL_MS`; and `MAX_SKILLS_PER_EMBED_PASS`, which is ten rather than
the sweep's three because what it bounds is different — one pass is **one**
provider call whatever its size, `EmbeddingRequest` taking texts plural for
exactly that, so the figure bounds tokens rather than calls, and a description is
a few hundred characters where a thread is sixty messages. `skillsNeedingEmbedding`
answers in name order, so a full library is worked through deterministically over
successive passes rather than dropped.

**Only the description is embedded**, never the body — the same text
`description_hash` stands for. So a body edit and a rewritten `status` cost
nothing, an edited description costs exactly one re-embedding, and the pass holds
no opinion about any of that: what needs a vector is a LEFT JOIN and what
invalidates one is `reconcileSkills` noticing the hash moved.

The call is metered on the same `SpendReport` path recall and the sweep use, with
a turn id of `skills-embed-<hash of the batch>`. That is `summary-<thread>-<watermark>`'s
property reached by hashing rather than by having a watermark to name: the same
batch of the same text is the same id, so a crash-retry is counted once, and an
edited description makes a different one. Its cost is stated rather than hidden —
a description edited and edited back inside a day re-embeds free on the meter,
which is the cheaper of the two errors available.

**A deployment with no embedding provider is unchanged**: the pass returns before
it reads a sheet or opens a directory, so there is no error, no retry loop, and
no log line, and skills go on retrieving from full text.

## The lifecycle job: the stale and archive clocks

`src/session/skill-lifecycle.ts` answers #294. A library only ever grows —
`max_skills` bounds it, there is no delete operation, and until this file nothing
aged a playbook that had stopped being true. What ages one is not its text and not
its `created:` line: it is what the index observed, which is when a task last
loaded it or, for a skill no task ever has, when this store first saw the file.

**It is the one background pass that spends nothing, and that is structural.**
`SkillLifecycleOptions` holds no completion client, no embedding client and no
`reportTurn`. "Deterministic, no model call" is therefore a fact about what was
wired rather than a promise the module makes — it is the first pass in this
process for which the shared spend reporter is deliberately not passed, and
`index.ts` says so beside the call. Anyone adding one of those options should take
that as the question rather than the answer.

### The arbitration

`skill_use` carries two columns nothing read until this landed: `status_by_job`,
the status the job last recorded, and `status_by_job_at`, when it last adopted
one. Three rules use them.

**A status the job did not write is the team's.** Detected by comparing the file's
status against `status_by_job` — a value comparison, not a timestamp one, because
there is no clock on these files worth trusting. A disagreement, or a missing row,
makes the job *adopt*: it records what the file says and writes no file that run.

**Adopting restamps `status_by_job_at`, and that stamp is part of the clock.** A
skill ages from `max(last_used_at ?? first_seen_at, status_by_job_at)`, so a hand
edit buys the team a full stale window before the clock speaks again. Without it,
somebody un-archiving a long-unused playbook would watch the job archive it back a
cycle later, which is fighting them rather than respecting them. The consequence
is stated rather than discovered: **a lost index costs one full stale window** of
no-ops, where the comment written before this job existed said one cycle. That is
the better failure — an operator restoring a store should not have their library
archived by the next message in the channel — and it is the same mechanism that
makes a hand-set status survive, so the two cannot be had separately.

**The job's own move does not restamp it.** The clock is what its decisions are
measured against, so a job that reset it every time it acted could never reach its
second threshold: a skill marked stale at thirty days would archive at a hundred
and twenty rather than ninety.

Two more things the arbitration settles. **A target is absolute rather than a
step**, so two hundred days idle goes straight to `archived` — `stale` is a
waypoint a team observes when the clock passes through it in real time, not a
turnstile the job has to be present for, and what guards against a burst is the
first-sight rule rather than step-limiting. And **ageing needs only time while
freshening needs a use**: idle time is evidence a skill has gone quiet, but "not
idle" is evidence of nothing — a skill somebody archived by hand this morning has
an idle time of zero. So a move back toward `active` also requires that the most
recent thing that happened was a task loading the skill, which is what makes
**`archived` terminal with no `if` for it**: an archived skill is out of both
retrieval legs, so it can never record the use that is the only road back. A
person editing the file is the road back, and the adoption rule respects it.

### Ordering, and why reconciliation comes first

The arbitration compares the *file's* status against the job's record, and the
file's status reaches it through the index. A pass that did not reconcile first
would read its own last word back and conclude nothing had changed, with every
hand edit since the previous pass invisible. **Reconciling first is what makes "a
hand-set status is respected" a property rather than a race**, and it makes this
`reconcileSkillIndex`'s third caller; all three hold the session's lock.

Files are written **before** their stamps. A crash between the two leaves a file
the job wrote with a baseline it did not record, which the next pass reads as
somebody else's edit: it adopts, and the cost is one stale window. The other order
would leave the index claiming a move the file never took, and under a persistent
`EACCES` the baseline would churn every run while the skill never aged.

A second reconciliation runs when anything was written, so an archived skill
leaves retrieval and loses its vector before the pass returns. **Correctness does
not depend on it** — `skill-recall.ts` reconciles at the head of every task before
it searches, so the skill is excluded on the very next task either way. What it
shortens is the window, from "the next task" to "the end of the pass".

### The schedule, and what "weekly" means here

`LIFECYCLE_INTERVAL_MS` is six hours per channel rather than `SWEEP_INTERVAL_MS`'s
five minutes, and the departure needs its argument written down because the
embedding pass established the opposite precedent. That file imports the sweep's
constant on the grounds that there is one "how often this process bothers to look"
number — which is an argument against *restating* a figure, not against a second
one existing. What it bounds there is how soon a newly saved skill gets a vector,
a question whose answer changes within minutes. Here the smallest unit either
threshold is expressed in is a **day**, so looking 288 times a day would answer a
question that changes at most twice in a skill's life.

The spec calls this a *weekly* maintenance job. What makes any interval at or
below that satisfy it is **idempotence**: the clocks are absolute dates, so
running more often moves nothing sooner than its threshold and running less often
only delays. "Weekly" is a statement about how often a status needs revisiting,
not about a schedule this process would have to grow a timer and a channel
enumerator to keep — and both are shapes `threads.ts` and `summarize.ts` have
already declined. A channel silent for a year ages nothing until somebody speaks
in it, which is the sweep's own argument arriving at the same place.

It is triggered where the other two are: the message ingest path, on the session
mutex, deliberately not awaited, in its own `mutex.run`. A **third** option rather
than a leg of the embedding pass, though both gate on `[skills] enabled` — so the
sweep's "different sheet blocks" argument does not apply and should not be reused.
The decisive reason is that `createSkillEmbedSweep` returns before it reads a
sheet when the deployment has no embedding provider, a supported configuration, so
folding the clocks in would make a channel's lifecycle depend on a key it does not
have. Keeping the provider client and the meter out of the lifecycle module is
also what makes "it spends nothing" structural.

The only state it keeps in memory is the per-channel interval stamp, so a restart
makes the next message in each channel run a pass immediately. That costs one
`SELECT` and one `readdir` and moves nothing that was not already due.

### What bounds it

- **The sheet.** `[skills] enabled` turns it off, and a channel that disabled
  skills has its statuses frozen rather than rewritten by a feature it does not
  run. `stale_after_days` and `archive_after_days` are the two clocks, defaulting
  to the spec's thirty and ninety; the schema refuses a sheet where the second is
  below the first, because that order makes `stale` unreachable rather than
  expressing a policy anybody meant.
- **`LIFECYCLE_INTERVAL_MS`**, per channel.
- **`MAX_SKILL_STATUS_WRITES_PER_PASS`.** Twenty files per pass, in name order, so
  a channel coming back to a library nobody has touched in a year gets a diff
  somebody can read rather than a hundred rewrites at once. Adoption is unbounded,
  because it writes no file.
- **`setStatus` itself**, which cannot create a file, cannot create the directory,
  and cannot write a file it could not first read — so a half-saved edit is never
  overwritten by a clock.

It never deletes. Archiving is a status; removing a file is the team's act on the
team's directory, and there is no delete on `SkillFiles` to reach for. Its log
words are `skills_adopted`, `skills_marked_stale`, `skills_archived`,
`skills_reactivated` and `skills_lifecycle_failed`, all carrying counts and never
a playbook's name. The first of those is the line that explains a run that moved
nothing.

## The curator pass: a proposal, and who applies it

`src/session/skill-curate.ts` answers #295, the last of phase 3. The author turn
sees only the skills retrieval had already loaded, so a playbook gets written
twice by a turn that could not see the first copy. This is what notices — and
what it does about it is **propose**, never rewrite.

### The review surface is the filesystem, and that was forced rather than chosen

The obvious surface is the channel: post the diff where the team is. **This
process cannot.** `MessagePoster.postThreadReply` is deliberately withheld from
the composing app — `packages/gateway`'s `SlackSurface` narrows to `CardPoster`
precisely so a handler cannot post out of band — and a card needs a `threadTs`
from an inbound event, which a background pass does not have. A new top-level
message is ambient mode's mechanic, which ships in a later phase and behind its
own switch.

Approval cards are separately not it, and the reason is worth keeping because it
is the one somebody will reach for: **a card is the proxy's mechanic for a held
tool call, and this is not a tool call.** Borrowing the card machinery would put
a proxy dependency in a pass that has none.

**Since #320 the channel is told, and the file is still the review surface.**
The heartbeat names a waiting proposal in a proactive post — the file and the two
acts, and none of the document. What changed is that somebody now knows to open
the directory; what did not change is that the directory is where the review
happens. The notice is composed from the two skill names by
`renderProposalNotice` and never by a model, which is what keeps this package's
"no model-authored text in `proposals/` re-enters a model's context" true: a
notice the model wrote would need the proposal in front of it.

So a proposal is `proposals/<a>--<b>.md`, a sibling of `skills/` in the channel's
own state root. It shows the merged playbook as a **complete file** — frontmatter
included, `created` and `status` carried from the kept skill — with both
originals quoted beside it, so applying is a paste rather than surgery. Not a
unified diff: a merged body is a rewrite rather than an edit, hunks over two
rewritten playbooks are unreadable, and a diff format would imply a patch tool
that does not exist here.

**A sibling and never a child.** Anything under `skills/` whose filename stem
parses as a `SkillName` is indexed as a skill, so a proposal quoting two
playbooks would become a retrievable third. The `--` in the filename is a
sequence `SKILL_NAME_PATTERN` cannot produce.

### Nomination is the index's job; the model only drafts

`skillMergeCandidate` answers the closest **mutual nearest neighbour** pair not
yet considered — B is A's nearest live skill and A is B's. The full argument is
on the SQL in `packages/memory`; what matters here is that it needs no distance
constant, which this tree has now refused three times for the same reason, and
that it replaces a rule that would have been quietly disastrous. "The closest
pair nobody has looked at yet" terminates only after every pair has had its turn:
a hundred-skill library would work through 4950 mostly unrelated pairs at one a
day, for thirteen years.

The model's job is the other half, and only that: it is handed two playbooks in
full and asked whether they are one. Declining is calling no tool, which is the
ordinary answer — the pair is the closest two in a library, not two anybody
judged similar, and the system prompt says so because a model that believes they
were selected *because* they overlap will find the overlap.

### What stops a declined proposal coming back

`skill_merge_proposal` records every pair the pass has **considered**, drafted or
declined, with the two description hashes it considered them at. The nomination
query excludes a pair whose row still matches, so a pair is raised once and not
again until somebody edits one of the two descriptions.

**Deleting the file is the decline, and nothing observes it.** Ignoring a
proposal and declining it therefore come to exactly the same thing, which is the
point: the team never has to tell this process anything, and there is no state
they can get wrong. It also means the steady state is free — a library nobody has
edited answers one SELECT and makes no call at all.

The one outcome that records nothing is a provider that threw. That is an outage
rather than an answer, so the pair comes back next run. A call that did not fit
the schema *is* recorded, and that asymmetry is deliberate: the spend already
happened, and a pair that costs a call a day forever because a model could not
pick between two names it was given is the failure the whole rule exists to
prevent.

### Ordering, and what bounds it

One instant for the pass. It reconciles first — `reconcileSkillIndex`'s fourth
caller, all four inside the session's lock — because the index is what nominates
the pair *and* what holds the hashes the bound is decided on, so skipping it
would nominate against a directory that has moved. Then it prunes, then it
checks the cap, then it nominates, then it resolves both skills through
`files.read`, and only then does it spend anything.

**Pruning comes before the cap check**, so a slot freed by a proposal somebody
applied is usable on the same run rather than a day later. A pair whose skill the
index no longer holds is how an applied — or half-applied — proposal is found:
the file goes first and then the row, so a crash between them leaves a row with
no file, which prunes again harmlessly, where the other order would leave a file
nothing could ever find and a cap slot consumed forever. **That is also why no
trigger drops these rows when a skill is deleted**: the surviving row is the only
record of which file to remove.

What bounds it: `[skills] enabled` and `[skills] curate`; `CURATE_INTERVAL_MS`, a
day per channel; **one pair and one model call per run**, structurally, because
the nomination answers one row and there is no loop; `MAX_OPEN_PROPOSALS`, so a
team that never opens the directory stops being asked after three; the hash rule;
and the meter, which is the backstop rather than the mechanism. The turn id is
`skills-merge-<hash of the pair and its two texts>`, so a crash-retry is counted
once and a re-consideration after an edit is a different turn.

A day rather than the lifecycle job's six hours, and the difference is what is
being bounded: those passes bound how stale a derived thing may get, and this one
bounds **how often a team may be asked to read something**. Nothing is lost by
waiting, because the candidate set only moves when a hash does.

### What it does not do

**It writes no skill file, and holds nothing that could.** That is two structural
halves rather than a rule anybody keeps: `SkillProposals` has no method that
names a skill file, and `runSkillMergeTurn` in `packages/agent` takes no handler
at all, where the author turn takes an `applyOp`.

**Nothing reads a proposal back.** There is no `read` on `SkillProposals`, which
means there is no path by which model-authored text in `proposals/` re-enters a
model's context — the shape `e2e/skill-poisoning.test.ts` exists to keep closed.
It also means the file needs no parser and no version, and a team may annotate or
rewrite a proposal before applying it without anything noticing.

**A deployment with no embedding provider proposes nothing at all.** The
nomination returns before it touches a vec table that may not exist, so there is
no error, no log line and no retry. This is a **behaviour difference from skill
retrieval**, which degrades to full text and is documented as a supported
deployment: there is no lexical answer to "are these two near each other",
because bm25 answers a question about a query rather than about a pair.

Its log words are `skill_merge_proposed`, `skill_merge_none` — the line that
explains a run that spent tokens and produced nothing — `skill_merge_unusable`,
`skill_merge_failed`, `skill_merge_backlog` and `skill_merge_pruned`. The middle
two are kept apart for the reason `summary_failed` and `summary_unusable` are:
"the provider is down" and "the model cannot follow the schema" want different
answers from whoever is reading. All carry counts and reason codes, never a
playbook's name.

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

## The ambient clock: the one timer, and the one enumerator

`src/session/ambient.ts` is the scheduler (#317), and it is the first thing in
this process that runs on a clock rather than on something a person did. The four
background passes above fire from the message ingest, and the lifecycle job's own
docs give that as a feature: a cron would mean growing a timer and an enumerator
over every channel, neither of which anything else here needs. Ambient needs
both, so they land here once — and the four passes stay on channel activity.

What it decides is **when to look, and where**. What a heartbeat then weighs is
the evaluation turn's (#319, below), and whether anything is posted is the
posting surface's (#318, below). The `heartbeat` dependency stays optional: a
scheduler composed without one logs `ambient_due` for a due channel and runs
nothing, which is what the rig relies on to test the clock alone.

### Wake at the next due instant, not on a tick

The loop sleeps until the earliest thing that is due. There are two kinds of due
thing: a channel's heartbeat, and — since #324 — a scheduled task, due at a
particular instant, which must fire *then* rather than at the next
cadence boundary. The task is an event source rather than a second clock: it
contributes entries to the same plan, and `earliestDue` answers over all of them,
which is what `DueEntry.kind` is for.

`AMBIENT_RESCAN_MS` caps the sleep at a minute, and that is the discovery bound
rather than a tick in disguise. Nothing notifies this process that a sheet was
edited, so a loop that only ever woke at a known deadline would never learn that
a channel had turned `[ambient] enabled` on, and a deployment with nothing
enabled would sleep forever. A minute is the shortest cadence a sheet can
express, and a scan is a `readdir` plus one small file read per channel — no
network, no model call.

### Missed windows are skipped, not replayed

A heartbeat asks whether anything merits a post *now*, so catching up on a week of
downtime by firing seven hundred of them would be seven hundred answers to one
question. Two rules make that structural:

- **First sight never fires.** A channel newly seen enabled is scheduled at
  `now + cadence`. Every restart is a fresh scheduler, so this is also why a
  restart replays nothing — the in-memory schedule starting empty *is* the rule,
  which is what makes persistence unnecessary rather than missing.
- **A fire reschedules from the instant it fired**, with the cadence just read,
  so a channel six windows overdue fires once and an edited cadence takes effect
  there rather than a cycle later.

The cost is stated rather than discovered: an enabled channel waits one full
cadence after a restart, and a newly enabled one waits a cadence after the scan
that noticed it.

### Why the enumerator is the filesystem, and where the workspace comes from

A session exists because a channel has had traffic. Ambient exists for the
channel that has *not* — the question sitting unanswered since Friday — so an
enumerator over live sessions would systematically miss the case the feature is
for, and would miss every channel again after each restart. `src/session/channels.ts`
therefore lists `AGENT_CHANNELS_ROOT`, read-only, keeping only directories whose
name is a `ChannelId`; whether a channel has a *sheet* is not checked there,
because one without resolves to the built-in defaults, where ambient is off.

That listing gives channel ids, and a `SessionKey` is `(workspace, channel)`. A
workspace this process made up would key a second session — and therefore a
second mutex — over a live channel, which is the one thing the session registry
exists to prevent. So it is asked for: `SlackGateway.workspace` answers what
`auth.test` said inside `start()`, and the composition hands the scheduler a
`() => string | undefined`. Until there is one, a scan enumerates nothing, logs
`ambient_unidentified`, and schedules nothing — so the first scan that can act is
also the first that sees each channel, and the first-sight rule stays true.

This is why `index.ts` starts the clock *after* `gateway.start()` resolves.

### What bounds it

- **The sheet.** `[ambient] enabled` is off unless a channel wrote otherwise —
  the one block on the sheet whose default is off — and an unreadable sheet falls
  back to off too. That fallback is sharper than `[memory]`'s and `[skills]`':
  those govern what a task does once somebody asked for one, and a heartbeat
  contains no tool call for the proxy to decide, so what `src/session/sheet.ts`
  resolves here *is* the decision.
- **`AMBIENT_RESCAN_MS`**, the ceiling on the sleep.
- **`MAX_CONCURRENT_HEARTBEATS`**, four. The on-activity passes are rate-limited
  by traffic and run one channel at a time; this enumerator can start work in
  every channel at one instant, and after a restart it will try to, since every
  enabled channel takes the same first-sight instant. The bound is against that
  herd rather than against the steady state, and no channel is starved — a scan
  runs every due channel before it answers, so being fifth in line costs a wait.
- **The overrun rule.** A channel whose previous heartbeat has not finished is
  skipped (`ambient_overrun`) rather than queued: turns stacking on the mutex
  make a channel that is already behind get further behind.
- **The meter** — the backstop, not the mechanism.

A heartbeat runs on the channel's session mutex, like every background pass, and
is **awaited**, unlike them: nothing is waiting on a scan, and awaiting is what
gives the concurrency bound teeth. One channel throwing is `ambient_failed` for
that channel and a scan that carries on.

## The heartbeat evaluation: what a due channel actually does

`src/session/heartbeat.ts` answers #319, and it is the reader the ambient clock
shipped without. It is **not** one of the four background passes: those fire from
the message ingest on channel activity, and this runs on the clock — which is the
whole difference ambient mode exists for, since the channel that has *not* had
traffic is the one with the question sitting unanswered since Friday.

### The pregate, and why its order is the design

Most heartbeats must cost nothing, or a brisk cadence is unaffordable and the
feature ships turned off. Four questions run before any model call, cheapest and
most decisive first:

| | Question | Cost |
| --- | --- | --- |
| 1 | Is `[ambient] enabled`? | a sheet read the resolver caches |
| 2 | Is the rate window open? (`post.mayPost`) | a map lookup |
| 3 | Is there anything new that has gone quiet? (`store.idleThreads`) | one indexed query |
| 4 | Can the channel afford it? (`maySpend`) | a network round trip |

A tick that stops at any of the first three is silent and spends **nothing at
all**. The budget question is last because everything above it is free: a channel
that was never going to evaluate must not pay for a question about its budget.

Step 3 is where `[ambient] answer_after_idle_minutes` finally gets its first
reader. It needed a store read of its own — `staleThreads` is joined against the
summary corpus, so a channel with `[memory] summarize` on would have its quiet
threads summarized away and become permanently invisible to the heartbeat, which
is exactly the case this feature is for.

### The watermark, and why a shut window loses nothing

One Slack `ts` per channel, in this factory's closure, advanced to the channel's
newest message **when an evaluation runs** — including when the answer was
silence. Two properties fall out and both are load-bearing.

**A finding is offered at most once per silence.** This matters because *the
agent's own replies are not in the store*: nothing records that it already spoke
about a thread, so without the watermark a question it had raised would look
unanswered forever and be raised again every window. A thread that says something
more rises back above the watermark, goes quiet again, and is eligible again —
say-once is per silence, not forever.

**A shut window defers rather than loses.** This is the decision
[#318 left open](#the-proactive-post-the-one-way-this-process-starts-a-message).
Because the window is checked *before* the evaluation, a heartbeat that cannot
post does not evaluate, does not advance its watermark, and finds the same
material again next time. The alternative — evaluate, then be refused — forced a
choice between losing the finding and paying for the same turn on every tick
until the window opened.

The state is in memory on the clock's own argument: a process that starts empty
weighs the channel once more, which is the cheap direction to be wrong in.

### Silence is calling no tool

There is no `SILENT` sentinel, and the divergence from the architecture's wording
is deliberate. All four other background turns express declining as an empty tool
list, and under that idiom the issue's requirement — that an answer which is
neither a sentinel nor a finding is treated as silent — holds *by construction*:
a malformed call, an invented tool name and a paragraph of prose all produce no
finding, with no branch anyone has to write correctly. A sentinel would need
recognizing, and "when unsure, post" is the wrong default for an agent speaking
to a channel that did not ask.

An unusable answer is still logged apart from silence (`heartbeat_unusable`), so
a broken prompt cannot hide inside the outcome that is expected almost every
time.

### A waiting merge proposal is one more kind of material

`#320`, and the deferred half of phase 3. A proposal nobody has been told about
is material in the pregate's sense — a tick with no new messages still has
something to say — and it is **free**: the notice is a template over two skill
names, so a tick whose only material is a proposal makes no model call at all.

Three consequences, each of which is a decision rather than a fallout:

- **A channel over its caps still hears about one.** Telling somebody a file is
  waiting costs nothing, and what `maySpend` bounds is spend.
- **A notice and a finding in one evaluation are one post**, folded finding
  first — the timely half before the housekeeping. The window permits one post
  and the rate limit is not negotiable by having two things to say.
- **The model is never told a proposal exists.** It is not in the turn's input
  and the notice is not its words, which is what keeps `packages/memory`'s "no
  model-authored text in `proposals/` re-enters a model's context" true.

Say-once is a row in the channel's index — `skill_merge_notice`, its own table
beside the considered one, because *considered* is a fact about spend and *told*
is a fact about a channel. It is written **after** the post lands, so a refused
or failed post leaves the proposal to be offered again; and it is deliberately
**not** cleared when the considered row is forgotten, because a team that deleted
a proposal has declined, and re-announcing it would make deletion a way to be
asked again.

What is listed is the **directory**, never the index — which is what makes
deleting a proposal both the decline and the thing that stops it being announced.
A proposal deleted before the notice fires surfaces nothing, because it is not
there to be found.

### What the model is shown, and what it is not

The channel's recent activity, capped at `MAX_HEARTBEAT_MESSAGES` and attributed
by the name captured when each message was stored. It is **not** told which
threads the pregate found idle: handing it the answer would make the finding a
formality, and the cases the design actually wants — a deadline nobody picked up,
a thread stalled on something answerable — are the ones it would stop looking for.

## Where a scheduled check lands (#323)

A `schedule_task` create is governed by the tool proxy service and recorded here,
and the split is forced rather than chosen: that service opens a channel's store
`readOnly`, and a writer there would be a second writer on one file, from the
process that must not be able to repair a channel's evidence. So the create is
served, the ticket it minted comes back in the result, and
`session/scheduled.ts` turns it into a row.

The seam is `ProxyToolClientOptions.onScheduledTask`. The router builds the sink
from `session.store` **inside the lock**, beside `memoryFile` and `skillFiles`, and
passes it on `TaskSettings`; `session/task.ts` wires it into the tool client the
way it already wires `onUnmappedCall` and `onBudgetWarning`. Built from the
session's store rather than opening one, because there is one handle per channel
and a second would be the very thing the proxy is denied.

**Why the write is exact against a model.** The proxy's pending cap counts what
this side has written, and three properties in a row make that count right at the
moment the next create is decided: the loop dispatches a task's tool calls one at a
time, `node:sqlite` writes are synchronous, and a channel's work is serialized on
one session mutex. So the row from create *N* is on disk before create *N+1* is
submitted. That is the whole of the claim — a *compromised* agent process can
write extra rows or none, and has cheaper attacks available anyway.

**What can be lost, and in which direction.** The audit log records the governed
create and the store records the ticket that will fire, and they can disagree one
way: an audited create whose row never landed. It cannot be refused retroactively,
because the call ran — so the model is told plainly (the client answers it an
error result saying the check will not run) and `scheduled_task_unrecorded` is
what an operator greps for. The other direction is unreachable: nothing writes a
row the proxy did not serve.

**The parse is on this side of the seam**, with the logger. `packages/agent`
hands over the result's text; this parses it with `@getlibero/schema`, the same
definition the proxy serialized it with. A failure is a deployment fact — two
halves that do not agree about a shape — and that package cannot log and must not
learn how.

## Firing a due check (#324)

`session/check.ts` is what a due ticket does, and it is a third kind of thing
this process runs on a clock — not a background pass, which fires from the
message ingest, and not a heartbeat, which asks whether anything merits saying. A
check runs a question somebody already decided was worth asking and approved
through the tool proxy service, minutes or days ago.

### One firing, one outcome

**A due check reaches a terminal state on its first wake, always.** It posts, or
it runs and has nothing to say, or it could not run and the channel is told so —
and in every one of those the row gets its fire stamp and is never looked at
again.

That rule replaced a queue, and what it removed is worth recording so nobody
rebuilds it. A due check that stayed pending would keep contributing an entry to a
plan whose loop sleeps until the next due instant — and an instant already in the
past makes that sleep zero, so a channel over its budget would spin the scan at
whatever rate the event loop allows until its meter reset. Fixing that needs a
backoff; a backoff needs a retry stamp; a stamp needs a rule for how stale is too
stale; and by then a reminder can arrive four days late, which is worse than not
arriving at all.

What the queue was protecting was real, and this keeps it by a different route:
**the team is told.** A check that could not run says so in the channel, from a
closed set of two reasons, so the people who set it up can act on the timer even
though the agent could not do its part. No queue, no backoff, no grace window, no
`abandoned` state, and nothing silently lost.

`[ambient]` off is the one silence. Switched off between the approved create and
the due time, the clock never enumerates the channel, so nothing fires and nothing
is said — that switch means *do not speak here*, and a failure notice would be the
agent speaking after being told not to.

Four outcomes are recorded on the row, and only one of them is read by a person
rather than by code: `posted`, `silent`, `over_budget`, `failed`. `silent` is not
a failure — a conditional check that is usually quiet is working — but a check
that has *never once* had anything to say is usually a badly written check, and
that is only visible if the two are distinguishable.

### Why the stamp is written after the attempt

A crash between the model call and the stamp re-fires the check on the next scan,
which costs one more turn. A stamp written first would lose the check entirely on
the same crash. One is a cost and the other is a silent failure.

The post is not what the stamp waits for either, and that differs from the
proposal notice deliberately. There, nothing had been spent when a post failed, so
leaving the row absent cost a retry and no tokens. Here the turn has already run,
so a stamp that waited for Slack would buy a repeat of the *model call* on every
scan against a channel the app cannot post in — which is exactly why
`ProactivePoster` refuses to refund its window.

### What a fired check cannot do

It has no `ToolExecutor` and no tool proxy client: `runScheduledCheckTurn` is
handed a completion client and a list of messages. So a fired check induces **no**
served calls at all, and "every call it induces meets the same gates a mention's
does" is true by there being none. Giving a check the ReAct loop would be a real
widening of what unattended work can do, and it should be a decision somebody
makes on purpose rather than one inherited from this file.

### The clock reads the store every scan

`session/ambient.ts` asks each enabled channel for its earliest unfired instant on
every scan, rather than remembering one. That is the opposite of what it does with
a heartbeat's deadline, and right for the opposite reason: a heartbeat's next
instant is this process's own arithmetic, so holding it in memory *is* the
skip-don't-replay rule, where a ticket's instant is a fact on disk that another
task in this process can add to at any moment. A cached copy would miss a check
created since the last scan and fire it late.

The cost is one indexed lookup per enabled channel per scan, on a handle the
session already holds — a channel with `[ambient]` on has its session opened every
cadence anyway, so this adds a query and no file handles. It also makes a restart
correct by construction: nothing has to be replayed into memory, because nothing
was ever only in memory.

Two bounds fall out of the same place. **At most one check per channel per scan**,
earliest first, because a channel can hold several that come due together and
firing all of them would be a burst of unprompted messages at one instant; the
rest are due again on the next scan. And **a ticket already due contributes its
plan entry at `AMBIENT_RESCAN_MS` rather than at its own instant**, which is the
spin guard: every way a due ticket can stay pending would otherwise ask the loop
to wake at a time that has passed.

### The operator surface, and why it is here

`src/tasks-cli.ts` is this process's **first operator entrypoint** — `node
dist/tasks.js list <channel>` and `cancel <channel> <id>` — beside the four
`apps/proxy-server` already carries. Where it lives was forced twice over.

Not the published `libero` CLI, for the reason #98 gave the audit log: the store
is a named volume, so `npx @getlibero/cli` would open a path that is not on the
operator's host. That is the rule the compose file already draws — the CLI owns
what the operator authors on the host, and a service's own entrypoints own what
that service owns inside its volumes.

Not the proxy's entrypoints either, even though it mounts the same volume, because
it mounts it `readOnly` by design. A cancel is a write, so it can only be this
process's.

**A cancel is a delete**, `forgetSkillMergeProposal`'s shape: the row's absence is
unambiguous where a stamp saying "fired" about a check that never ran would not
be, and the same act frees the pending slot. The cost is the one declining a
proposal already carries and is worth stating — **nothing records that a check was
cancelled.** If that is ever wanted it is a row somewhere else, not a value in
`outcome`: `fired_at` means when a check ran, and widening it to mean "when it
ended" would make every reader of that table ask which.

It needs no restart to take effect, and that is the property the clock's
read-every-scan was chosen for.

## The proactive post: the one way this process starts a message

`src/proactive/proactive.ts` answers #318. Everything else this app says is a
response — a reply answers a mention, a card answers a held tool call, and both
carry a `threadTs` because an inbound event supplied one. Ambient mode has no
inbound event, so it needed a verb that does not: `ChannelPoster.postToChannel`
in the gateway posts a message into a channel with no thread at all.

### The capability is minted once, and reaches one consumer

The withholding discipline the section above and [the curator's](#the-curator-pass-a-proposal-and-who-applies-it)
both rest on is that `MessagePoster.postThreadReply` never reaches the composing
app. That stays true. What changes is that there is now a *second* narrow verb,
and the way it is kept narrow is composition rather than a rule anybody applies:

- `createSlackSurface` returns `channel` beside `cards`, both over the one
  `WebClient`, so the process keeps one rate-limit queue over `chat.*`.
- `createServer` mints exactly one `ProactivePoster` from it and hands that to
  **`ServerDeps.heartbeat`, which is a factory** — `(post) => AmbientHeartbeat` —
  rather than an already-built pass like the other four.
- The four background passes are constructed with no poster and cannot name the
  type. The quiescence sweep, the skill-embedding pass, the lifecycle job and the
  merge curator still cannot post, and that is checkable by reading what each is
  given.

The factory is the load-bearing part, and it exists because of *when* the
capability exists. The poster is built inside `createServer` from the surface the
`slack` factory returns, so an already-built heartbeat would force `createServer`
to hand the capability back out to `index.ts` — and from there it is reachable by
everything the process constructs. `proactive-compose.test.ts` drives the
production composition and asserts both halves: one poster reaches the factory,
and a surface with no `channel` verb builds no heartbeat at all.

That last one is a deliberate degradation rather than a fallback. Everything a
heartbeat produces is a post, so a turn wired without a poster would spend model
calls to reach a surface it does not have — worse than the clock with no reader
[#317 shipped](#the-ambient-clock-the-one-timer-and-the-one-enumerator), where a
due channel logs `ambient_due` and runs nothing.

### Two sources, and no adjective

A post arrives for one of two reasons, and they are governed in different places:

| `source` | What authorized it | What bounds it |
| --- | --- | --- |
| `heartbeat` | A clock, and nothing else | `HEARTBEAT_POST_WINDOW_MS`, here |
| `task` | A served `schedule_task` create — allowlisted, held for approval by default, capped, audited | Its governed create. One post per firing |

The discriminant is the wake reason, spelled with the word list `session/ambient.ts`
already has: `DueEntry.kind` is `"heartbeat" | "task"`, the second member joining
in #324 as a *member* rather than a second clock. One vocabulary for the phase — what wakes
the loop, what governs the post, and what the channel is told are three views of
the same two cases. A `task` post neither draws on the window nor is blocked by
it: a reminder is not late because a heartbeat spoke first.

Earlier drafts said "bidden" and "unbidden". Those are gone deliberately: an
adjective names how a post feels, where the wake reason names what authorized it,
and only the second is a fact the code has.

### The window is four hours, and it is not a sheet field

`packages/schema`'s `[ambient]` block says so at the point where somebody would
add one — stated in time rather than in ticks, because one post per tick is no
throttle once ticks are minutes apart, and enforced in the posting surface so
that tightening `heartbeat_every_minutes` cannot quietly loosen the throttle. It
lives beside its mechanism the way `APPROVAL_TTL_MS` does.

The window is **not** the primary volume control — the evaluation turn's pregate
is, and most ticks post nothing whatever this number is. What it bounds is the
channel where there genuinely *is* material every time anyone looks. At the
sheet's defaults the cadence is fifteen minutes, so an eight-hour working day
holds 32 ticks, and the window converts that to posts per working day: one hour
gives eight, two gives four, **four gives two**, eight gives one, and twelve or
more straddles the night, where a 17:00 post blocks the next morning.

What decides between the survivors is an asymmetry: **too short kills the feature
and too long only costs a finding.** A chatty agent gets `[ambient] enabled`
flipped back to false and then nothing here works; the recovery path for an agent
that is too quiet is that somebody tags it, which the sheet already calls the
designed path. It holds at both ends of the cadence range — a channel at
`heartbeat_every_minutes = 1` gets 240 ticks per permitted post, and one at the
1440 ceiling never has the window bind at all.

Three rules ride with it:

- **Per channel, never per workspace.** Otherwise one busy channel silences every
  other, which is a channel's ambient setting being decided by a channel nobody
  there can see.
- **The permit is claimed at the attempt, not on success,** and is not refunded
  when Slack refuses. Claiming first is what makes the limit hold when
  evaluations overlap; refunding would turn a channel the app was removed from
  into repeated attempts at the same failure.
- **A refusal is legible.** `post` answers whether it posted. There is no queue,
  so an evaluation that finds something real while the window is shut produces
  nothing — and whether that is a deferral or a loss depends on whether the
  refused evaluation still advances its last-evaluated position. That is the
  evaluation turn's decision (#319), and it only has one to make because this
  surface says what happened.

The state is in memory, per channel, on the clock's argument for its own
schedule. An empty map at startup means "allowed", which is fail-open — and what
makes that safe is the clock above it: first sight never fires, so no heartbeat
runs until a full cadence after a restart, and a crash-looping process never
posts at all.

### What the channel sees

`renderProactivePost` in the gateway, beside the two card renderers. Not a card:
a card is the proxy's mechanic for a held tool call, it carries a status colour,
and something holds its `ts` to edit it. A proactive post is none of that, so the
renderer answers a string and `postToChannel` returns no handle.

The label says what authorized the message — `NOTICED` or `SCHEDULED CHECK` — in
the mono-uppercase style the cards use. Only a `NOTICED` post carries a closing
line naming `[ambient]`, and the asymmetry is not an oversight: a scheduled check
was asked for, and its off switch is the governed create rather than that block.
The body is caller-authored and is escaped and capped like every other string
this app did not write.

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

### A turn nobody asked for checks first

The reports above are after the fact, and for a *task* that is enough — a person
asked, and the tool calls that task makes meet the proxy's gate. It is not enough
for a background pass. A completion never traverses the proxy at all, so a turn
that calls no tool met no bound whatever a channel had spent, and three of the
four passes here spend exactly that way.

Since #335 each of those three asks first, over `GET /v1/budget`, and a channel
over its caps runs nothing. Two things about it are worth knowing before editing
one of those files.

**Where the question goes is load-bearing.** It sits immediately before the
provider call, never at the head of the pass. The skill passes reconcile their
index and prune applied proposals *first*, because that is bookkeeping the next
task reads: a channel that stopped reconciling because it was over a token cap
would answer the next mention from a stale library, degrading a reply somebody
*is* waiting on in order to save a call that pass was about to skip anyway. The
quiescence sweep asks only once it knows it has a quiet thread, so a channel with
`[memory] summarize = false` — or nothing to summarize — costs no round trip at
all.

**The lifecycle job asks nothing, and holds nothing to ask with.** It has no
completion client, no embedding client, no spend reporter and no budget client.
That pairing is what makes "deterministic, no model call" a fact about what was
wired rather than a promise the module makes.

It is not enforcement, and `packages/proxy/README.md` says so where the route is
introduced: this process cannot be stopped by a service that never sees its
completions. What it is, is this process declining to spend a channel's budget on
work nobody asked for.

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
| It could not be asked whether a background pass may spend | Nothing — no person is waiting | `budget_unreadable`, with `reason` |

Neither message answers what was asked. A synthesized answer to the question is
the thing this process will not do when something is broken.

**The last row goes the other way from the one above it, and the difference is
who is waiting** (#335). An unreported turn costs an operator a counter and must
not cost a user their reply, so a failed spend report is swallowed and the answer
still goes out. A background pass has nobody waiting on it, so the same outage
gets the opposite treatment: the pass declines and spends nothing. The sharper
reason is that the two failures arrive together — during an outage `reportTurn`
fails at the same moment, so spending anyway would be spending that is both
unbounded *and* unrecorded.

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
- `src/session/skills.ts` — a channel's `skills/` directory, gated and total for
  `memory.ts`'s reasons. Takes the sheet's `max_skills`, so it is opened per task
  for that file's reason, and creates no directory: `openSkillFiles` makes one
  lazily on the first write, which is what keeps a channel with skills turned off
  from acquiring an empty one.
- `src/session/proposals.ts` — a channel's `proposals/` directory, `skills.ts`'s
  twin. No cap to take, because this directory enforces none — what bounds a
  backlog is the curator's own constant, compared against `count()`.
- `src/session/names.ts` — one display-name lookup per user per session. Takes
  the lookup as a parameter rather than holding one, so nothing under
  `session/` has to name a Slack type.
- `src/session/context.ts` — the context assembler: a channel's recent messages
  become the transcript a task starts from, attributed.
- `src/session/channels.ts` — which channels this deployment has, as a listing of
  the channels root. Names only, read-only, and never rejecting: the one caller
  runs on a clock with nobody waiting on it.
- `src/session/ambient.ts` — the ambient clock (#317): the timer, the enumerator
  over those channels, and the schedule that makes a missed window a skip rather
  than a replay. `scan(at)` is the whole of the behaviour; `start()` is a sleep
  wrapped around it.
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
- `src/session/heartbeat.ts` — the heartbeat evaluation: the pregate, the
  watermark, and the one turn a due channel may pay for. Under `session/` rather
  than beside `proactive/` because it names no Slack anything — what it holds is
  a `ProactivePoster`, which is a channel id and a string.
- `src/proactive/proactive.ts` — the proactive post surface and its rate window.
  Out here for `approvals/` and `checklist/`'s reason and a sharper one: it holds
  the gateway's channel-post verb and its renderer, which is exactly the pair the
  ESLint rule on `session/**` forbids. What crosses into the composition is
  `ProactivePoster`, which names no Slack anything.
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
