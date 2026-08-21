#!/bin/sh
# The four image assertions — non-root user, no TypeScript source, no compiled
# tests, no build toolchain — shared by ci.yml's images job (against what a PR
# builds) and release-images.yml (against what a tag published, pulled back by
# digest per platform). One script so what a PR checks and what a release
# publishes cannot drift: the same argument boundary-check.sh makes for the
# import ban.
#
# The proxy holds every tool credential in the deployment, so what is in its
# filesystem is a security property in the same way its dependency list is. The
# runner (#395) is the other end of the same argument: it holds no credential and
# it can start containers, so what is in *its* filesystem decides what an
# attacker who reaches the Docker socket finds waiting there. Non-root matters to
# it twice over — it reads a root-owned socket through `group_add` rather than by
# being root, and an image that quietly ran as root would make that mechanism
# look like it was working.
# Asserting it here rather than trusting the Dockerfile is the same move as
# boundary-check backing up the ESLint rule: the multi-stage build and the
# `pnpm deploy --prod` prune are each one edit away from silently shipping the
# workspace whole.
#
# Scoped to what this workspace built. Third-party packages ship their own
# sources and declarations and are left as their publisher shipped them —
# rewriting the inside of a dependency is not a hardening step.
#
# Usage: image-checks.sh <image-ref>...
# Each ref must already be present locally — built or pulled. Which platform's
# image sits behind a ref is the caller's business; the checks run whatever is
# there, under QEMU when the caller pulled a foreign architecture. The
# `::error::` lines are GitHub annotations and print harmlessly elsewhere.

set -u

failed=0
for image in "$@"; do
  user=$(docker image inspect "$image" --format '{{.Config.User}}')
  if [ "$user" = "" ] || [ "$user" = "root" ] || [ "$user" = "0" ]; then
    echo "::error::$image runs as '${user:-root}'. Every published image must run as a non-root user."
    failed=1
  fi

  # One `docker run` per property. Three container starts rather than one,
  # because splitting a multi-line result back apart depends on the shell's
  # word-splitting and this has to be legible more than it has to be quick.
  count() { docker run --rm --entrypoint sh "$image" -c "$1" | tr -d '[:space:]'; }

  src=$(count 'find /app -name "*.ts" ! -name "*.d.ts" -not -path "*/node_modules/*" | wc -l')
  [ "$src" = "0" ] || { echo "::error::$image carries $src TypeScript source file(s)."; failed=1; }

  tests=$(count 'find /app \( -path "/app/dist/*" -o -path "*/@getlibero/*" \) -name "*.test.js" | wc -l')
  [ "$tests" = "0" ] || { echo "::error::$image carries $tests compiled test file(s)."; failed=1; }

  toolchain=$(count 'ls /app/node_modules/.pnpm 2>/dev/null | grep -cE "^(typescript|vitest|eslint|vite|esbuild)@" || true')
  [ "$toolchain" = "0" ] || { echo "::error::$image carries $toolchain build-toolchain package(s) — the --prod prune did not happen."; failed=1; }
done
exit $failed
