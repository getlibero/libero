# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                          # Node 24+, pnpm 9+
pnpm -r build                         # tsc per package
pnpm typecheck                        # tsc --noEmit per package
pnpm lint                             # eslint . (includes the agent→proxy import ban)
pnpm test                             # vitest run per package
pnpm license-check                    # allowlisted licenses only; fails on copyleft
pnpm boundary-check                   # grep gate: the agent side names no proxy
```

`boundary-check` is not part of `lint` — ESLint sees imports, the grep sees
prose and `package.json` too, and a raw string match belongs in a script rather
than in a rule.

Scoping to one package or test:

```bash
pnpm --filter @getlibero/schema test
pnpm --filter @getlibero/schema exec vitest run src/<file>.test.ts
pnpm --filter @getlibero/schema exec vitest run --exclude '**/dist/**' -t "<test name>"
```

Root scripts are `pnpm -r` fan-outs, so a new workspace package is invisible to
CI until it has a `package.json` with `build`, `typecheck`, and `test` scripts
(use `vitest run --exclude '**/dist/**' --passWithNoTests` while it has no
tests) and a `tsconfig.json` extending `../../tsconfig.base.json`.

**Every `test` script carries `--exclude '**/dist/**'`, and a new one must
too.** Vitest's default excludes are `node_modules` and `.git` only, so without
it each test file is collected twice — once from `src`, once from its compiled
copy — and CI builds before it tests, so `dist` is always there. That doubles
every reported count and keeps running tests that were deleted from `src` until
someone does a clean build. The flag adds to the defaults rather than replacing
them; `node_modules` stays excluded (#107).

## Current state

Early phase 1. `packages/schema` (zod team-sheet schema, shared name
primitives, egress patterns, tool call, spend report, refusal, listing, proxy
error, approval, and audit shapes), `packages/agent`
(provider-agnostic completion layer, ReAct loop with per-task caps),
`packages/proxy` (mTLS listener, per-channel identity, team-sheet enforcement
on both gates, the credential vault, credential injection into outbound HTTP
calls, the redaction pass on the way back, the MCP client over the official SDK
and its per-upstream pool, the daily budget meter over `node:sqlite`, the append-only audit log, and
the approval ticket store),
`apps/proxy-server` (the process composing all of it — a
permitted call is now served rather than answered 501, plus `budget` and
`audit` entrypoints alongside `vault` for the operator),
`packages/gateway` (the Slack Socket Mode adapter — mention in, handler, reply
into the thread, a reconnect ladder the gateway owns rather than the SDK, since
#126 an approval card it can render and a click it can decode, since #176 an
ordinary `message` it normalizes and hands down, and since #66 its own user id
from `auth.test` plus a reply path for a message it was told to answer),
`apps/server` (the gateway + agent process — env parsing, the mention handler,
the message ingest and the follow-up route, lifecycle),
`packages/cli` (placeholder npm release),
`design/` (the design system — plain CSS, no TypeScript), and `site/`
(getlibero.com).
`packages/memory` (the per-channel message store — one SQLite file per channel,
an FTS5 index over it, the delete and edit paths that keep the index in step, and
since #64 a read-only opener the proxy uses). `e2e/` is the security suite's rig
(#131).

**`packages/memory` is a leaf, and an ESLint block on `packages/memory/**` keeps
it one.** It may not import the proxy, the gateway, or the agent, because both
services open these files — the gateway writes every inbound message and, since
#64, the proxy reads one back — so it has to be importable from either side.
`src/log.ts` duplicating a `Logger` interface is the visible cost, and the hazard
it avoids is transitive and now live rather than prospective: a gateway import
would put the Slack SDK into the proxy's image through an edge that exists today. Two things there are
decisions rather than mechanics. **The tokenizer is `porter unicode61
remove_diacritics 2`**, chosen once because it is baked into the index — without
stemming, an AND of the terms in "what did we decide about the vault" does not
match "we decided to ship the vault", which is the first question #64 would ask.
And **`search` takes text, never an FTS5 expression**: MATCH is a query language
where a bare `AND` is a syntax error, a trailing `*` is a prefix query, and
`text:vault` is a column filter that parses and runs, so `toMatchQuery` quotes
every whitespace chunk and is deliberately absent from the barrel.

**#176 fills the store, and its two decisions are the mutex and the root.**
`packages/gateway` gains a third named subscription (`message`), a `toMessage`
beside `toMention` that keeps the **raw** `thread_ts` — `toMention`'s `?? ts` is
picking a reply target and makes top-level and self-threaded indistinguishable —
and a subtype allowlist of *absent*, `thread_broadcast`, and `file_share`, with
`message_changed`/`message_deleted` dropped under their own reason code as
#177's landing site. `apps/server/src/ingest.ts` is the mapping, out beside
`handler.ts` because it names both a Slack type and a `Session`.

**Ingest opens the session and never takes its mutex.** The mutex serializes
model turns; a store write is one synchronous statement with SQLite's own WAL
and busy timeout as the concurrency control, and behind the mutex a message
arriving mid-task would wait out a whole model turn to be filed. It still goes
through `registry.open`, because that is where the handle lives and is released
— the single `entries.delete` in `sweep` now calls `close()`. The consequence is
wanted: message traffic creates sessions and defers eviction, so a chatty
channel keeps a warm handle. `session/store.ts` is the opener and is **total** —
it answers `null` rather than throwing, which is what keeps `open` total, since
`router.ts` calls it outside any `try`.

**`store.db` lives under its own `AGENT_STORE_ROOT`, and that is the security
decision rather than a filing preference.** Both services mount the channels
directory and it is where the proxy reads its authorization from, so an agent
able to write there could rewrite a `channel.toml` — and the proxy re-reads the
sheet per call, which makes that a compromised agent widening its own
permissions. The channels mount stays `:ro` on both services. The cost is that
`packages/memory`'s "No mkdir" argument had to be restated: the directory
existing is no longer the operator's statement that the channel exists, so
`session/store.ts` checks `<channelsRoot>/<channel>/channel.toml` is there
before it creates anything. The rule is unchanged, its justification moved one
layer out, and both comments say so. `architecture.md`'s state-dir diagram was
edited for the same reason, and phase 2's `MEMORY.md` and `skills/` belong on
the writable side of that line too.

**Messages are deduped by the store's `ts` and never enter the gateway's `seen`
set.** `gateway.ts` already argues against two idempotency mechanisms that can
disagree, and the reason `seen` exists — nothing downstream of a mention is
idempotent — does not apply. The store's key is also better: it is the message's
own identity and it survives a restart. Concretely, `seen` is FIFO-bounded at
1000, so message traffic would flush every remembered mention id in seconds.
And **the message path logs nothing on the way through** — not the arrival, not
an ordinary drop. Ids are legal in a log line, but one per message turns stdout
into a record of who spoke in which channel and when.

**#64 closed the store's open question: the proxy reads `store.db` itself.**
`search_channel_history` is served by the proxy through `openMessageReader` —
a second opener in `store-db.ts`, `readOnly`, no DDL, no version stamp, `search`
and `close` and nothing else — under its own `PROXY_STORE_ROOT` pointing at the
directory the gateway writes. The callback branch was rejected on two grounds:
it has no target (there is no `.listen()` anywhere on the agent side, so it means
building the first inbound listener on the process whose compromise the design
survives), and it does not buy what it appears to — the proxy serves every
channel, so the gateway has no independent way to know it is entitled to the one
it names, and a compromised proxy reads everything either way one hop later. The
direct read keeps *one file per channel is the isolation boundary* structural:
the opener closes over one file, there is no `channel` column, no operation takes
a channel id. **The mount is read-write even though every open is read-only** —
a WAL reader creates the `-shm`/`-wal` sidecars, so `:ro` fails at the first
search; the read-only-ness is `{ readOnly: true }`, `openAuditReader`'s posture.
The memory package stays a leaf and the ESLint block stays, now guarding a live
import edge rather than a prospective one.

**The sheet grants it through a new top-level `[[builtin]]`, and the enum is why
that block exists.** `transport = "builtin"` under `[[mcp_server]]` would need
three refinements to stop the sheet expressing nonsense, and the decisive one is
the tool name: under `[[mcp_server.tool]]` it is `ResourceName` for every server
in the file, so a typo parses, lists as permitted, and is refused at dispatch —
a sheet saying a tool is allowed and a proxy saying it is not. `BuiltinEntry`
sits beside `ToolEntry` and is structurally assignable to it, which is what lets
`resolveApproval` and `resolveLimits` take it unchanged. `libero` is the wire
`server` name and is reserved: an `[[mcp_server]]` claiming it is a parse error,
because `decide` matches the name before it consults a transport.

**`Decision` carries a `Target` now, and that is the shape holding "a built-in is
not a bypass".** `{kind:"mcp", upstream}` or `{kind:"builtin", tool}`, both out of
the same `decide`, so the only way to reach a built-in is to have been through
the gate. `decideBuiltin` is the same five steps minus `server_ambiguous` — one
provider, no disagreement possible — calling the *same* `exhaustedLimit`,
`resolveLimits` and `resolveApproval` rather than copies. `createToolDispatcher`
in `dispatch.ts` is the only thing that narrows: `HttpDispatcher` became an
`McpToolDispatcher` taking an `McpServer`, `BuiltinDispatcher` takes a
`BuiltinToolName`, so the arm with the vault and the pool cannot be handed a
built-in and the arm with a path to channel messages cannot be handed an
upstream. It is provisional only when both arms are, because a real built-in
still spends a channel's meter. `catalog` stays the `HttpDispatcher`:
`describe` asks an *upstream*, and a built-in has nobody to ask.

Three things in the executor are decisions. **The reader opens per call** — no
DDL, one statement, cheaper than the audit and meter writes bracketing it — because
a pool costs an eviction policy and open handles across every channel the process
has served, which is worse for the process holding every tool credential.
**Bad arguments are a `ran` result with `isError`, not a refusal**: `ToolRefusal`
is a closed set of governance decisions with no free-text member, and MCP servers
answer the same way. **The result bound drops whole messages** rather than cutting
one — a dropped entry is a short answer that admits it, a cut entry is half a
sentence attributed by name to a real person. An unreadable store rethrows: `server.ts`
writes the `unanswered` row and answers 500, honest where `unavailable` would claim
no built-in exists.

`builtins.ts` is definitions only and `builtin-dispatcher.ts` is the executor,
with `listing-route.ts` newly banned from the second — the
`ToolCatalog`/`ToolDispatcher` split one file over. A built-in's description is
this build's own, so it is the one listing row that cannot arrive thin, and it is
checked against `MAX_TOOL_DESCRIPTION` at module load for #130's reason.
`e2e/src/channel-history.test.ts` is the security half, and its trap is worth
knowing: an assertion against the whole transcript is answered by #67's
`<channel-history>` seed block rather than by the tool, so `toolResults` narrows
to the tool result. That is also the honest account of what the built-in adds —
the assembler seeds the last few messages, the tool reaches the rest.

**#67 reads that store back, and the transcript's shape is the decision.**
`apps/server/src/session/context.ts` turns a channel's recent messages into the
one `user` message a task seeds from, each attributed (`@alice: …`) and each
`<@U…>` resolved through the same cache. Four things there are settled.
**Channel history never goes in the system prompt** — it is third-party text,
and `system` is where the agent's own instructions live; it goes in a marked
block that says it is context rather than instructions. **It is one message and
not a reconstructed dialogue**, because the agent's own replies are not stored
(`postThreadReply` returns nothing, deliberately) so history is one-sided and an
assistant/user alternation would be a lie the model reasons from. **It was the
channel's recent messages, not a thread's** — that was the one #66 reopened; see
below. And **the echo of the ask is excluded on exact `userId` + `text`
equality**, because a mention arrives on both subscriptions and is usually
already a row, with no id to match on.

**Names resolve live and are cached per session**, at the `entries.delete`
`registry.ts` reserved. `session/names.ts` caches the *promise*, not the value —
ingest does not take the session mutex, so two messages from one new author
genuinely overlap — and it caches the miss too, since a departed user has no
name and will not grow one. The seam under `session/**` is
`DisplayNameLookup`, a plain function, because that ESLint block admits no Slack
type; the `UserDirectory` behind it is `web-api.ts`'s, on the same `WebClient`
the posters use, and is wired in `compose.ts`. Ingest also writes the snapshot
into `display_name`, which is a *different question* from the live resolver —
"what were they called then" against "what are they called today" — and is the
only attribution available to #64, which holds no Slack token.

**The bound is two sheet fields and one constant.** `[llm]
max_history_messages` and `max_history_chars` are the channel's, for the reason
the four caps are: they spend its own budget and can widen nothing. The
2,000-character per-message ceiling is the process's, for the reason
`DEFAULT_UPSTREAM_TIMEOUT_MS` is. Nothing in `packages/agent` counts a
transcript's tokens before sending, so without these an oversized seed fails at
the provider rather than at a cap. `packages/memory` gained `recent(limit)` for
this — ordered by `ts` (fixed-width, so lexicographic is chronological; `id` is
arrival order and `at` is a different clock) and returned **oldest-first**.

**#66 answers a thread without a re-mention, and three things there are
decisions.** `TaskRequest` now carries `thread` — an opaque id the router only
ever compares — and `apps/server/src/session/threads.ts` is the per-session set
of threads a task has worked in, with a deadline each.
`apps/server/src/ingest.ts` routes a message through the *same* router the
mention handler uses, so a follow-up queues on the same mutex; `compose.ts`
hoists `createChannelRouter` above `deps.slack(...)` for it, and two routers
would have been two session registries and two mutexes over one channel.

**The window is a sheet field and not a constant.** `[llm]
follow_up_window_seconds` (default 900, `0` off), because whether the agent
answers messages nobody addressed to it is a channel's policy with a per-channel
cost in budget and noise — the `max_history_*` argument verbatim — and because
without a field the only way to switch it off is to unprovision the channel. It
is **bounded at 1800 in the schema**, which is `SESSION_IDLE_MS`: evicting a
session deactivates its threads, so a longer window is one the process cannot
keep, and a sheet naming one is a loud parse error rather than a silent clamp.
Deactivation is TTL and not task completion — completion-only would route
mid-task messages and nothing else, which is not the case anyone wants. The
deadline is computed at **write** time from the settings the task already
resolved, which is what keeps the per-message read path from needing a sheet.

**A mention arrives twice, and the second copy must not become a second task.**
Slack delivers it on `app_mention` *and* `message`, with a different `event_id`
on each, so nothing downstream can dedupe — and the `app_mention` copy activates
the thread, so the `message` copy fires on the *first* mention, not just later
ones. The gateway therefore resolves its own user id with `auth.test` inside
`connectWithRetry`, before the socket, and sets `SlackMessage.mentionsApp`;
`mentionsApp` in `message.ts` **fails closed** — with no id, any `<@…>` token
counts — because losing a follow-up costs a message the user can repeat and
mistaking a mention for one costs two model turns and two replies. Resolving
identity there also makes a bad bot token a startup `auth_rejected` rather than a
reply that never appears. `MessageHandler` now returns a `SlackReply | undefined`
and the gateway posts it to `message.threadTs` and **never `?? ts`**, so the
adapter still cannot start a thread on a message nobody addressed it in. An
answered message logs `follow_up`, not `replied`; nothing else on that path logs.

**History narrowed with it.** `packages/memory` gained `recentInThread(thread,
limit)` — `WHERE ts = ? OR thread_ts = ?`, since a thread is its root plus the
replies naming it — with a `message_thread` index added under
`CREATE INDEX IF NOT EXISTS` and **no schema-version bump**, because an index
changes which rows SQLite visits and never which come back. `context.ts` reads
the thread and falls back to the channel when it is empty, and **the echo filter
runs before that choice**: a top-level ask is its own thread's root, so on the
other order every first question would find one row, take the thread branch, and
seed with nothing.

**The two halves meet for real in `e2e/` (#131, which absorbed #47).** The proxy
runs as its **spawned built entrypoint**; the agent side runs **in-process**
through `createServer` — the same call `apps/server/src/index.ts` makes, which
is why `apps/server/src/compose.ts` exists at all and why the package's
`main`/`exports` point at it rather than at the process module.
`held-call.test.ts` runs on it too, which is what proves the extraction is the
wiring rather than a copy of it.

Three things there are decisions. **What is faked is exactly two things** — the
Slack socket (`createStubSlack`) and the model (a scripted `CompletionClient`) —
and an ESLint block on `e2e/**` enforces it, banning `@slack/*`, the provider
SDKs, and `createCompletionClient`, which is re-exported from `@getlibero/agent`
and would otherwise reach a provider without any file naming one. **The proxy is
the half that had to be spawned**, because the claim is that tool credentials
live only there — with the vault in the agent's own heap, a leak assertion is
about module scope rather than a process boundary. The agent side *cannot* be
spawned: `createSlackSurface` builds the real `SocketModeClient` and `WebClient`,
forwards neither injection seam beneath it, and sets no `slackApiUrl`. And **the
positive control is load-bearing** — every "the credential did not leak"
assertion also passes on a run where none was ever resolved, so a case asserts
the canary *did* arrive at the upstream as `Bearer <canary>` before asserting it
reached nothing else.

`packages/proxy`'s `mcp-fake-server.ts` is exported for this, on `stub-slack.ts`'s
argument. It is the exception to the barrel's "no client, no pool" doctrine
rather than a hole in it: a server holds no vault and can open nothing.
`e2e/` is also the one package the agent/proxy import ban does not cover —
`scripts/boundary-check.sh` does not scan it, and its header says why.
`e2e/README.md` is the harness API. With #135 the suite covers all four of
phase 1's definition-of-done properties, one file each.

**#134 is the budget half, and its shape is the asymmetry between the two
meters.** `e2e/src/exceed-budget.test.ts` puts each at its `>=` boundary — a
loop refused when `daily_tool_calls` is *reached*, a call refused when the turn
that preceded it took `daily_tokens` to the line, which only works because the
loop awaits `onTurn` before dispatching that turn's calls. The narrow claim gets
its own case: an agent reporting nothing still exhausts the count the proxy
keeps itself, while every token counter stays at zero. A replayed turn id is
answered `duplicate` and charged once. And a channel cannot move its spend into
a cheaper bucket — cache reads exhaust the budget at the weight the sheet names,
with the meter storing the raw counts either way. The operator's reset is
exercised by spawning the real `dist/budget.js` against a running proxy, which
is the only way to make "no restart, no signal" a demonstration rather than a
comment.

**#132 is the exfiltration half, and it attacks two paths rather than one.**
`e2e/src/exfiltration.test.ts` runs the credential back through a tool *result*
(the `json-escaped` spelling #149 was about, plus the response headers) and
through a tool *description*, which is the worse leak: upstream-authored text
enters the model's context on every turn, so a reflected credential there leaks
repeatedly. Both are covered by the one scrub in `callUpstream`, which is a
property of today's code rather than a law — so the listing case is re-run with
redaction gutted, the way `redaction-detector.test.ts` does for a tool result.
A third case asks for the credential by name through every listed tool and
asserts the arguments reached the upstream verbatim: the proxy is not a template
engine, and the only place a name becomes a value is `injectCredential`.

**#135 is the approval half, and it is the first place the broker's two ends
meet.** `e2e/src/destructive-call.test.ts` holds a call the *heuristic* caught —
`delete_branch`, with no `approval` in the sheet — and shows the click travelling
Slack interaction → decision route → ticket store → re-submission, with the
approver's Slack id on the `ran` row and three rows sharing one ticket. The four
ways of not having a click each cost the attacker nothing: a deny, an agent that
abandons its wait (the ticket is undecided, so `approval_pending`), an agent that
mutates the arguments after the human looked (`approval_mismatch` on the hash,
and the ticket is not spent), and a model that writes its own approval — a
fabricated `approve_ticket` refused before the proxy, and forged fields in the
arguments that change nothing, because a ticket is read from the request and
never from what the model wrote.

The clock there is one-sided and the file says so: only the agent's scheduler is
injectable, so a true `approval_expired` stays `approvals.test.ts`'s to prove.

**#130 is closed: the proxy calls GitHub for real**, proven live by
`e2e/src/github-live.test.ts` — the ladder, the legacy `2025-11-25` handshake,
the credential, the real catalog, and the call itself. What blocked it for a
while is worth keeping, because it is a hazard rather than a bug: GitHub's tool
schemas annotate `owner` and `repo` with `x-mcp-header`, asking a client to
mirror those argument values into `Mcp-Param-{name}` request headers. That is a
`2026-07-28` feature and GitHub negotiates `2025-11-25` — but it requires the
headers anyway, declining SEP-2243's optional allowance for older clients. The
official SDK mirrors only on a modern connection, which is equally correct. Both
ends are within spec and nothing between them worked, which is why the codec is
**vendored** at `packages/proxy/src/vendor/` and why the headers are derived on
*both* eras rather than only the legacy one: the SDK's mirroring lives in
`callTool`, which this client does not use — a `tools/call` goes out as a raw
`request` so the re-POST recovery has no code path to run on — so its mirroring
never runs. The derived headers ride the SDK's per-message `headers` option.
Filed upstream as `modelcontextprotocol/typescript-sdk#2639`.

**The declarations are scanned from the raw schema, before bounding**, and that
ordering is load-bearing. The bounding rules decide what may enter a *model's*
context — a schema over `MAX_TOOL_SCHEMA_BYTES` or one whose type is not
`object` is dropped and the tool published thin — and none of that bears on
which arguments a server wants in headers. Read off the published schema, a tool
too large to show the model would silently lose its headers and have every call
refused at the far end, with nothing in the log naming why. The cost of the
ordering is that the scan is the one consumer of bytes nothing has bounded, and
the vendored `visit` recurses per nesting level — so `declarationsIn` guards it,
and a schema the scan cannot survive declares nothing, exactly as one it will
not vouch for. Unguarded, the `RangeError` escaped the degrade-to-thin contract
(a 500 for the channel's whole listing), and on the call path was answered "the
call was made and no result came back" with a `ran` audit row for a call never
dispatched — the dispatcher now gives `definitionFor` its own catch for the
same reason.

**What #130 changed most is the docs.**
GitHub's hosted server is `https://api.githubcopilot.com/mcp/`, and
`channels/example/channel.toml` now points at it for real — two blocks, because
**that server's configuration surface is its url path**: `/x/<toolset>` picks a
toolset and a trailing `/readonly` drops every write tool, so one url is one
toolset. The alternative is `X-MCP-Toolsets`/`X-MCP-Readonly`/`X-MCP-Tools`
request headers, and **the sheet gains no field for those**: a headers field is a
place to write a token into the one file whose defining property is that it holds
none, and the path is already reviewed as part of the url.
`site/src/content/docs/docs/github.md` is the walk from `vault.js set` to a `ran`
row, and is in the sidebar under Start here.

**The finding worth keeping is that the approval heuristic barely fires on
GitHub.** `DESTRUCTIVE_VERBS` is delete/drop/transfer/deploy;
`merge_pull_request`, `push_files`, `create_or_update_file`, `issue_write` and
`pull_request_review_write` contain none of them, so they default to running
unreviewed. `delete_file` is the one it catches. That is the heuristic behaving
as designed — it is a default for the entry nobody thought about — but the
starter sheet now says so in a comment and the docs say so in a table, because a
starter that showed only the caught case would teach the wrong lesson.

**And one real bug, which is what a real upstream is for.** `truncate` — now
in `mcp-bounds.ts` — appended its ellipsis *past* the limit, so
`boundedToolDescription` returned 1,025 characters against a
`MAX_TOOL_DESCRIPTION` of 1,024 — the same constant `PermittedTool.description`
parses against, chosen to be one number precisely so the two ends agree. Any
upstream with a description over the line therefore produced a listing the
agent's own `ToolSource` rejected as `malformed_response`, which ends the task
with "the tool proxy could not be reached" rather than costing it a sentence.
GitHub's `pull_request_read` documents nine `method` values inline and is well
past it. The old test asserted `toHaveLength(1025)` and so *encoded* the gap, the
way `audit.test.ts` did for #124.

**Two e2e files, and the split is what CI can hold.**
`e2e/src/github.test.ts` runs #130's three acceptance bullets against the fake
wearing the real server's shape — legacy `initialize` fallback, a session id,
SSE framing, a paged catalog, an over-long description — none of which the
default fake does, which is why it is not a copy of `smoke.test.ts`.
`e2e/src/github-live.test.ts` is the acceptance run itself, against
`api.githubcopilot.com`, skipped unless `LIBERO_GITHUB_PAT` is set. **Its
positive control changes shape and that is the point**: there is no recording
upstream to read a header off, so the control is that GitHub answered with data
an anonymous caller cannot get — a merged pull request's title, which the
request did not carry. `RigOptions.credentials` plants the token and is the one
documented exception to `harness/vault.ts`'s plant-a-canary rule;
`expectNoSecret` generalises `expectNoCanary` and **masks the value in its own
failure message**, which is free for a canary that lives in source and is the
whole point for a real token.

**The agent calls tools, through the proxy and only through it.**
`packages/agent/src/proxy/` is the client (#109): an mTLS transport over
`node:https`, `ToolSource` over `GET /v1/tools`, `ToolExecutor` over
`POST /v1/tools/call`. `apps/server` composes gateway + loop + transport, so
`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `PROXY_URL`, `PROXY_TLS_CA`,
`PROXY_CLIENT_CERT_DIR`, `AGENT_PROVIDER`, `AGENT_MODEL`, `AGENT_CHANNELS_ROOT`,
`AGENT_STORE_ROOT`, and the provider key are all live and all required — there
is no toolless fallback. `apps/server/README.md` has the environment contract.

**Mentions in one channel queue rather than interleave, and each task runs on
its channel's sheet.** `apps/server/src/session/` is the channel router (#65):
one session per `(workspace, channel)`, a mutex per session, and a per-task read
of `$AGENT_CHANNELS_ROOT/<channel>/channel.toml` resolving `[llm]` to a model
and the four `AgentLoopCaps`. Sessions are evicted after 30 minutes idle and
never while busy; there is no cache and no watcher, so an edit lands on the next
mention.

Two things there are load-bearing. **The router never learns what Slack is** —
it takes a `TaskRequest`, `handler.ts` is the short mapping that builds one
from a `SlackMention` and `ingest.ts` the one that builds one from a
`SlackMessage` (#66), and an ESLint block on `apps/server/src/session/**`
allows only logging names (`Logger` and friends) through from the gateway
package. That is what a second front-end
plugs into, and it is enforced rather than asserted. And **what the sheet
resolves to here is advisory**: every read failure falls back to
`DEFAULT_AGENT_LOOP_CAPS` and logs a reason code rather than refusing to run,
which is only safe because the proxy enforces the same file from its own copy
and its meter is authoritative. A fallback on this side cannot widen anything.

Two things about that client are load-bearing rather than incidental. **The flat
name a model calls is decoded to a (server, tool) pair by a map built from the
listing, never by parsing the name** — `ResourceName` permits dots and
underscores, so any separator is ambiguous, and a name the proxy did not publish
has no pair to become. And **a name is chosen from `server` and `tool` alone**,
which is what keeps names stable across sessions now that a listing carries more
than the sheet: an upstream that reorders its catalog changes a description, not
a name.

A name with no pair is refused without sending anything, and since #170 the
client *reports* that through an optional `onUnmappedCall` — the only record of
it, since the proxy never saw the call and rightly writes no audit row.
`apps/server` turns it into a `warn`/`tool_not_permitted` line, which is where a
model enumerating tool names becomes visible to an operator. It is a callback
rather than a logger because `packages/agent` has no way to log and should not
gain one — `proxy/spend.ts` argues that for the sibling client, and it is why
`spend_reported` is a word in `apps/server` rather than in the client that
provokes it. The name is model-authored text, so it travels as a value and
`LogFields.tool` is the one field in that vocabulary this system did not write.

**The listing carries real tool definitions (#129).** `GET /v1/tools` asks each
upstream the channel's sheet names for its `tools/list`, keeps the entries the
sheet named, and publishes an optional `description` and `inputSchema` beside
the approval. `packages/proxy/src/listing-route.ts` is the route,
`mcp-catalog.ts` the walk and the cache; `enforce.permittedToolSources` is
`permittedTools` plus the block that carries each tool, from the same expression
`decide` uses, so the two cannot disagree about where a call goes.

Four things there are decisions. **The sheet decides what is listed and the
upstream only describes** — the merge iterates the sheet's entries and looks
each up by name, so a catalog naming a tool the sheet does not has no row to
attach to; the intersection is the loop's shape rather than a filter. **Every
way of not getting an answer degrades to the sheet's own entry** — stdio,
missing credential, ambiguous blocks, a dead or slow upstream, bytes that are
not MCP — because the listing is not the enforcement and a missing schema costs
the model accuracy, never the channel a permission. The single exception is a
`RedactionError`, which is this proxy unable to hold its own boundary rather
than an upstream failing, so it propagates and the route uses `Promise.all`
rather than `allSettled`. **The route holds `ToolCatalog` and nothing wider** —
one seam that can describe, a separate one that can run, both filled by the
dispatcher object because that is still the only thing holding a vault and a
pool; an ESLint block on `listing-route.ts` bans the vault, the pool, the
client, and the outbound sender. `definitionFor`, which #188 added for the call
path, is deliberately on the *concrete* catalog type rather than on that seam,
so the listing route still structurally cannot feed a call. And **upstream descriptions and schemas are
third-party text entering the model's context every turn** — the tool-poisoning
surface. Nothing reads them, because a rule that read a description is a rule
the upstream phrases around; the caps (1024-character descriptions, 8KB
schemas, 100 tools, 5 pages, a 5s budget per upstream) bound the blast radius
and are not a mitigation. The sheet naming the server is what accepts it.

A schema must be a JSON object saying `type: "object"` or it is dropped and the
entry stays thin, and that rule is load-bearing rather than fussy:
`packages/agent` casts it straight into the provider's tool definition, and a
provider answering 400 fails the whole turn rather than the one tool.

**#188 rekeyed that cache onto the upstream, and the reason is the call path.**
It was keyed by `(upstream, exact sorted wanted-set)`, which made it a cache of
*answers to one question* rather than of a catalog — right while the only caller
was the listing route, wrong the moment a call wants one tool's `x-mcp-header`
declarations, because a one-name question is a different key and so a guaranteed
miss: a five-page walk under a five-second budget, per call, against an upstream
walked seconds ago. The key is now `upstreamKey` alone and the entry holds
per-name resolutions, where `published: null` means *walked and confirmed
absent* — a different fact from not-yet-asked, and one that has to be storable or
a sheet naming a tool the upstream does not offer re-walks it forever. Freshness
is per name because a walk is per name.

The old key protected something real and it survives. Its hazard — two channels
naming one server with different tool lists reading each other's answer — was
about sharing a *conclusion* drawn under someone else's question; per-name facts
cannot disagree, since a catalog is the server's and `upstreamKey` already
separates credentials. What did have to change is that **`MAX_DESCRIBED_TOOLS`
became a budget the caller subtracts from — and a cap `assemble` applies**: the
cap bounds what enters a model's context and definitions are re-sent every turn,
so it has to hold across the *answer* rather than across one walk, or a caller
asking for thirty names and then for all of them carries thirty remembered plus
a fresh hundred. The budget alone was not enough, because resolutions merge
across *questions* too: two narrow asks can together settle more names than the
cap, and a later wide ask finds everything fresh and walks nothing — so the
bound is applied where every path returns, in the sheet's order, making what
survives the cut the operator's priority rather than the upstream's.

**#151 bounds a response, and the decision is that there are two bounds owned by
two different principals.** Those listing caps bound what reaches the *model*;
nothing bounded what the proxy *buffered*, so a 50MB answer was read to
completion, scanned by fifteen redaction needles, parsed, and charged to a
channel. The split is **who owns the resource each spends**, and it is the
`max_history_chars` argument applied twice with opposite answers.

**The wire bound is the deployment's**: `PROXY_MAX_RESPONSE_BYTES` (4 MiB
default, `DEFAULT_UPSTREAM_RESPONSE_BYTES` in `outbound.ts`), reaching the client
through `McpClientOptions` and never through a sheet. It buys memory in a process
every channel shares, so a sheet able to raise it would be one channel degrading
service for all of them — but it is not a constant either, on
`PROXY_HOST`'s argument: the operator who sized the container is the one who
should say how much of it a response may occupy. **No ceiling**, because that
operator is the principal who owns the heap; an earlier draft put this field in
the sheet with a schema `.max()`, and taking it out of the sheet is what made the
ceiling unnecessary. `MAX_CONTROL_BODY_BYTES` (64 KiB) covers the handshake and
the `DELETE`, which nobody reads at length.

**The result bound is the channel's**: `[llm] max_result_chars` (32,768), with a
per-tool override on `[[mcp_server.tool]]` resolved most-restrictive-wins by
`resolveLimits`, beside `resolveApproval` and on its argument. It is charged
against `max_tokens_per_task`, so it spends the channel's own budget and can
widen nothing. It travels per call on `Decision.limits` — *not* on the client —
because two channels share a pooled client and must not share each other's
bounds; `mcp-pool.ts`'s header says so, since moving it there is the obvious
wrong edit. A redeemed approval ticket therefore runs under the live sheet's
bound rather than the one current when the human clicked, which is `upstream`'s
freshness and is wanted.

Three things there are settled. **Overflow is a return value, not a throw** —
`readBoundedText` answers `null` and `callUpstream` throws
`UpstreamError("too_large")` *outside* the transport catch, because that catch
reads `error.name` and would have reclassified a thrown `UpstreamError` as
`unreachable`, deleting the feature while every "the call failed" test kept
passing. **A `tools/list` past the bound is refused rather than truncated**: a
cut tool result is a short answer that admits it, but half a JSON-RPC envelope is
unparseable, so an oversized listing takes the path a malformed one already takes
and `mcp-catalog.ts` needed no change at all. And **`result_bytes` is the
post-truncation length**, which is what that column is for — it correlates with
the next turn's input tokens, driven by what the model was handed. The original
size survives in the notice the model reads, so no column was added.
`failureText`'s `default:` does **not** force a case for a new `McpFailure`
member and silently claims "no result came back"; `too_large` and `closed` each
have one because both clauses were false for them.

**The proxy speaks MCP through `@modelcontextprotocol/client` 2.0.0 (#128, then
#185/#188).** `mcp-client.ts` is one upstream's client and the **only module
that may import the SDK**; `mcp-bounds.ts` is what an upstream is allowed to say
and how much of it; `mcp-pool.ts` keys one client per `(transport, url,
credential)` triple — the same `upstreamKey` enforcement compares, exported
rather than restated so the two cannot drift. The confinement is enforced three
ways, because `no-restricted-imports` is *replaced* by the last ESLint block that
matches a file rather than merged into it: the ban is restated in every block, a
`boundary-check` grep catches a `package.json` edge on the agent side before any
import exists, and a test in `outbound.test.ts` matches the import form.

The client was hand-rolled until #188. Its stated reason was custody — the
belief that the SDK's transport owned its own `fetch`, so the credential would be
revealed outside `callUpstream`. #130 established that is false
(`fetch?: FetchLike`, used for every request including the auth paths), and the
stated cost model was wrong by construction: the spec watch meant to bound it
triggered on revision tags, and the gap #130 hit — `x-mcp-header`, which GitHub
enforces at `2025-11-25` — is within-revision, so the watch structurally could
not have fired and reported green throughout. What tipped the decision was the
recurring costs: OAuth is wanted near-term and the spec keeps moving.

**Custody survives adoption, and the argument is one line**: the SDK reaches the
network only through the `fetch` it is handed, and that is
`createGuardedFetch` — so the credential is revealed in one function, attached
last, and every byte the SDK sees has already been through the one scrub. The
e2e suite is what makes that checkable rather than asserted.

**What the adapter owns is the translation, under one rule**: from an SDK error
it reads the class and the numeric code and *never* a message — except
`http_error`'s detail, which was always upstream text and was always scrubbed on
the way in. That is what keeps "`connect_failed` relays no upstream bytes" a
property of the code rather than a hope about someone else's error-message
discipline.

**Five options invert an SDK default** and each would fail quietly if dropped, so
each has a test that fails without it: `versionNegotiation: { mode: "auto" }`
(the SDK defaults to the legacy handshake with no probe),
`inputRequired: { autoFulfill: false }` (it defaults to **on**, which would let
an upstream drive elicitation and sampling from inside an ordinary `tools/call`),
`supportedProtocolVersions` (the SDK's own list reaches back to `2024-11-05` and
`2024-10-07`, the HTTP+SSE revisions whose results arrive on the GET stream the
guarded fetch answers 405 — accepting that handshake makes every call a
thirty-second timeout with a wrong word at the end),
`reconnectionOptions.maxRetries: 0`, and no `authProvider` — without one the
OAuth paths are unreachable rather than merely unused. A `tools/call` goes out
as a raw `request` against a permissive envelope rather than through `callTool`,
and both halves are wanted: the header-mismatch recovery that would re-POST an
identical call has no code path to run on, and the specification's closed
content union does not fail a whole call over one forward-revision block —
`blockText`'s placeholder branch stays reachable on the legacy era. The same
envelope argument puts `nextCursor` on `z.unknown()`: serializers that spell an
absent field `null` are commonplace, and the cursor's reading is
`parseToolsList`'s.

**Two things the SDK swallows on the connect path but propagates on the call
path**, which is why the guarded fetch records what it refused where `connect`
can read it. Without that, an unreachable host, an oversized handshake and a
refused destination all collapse into "could not agree a version" — and a
`RedactionError` stops failing closed, degrading from a constant 500 into a
cheerful error result. The phase flag on the same holder is what restores
`MAX_CONTROL_BODY_BYTES`: a `fetch` has no call sites to choose a bound at, so
the connection answers per request instead — except the termination `DELETE`,
which is bounded **by its verb**, because the flag is shared with every
in-flight call on the session and a `close()` that flipped it would cut a
legitimate answer off mid-read as `too_large`.

**Three behaviours the adapter had to rebuild rather than inherit**, found by
review of the stack. The guarded fetch forwards `init.signal` into
`callUpstream`, joined with the timeout via `AbortSignal.any` — the SDK cancels
through the signal it hands its fetch (its per-request timeout,
`transport.close()`, the termination racing shutdown), and dropping it left
every such abort settling a promise while the socket ran to the full 30s,
holding the event loop past `docker stop`'s SIGKILL window. `ensureOpen`
consults `reopening`, because a session-loss reopen clears `session` before its
handshake resolves and a fresh call arriving in that window would start a
second full ladder, orphaning the loser's session at the upstream. And
`failureText` has an `unauthorized` case on the *call* branch too — a revoked
token surfaces as a 401 to the reopen's re-initialize, where the default's
"the call was made" is false in both clauses.

**`McpFailure` gained `unauthorized`** because the SDK settles the protocol in
one round trip and treats a 401 there as final. Telling an operator their server
speaks the wrong MCP revision when their token expired is the most expensive
wrong word in `failureText`.

**One property narrowed, and it is a decision on the record rather than a
regression to find later.** The rule that an unreadable *entry* is skipped while
only an unreadable *page* is refused survives on the legacy era — the client asks
for a page against a permissive schema precisely to keep it — but not on
`2026-07-28`, where the SDK validates against the specification before any
caller-supplied schema and one non-conforming entry fails the whole page. There
is no relaxation flag and the rejected bytes never reach us. What is lost is
graceful degradation, **not a permission**: the listing still names every tool
the sheet allows and the sheet is still enforced on the call. Every upstream in
production negotiates legacy. `mcp-catalog.test.ts` pins both halves.

**`.github/workflows/mcp-spec-watch.yml` is retired rather than repointed**, and
the argument is the one above turned around: its only mechanism was grepping
`MCP_PROTOCOL_VERSION` out of the wire-format module #188 deleted, and pointing
it at SDK releases would reimplement Renovate badly. What replaces it is
a review obligation rather than a job: an `@modelcontextprotocol/*` bump lands
inside the process that holds every tool credential, so it is a security review,
and it has to answer the two questions a version diff does not — whether anything
new lets an upstream ask the client to act on a channel's behalf (the
`input_required` shape, a refusal decision before it is an implementation one),
and whether the servers this deployment talks to speak the revision yet.
`packages/proxy/README.md` carries that obligation where an implementer will
meet it.

The evidence behind the decision — the 13-package dependency audit, the
`FetchLike` spike, and the pool-isolation answer — is the recommendation comment
on #185.

**`packages/proxy/src/vendor/` is the one place third-party source is copied
rather than depended on**, and its README states the rule: a copy, not a fork.
`license-check` walks `package.json` trees and cannot see a copied file, so
attribution is kept by review — which is why each vendored file names its source
repository, its exact commit, the release it corresponds to, and what was
removed. Every vendored file also needs a test that fails when upstream's
behaviour changes, since a version bump does not touch a copy.

Two behaviours are decisions rather than mechanics. **A server naming no
version we speak fails closed** with no `tools/call` sent, rather than being
spoken to at a version it never agreed to. **An `input_required` result is
refused** — MRTR replaced server-initiated sampling and elicitation, so an
upstream can now ask the client to act for a channel from inside an ordinary
`tools/call`, and answering would spend that channel's model budget on an
upstream's say-so with no sheet entry and no click. And **almost nothing is ever
retried**: `2026-07-28` removed stream resumability, and replaying a
`tools/call` is how one write becomes two. The single exception is #150's, and
it is argued below rather than assumed.

A discovery failure relays no upstream bytes, and that is a type rather than a
convention — `McpOutcome`'s `connect_failed` member has no `detail` field to put
them in, because a failed handshake is as likely to be answered by an auth
proxy's error page as by anything MCP.

**The client also speaks the older protocol, and picks by ladder rather than by
configuration (#150).** `server/discover` first; if the server *answers* with a
refusal — a JSON-RPC error of any code, or any HTTP status — the legacy
`initialize` + `notifications/initialized` handshake is attempted exactly once,
and the result is cached for the client's life. `SUPPORTED_PROTOCOL_VERSIONS`
covers `2026-07-28` and the three streamable-HTTP revisions below it;
`2024-11-05` is excluded because its transport is the two-endpoint HTTP+SSE
pair, and an `[[mcp_server]]` block holds one url.

Four things there are load-bearing. **The fallback is not classified by error
code** — an old server refuses `server/discover` with whatever its framework
does to an unrouted method, so the attempt is the discriminator; but a
*transport* failure short-circuits with no fallback, because nothing answered
and there is therefore nothing to fall back from. **The version on the wire is
the negotiated one, never the pinned constant** — a server receiving an
`MCP-Protocol-Version` it did not agree to MUST answer 400, so the old
hardcoded header would have had every legacy call refused. **One signal is
replayed and only one**: a 404 answering a request that carried a session id,
because that 404 is generated before the server dispatches, so the tool did not
run. A 404 from a client carrying no session is a wrong url and stays an
`http_error`. At most one re-initialize per call, bounded by the structure —
two statements, no loop and no counter — and a generation check plus a single
flight make N concurrent losses cost one handshake rather than N. And
**`negotiatedVersion` reads `STATELESS_PROTOCOL_VERSIONS`, not the union**:
agreeing to a legacy revision over the sessionless probe would mean sending a
`tools/call` with no session to a server that requires one.

`callUpstream` takes a closed `"POST" | "DELETE"` union so shutdown can
terminate a session, both verbs sharing the identical redirect, timeout and
redaction path. `mcp-session-id` joins `content-type` on the readable-response
allowlist — the handshake has nowhere else to learn a session — and it is safe
because every member goes through the same scrub before the one return, so an
upstream answering with the credential as its session id gets a marker replayed
at it. The value is validated against the spec's own character set before it is
written back out, since a CR or LF in it would be request smuggling on the one
path that carries a credential.

**Both services have images and `docker compose up` runs (#86), and three
things about them are decisions.** `apps/*/Dockerfile` are multi-stage over the
whole workspace — `context: ..`, because the pnpm workspace is what installs,
not one package. The final stage is `pnpm deploy --prod`'s output, which
resolves `workspace:*` into a real node_modules and drops devDependencies.

**It honours each package's `files` field, which is why the shipped packages
declare `["dist"]`** — without it the TypeScript sources are copied in beside
the JavaScript built from them. What `files` cannot exclude is what tsc emits
*into* dist: the compiled tests, the declarations and the source maps. Those are
stripped by one `find` in the builder rather than by giving each package a
second tsconfig, which keeps tests inside `pnpm typecheck` and covers a package
added later without that package remembering anything. The tests are the ones
that matter — the proxy's test tree carries a fake MCP server and canary
credentials, and none of that belongs in the process that holds the vault. The
strip is scoped by `-path` to what this workspace built; a dependency is left as
its publisher shipped it.

**The mount points are created in the image, owned by the runtime user, and
that is load-bearing rather than tidy.** Docker seeds an empty named volume from
the image's directory at that path, ownership included — so without
`/data/{vault,budget,audit}` and `/data/store` existing as `node`, the volumes
arrive owned by root and a non-root service cannot open its vault or write its
meter. **Neither image sets an ENTRYPOINT**, so the operator's documented
commands are the whole command line: an `ENTRYPOINT ["node"]` would silently
make `docker compose run --rm proxy node dist/vault.js set <name>` into `node
node dist/...`. Node is PID 1 because both entrypoints install SIGTERM and
SIGINT handlers, so an init shim would add a process without adding a signal.

**`.dockerignore` is an allowlist, and that is this repository's shape rather
than a habit.** The build context is the repository root, which is also where
`deploy/certs/` (the CA key and every channel's client key), `deploy/vault/` and
`.env` live. Denying by default means the next directory of deployment state is
excluded the day it is created rather than the day someone remembers. The cost
is that a new workspace package must be named there and in each Dockerfile's
manifest-copy block; it fails loudly, because `--frozen-lockfile` cannot
reconcile against a manifest that is not there.

The `images` job in `.github/workflows/ci.yml` builds through the compose file
and then asserts the properties above against the built images — non-root, no
source, no compiled tests, no toolchain — on `boundary-check`'s argument that a
multi-stage build and a `--prod` prune are each one edit away from silently
shipping the workspace whole. It supplies placeholder values for the two `:?`
guards because compose interpolates the whole file before it builds;
`.env.example` cannot serve, since it ships `PROXY_VAULT_KEY` empty, which is
what `:?` rejects.

**`daily_tokens` meters for real, and per turn.**
`packages/agent/src/proxy/spend.ts` reports four raw token counts to
`POST /v1/spend` (#110), and the loop's `onTurn` hook fires one after every
model turn rather than one when the task ends (#115). Per turn is the
load-bearing part: a task-end report means a long task spends its whole cost
before the meter hears any of it, so a channel over its cap is refused starting
with the next mention rather than this task's next tool call — and a task that
dies mid-flight spends silently, because `runAgentTask` rejects and everything
counted so far goes with the rejection.

The turn id is `<task>.<n>`, so each turn is its own idempotency key and a retry
is a `duplicate` rather than a double charge. The counts are the provider's
response envelope's, so the report holds against a prompt-injected model and not
against a compromised agent process — the narrower claim is the true one, as
with tool credentials. Weighting stays the proxy's, from `[budget]
cache_read_weight` and `cache_write_weight`, which is why four numbers go over
the wire and never a total. A meter that refuses or cannot be reached costs a
`spend_report_failed` log line and never a user's answer, and
`loop/caps.ts:totalTokens` stays as defence in depth rather than as a stand-in.

**`onTurn` must not throw**, and nothing catches it: the loop awaits it and
would propagate a rejection, which would end the task and lose a reply because a
counter could not be written. `apps/server`'s `reportSpend` is total, and the
contract is argued in `loop/types.ts` rather than defended in `loop.ts` — this
file has no way to log, so catching would make the failure vanish instead.

One gap remains, deliberate rather than overlooked: a report still in flight
when the process exits is lost, since neither `gateway.stop()` nor the task
abort drains one (#118, parked). At most one turn per task in flight, and it
under-reports, so the budget fails open. It is a shutdown issue rather than a
metering one — a drain also decides whether a task finishing during shutdown
posts its answer, which today it deliberately does not.

**#99 is the soft limit, and its two decisions are the sheet field and the
delivery path.** `[budget] warn_at` is a **fraction** of each hard limit, not a
pair of absolute soft values: the contradiction then has nowhere to live — a
soft limit above the hard one it belongs to is unsayable rather than validated,
which is why the field needs no cross-field refinement — and a fraction follows
an edit to `daily_tokens` where an absolute pair goes stale silently. `1` is
excluded because a warning delivered at the moment the meter is spent is the
refusal said twice; `0` is off, `follow_up_window_seconds`'s spelling.
`crossedThreshold` sits beside `exhaustedLimit` and runs **after** it, which is
the acceptance criterion rather than a preference: a channel crossing both in one
call is refused, and a refusal carries no warning.

Three things follow from where it rides. **`Decision.warning` is on `allow`
*and* `hold`** — an approved call is served from a `hold`, so a warning only on
`allow` would be one no approved call ever carried — and it is `BudgetWarning |
null` rather than optional, so a server composing an answer has to say what it
did with it. **The claim is durable and belongs to the meter**: `budget_warning
(channel, day, budget_limit)` with `claimWarning`'s `ON CONFLICT DO NOTHING`,
which is what makes "once a day" hold under concurrency, per *limit* because two
limits are two facts, and cleared by `clearDay` so an operator's reset re-arms
it. **No `BUDGET_SCHEMA_VERSION` bump**, on the argument that added
`message_thread` without one: that stamp guards the shape of the *counters*, and
this table holds none — a build without it reads and writes every number
identically and simply never warns. And **the claim is taken on the `ran` branch
of the dispatch switch**, not beside `recordToolCall`: a call that came back
`refused` or `unavailable` has nowhere to put a notice, and claiming earlier
would burn the channel's one warning on an answer that cannot carry it.

**The warning rides the task's reply, and that is a boundary rather than a
preference.** `SlackSurface` deliberately withholds `postThreadReply` from the
composing app — cards are the exception because a card's lifetime outlives the
handler that raised it, and a notice's does not — so posting it where it happens
would have meant carving a second exception. Instead `onBudgetWarning` reports it
out of `packages/agent` (`onUnmappedCall`'s pattern, and it must not throw for
the same reason), `session/task.ts` holds the first one, and `replyFor` appends
`budgetWarningMessage` after the cap note. The cost is stated rather than hidden:
a task ending on `cancelled` posts nothing, so that day's claim is spent unseen.
**The model is never shown it** — the remedy is a larger number in the sheet,
which is not a lever a model has, and a sentence in a tool result would be
re-sent as context every later turn.

**A held call now mints a ticket, and only the proxy half exists.**
`packages/proxy/src/approvals.ts` is the ticket store and `approvals-route.ts`
is `POST /v1/approvals` (#125). The shapes are in `packages/schema/src/approval.ts`.
A ticket authorizes one call — one server, one tool, one argument hash — once,
in one channel, for fifteen minutes, and an approved call runs by
**re-submission**: the client re-sends the call carrying the ticket and the
proxy serves it only on a byte-for-byte match.

Two things there are load-bearing. **A ticket is not a permission**: the sheet
is enforced when it is minted and again at redemption, from the live sheet, so
an operator's edit during the hold beats a click that preceded it and an
approval can never widen what a channel may call. A sheet refusal deliberately
does not spend the ticket. And **channel scoping is the map's shape** — tickets
are keyed by channel then id, so a lookup cannot reach another channel's, which
is why a foreign ticket and a nonexistent one are one answer rather than two
made to look alike.

The trust claim is the `daily_tokens` one again, and the docs say it that way:
the click is observed by gateway code rather than produced by a model, so
approver identity holds against a **prompt-injected model** and not against a
**compromised agent process**, which relays it. Tool credentials survive process
compromise; approvals survive prompt injection.

**#127 joined the two ends: a held call now raises a card and a click runs
it.** `packages/agent/src/proxy/tools.ts` takes an optional `HeldCallPrompter`;
with one, a hold is waited out and the identical call re-submitted with the
ticket — **on every wait outcome**, approve, deny, expiry, even a prompter
failure, because the proxy answers a re-submission with either the result or
the precise refusal (`approval_denied`, `approval_expired`,
`approval_pending`, …) and is the authority on what the call became. One code
path, and the proxy gets to observe expiries for the audit log. The model sees
one tool result either way and never the ticket id. Without a prompter — any
front-end with no one to ask — a hold degrades to the old refusal-shaped
result.

`apps/server/src/approvals/` is the client half of the broker: `registry.ts`
(pending waits, process-scoped map, task-scoped entries), `prompter.ts` (posts
the amber card, repaints it terminal, resolves the wait), and `decisions.ts`
(click → `POST /v1/approvals` → settle with what the proxy said, never with
what was clicked; unknown-ticket and wrong-channel clicks are dropped before
the proxy is asked). The mention's channel and thread are captured in
`handler.ts`, so what crosses into the router is a closure typed by the agent
package — the session ESLint block is untouched. `held-call.test.ts` is the
acceptance suite, against stub Slack and a manual clock.

Two behaviours there are settled, not incidental. **The task closes its own
card**: every exit — click, ticket deadline, wall-cap abort, shutdown —
repaints the card to a terminal state before the wait resolves, so a card
never outlives its wait; a repaint that fails fails safe, because a stale
amber card's clicks find no registry entry and the proxy answers from its own
ticket state regardless. And **the hold spends the task's wall clock by
design**, which under default caps (5-minute wall clock, 15-minute ticket)
means the wall cap usually beats the ticket's deadline: the card goes red, the
task ends on `wall_time_cap`, and an operator who wants longer holds sizes the
channel's `[llm]` caps for it in the sheet. The wait's deadline is the wire's
`expiresAt` on the proxy's clock — skew is relayed, not corrected.

**#143 made green mean the call ran, and #68 put a checklist beside it. They
share one decision: `SlackCard.color` is optional now.** The design system's
vocabulary is three — green allowed and executed, amber a human who still has to
click, red blocked — and the spec is locked. A checklist mid-task and an approved
call whose re-submission has not answered are none of the three, so rather than a
fourth colour or a widened amber (which would make the one colour meaning *click
this* also mean *nothing to do*), those states carry **no** colour and Slack
draws its own default border. That reads as *not a status yet*, and it is only
safe because the card was already required to be legible with no colour at all.

**#143's mechanism is a second phase on the prompter.** `HeldCallPrompter` may
resolve to a `HeldCallCompletion`, which `tools.ts` calls with the
re-submission's outcome; a prompter returning nothing behaves exactly as #127's,
and the **model-facing results are unchanged in every case**. Three faces were
added, and the third is the one worth keeping: `running` (uncoloured), `refused`
(red, naming the approver and relaying the proxy's own sentence — their decision
*was* carried out and something after it stopped the call, which is a different
fact from `denied`), and `unanswered` (uncoloured) for a task that ended with the
re-submission in flight. `unanswered` is the audit log's word (#124) and its
argument: the call was dispatched and may have run, so say only what is known.
Without it, an approve on a task that then hits its wall clock left a card
reading "the call is running" forever — the lie in the other direction. The three
prompter tests that failed had *encoded* the gap, the way `audit.test.ts` did.

**#68's two decisions are when the card appears and how edits are bounded.** It
is posted on the **first tool call**, not at task start, so a task that answers
from what the model knows still produces one message — which is also why it needs
no sheet field to switch off. And edits are coalesced against a one-second floor
(`MIN_EDIT_INTERVAL_MS`, the process's number on `DEFAULT_UPSTREAM_TIMEOUT_MS`'s
argument: it exists to stay inside Slack's rate limits, which belong to the app
rather than to any channel). The mechanism is a serialized write chain plus that
floor, and a write renders whatever is true *when it runs* — so a burst landing
during one write is covered by the next, and N steps never cost N writes. The
terminal write skips the floor and is awaited, because it is the state a reader
is left looking at.

Three smaller things there are settled. **The loop reports tool calls and
nothing else** — `onToolCall`, synchronous and *not* awaited, which is the
opposite of `onTurn` and deliberate: its consumer edits a Slack message, and
awaiting that would put a round trip between every tool call and the next. A
task's ending is its `AgentTaskResult`, which the caller already has, and the
case where the loop *throws* has no result at all and is exactly the one a
checklist must still close — so `session/task.ts` closes it in a `finally`, from
an `ending` initialized to `failed`. **The row shows the flat name the model
called**, not the `(server, tool)` pair the approval card shows: only the tool
client holds that mapping, and the flat name is the better one anyway, since a
name decoding to no tool still gets a row (#170). It is model-authored text and
is escaped by the renderer. And **`deps.scheduler` deliberately does not reach
the checklist** — that scheduler is the approval deadline's, and a test firing
the next pending timer to expire a ticket must not find an edit floor in the
queue instead, which is the rule `compose.ts` already stated for the gateway's
reconnect ladder.

Both are why `e2e/`'s `approvalCardOf` exists: a thread that holds a call now has
two cards in it, and which is first is a race.

Three decisions on the gateway side are settled and should not be
re-litigated. **The gateway holds no clock** — it renders `expired` when told to
and never on its own, because the deadline belongs to the layer already awaiting
the decision (#127), and a pending-promise map here would need a timeout, which
is a lifetime this package is not allowed to grow. **The verdict is never
parsed**: it travels in the `action_id` and is recovered by a two-entry table
lookup, the ticket travels in the button's `value`, and a packed id would need a
separator that `ApprovalTicketId` permits inside itself. And **`response_url` is
never read** — it is a URL with a secret in it, in a package whose rule is that
no field of any type holds a token; cards are edited with `chat.update` on the
bot token. The card's colours are the design system's dark tokens as hex, drawn
as an attachment's left border, and every state also names itself in text so the
card is correct with no colour at all.

Tickets are in memory, so a proxy restart drops pending approvals and they
degrade to expiry. `audit.db` is at schema version 3, and its vocabulary carries
`approved`, `denied`, and `expired` plus a `ticket` column joining an approval's
rows (#125), and `unanswered` (#124).

**#124 makes "every decided call leaves exactly one row" total, and the two
decisions are the word and where the catch opens.** The row was written after
dispatch — the only place `result_bytes` exists — so anything throwing between
the meter write and it escaped to the outer handler's catch, which holds no
per-call state, and left a metered and possibly-executed call unrecorded. A
`RedactionError` on the result's way back was the live path, and the test that
covered it *encoded* the gap. The fix is a `try`/`catch` **inside `callTool`**,
opening after the `audit` closure's `const` — coverage is identical to opening
at the decision, and opening earlier would let the catch reach `audit` in its
TDZ and mask the real failure — and rethrowing, so the 500 is byte-for-byte
unchanged.

**The word is `unanswered`, and `failed` was rejected on a test that already
existed.** `audit.test.ts` asserts the vocabulary refuses `"failed"` and
`"error"`, under "including the tool's own error flag", because
`outcome` is not a success/failure flag — `resultIsError` is the separate
question. `unanswered` also says only what is known: it asserts nothing about
whether the upstream acted, so `ran` undercounts upstream effects by exactly
these rows.

**The one-row guard is a flag set on *entry* to the `audit` closure, not on
success**, and that is a correctness requirement rather than a preference:
`append` can succeed and the closure still throw afterwards, since `logger.log`
writes to a stream and can fail on EPIPE — a success flag would then file a
second row for a call that already has one. Entry is safe because the closure is
called at most once per request: every call site is followed by a `return` in a
mutually exclusive branch. The fallback append is itself wrapped and its throw
swallowed, the only swallow in the file, because `audit_write_failed` is already
logged and the 500 is about the original failure.

**The migration is a fan-in, not a ladder.** `auditTableDdl` is by construction
*the table this build writes*, so a real v1→v2→v3 ladder would need a frozen v2
DDL literal beside it — the second copy of the columns that parameterised DDL
exists to prevent, and one no test could catch drifting. So `migrateV1ToV2`
became `rebuildAuditTable`, which asks `PRAGMA table_info` which columns the old
table can give rather than being told by a version number. That is also what
makes the no-stamp case safe: `schema_version` carries no triggers, so an
operator can delete the stamp from a v2 file with rows in it, and a rebuild
assuming the oldest shape would silently null every `ticket`.

**The docs moved.** `site/src/content/docs/docs/architecture.md` is the
specification and is far ahead of the implementation — treat it as the design
of record, not a description of what exists. `docs/ARCHITECTURE.md` and
`docs/ROADMAP.md` are now one-line pointers; edit the files under `site/`.

The roadmap is phase-gated on purpose: the governed core (vault, team-sheet
enforcement, approval broker, budget meter, audit log, and the e2e suite that
attacks them) comes before features that depend on it.

## Planning

Work is planned in GitHub issues on `getlibero/libero`. The roadmap
(`site/src/content/docs/docs/roadmap.md`) defines phase scope; issues are the
execution plan, not the spec.

- **One milestone per phase**, created when the phase starts. Its description
  carries the phase's definition of done. An issue goes in the milestone only
  if the phase gates on it.
- **One tracking issue per workstream** (label `tracking`), holding native
  sub-issues. Sub-issues are sized to roughly one PR and state their own
  acceptance criteria.
- **Sequencing uses native issue dependencies** (blocked by / blocking), not
  prose. Sub-issues express containment; dependencies express order.
- **Labels:** `area:*` says where in the tree (agent, proxy, schema, cli, e2e,
  site, infra); GitHub's default type labels say what kind of change;
  `security` marks issues load-bearing for the security property or part of
  the attack suite; `parked` marks valid work that belongs to a later phase —
  parked issues stay open, carry no milestone, and are picked up when their
  phase opens; `needs-triage` marks community issues not yet looked at (the
  issue templates apply it).
- **Triage is removing `needs-triage`** by doing exactly one of: assign the
  open milestone (plus `area:*`, attached to a tracking issue where one fits),
  apply `parked`, or close as duplicate/invalid/Discord-question. Target: under
  a week. An issue is approved to build against only when milestoned and
  unblocked — that rule is stated in CONTRIBUTING.md, so point contributors
  there rather than re-deriving it. A security-sensitive report filed publicly
  gets minimal in-thread discussion and a request to refile via private
  vulnerability reporting.
- **Taking an issue is assigning it to yourself, before the first commit.** The
  assignee is the only in-progress signal — there is no `status:*` label and no
  board, so an unassigned milestoned issue reads as free and someone else may
  start it. That applies to work you pick up on the user's behalf too: assign
  their GitHub account (`gh api user --jq .login` says who) when you start, not
  when you open the PR. If the work stops or gets
  descoped, unassign it in the same breath, so the queue never claims someone
  is on something they aren't. Open the PR with `Closes #N` in the body — merge
  then closes the issue, which is what ends the in-progress state.
- No Projects board. Milestone + labels + assignee + the issue list is the whole
  system.

The public version of this convention is the "How work is planned" section of
`CONTRIBUTING.md` (short form on the site's contributing page); keep them in
sync when the convention changes.

## Architecture invariants

Two services. **gateway + agent** (`apps/server`) talks to Slack over Socket
Mode and runs the model loop. **tool proxy** (`apps/proxy-server`) holds every
tool credential and enforces what each channel may do. The security property the
whole design hangs on: tool credentials live only in the proxy, and the agent
reaches tools only through it, so compromising the agent process yields no tool
credentials.

The agent process is not credential-free, and the docs say so rather than
overstating the property (#100). It holds the Slack app and bot tokens — the
gateway holds the socket, and brokering that through the proxy would make the
proxy the gateway — and the model provider key. Neither reaches a tool the
proxy guards, which is why the narrower claim is the true one. When you write
about this, say *tool credentials*, not *secrets*.

These are load-bearing, not stylistic:

- **`packages/agent` may never import `packages/proxy`.** The only path from
  agent to tools is the network call. Enforced twice — an ESLint
  `no-restricted-imports` rule in `eslint.config.mjs` and a grep-level
  `boundary-check` job in CI, which runs `scripts/boundary-check.sh` — the same
  script `pnpm boundary-check` runs, so the two cannot drift. Do not route
  around either. The grep is a **raw string match** rather than an import
  match, on purpose (the argument is in the script's header): it covers what a
  parser would miss — a comment, and a `package.json` dependency edge, which
  ships the proxy's code in the agent's image before any import exists. Prose
  on the agent side says "the tool proxy service".
- **Enforcement is deterministic and lives in the proxy.** Allowlist checks,
  approvals, budgets, and egress rules resolve from the channel's team sheet
  without the model's cooperation. Anything phrased as "instruct the model not
  to…" is not a mitigation. The agent loop may also cap tool calls/time/tokens,
  but the proxy's meter is authoritative.
- **Credentials are referenced by name, never by value,** in team sheets, logs,
  errors, and anything returned to the agent.
- **The channel id comes from the client certificate, and from nowhere else.**
  Client certs are minted per channel with the subject `CN=channel:<id>`
  (`scripts/dev-certs.sh`), and `packages/proxy/src/identity.ts` is the only
  place that resolves one. No header, query parameter, or request body may ever
  become a channel id: the process on the other end runs the model, so anything
  the model can influence is not a boundary. Certificates authenticate; team
  sheets authorize — revocation is removing a channel's sheet, not a CRL.
- **One SQLite file per channel is the isolation boundary** for anything holding
  channel *content* — messages, memory. No schema or query there should be able
  to join across channels. `packages/memory` is where that reading is built, and
  it is strict twice over (#63): there is **no `channel` column** — the file is
  the channel, so there is no column a statement could forget to filter on — and
  **no operation takes a channel id**, so `openMessageStore` closes over one file
  and a cross-channel query is not something `MessageStore` can express. That is
  a shape the type system has rather than a rule a reviewer applies, which is
  why `store-db.ts` needs no equivalent of the proxy's per-statement
  `WHERE channel = ?` check.

  Since #176 the files live under `AGENT_STORE_ROOT`, which is **not**
  `AGENT_CHANNELS_ROOT` — the agent must not be able to write to the directory
  the proxy reads team sheets from, because the proxy re-reads a sheet per call
  and a writable channels mount is a compromised agent widening its own
  permissions. One thing moved with it: `openMessageStore` still creates no
  directory, but the directory existing is no longer the operator's statement
  that the channel exists, so the sheet check is explicit in
  `apps/server/src/session/store.ts`. A second caller of `openMessageStore` that
  skipped it would be inventing a channel with no authorization behind it.

  Since #64 the proxy mounts that same root as `PROXY_STORE_ROOT` and reads it
  through `openMessageReader` — read-only, `search` and `close` only. That is one
  direction across the line and does not weaken the rule above: the hazard is the
  agent writing where the proxy reads *authorization*, and the store is neither
  the channels root nor authorization. `openMessageReader` is where a second
  caller's review goes now, and it needs no sheet check because it creates
  nothing — a channel with no store is `null` rather than an invented one.

  **The line is whose data it is and who reads it, not how much of it there
  is.** Content belongs to a channel's members and is read on their behalf, so a
  cross-channel join is one channel's members seeing another's conversation.
  Operator-facing tables — the budget meter and the audit log —
  are read by the operator, and cross-channel aggregation there is a feature
  rather than a hazard: a team asking how a workspace is tracking against its
  caps needs exactly the query the per-file layout would forbid.

  So the budget meter is one file keyed `(channel, day)`, decided in #96 rather
  than drifted into. What has to hold instead is that **channel members cannot
  manipulate the numbers**: the channel comes from the certificate, every write
  is `x = x + n`, and the server's whole surface on the meter is `read`,
  `recordToolCall`, `recordTokens` — clearing a counter lives in
  `budget-admin.ts`, which the server never imports. Keep all three. Also keep
  **every SQL string in `packages/proxy` in the module that opens the database
  it runs against** — `src/budget-db.ts` and `src/audit-db.ts`, and no others.
  One module per database, not one per package: the rule exists so
  "no statement omits `WHERE channel = ?`" is checkable by reading one file, and
  a second database does not weaken that as long as its statements are all in
  one file too. A statement prepared anywhere else — a route, a writer, an admin
  helper — is a review failure.

  **Aggregate reads go on the operator path** (`budget-admin.ts`), never on the
  interface the server closes over. Reading one channel is a serving concern;
  reading all of them is an operator concern.

  The audit log is that layout with a stricter write discipline (#97): one table
  with a channel column, and the only statement that touches it is an INSERT
  (the module's other SQL is `schema_version` bookkeeping at open).
  Append-only is `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)` —
  SQLite has no roles and no grants, so the architecture's "no UPDATE/DELETE
  grants for the service role" cannot be built as written. The write-only
  `AuditWriter` the server closes over and the file's permissions are defence in
  depth around the triggers, not the mechanism, and the PR that landed it says
  which is which. There is no retention command and a delete-based one should
  not be added; rotation is the shape. A failed audit write **refuses the call**
  rather than serving it unrecorded.
- **`packages/schema` is the single source of truth** for team sheets, audit
  records, tool calls, approvals, and memory ops. Both services import from it;
  don't redefine those shapes locally. `channels/example/channel.toml` is the
  documented starter sheet and should stay in sync with the zod schema.
  Built today: the team sheet, the tool call and its response, the tool
  listing, refusals, the spend report, the proxy error shape, the audit
  record, and the approval ticket and decision. Both services import them —
  `packages/agent` since #109, which is what makes "the two ends agree on one
  definition" true rather than aspirational. Memory ops are still where that
  shape goes when the code needing it lands, not something you can import yet.

  `src/audit.ts` is the one shape that never crosses the wire: the proxy builds
  it from its own observation and reads it back out of SQLite on the operator's
  path. It is in schema because the row is written by one mapping and read by
  another and the two must agree — a column renamed on one side is a type error
  rather than a silently empty CSV column. `AuditRecord` is a **type with no zod
  object**, for the reason `ResolvedToolCall` has none — a `.parse()` is how a
  channel gets taken from a request body. `AuditOutcome` does get a zod enum,
  because #98 parses it off `argv`. `auditRefusalMessage` lives here too: it
  rebuilds a `ToolRefusal` from a row's columns and delegates to
  `refusalMessage`, so the operator reading the log and the channel that saw the
  refusal get the same words, and answers `null` for the three reasons whose
  facts the table has no column for rather than inventing one.

**#98 is the read path, and where it landed is the decision.** The issue said
`packages/cli`; it went to `apps/proxy-server` as a third entrypoint
(`node dist/audit.js`) beside `vault` and `budget`, because
`deploy/docker-compose.yml` mounts the audit log as a **named volume**
(`audit-data`) exactly as it does the vault's and the budget's — so
`npx @getlibero/cli audit` would open a path that is not on the host. The rule
the compose file already draws, now written down: **the CLI owns what the
operator authors on the host** (`../channels`, `./certs`, the env file — all
bind-mounted `:ro` into the services, and all still `libero init` /
`channel add` / `doctor`'s), **and the proxy's own entrypoints own what the
services own inside their volumes**. It defers rather than dodges the packaging
question — `@getlibero/schema` is `private` too, so `doctor` will have to answer
it — and that belongs to `doctor`.

  Three things about the reader are settled. **It is a second connection, opened
  `readOnly`**, so SQLite refuses a write before the append-only triggers have
  to; the `-wal`/`-shm` sidecars it creates are bookkeeping beside the file
  rather than a write to the log, and the module says so rather than claiming it
  writes nothing. **It does not migrate**, in either direction, because
  migrating is writing and a reader that repaired a file would be a reader that
  changed the evidence — so a version mismatch names both numbers and stops.
  And **the query statements are in `audit-db.ts`** with the INSERT, which is
  what that file's rule already promised #98 would do; filter values are bound
  and never concatenated, and the only thing whose length varies is the
  `outcome IN (…)` placeholder run.

  `parseArgs` from `node:util` is the flag parser, so no dependency was added.
  The time bounds are parsed **by rule rather than by `Date.parse`**, which
  accepts `04/08/2026` in whatever order it likes, silently rolls `2026-02-30`
  into March, and reads a zoneless instant as the *host's* time on a command
  whose usage says UTC. A bare date is that whole UTC day and a time must carry
  a zone. **No colour is emitted**, ever: the outcome word is the status, three
  colours do not cover eight outcomes, and ANSI in a CSV is a corrupt file.

## Design

`design/` is plain CSS and SVG — no build step, outside the pnpm workspace, so
the root `pnpm -r` scripts don't see it. Open `design/index.html` directly.

- `tokens.css` — colour/type/radius tokens. **Generated**: a verbatim mirror of
  `libero-tokens.css` in the Claude Design project. Don't edit it here; change
  it upstream and re-sync, or the spec and the code drift.
- `libero.css` — the component layer, plus a marked block of derived tokens the
  spec uses but never names.
- `index.html` — live reference for every token and component, both modes.
- `brand/` — mark, lockup, app icons at 34/20/16.

**The spec is locked.** Don't introduce a colour, font, radius, or component
shape that isn't already in it. Reference tokens by name, never by hex. Dark is
the default and needs no attribute; light is `data-theme="light"` on the root.
Green = allowed and executed, amber = awaiting a human, red = blocked —
nothing else on screen is coloured. `design/README.md` has the full rules, the
upstream project link, and the two places the implementation deliberately
departs from the source file.

**Voice**, which governs docs and UI copy as much as the design: plain, terse,
technical. Name the tool call. State what is and isn't permitted. No
exclamation marks, no emoji, no "AI magic" language.

## Site

`site/` is getlibero.com — Astro + Starlight, static, deployed to GitHub Pages
by `.github/workflows/pages.yml`. Like `design/`, it is **outside the pnpm
workspace**: it has its own `pnpm-workspace.yaml`, its own lockfile, and its own
CI job, so Astro's dependency tree never reaches `pnpm -r` or the core license
gate. Run everything from inside `site/` (`pnpm install`, `pnpm dev`,
`pnpm build`, `pnpm check`). It needs **Node 22.12+** — Astro 7's floor. The
core packages are now two majors above that, at **24**, and the gap is
deliberate: `site/` is outside the workspace and has no reason to follow. The
core floor moved for `packages/memory`, whose full-text index needs SQLite's
FTS5 — `node:sqlite` was compiled without it until 22.16, so the old 22.13 floor
(where `node:sqlite` stopped needing `--experimental-sqlite`) would have let a
conforming install fail at runtime with `no such module: fts5`. Node 24 is the
LTS above that line.

- Marketing pages are `src/pages/`; docs are `src/content/docs/docs/` and serve
  at `/docs/*` because the marketing pages own the root.
- The design system is **imported, not vendored** — `src/styles/tokens.css`
  points at `../../../design/tokens.css`. Marketing loads tokens + `libero.css`;
  docs load tokens only, and `src/styles/starlight.css` maps every `--sl-*`
  variable onto a `--lb-*` token.
- Where a CSS variable is impossible (the syntax theme, the social card),
  `src/lib/design-tokens.mjs` parses the values out of the design stylesheets at
  build time and throws if a token is renamed. Don't type a hex into `site/`.
- Code blocks are monochrome by design: a string literal is not a status, so it
  doesn't get a colour. See `src/lib/code-theme.mjs`.
- Starlight component overrides live in `src/components/overrides/` and each
  says why it exists. Dark is the default with no "auto" — `src/lib/theme-script.ts`
  is shared by both surfaces.
- `site/README.md` has the full account.

## Conventions

ESM throughout (`"type": "module"`) with `moduleResolution: NodeNext`, so
relative imports carry the `.js` extension (`export * from "./team-sheet.js"`).
`tsconfig.base.json` turns on `strict`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes` — indexed access yields `T | undefined` and
optional properties reject explicit `undefined`.

## Repository rules CI enforces

- **License gate:** MIT/Apache-2.0-class dependencies only in core — the
  actual allowlist is the `ALLOWED` string in `scripts/license-check.sh` (ten
  permissive licences). Per
  `GOVERNANCE.md`, AGPL/SSPL and commercially-licensed packages (including the
  Anthropic Claude Agent SDK) are excluded; the latter is allowed only as an
  optional, user-installed adapter.
- **Privileged workflows must not check out code.** `.github/workflows/cla.yml`
  runs under `pull_request_target` with a write token; the `workflow-guard` CI
  job fails any `pull_request_target` workflow containing an
  `actions/checkout` step. Third-party actions in those workflows are pinned to
  a SHA, not a tag.
- **CODEOWNERS review** covers `packages/proxy`, `packages/schema`,
  `apps/proxy-server`, `.github/`, `.claude/`, `SECURITY.md`, and
  `GOVERNANCE.md` (currently inert — the teams don't exist yet; see the note
  in `.github/CODEOWNERS`).
- **CLA** required from the first external PR, checked by a bot.

## Release

`@getlibero/cli` is the only npm-published package; everything else ships as
Docker images built from `deploy/docker-compose.yml`. Pushing a `cli-v*` tag
triggers `release-cli.yml`, which publishes with npm provenance attestations.
