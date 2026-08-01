/**
 * Generates the two static assets that cannot be authored by hand without
 * duplicating the design system: the favicon and the social card.
 *
 * Both are written into public/ and both are git-ignored — they are derived
 * from design/brand and design/tokens.css, so committing them would be a
 * second copy waiting to drift. Run by `prebuild` and `predev`.
 *
 * Text in the card is rendered by satori, which converts glyphs to paths
 * using the .woff files from node_modules. That matters: the alternative is
 * rasterising an SVG with sharp, which would need IBM Plex installed on
 * whatever machine happens to be running CI.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import sharp from 'sharp';
import { token } from '../src/lib/design-tokens.mjs';

const root = new URL('../', import.meta.url);
const path = (url) => fileURLToPath(url);

const OUT = new URL('public/', root);
const CARD = { width: 1200, height: 630 };

const bg = token('dark', '--lb-bg-canvas');
const surface = token('dark', '--lb-bg-surface');
const border = token('dark', '--lb-border');
const text = token('dark', '--lb-text');
const muted = token('dark', '--lb-text-muted');
const dim = token('dark', '--lb-text-dim');
const accent = token('dark', '--lb-accent');

/** The mark, as a satori-friendly element tree. The viewBox does the scaling. */
function mark(size) {
  return {
    type: 'svg',
    props: {
      width: size,
      height: size,
      viewBox: '0 0 64 64',
      children: [
        {
          type: 'path',
          props: {
            d: 'M17 18 v11 c0 11.6 7.4 19 19 19 h11',
            fill: 'none',
            stroke: accent,
            strokeWidth: 7,
            strokeLinecap: 'round',
          },
        },
        { type: 'circle', props: { cx: 47, cy: 18, r: 5.5, fill: accent } },
      ],
    },
  };
}

/**
 * satori implements a subset of flexbox and refuses any block-level element
 * with more than one child, so every div declares display explicitly.
 */
const el = (type, props, ...children) => ({
  type,
  props: {
    ...props,
    style: type === 'div' ? { display: 'flex', ...props?.style } : props?.style,
    children,
  },
});

function card() {
  const row = (dot, label, value) =>
    el(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '13px 20px',
          borderBottom: `1px solid ${border}`,
          fontFamily: 'IBM Plex Mono',
          fontSize: 19,
          color: muted,
        },
      },
      el('div', { style: { width: 8, height: 8, borderRadius: 99, background: dot } }),
      el('div', { style: { flex: 1 } }, label),
      el('div', { style: { color: dim, fontSize: 17 } }, value)
    );

  return el(
    'div',
    {
      style: {
        width: CARD.width,
        height: CARD.height,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 64,
        background: bg,
        fontFamily: 'IBM Plex Sans',
      },
    },
    el(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      el(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 18 } },
        mark(56),
        el(
          'div',
          { style: { fontSize: 46, fontWeight: 600, letterSpacing: '-0.035em', color: text } },
          'libero'
        )
      ),
      el(
        'div',
        {
          style: {
            marginTop: 40,
            fontSize: 54,
            fontWeight: 600,
            lineHeight: 1.1,
            letterSpacing: '-0.035em',
            color: text,
            maxWidth: 760,
          },
        },
        'The open-source AI teammate for Slack.'
      ),
      el(
        'div',
        { style: { marginTop: 22, fontSize: 26, lineHeight: 1.45, color: muted, maxWidth: 700 } },
        'Self-hosted, credential-isolated, every tool call audited.'
      )
    ),
    el(
      'div',
      { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' } },
      el(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: 470,
            background: surface,
            border: `1px solid ${border}`,
            borderRadius: 10,
          },
        },
        row(accent, 'github.list_prs', 'executed'),
        row(token('dark', '--lb-warn'), 'github.trigger_workflow', 'awaiting'),
        el(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '13px 20px',
              fontFamily: 'IBM Plex Mono',
              fontSize: 19,
              color: muted,
            },
          },
          el('div', {
            style: {
              width: 8,
              height: 8,
              borderRadius: 99,
              background: token('dark', '--lb-danger'),
            },
          }),
          el('div', { style: { flex: 1 } }, 'github.delete_repo'),
          el('div', { style: { color: dim, fontSize: 17 } }, 'blocked')
        )
      ),
      el(
        'div',
        { style: { fontFamily: 'IBM Plex Mono', fontSize: 20, color: dim } },
        'getlibero.com'
      )
    )
  );
}

const fontFile = (specifier) =>
  readFile(path(new URL(`node_modules/${specifier}`, root)));

const fonts = [
  {
    name: 'IBM Plex Sans',
    weight: 400,
    style: 'normal',
    data: await fontFile('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff'),
  },
  {
    name: 'IBM Plex Sans',
    weight: 600,
    style: 'normal',
    data: await fontFile('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff'),
  },
  {
    name: 'IBM Plex Mono',
    weight: 400,
    style: 'normal',
    data: await fontFile('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff'),
  },
];

await mkdir(path(OUT), { recursive: true });

// Favicon: the app icon, verbatim from design/brand. It never goes light —
// one lockup everywhere — so it is a copy rather than a render.
await writeFile(
  path(new URL('favicon.svg', OUT)),
  await readFile(path(new URL('../design/brand/app-icon.svg', root)), 'utf8')
);

const svg = await satori(card(), { ...CARD, fonts });
await sharp(Buffer.from(svg)).png().toFile(path(new URL('og.png', OUT)));

console.log('build-assets: wrote public/favicon.svg and public/og.png');
