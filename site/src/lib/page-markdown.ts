/**
 * The markdown siblings — what `/docs/security.md` contains and how its URL is
 * derived. See src/pages/[...slug].md.ts for the route that serves them.
 *
 * The point of the siblings is bytes: a docs page is roughly three times the
 * size of the prose it carries once Starlight's sidebar, the expressive-code
 * spans and the Pagefind markup are counted. A reader that only wants the words
 * should not pay for the frame.
 */

/**
 * Canonical path minus its trailing slash, plus `.md`. `/docs/security/` is
 * `/docs/security.md` and `/docs/` is `/docs.md`.
 *
 * One rule with no special case for the index, which is why the docs index is
 * `/docs.md` rather than the arguably-clearer `/docs/index.md`: a reader that
 * has learned the rule on any other page can apply it here without knowing
 * that this one is a directory index.
 */
export function markdownPath(canonicalPath: string): string {
  const trimmed = canonicalPath.replace(/\/$/, '');
  return `${trimmed || '/index'}.md`;
}

/** `title="..."` out of a JSX attribute string. Double quotes only — see below. */
function attr(source: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(source)?.[1];
}

/** Code fences blanked, so the JSX guard cannot trip over a shell heredoc. */
function withoutFences(source: string): string {
  return source.replace(/^```[\s\S]*?^```/gm, '');
}

/**
 * MDX reduced to markdown a reader can take at face value.
 *
 * This is deliberately a small set of string replacements rather than a real
 * MDX parse: exactly one page in this site is MDX and it uses three components.
 * What makes that safe is the guard at the end — anything this does not
 * recognise fails the build rather than shipping. A `<LinkCard>` in the middle
 * of a markdown file is not a rendering bug, it is a reader being handed source
 * code and told it is documentation, and the failure is silent at every point
 * where someone might notice it.
 *
 * The guard is also why attribute parsing can insist on double quotes: a single
 * quoted attribute does not silently produce a wrong link, it stops the build.
 */
export function mdxToMarkdown(body: string): string {
  let out = body;

  // The component import is the page's plumbing, not its content.
  out = out.replace(/^import\s+\{[^}]*\}\s+from\s+'@astrojs\/starlight\/components';\n+/m, '');

  // CardGrid is layout and nothing else; its LinkCards become a list.
  out = out.replace(/^[ \t]*<\/?CardGrid>[ \t]*\n/gm, '');
  // Leading indentation goes with it: the source nests these inside CardGrid,
  // and an indented list item is a different thing in markdown than a flat one.
  out = out.replace(/^[ \t]*<LinkCard\b([\s\S]*?)\/>/gm, (_m, attrs: string) => {
    const title = attr(attrs, 'title');
    const href = attr(attrs, 'href');
    const description = attr(attrs, 'description');
    if (!title || !href) return _m; // Unrecognised shape — let the guard catch it.
    return `- [${title}](${href})${description ? ` — ${description}` : ''}`;
  });

  // An Aside becomes a blockquote. It has to survive prominently rather than
  // flatten into the prose: on this site the Asides are the pre-1.0 caveats,
  // and a page that reads as a description of running software when it is a
  // specification is the single most expensive thing these files could get
  // wrong.
  out = out.replace(/<Aside\b([^>]*)>\n?([\s\S]*?)<\/Aside>/g, (_m, attrs: string, inner: string) => {
    const title = attr(attrs, 'title');
    const lines = inner.trim().split('\n');
    const quoted = lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');
    return title ? `> **${title}**\n>\n${quoted}` : quoted;
  });

  const residue = withoutFences(out);
  const leftover =
    /^import\s/m.exec(residue)?.[0] ?? /<\/?[A-Z][A-Za-z0-9]*[\s/>]/.exec(residue)?.[0];
  if (leftover) {
    throw new Error(
      `mdxToMarkdown: unhandled MDX in a page body (${JSON.stringify(leftover)}). ` +
        'Add a case for it in src/lib/page-markdown.ts — shipping it raw would put JSX ' +
        'into a file that claims to be markdown.'
    );
  }

  return out;
}

/**
 * Root-relative links made absolute, and pointed at a sibling where one exists.
 *
 * Absolute is not optional: a `.md` file is read detached from the site, so
 * `/docs/team-sheet` resolves against nothing. Retargeting to the sibling is
 * the part that could have been a guess, so it is not one — `siblings` is the
 * set of paths this build actually emitted, and a link to a marketing page,
 * which has no sibling, keeps pointing at the HTML.
 */
export function absolutiseLinks(body: string, base: string, siblings: ReadonlySet<string>): string {
  return body.replace(/\]\((\/[^)\s]*)\)/g, (_m, target: string) => {
    const [path = '', fragment] = target.split('#');
    const withSlash = path.endsWith('/') ? path : `${path}/`;
    const sibling = siblings.has(withSlash) ? markdownPath(withSlash) : path;
    return `](${new URL(sibling, base).href}${fragment ? `#${fragment}` : ''})`;
  });
}
