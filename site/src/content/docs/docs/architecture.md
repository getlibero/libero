---
title: Architecture
description: The two services, the agent loop, the proxy's five jobs, the team sheet, memory, skills, ambient mode, and the sandbox.
---

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

The design principle everything else follows from: **the agent is visibly not a user**. It acts only as itself, under admin-provisioned service credentials, through an allowlisted proxy, with every action audited. Channel isolation is a hard admin-defined boundary enforced in code, never model self-restraint.

## The two services

Two deployable services plus per-channel state. The security property the whole design hangs on: **tool credentials live only in the proxy**, and the agent reaches tools only through it. The agent process holds the credentials it cannot function without — the Slack app and bot tokens, and the model provider key — and nothing a team sheet governs.

```
Slack (Socket Mode)
      │
      ▼
┌───────────────────────────────┐      ┌──────────────────────────────┐
│  gateway + agent  (service 1) │      │  tool proxy      (service 2) │
│                               │      │                              │
│  Slack adapter                │      │  team-sheet loader/validator │
│  channel router               │ HTTP │  credential vault (encrypted │
│  (workspace, channel) → sess. │─────▶│    at rest, never returned)  │
│  context assembler            │ mTLS │  tool allowlist enforcement  │
│  agent loop (BYO model,       │ local│  MCP client pool             │
│    per-channel override)      │ net  │  HITL approval broker ───────┼──▶ approval cards
│  memory curation turn         │      │  budget meter (tokens/calls) │     in Slack
│  skill author + retriever     │      │  egress allowlist            │
│  checklist renderer           │      │  audit writer (append-only)  │
└──────────────┬────────────────┘      └──────────────┬───────────────┘
               │                                      │
               ▼                                      ▼
   per-channel state dir                    audit.db (append-only)
   ├─ channel.toml   (team sheet, git-managed)        │
   ├─ MEMORY.md      (agent-curated)                  ▼
   ├─ skills/*.md    (agent-authored)         sandbox runner
   └─ store.db       (SQLite+FTS5+sqlite-vec) (containerized code exec)
```

The proxy is a separate OS process listening only on localhost/private network with mutual TLS between services. The agent authenticates to the proxy per-channel: one client certificate per channel, subject `CN=channel:<id>`, and that certificate is the only place the proxy reads a channel identity from — never a header, query parameter, or body field, because the process on the other end runs the model and anything the model can influence is not a boundary. Certificates authenticate; team sheets authorize. There is no revocation list: removing a channel's sheet removes its permissions on the next call, and a stale certificate is left holding nothing. That is revocation for a channel being retired, not for a leaked key — a certificate whose channel is still in use holds whatever that channel's sheet allows, and re-minting does not invalidate the old one, because both carry the same CN. Pinning a channel's key in its team sheet is the intended fix and is not built yet. The proxy resolves which credentials and tools that channel's team sheet permits. Compromise of the agent process (prompt injection, malicious skill, model misbehavior) yields no tool credentials and only the tool surface that channel's team sheet allows, with every call audited. Those are model-level cases, and none of them reaches certificate selection: which channel a task runs as is derived from the Slack event, not from anything the model produces. Full compromise of the process is wider, because it holds one certificate per channel it serves — the union of those channels' tool surfaces, though still no tool credentials, since none are in that process. What is in it is the Slack app and bot tokens and the model provider key, which the gateway and the loop cannot run without; a leak there lets an attacker speak as the app and spend against the provider, and reaches no tool the proxy guards. See the [security model](/docs/security#which-secrets-are-where).

## Gateway and channel router

Built over Slack Socket Mode (no inbound ports — good self-host ergonomics). Sessions are keyed on `(team_id, channel_id)` with a per-session async mutex serializing context writes; concurrent mentions in one channel queue rather than interleave. Every inbound message is stored with `user_id`, display name, `thread_ts`, and timestamp, and the context assembler renders attribution (`@alice: ...`) so the model can address the right person. Long tasks render a single live-updating checklist message in the thread (edit, don't spam). Follow-ups in a thread the agent is active in do not require re-mention.

## Agent loop

A ReAct-style loop over a provider-agnostic completion layer (Anthropic, OpenAI, Google, Groq, Ollama out of the box; the optional LiteLLM sidecar covers the long tail behind an OpenAI-compatible endpoint). Per-channel model override comes from the team sheet. Tool definitions are fetched from the proxy at session start — the agent never constructs tool clients itself. Hard caps per task: max tool calls, max wall time, max tokens, all read from the team sheet and enforced in the loop *and* independently in the proxy (defense in depth; the proxy's meter is authoritative).

## Tool proxy

The proxy is the core of the project. It does five things.

**Credential vault.** Secrets are stored encrypted at rest (key from env/KMS), referenced by name in team sheets, injected into outbound MCP/HTTP calls by the proxy, and never present in any response body, log line, or error message returned to the agent. A redaction pass scrubs known secret values from tool results before they cross back to the agent, closing the "tool echoes its own auth header" leak class.

**Team-sheet enforcement.** On each call the proxy resolves the channel's team sheet and answers deterministically: is this MCP server allowed for this channel; is this specific tool on the allowlist; does the call require approval; is the budget exhausted. Any "no" is a structured refusal the agent can relay to the user. The model's cooperation is never part of the enforcement path.

Where the call goes is answered by the same sheet, in two places that do not overlap. An MCP call goes to the `url` on the `[[mcp_server]]` block that carried the tool — declaring a destination there is what authorizes it, and the block that authorized the tool is the block the call is dispatched to. The `[egress]` allowlist governs the destinations the sheet does *not* pin: the code-execution sandbox, and anything later that takes a URL as an argument. Keeping them apart is what stops one grant widening the other — a channel can reach the GitHub MCP server without its sandbox reaching the GitHub API. Redirects are not followed, because a redirect target is the one destination neither list names.

**HITL approval broker.** Tools marked `approval = "required"` cause the proxy to hold the call, emit an approval request, and let the gateway render an Approve / Request changes card in the thread. Approvals are per-call, recorded in the audit log with the approver's Slack user id, and expire (default 15 minutes). Destructive-verb heuristics (delete, drop, transfer, deploy) default to approval-required unless the team sheet explicitly opts out.

**Budget meter.** Token and tool-call accounting per channel per day, authoritative in the proxy. One SQLite file keyed `(channel, UTC day)`, holding the four raw token counts and the tool-call count; rollover is implicit, because a new day is a key nothing has written and reads as zero, so it survives a restart and does not happen at process start. A hard limit stops the loop and requires the daily rollover or an admin reset — `node dist/budget.js reset <channel>`, a second process against the same file, which takes effect on the next call without a restart. Ambient mode draws from the same meter. The soft in-thread warning is not built yet.

The two limits rest on different things. `daily_tool_calls` is counted by the proxy from calls it serves, at the moment it commits to serving one, so it holds even under full compromise of the agent process. `daily_tokens` is counted from a report the agent POSTs to `/v1/spend` after each turn — bound to a channel by the client certificate exactly as a tool call is, idempotent on a per-turn id so a retry cannot double-count, and carrying no field any enforcement decision reads. The numbers come out of the provider's HTTP response envelope rather than from anything the model writes, so a prompt-injected model cannot forge them; a compromised agent process could, which is an assumption the [security model](/docs/security/) already states and whose consequences are larger. What a cached token is worth against `daily_tokens` is a team sheet setting, so the meter stores raw counts and the weighting resolves with the rest of policy at decision time.

**The report route makes no authorization decision**, and that is structural rather than incidental: it resolves no team sheet, shares no handler with the route that does, and lives in a module with no import that could reach one — a lint rule in CI, not a comment, is what keeps it that way. Reporting spend is not asking for anything, so there is nothing to decide.

**Audit writer.** Append-only SQLite table (WAL, no UPDATE/DELETE grants for the service role): timestamp, channel, requesting user, task id, tool, server, argument hash (args themselves optionally stored, redacted, behind a config flag), result status, tokens, approver if any. `libero audit` provides query and CSV export.

## The team sheet

The manifest is the admin surface: a TOML file per channel, intended to live in the operator's own git repo. We call it the channel's **team sheet** — the sheet the manager submits before a match declaring who is allowed on the pitch, what position they play, and what needs the gaffer's sign-off. Nothing in it is a secret — credentials are named references resolved only inside the proxy. See the [team sheet reference](/docs/team-sheet) for a documented starter.

Team-sheet changes are picked up on file change (watched and validated against the zod schema in `@getlibero/schema`); invalid sheets are rejected loudly and the previous valid version stays active.

## Memory

One SQLite database per channel, and the file-per-channel layout *is* the isolation boundary — there is no query path that can join across channels.

- **Layer 1:** full message history with FTS5 for "what did we decide about X" search, exposed to the agent as a `search_channel_history` built-in (proxied like everything else).
- **Layer 2:** `MEMORY.md`, agent-curated via a post-reply inner-loop turn: the model gets one extra call with `memory_append` / `memory_replace` tools and instructions to persist only durable team facts. Writes go through the memory package with file locking and size caps.
- **Layer 3:** semantic recall via sqlite-vec embeddings over curated facts and thread summaries — same database file, same isolation.

Slack retention is respected: a message deleted in Slack is deleted from the store on the corresponding event.

## Skills

After any task exceeding a tool-call threshold (default 5), a skill-author turn decides whether a reusable playbook emerged and, if so, writes a frontmatter-structured `skills/*.md` (name, description, created, uses, status). Loading is by retrieval: at task start the agent embeds the incoming request and retrieves top-k matching skills (sqlite-vec + FTS hybrid), loading only those into context — never the whole library. Lifecycle: stale at 30 days unused, archived at 90, implemented as a weekly maintenance job, plus a curator pass that proposes merges of overlapping skills as a PR-style diff for human review rather than silently rewriting institutional knowledge. Skills are text in the channel directory: reviewable, editable, deletable by the team that owns them.

## Ambient mode

Ships last, disabled by default, and only behind the budget meter. A per-channel cron invokes a heartbeat evaluation: recent activity is summarized and the model is asked whether anything merits a proactive post — stale thread, approaching deadline, unanswered question — with a SILENT sentinel otherwise, and a hard rate limit of one proactive post per channel per heartbeat. A `schedule_task` tool (proxied, audited, approval-gated by default) lets the agent create its own future checks.

## Sandbox

The built-in code-execution tool runs in an ephemeral container (Docker by default; gVisor documented for hardened deployments) with no network unless the team sheet grants an egress allowlist, a read-only rootfs, cpu/mem/time limits, and a tmpfs workdir. The runner is invoked *by the proxy*, not the agent, so code execution is audited and budgeted like any other tool.

## Threat model

See the [security model](/docs/security).

## Scope (v1 non-goals)

Discord/Teams adapters (the gateway supports them in principle; untested until Slack is solid). A web admin UI — manifests are files in a git repo, and that *is* the admin UI for v1. Fine-grained per-user permissions within a channel — channel membership is the permission boundary. Voice or DM personal-assistant modes. Multi-workspace control plane — single-tenant self-host only.

## Acknowledgments

Libero builds on and learns from prior open work: the gateway is built over [CopilotKit's bot SDK](https://github.com/CopilotKit) (MIT), where we contribute upstream rather than fork when possible; the memory-curation inner loop follows the pattern popularized by Letta; and the skill-lifecycle design draws on ideas explored in earlier MIT-licensed community projects in this category. The channel-agent product category was defined by Anthropic's Claude Tag; Libero exists to offer a self-hosted, model-agnostic, source-available take on it.
