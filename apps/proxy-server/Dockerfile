# The tool proxy. Build from the repository root:
#   docker build -f apps/proxy-server/Dockerfile .
# or through deploy/docker-compose.yml, which sets `context: ..` for exactly
# this reason — the pnpm workspace is the unit that installs, not one package.
#
# This process holds every tool credential in the deployment. What is in its
# filesystem is a security property in the same way its dependency list is:
# anything here is reachable by whatever compromises the process. So the final
# stage carries the built JavaScript and its production dependencies and
# nothing else — no source, no compiler, no test code, no package manager.

# syntax=docker/dockerfile:1

# Pinned to a major, not to a digest. The floor is the workspace's own
# (`engines.node` is >=24.0.0), and it is 24 rather than 22 because
# packages/memory's full-text index needs a node:sqlite compiled with FTS5,
# which is 22.16 and later — Node 24 is the LTS above that line. Tracking the
# tag means a rebuild picks up the base image's security patches, which is worth
# more here than reproducibility is: this image is rebuilt to be redeployed, and
# a digest pin is a promise to notice CVEs by hand.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS build

# Corepack reads `packageManager` from the root package.json, so the pnpm
# version is pinned in one place for CI, the host, and this image alike rather
# than restated here where it could drift.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

# Manifests first, so that editing a source file does not re-resolve the
# dependency tree. Every workspace member is named because
# `--frozen-lockfile` reconciles the lockfile against all of them; a new
# package missing from this list fails the install rather than being skipped.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/schema/package.json   packages/schema/
COPY packages/proxy/package.json    packages/proxy/
COPY packages/agent/package.json    packages/agent/
COPY packages/gateway/package.json  packages/gateway/
COPY packages/memory/package.json   packages/memory/
COPY packages/cli/package.json      packages/cli/
COPY apps/server/package.json       apps/server/
COPY apps/proxy-server/package.json apps/proxy-server/
COPY e2e/package.json               e2e/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
 && pnpm install --frozen-lockfile

COPY . .

# `...` is pnpm's "this package and everything it depends on". The agent's
# packages, the CLI and the e2e suite are not in this image and are not built
# for it — which also means a build failure in one of them cannot fail the
# proxy's release.
RUN pnpm --filter @getlibero/proxy-server... build

# `pnpm deploy --prod` resolves `workspace:*` into a real, self-contained
# node_modules and drops devDependencies. It honours each package's `files`
# field, which is why the workspace packages declare `["dist"]` — without it the
# TypeScript sources are copied in beside the JavaScript built from them.
RUN pnpm deploy --filter=@getlibero/proxy-server --prod /out

# What tsc emits beside the JavaScript, and what `files: ["dist"]` cannot
# exclude because it all lands in dist together (the same fact that makes every
# `test` script carry `--exclude '**/dist/**'`). Stripping it here rather than
# by splitting each package's tsconfig keeps tests inside `pnpm typecheck`, and
# covers a package added later without that package having to remember
# anything.
#
# The test files are the ones that matter in this image: the proxy's test tree
# includes a fake MCP server and canary credentials, and none of that should be
# sitting in the process that holds the vault. The declarations and source maps
# are dead weight rather than a hazard — nothing sets `--enable-source-maps` and
# Node never reads a .d.ts — but they exist only to describe source this image
# deliberately does not carry, and their `sources` entries name paths that are
# not here.
#
# Scoped by -path to what this workspace built. Third-party packages ship their
# own declarations and are left exactly as their publisher shipped them.
RUN find /out -type f \
      \( -name '*.test.js' -o -name '*.d.ts' -o -name '*.map' \) \
      \( -path '/out/dist/*' -o -path '*/@getlibero/*' \) \
      -exec rm -f {} +

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production

# `node` (uid 1000) ships with the base image. Nothing here runs as root.
WORKDIR /app
COPY --from=build --chown=node:node /out /app

# The three volume mount points, created owned by the runtime user. This is
# load-bearing rather than tidy: Docker seeds an empty named volume from the
# image's directory at that path, ownership included, so without these the
# volumes arrive owned by root and a non-root proxy cannot open its vault,
# write its meter, or append to its audit log. Each is a directory rather than
# a file because SQLite writes -wal and -shm beside its database.
RUN mkdir -p /data/vault /data/budget /data/audit && chown -R node:node /data

USER node

# No ENTRYPOINT, so that the operator's documented commands are the whole
# command line and read the way they are written:
#   docker compose run --rm proxy node dist/vault.js set <name>
#   docker compose run --rm proxy node dist/budget.js reset <channel>
#   docker compose run --rm proxy node dist/audit.js list --channel <id>
# An `ENTRYPOINT ["node"]` would silently make those `node node dist/...`.
#
# Node is PID 1 and that is deliberate: both entrypoints install SIGTERM and
# SIGINT handlers, so `docker stop` is a clean shutdown and an init shim would
# add a process without adding a signal.
CMD ["node", "dist/index.js"]
