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

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const { version } = manifest;

// The floor this package publishes, substituted so ./src/node-version.ts can
// enforce what `engines` only advises. npm prints a warning and runs anyway,
// and a CLI that half-works on an unsupported runtime is the failure mode this
// milestone exists to remove.
const nodeFloor = manifest.engines.node;

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
  define: {
    __LIBERO_VERSION__: JSON.stringify(version),
    __LIBERO_NODE_FLOOR__: JSON.stringify(nodeFloor)
  },
  logLevel: "info"
});

// `libero channel add` mints certificates by running scripts/dev-certs.sh, and
// npm's `files` cannot name a path outside the package — so the script is
// copied in here rather than referenced where it lives. A copy and not a move:
// packages/proxy and packages/agent exec it at its repository path for their
// test fixtures, and the documentation names it in nine places. CI asserts the
// two files are byte-identical, which is what keeps a copy from becoming a
// fork; ./src/dev-certs.ts carries the rest of the argument.
//
// The mode is npm's business, not this file's: a tarball does not reliably
// carry an executable bit through an install, so the CLI runs the script as
// `sh <path>` and never relies on one.
mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
copyFileSync(
  new URL("../../scripts/dev-certs.sh", import.meta.url),
  new URL("./dist/dev-certs.sh", import.meta.url)
);

// The licence, and the licences of everything inlined above.
//
// This package declared `license: MIT` and shipped no licence text, because npm
// only auto-includes a LICENSE sitting in the package directory and the one in
// this repository is at the root. Copied here for the same reason as the script
// above — one source of truth, and CI packs the tarball and checks.
copyFileSync(new URL("../../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));

// **Bundling made this necessary and nothing warned.** `scripts/license-check.sh`
// asks which licences are allowed, not whether their notices travel; esbuild's
// `legalComments: "eof"` carries only notices that exist as comments in the
// source, which smol-toml has and zod does not. So the bundle was redistributing
// zod's code without zod's MIT notice, which that licence requires of any
// substantial portion — and inlining the whole library is not a small one.
//
// Generated rather than written by hand, from what `@getlibero/schema` actually
// depends on, so a dependency added there cannot be one whose notice quietly
// stops shipping. A dependency with no discoverable licence text fails the
// build: that is a question for a human, not something to skip.
const LICENCE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENCE", "LICENCE.md", "license", "license.md"];
const schema = new URL("../schema/", import.meta.url);
const bundled = Object.keys(JSON.parse(readFileSync(new URL("./package.json", schema), "utf8")).dependencies);

const notices = [
  "# Third-party notices",
  "",
  "`@getlibero/cli` is published as a single bundled file. The following",
  "packages are compiled into it, and their licences are reproduced in full",
  "below. Libero's own licence is in LICENSE beside this file.",
  ""
];
for (const name of bundled.sort()) {
  const root = new URL(`node_modules/${name}/`, schema);
  const filename = LICENCE_FILENAMES.find(candidate => existsSync(new URL(candidate, root)));
  if (filename === undefined) {
    throw new Error(
      `${name} is bundled into the CLI and has no licence file in ${fileURLToPath(root)}. ` +
        "Find its terms and decide what has to ship with them before releasing."
    );
  }
  const { version: at } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  notices.push(`## ${name} ${at}`, "", "```", readFileSync(new URL(filename, root), "utf8").trimEnd(), "```", "");
}
writeFileSync(new URL("./THIRD-PARTY-NOTICES.md", import.meta.url), `${notices.join("\n").trimEnd()}\n`);
