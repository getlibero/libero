# The sandbox runner. Build from the repository root:
#   docker build -f apps/runner/Dockerfile .
# or through deploy/docker-compose.yml, which sets `context: ..` for the reason
# the other two do — the pnpm workspace is the unit that installs.
#
# This process holds the Docker socket, which is equivalent to root on the host.
# It holds no credential, and those two facts together are the whole of #393's
# decision: the socket did not come back to the proxy, it moved to a service
# that has nothing worth stealing. See packages/proxy/README.md, "Reaching a
# runtime", for the argument and for the shapes rejected on the way to it.
#
# So what is in this filesystem matters for the same reason it matters in the
# proxy's image, pointing the other way: anything here is reachable by whatever
# compromises the process that can start containers. It carries the built
# JavaScript and @getlibero/schema, and that is the entire dependency tree —
# the runner speaks the Docker Engine API over `node:http` rather than through a
# client library, precisely so this list stays one line long.

ARG NODE_VERSION=24

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS build

RUN corepack enable

WORKDIR /repo

# Manifests first, so that editing a source file does not re-resolve the
# dependency tree. Every workspace member is named because
# `--frozen-lockfile` reconciles the lockfile against all of them; a new
# package missing from this list fails the install rather than being skipped.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/atomic-write/package.json packages/atomic-write/
COPY packages/schema/package.json       packages/schema/
COPY packages/proxy/package.json        packages/proxy/
COPY packages/agent/package.json        packages/agent/
COPY packages/gateway/package.json      packages/gateway/
COPY packages/memory/package.json       packages/memory/
COPY packages/cli/package.json          packages/cli/
COPY packages/test-kit/package.json     packages/test-kit/
COPY apps/server/package.json           apps/server/
COPY apps/proxy-server/package.json     apps/proxy-server/
COPY apps/runner/package.json           apps/runner/
COPY e2e/package.json                   e2e/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
 && pnpm install --frozen-lockfile

COPY . .

# `...` is pnpm's "this package and everything it depends on", which here is the
# runner and @getlibero/schema. The proxy's package is not in this image and is
# not built for it — a runner that could import the vault is the drift #393's
# whole topology exists to prevent, and not shipping the code is the strongest
# form of that.
RUN pnpm --filter @getlibero/runner... build

# `pnpm deploy --prod` resolves `workspace:*` into a real, self-contained
# node_modules and drops devDependencies. It honours each package's `files`
# field, which is why the workspace packages declare `["dist"]` — without it the
# TypeScript sources are copied in beside the JavaScript built from them.
RUN pnpm deploy --filter=@getlibero/runner --prod /out

# What tsc emits beside the JavaScript, stripped for the reason the other two
# images strip it — and here the test files are the ones that matter most:
# `sandbox.docker.test.ts` exists to start containers, and it has no business in
# the image of the process that can.
RUN find /out -type f \
      \( -name '*.test.js' -o -name '*.d.ts' -o -name '*.map' \) \
      \( -path '/out/dist/*' -o -path '*/@getlibero/*' \) \
      -exec rm -f {} +

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim

ENV NODE_ENV=production

# `node` (uid 1000) ships with the base image. Nothing here runs as root, which
# `scripts/image-checks.sh` asserts against every published image.
#
# Reaching a root-owned socket as a non-root user is what `group_add` in the
# compose file is for, and it takes the *host's* docker gid — which differs
# between distributions. That is why it is an operator variable rather than a
# number baked in here: a gid guessed at build time is a gid that is wrong on
# half the hosts this image runs on.
WORKDIR /app
COPY --from=build --chown=node:node /out /app

USER node

# No ENTRYPOINT, matching the other two images: an operator's command line
# should read the way it is written.
#
# Node is PID 1 deliberately — the entrypoint installs SIGTERM and SIGINT
# handlers, so `docker stop` is a clean shutdown and an init shim would add a
# process without adding a signal.
CMD ["node", "dist/index.js"]
