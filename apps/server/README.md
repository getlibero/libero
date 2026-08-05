# @getlibero/server

The gateway + agent process. It holds the Slack socket and runs the model loop:
a mention arrives over Socket Mode, one agent task runs, the answer goes back
into the thread.

Unpublished workspace package. See
[the architecture spec](../../site/src/content/docs/docs/architecture.md) — it
is the design of record and is ahead of what is built.

## What it holds, and what it does not

This process holds the Slack app token, the Slack bot token, and the model
provider key. It holds **no tool credential** and has no way to reach a tool:
the only path is a network call to the tool proxy service, which owns every
credential and decides every call from the channel's team sheet.

That client is not written yet, so the agent runs with a stub tool source that
lists nothing. It answers from the model and calls no tools.

Not here either, and each belongs to its own issue: per-channel sessions and
the mutex that serializes them (#65), thread history and attribution (#67), the
per-channel `[llm]` model override and caps from the team sheet (#65), and the
spend report that meters tokens (`daily_tokens` reads zero until it lands).

## Configuration

Environment only. Nothing is read from a file and nothing is baked into the
image. Every variable below is required unless marked optional, and a missing
one is a startup failure naming the variable — not a task that fails later at
the far end of a thread.

| Variable | Notes |
| --- | --- |
| `SLACK_APP_TOKEN` | App-level token, `xapp-…`. Opens the socket; cannot post. |
| `SLACK_BOT_TOKEN` | Bot token, `xoxb-…`. Posts; cannot open the socket. |
| `AGENT_PROVIDER` | `anthropic` or `openai-compatible`. |
| `AGENT_MODEL` | Model id, passed to the provider verbatim. |
| `ANTHROPIC_API_KEY` | Required when `AGENT_PROVIDER=anthropic`. |
| `OPENAI_API_KEY` | Required when `AGENT_PROVIDER=openai-compatible`. |
| `ANTHROPIC_BASE_URL` | Optional. Anthropic's own endpoint when unset. |
| `OPENAI_BASE_URL` | Optional. Reaches Together, Fireworks, Groq, Ollama, Gemini's compatibility endpoint, or a LiteLLM sidecar. |

`AGENT_PROVIDER` is required and never inferred from whichever key happens to
be set: `deploy/docker-compose.yml` declares both keys on this service, so
inference would resolve on the order the arms are written in and bill an
account nobody chose. `AGENT_MODEL` has no default for the same class of
reason — a defaulted model id goes stale on the provider's schedule and pins a
price the operator never picked.

The Slack app needs Socket Mode enabled, the `app_mentions:read` and
`chat:write` scopes, and the `app_mention` event subscribed.

## Running it

Directly, from the repository root:

```sh
pnpm -r build
SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… \
AGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… AGENT_MODEL=claude-sonnet-4-6 \
node apps/server/dist/index.js
```

It logs one JSON object per line on stdout: `connecting`, `connected`, then
`mention`, `task`, and `replied` per answered mention. No line carries a token
value or any message text — ids only.

Under compose it is the `server` service. That path needs a Dockerfile, which
is #86.

## Shutting down

`SIGTERM` or `SIGINT` aborts every task in flight and closes the socket. A
cancelled task posts nothing: the operator asked for quiet, and an answer
arriving after the socket closed has nowhere to go. A second signal exits
immediately — nothing here is durable, so the cost is at most one answer that
was already cancelled.

If Slack refuses the credentials after startup — a revoked or rotated token —
the process logs `gateway_dead` and exits non-zero rather than staying up
healthy and never answering again. Under compose, `restart: unless-stopped`
brings it back once the environment is fixed.

## Layout

- `src/env.ts` — every environment rule, apart from `index.ts` so the failure
  modes are testable without a process.
- `src/handler.ts` — the seam: a mention in, one agent task, and the mapping
  from how the task ended to what the channel is told.
- `src/index.ts` — composition and lifecycle, and nothing else.
