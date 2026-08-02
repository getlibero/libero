#!/usr/bin/env sh
# License gate. Per GOVERNANCE.md, core ships MIT/Apache-2.0-class dependencies
# only; AGPL/SSPL and commercially-licensed packages are excluded.
#
# Every workspace package is scanned, not only the root. Under pnpm the root
# node_modules holds root devDependencies alone, so a root-only scan silently
# passes every dependency a workspace package declares — which is most of them.
#
# site/ is deliberately absent. It is outside the pnpm workspace, has its own
# lockfile and its own CI job, and ships OFL-1.1 fonts. It is presentation, not
# core, and the allowlist GOVERNANCE.md sets is a statement about core.
set -eu

ALLOWED="MIT;Apache-2.0;ISC;BSD-2-Clause;BSD-3-Clause;0BSD;CC0-1.0;Unlicense;Python-2.0;BlueOak-1.0.0"

for dir in ./ packages/*/ apps/*/ e2e/; do
  [ -f "${dir}package.json" ] || continue
  echo "license gate: ${dir}"
  license-checker-rseidelsohn \
    --start "${dir}" \
    --onlyAllow "${ALLOWED}" \
    --excludePrivatePackages \
    --excludePackagesStartingWith "spdx-exceptions@"
done

echo "license gate: core is clean"
