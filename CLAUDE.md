# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                          # Node 22.13+, pnpm 9+
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
calls, the redaction pass on the way back, the MCP client and its per-upstream
pool, the daily budget meter over `node:sqlite`, the append-only audit log, and
the approval ticket store),
`apps/proxy-server` (the process composing all of it — a
permitted call is now served rather than answered 501, plus a `budget`
entrypoint alongside `vault` for the operator),
`packages/gateway` (the Slack Socket Mode adapter — mention in, handler, reply
into the thread, a reconnect ladder the gateway owns rather than the SDK, and
since #126 an approval card it can render and a click it can decode),
`apps/server` (the gateway + agent process — env parsing, the mention handler,
lifecycle), `packages/cli` (placeholder npm release), `design/` (the design
system — plain CSS, no TypeScript), and `site/` (getlibero.com).
`packages/memory` is a README stub. `e2e/` is the security suite's rig (#131).

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
`e2e/README.md` is the harness API, and the place #132–#135 should start.

**The agent calls tools, through the proxy and only through it.**
`packages/agent/src/proxy/` is the client (#109): an mTLS transport over
`node:https`, `ToolSource` over `GET /v1/tools`, `ToolExecutor` over
`POST /v1/tools/call`. `apps/server` composes gateway + loop + transport, so
`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `PROXY_URL`, `PROXY_TLS_CA`,
`PROXY_CLIENT_CERT_DIR`, `AGENT_PROVIDER`, `AGENT_MODEL`, `AGENT_CHANNELS_ROOT`,
and the provider key are all live and all required — there is no toolless
fallback. `apps/server/README.md` has the environment contract.

**Mentions in one channel queue rather than interleave, and each task runs on
its channel's sheet.** `apps/server/src/session/` is the channel router (#65):
one session per `(workspace, channel)`, a mutex per session, and a per-task read
of `$AGENT_CHANNELS_ROOT/<channel>/channel.toml` resolving `[llm]` to a model
and the four `AgentLoopCaps`. Sessions are evicted after 30 minutes idle and
never while busy; there is no cache and no watcher, so an edit lands on the next
mention.

Two things there are load-bearing. **The router never learns what Slack is** —
it takes a `TaskRequest`, `handler.ts` is the short mapping that builds one
from a `SlackMention`, and an ESLint block on `apps/server/src/session/**`
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
client, and the outbound sender. And **upstream descriptions and schemas are
third-party text entering the model's context every turn** — the tool-poisoning
surface. Nothing reads them, because a rule that read a description is a rule
the upstream phrases around; the caps (1024-character descriptions, 8KB
schemas, 100 tools, 5 pages, a 5s budget per upstream) bound the blast radius
and are not a mitigation. The sheet naming the server is what accepts it.

A schema must be a JSON object saying `type: "object"` or it is dropped and the
entry stays thin, and that rule is load-bearing rather than fussy:
`packages/agent` casts it straight into the provider's tool definition, and a
provider answering 400 fails the whole turn rather than the one tool.

**The proxy speaks MCP for real, at revision `2026-07-28` (#128).**
`mcp-protocol.ts` is the wire format as pure functions, `mcp-client.ts` is one
upstream's client, `mcp-pool.ts` keys one client per `(transport, url,
credential)` triple — the same `upstreamKey` enforcement compares, exported
rather than restated so the two cannot drift.

The client is hand-rolled rather than the SDK, and the reason is the custody
argument rather than dependency count: `StreamableHTTPClientTransport` owns its
own `fetch`, so the credential would be revealed outside `callUpstream`, and
"redaction is total because sending is centralised" would become "because we
wrapped it carefully" in the process holding every credential. The cost — this
repo owning a moving protocol — is paid by one pinned constant and
`.github/workflows/mcp-spec-watch.yml`, which files an issue when the spec moves
past it.

Three behaviours there are decisions rather than mechanics. **A server naming no
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

**Two services, one Dockerfile short of running under compose.**
`deploy/docker-compose.yml` builds both images from paths that do not exist
(#86), so `docker compose up` fails on a clean checkout. Run either process
directly in the meantime.

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
degrade to expiry. `audit.db` is at schema version 2 with the repository's first
migration (#125), and its vocabulary now carries `approved`, `denied`, and
`expired` plus a `ticket` column joining an approval's rows.

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
  to join across channels. `packages/memory` is the next one, and it keeps the
  strict reading: a factory that takes one channel id and no API that can ask
  for a second.

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
  it from its own observation and the CLI reads it back out of SQLite. It is in
  schema anyway because `packages/cli` is npm-published and `@getlibero/proxy`
  is private, so #98 opens the file itself and needs the column names from
  somewhere shared. `AuditRecord` is a **type with no zod object**, for the
  reason `ResolvedToolCall` has none — a `.parse()` is how a channel gets taken
  from a request body. `AuditOutcome` does get a zod enum, because #98 parses it
  off `argv`.

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
`pnpm build`, `pnpm check`). It needs **Node 22.12+** — Astro 7's floor; the
core packages sit just above it at **22.13**, which is where `node:sqlite`
stopped needing `--experimental-sqlite`.

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
