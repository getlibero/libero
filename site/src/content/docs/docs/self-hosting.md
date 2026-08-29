---
title: Self-hosting
description: The target deployment — two containers, one team sheet per channel — and an honest account of what does not work yet.
---

:::caution[Pre-1.0]
The team-sheet format is the compatibility surface 1.0 will freeze, and until then a release may
change it — the [changelog](/docs/changelog/)'s Upgrading section says when and what to edit.
Certificate rotation and revocation are manual: possible without downtime, driven by a shell
script and an edit to a sheet rather than by anything automated. Nobody outside the project has
run this against a workspace they depend on yet; the section on
[using a scratch workspace first](#use-a-scratch-workspace-first) is the practical consequence.
:::

Everything on this page runs as of `v0.6.0`. The proxy speaks mutual TLS, binds every request to
a channel, enforces team sheets, holds credentials in an encrypted vault, injects them into
outbound calls, scrubs them back out of results, meters each channel's daily budget in calls and
in dollars, and appends a hash-chained audit row for every decided call. The gateway and the
agent loop reach tools through the proxy and nowhere else, and a held call raises an amber card
whose click re-submits the identical call with the ticket. The proxy speaks MCP, including OAuth
against upstreams that require it, and [GitHub's hosted server](/docs/github/) is exercised end
to end. Memory, skills and ambient mode are whole; two limits are stated rather than hidden — a
deployment with no embedding provider retrieves skills on full text alone and proposes no merges,
and a fired scheduled check is one bounded turn over the channel's recent messages that can look
nothing up ([#348](https://github.com/getlibero/libero/issues/348)).

Code execution is off unless you start it: `docker compose --profile runner up -d`, plus a
digest-pinned sandbox image, the runner's client pin, and the host's docker group id. Without the
runner, a channel that grants `run_code` is told the call is permitted and this deployment has
nothing to serve it.

Both service images are published to GHCR on every release, and both still build from the
compose file — so `docker compose -f deploy/docker-compose.yml up` starts a deployment from a
clean checkout, and a `docker compose -f deploy/docker-compose.yml pull` first makes it run the
exact bytes a release published.

## The shape of a deployment

Two containers and a directory of channel state — read-only to both of them, with everything either
service writes on a volume of its own. No inbound ports: the gateway connects out to Slack over
Socket Mode, which is the main reason Socket Mode was chosen.

```bash
npx @getlibero/cli init                          # writes deploy/.env, generates the vault master key
npx @getlibero/cli channel add C024BE91L         # a team sheet and the certificate that speaks for it
npx @getlibero/cli doctor                        # says what is still wrong before you start anything
docker compose -f deploy/docker-compose.yml up   # starts gateway+agent and proxy
```

All of these run from the root of a checkout. `channel add` mints the local CA and the proxy's server
certificate on its first run as well as the channel's own, so `sh scripts/dev-certs.sh` is the same
step done by hand — see [pinning a channel's certificate](#pinning-a-channels-certificate). The agent
reaches a model in one of [three shapes](#reaching-a-model) — directly, through a LiteLLM you
already run, or through a sidecar this compose file can start — and the choice changes two
variables, not the deployment.

This page is the stack itself. [Deploying on a VM](/docs/deploying-on-a-vm/) puts it on a machine
that is not a laptop — a Compute Engine or EC2 instance, one disk for every piece of durable state,
the four secrets in the platform's secret manager rather than in a file a snapshot then copies
around, and why a VM with a disk is the supported shape rather than a serverless container.

**There are two environment files, and they are different documents.** `init` writes
`deploy/.env`: the operator's half of a compose deployment — the two Slack tokens, the provider
and model, the completion key, the optional price table, and `PROXY_VAULT_KEY`, the master key
that encrypts the vault. It goes beside the compose file because that is where Compose looks —
with no `--project-directory` the project directory is the directory holding the compose file —
so an `.env` at the repository root is read by nothing. Everything else the services need is set
in the compose file itself, because those are paths inside a container.

`.env.example` at the repository root is the other one: the full contract for **running the two
processes directly**, with host-relative paths, and a superset of what compose reads. Most of it
is required with no default — the Slack tokens, the provider key, `AGENT_PROVIDER` and
`AGENT_MODEL`, the channels roots for both services, the agent's `AGENT_STORE_ROOT`, the proxy's
TLS material, and the vault, budget, and audit paths. A missing one is a startup failure that
names itself. `PROXY_BUDGET_DB`,
`PROXY_AUDIT_DB`, `AGENT_STORE_ROOT` and `PROXY_STORE_ROOT` get their own paragraphs under
[operating it](#operating-it) because they are the four where a wrong value fails quietly rather
than loudly.

Credentials go into the vault from inside the proxy container, so the master key never has to
exist on the host:

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/vault.js set github_service_account < token.txt
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/vault.js list    # names only
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/vault.js remove github_service_account
```

The value is read from stdin rather than an argument, because `ps` shows arguments to every user
on the box and a shell writes them to history. There is no command that prints a credential back.
The proxy reads the vault at startup, so a change takes effect on restart — and losing the master
key means losing the vault: there is no recovery path and no escrow.

[Connecting GitHub](/docs/github/) walks that credential the rest of the way: into a team sheet, out
to GitHub's hosted MCP server, and onto an audit row.

An upstream secured by OAuth rather than a service token ([`[mcp_server.auth]`](/docs/team-sheet/#mcp_serverauth))
is authorized by a grant instead of a vault entry, completed the same way — from inside the
container, where the master key already is — with a browser on any machine, including a laptop
nowhere near the VM the proxy runs on:

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/grant.js add notion_grant
```

The command reads the issuer and scopes from the team sheets naming `notion_grant`, prints an
authorization URL, and waits. Open the URL in any browser, sign in, approve. The browser is then
redirected to `http://127.0.0.1/callback` and **fails to load it — that is expected**: nothing
listens there, on purpose. Copy the full address of the failed page from the address bar, paste it
back at the prompt, and the command answers `grant: stored notion_grant`. The next tool call
through that upstream mints from the stored grant — no restart, no port-forwarding, and no token
or code ever printed. Running the flow again for the same name replaces the grant.

## What you provide

**A Slack app** with Socket Mode enabled, in a workspace you administer. One app serves every
channel — see [the Slack app](#the-slack-app) for the scopes and events it needs.

**A model provider, reached one of three ways.** Anthropic natively; OpenAI, Groq, Ollama, and
Gemini through their OpenAI-compatible endpoints; or either of those behind a LiteLLM — one you
already run, or the sidecar included here. All three are supported shapes rather than a default
and two workarounds; [reaching a model](#reaching-a-model) is the choice and what each costs. The
model is set globally and overridable per channel in the team sheet.

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
a team sheet governs is in the proxy's vault and the agent never sees it. Behind a LiteLLM the
agent holds a key for the gateway rather than for a provider, and the provider keys sit with
whoever runs that gateway — the row stays true, and what it names is a different secret. The
[security model](/docs/security#which-secrets-are-where) states what a leak of each gets an
attacker.

The proxy listens only on localhost or a private network, with mutual TLS between the two
services. Put nothing else on that interface.

## Reaching a model

There are three shapes here, and none of them is the default the other two are exceptions to.
Which one you run is an operations decision, and the deployment is the same in every other
respect.

| | Direct | A LiteLLM you already run | The bundled sidecar |
| --- | --- | --- | --- |
| What holds a provider key | The agent | Your gateway — nothing in this deployment | The sidecar; the agent holds none |
| Who operates it | Nobody: there is no extra hop | Your platform team, already | You, with `docker compose` |
| Routing, fallbacks, rate limits, key rotation across vendors | The provider's own, or nothing | Whatever you already run | One config file, this deployment's alone |
| A per-call cost figure to check the meter against | None | Yes | Yes |
| Extra process to run | None | None here | One |

**What you already run decides most of it.** An organization with a LiteLLM in front of its model
spend has the second shape whether or not this deployment exists, and pointing the agent at it is
a base URL and a key. A deployment with one vendor and no gateway has the first. The third is for
one that wants what a router gives without standing a gateway up first.

None of this is about model coverage. `AGENT_PROVIDER=openai-compatible` reaches Together,
Fireworks, Groq, Baseten, Ollama and Gemini's compatibility endpoint by base URL alone, with no
router in the path — a router is never what you run because a model is otherwise unsupported.

**Direct.** Anthropic natively, or anything with an OpenAI-compatible endpoint:

```bash
AGENT_PROVIDER=anthropic                 # or: openai-compatible
ANTHROPIC_API_KEY=sk-ant-…               # or: OPENAI_API_KEY, plus OPENAI_BASE_URL
AGENT_MODEL=claude-sonnet-4-6            # for anything that is not OpenAI itself
```

**A LiteLLM you already run.** Start nothing extra; point the agent at your gateway with a virtual
key it issued:

```bash
AGENT_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://llm.internal.example/v1
OPENAI_API_KEY=sk-…                      # a virtual key your gateway issued, not a provider's
AGENT_MODEL=claude-sonnet-4-6            # a model your gateway serves, spelled as it serves it
```

The agent refuses to start without a key even where your gateway would serve without one. The hop
leaves the machine in this shape, so it wants `https` and whatever your gateway's front door
requires — and a gateway on the same host is not `localhost` from inside a container, but
`host.docker.internal` where the daemon provides that name and an
`extra_hosts: ["host.docker.internal:host-gateway"]` line on the server service where it does not.
Nothing under `deploy/litellm/` is read.

**The bundled sidecar.** One extra service, behind a profile, configured in
`deploy/litellm/config.yaml`:

```bash
AGENT_PROVIDER=openai-compatible
OPENAI_BASE_URL=http://litellm:4000/v1
OPENAI_API_KEY=…                         # the sidecar's master key, and compose hands it the same value
AGENT_MODEL=claude-sonnet-4-6            # a model_name alias from config.yaml
LITELLM_ANTHROPIC_API_KEY=sk-ant-…       # the provider keys, read by that service alone
LITELLM_OPENAI_API_KEY=sk-…
docker compose -f deploy/docker-compose.yml --profile litellm up -d
```

The provider keys move to the sidecar and the agent holds none. They are prefixed because a stock
LiteLLM config reads the unprefixed names, which already mean something else on the agent — one
name for both would send the sidecar's own key upstream as a provider credential. The sidecar
publishes no ports: it is reachable at `litellm:4000` on the private network and nowhere else.

**Both LiteLLM shapes: the model name your gateway echoes back is the one that gets priced.** A
router resolves an alias, and what comes back in the response — the alias, not the upstream id —
is what lands in the spend report and what the [price table](/docs/price-table) must be keyed by.
An unpriced model fails `budget.daily_usd` closed. The proxy's `spend_reported` log line is where
to read the spelling. Embeddings need not follow completion through the gateway: the
`AGENT_EMBEDDING_*` variables are a provider configuration of their own, so completing through
your gateway and embedding elsewhere is a supported deployment rather than a workaround.

## The Slack app

One app, installed once, serving every channel it is invited to. Not one app per channel: which
channel a task runs as comes from the Slack event, and that is what selects the client certificate
the agent presents to the proxy.

Socket Mode means there is no Request URL to configure anywhere — not for events, not for
interactivity. The gateway dials out and holds the connection open, which is why the deployment
publishes no ports.

### Creating it

Paste the checked-in manifest rather than setting fields by hand. At
[api.slack.com/apps](https://api.slack.com/apps): **Create New App → From an app manifest**, choose
your workspace, and paste
[`deploy/slack-app-manifest.yml`](https://github.com/getlibero/libero/blob/main/deploy/slack-app-manifest.yml)
into the YAML tab. It declares the scopes, the events, Socket Mode and interactivity, so nothing in
the rest of this section has to be configured — the tables below are why each line is granted, and
the manifest is the thing you paste. Nothing in it is specific to one workspace.

Two lines to delete if the agent serves only public channels: `groups:history` and
`message.groups`. Everything else is called by the code as it stands; the manifest grants nothing
for a feature that does not exist, and says beside each line what needs it.

Then generate the app-level token, install to the workspace, and invite the app to each channel you
have written a team sheet for. The app icon is the one field the manifest cannot carry —
`design/brand/app-icon-fullbleed-1024.png` in the repository is the file to upload, and the app
works without it.

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
| `chat:write` | Posting replies and approval cards, and editing its own messages — a card goes amber, then green or red, in place |
| `channels:history` | Channel messages for recall and thread follow-ups. Without it the agent answers mentions and remembers nothing — the store stays empty |
| `groups:history` | The same, for private channels — omit if the agent only serves public ones |
| `users:read` | Display names, so the model can address the right person. Without it every author in the transcript is a raw `U…` id, and the agent logs `user_lookup_failed` with `missing_scope` |

The agent also calls `auth.test` once before opening the socket, to learn its own user id — a
message that mentions the app is delivered on both subscriptions, and only an id tells the two
copies apart. That call needs no scope, and it means a bot token Slack will not accept is a startup
failure naming `auth_rejected` rather than a reply that never appears.

### Event subscriptions

| Event | What needs it |
| --- | --- |
| `app_mention` | The trigger |
| `message.channels` | Messages that are not mentions: thread follow-ups, and the message store |
| `message.groups` | The same, for private channels |

An ordinary message in a channel that has a team sheet is stored with its author, its thread, its
timestamp and its text. A channel with no sheet is recorded nowhere: the agent is in most channels
of a workspace and provisioned for few, and an unprovisioned one has no authorization behind it.
Messages the agent posts itself are not stored either, so a transcript is what people said.

Those messages are what a task starts from. Before the model is asked anything it is given the
recent conversation, each message attributed to its author (`@alice: …`) and each `<@U…>` resolved
to a name, bounded by `[llm] max_history_messages` and `max_history_chars`. A question asked inside
a thread is answered from that thread; a question that starts one sees the channel around it. The
block is clearly marked as context rather than instructions and never goes in the system prompt,
because anyone in the channel can write it.

After the agent has worked in a thread, a reply there reaches it with **no mention**, for
`[llm] follow_up_window_seconds` after the last answer (default 900, `0` to switch it off).
Everywhere else in the channel still needs a mention. A follow-up is an ordinary task: same model,
same caps, same daily budget, same enforcement at the proxy.

Message events carry deletions and edits as a subtype rather than as their own events, and both are
mirrored. A message deleted in Slack is deleted from that channel's store, index entry included, so
Slack retention is respected rather than quietly outlived — including when the deleted message was a
thread parent, which Slack reports as a change to a placeholder rather than as a deletion. A message
edited in Slack has its new text stored and reindexed, and the text it replaced stops being
findable: someone who pastes a key and edits it out thirty seconds later has retracted it from the
transcript the model is given, not just from the channel.

**What was derived from the message goes with it.** If the thread had been summarized into the
channel's searchable memory, that summary and its embedding are dropped by the same event — an
edit as readily as a deletion — so the summary of a conversation cannot outlive the words it was
drawn from. The thread leaves the searchable corpus until it is summarized again. The one thing
deletion does **not** reach is a curated fact in `MEMORY.md`, because curation is a model turn
rather than a join and a fact records no per-message provenance; that file is markdown your team
reads and edits, and correcting it is a human step. The [security page](/docs/security/) argues
that in full.

An edit to a message the store never held does nothing. Nothing is back-filled through this path —
what the store holds is what was recorded as it happened, so a channel provisioned today has no
history from last week and an edit does not invent one.

### Interactivity

Turn it on. Approve once / Deny cards are Slack interactions, and the approver's identity
arrives in the interaction payload — the one identity in the system Slack vouches for rather than
the agent asserting it. No extra scope, and no Request URL. Left off, a click never reaches the
socket, so a card would go up and stay amber.

### Use a scratch workspace first

A free workspace you create is enough to bring the gateway up and watch it answer a mention. Point
the app at a workspace you care about only once the enforcement path is one you have read. It is
pre-1.0 software that nobody outside the project has yet run against a workspace they depend on,
and a scratch workspace is where that stops being an abstraction.

## Mutual TLS between the services

The agent reaches the proxy over mutual TLS. A client with no certificate the local CA signed
cannot open a connection at all, and the certificate it does present is where the proxy reads the
channel id from — there is no header and no request field it will accept one in. A call on behalf
of `#engineering` requires that channel's private key, so a prompt-injected model cannot talk its
way into another channel's tools.

`scripts/dev-certs.sh` mints the material: a local CA, the proxy's server certificate, and one
client certificate per directory under `channels/`, each with the subject `CN=channel:<CHANNEL_ID>`.
The `example` directory is skipped — copy it to a real channel id first, or name channels
explicitly.

```bash
sh scripts/dev-certs.sh                       # every channel under channels/
sh scripts/dev-certs.sh --channels C024BE91L  # or name them
sh scripts/dev-certs.sh --print-pins          # fingerprints and expiry dates
```

Output lands in `deploy/certs`, gitignored and laid out by role: `ca.pem` at the root, the proxy's
keypair under `proxy/`, the channel client certificates under `agent/`. The compose file mounts
each container only its own slice, read-only — and the CA's private key into neither, because a
process that can mint certificates can name itself any channel.

**Re-running the script mints only what is missing**, so adding a channel leaves every other
channel's certificate alone. Replacing one that already exists is `--rotate` (below); `--force`
does it in place, and `--force-ca` replaces the CA and with it every certificate in the deployment.

Client certificates are valid for a year; the CA and the proxy's server certificate for ten. The
script warns about any client certificate within thirty days of expiring, and `--print-pins` shows
every expiry date at once.

### Pinning a channel's certificate

Every team sheet names the certificates allowed to speak for its channel:

```toml
[channel]
name = "engineering"
certificate_sha256 = ["B7:C6:75:05:…:38"]
```

**Certificates authenticate; team sheets authorize** — and this is the one narrow say the sheet has
in the first of those. A certificate proves which *channel* is calling; the pin decides which *key*
may do the calling on its behalf. Without it a leaked private key could not be revoked without
retiring the channel, because a replacement certificate carries the same `CN=channel:<id>` as the
key it replaces and nothing could tell them apart.

There is still no revocation list and no CRL. Removing a channel's sheet removes its permissions
immediately and leaves a stale certificate holding nothing — that is how a channel is *retired*.
Dropping one fingerprint from a sheet revokes one *key* while the channel keeps working.

Setting a channel up is one command:

```bash
npx @getlibero/cli channel add C024BE91L --name engineering
```

It mints the certificate and writes `channels/C024BE91L/channel.toml` pinning it, so no fingerprint
is ever copied by hand. The sheet it writes grants **nothing** — no `[[mcp_server]]`, no
`[[builtin]]`, and the schema's default caps — so the channel authenticates and can call nothing
until you add a block to it. It refuses to touch a channel that already has a sheet.

That is one act because at creation there is no prior sheet to review the change against, and the
operator running the command is the authorization. Changing which key may speak for an existing
channel stays two acts, below. By hand the sequence is the same three steps: create
`channels/<CHANNEL_ID>/channel.toml`, run the script, paste the fingerprint it prints into the
sheet — between the first and last the sheet does not parse and every call is refused, which is the
correct state for a channel that has no key material yet.

Confirm either way with:

```bash
# From the compose network — the proxy publishes no port to the host.
docker compose -f deploy/docker-compose.yml run --rm --entrypoint curl proxy \
  --cacert /etc/libero/certs/ca.pem \
  --cert /path/to/client-C024BE91L.pem --key /path/to/client-C024BE91L.key \
  https://proxy:8443/v1/whoami            # -> {"channel":"C024BE91L"}
```

`libero doctor` checks the same pairing from the host without needing anything running: it reads
every sheet, compares each pin against the certificate on disk, and reports both directions — a pin
with no certificate, and a certificate no sheet pins. It ends with this same `/v1/whoami` probe when
the environment names a reachable `PROXY_URL`, and skips it with this command when compose owns the
address.

`/v1/whoami` is the probe for all of this: 200 with the channel id means the certificate
authenticated and its fingerprint is pinned, and 401 means one of the two is not true. The proxy's
log says which — `identity_rejected` with `reason: "certificate_not_pinned"` carries the
fingerprint that arrived and how many the sheet listed.

The script itself prints the fingerprint and never writes it into a sheet. Minting key material and
authorizing it are two acts, by two authorities, and a script that did both would give back exactly
the property pinning creates. `channel add` is not an exception to that: it authors both files at
once for a channel that has neither, where there is no prior authorization to overwrite and no diff
to review. Every later change to a pin goes through the two-step below.

### Rotating and revoking a certificate

Rotation is four steps and has no gap: at every point at least one valid certificate is pinned, and
neither service is restarted.

```bash
npx @getlibero/cli channel rotate C024BE91L    # 1. mint a replacement, print its fingerprint
                                               # 2. add that fingerprint to the channel's sheet,
                                               #    beside the one already there
npx @getlibero/cli channel promote C024BE91L   # 3. swap the material into place
                                               # 4. remove the old fingerprint from the sheet
```

`sh scripts/dev-certs.sh --rotate` and `--promote` are the same two steps from a checkout; the CLI
ships a copy of that script and runs it. `channel pins` prints every channel's fingerprint and
expiry, which is `--print-pins`.

Step 1 changes nothing in service — the replacement is staged beside what is running. Step 3
refuses to run until step 2 has landed, because promoting first would take the channel offline with
nothing on screen to say why. After step 3 the agent presents the new certificate on its next
request without a restart, and the proxy accepts it because the sheet still pins both.

**Revoking a leaked key** is step 4 on its own: delete that fingerprint, and the next call on that
certificate is refused. Two things are worth knowing about the edit:

- **It is not done until the sheet parses.** A sheet that fails to validate leaves the previous
  version in force — including the fingerprint you were trying to remove. The proxy logs
  `team_sheet_invalid` with `effect: "previous_sheet_retained"` when that happens, and
  `team_sheet_reloaded` when the edit lands. Watch for the second one.

  A `team_sheet_invalid` you did not expect may be the proxy reading your file *while you were
  writing it*: the watcher is live during a write that is not atomic, and a half-written sheet does
  not parse. That case corrects itself, and the reload that corrects it says so —
  `team_sheet_reloaded` carries `supersedes: "team_sheet_invalid"`. So the rule is exact: **a
  complaint with no superseding reload after it is real.** Writing the sheet atomically — to a
  temporary file in the same directory, then `mv` over the target, which is what `libero channel
  add` does — avoids the transient one entirely.
- **The emergency path is deleting the sheet.** That takes effect immediately, is exempt from the
  retain rule above, and takes the channel offline until you restore it. Use it when a key is known
  to be compromised and the sheet edit is not going smoothly.

Either way, `curl … /v1/whoami` with the revoked certificate answering 401 is the confirmation.

The CA is yours: it never leaves the host, it signs only these two roles, and it is not a public
trust anchor. The keys it produces are secrets. Keep `deploy/certs` out of the git repo holding
your team sheets — that repo is meant to be readable by everyone who reviews a manifest, and these
files are not.

## Turning code execution on

Off unless you do this, and a deployment that skips it is unchanged — a channel granting
`run_code` is told the call is permitted and this proxy has nothing to serve it, which is true and
is not a refusal.

It is a fourth container that holds the Docker socket and no credential. That pairing is the whole
design: the socket is equivalent to root on this host, so it belongs anywhere except the process
holding every tool credential. The proxy reaches it over mutual TLS on an internal network the
agent has no route to, and the request it sends has no field naming an image, a mount, or a
capability — the runner builds every container spec itself.

**1. Mint the material.** `sh scripts/dev-certs.sh` already writes the runner's server certificate
and the proxy's client certificate, and prints the fingerprint you need:

```
dev-certs:   RUNNER_CLIENT_PIN=A9:84:C7:1E:...
```

That pin is not optional and not a formality. One CA signs it *and* every channel certificate the
agent holds — so a runner trusting the CA alone would serve a compromised agent process directly,
with no team sheet, no decision, no meter and no audit row.

**2. Choose a sandbox image, by digest.** The runner refuses a floating tag at startup: which
language the sandbox has is a property of your deployment, and a tag makes it a property of
whenever the daemon last pulled.

```bash
docker buildx imagetools inspect python:3.13-slim   # prints the digest
docker pull python:3.13-slim@sha256:...             # the runner never pulls
```

**3. Fill in three values in `.env`.** `libero init` scaffolds them blank with the command that
prints each:

```bash
RUNNER_SANDBOX_IMAGE=python:3.13-slim@sha256:...
RUNNER_CLIENT_PIN=...                 # sh scripts/dev-certs.sh prints it
DOCKER_GID=...                        # getent group docker | cut -d: -f3
```

`DOCKER_GID` is this host's docker group, and it differs between distributions — Debian and
Amazon Linux do not agree. It has no usable default: the fallback is the root group, which every
host has and which opens the socket on none of them, so a deployment that forgot the variable
fails rather than quietly working on whichever distribution somebody guessed.

**4. Uncomment the proxy's four `RUNNER_*` lines** in `deploy/docker-compose.yml`, and start it:

```bash
docker compose -f deploy/docker-compose.yml --profile runner up -d
```

**5. Grant it in a team sheet.** No `approval` line means the hold — a built-in's default is
declared rather than guessed, and this one's is `required`:

```toml
[[builtin]]
name            = "run_code"
cpus            = 1
memory_mb       = 512
timeout_seconds = 30

[egress]
allow = ["api.github.com"]
```

Omit `[egress]` and the run gets no network at all, which is the safe default rather than an
oversight. See [the team sheet reference](/docs/team-sheet) for what a list does and does not
grant — in particular that it covers HTTP and HTTPS only, and that a host outside it ends the run.

### Letting it install packages

The common case, and it takes two hosts. A package index and the file host it
redirects to are different names, so one is not enough:

```toml
[[builtin]]
name            = "run_code"
approval        = "none"      # or omit the line, and every run waits for a click
memory_mb       = 2048
timeout_seconds = 300

[egress]
allow = ["pypi.org", "files.pythonhosted.org"]
```

The npm equivalent is `registry.npmjs.org`; Debian's is `deb.debian.org`. Add
only the index you use — a list is a grant, and each entry is a host sandboxed
code may reach with whatever it has.

Three things about the caps, because the defaults are sized for arithmetic and
not for installing a package tree:

- **`memory_mb` is also the workdir's size.** The scratch directory is a tmpfs,
  and a tmpfs is memory — so the two are one bound rather than two, and a
  program that fills the workdir is killed for exceeding the memory cap. The
  default 512 MB installs `requests`; `numpy` needs more like 2 GB while pip
  unpacks it.
- **`timeout_seconds` covers the install too.** 30 seconds is not enough to
  fetch and unpack a wheel over a filtered connection.
- **The deployment has a ceiling over all three, and it clamps rather than
  refuses.** `RUNNER_MAX_MEMORY_MB` and its two siblings cap what any sheet may
  ask for; the shipped compose file sets 2048 MB, 2 cpus and 300 seconds. Ask
  for more and the run happens with the deployment's number instead, and the
  result says which caps were sized down — so a `numpy` install that dies on a
  host configured tighter than this says so rather than looking like a program
  that failed. Raising it is the operator's edit, not the sheet's.
- **The rootfs is read-only, so install somewhere writable.** `pip install`
  with no target writes to the interpreter's own `site-packages` and fails.
  Point it at the workdir and put that on the path:

```python
import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "--target", "/work/pkgs", "numpy"], check=True)
sys.path.insert(0, "/work/pkgs")
import numpy
```

Nothing persists between calls, so each run that needs a package installs it
again. That is the sandbox working as designed rather than a limit to route
around: a warm cache is state, and state is the thing an ephemeral container
exists not to have.

**Pick a glibc image if you want native wheels.** `python:3.13-slim` is the
straightforward choice — most projects publish `manylinux` wheels and some do
not publish the `musllinux` ones Alpine needs, so `python:3.13-alpine` will
build from source or fail where slim just works.

### Hardening it further with gVisor

The container boundary here is the kernel's, and a container escape is a kernel bug. If that is
inside your threat model, run the daemon with [gVisor](https://gvisor.dev/) (`runsc`) as its
default runtime, which puts a user-space kernel between a sandboxed process and the host's.

It is configured at the daemon and not by us. The runner asks for no runtime, so whatever the
daemon defaults to is what a run gets — which also means the choice applies to every container on
that host, including the services themselves. **We do not test under it**, so treat it as a
deployment you validate rather than a supported configuration: start with a scratch host, and
check that a `run_code` call still returns before you rely on it.

## Operating it

`node dist/audit.js` queries and exports the append-only audit log — every tool call with its
requester, its arguments' hash, its result, and its approver if it had one.

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js list --channel C024BE91L
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js list --since 2026-08-04 --outcome refused
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js show 1422      # one row in full
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js ticket tk-8f2c1b   # one approval's lifecycle
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js open           # held or approved, unresolved
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js csv > audit.csv
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js verify       # walk the hash chain
```

Filters compose — channel, date range, server, tool, outcome — and nothing matching is an empty
result rather than an error. `list` shows the most recent 50 and says when it truncated; `csv`
exports every match, and its header row is a stable contract to script against.

It is a second process against the proxy's own database rather than a command in the published
`libero` CLI, for the reason the vault and budget commands are: it runs where the data is. The
connection is opened **read-only**, so it cannot write the log even by accident, and it is safe to
run against a live proxy. It will not migrate a file from another schema version — migrating is
writing, and a reader that repaired the evidence would not be a reader.

`verify` walks the hash chain and prints the row count and the **tip** — one 64-character hash that
depends on every row in the file. Exit 0 means the chain holds, 3 means it is broken and the first
bad row is named, 1 means the log could not be read at all, so a timer can page different people for
each. Keep the tip somewhere the machine holding the file does not control: the chain catches a row
altered without recomputing the rest, and comparing today's tip against one you recorded last month
is what catches everything else. Rows written before schema version 5 were chained when the column
was added, so they are covered from that migration forward rather than from when they were written.

The row carries a hash of the arguments, never the arguments — and for a **blocked** call, what was
attempted lands in the attempt store instead, a separate deletable file beside the log
([#364](https://github.com/getlibero/libero/issues/364)):

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js attempt 1422
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js attempt-delete 1422
```

`attempt` takes a row id from `list`, or the 64-hex hash a row carries, and prints the arguments the
blocked call was made with. Its content is the model's own text, captured raw with no redaction
claimed — it may contain anything the model saw, which is exactly why it is worth reading after an
incident and why it is **deletable**: `attempt-delete` removes a record, the chained rows stay
byte-identical, and `verify` stays green. The read re-verifies the content against the hash the row
committed to and exits 3 if the file was altered under it. Capture is on in the shipped compose
file; unsetting `PROXY_ATTEMPTS_DB` switches it off, and the proxy says so once at startup.

The hash alone still affords something worth knowing: it is SHA-256 over the arguments as canonical
JSON — object keys sorted, no whitespace — so a reviewer who suspects what a call's arguments were
can check a candidate against any row, captured or not:

```bash
printf '%s' '{"branch":"gh-pages","force":true}' | sha256sum   # compare to the row's arguments hash
```

Budget exhaustion is visible in-thread: the hard limit stops the loop until the UTC day rolls over
or an admin resets the channel. The approach to it is visible too — a channel that passes `[budget]
warn_at` is told once that day, in the thread, on a call that still runs. A reset re-arms that
warning along with the counters.

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js show  C024BE91L   # today's counters
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js days  C024BE91L   # which days hold spend
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js reset C024BE91L   # clears today only
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js prune             # drops turn ids older than 48h
```

The reset is a second process against the proxy's own database rather than a request to the proxy,
for the same reason the vault commands are: it runs where the data is. It takes effect on the
running proxy's next call, so nothing needs restarting. It clears today; earlier days stay as
history.

If you reach models through a LiteLLM, one more command reads a record the reset does not touch —
what the gateway said your calls cost, beside what your own [price table](/docs/price-table/) says
they cost:

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/drift.js show   # every model
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/drift.js days claude-sonnet-4-6
```

It is how a stale price table shows up before the provider's invoice does, and it decides nothing:
no call was refused or allowed because of a figure in it. [Telling when it has gone
stale](/docs/price-table/#telling-when-it-has-gone-stale) has the reading.

`PROXY_BUDGET_DB` is required and has no default — a budget file invented under a path nobody meant
is a channel whose hard limits never bite, which is the one misconfiguration here that fails open.

Scheduled checks have an operator surface too, and it is on the **server** container rather than
the proxy, because the tickets live in each channel's own store and that volume is the agent
side's:

```bash
docker compose -f deploy/docker-compose.yml run --rm server node dist/tasks.js list C024BE91L
docker compose -f deploy/docker-compose.yml run --rm server node dist/tasks.js cancel C024BE91L 7
docker compose -f deploy/docker-compose.yml run --rm server node dist/tasks.js cancelled C024BE91L
```

A cancel is a delete that leaves a record: the check stops being due and can never fire, and what
it said, when it would have run, and when it was called off land in a record `cancelled` prints,
newest first. The record exists because the check being called off is one a human in the channel
approved — a cancel is a person with a shell undoing a person with a click, and that deserves an
account ([#349](https://github.com/getlibero/libero/issues/349)).

The same container carries the one command you have to remember to run. `AGENT_EMBEDDING_MODEL` is
stamped against a channel's stored vectors, and the table holding them has its width fixed when it
is created — so changing the model is a **rebuild**, not a swap:

```bash
docker compose -f deploy/docker-compose.yml run --rm server node dist/rebuild.js C024BE91L
```

Until it has run for a channel, that channel's threads are still summarized and never embedded, and
its semantic recall answers nothing while everything else reports healthy. The rebuild costs
embedding calls and no completion ones — the summaries are already written, so it re-embeds them
rather than asking the model again — and it is safe to run twice: it embeds whatever has no vector,
so a run you interrupted continues where it stopped
([#282](https://github.com/getlibero/libero/issues/282)).

The same container carries one more, which you will need only if you use shared skills and only on a
channel that used to grow its own. Both retrieval legs are blind to which half of the library a
playbook came from, so a channel that has since set `[skills] enabled = false` keeps its old index
rows — and those rows can crowd out the shared skills its sheet *does* name, while being unreachable
in every other sense:

```bash
docker compose -f deploy/docker-compose.yml run --rm server node dist/skill-purge.js C024BE91L
```

Without `--yes` that is a read: it says how many skills are in the index, when the oldest was first
seen, how many have ever been loaded, and that their use counts and both stamps go with the rows
because nothing re-derives them. Add `--yes` to purge. It leaves the channel's `skills/` files
alone — the index is rebuilt from them the next time a task runs with skills on, minus the clocks —
and it leaves shared skills alone entirely.

The switch does not do this by itself on purpose. A sheet that fails to parse falls back to skills
being off, so an automatic purge would let one typo in a `channel.toml` destroy a channel's use
counts and first-seen stamps on the next mention
([#452](https://github.com/getlibero/libero/issues/452)).
SQLite writes `-wal` and `-shm` files beside it, so the *directory* must be writable and not just
the file. Nothing in it is a secret.

`PROXY_AUDIT_DB` is required on the same terms, and holds the audit log: one row per decided tool
call, appended and never rewritten. Its failure mode is the budget's turned quiet — a file under a
path nobody meant produces a deployment that looks audited and has nothing to show when someone
finally looks. It has no reset command, because the table refuses `DELETE` from any connection —
and the read command above opens it read-only, so there is no supported path that writes it at all.
Nothing in it is a secret either: names, ids, and a hash of the model's arguments, never an argument
value and never a credential. A proxy that cannot write this file refuses the call it could not
record rather than serving it unrecorded. The attempt store beside it is the deliberate opposite —
a blocked call's arguments in full, model-authored and possibly secret-bearing, which is why it is
the one deletable file in the volume; see [operating it](#operating-it).

`AGENT_STORE_ROOT` is the agent side's equivalent and is required on the same terms: one
`<channel>/store.db` under it, the *directory* writable for the `-wal` and `-shm` files. **It is
deliberately not a subdirectory of `AGENT_CHANNELS_ROOT`.** Both services mount the channels
directory and it is where the proxy reads its authorization from, so an agent able to write there
could rewrite a `channel.toml` — and the proxy re-reads the sheet per call, which would make that a
compromised agent widening its own permissions. Under compose the channels mount is `:ro` on both
services and this is the one writable volume the agent has.

Unlike the two above, **this one is not "nothing in it is a secret"**: it holds what people said in
a channel, and it belongs to that channel's members. One SQLite file per channel is the isolation
boundary — there is no channel column for a query to forget to filter on — and back it up, or not,
on the terms your Slack retention policy already sets.

`AGENT_SHARED_SKILLS_ROOT` is the third root, optional, and mounted **read-only to the agent
alone**. It holds the playbooks you publish to channels whose sheets name them with
`[[shared_skill]]` — one flat directory of `<name>.md` files, no nesting. Unset is a supported
deployment and so is an empty directory: the server says so once in its log and every channel's own
skills work exactly as before.

It is neither of the two roots above, and the second exclusion is the one worth reading twice. Not
the channels root, because that is the proxy's authorization source. Not the store root either,
because that is the one directory the agent *writes* — a shared skill kept there would be a file a
compromised agent could rewrite, and where a poisoned channel-authored skill costs one channel's
future tasks, a shared skill is read by every channel whose sheet names it. The proxy does not mount
it at all: a shared skill is text for the model, not authorization.

**Content gets in here by vendoring, not fetching.** Copy the file into this directory in your own
repository, pinned however you pin, so an update is a reviewed diff rather than text that changed
under the model overnight. There is no runtime marketplace client and no auto-update, which was
declined rather than deferred — auto-updating text that enters a model's context is an injection
subscription. A `libero skill vendor` command that would do the copying is filed and parked as
[#439](https://github.com/getlibero/libero/issues/439).

`PROXY_STORE_ROOT` is the **same directory**, named again on the proxy side, because the proxy
serves `search_channel_history` and has to read the store to answer it. Two variables for one path
because the two services are configured separately; point them at the same place or the tool finds
every channel empty. Required with no default, on the same terms as the rest — the quiet failure is
a proxy that starts, publishes the tool to every channel whose sheet grants it, and answers each
call with "no messages have been stored for this channel yet".

The proxy opens every store **read-only**, per call, through an opener that has `search` and
`close` on it and no way to write, stamp a version, or migrate. The mount is still read-write, and
has to be: a SQLite WAL reader creates the `-shm` and `-wal` sidecars beside the file, so a `:ro`
mount fails at the first search. It is not `PROXY_CHANNELS_ROOT` and does not merge with it — the
paragraph above is about the agent writing where the proxy reads *authorization*, and this is
neither of those.

The meter uses Node's built-in `node:sqlite` — no dependency, no native build. Both services need
Node 24 or newer: the message store's full-text index needs SQLite's FTS5, and `node:sqlite` was
compiled without it until 22.16. `node:sqlite` became a release candidate in 24.15; below that it
prints an `ExperimentalWarning` at startup. If that is noise in your log collector, either move to
24.15+ or set `NODE_OPTIONS: --disable-warning=ExperimentalWarning` on the service.

Team sheet edits are picked up on file change. An invalid sheet is rejected and the previous valid
version stays active, so a bad edit degrades to "no change" rather than "no enforcement".

## Upgrading

`@getlibero/cli` is the only npm-published package, released with provenance attestations.
Everything else ships as Docker images built from `deploy/docker-compose.yml`. Pin image tags in
your compose file and move them deliberately — the proxy is a security boundary, and you should
know when it changes.
