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
- `libero channel add` — register a channel, its team sheet, and its client certificate *(not built yet)*
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

## Packaging

One published package, one published file. `build.mjs` bundles the entry point with esbuild,
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
