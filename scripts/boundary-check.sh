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
#
# `e2e/` is not among the roots below, and that is deliberate rather than an
# omission. The end-to-end suite composes both sides on purpose: it stands up
# the real proxy and the real agent composition and drives one against the
# other, which is the only way to show the two halves agree about the wire. It
# ships in no image, so a dependency edge there carries none of the risk this
# check exists for. The rule e2e/ does carry — that Slack and the model are the
# only things it may fake — is an ESLint block on `e2e/**`, because that one is
# genuinely about imports and has a parser available.
set -eu

# The MCP SDK belongs to the proxy alone, and this is the half an ESLint rule
# cannot cover: a `package.json` dependency edge ships the SDK in the agent's
# image before any import exists, which is the same argument the proxy ban makes
# below. The agent reaches tools over the network and speaks no MCP at all.
if grep -rn \
  --include='*.ts' --include='*.mts' --include='*.cts' \
  --include='*.js' --include='*.mjs' --include='*.cjs' \
  --include='package.json' \
  -e '@modelcontextprotocol' \
  packages/agent/ packages/gateway/ apps/server/; then
  echo "boundary-check: the agent side references the MCP SDK. Only the proxy speaks MCP; the agent reaches tools over the network." >&2
  exit 1
fi

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
