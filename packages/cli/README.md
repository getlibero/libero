# @getlibero/cli

The command-line interface for [Libero](https://getlibero.com) — the open-source AI teammate
for Slack. Self-hosted, credential-isolated, every tool call audited.

**This is a placeholder release.** It claims the package name and proves the release path:
published from CI on a `cli-v*` tag with npm provenance attestations. Running it prints a
pointer to the repository and nothing else.

Commands land in phase 1 alongside the governed core:

- `libero init` — scaffold host configuration and the encrypted vault
- `libero channel add` — register a channel and its team sheet
- `libero audit` — query and export the append-only audit log
- `libero budget reset` — reset a channel's daily budget
- `libero doctor` — check a deployment's wiring

`@getlibero/cli` is the only npm-published Libero package; the services ship as Docker images.
Follow progress at [github.com/getlibero/libero](https://github.com/getlibero/libero).
