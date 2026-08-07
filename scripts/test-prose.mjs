#!/usr/bin/env node
/**
 * Every page's prose, read for the spaces that vanish between source and HTML.
 *
 *   npm run build && node scripts/test-prose.mjs
 *
 * WHAT THIS CATCHES, AND WHY NOTHING ELSE COULD
 * ---------------------------------------------
 * Astro drops the whitespace *before* an inline element that begins a line in
 * the source, and keeps the whitespace after it. So this, which is what a
 * paragraph looks like after any ordinary reflow:
 *
 *     Every property of seawater, from the
 *     <a href="https://www.teos-10.org/">TEOS-10</a> Gibbs function.
 *
 * renders as "from theTEOS-10 Gibbs function".
 *
 * The source is correct-looking — the space is right there at the end of the
 * line — so review does not catch it, `astro check` has nothing to say about
 * it, and it survives until somebody reads the rendered page. It reached the
 * live site four times before this existed, in the map's own no-JavaScript
 * fallback among others, which is text almost nobody sees.
 *
 * It is deliberately a whole-site check rather than one page's, because the
 * trap belongs to the templating and not to any feature.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist';
if (!fs.existsSync(ROOT)) {
  console.error(`${ROOT} is missing — run \`npm run build\` first`);
  process.exit(1);
}

/* Elements that carry a word and therefore want a space on the side of them
   the prose continues on. `<sup>` and `<sub>` are left out on purpose:
   `10<sup>-19</sup>` and `g<sub>P</sub>` are exactly right butted up against
   their base.

   **Both sides, and the second was found the hard way.** The rule is not
   "before an opening tag" but "at a line break next to an element boundary":
   a closing tag that ends a line loses the space in front of the text that
   follows it too, so `…not vehicle data.</strong>` + newline + `Each volume`
   renders as "dataEach". The first version of this gate checked only the
   opening side and passed a page with exactly that on it. */
const INLINE = 'a|code|em|strong|abbr';
const NEEDS_SPACE = new RegExp(
  `(?:([A-Za-z0-9,;:)])(<(?:${INLINE})[\\s>][^>]*>))`
  + `|(?:(</(?:${INLINE})>)([A-Za-z0-9]))`,
  'g'
);

/* Chrome, not prose: a nav item or a list of links is a sequence of elements
   with no sentence around them, and there the absence of a space is the
   layout's business. Only paragraphs are read. */
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/g;

const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, e.name);
    if (e.isDirectory()) walk(at);
    else if (e.name.endsWith('.html')) pages.push(at);
  }
})(ROOT);

const problems = [];
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  for (const para of html.matchAll(PARAGRAPH)) {
    for (const hit of para[1].matchAll(NEEDS_SPACE)) {
      const at = Math.max(0, hit.index - 45);
      const context = para[1].slice(at, hit.index + hit[0].length + 25).replace(/\s+/g, ' ');
      problems.push(`${page}: …${context}…`);
    }
  }
}

const ok = problems.length === 0;
console.log(
  `${ok ? 'ok  ' : 'FAIL'}  ${pages.length} built pages keep the spaces around every inline element in their prose`
);
for (const p of problems) console.log(`        ${p}`);

if (!ok) {
  console.log(
    '\n  Astro eats the whitespace at a line break next to an element'
    + '\n  boundary — before an opening tag that starts a line, and after a'
    + '\n  closing tag that ends one. Keep the space on the same line as the'
    + '\n  tag: `from the <a …>`, and `</strong> Each` rather than a newline.'
  );
}
process.exit(ok ? 0 : 1);
