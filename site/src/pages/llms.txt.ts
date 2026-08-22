/**
 * /llms.txt — the annotated link list from llmstxt.org.
 *
 * The format is one file at the site root, not one per page; the per-page half
 * of this is the markdown siblings in [...slug].md.ts, and the two are
 * complementary rather than alternatives. This file is the index that makes
 * them findable without crawling.
 *
 * It costs almost nothing to keep honest because the inputs already exist: every
 * doc carries a one-line `description` in its frontmatter, which is exactly what
 * the format's link annotations want, and the reading order comes from the
 * sidebar rather than from a second list maintained here.
 *
 * Deliberately no llms-full.txt. The docs are ~277 kB of markdown, and inlining
 * all of it produces a file that is worse than useless at the size where it
 * matters — an agent that can fetch a link can fetch the two pages it needs.
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '../consts';
import { docsNav } from '../lib/docs-nav';
import { markdownPath } from '../lib/page-markdown';

/** "- [Title](url): description", the format's link shape. */
function link(title: string, path: string, description: string): string {
  const url = new URL(markdownPath(path), SITE.url).href;
  return `- [${title}](${url})${description ? `: ${description}` : ''}`;
}

export const GET: APIRoute = async () => {
  const docs = new Map((await getCollection('docs')).map((entry) => [entry.id, entry]));
  const posts = (await getCollection('blog')).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  const sections = docsNav.map((group) => [
    `## ${group.label}`,
    '',
    ...group.items.map((item) =>
      link(item.label, `/${item.slug}/`, docs.get(item.slug)?.data.description ?? '')
    ),
    '',
  ]);

  const lines = [
    `# ${SITE.name}`,
    '',
    `> ${SITE.description}`,
    '',
    // The status belongs above the links for the same reason it is on every
    // page: a reader should know the release and that it is pre-1.0 before
    // describing it to anyone else.
    `Libero ${SITE.status}. The architecture document is the design of record and describes what`,
    'runs; the roadmap records where a release landed differently from its plan, and the changelog',
    'is what an operator upgrades by.',
    '',
    'Every page below is markdown. The HTML is the same content at roughly three times the size,',
    'at the same path without the `.md`.',
    '',
    ...sections.flat(),
    '## Blog',
    '',
    ...posts.map((post) =>
      link(`${post.data.title} (${post.data.date.toISOString().slice(0, 10)})`, `/blog/${post.id}/`, post.data.description)
    ),
    '',
    '## Optional',
    '',
    `- [Source repository](${SITE.repo}): the implementation, the issue tracker, and the end-to-end suite that attacks the security boundary.`,
    `- [Discord](${SITE.url}/discord): project chat.`,
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
