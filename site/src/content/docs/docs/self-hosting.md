---
title: Self-hosting
description: The target deployment — two containers, one team sheet per channel — and an honest account of what does not work yet.
---

:::caution[Not deployable yet]
This page describes the target deployment. What exists today is phase 1, part-built: the proxy
process starts, speaks mutual TLS, binds every request to a channel, enforces team sheets, holds
credentials in an encrypted vault, injects them into outbound calls, scrubs them back out of
results, meters the daily budget, and appends an audit row for every decided call. The Slack
gateway and the agent loop exist and reach tools through the proxy, and approvals are joined end
to end: a held call raises an amber card in the channel, and an approver's click re-submits the
identical call with the ticket.

The proxy speaks MCP for real, and [GitHub's hosted server](/docs/github/) is documented and
exercised end to end. The end-to-end suite that attacks all of this exists: it composes both halves
over real mutual TLS, fakes only the Slack socket and the model, and covers exfiltration, budget
exhaustion, held destructive calls, and channel isolation.

Both services build as images from the compose file, so
`docker compose -f deploy/docker-compose.yml up` starts a deployment from a clean checkout.

What is not finished: certificate rotation and revocation are manual —
possible without downtime, and driven by a shell script and an edit to a team sheet rather than by
anything automated. Do not run this against a workspace you care about.
:::

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
step done by hand — see [pinning a channel's certificate](#pinning-a-channels-certificate). An
optional LiteLLM sidecar is included for models without first-class support.

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

**A model provider.** Anthropic natively; OpenAI, Groq, Ollama, and Gemini through their
OpenAI-compatible endpoints — set globally and overridable per channel in the team sheet.

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
- **The emergency path is deleting the sheet.** That takes effect immediately, is exempt from the
  retain rule above, and takes the channel offline until you restore it. Use it when a key is known
  to be compromised and the sheet edit is not going smoothly.

Either way, `curl … /v1/whoami` with the revoked certificate answering 401 is the confirmation.

The CA is yours: it never leaves the host, it signs only these two roles, and it is not a public
trust anchor. The keys it produces are secrets. Keep `deploy/certs` out of the git repo holding
your team sheets — that repo is meant to be readable by everyone who reviews a manifest, and these
files are not.

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
```

Filters compose — channel, date range, server, tool, outcome — and nothing matching is an empty
result rather than an error. `list` shows the most recent 50 and says when it truncated; `csv`
exports every match, and its header row is a stable contract to script against.

It is a second process against the proxy's own database rather than a command in the published
`libero` CLI, for the reason the vault and budget commands are: it runs where the data is. The
connection is opened **read-only**, so it cannot write the log even by accident, and it is safe to
run against a live proxy. It will not migrate a file from another schema version — migrating is
writing, and a reader that repaired the evidence would not be a reader.

Budget exhaustion is visible in-thread: the hard limit stops the loop until the UTC day rolls over
or an admin resets the channel. The approach to it is visible too — a channel that passes `[budget]
warn_at` is told once that day, in the thread, on a call that still runs. A reset re-arms that
warning along with the counters.

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js show  C024BE91L   # today's counters
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js reset C024BE91L   # clears today only
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
finally looks. It has no reset command, because the table refuses `DELETE` from any connection —
and the read command above opens it read-only, so there is no supported path that writes it at all.
Nothing in it is a secret either: names, ids, and a hash of the model's arguments, never an argument
value and never a credential. A proxy that cannot write this file refuses the call it could not
record rather than serving it unrecorded.

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
