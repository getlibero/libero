---
title: Self-hosting
description: The target deployment — two containers, one team sheet per channel — and an honest account of what does not work yet.
---

:::caution[Not deployable yet]
This page describes the target deployment. What exists today is phase 1, part-built: the proxy
process starts, speaks mutual TLS, binds every request to a channel, enforces team sheets, holds
credentials in an encrypted vault, injects them into outbound calls, and scrubs them back out of
results. But the process still composes a placeholder dispatcher, so a permitted call answers 501
rather than reaching an upstream — and approvals, budgets, the audit log, and the gateway do not
exist. Do not run this against a workspace you care about: the parts that make it safe are not
all built.
:::

## The shape of a deployment

Two containers and a directory of channel state. No inbound ports: the gateway connects out to
Slack over Socket Mode, which is the main reason Socket Mode was chosen.

```bash
npx @getlibero/cli init      # scaffolds config + secrets on the host
sh scripts/dev-certs.sh      # mints the mutual-TLS material (see below)
docker compose up            # starts gateway+agent and proxy
```

`init` writes the host configuration and generates `PROXY_VAULT_KEY`, the master key that encrypts
the vault; `docker compose up` starts both services from `deploy/docker-compose.yml`. An optional
LiteLLM sidecar is included for models without first-class support.

Credentials go into the vault from inside the proxy container, so the master key never has to
exist on the host:

```bash
docker compose run --rm proxy node dist/vault.js set github_service_account < token.txt
docker compose run --rm proxy node dist/vault.js list    # names only
```

The value is read from stdin rather than an argument, because `ps` shows arguments to every user
on the box and a shell writes them to history. There is no command that prints a credential back.
The proxy reads the vault at startup, so a change takes effect on restart — and losing the master
key means losing the vault: there is no recovery path and no escrow.

## What you provide

**A Slack app** with Socket Mode enabled, in a workspace you administer. One app serves every
channel — see [the Slack app](#the-slack-app) for the scopes and events it needs.

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
| Holds tool credentials | **no** | yes |
| Holds gateway and model credentials | yes | no |
| Enforces the allowlist | no | yes |
| Meters budget | advisory | **authoritative** |
| Writes the audit log | no | yes |

The two credential rows are the whole distinction. Slack tokens and the model provider key are in
the agent process because the gateway holds the socket and the loop calls the provider; everything
a team sheet governs is in the proxy's vault and the agent never sees it. The
[security model](/docs/security#which-secrets-are-where) states what a leak of each gets an
attacker.

The proxy listens only on localhost or a private network, with mutual TLS between the two
services. Put nothing else on that interface.

## The Slack app

One app, installed once, serving every channel it is invited to. Not one app per channel: which
channel a task runs as comes from the Slack event, and that is what selects the client certificate
the agent presents to the proxy.

Socket Mode means there is no Request URL to configure anywhere — not for events, not for
interactivity. The gateway dials out and holds the connection open, which is why the deployment
publishes no ports.

### Tokens

| Token | Where it comes from | Env var |
| --- | --- | --- |
| App-level (`xapp-`) | Created when you enable Socket Mode; needs `connections:write` | `SLACK_APP_TOKEN` |
| Bot (`xoxb-`) | Issued when you install the app to the workspace | `SLACK_BOT_TOKEN` |

Both live in the gateway process, because that is what holds the socket. They are not tool
credentials and do not go in the vault: the vault is for the credentials the proxy injects into
calls the team sheet permits, and the gateway's own token is not one of them. Scope the app
narrowly and install it only in the workspace that needs it — a leaked bot token can post as the
app and read history anywhere the app is installed.

### Bot scopes

| Scope | What needs it |
| --- | --- |
| `app_mentions:read` | Receiving the mention that starts a task |
| `chat:write` | Posting replies, and editing its own messages for the live checklist |
| `channels:history` | Storing channel messages for recall and for thread follow-ups |
| `groups:history` | The same, for private channels — omit if the agent only serves public ones |
| `users:read` | Display names, so the model can address the right person |

### Event subscriptions

| Event | What needs it |
| --- | --- |
| `app_mention` | The trigger |
| `message.channels` | Messages that are not mentions: thread follow-ups, and the message store |
| `message.groups` | The same, for private channels |

Message events carry deletions as a subtype rather than as their own event, and the gateway acts
on them: a message deleted in Slack is deleted from that channel's store, index included. Slack
retention is respected rather than quietly outlived.

### Interactivity

Turn it on. Approve / Request changes cards are Slack interactions, and the approver's identity
arrives in the interaction payload — the one identity in the system Slack vouches for rather than
the agent asserting it. No extra scope, and no Request URL.

### Use a scratch workspace first

A free workspace you create is enough to bring the gateway up and watch it answer a mention. Point
the app at a workspace you care about only once the enforcement path is one you have read — the
caution at the top of this page is not a formality.

## Mutual TLS between the services

The agent reaches the proxy over mutual TLS. A client with no certificate the local CA signed
cannot open a connection at all, and the certificate it does present is where the proxy reads the
channel id from — there is no header and no request field it will accept one in. A call on behalf
of `#engineering` requires that channel's private key, so a prompt-injected model cannot talk its
way into another channel's tools.

`scripts/dev-certs.sh` mints the material: a local CA, the proxy's server certificate, and one
client certificate per directory under `channels/`, each with the subject `CN=channel:<CHANNEL_ID>`.

```bash
sh scripts/dev-certs.sh                       # every channel under channels/
sh scripts/dev-certs.sh --channels C024BE91L  # or name them
```

Output lands in `deploy/certs`, gitignored and laid out by role: `ca.pem` at the root, the proxy's
keypair under `proxy/`, the channel client certificates under `agent/`. The compose file mounts
each container only its own slice, read-only — and the CA's private key into neither, because a
process that can mint certificates can name itself any channel. Adding a channel means creating
its directory and running the script again.

**Certificates authenticate; team sheets authorize.** There is no revocation list. A certificate
proves which channel is calling and nothing more — what that channel may do is resolved from its
team sheet on every call, so removing a channel's sheet removes its permissions immediately, with
a stale certificate left holding nothing. Rotate by re-running the script and restarting both
services.

The CA is yours: it never leaves the host, it signs only these two roles, and it is not a public
trust anchor. The keys it produces are secrets. Keep `deploy/certs` out of the git repo holding
your team sheets — that repo is meant to be readable by everyone who reviews a manifest, and these
files are not.

## Operating it

`libero audit` queries and exports the append-only audit log — every tool call with its
requester, its arguments' hash, its result, and its approver if it had one.

Budget exhaustion is visible in-thread: the hard limit stops the loop until the UTC day rolls over
or an admin resets the channel. (A soft limit that warns before the hard one bites is on the
roadmap and is not built.)

```bash
docker compose run --rm proxy node dist/budget.js show  C024BE91L   # today's counters
docker compose run --rm proxy node dist/budget.js reset C024BE91L   # clears today only
```

The reset is a second process against the proxy's own database rather than a request to the proxy,
for the same reason the vault commands are: it runs where the data is. It takes effect on the
running proxy's next call, so nothing needs restarting. It clears today; earlier days stay as
history.

`PROXY_BUDGET_DB` is required and has no default — a budget file invented under a path nobody meant
is a channel whose hard limits never bite, which is the one misconfiguration here that fails open.
SQLite writes `-wal` and `-shm` files beside it, so the *directory* must be writable and not just
the file. Nothing in it is a secret.

`PROXY_AUDIT_DB` is required on the same terms, and holds the audit log: one row per decided tool
call, appended and never rewritten. Its failure mode is the budget's turned quiet — a file under a
path nobody meant produces a deployment that looks audited and has nothing to show when someone
finally looks. It has no reset command, because the table refuses `DELETE` from any connection.
Nothing in it is a secret either: names, ids, and a hash of the model's arguments, never an argument
value and never a credential. A proxy that cannot write this file refuses the call it could not
record rather than serving it unrecorded.

The meter uses Node's built-in `node:sqlite` — no dependency, no native build — which needs Node
22.13 or newer and is still marked experimental, so some Node versions print an
`ExperimentalWarning` for it at startup. If that is noise in your log collector, set
`NODE_OPTIONS: --disable-warning=ExperimentalWarning` on the proxy service.

Team sheet edits are picked up on file change. An invalid sheet is rejected and the previous valid
version stays active, so a bad edit degrades to "no change" rather than "no enforcement".

## Upgrading

`@getlibero/cli` is the only npm-published package, released with provenance attestations.
Everything else ships as Docker images built from `deploy/docker-compose.yml`. Pin image tags in
your compose file and move them deliberately — the proxy is a security boundary, and you should
know when it changes.
