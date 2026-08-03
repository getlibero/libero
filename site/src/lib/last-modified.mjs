/**
 * Per-page `lastmod` for the sitemap, read from git.
 *
 * The date a page was last meaningfully changed is the date its *source* was
 * last committed — not the build time. Stamping the build time on every URL is
 * the common shortcut and it is a lie: it tells a crawler all thirteen pages
 * changed every time CI runs, which is exactly the signal `lastmod` exists to
 * carry, spent on nothing. Better to emit no `lastmod` than a false one, so
 * every failure path here returns undefined and @astrojs/sitemap omits the tag.
 *
 * This needs full history. `actions/checkout` clones with `fetch-depth: 1` by
 * default, which collapses every file's last-commit date onto the one commit in
 * the clone — the fake build-time stamp again, wearing a git costume. The Pages
 * workflow sets `fetch-depth: 0`; the shallow guard below is what catches it if
 * that ever regresses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const git = (args) =>
  execFileSync('git', args, { cwd: siteRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** True when history is too shallow for per-file dates to mean anything. */
const isShallow = (() => {
  try {
    return git(['rev-parse', '--is-shallow-repository']) === 'true';
  } catch {
    return true; // No git, no dates.
  }
})();

if (isShallow) {
  console.warn(
    '[sitemap] shallow clone or no git — omitting lastmod rather than stamping build time'
  );
}

/**
 * The source file behind a built URL. Ordered by specificity; the first that
 * exists wins. Covers every route shape the site has:
 *
 *   /                        src/pages/index.astro
 *   /why/                    src/pages/why.astro
 *   /blog/                   src/pages/blog/index.astro
 *   /blog/<slug>/            src/content/blog/<slug>.md
 *   /docs/                   src/content/docs/docs/index.mdx
 *   /docs/<slug>/            src/content/docs/docs/<slug>.md
 */
function sourceFor(pathname) {
  const slug = pathname.replace(/^\/+|\/+$/g, '');
  if (slug === '') return 'src/pages/index.astro';

  const candidates = [
    `src/pages/${slug}.astro`,
    `src/pages/${slug}/index.astro`,
    `src/content/${slug}.md`,
    `src/content/docs/${slug}.md`,
    `src/content/docs/${slug}.mdx`,
    `src/content/docs/${slug}/index.mdx`,
  ];
  return candidates.find((rel) => existsSync(join(siteRoot, rel)));
}

const cache = new Map();

/** ISO-8601 commit date for the page at `pathname`, or undefined. */
export function lastModified(pathname) {
  if (isShallow) return undefined;
  if (cache.has(pathname)) return cache.get(pathname);

  let stamp;
  const source = sourceFor(pathname);
  if (source) {
    try {
      // Empty for a file that exists but has never been committed.
      stamp = git(['log', '-1', '--format=%cI', '--', source]) || undefined;
    } catch {
      stamp = undefined;
    }
  }

  cache.set(pathname, stamp);
  return stamp;
}
