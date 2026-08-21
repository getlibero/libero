// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/consts';
import { liberoDark, liberoLight, styleOverrides } from './src/lib/code-theme.mjs';
import { lastModified } from './src/lib/last-modified.mjs';
import { docsNav } from './src/lib/docs-nav';

// getlibero.com. Static output, deployed to GitHub Pages from
// .github/workflows/pages.yml. Docs live under /docs/ because the marketing
// pages own the root — Starlight's routes come from the nested
// src/content/docs/docs/ directory, and src/pages/ wins for everything else.
export default defineConfig({
  site: 'https://getlibero.com',

  // Leaving this unset collapses the newline between prose and an inline
  // element to nothing rather than to a space, so
  //
  //     ... nobody can check. The
  //     <a href="...">governance document</a>
  //     explains the CLA ...
  //
  // ships as "The<a>governance document</a>explains".
  //
  // It must be `false`, not `true`. Measured on Astro 7.1.6, the three states
  // are not two — omitting the key eats the newline, `true` keeps a bare "\n",
  // and only `false` keeps the source whitespace. So `true` is not the
  // "compression on" spelling of the default, and swapping this to `true`
  // would look like a no-op while changing behaviour.
  //
  // The failure is invisible in dev — compression only runs on build — so the
  // author and the reviewer both miss it and every reader sees it. The whole
  // cost of `false` is ~9 kB gzipped across every page, which is not worth one
  // wrapped line silently eating a word boundary. `pnpm check:html` fails the
  // build if one comes back.
  compressHTML: false,

  // Short links we hand out in places where a bare domain is easier to say than
  // a URL full of invite noise. Static output turns each one into a meta-refresh
  // page with rel=canonical and robots=noindex, which is all GitHub Pages can do
  // — there is no server to return a 301.
  redirects: {
    '/discord': SITE.discord,
  },

  integrations: [
    starlight({
      title: 'Libero',
      description:
        'Documentation for Libero — the open-source AI teammate for Slack. Self-hosted, credential-isolated, every tool call audited.',
      favicon: '/favicon.svg',
      // Starlight emits twitter:card=summary_large_image but no og:image, so
      // without this every docs page shares as a large *empty* card. Same
      // /og.png the marketing layout uses — the card advertises the project,
      // not the page, so one image is honest for all of them.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE.url}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: SITE.ogImageAlt } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE.url}/og.png` } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/getlibero/libero' },
        { icon: 'discord', label: 'Discord', href: SITE.discord },
      ],
      editLink: {
        baseUrl: 'https://github.com/getlibero/libero/edit/main/site/',
      },
      // Load order matters: fonts, then the design system's tokens, then the
      // bridge that maps Starlight's --sl-* variables onto --lb-* tokens.
      customCss: [
        './src/styles/fonts.css',
        './src/styles/tokens.css',
        './src/styles/starlight.css',
      ],
      components: {
        // Dark is the default in this design system, so the theme is dark
        // unless the reader has explicitly chosen light — not whatever the OS
        // happens to prefer. That is the only reason this override exists.
        ThemeProvider: './src/components/overrides/ThemeProvider.astro',
        ThemeSelect: './src/components/overrides/ThemeSelect.astro',
        SiteTitle: './src/components/overrides/SiteTitle.astro',
        // Adds this page's markdown sibling as rel=alternate. Per page, so it
        // cannot be a `head` entry above.
        Head: './src/components/overrides/Head.astro',
      },
      // Shared with /llms.txt, which groups its link list by these headings —
      // see src/lib/docs-nav.ts for why the order is worth not duplicating.
      sidebar: docsNav,
      lastUpdated: true,
      // src/pages/404.astro covers the whole site, docs included.
      disable404Route: true,

      // Monochrome code, built from the design tokens — see src/lib/code-theme.mjs
      // for why syntax highlighting does not get to use the palette.
      expressiveCode: {
        themes: [liberoDark, liberoLight],
        themeCssSelector: (theme) => `[data-theme="${theme.type}"]`,
        styleOverrides,
      },
    }),

    sitemap({
      // The markdown siblings are alternates of pages already listed here, not
      // pages of their own. Listing both would put the same content in the
      // sitemap twice and contradict the canonical each HTML page declares.
      filter: (page) => !page.endsWith('.md'),
      // Dates come from git, not the build clock — see src/lib/last-modified.mjs.
      serialize: (item) => {
        const lastmod = lastModified(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],

  vite: {
    server: {
      // tokens.css and libero.css are imported from ../design, which is
      // outside this project root. The design system is the source of truth
      // and is deliberately not vendored in here.
      fs: { allow: ['..'] },
    },
  },
});
