# @getlibero/proxy-server

Unpublished workspace package. The tool-proxy process: composition only, with
the behavior in [`@getlibero/proxy`](../../packages/proxy). See
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the specification.

```bash
sh scripts/dev-certs.sh --channels C024BE91L   # from the repo root
pnpm -r build

PROXY_TLS_CERT=deploy/certs/proxy/server.pem \
PROXY_TLS_KEY=deploy/certs/proxy/server.key \
PROXY_TLS_CA=deploy/certs/ca.pem \
PROXY_CHANNELS_ROOT=channels \
PROXY_VAULT_FILE=deploy/vault/vault.enc \
PROXY_VAULT_KEY="$(openssl rand -base64 32)" \
PROXY_BUDGET_DB=deploy/budget/budget.db \
PROXY_AUDIT_DB=deploy/audit/audit.db \
PROXY_STORE_ROOT=deploy/store \
  pnpm --filter @getlibero/proxy-server start
```

The script prints each certificate's fingerprint; paste it into that channel's
`channel.toml` under `[channel] certificate_sha256`, which this process checks
on every request. `sh scripts/dev-certs.sh --print-pins` prints them again.

Both database directories have to exist first — nothing here creates one:
`mkdir -p deploy/budget deploy/audit`. `PROXY_STORE_ROOT` is the agent's
`AGENT_STORE_ROOT`, and the agent creates the per-channel directories under it.

| variable | default | |
| --- | --- | --- |
| `PROXY_TLS_CERT` | — | the proxy's own certificate |
| `PROXY_TLS_KEY` | — | its private key |
| `PROXY_TLS_CA` | — | the CA every client certificate is checked against |
| `PROXY_CHANNELS_ROOT` | — | team sheets, at `<root>/<channel id>/channel.toml` |
| `PROXY_VAULT_FILE` | — | the encrypted credential vault |
| `PROXY_VAULT_KEY` | — | its master key: base64, 32 bytes |
| `PROXY_BUDGET_DB` | — | the daily budget meter |
| `PROXY_AUDIT_DB` | — | the append-only audit log |
| `PROXY_STORE_ROOT` | — | the agent's per-channel message stores, read read-only for `search_channel_history` |
| `PROXY_HOST` | `127.0.0.1` | empty means the default; compose sets `0.0.0.0`, on a bridge that publishes no ports |
| `PROXY_PORT` | `8443` | |
| `PROXY_MAX_RESPONSE_BYTES` | `4194304` | how much of an upstream's answer to hold before abandoning it |

`PROXY_MAX_RESPONSE_BYTES` is the one knob here that is a capacity decision
rather than an address. Past it a response is abandoned mid-read — the reader is
cancelled, nothing is decoded, and the call comes back as `too_large` — which is
what stops one upstream from spending this process's memory without limit.

It is deliberately **not** a team sheet field, unlike the companion bound on how
much of a result reaches the model (`[llm] max_result_chars`). That one is
charged against a channel's own token budget, so a channel raising it spends only
its own; this one buys memory in a process every channel shares. And it is
deliberately not hardcoded: the operator who sized the container is the one who
should say how much of it a response may occupy. There is no upper bound for the
same reason — you own the heap.

Raising it costs more than the number says. Budget roughly three to five times
its value per concurrent call: the decoded string, the redaction pass's output
copy, and the parsed object graph all exist at once. Four megabytes is
comfortably above any real `tools/list` catalog and any ordinary tool answer.

Everything without a default is required, and a missing one stops the process at
startup rather than degrading. For the TLS paths the reason is that a proxy
which came up without mutual TLS would be reachable, unauthenticated, and
holding every credential in the deployment. For the channels root and the vault
the reason is quieter: a path that defaulted to somewhere empty would look
exactly like a correct one holding nothing, and the symptom — every call
refused, every credential unresolved — would surface at the far end of a Slack
thread instead of here.

## The credential vault

Secrets are encrypted at rest with `PROXY_VAULT_KEY` and referenced by name
everywhere else — in team sheets, in logs, in refusals. Loading them is a
separate entrypoint of this same process:

```bash
docker compose run --rm proxy node dist/vault.js set github_service_account < token.txt
docker compose run --rm proxy node dist/vault.js list
docker compose run --rm proxy node dist/vault.js remove github_service_account
```

`github_service_account` is not a placeholder name — it is the one
`channels/example/channel.toml` refers to, and the walk from that command to a
served GitHub tool call is `site/src/content/docs/docs/github.md`.

Running it in the container is the point: the vault file is in a container
volume and the master key is in that container's environment, so editing from
the host would mean putting the key on the host. Locally, `pnpm --filter
@getlibero/proxy-server vault set <name>` does the same thing with the
variables set in your shell.

The value is read from **stdin**, never from an argument — `ps` and
`/proc/<pid>/cmdline` show argv to every user on the box, and a shell writes it
to history. There is no command that prints a value back.

The proxy reads the vault once, at startup, so a change takes effect on
restart. Losing `PROXY_VAULT_KEY` means losing the vault: there is no recovery
path and no escrow.

Passing the key by environment variable is the phase-1 form, and it is readable
by anyone who can `docker inspect` the container — as `SLACK_APP_TOKEN` and
`ANTHROPIC_API_KEY` already are. A file-backed or KMS-backed key source is the
hardened path and is not built.

The vault is opened at startup, before anything binds, so a wrong key or an
unreadable file is a startup failure rather than a surprise at the far end of a
Slack thread.

## The budget

`PROXY_BUDGET_DB` is the daily meter: tool calls and tokens, per channel per UTC
day, authoritative. Required with no default, and opened before anything binds
for the same reason the vault is — but this one is the misconfiguration that
fails *open*, because a budget file under a path nobody meant is a channel whose
hard limits never bite. SQLite writes `-wal` and `-shm` beside it, so the
directory has to be writable and not just the file. Nothing in it is a secret.

```bash
docker compose run --rm proxy node dist/budget.js show  C024BE91L
docker compose run --rm proxy node dist/budget.js reset C024BE91L
docker compose run --rm proxy node dist/budget.js prune
```

## The channel message stores

`PROXY_STORE_ROOT` is the agent's `AGENT_STORE_ROOT` — the same directory, named
again because the two services are configured separately. The proxy reads it to
answer `search_channel_history`, the one tool it implements itself rather than
dialling an upstream for.

**Read-only, per call.** The opener has `search` and `close` on it and no way to
append, remove, edit, stamp a version, or migrate; the connection is opened
`readOnly`, which is the posture the audit reader already takes. Nothing here
creates a directory: a channel with no store yet is answered "no messages have
been stored for this channel yet", which is the ordinary state of a newly
provisioned channel.

The *mount* has to be writable all the same, and that surprises people: a SQLite
WAL reader creates the `-shm` and `-wal` sidecars beside the file, so a `:ro`
mount fails at the first search.

**It is not `PROXY_CHANNELS_ROOT` and must not be merged with it.** Team sheets
are where this process reads its authorization from and the proxy re-reads one
per call, so an agent able to write there would be a compromised agent widening
its own permissions. The store lives on the agent's writable side; reading it
from here crosses that line in the safe direction and in one direction only.

Unlike the vault, the meter and the log, **this one holds content rather than
operator records**: it is what people said in a channel, and it belongs to that
channel's members. One SQLite file per channel is the isolation boundary, and the
opener closes over exactly one file — so `search_channel_history` has no argument
that could reach another channel, and no statement that could.

## The audit log

`PROXY_AUDIT_DB` is one row per decided tool call — served, held, refused,
permitted with no upstream, or decided and then never answered because the
handler failed — appended and never rewritten. Exactly one row per decided call,
in both directions: none escapes without one, and none gets two. Required with no
default, and opened before anything binds, on the same argument as the budget
with the failure mode turned quiet: a file under a path nobody meant produces a
deployment that looks audited and has nothing to show when someone finally
looks. Nothing in it is a secret: names, ids, and a hash of the model's
arguments, never an argument value and never a credential.

**A proxy that cannot write this file refuses the call it could not record.**
That is deliberate — serving a stream of calls with no record is the failure
worth avoiding, and the realistic causes (a full disk, a read-only mount) are
conditions that should stop the process.

Append-only is enforced on the table by `BEFORE UPDATE` and `BEFORE DELETE`
triggers, so it holds for `sqlite3` and any other connection, not just this
process. There is no reset or prune command and there will not be one: deleting
rows from an audit log is the operation an attacker wants. Growth is about 200
bytes a row, so 10k calls a day is roughly 2 MB a day; when that stops being
small the answer is to rotate the file.

### Reading it

`node dist/audit.js`, a third entrypoint beside the vault's and the budget's,
and one for the same reason: the file is in a container volume the host cannot
see, so it is not a command in the published `libero` CLI.

```bash
docker compose run --rm proxy node dist/audit.js list --channel C024BE91L
docker compose run --rm proxy node dist/audit.js list --since 2026-08-04 --outcome refused
docker compose run --rm proxy node dist/audit.js show 1422
docker compose run --rm proxy node dist/audit.js ticket tk-8f2c1b
docker compose run --rm proxy node dist/audit.js open
docker compose run --rm proxy node dist/audit.js csv --since 2026-08-01 > audit.csv
```

`list` shows the most recent 50 by default and says so when it truncated; `csv`
exports every match. Filters compose, and nothing matching is an empty result
rather than an error. `open` answers the two questions the table cannot answer by
counting: a held call nobody resolved, and an approval nobody redeemed — both are
a ticket whose last row is `held` or `approved`, because there is no sweep and no
timer, so `expired` rows count *observed* expiries only.

**It cannot write.** The connection is opened read-only, so SQLite refuses a
write before the triggers have to, and there is no command that deletes, prunes
or rotates. It does not migrate either: a file from another schema version is
refused with both numbers named, because migrating is writing and a reader that
repaired the file would be a reader that changed the evidence. It is safe to run
against a live proxy — the database is WAL — and it resolves no credential and
opens no vault.

Two things about the CSV worth knowing before you script against it. The header
row is the contract and a new column is appended at the end, so positional
indexing keeps working. And a field beginning with `=`, `+`, `-` or `@` is a
formula to a spreadsheet: `call_id` is model-authored, and this export records
what was written rather than altering it, so open it as text if that matters.

## Pending approvals do not survive a restart

The approval broker's tickets live in memory. There is no environment variable,
no file, and nothing for the shutdown handler to close — which is the deliberate
half of the design rather than an omission.

What that means operationally: **restart the proxy and every approval card in
flight goes stale.** The calls behind them are never served, the person who
clicks gets a refusal saying the approval is unknown, and the agent raises a
fresh hold on the next attempt. Nothing is served unapproved either way, which
is why losing this state is acceptable — it fails in the direction that refuses.

Plan a restart the way you would plan one that drops in-flight requests. If a
destructive call is waiting on someone, it will need asking again.

### Schema version 3

This build writes schema version 3, and **migrates a version 1 or version 2 file
in place the first time it opens one**. The migration rebuilds the table inside
one transaction: a crash during it leaves the original file untouched and the
next start tries again. Back up the file first if you would rather not rely on
that.

Two consequences worth knowing before you roll:

- **Rolling back to a previous build will not start** against a migrated file.
  That is the existing behaviour of the version check rather than something new,
  and it is the right one — a build writing rows a later one cannot read leaves
  an incident review with a gap it has no way to notice — but until now it was
  not reachable. Rolling back means restoring the file alongside the binary.
- Version 2 adds the approval broker's outcomes (`approved`, `denied`,
  `expired`) and a `ticket` column tying an approval's rows together. Version 3
  adds one more outcome, `unanswered` — a call the proxy decided and metered and
  then failed to answer — and no column. Existing rows keep their ids, their
  order, and every value they had; a column an older file did not have is null
  on all of them.
- **`node dist/audit.js` will not read a file this build has not migrated.** In
  a normal deployment it runs from the same image as the proxy, so it sees a
  file the proxy has already brought forward; pointed at an older copy, it says
  which version it found and which it reads, and does not migrate it.

A second entrypoint rather than a route, and that is the security argument
rather than a convenience one. A reset makes a hard limit soft again; the proxy
has no admin principal, since identity is `CN=channel:<id>` and nothing else; and
`daily_tool_calls` surviving compromise of the agent process is exactly what a
reset verb on the agent's listener would cost. It takes effect on the running
proxy's next call — the database is WAL and the meter caches nothing — so
nothing needs restarting.

The counters `show` prints are raw. What they cost against `daily_tokens`
depends on the channel's `cache_read_weight` and `cache_write_weight`, which are
read from the team sheet when a call is decided.
