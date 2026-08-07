#!/usr/bin/env sh
# Agent/proxy boundary gate. Belt-and-suspenders alongside the ESLint
# `no-restricted-imports` rule: a grep-level check that nothing on the agent
# side of the boundary — packages/agent, packages/gateway, or the apps/server
# process that composes both — references the proxy package. The only path from
# agent to tools is the network call.
#
# The grep holds where ESLint cannot: when the ESLint config is itself the file
# being edited in the same pull request, and for a reviewer who wants to verify
# the boundary without reading flat config.
#
# It is a raw string match, not an import match, and stays one deliberately.
# Anchoring the pattern to import syntax would be both buggier and weaker: a
# line-based regex misses a multi-line import (the specifier is not on the
# `import` line once Prettier wraps at 100 columns), and matching those needs a
# parser — the parser is ESLint, which already covers the import case.
# Anchoring would keep the redundancy and drop the stronger property this check
# actually enforces: you may not name it on this side of the line. That
# property is what keeps the prose in these packages saying "the tool proxy
# service" rather than drifting into describing an import that should not
# exist.
#
# The `\.\./proxy` pattern catches a relative deep import into the proxy's
# build output ("../../proxy/dist/…"), which names neither the package nor its
# source path. The .js/.mjs/.cjs includes catch a file ESLint's *.ts blocks
# would not parse. `package.json` is included because a dependency edge is
# already wrong on its own — it puts the proxy's code into the agent's image —
# and it trips neither gate until an import appears.
set -eu

if grep -rn \
  --include='*.ts' --include='*.mts' --include='*.cts' \
  --include='*.js' --include='*.mjs' --include='*.cjs' \
  --include='package.json' \
  -e '@getlibero/proxy' -e 'packages/proxy' -e '\.\./proxy' \
  packages/agent/ packages/gateway/ apps/server/; then
  echo "boundary-check: the agent side references the proxy. The only path from agent to tools is the network call." >&2
  echo "boundary-check: if the match is prose rather than an import, write \"the tool proxy service\" — this check is a raw string match and does not read syntax." >&2
  echo "boundary-check: if the match is in a package.json, remove the dependency — a dependency edge ships the proxy's code in the agent's image, import or no import." >&2
  exit 1
fi

echo "boundary-check: the agent side names no proxy"
