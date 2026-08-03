// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/consts';
import { liberoDark, liberoLight, styleOverrides } from './src/lib/code-theme.mjs';

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
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What Libero is', slug: 'docs' },
            { label: 'Self-hosting', slug: 'docs/self-hosting' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Architecture', slug: 'docs/architecture' },
            { label: 'Team sheets', slug: 'docs/team-sheet' },
            { label: 'Security model', slug: 'docs/security' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'Roadmap', slug: 'docs/roadmap' },
            { label: 'Contributing', slug: 'docs/contributing' },
          ],
        },
      ],
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

    sitemap(),
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
