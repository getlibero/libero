# Contributing to Libero

Thanks for considering a contribution. A few things to know before your first PR.

## CLA

A Contributor License Agreement (Apache-style) is required from your first PR; a CLA bot will prompt you in CI. The rationale is documented in [GOVERNANCE.md](GOVERNANCE.md) — read it, it's short and it was written before you asked.

## Ground rules that CI enforces

- **`packages/agent` may never import `packages/proxy`.** The only path from agent to tools is the network call. An ESLint `no-restricted-imports` rule and a CI check enforce this; PRs that route around it will not merge regardless of how convenient it is.
- **MIT/Apache-2.0 dependencies only** in the core. The license gate fails the build on copyleft.
- **`packages/proxy` requires CODEOWNERS review.** The proxy is the security boundary; changes there get extra scrutiny by design.
- TypeScript strict, lint, and tests must pass.

## What we most need

The roadmap is phase-gated (see [the roadmap](https://getlibero.com/docs/roadmap), sourced from `site/src/content/docs/docs/roadmap.md`), and the priority is the governed core: vault, team-sheet enforcement, approval broker, budget meter, audit log, and the e2e security suite that attacks them. Fun features that outpace the proxy will be politely parked.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Node 20+, pnpm 9+. The e2e harness (mock Slack + mock MCP server) lives in `e2e/`.

### Getting pnpm

The `packageManager` field pins pnpm 9.15.0, which is the version CI resolves.
On Node 20–24, `corepack enable` reads that field and provisions it for you.
**Corepack was removed from Node in v25**, so on newer runtimes it isn't there
and nothing bootstraps pnpm — install the pinned version directly instead:

```bash
npm install -g pnpm@9.15.0
```
