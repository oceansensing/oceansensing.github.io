#!/usr/bin/env node
/**
 * The seawater calculator page, driven in a headless DOM.
 *
 *   npm run build && node scripts/test-seawater.mjs
 *
 * `test:teos10` proves the physics. This proves the page: that the numbers
 * reach the screen, that changing an input changes what it says, that the
 * batch parser reads what people actually paste, and that the honesty the
 * library promises survives being rendered.
 *
 * It runs the **built** bundle against the **built** HTML, so it also catches
 * the thing neither source file can show on its own: the server-rendered
 * default state and the client's repaint have to produce the same rows, and
 * they are written twice.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import zlib from 'node:zlib';

const PAGE = 'dist/data/seawater/index.html';
if (!fs.existsSync(PAGE)) {
  console.error(`${PAGE} is missing — run \`npm run build\` first`);
  process.exit(1);
}
const html = fs.readFileSync(PAGE, 'utf8');

/* The calculator's script is far too large for Astro to inline, so it is
   bundled. If it ever crosses back under that threshold this stops finding
   it, which is why the failure says so rather than reporting no checks. */
const bundle = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)]
  .map((m) => `dist${m[1]}`)
  .find((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('data-seawater'));
if (!bundle) {
  console.error('no seawater bundle found — did the component script move or shrink into the page?');
  process.exit(1);
}

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
};

// ---- boot ------------------------------------------------------------------

const dom = new JSDOM(html, {
  url: 'https://oceansensing.org/data/seawater/',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

/* The atlas is a gzipped binary read with DecompressionStream, which jsdom
   has no fetch for and Node has no `DecompressionStream` binding into that
   realm. Serving it from disk, already inflated, exercises the decoder and
   the lookup for real while skipping only the transport — and the sniff for
   the gzip magic means the un-gzipped path is a shape the code already
   supports rather than a test-only branch. */
const atlasBytes = zlib.gunzipSync(fs.readFileSync('dist/teos10/saar.bin.gz'));
let atlasRequests = 0;
window.fetch = async (url) => {
  if (!String(url).includes('saar')) throw new Error(`unexpected fetch: ${url}`);
  atlasRequests++;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => atlasBytes.buffer.slice(
      atlasBytes.byteOffset, atlasBytes.byteOffset + atlasBytes.byteLength
    ),
  };
};

/* Node defines some of these as getters on globalThis, so they are defined
   rather than assigned. The bundle runs inside jsdom's realm and reaches for
   them by bare name. */
/* `localStorage` is in this list for a specific reason: Node does not define
   one without `--localstorage-file`, and the page wraps every storage call in
   a try/catch so a reader in private browsing still gets a working
   calculator. Leave it out and every storage call throws ReferenceError,
   every catch swallows it, and every check below passes against a feature
   that never ran. */
const REALM = [
  'window', 'document', 'location', 'history', 'navigator', 'Event', 'Blob',
  'URL', 'fetch', 'HTMLElement', 'SVGElement', 'Node', 'CustomEvent',
  'localStorage',
];
const inhabit = (w) => {
  for (const key of REALM) {
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
  }
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
};
inhabit(window);

/* Imported as a module into Node's own realm rather than injected as a
   <script>, which is what `test:map` does and for the same reason: jsdom will
   not run an injected script without `runScripts: 'dangerously'`, and with it
   the bundle gets a realm whose globals are harder to stub. */
const MODULE = './' + bundle.replace(/^dist/, '../dist');
await import(MODULE);
await new Promise((r) => setTimeout(r, 50));

/**
 * Load the page again, as the same browser would on a later visit.
 *
 * A fresh document with the given storage already in it and the given
 * fragment in the address bar, then a fresh instance of the module — the
 * query string is what defeats the ESM cache, since `import` of the same
 * specifier returns the same instance and would re-run nothing.
 *
 * jsdom scopes `localStorage` to each instance rather than to the origin, so
 * "the same browser" is copied across by hand. That is the one thing here
 * that is a simulation rather than the real mechanism, and it is the reason
 * the *writing* half is checked against the live store instead.
 */
let visits = 0;
async function reopen(storage, hash = '', { instantTimers = false } = {}) {
  const dom = new JSDOM(html, {
    url: `https://oceansensing.org/data/seawater/${hash}`,
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries(storage)) {
    if (value !== null) dom.window.localStorage.setItem(key, value);
  }
  dom.window.fetch = window.fetch;
  /* Runs every page timer immediately, which collapses the four seconds a
     transient message waits before clearing itself into no time at all. That
     is the only way to tell a held message from a transient one without
     making the gate wait four real seconds. */
  if (instantTimers) dom.window.setTimeout = (fn) => { fn(); return 0; };
  inhabit(dom.window);
  await import(`${MODULE}?visit=${++visits}`);
  await new Promise((r) => setTimeout(r, 50));
  return dom.window.document;
}

const q = (sel) => document.querySelector(sel);
const cell = (key) => q(`[data-row="${key}"] [data-cell]`)?.textContent;
const label = (key) => q(`[data-row="${key}"] dt`)?.textContent;
const type = (sel, value) => {
  const el = q(sel);
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const pick = (sel, value) => {
  const el = q(sel);
  el.value = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const wait = () => new Promise((r) => window.setTimeout(r, 0));

// ---- the server-rendered state, and the client agreeing with it ------------

const serverRows = [...document.querySelectorAll('[data-row]')].map((el) => el.dataset.row);
const serverValues = Object.fromEntries(serverRows.map((k) => [k, cell(k)]));

check('the page ships with its default state already computed',
  serverRows.length > 40 && Number(serverValues.rho) > 1000,
  `${serverRows.length} rows, density ${serverValues.rho}`);

/* The template and `paint()` render the same rows in two places, which is the
   cost of server-rendering the default. This is the check that keeps them
   honest: a repaint at the defaults must not change a single cell. */
type('[data-value="salinity"]', '35');
const afterRepaint = Object.fromEntries(serverRows.map((k) => [k, cell(k)]));
const drifted = serverRows.filter((k) => serverValues[k] !== afterRepaint[k]);
check('and a repaint at those same inputs changes nothing',
  drifted.length === 0, drifted.length ? `${drifted.length} cells drifted: ${drifted.slice(0, 4)}` : '');

// ---- inputs reaching the numbers -------------------------------------------

type('[data-value="temperature"]', '25');
const warm = { ct: Number(cell('CT')), rho: Number(cell('rho')), c: Number(cell('c')) };
check('warming the sample lowers its density and speeds up sound',
  warm.rho < Number(serverValues.rho) && warm.c > Number(serverValues.c),
  `${warm.rho} kg/m3, ${warm.c} m/s`);

/* Conservative Temperature as an *input* has to run the conversion backwards.
   At 1000 dbar the in-situ temperature is the warmer of the two, so a page
   that quietly treated CT as t would return the number it was given. */
pick('[data-kind="temperature"]', 'CT');
type('[data-value="temperature"]', '25');
check('Conservative Temperature entered as input is inverted, not copied',
  Math.abs(Number(cell('CT')) - 25) < 1e-3 && Number(cell('t')) > 25.1,
  `t ${cell('t')} for CT 25 at 1000 dbar`);
pick('[data-kind="temperature"]', 't');
type('[data-value="temperature"]', '10');

/* A conductivity is what a CTD actually reports, and PSS-78 needs the in-situ
   temperature and pressure to turn it into a salinity. */
pick('[data-kind="salinity"]', 'C');
type('[data-value="salinity"]', '38.5295219');
check('a conductivity resolves back to the salinity it came from',
  Math.abs(Number(cell('SP')) - 35) < 1e-4, `SP ${cell('SP')}`);
pick('[data-kind="salinity"]', 'SP');
type('[data-value="salinity"]', '35');

// ---- depth, and the latitude it needs --------------------------------------

pick('[data-kind="pressure"]', 'z');
type('[data-value="pressure"]', '1000');
const atEquator = Number(cell('p'));
check('a depth with no latitude says which one it assumed',
  [...document.querySelectorAll('[data-messages] p')].some((p) => /equator/.test(p.textContent)));

type('[data-value="lat"]', '60');
const atSixty = Number(cell('p'));
check('and gravity moves the pressure when a latitude is given',
  Math.abs(atSixty - atEquator) > 1, `${atEquator} vs ${atSixty} dbar at 1000 m`);
check('the gravity row names the latitude it used',
  /60/.test(label('grav') ?? ''), label('grav'));

// ---- the salinity anomaly --------------------------------------------------

type('[data-value="lat"]', '30');
type('[data-value="lon"]', '200');
pick('[data-kind="pressure"]', 'p');
type('[data-value="pressure"]', '2000');

check('the atlas is fetched once a position exists', atlasRequests === 1, `${atlasRequests} request(s)`);
await wait();
await wait();

/* Several more edits, each of which repaints. The fetch is latched, so a
   reader typing a longitude digit by digit must not pull 188 KB per keystroke. */
for (const v of ['11', '12', '13', '10']) type('[data-value="temperature"]', v);
check('and not again on every repaint', atlasRequests === 1, `${atlasRequests} request(s)`);

check('the North Pacific anomaly reaches the page',
  Number(cell('SA')) > Number(cell('SR')) && Number(cell('dSA')) > 0.015,
  `SA ${cell('SA')} against SR ${cell('SR')}, anomaly ${cell('dSA')}`);
check('and it is stated in words as well as numbers',
  [...document.querySelectorAll('[data-messages] p')].some((p) => /composition anomaly/.test(p.textContent)));

/* The promise the library makes, checked where a reader would see it broken:
   with the position cleared, SA and SR must be the same number *and* the page
   must say why. Reporting the right number silently is the failure. */
type('[data-value="lon"]', '');
type('[data-value="lat"]', '');
check('clearing the position falls back to Reference Salinity',
  cell('SA') === cell('SR'), `SA ${cell('SA')}, SR ${cell('SR')}`);
check('and says so rather than quietly renaming it',
  [...document.querySelectorAll('[data-messages] p')].some((p) => /Reference Salinity/.test(p.textContent)));

// ---- warnings --------------------------------------------------------------

type('[data-value="temperature"]', '-4');
check('water below its freezing point is flagged on the page',
  [...document.querySelectorAll('[data-messages] .warn')].some((p) => /freezing/.test(p.textContent)));
type('[data-value="temperature"]', '10');

// ---- the T-S diagram -------------------------------------------------------

{
  const svg = q('[data-ts]');
  const isos = svg.querySelectorAll('.iso');
  check('the diagram draws density contours', isos.length >= 3, `${isos.length} contours`);
  check('and labels them', svg.querySelectorAll('.iso-label').length >= 3);
  check('and marks the sample', svg.querySelectorAll('.sample').length === 1);
  check('and draws the freezing line', svg.querySelectorAll('.freeze').length === 1);

  /* Every stroke is a class, never an attribute: the map has the same rule
     and the same reason, which is that a theme switch has to restyle the
     picture with no redraw. An inline colour would be invisible to that. */
  const inline = [...svg.querySelectorAll('*')]
    .filter((el) => el.getAttribute('stroke') || el.getAttribute('fill'));
  check('and carries no colour of its own', inline.length === 0,
    inline.length ? `${inline.length} element(s) with an inline stroke or fill` : '');

  /* Every stroked path needs `fill: none`, and the axis is the one that bites:
     an SVG path fills by default, so the two-legged axis renders as a solid
     black triangle across the diagram. It shipped that way once. */
  const css = fs.readdirSync('dist/_astro')
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(`dist/_astro/${f}`, 'utf8'))
    .join('\n');
  /* Anchored on the exact selector: `.axis-label` sorts first in the sheet,
     so a loose `.axis` match reads the label rule and reports a missing
     fill:none that was never meant to be there. */
  const axisRule = /\.ts \.axis\{[^{}]*\}/.exec(css)?.[0] ?? '';
  check('and the axis rule sets fill:none, or it draws as a filled triangle',
    /fill:\s*none/.test(axisRule), axisRule || 'no .axis rule found in the built CSS');

  /* Two facts about the phone layout, decided over the built stylesheet
     because jsdom does no layout and cannot measure a tap target.

     The second is the one that bit: the base `button` rule sets the `padding`
     shorthand at one-selector specificity and so does the override, so source
     order decides. Written above it the media query silently loses for the
     buttons alone — measured, the selects reached 44 px and the buttons
     stayed at 35 — which is the map's basemap-cascade trap in a new place.
     Minification rewrites the query, so this anchors on the declaration. */
  /* Found from the declaration outwards, not from the media query inwards:
     `builtCss` concatenates every stylesheet in dist, and the map's own
     48rem breakpoint sorts first — so searching for the query matched
     `.ocean-map{height:…}` and reported a missing rule that was never in it.
     The same masking `test:map` has a note about, met from a new direction. */
  const at = css.search(/padding-block:\s*0?\.78em/);
  const opened = at > 0 ? css.lastIndexOf('@media', at) : -1;
  check('phones get a bigger tap target than the 35 px default',
    at > 0 && /48rem/.test(css.slice(opened, opened + 90)),
    at > 0 ? css.slice(opened, opened + 60) : 'no 0.78em padding-block anywhere in the built CSS');
  check('and that rule sits below the base button rule, or it loses the cascade',
    css.lastIndexOf('48rem') > css.lastIndexOf('padding:.45em .8em'),
    `media at ${css.lastIndexOf('48rem')}, base button at ${css.lastIndexOf('padding:.45em .8em')}`);

  /* The contours are cached per window, which is what keeps a keystroke at
     0.98 ms instead of 3.59 ms -- measured in a browser, where the trace is
     the dominant cost. That saving is **not** what this checks: in jsdom the
     DOM work swamps it (53 ms a repaint either way), so a timing check here
     would compare noise, and the traced paths are deterministic so comparing
     the output cannot tell a cache hit from a re-trace either.
     What it checks is the risk the cache actually carries, which is a stale
     picture: move the sample far enough to leave the window and the contours
     must be redrawn for the new one. A cache that never invalidated would
     leave a diagram describing water the reader has left. */
  const iso = () => [...q('[data-ts]').querySelectorAll('.iso')].map((p) => p.getAttribute('d')).join('');
  const near = iso();
  type('[data-value="temperature"]', '10.01');
  check('a nudge inside the window leaves the contours where they are',
    iso() === near && near.length > 0);
  type('[data-value="temperature"]', '30');
  check('and leaving the window redraws them rather than going stale',
    iso() !== near && iso().length > 0);
  type('[data-value="temperature"]', '10');
  check('and coming back redraws them again', iso() === near);
}

// ---- a column of measurements ----------------------------------------------

{
  q('[data-batch-input]').value =
    'SP, t, p\n35.0, 10.0, 1000\n34.7 4.2 2000\n34.9;12.1;50\n35.0,\t10.0,\t1000\nrubbish';
  q('[data-action="batch"]').dispatchEvent(new window.Event('click', { bubbles: true }));

  const rows = [...q('[data-batch-out]').querySelectorAll('tr')].slice(1);
  check('a pasted column converts, skipping the header and the noise',
    rows.length === 4, `${rows.length} rows: ${q('[data-batch-said]').textContent}`);

  /* Comma-space is the commonest paste there is, and it was the one that
     broke: splitting on "commas OR whitespace" matches both characters
     separately, leaving an empty token whose Number() is 0 rather than NaN,
     so every column shifts one left and the reader gets plausible numbers for
     water they never described. Rows 1 and 4 are the separators that failed;
     they must agree with rows built from unambiguous ones. */
  const first = [...rows[0].querySelectorAll('td')].map((td) => td.textContent);
  const commaTab = [...rows[3].querySelectorAll('td')].map((td) => td.textContent);
  check('and comma-space parses the same as comma-tab',
    first.slice(1).join('|') === commaTab.slice(1).join('|'), first.slice(1).join(' '));
  /* The single sample has to be put on the same water first, or this
     compares two different states and passes or fails by accident. */
  type('[data-value="salinity"]', '35');
  type('[data-value="pressure"]', '1000');
  type('[data-value="temperature"]', '10');
  check('and matches the single-sample answer for the same water',
    first[4] === cell('rho'), `batch ${first[4]} against ${cell('rho')}`);
}

// ---- the address bar --------------------------------------------------------

{
  type('[data-value="salinity"]', '38.5');
  const hash = window.location.hash;
  check('the view rides in the address bar', /salinity=38.5/.test(hash), hash);
  check('and carries only what differs from the defaults',
    !/temperature=10\b/.test(hash) && !/pressureKind/.test(hash), hash);

  /* Pasting a link into an open page is a same-document navigation: nothing
     reloads and only `hashchange` fires. Without handling it the page would
     ignore the link and then overwrite it on the next keystroke. */
  window.location.hash = '#salinity=20&temperature=4&pressure=0&pressureKind=p';
  window.dispatchEvent(new window.Event('hashchange'));
  check('and a link pasted into an open page is applied',
    q('[data-value="salinity"]').value === '20' && Math.abs(Number(cell('t')) - 4) < 1e-9,
    `SP ${q('[data-value="salinity"]').value}, t ${cell('t')}`);
}

// ---- conductivity is an input, and has to be findable as one -----------------

{
  const menu = q('[data-kind="salinity"]');
  const groups = [...menu.querySelectorAll('optgroup')].map((g) => g.label);
  check('the salinity menu says which of its options are conductivities',
    groups.includes('Conductivity'), groups.join(', ') || 'no optgroups');
  check('and the field is labelled for both, not just salinity',
    /conductivity/i.test(q('label[for="sw-sal-kind"]').textContent));

  /* The value box has no visible label of its own, so its accessible name is
     the only thing telling a screen reader what the number is — and it has to
     follow the menu. Written once it said "Salinity value" while the reader
     typed a conductivity. */
  pick('[data-kind="salinity"]', 'C');
  const named = q('[data-value="salinity"]').getAttribute('aria-label');
  check('and the value box renames itself to match', /conductivity/i.test(named ?? ''), named);
  pick('[data-kind="salinity"]', 'SP');
  check('and back again', /practical salinity/i.test(q('[data-value="salinity"]').getAttribute('aria-label') ?? ''));
}

// ---- what the browser remembers of the last visit -----------------------------

const KEY = 'seawater-inputs';
let snapshot = {};
{
  /* A state nothing else in this run uses, so a value left over from an
     earlier check cannot pass for a restored one. */
  pick('[data-kind="salinity"]', 'C');
  type('[data-value="salinity"]', '41.7');
  type('[data-value="temperature"]', '6.5');
  type('[data-value="pressure"]', '250');

  const held = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
  check('the inputs are remembered as they are typed',
    held?.salinityKind === 'C' && held?.salinity === 41.7
      && held?.temperature === 6.5 && held?.pressure === 250,
    JSON.stringify(held));

  snapshot = { [KEY]: window.localStorage.getItem(KEY) };
}

// ---- reset -------------------------------------------------------------------

const wantedSP = cell('SP');
q('[data-action="reset"]').dispatchEvent(new window.Event('click', { bubbles: true }));
const afterReset = Object.fromEntries(serverRows.map((k) => [k, cell(k)]));
const stillWrong = serverRows.filter((k) => serverValues[k] !== afterReset[k]);
check('Reset returns every row to the state the page shipped with',
  stillWrong.length === 0,
  stillWrong.length ? `${stillWrong.length} differ: ${stillWrong.slice(0, 4)}` : '');

/* Reset has to forget as well as revert, or the next visit undoes it — which
   is the bug the map's saved view already has a note about. It falls out of
   `remember` storing nothing when the state is the defaults, so this is
   checking that consequence rather than a second code path. */
check('and forgets, so the next visit does not undo it',
  window.localStorage.getItem(KEY) === null, window.localStorage.getItem(KEY));

// ---- and the next visit -------------------------------------------------------

{
  const back = await reopen(snapshot);
  const value = (d, key) => d.querySelector(`[data-row="${key}"] [data-cell]`)?.textContent;
  check('a later visit in the same browser comes back to those inputs',
    back.querySelector('[data-value="salinity"]').value === '41.7'
      && back.querySelector('[data-kind="salinity"]').value === 'C'
      && back.querySelector('[data-value="temperature"]').value === '6.5',
    `${back.querySelector('[data-kind="salinity"]').value} ${back.querySelector('[data-value="salinity"]').value}`);
  check('and to the same numbers', value(back, 'SP') === wantedSP,
    `${value(back, 'SP')} against ${wantedSP}`);
  check('and says it did, since numbers you did not type read as a bug',
    /last visit/i.test(back.querySelector('[data-said]').textContent));

  /* Held, not transient. Measured in a browser, a returning reader had not
     looked at the page for 29 s — so the four-second clear that suits
     "Copied" would have taken away the only sentence explaining why the
     numbers were not the defaults, 25 seconds before they read it. */
  const patient = await reopen(snapshot, '', { instantTimers: true });
  check('and holds the notice rather than clearing it after four seconds',
    /last visit/i.test(patient.querySelector('[data-said]').textContent),
    `"${patient.querySelector('[data-said]').textContent}"`);

  const box = patient.querySelector('[data-value="temperature"]');
  box.value = '7.5';
  box.dispatchEvent(new patient.defaultView.Event('input', { bubbles: true }));
  check('and drops it once the reader touches anything',
    patient.querySelector('[data-said]').textContent === '');

  /* The precedence that matters: someone sends you a link and you must see
     *their* view, not your own. A stored state winning here would make the
     link feature untrustworthy in the one case it exists for. */
  const linked = await reopen(snapshot, '#salinity=12&salinityKind=SP&temperature=3');
  check('a link outranks what the browser remembers',
    linked.querySelector('[data-value="salinity"]').value === '12'
      && linked.querySelector('[data-kind="salinity"]').value === 'SP',
    `${linked.querySelector('[data-kind="salinity"]').value} ${linked.querySelector('[data-value="salinity"]').value}`);
  check('and does not claim to have restored anything',
    !/last visit/i.test(linked.querySelector('[data-said]').textContent));

  /* Storage outlives the code that wrote it. A state from an older version
     naming a kind this one dropped must fall back rather than reach the
     engine, where an unknown kind falls through a switch and yields Standard
     Seawater with no Practical Salinity — plausible-looking and wrong. */
  const stale = await reopen({ [KEY]: '{"salinityKind":"gone","salinity":"oops","temperature":9}' });
  check('a stale or corrupt memory is read for what it can give',
    stale.querySelector('[data-kind="salinity"]').value === 'SP'
      && stale.querySelector('[data-value="salinity"]').value === '35'
      && stale.querySelector('[data-value="temperature"]').value === '9',
    `${stale.querySelector('[data-kind="salinity"]').value} ${stale.querySelector('[data-value="salinity"]').value} ${stale.querySelector('[data-value="temperature"]').value}`);

  const junk = await reopen({ [KEY]: 'not json at all' });
  check('and unreadable storage is simply the defaults',
    junk.querySelector('[data-value="salinity"]').value === '35'
      && Number(junk.querySelector('[data-row="rho"] [data-cell]').textContent) > 1000);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
