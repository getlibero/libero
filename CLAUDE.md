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
```

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

Early phase 1. `packages/schema` (zod team-sheet schema, tool call, spend
report, refusal, listing, and proxy error shapes), `packages/agent`
(provider-agnostic completion layer, ReAct loop with per-task caps),
`packages/proxy` (mTLS listener, per-channel identity, team-sheet enforcement
on both gates, the credential vault, credential injection into outbound HTTP
calls, the redaction pass on the way back, and the daily budget meter over
`node:sqlite`), `apps/proxy-server` (the process composing all of it — a
permitted call is now served rather than answered 501, plus a `budget`
entrypoint alongside `vault` for the operator),
`packages/gateway` (the Slack Socket Mode adapter — mention in, handler, reply
into the thread, and a reconnect ladder the gateway owns rather than the SDK),
`apps/server` (the gateway + agent process — env parsing, the mention handler,
lifecycle), `packages/cli` (placeholder npm release), `design/` (the design
system — plain CSS, no TypeScript), and `site/` (getlibero.com).
`packages/memory` is a README stub and `e2e/` is empty.

**The agent answers, and calls no tools.** `apps/server` composes gateway +
loop, so `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `AGENT_PROVIDER`, `AGENT_MODEL`,
and the provider key are live. The tool source is `createStubToolSource()` and
lists nothing — the agent reaches no tool because the client that would is not
written (see below). `apps/server/README.md` has the environment contract; the
per-channel model override and the sheet's `[llm]` caps are not read, and
`DEFAULT_AGENT_LOOP_CAPS` applies to every channel until the session router
(#65) resolves a sheet per channel.

**Two services, one Dockerfile short of running under compose.**
`deploy/docker-compose.yml` builds both images from paths that do not exist
(#86), so `docker compose up` fails on a clean checkout. Run either process
directly in the meantime.

**No proxy client exists, which is the largest remaining gap and has no issue
of its own.** Nothing in `packages/agent` or `apps/server` speaks to the proxy:
`PROXY_URL`, `PROXY_TLS_CA`, and `PROXY_CLIENT_CERT_DIR` in
`deploy/docker-compose.yml` are read by no code. Three things wait on it — a
real `ToolSource` (`GET /v1/tools`), a real `ToolExecutor`
(`POST /v1/tools/call`), and the spend report (`POST /v1/spend`, built, tested
over real mTLS, and idempotent). So `daily_tokens` meters at zero in a live
deployment and only `daily_tool_calls` would bite. When it lands,
`packages/agent` gains its first `@getlibero/schema` dependency and
`loop/caps.ts:totalTokens` can be revisited.

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
- No Projects board. Milestone + labels + the issue list is the whole system.

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
  `boundary-check` job in CI. Do not route around either.
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
  Operator-facing tables — the budget meter, and the audit log when it lands —
  are read by the operator, and cross-channel aggregation there is a feature
  rather than a hazard: a team asking how a workspace is tracking against its
  caps needs exactly the query the per-file layout would forbid.

  So the budget meter is one file keyed `(channel, day)`, decided in #96 rather
  than drifted into. What has to hold instead is that **channel members cannot
  manipulate the numbers**: the channel comes from the certificate, every write
  is `x = x + n`, and the server's whole surface on the meter is `read`,
  `recordToolCall`, `recordTokens` — clearing a counter lives in
  `budget-admin.ts`, which the server never imports. Keep all three. Also keep
  **every SQL string in `packages/proxy` in `src/budget-db.ts`**, so
  "no statement omits `WHERE channel = ?`" is checkable by reading one file.

  **Aggregate reads go on the operator path** (`budget-admin.ts`), never on the
  interface the server closes over. Reading one channel is a serving concern;
  reading all of them is an operator concern.
- **`packages/schema` is the single source of truth** for team sheets, audit
  records, tool calls, approvals, and memory ops. Both services import from it;
  don't redefine those shapes locally. `channels/example/channel.toml` is the
  documented starter sheet and should stay in sync with the zod schema.
  Today only the team sheet is implemented — `src/team-sheet.ts`, ~60 lines. The
  rest of that list is where those shapes go when the code needing them lands,
  not something you can import yet.

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

- **License gate:** MIT/Apache-2.0-class dependencies only in core. Per
  `GOVERNANCE.md`, AGPL/SSPL and commercially-licensed packages (including the
  Anthropic Claude Agent SDK) are excluded; the latter is allowed only as an
  optional, user-installed adapter.
- **Privileged workflows must not check out code.** `.github/workflows/cla.yml`
  runs under `pull_request_target` with a write token; the `workflow-guard` CI
  job fails any `pull_request_target` workflow containing an
  `actions/checkout` step. Third-party actions in those workflows are pinned to
  a SHA, not a tag.
- **CODEOWNERS review** covers `packages/proxy`, `packages/schema`, and
  `.github/` (currently inert — the teams don't exist yet; see the note in
  `.github/CODEOWNERS`).
- **CLA** required from the first external PR, checked by a bot.

## Release

`@getlibero/cli` is the only npm-published package; everything else ships as
Docker images built from `deploy/docker-compose.yml`. Pushing a `cli-v*` tag
triggers `release-cli.yml`, which publishes with npm provenance attestations.
