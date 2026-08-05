# @getlibero/server

The gateway + agent process. It holds the Slack socket and runs the model loop:
a mention arrives over Socket Mode, one agent task runs, the answer goes back
into the thread.

Unpublished workspace package. See
[the architecture spec](../../site/src/content/docs/docs/architecture.md) — it
is the design of record and is ahead of what is built.

## What it holds, and what it does not

This process holds the Slack app token, the Slack bot token, and the model
provider key. It holds **no tool credential** and has no way to reach a tool
except one: a mutual-TLS call to the tool proxy service, which owns every
credential and decides every call from the channel's team sheet.

Which channel a call is attributed to comes from the client certificate the
agent presents — `client-<channel id>.pem` out of `PROXY_CLIENT_CERT_DIR` — and
from nothing in the request. A channel whose certificate this process does not
hold is a channel it cannot call as.

The tools the model is offered are whatever the proxy lists for that channel,
unfiltered. Their descriptions are thin on purpose: a team sheet knows names and
approval and nothing about arguments, so no input schema is published. Real
schemas arrive with the MCP client pool (#39).

Not here yet, and each belongs to its own issue: per-channel sessions and the
mutex that serializes them (#65), thread history and attribution (#67), the
per-channel `[llm]` model override and caps from the team sheet (#65), and the
spend report that meters tokens (#110 — `daily_tokens` reads zero until it
lands, so only `daily_tool_calls` bites).

## Configuration

Environment only. Nothing is read from a file and nothing is baked into the
image. Every variable below is required unless marked optional, and a missing
one is a startup failure naming the variable — not a task that fails later at
the far end of a thread.

| Variable | Notes |
| --- | --- |
| `SLACK_APP_TOKEN` | App-level token, `xapp-…`. Opens the socket; cannot post. |
| `SLACK_BOT_TOKEN` | Bot token, `xoxb-…`. Posts; cannot open the socket. |
| `PROXY_URL` | The tool proxy. Must be `https://…`. |
| `PROXY_TLS_CA` | Verifies the proxy's certificate, and nothing else does. |
| `PROXY_CLIENT_CERT_DIR` | Holds `client-<channel id>.pem` and `.key` per channel. |
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

The three `PROXY_*` variables are required together, with no fallback to a
toolless agent. A process missing one of them is not a deployment that answers
without tools, it is a misconfigured one — and a silent downgrade would be a
model saying it cannot do something the channel in fact permits, with nothing in
the logs to say why. `PROXY_URL` must be `https`: mutual TLS is the proxy's only
authentication, so a plaintext URL means no certificate is presented, no channel
is resolved, and every call is refused.

The Slack app needs Socket Mode enabled, the `app_mentions:read` and
`chat:write` scopes, and the `app_mention` event subscribed.

## Running it

The proxy is not optional, so mint certificates first — one per channel the bot
answers in, plus the CA both processes trust:

```sh
sh scripts/dev-certs.sh --channels C024BE91L
pnpm -r build
SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… \
PROXY_URL=https://localhost:8443 \
PROXY_TLS_CA=./deploy/certs/ca.pem \
PROXY_CLIENT_CERT_DIR=./deploy/certs/agent \
AGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… AGENT_MODEL=claude-sonnet-4-6 \
node apps/server/dist/index.js
```

It logs one JSON object per line on stdout: `connecting`, `connected`, then
`mention`, `task`, and `replied` per answered mention. No line carries a token
value or any message text — ids only.

## When the proxy cannot be reached

The channel is told, in one line, and the task ends there. This is a departure
from how an unreachable model provider behaves — that one posts nothing — and
the reason is that one of these failures is permanent: a channel whose client
certificate was never minted will never answer again, which is a first-run
configuration mistake rather than an outage. Silence there is indistinguishable
from being ignored, by the people who cannot see the log.

| What happened | What the channel sees | Log line |
| --- | --- | --- |
| No `client-<channel>.pem` for this channel | Names the certificate, and the script that mints one | `tools_unavailable`, `reason: no_client_certificate` |
| Proxy down, or it refused this certificate | Says the proxy could not be reached | `tools_unavailable`, `reason: connection_reset` or `unreachable` |
| Shutting down mid-listing | Nothing | none |

Neither message answers what was asked. A synthesized answer to the question is
the thing this process will not do when something is broken.

A failed tool *call* is different and never ends a task: a refusal, a hold, or
an upstream error comes back to the model as tool-result content and the task
carries on.

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
  from how the task ended to what the channel is told. One proxy tool client per
  task, pinned to the mention's channel.
- `src/index.ts` — composition and lifecycle, and nothing else.
