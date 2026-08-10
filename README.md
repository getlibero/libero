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
  <img alt="Status: Phase 1, pre-release" src="https://img.shields.io/badge/status-phase_1-8FA39D?style=flat-square&labelColor=131A18">
  <a href="https://getlibero.com/discord"><img alt="Discord: join the server" src="https://img.shields.io/badge/discord-join-1BA85A?style=flat-square&labelColor=131A18"></a>
</p>

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

Governance first, features second: tool credentials never enter the agent process, its tool surface is a deterministic per-channel allowlist, dangerous calls require a human click, and everything lands in an append-only audit log.

> **Why "libero"?** In football, the libero is the free player — the one who sweeps up behind the team, covering whatever gets through. That's the job here: an AI teammate in your Slack channels that handles the work nobody's on, under rules your admins write. And like the libero in volleyball — the specialist who plays under explicit restrictions, marked by a different jersey — this agent is visibly *not* a user: it acts only as itself, only through an allowlisted tool proxy, with every action audited. Free player, firm rules.

## Status

Pre-release (Phase 1, part-built). Nothing here is ready to deploy yet.

What exists is most of the tool proxy: mutual TLS, per-channel identity taken from the client certificate, team-sheet enforcement on both gates, a vault encrypted at rest, credential injection into outbound calls, a redaction pass that scrubs echoed secrets out of results, the daily budget meter, the append-only audit log, and the approval broker — so a permitted tool call is now served rather than answered 501. The Slack gateway and the agent loop exist too, and report what each model turn cost, so both halves of the budget bite. Approvals are joined end to end (#126, #127): a held call raises an amber card in the channel, and an approver's click re-submits the identical call with the ticket — proven against a stub Slack in the acceptance suite.

The gaps that matter. There is no real MCP server behind the dispatcher yet (#39), so the served-call path is proven against stubs rather than a real tool. The soft in-thread budget warning is not built, so a hard limit refuses rather than warns. There is no memory, and no end-to-end suite attacking any of it (#41) — which is the one that decides whether the security property holds, and it is why none of this is ready to deploy.

See the [roadmap](https://getlibero.com/docs/roadmap) and [architecture](https://getlibero.com/docs/architecture) — the documentation now lives on the site, sourced from [`site/src/content/docs/`](site/src/content/docs/docs).

## Architecture in one paragraph

Two services. The **gateway + agent** (service 1) connects to Slack over Socket Mode, routes each `(workspace, channel)` to a shared session, and runs a provider-agnostic agent loop. The **tool proxy** (service 2) holds every tool credential, enforces each channel's **team sheet** (a git-managed TOML manifest declaring allowed tools, budgets, and approval requirements), brokers human-in-the-loop approvals, meters spend, and writes the audit log. The agent reaches tools only through the proxy; compromise of the agent process yields no tool credentials. It holds the Slack tokens and the model provider key — the gateway cannot open the socket without them — and those reach nothing a team sheet governs.

## Quick start (target UX — not live yet)

```bash
npx @getlibero/cli init      # scaffolds config + secrets on the host
docker compose up            # starts gateway+agent and proxy
```

## Repository layout

```
packages/schema    zod schemas — single source of truth for team sheets, audit records, tool calls
packages/gateway   Slack adapter — Socket Mode, mention intake, approval-card rendering
packages/agent     provider-agnostic agent loop + the proxy client
packages/proxy     credential vault, team-sheet enforcement, HITL broker, budgets, audit
packages/memory    per-channel SQLite message store with FTS5 (sqlite-vec recall is phase 2)
packages/cli       @getlibero/cli — the only npm-published package (placeholder release)
apps/server        composes gateway + agent + the channel router (service 1)
apps/proxy-server  composes proxy (service 2)
deploy/            docker-compose + optional LiteLLM sidecar
channels/example/  documented starter team sheet
design/            design system — tokens, component CSS, brand SVGs, reference page
site/              getlibero.com — Astro + Starlight; outside the pnpm workspace
e2e/               the security suite: both halves composed, driven by a scripted model
```

**Package boundary rule:** `agent` may never import `proxy`. The only path from agent to tools is the network call. This is enforced by lint + CI, not convention.

## Design

The brand, colour tokens, and component styles live in [`design/`](design/README.md) — plain CSS and SVG, no build step. Open `design/index.html` for the live reference: every token and component, dark and light. Dark is the default; light is a peer, not an inversion. The spec is locked, so changes start upstream in the design project rather than in the CSS.

[`site/`](site/README.md) imports those files directly rather than vendoring them, so the published site and the spec cannot drift.

## License

MIT, for the entire core — proxy included. See [LICENSE](LICENSE) and [GOVERNANCE.md](GOVERNANCE.md) (including why we use a CLA).

## Security

See [SECURITY.md](SECURITY.md) for the threat model summary and how to report a vulnerability.
