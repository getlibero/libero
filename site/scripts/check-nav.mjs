/**
 * Fails the build if a docs page is in no sidebar group.
 *
 * `src/lib/docs-nav.ts` is the reading order, and two consumers read it: the
 * Starlight sidebar and `/llms.txt`. A page nobody added to it is built, shipped
 * and indexed by the site search, and appears in neither — reachable by URL and
 * by nothing else.
 *
 * That is the worst shape this class of mistake takes, because it looks fine to
 * whoever made it. They wrote the page, built the site, clicked the link and saw
 * it render. Nobody else ever finds it.
 *
 * ## Only one direction needs checking
 *
 * The reverse — a sidebar entry naming a page that does not exist — already
 * fails the build, and loudly: Starlight validates its own sidebar and throws
 * `The slug "docs/ghost" specified in the Starlight sidebar config does not
 * exist`. `site-build` is a required status, so that case is covered and this
 * script deliberately does not restate it. What it adds is the half nothing
 * catches.
 *
 * ## Why it reads the source rather than the build
 *
 * `check-html.mjs` next door runs against `dist/` because the defect it hunts
 * does not exist until the HTML is emitted. This one is a fact about two source
 * files, so it runs before a build rather than after one — a page missing from
 * the sidebar should not cost a build first.
 *
 * The parser is deliberately small and deliberately brittle, which is
 * `ci-partition.test.ts`'s argument in the workspace next door: it understands
 * the one shape `docs-nav.ts` is written in and **fails on a file it cannot
 * read at all**, rather than reporting a coverage it did not check. A nav
 * rewritten into some other shape fails this script, which is a one-line fix
 * and a reviewable one; a wrong green is neither.
 */

import { readdirSync, readFileSync } from 'node:fs';

const PAGES = 'src/content/docs/docs';
const NAV = 'src/lib/docs-nav.ts';

/** `{ label: 'Limits', slug: 'docs/limits' }`, and the root's bare `docs`. */
const SLUG = /slug:\s*'(docs(?:\/[A-Za-z0-9-]+)?)'/g;

/** A page's slug is its filename, and `index` is the group's root. */
const slugOf = (file) => {
  const stem = file.replace(/\.(md|mdx)$/, '');
  return stem === 'index' ? 'docs' : `docs/${stem}`;
};

// Read through a catch rather than letting `readdirSync` throw: a moved or
// renamed directory is the likelier mistake than an empty one, and it would
// otherwise surface as a stack trace that says ENOENT rather than as the
// sentence below. Both land on the same guard.
let entries = [];
try {
  entries = readdirSync(PAGES);
} catch {
  entries = [];
}
const files = entries.filter((f) => /\.(md|mdx)$/.test(f));
const nav = readFileSync(NAV, 'utf8');
const listed = new Set([...nav.matchAll(SLUG)].map(([, slug]) => slug));

// Non-vacuity, both sides. Everything below passes on an empty directory and on
// a nav this script failed to parse, so neither may go unnoticed — the two
// checks in `packages/test-kit` open the same way and for the same reason.
if (files.length === 0) {
  console.error(
    `check-nav: no pages found under ${PAGES}.\n` +
      'Either the directory moved or it holds no .md/.mdx, and this script cannot\n' +
      'tell you the sidebar is complete without reading the pages it covers.'
  );
  process.exit(1);
}
if (listed.size === 0) {
  console.error(
    `check-nav: parsed no slugs out of ${NAV}.\n` +
      "Entries are expected to read { label: '…', slug: 'docs/…' }. If the nav has\n" +
      'been rewritten, this script needs teaching the new shape rather than deleting.'
  );
  process.exit(1);
}

const orphans = files.filter((file) => !listed.has(slugOf(file)));

if (orphans.length > 0) {
  console.error(`check-nav: ${orphans.length} page(s) in no sidebar group.\n`);
  for (const file of orphans) {
    console.error(`  ${PAGES}/${file}  is not listed as '${slugOf(file)}'`);
  }
  console.error(
    `\nAdd each to a group in ${NAV}. It is the reading order for both the sidebar\n` +
      'and /llms.txt, so a page missing from it ships and is findable from neither.'
  );
  process.exit(1);
}

console.log(`check-nav: ${files.length} pages, every one in the sidebar.`);
