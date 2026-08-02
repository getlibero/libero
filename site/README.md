# getlibero.com

The marketing site and documentation. Astro + Starlight, static output, deployed to GitHub Pages
by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to `main` that
touches `site/` or `design/`.

That workflow's `site-build` job is a required status check on `main`, so it runs on **every**
pull request, not only ones that touch this directory — a required check that stays pending on
some pull requests would block them forever. The deploy half stays path-filtered.

```bash
cd site
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # -> site/dist
pnpm check        # astro check (types)
pnpm check:html   # fused word boundaries in the built HTML
pnpm preview
```

**Node 22.12+**, pnpm 9+ — Astro 7 requires it; the core packages share the
Node 22 floor. This is a build-time toolchain and nothing shipped runs on it.

## Outside the workspace, on purpose

`site/` is **not** in the root `pnpm-workspace.yaml`. Astro brings several hundred transitive
dependencies that have no business in `pnpm -r build/test/typecheck` or in the core licence gate,
which allows only MIT/Apache-2.0-class packages. The `pnpm-workspace.yaml` in this directory is
what stops pnpm walking up to the repository root; it gives the site its own lockfile and its own
`node_modules`.

Consequence: the root scripts do not see this package. CI runs it as a separate job.

## Layout

```
src/pages/            marketing routes — /, /security, /why, /blog, /404
src/content/docs/docs/ Starlight routes — everything under /docs
src/content/blog/     posts and release notes
src/layouts/          the frame for everything outside the docs
src/components/       brand mark, header, footer, theme toggle
  overrides/          Starlight component overrides (see below)
src/styles/           the bridge between the design system and both surfaces
src/lib/              design-token parser, code theme, theme bootstrap
scripts/              build-assets.mjs — favicon and social card
```

Docs live at `/docs/*` because the marketing pages own the root. Starlight derives its routes
from the directory structure, so the content sits one level deep in
`src/content/docs/docs/`. Files in `src/pages/` take precedence over Starlight's routes.

## The design system

The site does not vendor the design system. It imports it:

- `src/styles/tokens.css` → `../../../design/tokens.css`
- `src/styles/design.css` → the above plus `design/libero.css`

`design/tokens.css` is generated upstream (see [`design/README.md`](../design/README.md)), so a
copy here would guarantee drift. `vite.server.fs.allow` in `astro.config.mjs` is what permits the
out-of-root import.

**Marketing pages** load the full design system — tokens plus `libero.css`, the component layer.
**Docs pages** load the tokens only; Starlight has its own component layer, and
`src/styles/starlight.css` re-skins it by pointing every `--sl-*` variable at a `--lb-*` token.
Because the tokens themselves swap on `[data-theme="light"]`, one block covers both modes.

The spec is locked. Do not introduce a colour, font, radius or component shape that is not already
in it, and reference tokens by name rather than by hex.

### Where hex values are unavoidable

Two things cannot take a CSS variable: the syntax-highlighting theme and the social card, both of
which are compiled to literal colours at build time. Rather than transcribe hexes,
`src/lib/design-tokens.mjs` parses them out of `design/tokens.css` and `design/libero.css`, and
throws at build time if a token is renamed.

Code blocks are monochrome as a result of the same rule: green means allowed and executed, amber
means awaiting a human, red means blocked, and a string literal is none of those. The four text
weights carry the structure instead — see `src/lib/code-theme.mjs`.

## Theme

Dark is the default and needs no stored preference; light is a peer the reader opts into with the
header toggle. There is no "auto" — Starlight's three-way picker is replaced by a two-state
toggle, and its `ThemeProvider` is replaced so an unset preference resolves to dark rather than to
the operating system's setting. Both surfaces share Starlight's `starlight-theme` storage key, so
the choice carries between the docs and the marketing pages.

Overrides live in `src/components/overrides/` and each one carries a comment saying why it exists.

## Generated assets

`public/favicon.svg` and `public/og.png` are produced by `scripts/build-assets.mjs` from
`design/brand/app-icon.svg` and the design tokens. They run on `predev` and `prebuild` and are
git-ignored.

`public/CNAME` is committed but **does not** set the custom domain. That behaviour belongs to
branch-based publishing; with the GitHub Actions source the file deploys as an ordinary asset and
Pages ignores it — confirmed the hard way, by deploying it and watching the API keep reporting
`"cname": null`. The domain is configured on the repository:

```bash
gh api repos/getlibero/libero/pages --jq '{cname, https_enforced}'
gh api -X PUT repos/getlibero/libero/pages -f cname=getlibero.com -F https_enforced=true
```

The file stays because it records the intended domain next to the code, and because it would
become load-bearing again if the site ever moved back to a branch source. Change one, change both.

The social card renders text with [satori](https://github.com/vercel/satori), which converts
glyphs to paths using the `.woff` files in `node_modules`. That is deliberate: rasterising an SVG
with sharp would require IBM Plex to be installed on the machine running CI.

## Why HTML compression is off

`compressHTML` must stay `false` in `astro.config.mjs`. Left unset, it collapses the newline
between prose and an inline element to nothing rather than to a space, shipping
`The<a>governance document</a>explains`. It reproduces only in a production build, so the author
and the reviewer both see correct spacing in dev and every reader sees the defect.

Setting it to `true` is **not** the same as leaving it unset — on Astro 7.1.6 the three states all
differ, and only `false` preserves source whitespace. `pnpm check:html` runs against `dist/` in CI
and fails the build if a word boundary is swallowed again.

## Voice

Plain, terse, technical. Name the tool call. State what is and is not permitted. No exclamation
marks, no emoji, no "AI magic" language. Say what does not exist yet — the project is at phase 0
and the site should never imply otherwise.
