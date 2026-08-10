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

Not here yet, and each belongs to its own issue: thread follow-ups without a
re-mention (#66), thread history and attribution in the prompt (#67), and the
live checklist (#68).

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
| `AGENT_STORE_ROOT` | The message stores: one directory per channel, each with a `store.db`. Written. Not the same root. |
| `ANTHROPIC_API_KEY` | Required when `AGENT_PROVIDER=anthropic`. |
| `OPENAI_API_KEY` | Required when `AGENT_PROVIDER=openai-compatible`. |
| `ANTHROPIC_BASE_URL` | Optional. Anthropic's own endpoint when unset. |
| `OPENAI_BASE_URL` | Optional. Reaches Together, Fireworks, Groq, Ollama, Gemini's compatibility endpoint, or a LiteLLM sidecar. |

`AGENT_PROVIDER` is required and never inferred from whichever key happens to
be set: `deploy/docker-compose.yml` declares both keys on this service, so
inference would resolve on the order the arms are written in and bill an
account nobody chose. `AGENT_MODEL` has no default for the same class of
reason — a defaulted model id goes stale on the provider's schedule and pins a
price the operator never picked.

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
assembler reads back. Without the history scope the app answers mentions and
remembers nothing.

## Running it

The proxy is not optional, so mint certificates first — one per channel the bot
answers in, plus the CA both processes trust:

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

**A message opens a session too, and does not take its queue.** Ordinary
channel messages are recorded rather than answered, so ingest opens the session
— which is what makes a message in a channel nobody has mentioned the app in
still get stored — and writes straight through. The queue exists to serialize
model turns; a store write is one synchronous statement with nothing to
serialize, and behind the queue a message arriving mid-task would wait out a
whole model turn to be filed. The consequence is deliberate: message traffic
defers eviction, so a chatty channel keeps a warm handle, which is the point of
holding one.

### The team sheet, as this process reads it

Each task resolves its channel's sheet — `$AGENT_CHANNELS_ROOT/<channel
id>/channel.toml` — to a model and the four per-task caps, and runs on those.
`[llm] model` wins over `AGENT_MODEL`; every cap in the schema has a default, so
a channel whose sheet has no `[llm]` block still gets all four. `max_task_seconds`
is seconds in the sheet and milliseconds in the loop, which is the one field that
is a conversion rather than a rename.

The sheet is read once per task, with no cache and no watcher, so an operator's
edit lands on the next mention. And every failure to read one — missing,
unreadable, no longer valid TOML, rejected by the schema — falls back to the
built-in defaults and logs a reason code rather than refusing to run. That is
safe precisely because **what is resolved here is advisory**: the proxy enforces
what a channel may do from its own copy of the same file, and its meter is
authoritative. A fallback here cannot widen anything. The opposite policy would
put an authorization decision on the wrong side of the boundary and take a whole
deployment dark the first time a volume was mounted at the wrong path.

The sheet picks a model id, not a provider. `AGENT_PROVIDER` is the process's,
and a sheet naming a model the configured provider does not serve fails at the
provider like any other outage.

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

Under compose it is the `server` service. That path needs a Dockerfile, which
is #86.

## Shutting down

`SIGTERM` or `SIGINT` aborts every task in flight and closes the socket. A
cancelled task posts nothing: the operator asked for quiet, and an answer
arriving after the socket closed has nowhere to go. A second signal exits
immediately, and exiting with a session's `store.db` still open is safe rather
than merely tolerated: the store runs in WAL with `synchronous = FULL`, so a
committed row survives a hard kill and nothing is buffered waiting for a close.
The cost is at most one answer that was already cancelled, and the one turn each
in-flight task was reporting.
That under-reports rather than over-reports, so the budget fails open, and the
proxy's own tool-call meter is unaffected either way. Draining before exit is
#118, which also has to settle whether a task finishing during the drain gets
to post.

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
  `SlackMessage` becomes a row in its channel's store. Out here rather than
  under `session/` because it names both a Slack type and a session, which is
  the pair the ESLint rule forbids in one file.
- `src/session/types.ts` — what everything below the adapter works in:
  `SessionKey`, `TaskRequest`, `TaskSettings`. No Slack type appears in it, and
  an ESLint rule on `src/session/**` is what keeps that true.
- `src/session/mutex.ts` — one at a time, in arrival order.
- `src/session/registry.ts` — the sessions, and when they are torn down.
- `src/session/sheet.ts` — a channel's team sheet to a model and four caps.
- `src/session/store.ts` — a channel's message store, gated on it having a
  sheet. Symmetric with `sheet.ts`, and total in the same way: it answers `null`
  rather than throwing, because `registry.open` is synchronous and uncaught.
- `src/session/router.ts` — request in, reply out: which session, what it waits
  for, which sheet the task runs on.
- `src/session/task.ts` — one agent task. One proxy tool client and one spend
  client per task, both pinned to the request's channel.
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
