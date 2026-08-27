# The gateway + agent process. Build from the repository root:
#   docker build -f apps/server/Dockerfile .
# or through deploy/docker-compose.yml, which sets `context: ..`.
#
# The structure, the base image, and the reasoning behind each stage are the
# same as apps/proxy-server/Dockerfile, which carries the full commentary. Two
# files rather than one shared base, because the compose file names a dockerfile
# per service and the two images differ in what they build, what they write, and
# how much care the contents warrant.
#
# This process holds the Slack app and bot tokens and the model provider key. It
# holds no tool credential — those live only in the proxy, and this process
# reaches tools only by calling it over mTLS.

# syntax=docker/dockerfile:1

# The base is `-slim` and not `-alpine`, for packages/memory's sqlite-vec — the
# full argument is in apps/proxy-server/Dockerfile, and it applies here because
# this image carries that package too, to write the message store.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/atomic-write/package.json packages/atomic-write/
COPY packages/schema/package.json       packages/schema/
COPY packages/proxy/package.json        packages/proxy/
COPY packages/agent/package.json        packages/agent/
COPY packages/gateway/package.json      packages/gateway/
COPY packages/memory/package.json       packages/memory/
COPY packages/cli/package.json          packages/cli/
COPY packages/test-kit/package.json     packages/test-kit/
COPY packages/litellm-conformance/package.json packages/litellm-conformance/
COPY apps/server/package.json           apps/server/
COPY apps/proxy-server/package.json     apps/proxy-server/
COPY apps/runner/package.json           apps/runner/
COPY e2e/package.json                   e2e/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store --global \
 && pnpm install --frozen-lockfile

COPY . .

# `@getlibero/server...` is the agent side and its dependencies. packages/proxy
# is not among them and is not built here — the agent may never import it, and
# this filter is that rule showing up in the image as an absence rather than as
# a check.
RUN pnpm --filter @getlibero/server... build

RUN pnpm deploy --filter=@getlibero/server --prod /out

RUN find /out -type f \
      \( -name '*.test.js' -o -name '*.d.ts' -o -name '*.map' \) \
      \( -path '/out/dist/*' -o -path '*/@getlibero/*' \) \
      -exec rm -f {} +

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /out /app

# The one directory this service writes: the per-channel message stores, whose
# volume is seeded from this path's ownership. It is deliberately not the
# channels mount, which stays read-only to both services because it is where the
# proxy reads its authorization from — see AGENT_STORE_ROOT in the compose file.
RUN mkdir -p /data/store && chown -R node:node /data

USER node

# `index.js`, not the package's `main` — that is `compose.js`, the injectable
# composition the e2e suite drives in-process, and it starts nothing on its own.
CMD ["node", "dist/index.js"]
