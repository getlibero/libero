# @getlibero/cli

The command-line interface for [Libero](https://getlibero.com) — the open-source AI teammate
for Slack. Self-hosted, credential-isolated, every tool call audited.

**This CLI owns what an operator authors on the host** — the environment file, the channels
directory, the team sheets, the certificates — all of which are bind-mounted read-only into
the services. What the services own inside their own volumes is reached by the proxy's own
entrypoints instead, because those files are not visible from the host at all:

```bash
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/vault.js  set github_token < token.txt
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/budget.js reset C024BE91L
docker compose -f deploy/docker-compose.yml run --rm proxy node dist/audit.js  list --channel C024BE91L
```

So the vault, the budget and the audit log are deliberately not commands here.

## Commands

- `libero init` — write the deployment's environment file and generate the vault master key
- `libero channel add` — register a channel: its team sheet, and the certificate that speaks for it
- `libero channel rotate` / `promote` / `pins` — replace a channel's key without downtime
- `libero doctor` — check a deployment's wiring *(not built yet)*

### `init`

```bash
npx @getlibero/cli init
```

Writes the operator's half of a deployment's configuration — the two Slack tokens, the
provider and model, the completion key, the optional price table — and generates
`PROXY_VAULT_KEY`, the 32 random bytes that encrypt the credential vault. Everything else the
two services read is set in the compose file, because those are paths inside a container and
a value on the host cannot make them true.

**The file goes beside the compose file**, because that is where Docker Compose looks: with no
`--project-directory` the project directory is the directory holding the compose file, and the
`.env` loaded automatically is the one there. In a checkout of this repository that is
`deploy/.env`; an `.env` at the repository root is read by nothing. The `.env.example` at the
root is a different document and a superset — the contract for running the two processes
directly, with host-relative paths.

**No value is ever written over a non-empty one, and there is no `--force`.** A re-run fills
assignments that are empty, appends variables that are absent, and leaves every other byte
alone, comments included. The asymmetry is one line: every value in the file can be retyped
from where it came from except `PROXY_VAULT_KEY`, which the vault is encrypted under. There is
no escrow and no recovery, so a flag that regenerated it would discard every credential an
operator has loaded. Delete the line by hand if you mean it.

**No command here writes, reads back, or prints a tool credential**, and none has a flag that
takes one. Service credentials go into the vault from inside the proxy container, over stdin,
so the master key and the secrets it encrypts never sit on the host together. The master key
itself is written to a `0600` file and never to stdout.

### `channel add`

```bash
npx @getlibero/cli channel add C024BE91L --name engineering
```

Mints the client certificate whose subject carries `CN=channel:C024BE91L` — the only place the
proxy will read a channel identity from — and writes `channels/C024BE91L/channel.toml` pinning its
fingerprint, so no fingerprint is copied by hand.

**The sheet it writes grants nothing.** No `[[mcp_server]]`, no `[[builtin]]`, and the schema's
default caps: the channel authenticates and can call nothing until an admin adds a block to that
file. `channels/example/channel.toml` documents every field. `add` refuses to touch a channel that
already has a sheet.

**Creating is one act; changing is two.** `scripts/dev-certs.sh` never writes a sheet, on the
principle that minting key material and authorizing it are separate acts — a change to which key
may speak for a channel should be a reviewable edit in git. Creation is not that change: there is no
prior sheet, no diff, and nobody to review it but the person running the command. So `add` writes
both, and rotation keeps the human step:

```bash
npx @getlibero/cli channel rotate C024BE91L    # stages a certificate, prints its fingerprint
                                               # you add it to the sheet, beside the current one
npx @getlibero/cli channel promote C024BE91L   # refuses until the sheet pins it, then swaps
npx @getlibero/cli channel pins                # every channel's fingerprint and expiry
```

`rotate` changes nothing in service. `promote` refuses until the sheet pins the staged fingerprint,
because promoting first would take the channel offline with nothing on screen to say why. Neither
service restarts.

Certificates are minted by `scripts/dev-certs.sh`, a copy of which ships in this package — Node
cannot sign an X.509 certificate, so every path shells out to `openssl` in the end and the choice is
between one implementation and two. It needs `sh` and `openssl` on the host.

## Packaging

One published package, two published files: the bundle, and a copy of `scripts/dev-certs.sh` that
`channel add` runs. The copy is made at build time because npm's `files` cannot name a path outside
the package directory, and it is a copy rather than a move because `packages/proxy` and
`packages/agent` exec the script at its repository path for their test fixtures. CI asserts the two
are byte-identical, which is what keeps a copy from becoming a fork.

`build.mjs` bundles the entry point with esbuild,
inlining `@getlibero/schema` — the workspace package that defines what a team sheet, a model
id and a channel id are — along with zod and smol-toml. So the published manifest declares
**no dependencies**, and installing this reaches no registry twice.

That is a build-time inline of one source of truth rather than a vendored copy: there is no
second checked-in definition to drift from the first, and the build fails here the moment the
schema's exports change. The alternative — publishing `@getlibero/schema` — would put a second
package on a release cadence the core has not needed, and `npm publish` does not rewrite
pnpm's `workspace:*`, so the dependency edge is deleted in CI before the tarball is built.

`engines` is `>=24`, matching the rest of the repository. The deployment's containers carry
their own runtime and do not care what the host has; this is about who can run `init`.

**`scripts/boundary-check.sh` does not cover this package.** It greps the agent side, which is
where the load-bearing import ban lives. The rule here is held by review instead: `packages/cli`
must never depend on `@getlibero/proxy`, because that edge would pull the MCP SDK, the vault's
cipher and the credential-handling code into the one artifact people install from npm. It is
why `src/vault-key.ts` writes out twelve bytes of key generation rather than importing the
constant the proxy already exports.

`@getlibero/cli` is the only npm-published Libero package; the services ship as Docker images.
Follow progress at [github.com/getlibero/libero](https://github.com/getlibero/libero), or ask in
[Discord](https://getlibero.com/discord).
