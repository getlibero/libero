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

**`server` sets `stop_grace_period: 20s`**, and it is written down rather than
inherited because the shutdown path now depends on the number (#118). On
`SIGTERM` the server cancels every task and then waits eight seconds for the
cancelled tasks to report their last turn's spend and repaint their checklist
cards. Docker's default grace period is ten seconds, which leaves that drain no
room, and a SIGKILL through it loses exactly what the drain exists to save. An
orchestrator that is not compose needs the same margin — Kubernetes' default
`terminationGracePeriodSeconds` is thirty, which already has it. It is not a
number a task can finish inside: that bound is the channel's `max_task_seconds`,
five minutes by default, and shutdown does not wait for it.

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
shipping the workspace whole. The four assertions live in
`scripts/image-checks.sh`, shared with the release workflow below so what a PR
checks and what a release publishes cannot drift. The job supplies placeholder
values for the two `:?` guards, because compose interpolates the whole file
before it builds; `.env.example` cannot serve, since it ships `PROXY_VAULT_KEY`
empty, which is exactly what `:?` rejects.

## Publishing

Since v0.3.0 a `v*` tag publishes the service images to GHCR — three of them
since v0.4.0 added the runner —
`.github/workflows/release-images.yml`, the GHCR counterpart to the CLI's
`release-cli.yml`: one tag releases the whole deployment (`RELEASING.md` is the
scheme's record), behind a reviewed environment gate, with build provenance
attestations verifiable against the commit that built them:

```bash
gh attestation verify oci://ghcr.io/getlibero/server:v0.4.0 -R getlibero/libero
```

Each release publishes the version tag and moves `latest`. The images are
multi-arch — `linux/amd64` and `linux/arm64`, because the VM guide covers
Graviton and the arm64 sqlite-vec prebuild was already in the lockfile. After
the push, the release workflow pulls each image back by its published digest,
per platform, and runs `scripts/image-checks.sh` against it — the same four
assertions every PR passes, this time against the bytes an operator will pull.

**The compose file keeps its `build:` block.** `docker compose up` from a clean
checkout still builds locally, with no registry access — the quick start's
promise — because compose builds rather than pulls when a service carries
`build:` and the image is absent. An operator who wants the published bytes,
provenance and all, runs `docker compose pull` first, and pins the version tag
in a compose override rather than tracking `latest`, as the VM guide says. The
two paths run the same Dockerfiles; what `pull` adds is that the bytes are
provably the ones the tag built.

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

`../shared-skills` is bind-mounted `:ro` into the **server alone**
(`AGENT_SHARED_SKILLS_ROOT`, #433), and it is the third root rather than a corner
of either of the first two. Not the channels root, because that is the proxy's
authorization source. Not the store root either, and that is the half worth
reading twice: the store root is the one directory the server *writes*, so a
shared skill kept there would be a file a compromised agent could rewrite — and
where a poisoned channel-authored skill costs one channel's future tasks, a
shared skill is read by every channel whose sheet names it. One writable file
poisoning all of them at once is the cross-channel amplification the per-channel
layout exists to prevent. The proxy does not mount it at all: a shared skill is
text for the model, not authorization.

An empty directory is a supported deployment, and so is an unset variable — the
server logs `shared_skills_unconfigured` once and every channel's own skills work
exactly as before.

**Content gets in here by vendoring, not fetching.** Your CI copies a skill file
into this directory in your own repository, pinned however you pin, so an update
is a reviewed diff rather than text that changed under the model overnight. A
`libero skill vendor` command that would do the copying is filed and parked as
[#439](https://github.com/getlibero/libero/issues/439); `shared-skills/README.md`
has the format and the sheet syntax.

`../prices` is bind-mounted `:ro` into the proxy alone, beside the channels
directory and for the same reason: both are host-authored, reviewed, and written
by nobody at runtime. It is inert until `PROXY_PRICE_TABLE` names a file inside
it. The four databases stay in named volumes — the line `CLAUDE.md` draws is that
the CLI owns what the operator authors on the host and a service's own entrypoints
own what that service owns inside its volumes, and a price table is authored.

Since #324 that second half is no longer only the proxy's. `store-data` is a named
volume too, and the scheduled checks in it are read and cancelled through
`docker compose run --rm server node dist/tasks.js` — the server's first operator
entrypoint. It is the server's rather than the proxy's because the proxy mounts
that volume `readOnly` by design and a cancel is a write.

`node dist/rebuild.js <channel>` is the second, and it is there for the same
reason (#282). Changing `AGENT_EMBEDDING_MODEL` under a channel that has already
embedded is a **stated rebuild** — a `vec0` table's width is fixed at creation —
and until the rebuild is run that channel's summaries are written and never
embedded, so its semantic recall quietly answers nothing. Run it once per
channel after changing the variable. It costs embedding calls and no completion
ones, and it is safe to run again.

## The sandbox runner (#368)

Decided in #393, built in #395, and given its egress hop in #219. The argument
is in `packages/proxy/README.md` under "Reaching a runtime" and "Enforcing
`[egress]`"; what follows is what it means for this directory.

**It is behind a `runner` profile**, so `docker compose up` does not start it and
a deployment whose channels never grant `run_code` is unchanged. Turning it on:

```
sh scripts/dev-certs.sh                     # mints runner/ and proxy/client, prints the pin
# set RUNNER_SANDBOX_IMAGE, RUNNER_CLIENT_PIN and DOCKER_GID in .env
# uncomment the proxy's four RUNNER_* variables
docker compose --profile runner up -d
```

A profile rather than a commented-out block, and the difference is not cosmetic:
a commented-out service is not validated, not built by CI, and not covered by
`scripts/image-checks.sh`. `ci.yml` builds with `--profile runner` for exactly
that reason.

**One new service, holding the one privilege.** `runner` mounts the Docker socket
and its own certificate slice, **and nothing else** — no channels, no prices, no
vault, no store, no audit, no budget. It holds no credential, and the list of what
it does not mount is how that stays true. The proxy still does not get the socket;
the compose file says so where the mount would be, and that line does not change
when the runner arrives.

Three networks today, and a fourth when the egress hop lands (#219):

| Network | Members | Reaches |
| --- | --- | --- |
| `libero` (existing bridge) | `server`, `proxy` | Each other, and out. Unchanged. |
| `runner-control` (new, `internal: true`) | `proxy`, `runner` | Each other, nothing else. **The agent has no route to the runner at all** — the mTLS fingerprint pin is the second wall, not the only one. |
| `sandbox-egress` (new bridge, has a default route) | `runner`, and each run's hop | Out. Deliberately **not** `libero`, so an allowed host cannot become a path to `proxy:8443` — the proxy is not on this network. |
| `sandbox-<runid>` (per run, ephemeral, `internal: true`) | one sandbox, one hop | Each other, and nothing else. No route out, which is what enforces `[egress]`. |

**A sheet with no `[egress]` block gets `NetworkMode: none` and no hop at all** —
not a filtered network, no network. With one, the sandbox joins only its own
per-run network and the hop joins that plus `sandbox-egress`, so the single
route out of a run passes through something that checks the channel's list per
host. A test dials a raw address rather than resolving a name, to prove the
enforcement is the topology rather than the proxy environment variables.

The per-run network and its hop are created and destroyed by the runner, which
is why they are not in this file. A leaked one is a bridge interface on the host
that nothing would clean up, so teardown removes containers first and the
network last — the daemon refuses to remove a network something is still
attached to.

Turning egress on is `RUNNER_EGRESS_NETWORK` and `RUNNER_IMAGE` on the runner.
Without them a run gets no network whatever a sheet says, which is the safe
direction, and the runner logs `egress_unavailable` so an operator can see their
channel is asking for something the deployment has not enabled.

**Two bounds on the host, and neither is the channel's** (#405). A team sheet
sizes one run; nothing in it bounds the sum, and nothing in it bounds what a
single sheet may ask for.

- `RUNNER_MAX_CPUS`, `RUNNER_MAX_MEMORY_MB` and `RUNNER_MAX_TIMEOUT_SECONDS` on
  the runner cap what any sheet may ask for. They **clamp rather than refuse** —
  a sheet asking for more gets these numbers and the run still happens — and
  both the channel and the log are told which fields were sized down. Unset
  means no ceiling, which the runner says at boot; this file ships real values,
  so a compose deployment is bounded and a hand-rolled one is not changed under
  its operator.
- `PROXY_MAX_SANDBOX_CONCURRENCY` on the proxy caps how many runs are in flight
  at once. `PROXY_MAX_UPSTREAM_CONCURRENCY` does **not** bound this: it bounds
  the MCP pool, and a socket is not a container. Past the limit a call queues
  briefly and is then told the deployment is full — a 501, not a refusal.

Multiply them — plus a 128 MB hop per run — for the worst case the host can be
asked to hold. That is the number `deploying-on-a-vm.md` asks you to compute
when you turn the sandbox on, and these two variables are what make it a bound
rather than an estimate.

**The one line an operator will get wrong.** The runner runs non-root, like both
existing images and asserted by `scripts/image-checks.sh`, and the Docker socket
is root-owned. Reaching it therefore needs `group_add` with the **host's** docker
group id — which differs between Debian on GCP and AL2023 on AWS. That makes it an
operator variable (`DOCKER_GID`) rather than a number this file can hardcode. Its
default is `0` — the root group, which every host has and which opens the socket
on none of them — so a deployment that forgot the variable fails rather than
quietly working on whichever distribution somebody guessed. `libero init`
scaffolds it blank with the command that prints it.

**The sandbox image is the runner's, and the runner never pulls.** The run request
has no image field — that is most of what makes it narrow — so the image is named
in the runner's own environment, pinned by digest, and pulled at deploy time. A
runner that pulled at call time would put a network dependency, a latency cliff
and a supply-chain surface inside the call path.

The image count is three. `ci.yml` asserts all three and `release-images.yml`
publishes and attests all three on a `v*` tag — the runner ships with the
deployment even though it is opt-in at `up` time, so an operator turning the
sandbox on finds an image already built for the version they are running. When
the egress hop lands it is a second entrypoint on this same image, the pattern
`apps/proxy-server` already uses for `vault`, `audit`, `grant` and `tasks`, so
the count stays at three. `.dockerignore` needed no edit: `!apps` already covers
any new directory under it.

One assumption worth stating rather than discovering: the isolation between these
networks rests on Docker's default iptables rules. A deployment running the daemon
with `--iptables=false` has removed a wall this design leans on, and nothing here
would report it.

## The LiteLLM sidecar (#428)

**Two supported deployment shapes, not a default and an escape hatch.** The
agent completes either directly against a provider or through this sidecar, and
which one you run is a choice with grounds on both sides:

| | Direct | Sidecar |
| --- | --- | --- |
| Processes holding a provider key | The agent | The sidecar, and the agent holds none |
| Hops on the call path | One | Two |
| Routing, fallbacks, rate limits, key rotation across several vendors | Each is the provider's own, or nothing | One place, one config file |
| A cost figure to reconcile the proxy's computed one against | None | Per call (#239) |
| Token counts | Arrive in the provider's own envelope | Arrive in LiteLLM's, and must survive it (#480) |

Neither is the fallback. This is not what you run because `packages/agent` has
no adapter for your provider — the `openai-compatible` arm already reaches
Together, Fireworks, Groq, Baseten, Ollama and Gemini's compatibility endpoint by
base URL alone.

**Behind a `litellm` profile**, for the runner's reason: opt-in, and still a real
service that compose validates rather than a commented-out block that rots.

```
# edit deploy/litellm/config.yaml — the model_list is what you change
# in .env: LITELLM_ANTHROPIC_API_KEY / LITELLM_OPENAI_API_KEY, whichever the list names
# in .env: AGENT_PROVIDER=openai-compatible
#          OPENAI_BASE_URL=http://litellm:4000/v1
#          OPENAI_API_KEY=<any value — it is the sidecar's key, see below>
#          AGENT_MODEL=<a model_name alias from config.yaml>
docker compose --profile litellm up -d
```

### The keys split, and that is the whole custody story

The agent service in this shape **holds no provider key at all**. `OPENAI_API_KEY`
on it is the key for whatever `OPENAI_BASE_URL` names, which is the sidecar — so
it is the sidecar's master key, a different secret to a different party. The
provider keys are `LITELLM_ANTHROPIC_API_KEY` and `LITELLM_OPENAI_API_KEY`, set on
the sidecar alone.

The prefix is not decoration. A stock LiteLLM config reads the unprefixed
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and this compose file already declares
both of those on the *server*, meaning something else. Collapsing the two meanings
onto one name would send the sidecar's own key upstream to OpenAI as a provider
credential — a secret crossing to the wrong party, silently, on a working
deployment.

**The master key is not optional, and LiteLLM will not tell you.** Unset, it
starts anyway and serves every request unauthenticated; that puts the provider
keys behind no check for anything that can reach port 4000. It cannot be a
compose `:?` guard, because compose interpolates the whole file before it decides
which profiles are active — a required variable in a profile-gated service breaks
`docker compose up` for every deployment that does not run that service, this
one's `images` CI job included. So the guard is structural instead: compose sets
`LITELLM_MASTER_KEY: ${OPENAI_API_KEY:-}`, one secret under one name, and the
server's own `requiredEnv` refuses to start without it. There is no configuration
in which the agent runs and the sidecar is unauthenticated.

The service publishes no ports, for the same reason the proxy does not: the agent
reaches it at `litellm:4000` on the private network, and publishing it would put
the provider keys behind one HTTP header on the host's interface.

### The alias is a deployment fact

A `model_name` in the `model_list` is read by three things that have to agree:

- **`AGENT_MODEL`, or a channel's `[llm] model`,** names it. It is what a sheet
  asks for.
- **LiteLLM echoes it back** as the response's `model` — the alias, not the
  upstream id it resolved to. Verified against `main-stable`: `claude-sonnet-4-6`
  backed by `anthropic/claude-sonnet-4-6` comes back `claude-sonnet-4-6`.
- **So it is what lands in the spend report** (#62, `servedModel`), and therefore
  what the proxy's price table must be keyed by. An alias with no row there is an
  unpriced model, and `daily_usd` fails closed on it.

Naming the alias after the upstream model id keeps all three the same string
without anyone having to think about it. An alias must also satisfy `ModelId` —
letters, digits, dot, dash, colon, slash — because the spend report is a strict
schema and an id that does not parse costs the turn its token counts, which is
the limit that catches a runaway loop.

Embeddings go through the same service and the same key: `AGENT_EMBEDDING_PROVIDER=openai-compatible`
with `AGENT_EMBEDDING_BASE_URL=http://litellm:4000/v1`, and
`AGENT_EMBEDDING_API_KEY` left unset so it falls back to `OPENAI_API_KEY`, which
here is the one right answer rather than a convenience. Changing which upstream an
embedding alias resolves to is a **rebuild** for the same reason changing
`AGENT_EMBEDDING_MODEL` is: the id is stamped against a channel's stored vectors.

### What the meter sees through the envelope

All four token tiers arrive, and they are proven against a live sidecar rather
than assumed: `packages/litellm-conformance` starts this image, points the real
adapters at it, and reads what comes back (#480).

Two things are worth knowing before changing anything on this path.

**LiteLLM's `prompt_tokens` is the sum, not the fresh input.** An upstream
reporting 11 fresh input tokens, 7 read from cache and 13 written comes back as
`prompt_tokens: 31` — the OpenAI convention counts cache hits inside the prompt
total, while the meter prices the four tiers by adding four independent terms.
`packages/agent/src/completion/openai.ts` converts between the two. Without that
conversion every cached token is charged twice, once at the input rate and again
at the cache rate, which is the order-of-magnitude error the four tiers exist to
prevent — and it was live on this path until #480.

**The cache-write count exists here and does not exist upstream of here.** Stock
OpenAI has no such field: its caching is implicit and a write is not billed.
LiteLLM in front of a provider that does bill writes emits one, in three
spellings at once — `prompt_tokens_details.cache_write_tokens`,
`prompt_tokens_details.cache_creation_tokens`, and a top-level
`cache_creation_input_tokens`. The adapter reads all three, first one wins,
because which spelling a version keeps is not ours to decide and a missing count
is billed at the input rate.

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
