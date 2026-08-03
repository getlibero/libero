---
title: Contributing
description: The ground rules CI enforces, what the project most needs, and how to get a development environment running.
---

The canonical version of this lives in
[CONTRIBUTING.md](https://github.com/getlibero/libero/blob/main/CONTRIBUTING.md) in the
repository. This page is the short form.

## Where to ask

[Discord](https://discord.gg/7JXpyBa6ZJ) is for questions, design discussion, and checking whether
anyone is already on something. [GitHub issues](https://github.com/getlibero/libero/issues) are for
bugs and feature requests, so they stay searchable and can be scheduled into a phase. Neither is
for vulnerabilities — use private reporting, described in the
[security model](/docs/security).

A decision only counts once it is written down in an issue or a pull request. Discord is for
working things out, not for recording them.

## Ground rules CI enforces

- **`packages/agent` may never import `packages/proxy`.** The only path from agent to tools is the
  network call. An ESLint `no-restricted-imports` rule and a grep-level CI job enforce this; pull
  requests that route around either will not merge, regardless of how convenient it is.
- **MIT/Apache-2.0 dependencies only** in the core. The license gate fails the build on copyleft.
  Per [GOVERNANCE.md](https://github.com/getlibero/libero/blob/main/GOVERNANCE.md), AGPL/SSPL and
  commercially-licensed packages are excluded; the latter are allowed only as optional,
  user-installed adapters.
- **`packages/proxy` requires CODEOWNERS review.** The proxy is the security boundary; changes
  there get extra scrutiny by design.
- **Privileged workflows must not check out code.** Any `pull_request_target` workflow containing
  an `actions/checkout` step fails CI.
- TypeScript strict, lint, and tests must pass.

## CLA

A Contributor License Agreement (Apache-style) is required from your first pull request; a bot
will prompt you in CI. The rationale is documented in GOVERNANCE.md — it is short, and it was
written before you asked.

## What the project most needs

The [roadmap](/docs/roadmap) is phase-gated, and the priority is the governed core: vault,
team-sheet enforcement, approval broker, budget meter, audit log, and the e2e security suite that
attacks them. Features that outpace the proxy will be politely parked.

## Following along

Work is planned in [public GitHub issues](https://github.com/getlibero/libero/issues); there is
no separate tracker. One milestone per phase carries the phase's definition of done, and the open
milestone is the current phase. Each workstream is a `tracking` issue holding PR-sized
sub-issues; ordering is expressed with blocked-by relationships, so filtering out blocked issues
shows what is workable now. Valid work that belongs to a later phase is labeled `parked` rather
than closed, and picked up when its phase opens.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Node 22+, pnpm 9+. The e2e harness — mock Slack plus a mock MCP server — lands in `e2e/` with
phase 1.

The `packageManager` field pins pnpm 9.15.0. On Node 22–24, `corepack enable` reads that field and
provisions it. Corepack was removed from Node in v25, so on newer runtimes install the pinned
version directly:

```bash
npm install -g pnpm@9.15.0
```

## This site

The site lives in `site/` and is deliberately outside the pnpm workspace, so Astro's dependency
tree stays out of the core license gate and the root `pnpm -r` scripts.

```bash
cd site
pnpm install
pnpm dev
```

It reads `design/tokens.css` and `design/libero.css` directly rather than vendoring copies. The
design spec is locked: do not introduce a colour, font, radius, or component shape that is not
already in it.
