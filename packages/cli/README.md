# @getlibero/cli

The command-line interface for [Libero](https://getlibero.com) — the open-source AI teammate
for Slack. Self-hosted, credential-isolated, every tool call audited.

**This is a placeholder release.** It claims the package name and proves the release path:
published from CI on a `cli-v*` tag with npm provenance attestations. Running it prints a
pointer to the repository and nothing else.

Commands land in phase 1 alongside the governed core:

- `libero init` — scaffold host configuration and generate the vault master key
- `libero channel add` — register a channel, its team sheet, and its client certificate
- `libero doctor` — check a deployment's wiring

**This CLI owns what an operator authors on the host** — the channels directory, the
certificates, the configuration file — all of which are bind-mounted read-only into the
services. What the services own inside their own volumes is reached by the proxy's own
entrypoints instead, because those files are not visible from the host at all:

```bash
docker compose run --rm proxy node dist/vault.js  set github_token < token.txt
docker compose run --rm proxy node dist/budget.js reset C024BE91L
docker compose run --rm proxy node dist/audit.js  list --channel C024BE91L
```

So the vault, the budget and the audit log are deliberately not commands here.

`@getlibero/cli` is the only npm-published Libero package; the services ship as Docker images.
Follow progress at [github.com/getlibero/libero](https://github.com/getlibero/libero), or ask in
[Discord](https://getlibero.com/discord).
