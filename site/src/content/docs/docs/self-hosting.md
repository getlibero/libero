---
title: Self-hosting
description: The target deployment — two containers, one team sheet per channel — and an honest account of what does not work yet.
---

:::caution[Not deployable yet]
This page describes the target deployment. Phase 0 is the skeleton: the schema package, the CLI
placeholder, the design system, and the CI that guards the boundaries. The proxy — the thing that
makes any of this safe — is phase 1. Do not run this against a workspace you care about, because
there is nothing to run yet.
:::

## The shape of a deployment

Two containers and a directory of channel state. No inbound ports: the gateway connects out to
Slack over Socket Mode, which is the main reason Socket Mode was chosen.

```bash
npx @getlibero/cli init      # scaffolds config + secrets on the host
docker compose up            # starts gateway+agent and proxy
```

`init` writes the host configuration and the encrypted vault; `docker compose up` starts both
services from `deploy/docker-compose.yml`. An optional LiteLLM sidecar is included for models
without first-class support.

## What you provide

**A Slack app** with Socket Mode enabled, in a workspace you administer.

**A model provider.** Anthropic, OpenAI, Google, Groq or Ollama out of the box, set globally and
overridable per channel in the team sheet.

**Service credentials for the tools you want the agent to reach** — a GitHub service account, for
example. These go into the vault by name. They are provisioned by an admin and belong to the
agent, not to a user: the agent acts only as itself, and the audit log records which human asked
for each call.

**A git repo for your team sheets.** One TOML file per channel. This is the admin surface; see
the [team sheet reference](/docs/team-sheet).

## What runs where

| | gateway + agent | tool proxy |
| --- | --- | --- |
| Talks to Slack | yes | no |
| Runs the model loop | yes | no |
| Holds credentials | **no** | yes |
| Enforces the allowlist | no | yes |
| Meters budget | advisory | **authoritative** |
| Writes the audit log | no | yes |

The proxy listens only on localhost or a private network, with mutual TLS between the two
services. Put nothing else on that interface.

## Operating it

`libero audit` queries and exports the append-only audit log — every tool call with its
requester, its arguments' hash, its result, and its approver if it had one.

Budget exhaustion is visible in-thread: a soft limit warns, a hard limit stops the loop until an
admin resets it or the day rolls over.

Team sheet edits are picked up on file change. An invalid sheet is rejected and the previous valid
version stays active, so a bad edit degrades to "no change" rather than "no enforcement".

## Upgrading

`@getlibero/cli` is the only npm-published package, released with provenance attestations.
Everything else ships as Docker images built from `deploy/docker-compose.yml`. Pin image tags in
your compose file and move them deliberately — the proxy is a security boundary, and you should
know when it changes.
