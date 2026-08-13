// The published artifact, in one file.
//
// `packages/cli` is the only package anyone installs from npm, and it imports
// `@getlibero/schema` — a `private: true` workspace package that is not
// published and never will be. It has to: `libero init` validates a model id
// with the same `ModelId` a team sheet's `[llm] model` passes through, and the
// two commands after it write a sheet and read one back. A second definition of
// those shapes here would be a second answer to what a team sheet is, which is
// the one question this repository keeps in a single place.
//
// So the schema is inlined rather than depended on. esbuild resolves the
// workspace import, and zod and smol-toml under it, into a single ESM file with
// no bare imports left except `node:` builtins. The published package.json then
// declares no dependencies at all — which is what makes `npm publish` from this
// directory safe. npm, unlike pnpm, does not rewrite pnpm's `workspace:*`, so a
// dependency edge on the schema would publish a specifier no registry client
// can resolve. The workspace dep sits in devDependencies, and
// .github/workflows/release-cli.yml deletes that field before publishing.
//
// This is a build-time inline of one workspace source of truth, not a vendored
// copy: there is no second checked-in definition to drift from the first, and
// `pnpm -r build` fails here the moment the schema's exports change.
//
// Three options are load-bearing rather than cosmetic:
//
//   platform: node   leaves `node:` builtins external instead of shimming them
//   target: node24   matches the `engines` floor this package publishes
//   legalComments    esbuild's default, set explicitly because it is what
//                    carries smol-toml's BSD-3-Clause notice into the file that
//                    redistributes its code
//
// The shebang on src/index.ts survives on its own — esbuild parses a leading
// hashbang and re-emits it first — so `bin` still resolves to a file the shell
// can exec.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await esbuild.build({
  absWorkingDir: here,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "eof",
  // A bundled single file cannot read its own package.json off disk, so the
  // version it reports has to be substituted here. ./src/cli.ts declares it and
  // falls back, so the source stays runnable under plain tsc output and under
  // vitest, where nothing defines it.
  define: { __LIBERO_VERSION__: JSON.stringify(version) },
  logLevel: "info"
});
