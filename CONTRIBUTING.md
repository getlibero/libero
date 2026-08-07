# Contributing to Libero

Thanks for considering a contribution. A few things to know before your first PR.

## Where to ask

- **[Discord](https://getlibero.com/discord)** — questions, design discussion, and checking whether anyone is already on something.
- **[GitHub issues](https://github.com/getlibero/libero/issues)** — bugs and feature requests, so they stay searchable and can be scheduled into a phase.
- **Neither, for vulnerabilities.** Use private reporting; see [SECURITY.md](SECURITY.md).

A decision only counts once it is written down in an issue or a PR. Discord is for working things out, not for recording them.

## CLA

A Contributor License Agreement (Apache-style) is required from your first PR; a CLA bot will prompt you in CI. The rationale is documented in [GOVERNANCE.md](GOVERNANCE.md) — read it, it's short and it was written before you asked.

## Ground rules that CI enforces

- **`packages/agent` may never import `packages/proxy`.** The only path from agent to tools is the network call. An ESLint `no-restricted-imports` rule and a grep-level check (`pnpm boundary-check`) enforce this; PRs that route around either will not merge regardless of how convenient it is. The grep is a raw string match rather than an import match, so it also fails on a comment that names the proxy package or its path — on this side of the line, write "the tool proxy service".
- **MIT/Apache-2.0 dependencies only** in the core. The license gate fails the build on copyleft. Per [GOVERNANCE.md](GOVERNANCE.md), AGPL/SSPL and commercially-licensed packages are excluded; the latter are allowed only as optional, user-installed adapters.
- **`packages/proxy` requires CODEOWNERS review.** The proxy is the security boundary; changes there get extra scrutiny by design.
- **Privileged workflows must not check out code.** Any `pull_request_target` workflow containing an `actions/checkout` step fails CI.
- TypeScript strict, lint, and tests must pass.

## What we most need

The roadmap is phase-gated (see [the roadmap](https://getlibero.com/docs/roadmap), sourced from `site/src/content/docs/docs/roadmap.md`), and the priority is the governed core: vault, team-sheet enforcement, approval broker, budget meter, audit log, and the e2e security suite that attacks them. Features that outpace the proxy will be politely parked.

## How work is planned

Everything is planned in public GitHub issues; there is no separate tracker.

- **One milestone per roadmap phase**, opened when the phase starts. Its
  description is the phase's definition of done, and the open milestone is the
  current phase — watch it to follow along.
- **One tracking issue per workstream** (label `tracking`), broken into
  sub-issues sized to roughly one PR. Ordering is expressed with GitHub's
  blocked-by relationships, so filtering out blocked issues shows what is
  workable right now.
- **Out-of-phase work is parked, not rejected.** A valid bug report or feature
  that belongs to a later phase gets the `parked` label and no milestone, and
  is picked up when its phase opens. "X from a later phase does not exist yet"
  is parked on sight.
- **The assignee is the in-progress signal.** There is no board and no
  `status:*` label: an issue with no assignee is free, an assigned issue is
  being worked on. Maintainers assign themselves before their first commit and
  unassign if the work stops.
- Issues labeled `help wanted` or `good first issue` are up for grabs. Comment
  on a sub-issue before starting it and a maintainer will assign it to you —
  GitHub only allows assigning users who have participated in an issue, so the
  comment is both the claim and what makes the assignment possible. Say so in
  the thread if you drop
  it; we would rather free the issue than leave it looking taken.
- Open the PR with `Closes #N` in the body, so merging closes the issue.

## Triage

New issues arrive labeled `needs-triage` (the templates apply it). Triage
removes that label by doing exactly one of three things:

- **Accept:** assign the open milestone and `area:*` labels, and attach the
  issue as a sub-issue of the workstream it belongs to, where one fits.
- **Park:** apply `parked` — valid, but belongs to a later phase. Kept open,
  no milestone, picked up when its phase starts.
- **Close:** duplicate, invalid, or a question that belongs in
  [Discord](https://getlibero.com/discord) — with a comment saying which.

Expect an issue to be triaged within a week. If a security-sensitive report is
filed publicly by mistake, we will keep in-thread discussion to a minimum and
ask you to refile it through private vulnerability reporting (see
[SECURITY.md](SECURITY.md)).

**An issue is ready to build against when it is in the open milestone and not
blocked.** An issue that is untriaged or `parked` is not yet accepted — a PR
for one may sit until its phase opens, however good the code is. Check before
writing code; `help wanted` and `good first issue` mark the issues we would
most like a hand with.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm boundary-check                   # agent side names no proxy; not covered by pnpm lint
pnpm license-check                    # allowlisted licenses only; fails on copyleft
```

The last two are the gates from [Ground rules that CI enforces](#ground-rules-that-ci-enforces).
Both run the same script CI runs, so a failure is reproducible in a terminal
rather than only on a push.

Node 22.13+, pnpm 9+ — 22.13 because the budget meter uses the built-in `node:sqlite`, which needs
a flag below that. The e2e harness (mock Slack + mock MCP server) lands in `e2e/` with phase 1.

### Getting pnpm

The `packageManager` field pins pnpm 9.15.0, which is the version CI resolves.
On Node 22–24, `corepack enable` reads that field and provisions it for you.
**Corepack was removed from Node in v25**, so on newer runtimes it isn't there
and nothing bootstraps pnpm — install the pinned version directly instead:

```bash
npm install -g pnpm@9.15.0
```
