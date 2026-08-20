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

**Every phase is shipped and every phase milestone is closed.** Phase 5 was the
last one, so delivery is no longer phase-gated: work is now milestone-gated on
`v0.3.0`, the release that makes releases real — the service images on GHCR
(#313), a changelog (#377), a written release procedure (#378), and four
correctness and doc-drift items beside them. There is no phase 6, and inventing
one to hold ordinary work would be the wrong move; the roadmap's phase list is
complete rather than paused.

Phase 5 was two workstreams and both are closed. #352 hash-chained the audit
log (#354), gave an operator a walk over it (#355), and attacked it in the suite
(#356). #353 streamed MCP responses through redaction (#156), gave the client
pool and the catalog cache a lifetime (#158, #374), and fixed the sheet-store's
torn-read complaint (#342). Their decisions are argued where the code is; the
table below says which file.

Two belong here rather than there. One is a decision *not* to build, which the
next person to have the idea will not find otherwise: **#122's argument capture
was designed and declined**, so "store the arguments and redact the secrets" is
settled rather than open. #364 closed the cost it left without reopening it —
a blocked call's arguments land in an off-chain, deletable store the audit
row's own hash binds (`packages/proxy/src/attempts-db.ts`), and the chain
stays hash-only exactly as decided. The other is that
**the milestone's own wording for #158 was wrong** — it asked for eviction
"sized against the token lifetimes OAuth gave them", and a pooled client never
held a token, because #256 gave it a credential *source* it asks per request.
The roadmap records that difference. It is worth knowing here because the same
false premise is the obvious thing to re-derive: OAuth is a reason **not** to
evict, and what made eviction necessary was #150's session state plus key drift.

It was first written as "breadth"; the roadmap records why Discord and Temporal
were dropped rather than deferred, and advanced scheduling is parked as #358
beside #348.

What exists:

| Package | What it is |
| --- | --- |
| `packages/atomic-write` | The durable-replace recipe, once — write a whole temporary sibling, fsync it, rename it over the target, fsync the directory. Two exports and no dependencies at all, which is what lets both services and the published CLI import it (#272) |
| `packages/schema` | The single source of truth for shapes both services use: the zod team sheet, name primitives, egress patterns, tool call and response, tool listing, refusals, spend report, proxy error, approval ticket and decision, the audit record, the memory ops, and the skill file and its two operations |
| `packages/agent` | The model half — provider-agnostic completion and embedding layers, ReAct loop with per-task caps, the post-reply curation and skill-author turns, the thread-summarization and ambient-heartbeat turns, and the mTLS client that reaches tools through the proxy and nowhere else |
| `packages/proxy` | The security boundary — mTLS listener, per-channel identity, team-sheet enforcement on both gates, the credential vault, the OAuth token store and its mint/refresh engine, injection and redaction, the MCP client over the official SDK and its pool, `search_channel_history` and `schedule_task` as built-ins, the budget meter in calls and in dollars, the append-only and hash-chained audit log, and the approval ticket store |
| `packages/gateway` | The Slack Socket Mode adapter — mentions, ordinary messages, approval-card rendering and click decoding, the live-checklist renderer, the proactive post's verb and renderer, the app's own identity and workspace off one `auth.test`, and a reconnect ladder it owns rather than the SDK |
| `packages/memory` | The per-channel store — one SQLite file per channel, an FTS5 index, the delete and edit paths, the curated `MEMORY.md`, thread summaries and the two quiet-thread reads, a sqlite-vec embeddings table, the `skills/` directory and the index that follows it, the `proposals/` directory beside it, and a read-only opener the proxy uses |
| `packages/cli` | The operator's host-side commands — `init`, `channel`, `doctor`. The only npm-published package: one bundled file, plus a build-time copy of `scripts/dev-certs.sh` |
| `apps/server` | The gateway + agent process — env parsing, mention and message handling, the channel router, the one query embedding a task pays for, semantic recall and skill retrieval over it, the quiescence sweep, the skill-embedding pass, the skill lifecycle job and the merge curator, the ambient clock and its channel enumerator, the proactive post surface and its rate window, the heartbeat evaluation and its pregate, approvals and checklist clients, lifecycle |
| `apps/proxy-server` | The process composing the proxy, plus `vault`, `grant`, `budget` and `audit` entrypoints for the operator |
| `e2e/` | The security suite's rig: the proxy spawned as its built entrypoint, the agent side composed in-process, attacked by a scripted model and — on request — running the four background passes and the ambient clock |
| `design/` | The design system — plain CSS, no TypeScript, outside the workspace |
| `site/` | getlibero.com — Astro + Starlight, outside the workspace |

Both halves are wired end to end: a mention runs a task, tool calls go over mTLS
to the proxy, GitHub is called for real, holds raise approval cards, spend meters
per turn, and every decided call leaves an audit row. Memory is whole as of
phase 2: a channel's messages are searchable, its `MEMORY.md` is curated after a
reply and read back before the next task, its quiet threads are summarized and
embedded, and a task starts with whatever of that bears on the question.

Everything below the phase line is a **pointer, not a record**. What each
workstream decided is argued in the README or the header of the code it governs,
and the table under "Where the reasoning lives" says which file — the phase 3 and
phase 4 narratives that used to sit here were a hundred lines restating
`apps/server/README.md`, which is exactly what this file's own rule forbids.
`site/src/content/docs/docs/roadmap.md` is the phase record, including the three
phase 3 clauses that landed differently from its own wording.

## Where the reasoning lives

**This file is not the design record.** A decision about how one package behaves
belongs in that package's README or in the file's own header comment, which is
where someone editing it will actually meet it. Keep it that way: this section is
a map, not a summary, and a paragraph added here that could have gone next to the
code is a paragraph the next reader will not find.

| Question | Read |
| --- | --- |
| What the loop does, the callback contracts, how a tool name is resolved, what a turn reports, why embeddings are a second seam, what the summarization turn assumes, what the skill-author turn sees of a task that curation deliberately does not, and why the merge turn takes no handler | `packages/agent/README.md` |
| Enforcement, the vault, MCP client and pool, built-ins, listing bounds, budgets, why the budget read is advisory rather than a second enforcement point, approvals, the audit log's write discipline, what the hash chain catches and the four things it does not, why the unique index on `prev_hash` does more than the chain alone, why argument capture in the chain was declined rather than deferred, and the off-chain attempt store built beside that decision (#364) | `packages/proxy/README.md` |
| Sessions and the queue, follow-ups, the transcript a task starts from, the checklist, the approvals client half, the environment contract, where recall and skill retrieval enter a task and why neither is a tool, why one embedding serves both, how the two skill legs are fused and what bounds them, why the post-reply turns are one thunk, what counts toward the author threshold, what bounds the quiescence sweep, why skills are embedded on channel activity rather than at task head, what `stale` means to retrieval and why, how the lifecycle job tells a hand-set status from its own, why a merge proposal is a file rather than a message, why the ambient clock enumerates the filesystem, wakes at the next due instant, and skips the windows it was down for, why the proactive post surface is minted in the composition, why its window is four hours, why its two sources are named for the wake reason, and what the heartbeat's pregate asks in what order, why its watermark makes a finding say-once, and why a shut window defers rather than loses | `apps/server/README.md` |
| Slack normalization, the three subscriptions, card rendering, how the app learns its own id and its workspace from one `auth.test`, why the channel-post verb is a second exception to the `CardPoster` narrowing and a different kind of one, the three rules that package keeps | `packages/gateway/README.md` |
| The three reads, the isolation boundary, the tokenizer, why `search` takes text, why `MEMORY.md` has no lock, what `allowExtension` does and does not open, why the vec table is created lazily, why a thread summary has a shape, why reconciliation is the skill index's only writer, why `nearest` takes a kind, why `searchSkills` ORs its terms where `search` ANDs them, why `idleThreads` is not `staleThreads` with another argument, why the lifecycle job's two stamps are two methods rather than one, why the proposals directory has no `read`, and why no trigger drops a considered pair | `packages/memory/README.md` |
| Operator commands and the vault CLI, and what `audit verify`'s four exit codes are a contract for | `apps/proxy-server/README.md` |
| The shapes both services agree on. No README — each file's own header is the record, `src/skill.ts` and `src/audit.ts` most of all | `packages/schema/src/*.ts` |
| What the published CLI owns, why the schema is bundled rather than published, why `channel add` writes a pin, and what `doctor` refuses to check | `packages/cli/README.md` |
| The harness API, what is faked, why the positive control matters, which sheet blocks are off by default in a rig and why, why ambient is off twice and why `rig.heartbeat` scans twice, why each audit tamper case gets its own `VACUUM INTO` copy, and the one fake embedder's shape and the rule it carries | `e2e/README.md` |
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

The test for belonging here is that **the constraint binds code outside the
package that documents it.** Some of these are argued at length elsewhere —
`packages/memory/README.md` makes the leaf case, `refusal.ts`'s header draws the
refusal/error line — and they are still restated here, because the person who
needs them is adding an import in `apps/server` or wording an error in a route,
and will not be reading that README first. A rule nobody meets at the moment they
would break it is not enforced by being written down somewhere reasonable.

Keep each entry to the rule and its reason. The argument belongs where the code
is; what belongs here is enough to stop someone, and a pointer.

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

**The published CLI and the proxy's entrypoints own different things** (#98).
The CLI owns what the operator authors on the host — the channels directory, the
certificates, the env file, all bind-mounted `:ro` into the services. The proxy's
own entrypoints (`vault`, `grant`, `budget`, `audit`) own what the services own
inside their named volumes, which the host cannot open. That is why reading the
audit log is `node dist/audit.js` and not `npx @getlibero/cli audit`: the latter
would be a command whose first act is to open a path that is not there. What the
CLI ships instead of depending on the workspace — one bundled file and no
declared dependencies — is `packages/cli/README.md`'s account.

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
- **Where something landed differently from the roadmap's own wording, the
  roadmap records the difference** rather than the definition of done being
  ticked as though it had not happened. Phase 3 has three of these and phase 5
  has three; a box ticked against a sentence that turned out to be untrue is
  worse than no box, because the next reader has no way to tell which.
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

  **Minting material and authorizing it are two acts**, so that a change to
  which key may speak for a channel is a reviewable edit in git.
  `scripts/dev-certs.sh` never writes a sheet, and `libero channel add` is not an
  exception — it writes both only where there is no prior sheet to diff, and
  refuses outright on a channel that has one. `packages/cli/README.md` has the
  argument; if you are tempted to let `add` merge into an existing sheet, that is
  the rule you would be giving up.
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
  permissions.

  One thing moved with it: the directory existing is no longer the operator's
  statement that the channel exists, so the sheet check is explicit in
  `apps/server/src/session/store.ts` — a second caller that skipped it would be
  inventing a channel with no authorization behind it. Since #64 the proxy mounts
  that same root read-only through `openMessageReader`, which is one direction
  across the line and does not weaken the rule: the hazard is the agent writing
  where the proxy reads *authorization*, and the store is neither.

  **The line is whose data it is and who reads it, not how much of it there
  is.** Content belongs to a channel's members and is read on their behalf, so a
  cross-channel join is one channel's members seeing another's conversation.
  Operator-facing tables — the budget meter and the audit log — are read by the
  operator, and cross-channel aggregation there is a feature rather than a
  hazard: a team asking how a workspace is tracking against its caps needs
  exactly the query the per-file layout would forbid. So those two are single
  files with a `channel` column, decided in #96 and #97 rather than drifted into,
  and what has to hold instead is that channel members cannot manipulate the
  numbers and that aggregate reads stay off the interface the server closes over.

  **Every SQL string in `packages/proxy` lives in the module that opens the
  database it runs against** — `budget-db.ts`, `audit-db.ts` and
  `attempts-db.ts`, and no others — so "no statement omits `WHERE channel = ?`"
  is checkable by reading one file per database. (The attempt store has no
  channel column at all: it is content-addressed, and the audit rows are its
  index — its header makes that case.) A statement prepared in a route, a
  writer or an admin helper is a review failure.
  `packages/proxy/README.md` has the rest: the meter's surface, the audit log's
  write discipline, and why there is no retention command.
- **`packages/schema` is the single source of truth** for team sheets, audit
  records, tool calls, approvals, and memory ops. Both services import from it —
  `packages/agent` since #109, which is what makes "the two ends agree on one
  definition" true rather than aspirational — so don't redefine those shapes
  locally. `channels/example/channel.toml` is the documented starter sheet and
  should stay in sync with the zod schema.

  There is no README here; each shape's own header is the record, and two are
  worth knowing before you touch them. `src/skill.ts` is the one shape that is
  also a *file format*, so its grammar is a compatibility surface rather than an
  implementation detail. `src/audit.ts` is the one that never crosses the wire,
  and it is a **type with no zod object** on purpose — a `.parse()` is how a
  channel gets taken from a request body.

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
Docker images built from `deploy/docker-compose.yml`. **One `v*` tag releases
the whole deployment** — it triggers `release-cli.yml` (npm publish with
provenance attestations) and the image publish (#313). `cli-v*` is retired.
`RELEASING.md` at the repo root is the release procedure and the tag scheme's
record, including the environment tag policy that lives in repo settings
rather than in git.

It publishes **one file and no dependencies**: `packages/cli/build.mjs` bundles
`@getlibero/schema` and `@getlibero/atomic-write` in with esbuild, and the
workflow deletes `devDependencies` before `npm publish` so the workspace edges
never reach the registry. See `packages/cli/README.md` for why that, rather
than publishing them.
