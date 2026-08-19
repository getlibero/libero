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
  <img alt="Status: Phase 5, pre-release" src="https://img.shields.io/badge/status-phase_5-8FA39D?style=flat-square&labelColor=131A18">
  <a href="https://getlibero.com/discord"><img alt="Discord: join the server" src="https://img.shields.io/badge/discord-join-1BA85A?style=flat-square&labelColor=131A18"></a>
</p>

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

Governance first, features second: tool credentials never enter the agent process, its tool surface is a deterministic per-channel allowlist, dangerous calls require a human click, and everything lands in an append-only audit log.

> **Why "libero"?** In football, the libero is the free player — the one who sweeps up behind the team, covering whatever gets through. That's the job here: an AI teammate in your Slack channels that handles the work nobody's on, under rules your admins write. And like the libero in volleyball — the specialist who plays under explicit restrictions, marked by a different jersey — this agent is visibly *not* a user: it acts only as itself, only through an allowlisted tool proxy, with every action audited. Free player, firm rules.

## Status

Pre-release. Phases 1 through 4 are done, so the quick start below is the whole of it: three CLI commands and `docker compose up` stand a deployment up from a clean checkout. It is still not something to point at a workspace you care about.

What exists is the tool proxy: mutual TLS, per-channel identity taken from the client certificate, team-sheet enforcement on both gates, a vault encrypted at rest, credential injection into outbound calls, a redaction pass that scrubs echoed secrets out of results, the MCP client and its pool with a per-upstream concurrency limit, OAuth against upstreams that need it — the proxy discovers, mints, stores and rotates the token, and the agent never sees it (#157) — the budget meter in calls and in dollars, failing closed on an unpriced model (#62), the append-only audit log, and the approval broker. The Slack gateway and the agent loop reach tools through the proxy and nowhere else, report what each model turn cost, and drain in-flight work on SIGTERM so the last turn's spend is not lost (#118).

The end-to-end security suite is written (#41). It runs the proxy as its real built entrypoint and the agent side in process, fakes exactly two things — the Slack socket and the model — and attacks all four of phase 1's definition-of-done properties, one file each: a prompt-injected agent cannot exfiltrate a secret, call an unlisted tool, exceed its budget, or act destructively without a human click. A scripted authorization server attacks the OAuth token path beside them (#258), and the skill layer is attacked in both halves: a playbook authored and retrieved (#293), and the four background passes that maintain one — the two that write into a team's own directory included (#308).

GitHub is behind the dispatcher and the governed path completes against it for real (#130) — allowlist, approval, budget, call, redaction, audit — so the served-call path is no longer proven only against a fake. Approvals are joined end to end (#126, #127): a held call raises an amber card in the channel, and an approver's click re-submits the identical call with the ticket. Both images build from `deploy/docker-compose.yml` and CI builds them on every change (#86). The soft in-thread budget warning reaches the channel before a hard limit refuses anything, and `search_channel_history` is a proxied built-in the model can call on demand (#64).

The gaps that matter. Certificate revocation is an edit to a team sheet, and there is no CRL by design — rotation is two commands with that edit between them, without downtime. `[egress]` is validated when a sheet loads and enforced nowhere, because the surface it governs — a code-execution sandbox — is later work (#219). Memory is whole as of phase 2 — the per-channel store and its index, a curated `MEMORY.md` read back into a task's context, and semantic recall over thread summaries. Two limits there are stated rather than hidden: recall applies no distance cutoff (#283), so a small corpus contributes all of itself, and a long thread becomes one summary and therefore one vector (#284). Skills are whole as of phase 3 — a playbook written after a tool-heavy task, retrieved into a later one, aged by a job that spends nothing, and proposed for merging as a document a person applies by hand. Two limits there are stated too: a deployment with no embedding provider retrieves skills on full text alone and proposes no merges at all, because overlap is a question about two vectors; and a skill the index has truncated past `[skills] max_skills` is one no clock ages. Ambient mode is whole as of phase 4 — a heartbeat that speaks only when something merits it, a rate window it cannot talk its way past, and `schedule_task`, whose create is allowlisted, held for a human by default, capped and audited, and whose check fires at its own instant. Two limits there are stated rather than hidden: a fired check is one turn over the channel's recent messages and can look nothing up (#348), so "every call it induces meets the proxy's gates" is true because it induces none; and cancelling a check leaves no record that it was cancelled (#349). Phase 5 is hardening, which is where the work now is.

See the [roadmap](https://getlibero.com/docs/roadmap) and [architecture](https://getlibero.com/docs/architecture) — the documentation now lives on the site, sourced from [`site/src/content/docs/`](site/src/content/docs/docs).

## Architecture in one paragraph

Two services. The **gateway + agent** (service 1) connects to Slack over Socket Mode, routes each `(workspace, channel)` to a shared session, and runs a provider-agnostic agent loop. The **tool proxy** (service 2) holds every tool credential, enforces each channel's **team sheet** (a git-managed TOML manifest declaring allowed tools, budgets, and approval requirements), brokers human-in-the-loop approvals, meters spend, and writes the audit log. The agent reaches tools only through the proxy; compromise of the agent process yields no tool credentials. It holds the Slack tokens and the model provider key — the gateway cannot open the socket without them — and those reach nothing a team sheet governs.

## Quick start

```bash
npx @getlibero/cli init                          # writes deploy/.env, generates the vault master key
npx @getlibero/cli channel add C024BE91L         # a team sheet and the certificate that speaks for it
npx @getlibero/cli doctor                        # says what is still wrong before you start anything
docker compose -f deploy/docker-compose.yml up   # starts gateway+agent and proxy
```

Run these from the root of a checkout, and fill the Slack tokens and the provider key in
`deploy/.env` before the last two — `doctor` names whatever is still missing. The channel starts
able to call nothing; granting it a tool is an edit to the sheet `channel add` wrote, which
[self-hosting](https://getlibero.com/docs/self-hosting) walks through.

## Repository layout

```
packages/schema    zod schemas — single source of truth for team sheets, audit records, tool calls
packages/gateway   Slack adapter — Socket Mode, mention intake, approval-card rendering
packages/agent     provider-agnostic agent loop + the proxy client
packages/proxy     credential vault, team-sheet enforcement, HITL broker, budgets, audit
packages/memory    per-channel SQLite store: messages with FTS5, thread summaries, skills, sqlite-vec
packages/cli       @getlibero/cli — the operator's host-side commands; the only npm-published package
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
