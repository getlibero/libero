/**
 * Fails the build if two words ended up fused across an inline tag boundary —
 * `The<a href="…">governance document</a>explains` rather than
 * `The <a href="…">governance document</a> explains`.
 *
 * This exists because that class of bug is invisible everywhere except to the
 * reader. It does not reproduce in `astro dev`, so neither the author nor a
 * reviewer looking at a browser will catch it; it only appears in a production
 * build. `compressHTML: false` in astro.config.mjs removes the mechanism that
 * caused it once — this check is what notices if it ever comes back, whether
 * from that setting being flipped or from someone typing the markup glued.
 *
 * Run against `dist/` after a build: `pnpm check:html`.
 *
 * The rule: an inline tag is a defect when there is a word character on the
 * text side of both boundaries, because that is a missing space and nothing
 * else. Everything softer is left alone deliberately —
 *
 *   <span class="lb-dot"></span>valid   empty element, spacing comes from gap
 *   </a><a href=…>                      adjacent links in a nav or footer
 *   (<code>x</code>)                    brackets and punctuation legitimately abut
 *
 * <pre>, <script> and <style> are excluded: whitespace inside them is either
 * significant or not prose. In particular the syntax highlighter emits dense
 * runs of adjacent <span>s, which are correct.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const INLINE = 'a|code|strong|em|b|i|span|abbr|kbd';

/** Word character, or the punctuation that still needs a space after it. */
const LEFT = '[A-Za-z0-9,;:.!?]';
const RIGHT = '[A-Za-z0-9]';

const RULES = [
  {
    id: 'fused-open',
    // ...import<code>packages...
    re: new RegExp(`${LEFT}<(?:${INLINE})(?:\\s[^>]*)?>${RIGHT}`, 'g'),
    hint: 'text runs straight into the start of an inline element',
  },
  {
    id: 'fused-close',
    // ...document</a>explains...
    re: new RegExp(`[A-Za-z0-9]</(?:${INLINE})>${RIGHT}`, 'g'),
    hint: 'an inline element runs straight into the text after it',
  },
];

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (path.endsWith('.html')) out.push(path);
  }
  return out;
}

/**
 * Blank out regions where adjacency is meaningless, preserving offsets so
 * reported line numbers stay true.
 */
function maskNonProse(html) {
  return html.replace(
    /<(pre|script|style)\b[\s\S]*?<\/\1>/g,
    (block) => ' '.repeat(block.length)
  );
}

const files = htmlFiles(DIST);
if (files.length === 0) {
  console.error(`check-html: no HTML in ${DIST}/. Run the build first.`);
  process.exit(1);
}

const findings = [];
for (const file of files.sort()) {
  const html = readFileSync(file, 'utf8');
  const searchable = maskNonProse(html);

  for (const { id, re, hint } of RULES) {
    for (const match of searchable.matchAll(re)) {
      const line = html.slice(0, match.index).split('\n').length;
      const context = html
        .slice(Math.max(0, match.index - 60), match.index + 80)
        .replace(/\s+/g, ' ')
        .trim();
      findings.push({ file, line, id, hint, context });
    }
  }
}

if (findings.length > 0) {
  console.error(`check-html: ${findings.length} missing word space(s).\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.id}] ${f.hint}`);
    console.error(`    …${f.context}…\n`);
  }
  console.error(
    'A word boundary was swallowed. Check that compressHTML is still false in\n' +
      'astro.config.mjs, and that the source has a space either side of the tag.'
  );
  process.exit(1);
}

console.log(`check-html: ${files.length} pages, no fused word boundaries.`);
