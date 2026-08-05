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
  pnpm --filter @getlibero/proxy-server start
```

Both database directories have to exist first — nothing here creates one:
`mkdir -p deploy/budget deploy/audit`.

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
| `PROXY_HOST` | `127.0.0.1` | empty means the default; compose sets `0.0.0.0`, on a bridge that publishes no ports |
| `PROXY_PORT` | `8443` | |

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

## The audit log

`PROXY_AUDIT_DB` is one row per decided tool call — served, held, refused, or
permitted with no upstream — appended and never rewritten. Required with no
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

The read path — `libero audit`, with query and CSV export — is #98.

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
