/**
 * A markdown sibling for every collection page: `/docs/security.md` beside
 * `/docs/security/`, `/blog/<post>.md` beside the post.
 *
 * Astro has no built-in llms.txt or markdown export, and Astro's own docs
 * removed theirs in April 2026 in favour of an MCP server. An MCP server has to
 * be installed before it helps anyone; a sibling file is reachable by anything
 * that speaks HTTP, which is the whole argument for building this one rather
 * than that one.
 *
 * The marketing pages have no sibling. They are .astro rather than collection
 * entries, so there is no body to serve, and their content is a pitch — the
 * thing a reader came for is under /docs.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '../consts';
import { absolutiseLinks, markdownPath, mdxToMarkdown } from '../lib/page-markdown';

interface Page {
  title: string;
  description: string;
  /** The HTML page this is a sibling of, as a site-root path with its slash. */
  canonical: string;
  body: string;
  isMdx: boolean;
  /** Blog posts only. */
  date?: string;
}

async function pages(): Promise<Page[]> {
  const docs = await getCollection('docs');
  const blog = await getCollection('blog');

  return [
    ...docs.map((entry) => ({
      title: entry.data.title,
      description: entry.data.description ?? '',
      canonical: `/${entry.id}/`,
      body: entry.body ?? '',
      isMdx: entry.filePath?.endsWith('.mdx') ?? false,
    })),
    ...blog.map((entry) => ({
      title: entry.data.title,
      description: entry.data.description,
      canonical: `/blog/${entry.id}/`,
      body: entry.body ?? '',
      isMdx: false,
      date: entry.data.date.toISOString().slice(0, 10),
    })),
  ];
}

export const getStaticPaths: GetStaticPaths = async () => {
  const all = await pages();
  const siblings = new Set(all.map((page) => page.canonical));

  return all.map((page) => ({
    // markdownPath yields "/docs/security.md"; the rest param wants the middle.
    params: { slug: markdownPath(page.canonical).slice(1).replace(/\.md$/, '') },
    props: { page, siblings: [...siblings] },
  }));
};

export const GET: APIRoute = ({ props }) => {
  const { page, siblings } = props as { page: Page; siblings: string[] };
  const base = SITE.url;

  const body = absolutiseLinks(
    page.isMdx ? mdxToMarkdown(page.body) : page.body,
    base,
    new Set(siblings)
  );

  // The status line is the reason this header exists at all. On the site it is
  // in the chrome — a banner in the layout, an Aside on the docs index — and
  // none of that survives being extracted into a file. A reader who arrives at
  // architecture.md alone should still learn which release it describes and
  // that it is pre-1.0, and has nothing else to tell them so.
  const provenance = [`Source: ${new URL(page.canonical, base).href}`, `Libero ${SITE.status}`];
  if (page.date) provenance.splice(1, 0, `Published ${page.date}`);

  const markdown = [
    `# ${page.title}`,
    '',
    `> ${page.description}`,
    '',
    provenance.join(' · '),
    '',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');

  return new Response(markdown, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
