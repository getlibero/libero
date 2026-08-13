# deploy/

`docker compose up` for both services, the certificates they authenticate with,
and the LiteLLM sidecar's configuration.

Operator instructions live at
[getlibero.com/docs/self-hosting](https://getlibero.com/docs/self-hosting). This
file is what the build does and why, for whoever changes it.

## The images

`apps/*/Dockerfile` are multi-stage over the **whole workspace** — `context: ..`,
because the pnpm workspace is what installs, not one package. The final stage is
`pnpm deploy --prod`'s output, which resolves `workspace:*` into a real
`node_modules` and drops devDependencies.

Four things about them are decisions rather than mechanics.

**`pnpm deploy` honours each package's `files` field, which is why the shipped
packages declare `["dist"]`.** Without it the TypeScript sources are copied in
beside the JavaScript built from them. What `files` cannot exclude is what `tsc`
emits *into* `dist`: the compiled tests, the declarations, and the source maps.
Those are stripped by one `find` in the builder rather than by giving each
package a second tsconfig — which keeps tests inside `pnpm typecheck` and covers
a package added later without that package having to remember anything. The tests
are the ones that matter: the proxy's test tree carries a fake MCP server and
canary credentials, and none of that belongs in the process that holds the vault.
The strip is scoped by `-path` to what this workspace built, so a dependency is
left as its publisher shipped it.

**The mount points are created in the image, owned by the runtime user.** Docker
seeds an empty named volume from the image's directory at that path, ownership
included — so without `/data/{vault,budget,audit}` and `/data/store` existing as
`node`, the volumes arrive owned by root and a non-root service cannot open its
vault or write its meter.

**Neither image sets an `ENTRYPOINT`**, so the operator's documented commands are
the whole command line. An `ENTRYPOINT ["node"]` would silently turn
`docker compose run --rm proxy node dist/vault.js set <name>` into
`node node dist/...`. Node is PID 1 because both entrypoints install `SIGTERM`
and `SIGINT` handlers, so an init shim would add a process without adding a
signal.

**`.dockerignore` is an allowlist**, and that is this repository's shape rather
than a habit. The build context is the repository root, which is also where
`deploy/certs/` (the CA key and every channel's client key), `deploy/vault/`, and
`.env` live. Denying by default means the next directory of deployment state is
excluded the day it is created rather than the day someone remembers. The cost is
that a new workspace package must be named there and in each Dockerfile's
manifest-copy block — and it fails loudly, because `--frozen-lockfile` cannot
reconcile against a manifest that is not there.

The `images` job in `.github/workflows/ci.yml` builds through this compose file
and then asserts those properties against the built images — non-root, no source,
no compiled tests, no toolchain — on `boundary-check`'s argument that a
multi-stage build and a `--prod` prune are each one edit away from silently
shipping the workspace whole. It supplies placeholder values for the two `:?`
guards, because compose interpolates the whole file before it builds;
`.env.example` cannot serve, since it ships `PROXY_VAULT_KEY` empty, which is
exactly what `:?` rejects.

## The mounts

The channels directory is bind-mounted `:ro` **into both services**, and that is
a security property rather than tidiness: it is where the proxy reads its
authorization from, the proxy re-reads a sheet per call, and an agent able to
write there would be a compromised agent widening its own permissions.

The message store is a separate root (`AGENT_STORE_ROOT`, `PROXY_STORE_ROOT`) for
the same reason — the agent writes it, so it cannot live under the directory the
proxy reads sheets from. That mount is read-write on both services even though
every open on the proxy's side is read-only, because a WAL reader creates the
`-shm`/`-wal` sidecars and `:ro` would fail at the first search. The read-only-ness
is `{ readOnly: true }` on the connection, not the mount.

`../prices` is bind-mounted `:ro` into the proxy alone, beside the channels
directory and for the same reason: both are host-authored, reviewed, and written
by nobody at runtime. It is inert until `PROXY_PRICE_TABLE` names a file inside
it. The three databases stay in named volumes — the line `CLAUDE.md` draws is
that the CLI owns what the operator authors on the host and the proxy's own
entrypoints own what the services own inside their volumes, and a price table is
authored.

## Upgrading across #62: proxy first

**Upgrade the proxy before the agent.** The spend report gained a `model` field,
`SpendReport` is a strict schema, and an *old* proxy answers 400 to a body
carrying a field it does not know. So a new agent against an old proxy fails
every spend report: `daily_tokens` runs blind while `daily_tool_calls` keeps
working — the meter failing open, quietly, for as long as the pair is mismatched.

The other order is fine. A new proxy accepts an old agent's reports exactly as
before; they arrive without a model, land in the `(unreported)` bucket, and
change nothing for a channel that has not set `budget.daily_usd`.

`docker compose up -d` on both at once is also fine — it is only a staged rollout
that holds one at the old image that has the window.

`certs/` holds the CA, the proxy's keypair, and one client certificate per
channel, laid out by role so each container mounts only its slice and the CA key
is mounted into neither. `scripts/dev-certs.sh` mints them, and re-running it
mints only what is missing — a client certificate in service must not be
replaced silently, because each channel's team sheet pins the fingerprint of the
one it accepts (#79). `--rotate` then `--promote` replaces one with no downtime;
`--print-pins` prints what to paste into a sheet, and when each expires.

## The Slack app manifest

`slack-app-manifest.yml` is what an operator pastes into *Create New App → From
an app manifest*. It is the only file here that configures something outside the
deployment, and it is checked in for the reason the compose file is: the scopes
are a list of checkboxes, and a wrong one is a permission granted for years.

**One file with commented sections, rather than a minimal one and a full one.**
The scopes that answer a mention are a strict subset of the set that also fills
the message store, so two files would say the same thing twice and fall out of
step the first time a scope moves. What one file costs a reader is two comments
naming the lines to delete — `groups:history` and `message.groups`, for a
deployment serving only public channels; what two would cost is a second file to
remember to edit.

**It is exact, and staying exact is the whole thing to check when it changes.**
The failure a manifest invites is a scope that outlives the feature that needed
it — nobody notices a permission that is merely unused. So every line carries the
call or the event that needs it, and a scope granted for work that has not landed
names its issue instead. The scope and event tables in
`site/src/content/docs/docs/self-hosting.md` are the long-form version of those
comments and are meant to agree with them line for line.

Two fields it sets that no code would notice: `always_online: false`, so a
workspace can see the gateway is down rather than being told it is up, and
`token_rotation_enabled: false`, because the gateway reads `SLACK_BOT_TOKEN` from
its environment and never writes one back — rotation on would expire the token
the deployment holds.

Not a Slack Marketplace listing. Distributing a Libero app through the directory
would mean Slack review and this project holding a distributed app's identity;
what this file describes is an app an operator creates in their own workspace.
