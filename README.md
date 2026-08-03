<p align="center">
  <img src="design/brand/mark.svg" width="72" height="72" alt="">
</p>

<h1 align="center">libero</h1>

<p align="center">
  <b>The open-source AI teammate for Slack.</b><br>
  Self-hosted, credential-isolated, every tool call audited.
</p>

<p align="center">
  <a href="https://getlibero.com">getlibero.com</a> ·
  <a href="https://getlibero.com/docs/architecture">Architecture</a> ·
  <a href="https://getlibero.com/docs/roadmap">Roadmap</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="design/README.md">Design</a> ·
  <a href="https://getlibero.com/discord">Discord</a>
</p>

<p align="center">
  <a href="https://getlibero.com"><img alt="Site: getlibero.com" src="https://img.shields.io/badge/site-getlibero.com-1BA85A?style=flat-square&labelColor=131A18"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-1BA85A?style=flat-square&labelColor=131A18">
  <img alt="Status: Phase 0, pre-release" src="https://img.shields.io/badge/status-phase_0-8FA39D?style=flat-square&labelColor=131A18">
  <a href="https://getlibero.com/discord"><img alt="Discord: join the server" src="https://img.shields.io/badge/discord-join-1BA85A?style=flat-square&labelColor=131A18"></a>
</p>

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

Governance first, features second: the agent process never holds a secret, its tool surface is a deterministic per-channel allowlist, dangerous calls require a human click, and everything lands in an append-only audit log.

> **Why "libero"?** In football, the libero is the free player — the one who sweeps up behind the team, covering whatever gets through. That's the job here: an AI teammate in your Slack channels that handles the work nobody's on, under rules your admins write. And like the libero in volleyball — the specialist who plays under explicit restrictions, marked by a different jersey — this agent is visibly *not* a user: it acts only as itself, only through an allowlisted tool proxy, with every action audited. Free player, firm rules.

## Status

Pre-release (Phase 0). Nothing here is ready to deploy yet. See the [roadmap](https://getlibero.com/docs/roadmap) and [architecture](https://getlibero.com/docs/architecture) — the documentation now lives on the site, sourced from [`site/src/content/docs/`](site/src/content/docs/docs).

## Architecture in one paragraph

Two services. The **gateway + agent** (service 1) connects to Slack over Socket Mode, routes each `(workspace, channel)` to a shared session, and runs a provider-agnostic agent loop. The **tool proxy** (service 2) holds all credentials, enforces each channel's **team sheet** (a git-managed TOML manifest declaring allowed tools, budgets, and approval requirements), brokers human-in-the-loop approvals, meters spend, and writes the audit log. The agent reaches tools only through the proxy; compromise of the agent process yields zero secrets.

## Quick start (target UX — not live yet)

```bash
npx @getlibero/cli init      # scaffolds config + secrets on the host
docker compose up            # starts gateway+agent and proxy
```

## Repository layout

```
packages/schema    zod schemas — single source of truth for team sheets, audit records, tool calls
packages/gateway   Slack adapter, channel router, checklist + approval-card rendering
packages/agent     agent loop, context assembler, memory curation, skills
packages/proxy     credential vault, team-sheet enforcement, HITL broker, budgets, audit
packages/memory    per-channel SQLite (FTS5 + sqlite-vec), MEMORY.md tooling
packages/cli       @getlibero/cli — the only npm-published package
apps/server        composes gateway + agent (service 1)
apps/proxy-server  composes proxy (service 2)
deploy/            docker-compose + optional LiteLLM sidecar
channels/example/  documented starter team sheet
design/            design system — tokens, component CSS, brand SVGs, reference page
site/              getlibero.com — Astro + Starlight; outside the pnpm workspace
e2e/               mock Slack + mock MCP harness; the security suite lives here
```

**Package boundary rule:** `agent` may never import `proxy`. The only path from agent to tools is the network call. This is enforced by lint + CI, not convention.

## Design

The brand, colour tokens, and component styles live in [`design/`](design/README.md) — plain CSS and SVG, no build step. Open `design/index.html` for the live reference: every token and component, dark and light. Dark is the default; light is a peer, not an inversion. The spec is locked, so changes start upstream in the design project rather than in the CSS.

[`site/`](site/README.md) imports those files directly rather than vendoring them, so the published site and the spec cannot drift.

## License

MIT, for the entire core — proxy included. See [LICENSE](LICENSE) and [GOVERNANCE.md](GOVERNANCE.md) (including why we use a CLA).

## Security

See [SECURITY.md](SECURITY.md) for the threat model summary and how to report a vulnerability.
