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

Phases 1, 1.5, 2 and 3 are shipped and their milestones closed. Phase 4
(ambient) is open. #316 gave `[ambient]` its real shape —
`heartbeat_every_minutes` and `answer_after_idle_minutes` beside `enabled` — and
#317 is its first reader: `apps/server/src/session/ambient.ts` is **the one clock
in this process and the one enumerator over every channel**, which is why the
four background passes stay on channel activity and this does not. It wakes at
the next due instant rather than on a tick (so `schedule_task`'s due task joins
as an event source rather than a second clock), skips windows it was down for
rather than replaying them, and reaches a channel through the same session — and
therefore the same mutex — a task does. One thing rides with it: the gateway now
answers `workspace` off the same `auth.test` it already made, because a
filesystem listing gives channel ids and a session key needs both.

#318 gave that clock somewhere to speak. `apps/server/src/proactive/proactive.ts`
is **the one path in this process that starts a message** — the gateway's
`ChannelPoster` posts with no thread, because a proactive post has no inbound
event to reply into. What keeps it from becoming a general capability is
composition rather than a rule: `createServer` mints one `ProactivePoster` and
`ServerDeps.heartbeat` is a **factory** over it, so the capability never reaches
`index.ts` and the four background passes cannot name the type. The curator's
"a proposal is a file because this process cannot post" is therefore still true
after this, and #320 is what changes it. The rate limit is
`HEARTBEAT_POST_WINDOW_MS` — four hours, per channel, an architecture constant
the schema's `[ambient]` block already refused to make a field — and it governs
`source: "heartbeat"` alone: a fired task's post was governed at its create, so
it neither draws on the window nor is blocked by it. That discriminant is
`DueEntry.kind`'s word list, deliberately, so the phase has one vocabulary.

#335 came out of #319 rather than out of the roadmap, and it is the reason that
issue is not next: the evaluation turn promises that a channel at its cap spends
nothing, and the agent side had no way to find out. `GET /v1/budget` is the read
that closes it — advisory rather than enforcement, because a completion never
reaches the proxy — and the three background passes that spend now ask before
they do. The gate sits immediately before each provider call rather than at the
head of a pass, so a channel over its caps still reconciles its skill index.

#319 is the reader those two were built for. `apps/server/src/session/heartbeat.ts`
is what a due channel does: a four-question pregate — sheet, rate window, idle
material, budget — where the first three are free and most ticks stop in them, and
then one model call whose ordinary answer is nothing. **Silence is calling no
tool**, which diverges from the architecture's "SILENT sentinel" wording on
purpose: it is the idiom the other four background turns already use, and under
it "an answer that is neither the sentinel nor a finding is silent" holds by
construction rather than by a branch. The window is checked *before* the
evaluation, which is what makes a shut window defer a finding rather than lose
one, and a per-channel watermark is what makes a finding say-once — load-bearing
because the agent's own replies are not in the store, so nothing else records
that it already spoke. `[ambient] answer_after_idle_minutes` finally has a
reader, and `packages/memory` grew `idleThreads` for it: `staleThreads` is joined
against the summary corpus, so a channel that summarizes its quiet threads would
be invisible to the heartbeat.

#320 closed the heartbeat workstream's last feature and the loop phase 3 left
open: a waiting merge proposal is now named in its channel, once. It is material
in the pregate's sense and it is *free* — the notice is a template over two skill
names, so a tick whose only material is a proposal makes no model call, and a
channel over its caps still hears about one. A notice and a finding in the same
evaluation are one post. Say-once is `skill_merge_notice` in the channel's index,
a table of its own beside the considered one because *considered* is a fact about
spend and *told* is a fact about a channel; it is written after the post lands and
is never cleared when a proposal is forgotten, or deleting one would become a way
to be asked again. The **directory** is what is listed rather than the index,
which is what keeps deletion both the decline and the way to stop the notice.

#321 closed the heartbeat workstream. The rig composes ambient on request — off
twice, by a `RigOptions.ambient` switch *and* by the sheet, which is what makes
"a channel that never opted in sees nothing" assertable rather than asserted —
and `rig.heartbeat(at)` fires exactly one, scanning twice because first sight
never fires. The suite states the claim the way #293 states its own: injected
channel content can steer *what a proactive post says*, and what it must not do
is widen anything governed — one post per rate window however many ticks fire, a
question not answered before its threshold and answered after, a tick with
nothing new spending nothing, a capped channel heartbeating without spending, a
channel with `[ambient]` off seeing nothing, and a proposal notice that hostile
content in the proposal itself cannot repeat. Wiring it found two real gaps in
the rig: the harness gateway had no `AppIdentity`, so `gateway.workspace` was
`undefined` and the clock would have refused to scan in every deployment the
suite composed, and the surface had no `channel` verb.

What phase 4 does *not* have yet is `schedule_task` (#322–#325). What exists:

| Package | What it is |
| --- | --- |
| `packages/atomic-write` | The durable-replace recipe, once — write a whole temporary sibling, fsync it, rename it over the target, fsync the directory. Two exports and no dependencies at all, which is what lets both services and the published CLI import it (#272) |
| `packages/schema` | The single source of truth for shapes both services use: the zod team sheet, name primitives, egress patterns, tool call and response, tool listing, refusals, spend report, proxy error, approval ticket and decision, the audit record, the memory ops, and the skill file and its two operations |
| `packages/agent` | The model half — provider-agnostic completion and embedding layers, ReAct loop with per-task caps, the post-reply curation and skill-author turns, the thread-summarization and ambient-heartbeat turns, and the mTLS client that reaches tools through the proxy and nowhere else |
| `packages/proxy` | The security boundary — mTLS listener, per-channel identity, team-sheet enforcement on both gates, the credential vault, the OAuth token store and its mint/refresh engine, injection and redaction, the MCP client over the official SDK and its pool, `search_channel_history` as a built-in, the budget meter in calls and in dollars, the append-only audit log, and the approval ticket store |
| `packages/gateway` | The Slack Socket Mode adapter — mentions, ordinary messages, approval-card rendering and click decoding, the live-checklist renderer, the proactive post's verb and renderer, the app's own identity and workspace off one `auth.test`, and a reconnect ladder it owns rather than the SDK |
| `packages/memory` | The per-channel store — one SQLite file per channel, an FTS5 index, the delete and edit paths, the curated `MEMORY.md`, thread summaries and the two quiet-thread reads, a sqlite-vec embeddings table, the `skills/` directory and the index that follows it, the `proposals/` directory beside it, and a read-only opener the proxy uses |
| `packages/cli` | The operator's host-side commands — `init`, `channel`, `doctor`. The only npm-published package: one bundled file, plus a build-time copy of `scripts/dev-certs.sh` |
| `apps/server` | The gateway + agent process — env parsing, mention and message handling, the channel router, the one query embedding a task pays for, semantic recall and skill retrieval over it, the quiescence sweep, the skill-embedding pass, the skill lifecycle job and the merge curator, the ambient clock and its channel enumerator, the proactive post surface and its rate window, the heartbeat evaluation and its pregate, approvals and checklist clients, lifecycle |
| `apps/proxy-server` | The process composing the proxy, plus `vault`, `grant`, `budget` and `audit` entrypoints for the operator |
| `e2e/` | The security suite's rig: the proxy spawned as its built entrypoint, the agent side composed in-process, attacked by a scripted model and — on request — running the four background passes |
| `design/` | The design system — plain CSS, no TypeScript, outside the workspace |
| `site/` | getlibero.com — Astro + Starlight, outside the workspace |

Both halves are wired end to end: a mention runs a task, tool calls go over mTLS
to the proxy, GitHub is called for real, holds raise approval cards, spend meters
per turn, and every decided call leaves an audit row. Memory is whole as of
phase 2: a channel's messages are searchable, its `MEMORY.md` is curated after a
reply and read back before the next task, its quiet threads are summarized and
embedded, and a task starts with whatever of that bears on the question.

Skills close the same loop as of #291: a channel's `skills/` directory is
reconciled against its index at the head of every task, the playbooks matching
the incoming request are loaded into the opening context and record a use (#292),
and a task whose *served* tool calls exceed the channel's threshold gets one
extra model call that decides whether a reusable playbook emerged and writes it
(#291). A skill somebody added with an editor and a skill the turn wrote reach
the index by the same road. The layer is attacked in `e2e/` as of #293, which
states the claim narrowly: a poisoned skill can steer the model, and what it
must not do is widen anything the proxy governs. #305 gave that retrieval its
second leg: nothing embedded a skill until then, so `nearest(…, "skill")`
answered nothing in every deployment and the hybrid fusion ran on full text
alone. `apps/server/src/session/skill-embed.ts` is the pass that fills it, on
channel activity beside the quiescence sweep and reconciling first — which makes
it `reconcileSkillIndex`'s second caller. #294 added the third and the clocks it
serves: `apps/server/src/session/skill-lifecycle.ts` marks a skill stale at
`[skills] stale_after_days` unused and archived at `archive_after_days`, on
channel activity beside the other two and reconciling first — which is what makes
respecting a hand-set status a property rather than a race. It is the one
background pass that spends nothing, and structurally so: it holds no model
client and no spend reporter. #295 closed the workstream with the curator:
`apps/server/src/session/skill-curate.ts` asks the index for the closest *mutual
nearest neighbour* pair of playbooks not yet considered, spends one model call
asking whether they are one, and writes the answer as a **proposal** in
`proposals/` beside `skills/` — never a rewrite. The review surface is the
filesystem because it is forced: no path in this process can post to a channel.
#308 closed the phase: the rig wires all four background passes on request
(`passes`), on a clock that reaches them and nothing else, and the suite now
attacks the two that write into the team's directory. It also fixed a latent
hazard — `channels.ts` wrote `[memory] enabled` but not `summarize`, which the
sweep actually gates on, so every sheet the harness produced already carried
`summarize = true`.

Three things in phase 3 landed differently from the roadmap's own wording, and
the roadmap records them rather than ticking a definition of done that says
something untrue. **The curator produces no diff** — a merged playbook is a
rewrite rather than an edit, so a proposal shows three whole documents instead of
hunks. **Where a proposal goes was forced rather than chosen** (until #320 gave
it a notice in the channel — the file is still the review surface), because
`postThreadReply` is withheld from this process and a card needs a thread from an
inbound event. And **the lifecycle job runs on channel activity rather than
weekly**, which its absolute-date clocks make equivalent.

## Where the reasoning lives

**This file is not the design record.** A decision about how one package behaves
belongs in that package's README or in the file's own header comment, which is
where someone editing it will actually meet it. Keep it that way: this section is
a map, not a summary, and a paragraph added here that could have gone next to the
code is a paragraph the next reader will not find.

| Question | Read |
| --- | --- |
| What the loop does, the callback contracts, how a tool name is resolved, what a turn reports, why embeddings are a second seam, what the summarization turn assumes, what the skill-author turn sees of a task that curation deliberately does not, and why the merge turn takes no handler | `packages/agent/README.md` |
| Enforcement, the vault, MCP client and pool, built-ins, listing bounds, budgets, why the budget read is advisory rather than a second enforcement point, approvals, the audit log's write discipline | `packages/proxy/README.md` |
| Sessions and the queue, follow-ups, the transcript a task starts from, the checklist, the approvals client half, the environment contract, where recall and skill retrieval enter a task and why neither is a tool, why one embedding serves both, how the two skill legs are fused and what bounds them, why the post-reply turns are one thunk, what counts toward the author threshold, what bounds the quiescence sweep, why skills are embedded on channel activity rather than at task head, what `stale` means to retrieval and why, how the lifecycle job tells a hand-set status from its own, why a merge proposal is a file rather than a message, why the ambient clock enumerates the filesystem, wakes at the next due instant, and skips the windows it was down for, why the proactive post surface is minted in the composition, why its window is four hours, why its two sources are named for the wake reason, and what the heartbeat's pregate asks in what order, why its watermark makes a finding say-once, and why a shut window defers rather than loses | `apps/server/README.md` |
| Slack normalization, the three subscriptions, card rendering, how the app learns its own id and its workspace from one `auth.test`, why the channel-post verb is a second exception to the `CardPoster` narrowing and a different kind of one, the three rules that package keeps | `packages/gateway/README.md` |
| The three reads, the isolation boundary, the tokenizer, why `search` takes text, why `MEMORY.md` has no lock, what `allowExtension` does and does not open, why the vec table is created lazily, why a thread summary has a shape, why reconciliation is the skill index's only writer, why `nearest` takes a kind, why `searchSkills` ORs its terms where `search` ANDs them, why `idleThreads` is not `staleThreads` with another argument, why the lifecycle job's two stamps are two methods rather than one, why the proposals directory has no `read`, and why no trigger drops a considered pair | `packages/memory/README.md` |
| Operator commands and the vault CLI | `apps/proxy-server/README.md` |
| What the published CLI owns, why the schema is bundled rather than published, why `channel add` writes a pin, and what `doctor` refuses to check | `packages/cli/README.md` |
| The harness API, what is faked, why the positive control matters, which sheet blocks are off by default in a rig and why, why ambient is off twice and why `rig.heartbeat` scans twice, and the one fake embedder's shape and the rule it carries | `e2e/README.md` |
| Images, mounts, `.dockerignore` as an allowlist | `deploy/README.md` |
| Vendored third-party source: a copy, not a fork | `packages/proxy/src/vendor/README.md` |
| Tokens, components, voice | `design/README.md` |

**The specification is `site/src/content/docs/docs/architecture.md`**, and it is
far ahead of the implementation — treat it as the design of record, not a
description of what exists. `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` are
one-line pointers; edit the files under `site/`.

The roadmap is phase-gated on purpose: the governed core — vault, team-sheet
enforcement, approval broker, budget meter, audit log, and the e2e suite that
attacks them — comes before features that depend on it.

## Things that span packages

These have no single README to live in, which is the test for belonging here.

**One credential lives in one place, and the boundary is a process.** Tool
credentials are the proxy's and reach the agent never; the Slack tokens and the
model provider key are the agent's and reach the proxy never. The e2e suite is
what makes that checkable rather than asserted, and its positive controls are
load-bearing — every "the credential did not leak" assertion also passes on a run
where none was ever resolved, so a case proves the canary *did* arrive at the
upstream before proving it reached nothing else.

**`packages/memory` is a leaf, and an ESLint block keeps it one.** Both services
open these files — the gateway writes every inbound message and the proxy reads
one back — so it must be importable from either side. `src/log.ts` duplicating a
`Logger` interface is the visible cost; the hazard it avoids is live rather than
prospective, since a gateway import would put the Slack SDK into the proxy's
image through an edge that exists today.

**What a leaf may import is a package with nothing under it.** The ban is on the
two services, not on dependencies, and the test is whether the edge would put
either service's code into the other's image. `@getlibero/schema` passes and
`@getlibero/atomic-write` passes — the second declares no dependencies at all,
which is its charter rather than a fact about today. That is the difference
between the two duplications this repository has carried: the durable-replace
recipe was copied because a leaf could not import the proxy, and #272 removed the
copy by giving the recipe a package instead; `Logger` stays duplicated because an
interface the gateway declares has no third home worth making. **Copy only what
has nowhere else to go, and say which it is.**

**A refusal is a served request, and a failure is not.** `ToolRefusal` is a
closed set of governance decisions with no free-text member, worded once by
`refusalMessage` so the operator reading the audit log and the channel that saw
the refusal get the same sentence. `ProxyError` is the separate shape of a
request that could not be answered at all. Nothing that is merely broken should
be spelled as a refusal, and nothing denied should be spelled as an error.

**Trust claims are written narrowly, and the two are different.** Tool
credentials survive a **compromised agent process**. Approver identity and the
token counts a turn reports survive a **prompt-injected model** but not a
compromised process, because that process relays them. Say which one you mean;
"secrets" and "the agent cannot lie" are both wrong.

**A test that encodes a gap is worse than no test.** This has now happened three
times — `audit.test.ts` asserting the pre-#124 behaviour, the `toHaveLength(1025)`
that pinned an off-by-one into the contract, and #143's three prompter tests
painting green at decision time. When a test needs changing to land a fix, say so
in the commit and check whether the assertion was describing a bug.

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
- **A tracking issue is scoped to the phase that opened it, and closes with
  it.** Follow-on work accumulates under a tracker because there is nowhere else
  to file it, so before the tracker closes that work is **re-homed**: a new
  `parked` tracker where the group is a real workstream, a standalone `parked`
  issue where it is not — a tracker for one issue is overhead. The rule this
  enforces is that **a closed parent must never be the only place open work is
  grouped**, because nobody opens closed issues and the grouping is then lost to
  whoever picks the phase up. Phase 1 is the worked example: #34, #38 and #39
  each named a deliverable and got it, their eleven parked children went to #210
  and #211, and #118 and #62 were detached to stand alone beside #122 and #202,
  which already did.
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
  sheets authorize — and since #79 the sheet has one narrow say in the first of
  those: `[channel] certificate_sha256` lists the fingerprints allowed to speak
  for the channel, checked in the identity gate ahead of the route table. Still
  not a CRL and still no second surface — revoking a leaked *key* is dropping a
  fingerprint from the sheet, retiring a *channel* is removing the sheet. The
  sheet cannot make a key speak for a different channel, because the CN is what
  selects which sheet is consulted. Rotation is `--rotate`/`--promote` in
  `scripts/dev-certs.sh` with two pins live across the overlap; the agent
  re-reads a changed certificate per request, so neither service restarts.

  **`scripts/dev-certs.sh` never writes a sheet, and `libero channel add` is
  not an exception to that.** The script's rule is that minting material and
  authorizing it are two acts, so that a change to which key may speak for a
  channel is a reviewable edit in git. Creation is not that change: at `add`
  there is no prior sheet, no diff, and nobody to review it but the person
  running the command — so `add` writes both files at once and refuses outright
  on a channel that already has a sheet, which keeps "this only ever writes a
  sheet nobody had reviewed yet" true by construction. Every later change to a
  pin still goes through `channel rotate` → human edit → `channel promote`, and
  `promote` still refuses until the sheet pins the staged fingerprint. If you
  are tempted to let `add` merge into an existing sheet, that is the rule you
  would be giving up.
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
  definition" true rather than aspirational. Memory ops joined them in #224, and
  skills in #289.

  **`src/skill.ts` is the first shape here that is also a file *format*.** It
  holds the frontmatter, the name — which is a path segment and an index key, so
  it is `ChannelId`'s kind of primitive rather than a label — and both halves of
  the `---`-fenced grammar, parser and serializer, round-tripped by a test.
  The grammar is hand-written rather than YAML: the CLI inlines this package and
  publishes no dependencies, and YAML's implicit typing would read
  `description: no` as `false` and `created:` as a zoned `Date`. Two decisions
  ride on that file's header and neither is re-derivable from the code. **The
  file is the source of truth for what a human authored and the index for what
  the runtime observed**, which is why `uses` is a column and not frontmatter
  even though `architecture.md` used to say otherwise — retrieval records a use
  per loaded skill per task, and that many rewrites of team-owned markdown loses
  hand edits. And **no lifecycle clock reads the file**: `created` is
  documentation, the clocks run on the index's own `first_seen_at` and
  last-used, or a model writing `created: 2099-01-01` would move one.

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
services own inside their volumes**.

**The packaging question #98 deferred is answered in #217: the CLI imports
`@getlibero/schema` and esbuild inlines it.** `packages/cli/build.mjs` bundles
the entry point into a single `dist/index.js` carrying the schema, zod and
smol-toml, so the published manifest declares **no dependencies at all** and
`@getlibero/schema` stays `private`. That is a build-time inline of the one
source of truth, not a vendored copy: there is no second checked-in definition to
drift, and `pnpm -r build` fails the moment the schema's exports change. The
workspace edge lives in `devDependencies` and `release-cli.yml` deletes that
field before publishing, because `npm publish` — unlike pnpm's — does not rewrite
`workspace:*` and would ship a specifier no registry client can resolve. CI packs
the tarball and asserts both halves on every pull request. The rule this leaves:
**a shape both services agree on is imported here, never restated** — the CLI
validating a model id or a team sheet differently from the proxy would be a
second answer to what a deployment is.

#272 made that two inlined packages rather than one, and the rule generalizes
from shapes to guarantees: `@getlibero/atomic-write` is inlined the same way, so
`libero init` writes the file holding `PROXY_VAULT_KEY` with the recipe the vault
uses rather than its own weaker copy of it. Two things follow. **A package the
CLI inlines must declare nothing the bundle cannot carry** — an edge to
`@getlibero/memory` would drag `sqlite-vec` into the one artifact people install
from npm, which is why the recipe got a package of its own rather than a home in
the message store. And **`build.mjs` reads the third-party notices off every
inlined workspace package**, not off a hardcoded path to the schema; the second
one changed no output, and the generator being right by coincidence was the point
of fixing it.

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

It publishes **one file and no dependencies**: `packages/cli/build.mjs` bundles
`@getlibero/schema` and `@getlibero/atomic-write` in with esbuild, and the
workflow deletes `devDependencies` before `npm publish` so the workspace edges
never reach the registry. See the #98 paragraph above for why that, rather than
publishing them.
