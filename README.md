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
  <a href="https://github.com/getlibero/libero/releases/tag/v0.4.0"><img alt="Release: v0.4.0" src="https://img.shields.io/badge/release-v0.4.0-1BA85A?style=flat-square&labelColor=131A18"></a>
  <a href="https://getlibero.com/discord"><img alt="Discord: join the server" src="https://img.shields.io/badge/discord-join-1BA85A?style=flat-square&labelColor=131A18"></a>
</p>

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

Governance first, features second: tool credentials never enter the agent process, its tool surface is a deterministic per-channel allowlist, dangerous calls require a human click, and everything lands in an append-only audit log.

> **Why "libero"?** In football, the libero is the free player — the one who sweeps up behind the team, covering whatever gets through. That's the job here: an AI teammate in your Slack channels that handles the work nobody's on, under rules your admins write. And like the libero in volleyball — the specialist who plays under explicit restrictions, marked by a different jersey — this agent is visibly *not* a user: it acts only as itself, only through an allowlisted tool proxy, with every action audited. Free player, firm rules.

## Status

`v0.4.0` is current: the CLI on npm and the service images on GHCR, each with provenance attestations, a [changelog](https://getlibero.com/docs/changelog) an operator can upgrade by, and a written release procedure (`RELEASING.md`). The quick start below is the whole of standing it up: three CLI commands and `docker compose up`, from a clean checkout or from the published images.

What runs. The tool proxy: mutual TLS, per-channel identity taken from the client certificate, team-sheet enforcement on both gates, a vault encrypted at rest, credential injection into outbound calls and a redaction pass that scrubs them back out of results, the MCP client and its pool, OAuth against upstreams that need it with the token minted and rotated inside the proxy, the budget meter in calls and in dollars, the hash-chained audit log with an operator command that walks it, and the approval broker whose Slack card re-submits the identical call on a click. On top of it: per-channel memory with a curated `MEMORY.md` and semantic recall over thread summaries; skills — a playbook written after a tool-heavy task, retrieved into a later one, aged by a job that spends nothing, and proposed for merging as a document a person applies by hand; ambient mode — a heartbeat that speaks only when something merits it, a rate window it cannot talk its way past, and `schedule_task`; and, since v0.4.0, code execution in an ephemeral container on a routeless network whose only exit checks the channel's `[egress]` allowlist per host. The Docker socket lives in a third, optional service that holds no credential, so the process with root-equivalent privilege and the process with every tool credential are different ones.

The end-to-end security suite runs the proxy as its real built entrypoint and the agent side in process, fakes exactly two things — the Slack socket and the model — and attacks every property above: a prompt-injected agent cannot exfiltrate a secret, call an unlisted tool, exceed its budget, act destructively without a human click, or reach a host its sheet did not name. It passes against every release, and each changelog entry says so.

What pre-1.0 means. The team-sheet format is the compatibility surface 1.0 will freeze, and a release may still change it — read the changelog's Upgrading section between versions. Certificate revocation is an edit to a team sheet and there is no CRL by design; rotation is two commands with that edit between them, without downtime. Code execution is opt-in twice over — a `[[builtin]]` grant and a runner the deployment chose to start — and its allowlist grants HTTP and HTTPS only. A fired scheduled check is one bounded turn and can look nothing up (#348). Three correctness items are parked on measurements nobody has yet taken (#239, #283, #284). Start in a scratch workspace; nobody outside the project has run this against one they depend on.

The [roadmap](https://getlibero.com/docs/roadmap) is the record of the phases and of where each release landed differently from its own plan; the [architecture](https://getlibero.com/docs/architecture) is the design of record and describes what runs. The documentation lives on the site, sourced from [`site/src/content/docs/`](site/src/content/docs/docs).

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
packages/atomic-write  the durable-replace recipe, once; no dependencies, importable from anywhere
packages/test-kit  it.each, waitFor, and the reporter that fails a run that collected nothing; never published
packages/gateway   Slack adapter — Socket Mode, mention intake, approval-card rendering
packages/agent     provider-agnostic agent loop + the proxy client
packages/proxy     credential vault, team-sheet enforcement, HITL broker, budgets, audit
packages/memory    per-channel SQLite store: messages with FTS5, thread summaries, skills, sqlite-vec
packages/cli       @getlibero/cli — the operator's host-side commands; the only npm-published package
apps/server        composes gateway + agent + the channel router (service 1)
apps/proxy-server  composes proxy (service 2)
apps/runner        sandbox runner (optional service 3) — holds the Docker socket and no credential
e2e/               the security suite's rig — both halves over real mTLS, a scripted model
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
