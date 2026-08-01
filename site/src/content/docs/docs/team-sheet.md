---
title: Team sheets
description: The per-channel TOML manifest that declares which tools exist, which need a human click, what the budget is, and where traffic may go.
---

The team sheet is the admin surface: one TOML file per channel, intended to live in the operator's
own git repo.

The name is the football one. It is the sheet the manager submits before a match declaring who is
allowed on the pitch, what position they play, and what needs the gaffer's sign-off. Everything
the proxy enforces at runtime is a lookup into this file.

Nothing in a team sheet is a secret. Credentials appear as **names**, resolved only inside the
proxy's vault — never in the sheet, the logs, an error message, or anything returned to the agent.

## A documented starter

This is `channels/example/channel.toml` in the repository, kept in sync with the zod schema in
`@getlibero/schema`.

```toml
# Example team sheet — copy to channels/<CHANNEL_ID>/channel.toml

[channel]
name        = "engineering"
description = "Deploys, code review, incident response."

[llm]
model               = "claude-sonnet-4-6"   # per-channel override
max_tokens_per_task = 60000

[budget]
daily_tokens     = 2_000_000
daily_tool_calls = 400

[[mcp_server]]
name       = "github"
transport  = "http"
url        = "http://mcp-github:3001"
credential = "github_service_account"       # name only; value lives in the vault

  # Tools not listed here do not exist as far as this channel is concerned.
  [[mcp_server.tool]]
  name = "list_prs"

  [[mcp_server.tool]]
  name     = "trigger_workflow"
  approval = "required"                     # held for a human Approve click

[egress]
allow = ["api.github.com", "*.internal.example.com"]

[ambient]
enabled  = false                            # off by default, always
schedule = "0 9 * * 1-5"
```

## What each block does

### `[channel]`

Identity and a description. The description is part of the agent's context, so it is worth
writing: it is how the model knows what kind of channel it is in.

### `[llm]`

The per-channel model override and the per-task token ceiling. Libero is model-agnostic —
Anthropic, OpenAI, Google, Groq and Ollama are supported directly, and the optional LiteLLM
sidecar covers everything else behind an OpenAI-compatible endpoint.

### `[budget]`

Tokens and tool calls, per channel per day. The agent loop applies its own caps, but this is the
authoritative meter and it lives in the proxy. A soft limit warns in-thread; a hard limit stops
the loop until an admin resets it or the day rolls over.

### `[[mcp_server]]`

One block per MCP server this channel may reach. `credential` is a name; the proxy resolves it
against the vault and injects it into the outbound call. The agent never receives the value and
never learns it exists beyond the name.

### `[[mcp_server.tool]]`

The allowlist. **A tool that is not listed does not exist as far as this channel is concerned** —
it is not in the tool definitions the agent fetches at session start, and a call to it is refused
in the proxy regardless.

`approval = "required"` holds the call and renders an Approve / Request changes card in the
thread. Approvals are per-call, recorded with the approver's Slack user id, and expire after 15
minutes by default. Destructive verbs — delete, drop, transfer, deploy — default to
approval-required unless the sheet explicitly opts out.

### `[egress]`

Where the agent's traffic may go, including from inside the code-execution sandbox. The sandbox
has no network at all unless this list grants it.

### `[ambient]`

Proactive posting. Disabled by default, always, and metered by the same budget as everything else.

## How changes are applied

Team sheets are watched and validated against the schema on file change. An invalid sheet is
rejected loudly and **the previous valid version stays active** — a typo cannot silently widen or
disable enforcement.

Because the sheets are files in your git repo, the review trail for "who allowed the agent to
deploy" is your normal pull request history. That is deliberate: a web admin UI is an explicit
non-goal for v1, and the files *are* the admin UI.
