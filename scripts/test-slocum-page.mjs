#!/usr/bin/env node
/**
 * The built Slocum decoder page, driven in jsdom against the real fixtures.
 *
 *   npm run test:slocum-page
 *
 * `test:slocum` proves the decoding. This proves the page: that files reaching
 * the input come out as a table on screen, that a missing cache says which
 * cache, that the exports carry what the reader selected, and that the chrome
 * built at runtime is actually styled.
 *
 * WHY THE CSS HALF IS DECIDED OVER THE BUILT STYLESHEET
 * ----------------------------------------------------
 * Because jsdom does no layout and does not cascade the way a browser does,
 * and because the worst bug this page shipped was invisible to everything
 * else. Astro scopes a component's styles by stamping a `data-astro-cid-…`
 * attribute on the elements in its *markup* and rewriting every selector to
 * require it — so a rule for an element built later by `createElement` matches
 * nothing. No error, no warning: the two charts rendered as solid black blobs
 * (an SVG path fills by default) and the whole sensor list came out as
 * unstyled text. It was found by reading `getComputedStyle` in a browser,
 * because unstyled chrome looks like a design decision.
 *
 * The fix is a `<style is:global>` block anchored to `[data-slocum]`. What
 * keeps it fixed is a check that the rules for runtime-built elements are
 * *not* scoped, read out of `dist`. The same tactic `test:map` uses for the
 * three CSS faults it cannot render its way to.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url);
const FIXTURES = new URL('./scripts/fixtures/slocum/', ROOT);
const PAGE = new URL('./dist/data/slocum/index.html', ROOT);

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${what}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`),
  );
};

const html = readFileSync(PAGE, 'utf8');

// ── The built stylesheet, and the scoping trap ───────────────────────────────

console.log('--- styling the chrome that is built at runtime ---');
{
  const cssDir = new URL('./dist/_astro/', ROOT);
  const builtCss = readdirSync(cssDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(new URL(f, cssDir), 'utf8'))
    .join('\n');

  // Every one of these targets an element the script creates. If any is
  // scoped, that element renders with browser defaults.
  const runtime = [
    ['.trace', 'the chart line'],
    ['.axis', 'the chart axes'],
    ['.tick', 'the axis labels'],
    ['.sensor-list label', 'a sensor checkbox'],
    ['.notes li', 'a note'],
    ['td.blank', 'an unrecorded cell'],
    ['th.derived', 'a derived column heading'],
    ['.og1-field', 'an OG1 metadata field'],
    ['.og1-grid', 'the OG1 field grid'],
  ];
  const scoped = [];
  for (const [selector] of runtime) {
    // Find the rule and check the compound selector carries no scope attribute.
    const tail = selector.split(' ').pop();
    const pattern = new RegExp(`\\[data-slocum\\][^{}]*${tail.replace('.', '\\.')}(?![\\w-])[^{}]*\\{`);
    if (!pattern.test(builtCss)) scoped.push(selector);
  }
  check('every rule for a runtime-built element is global, anchored to [data-slocum]',
    scoped, []);

  // And that anchoring is what stops them leaking: a bare `.trace { }` would
  // restyle any element with that class anywhere on the site.
  check('and none of them is written bare, so nothing leaks to other pages',
    /(^|[},])\s*\.(trace|axis|tick|og1-field)\s*[,{]/.test(builtCss), false);

  // A grid item's min-width defaults to `auto`, which for an <input> is the
  // twenty characters its `size` implies. Without an explicit 0 the last
  // metadata field hangs out of the panel — and a viewport-overflow scan does
  // not see it, because it overflows its container rather than the window.
  //
  // Anchored to the *container* rule — `.og1-field{`, with nothing after it —
  // because `.og1-field input` also sets `min-inline-size: 0` and a looser
  // pattern is satisfied by that one while the container's is deleted. The
  // same masking `test:map` has a note about, met for the third time.
  check('the OG1 field boxes may shrink below an input\'s intrinsic width',
    /\.og1-field\s*\{[^}]*min-inline-size:\s*0/.test(builtCss), true);

  // `[hidden]` is one selector and so is `display: flex`, so author order
  // decides — without an explicit rule the sensor filter would hide nothing.
  check('a class that sets display is beaten back by [hidden] where it must be',
    /\[data-slocum\][^{}]*label\[hidden\]\s*\{[^}]*display:\s*none/.test(builtCss), true);

  // An SVG path fills by default. This is the seawater calculator's black
  // triangle, in a component that draws two charts.
  check('stroked paths declare fill:none',
    /\[data-slocum\][^{}]*\.trace[^{}]*\{[^}]*fill:\s*none/.test(builtCss) ||
      /\[data-slocum\][^{}]*\.axis[^{}]*,[^{}]*\.trace[^{}]*\{[^}]*fill:\s*none/.test(builtCss),
    true);

  // iOS Safari's own button chrome overrides background and border-radius, so
  // a styled button comes out as a grey rounded rect on a phone and nowhere
  // else. Anchored to *this component's* rule: `builtCss` is every stylesheet
  // in `dist` concatenated, and the map alone carries four `appearance: none`
  // declarations, so an unanchored search passes with this component's
  // deleted. That masking is exactly what `test:map` has a note about.
  check('this page\'s own buttons switch off the UA appearance',
    /\.download[^{}]*button[^{}]*\{[^}]*appearance:\s*none/.test(builtCss), true);
}

// ── The page, driven ─────────────────────────────────────────────────────────

console.log('\n--- decoding, in the page ---');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/data/slocum/',
  resources: undefined,
});
const { window } = dom;
const { document } = window;

// jsdom has no IndexedDB and no File.arrayBuffer worth the name, and the
// bundle is an ES module jsdom will not execute from a <script type="module">
// tag. So the module is imported here and handed this document, the same way
// test:seawater and test:ballast-page reach their bundles.
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Node = window.Node;
globalThis.Blob = window.Blob;
globalThis.URL = window.URL;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

check('the page carries the under-testing notice', !!document.querySelector('[data-disclaimer]'), true);
check('and it sits above the tool',
  document.querySelector('[data-disclaimer]').compareDocumentPosition(
    document.querySelector('[data-drop]'),
  ) & 4 ? true : false,
  true);
check('the notice says it is under testing and used at the reader\'s own risk',
  /under testing/i.test(document.querySelector('[data-disclaimer]').textContent) &&
    /own risk/i.test(document.querySelector('[data-disclaimer]').textContent),
  true);
// ── OG1: the panel, and the claim it makes ──────────────────────────────────

check('the page offers an OG1.0 export', !!document.querySelector('[data-og1-panel]'), true);
check('with both encodings', [
  !!document.querySelector('[data-og1-nc]'),
  !!document.querySelector('[data-og1-cdl]'),
], [true, true]);
check('and a way to carry the metadata between segments', [
  !!document.querySelector('[data-og1-save]'),
  !!document.querySelector('[data-og1-load]'),
], [true, true]);

{
  // The wording of this caveat is the whole honesty of the feature. The file
  // has never been through an OG1 validator — the community's own checkers
  // say they are experimental — so the page must say so outright, and must
  // say what the encoding actually is.
  const caveat = (document.querySelector('.og1-caveat')?.textContent ?? '').replace(/\s+/g, ' ');
  check('the page says the encoding is netCDF-3, not netCDF-4',
    /netCDF-3/.test(caveat) && /cannot write netCDF-4/.test(caveat), true);
  check('and says the CDL is the route to netCDF-4', /ncgen -4/.test(caveat), true);
  check('and says outright that neither file has been validated',
    /No OG1 validator has checked either file/.test(caveat), true);
  check('nowhere on the page claims compliance outright',
    /OG1[.\s-]*(0\s+)?compliant/i.test(html), false);
}

check('the results are hidden until there is something to show',
  document.querySelector('[data-results]').hasAttribute('hidden'), true);
check('the file input takes several files at once',
  document.querySelector('[data-files]').hasAttribute('multiple'), true);
check('and accepts the compressed extensions as well as the plain ones',
  ['.sbd', '.tbd', '.dbd', '.scd', '.tcd', '.cac', '.ccc'].every((ext) =>
    document.querySelector('[data-files]').getAttribute('accept').includes(ext)),
  true);

// ── What the page's own module does with real files ──────────────────────────
//
// The interface is DOM wiring over `@c4po/slocum`; the decoding is gated in
// test:slocum. What is checked here is the wiring: that the module the page
// imports, given these bytes, produces what the page then renders.

console.log('\n--- the page\'s own pipeline, on the fixtures ---');
{
  const { openDbd, readSeries, buildTable, deriveSeawater, toCsv, toNetcdf, describe, familyOf } =
    await import('../packages/slocum/index.ts');
  const { MissingCacheError } = await import('../packages/slocum/types.ts');

  const read = (name) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
  const text = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

  // The page decides what to do with a file from its extension before it has
  // read a byte, so that classification is load-bearing.
  check('the page can tell a cache file from a data file by name alone',
    ['electa-2025-120-1-169.sbd', 'electa-2025-120-1-169.tbd', '0f682cb2.cac', '63231de3.ccc']
      .map(familyOf),
    ['flight', 'science', 'cache', 'cache']);

  // The commonest failure, and the one the interface exists to explain.
  const header = describe(read('electa-2025-120-1-169.sbd'), 'electa-2025-120-1-169.sbd');
  check('a header is readable before any cache is found, so the page can ask for one',
    { factored: header.sensorListFactored, crc: header.sensorListCrc },
    { factored: 1, crc: '0f682cb2' });

  let named = '';
  try {
    openDbd(read('electa-2025-120-1-169.sbd'), { name: 'electa-2025-120-1-169.sbd' });
  } catch (error) {
    if (error instanceof MissingCacheError) named = error.crc;
  }
  check('and a file without it names the cache rather than failing vaguely', named, '0f682cb2');

  const flight = openDbd(read('electa-2025-120-1-169.sbd'),
    { name: 'electa-2025-120-1-169.sbd', cache: text('0f682cb2.cac') });
  const science = openDbd(read('electa-2025-120-1-169.tbd'),
    { name: 'electa-2025-120-1-169.tbd', cache: text('92610b65.cac') });
  const series = [...readSeries(flight), ...readSeries(science)];
  const table = buildTable(series);

  check('the pair decodes to the table the page shows',
    { rows: table.rows, columns: table.columns.length }, { rows: 1328, columns: 62 });

  const { columns: derived } = deriveSeawater(table);
  table.columns.push(...derived);
  check('and ticking the box adds six seawater columns', derived.length, 6);

  // The exports carry the reader's selection, not the whole table. A download
  // that quietly ignored the sensor picker would be a data bug wearing a UI
  // feature's clothes — the same one `test:seawater` checks for its filter.
  const chosen = ['sci_water_temp', 'salinity_practical'];
  const narrowed = { ...table, columns: table.columns.filter((c) => chosen.includes(c.name)) };
  const csv = toCsv(narrowed);
  const head = csv.split('\n')[0].split(',');
  check('an export carries exactly the columns that were selected',
    head, ['time', 'time_utc', 'sci_water_temp (degc)', 'salinity_practical (PSU)']);
  check('and one row per table row', csv.trimEnd().split('\n').length - 1, table.rows);

  // The form is built from the package's field list, so the two cannot drift.
  const { OG1_FIELDS, OG1_DEFAULTS, missingFields } = await import('../packages/slocum/og1.ts');
  check('every declared field has a group the form knows how to render',
    [...new Set(OG1_FIELDS.map((f) => f.group))].sort(),
    ['deployment', 'people', 'platform', 'programme', 'quality', 'sensor']);
  check('and the mandatory ones are what gate the export',
    missingFields(OG1_DEFAULTS).length > 0, true);

  const nc = toNetcdf(narrowed, { sources: ['electa-2025-120-1-169.sbd'] });
  check('the netCDF export is a classic netCDF file',
    [...nc.slice(0, 4)], [0x43, 0x44, 0x46, 0x01]);
  check('with the two chosen variables and time',
    new DataView(nc.buffer, nc.byteOffset).getInt32(24, false), table.rows);
}

console.log(
  failures
    ? `\n${failures} failing check(s) on the Slocum decoder page.`
    : '\nok    the Slocum decoder page decodes, styles its runtime chrome, and exports what was selected',
);
process.exit(failures ? 1 : 0);
