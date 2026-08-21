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
src/lib/              design-token parser, code theme, theme bootstrap, docs nav, markdown siblings
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

## Markdown for agent readers

Every collection page is served twice: `/docs/security/` is the HTML, `/docs/security.md` is the
same prose without the frame. The rule is one line — canonical path, trailing slash off, `.md` on
— so `/docs/` is `/docs.md` and there is no special case for an index to know about.

The reason is bytes. Starlight's sidebar, the expressive-code spans and the Pagefind markup are
most of what a docs page weighs: `/docs/team-sheet/` is 210 kB of HTML against 72 kB of markdown,
`/docs/security/` is 63 kB against 21 kB. A reader that only wants the words should not pay three
times over for the frame.

Three files do it, and none of them adds a dependency:

- `src/pages/[...slug].md.ts` — the siblings. `getStaticPaths` over the `docs` and `blog`
  collections.
- `src/pages/llms.txt.ts` — [llms.txt](https://llmstxt.org): the annotated link list, grouped by
  `src/lib/docs-nav.ts` so the reading order is the sidebar's rather than a second one kept here.
  Nearly free, because every doc already carries the one-line `description` the format wants.
- `src/lib/page-markdown.ts` — the URL rule, the MDX reduction, and link absolutisation.

There is deliberately **no `llms-full.txt`**. The docs are ~277 kB of markdown, and a file that
inlines all of it is least useful exactly where size matters; per-page siblings and an index let a
reader fetch the two pages it needs. The `starlight-llms-txt` plugin would have given us that file
in five lines of config, and not the siblings, which are the half that pays.

Three things are easy to break here.

**The header carries the status string.** On the site, "pre-release" is in the chrome — a banner in
the layout, an `<Aside>` on the docs index — and none of that survives extraction. The
architecture document is the design of record and runs well ahead of the implementation, so a
reader who arrives at `architecture.md` alone and has no reason to doubt it will describe features
that do not exist. `SITE.status` goes in every sibling's header and at the top of `llms.txt`.

**Links are made absolute, and retargeted only where a sibling exists.** A `.md` file is read
detached from the site, so `/docs/team-sheet` resolves against nothing. Retargeting to `.md` could
have been a guess and is not one — the set of paths is what the build actually emitted, so a link
to a marketing page stays pointed at the HTML.

**The MDX reduction fails the build on anything it does not recognise.** `index.mdx` is the one MDX
page and it uses three components; `mdxToMarkdown` handles those three and throws on a fourth. It
is string replacement rather than a real parse, and the guard is what makes that safe: a
`<LinkCard>` left in a `.md` file is a reader being handed source code and told it is
documentation, which is silent at every point where someone might catch it.

Discovery is `rel="alternate"` plus `llms.txt`, and it has to be, because GitHub Pages cannot do
content negotiation — the same constraint that makes `/discord` a meta-refresh rather than a 301.
The tag is per page, so the docs side needs `src/components/overrides/Head.astro` rather than an
entry in the config's static `head` array; the marketing side passes `markdown` to the layout, and
only blog posts do, because only they have a sibling. The siblings are filtered out of the
sitemap: they are alternates of pages already listed, not pages of their own.

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
marks, no emoji, no "AI magic" language. Say what does not exist yet — the project is pre-release
and part-built, and the site should never imply otherwise. The status string lives in
`src/consts.ts` (`SITE.status`) and is read, never retyped: a status in two places is a status
that is wrong in one of them.
