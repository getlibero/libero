#!/bin/sh
# @getlibero/cli, checked as the tarball an installer gets.
#
# Packs packages/cli into a temporary directory from a COPY of its manifest —
# the tree is left as it was — and asserts what the published package has to
# be: one dependency-free manifest, one bundle that runs on its own, and the
# three files that travel with it. Run from anywhere.
#
# The same script runs in two places on purpose: ci.yml, after the test step,
# on every pull request; and release-cli.yml, immediately before `npm publish`.
# A check that runs at a different point in the sequence from the publish is a
# check on a different artifact. That is how v0.6.0 and v0.7.0 shipped a CLI
# that could not start: `build` wrote the bundle, `test`'s tsc re-emitted the
# un-bundled entry stub over it, and the tarball check had already passed on
# the first file. The bundle now has a name tsc never writes (build.mjs), and
# this script executes what was packed rather than reading its first line.
set -eu
cd "$(dirname "$0")/../packages/cli"

work=$(mktemp -d)
cp package.json "$work/package.json.orig"
trap 'mv "$work/package.json.orig" package.json; rm -rf "$work"' EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

# What release-cli.yml does before publishing. The workspace dependencies —
# `@getlibero/schema` and `@getlibero/atomic-write` — are dependencies of the
# build, inlined by build.mjs; npm (unlike pnpm) does not rewrite `workspace:*`
# and would ship a specifier no registry client can resolve.
npm pkg delete devDependencies
npm pack --pack-destination "$work" --silent > /dev/null
tarball=$(ls "$work"/*.tgz)
tar -tzf "$tarball" | sort

tar -xzOf "$tarball" package/package.json > "$work/manifest.json"
node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (m.dependencies) throw new Error("published manifest declares dependencies");
  if (JSON.stringify(m).includes("workspace:")) throw new Error("published manifest carries a workspace: spec");
' "$work/manifest.json"

# The bundle, executed. Extracted with nothing beside it — no node_modules, no
# sibling dist files — and run, because a file that starts with the right
# shebang and names no workspace package can still be tsc's stub importing
# ./cli.js, which is exactly what 0.7.0 published. `--version` reaches the
# bundle's substituted version string and nothing on disk, so it is the one
# command that proves the file is whole without needing a deployment.
bundle=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).bin.libero' "$work/manifest.json")
tar -xzf "$tarball" -C "$work" "package/$bundle"
bundle="$work/package/$bundle"
head -1 "$bundle" | grep -qx '#!/usr/bin/env node' || fail "$bundle does not start with the node shebang"
# Not `! grep -q`: `set -e` is ignored for a pipeline that begins with `!`, so
# that form can print nothing and fail nothing. An `if` is what actually exits.
if grep -q '"@getlibero/' "$bundle"; then
  fail "the bundle still imports a workspace package"
fi
expected="libero $(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$work/manifest.json")"
got=$(node "$bundle" --version) || fail "the packed CLI does not run"
[ "$got" = "$expected" ] || fail "the packed CLI reports '$got'; the manifest says '$expected'"

# `libero channel add` mints certificates by running dev-certs.sh, and npm's
# `files` cannot name a path outside the package — so build.mjs copies it in.
# This is what keeps that copy from becoming a fork: the script two other test
# suites exec at its repository path, and the one an operator gets from npm,
# have to be the same file.
tar -xzOf "$tarball" package/dist/dev-certs.sh > "$work/dev-certs.sh"
diff -u ../../scripts/dev-certs.sh "$work/dev-certs.sh"

# The published package declares MIT and inlines two dependencies, so its own
# licence and theirs have to travel with it. `license-check.sh` asks which
# licences are allowed, not whether their notices ship — this is the half that
# was missing. The build fails on a bundled dependency with no licence file, so
# a name absent here means one was added and its terms were not.
tar -xzOf "$tarball" package/LICENSE > "$work/LICENSE"
diff -u ../../LICENSE "$work/LICENSE"
tar -xzOf "$tarball" package/THIRD-PARTY-NOTICES.md > "$work/notices.md"
for bundled in zod smol-toml; do
  grep -q "^## $bundled " "$work/notices.md" || fail "THIRD-PARTY-NOTICES.md does not carry $bundled"
done

echo "cli-tarball-check: ok ($(basename "$tarball"), $got)"
