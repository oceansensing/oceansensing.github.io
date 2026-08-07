#!/usr/bin/env node
/**
 * The glider ballast page, driven in a headless DOM.
 *
 *   npm run build && node scripts/test-ballast-page.mjs
 *
 * `test:ballast` proves the buoyancy arithmetic. This proves the page around
 * it: that the answer reaches the screen, that a tank reading overrides the
 * typed mass the way the panel says it does, that changing which point to
 * ballast for changes the answer, and that the illustrative-numbers caution
 * cannot be lost.
 *
 * That last one is the reason this file exists at all. Every vehicle shipped
 * carries stand-in hull terms, and a ballast figure computed from a stand-in
 * compressibility is wrong by an amount nothing on the page can show. The
 * caution is the only thing standing between that and somebody's vehicle.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const PAGE = 'dist/data/glider-ballast/index.html';
if (!fs.existsSync(PAGE)) {
  console.error(`${PAGE} is missing — run \`npm run build\` first`);
  process.exit(1);
}
const html = fs.readFileSync(PAGE, 'utf8');

const bundle = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)]
  .map((m) => `dist${m[1]}`)
  .find((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('data-ballast'));
if (!bundle) {
  console.error('no glider-ballast bundle found in dist/_astro');
  process.exit(1);
}

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
};

const dom = new JSDOM(html, {
  url: 'https://oceansensing.org/data/glider-ballast/',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;
window.fetch = async () => { throw new Error('the page should not fetch without a position'); };

for (const key of [
  'window', 'document', 'location', 'history', 'navigator', 'Event', 'Blob',
  'URL', 'fetch', 'HTMLElement', 'Node', 'CustomEvent', 'localStorage',
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

await import('./' + bundle.replace(/^dist/, '../dist'));
await new Promise((r) => setTimeout(r, 50));

const q = (sel) => document.querySelector(sel);
const headline = (key) => q(`[data-headline-row="${key}"] b`)?.textContent ?? '';
const grams = (text) => Number(String(text).replace('−', '-').replace('+', ''));
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

// ---- the caution -----------------------------------------------------------

check('the illustrative-numbers caution is in the shipped HTML',
  /illustrative numbers, not vehicle data/i.test(html));
check('and it is showing, not hidden behind anything',
  q('[data-illustrative]') !== null && q('[data-illustrative]').hidden === false);
check('and it says what to replace them with',
  /ballast sheet|tank test/i.test(q('[data-illustrative]').textContent));

/* Every vehicle offered has to carry it. A preset that quietly lost the flag
   would look like real data and read like real data. */
for (const option of [...q('[data-vehicle]').options].filter((o) => o.value !== 'custom')) {
  pick('[data-vehicle]', option.value);
  check(`${option.value} still shows the caution`, q('[data-illustrative]').hidden === false);
}
pick('[data-vehicle]', 'slocum');

// ---- the answer reaches the screen ----------------------------------------

check('the page ships with its answer already computed',
  Number.isFinite(grams(headline('ballastChange')))
  && Number(headline('neutralDensity')) > 1000,
  `${headline('ballastChange')} g, neutral at ${headline('neutralDensity')}`);

check('and the three points are on it',
  document.querySelectorAll('[data-reading]').length === 3,
  [...document.querySelectorAll('[data-reading]')].map((r) => r.dataset.reading).join(', '));

/* Ballasting for the point the vehicle is neutral at means no change at all;
   ballasting for a denser one means adding lead. Both directions, because a
   sign error here has an operator taking lead out when they should put it in. */
{
  const before = grams(headline('ballastChange'));
  q('[data-neutral][value="2"]').checked = true;
  q('[data-neutral][value="2"]').dispatchEvent(new window.Event('change', { bubbles: true }));
  const deep = grams(headline('ballastChange'));
  check('ballasting for the deepest, densest point adds more lead than the mixed layer',
    deep > before, `${deep} g against ${before} g`);
  check('and the neutral density follows the chosen point',
    Number(headline('neutralDensity')) > 1030, headline('neutralDensity'));

  q('[data-neutral][value="0"]').checked = true;
  q('[data-neutral][value="0"]').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('and the lightest surface water needs the least',
    grams(headline('ballastChange')) < before, `${grams(headline('ballastChange'))} g`);

  q('[data-neutral][value="1"]').checked = true;
  q('[data-neutral][value="1"]').dispatchEvent(new window.Event('change', { bubbles: true }));
}

// ---- the tank reading is the measurement ----------------------------------

{
  /* The panel promises the mass box follows a tank reading, because the
     reading is the better measure. If it did not, an operator would enter
     their measurement and get an answer computed from a number they had
     already replaced. */
  const typed = Number(q('[data-hull="mass"]').value);
  type('[data-tank="measured"]', '-1500');
  const implied = Number(q('[data-hull="mass"]').value);
  check('a measured tank buoyancy rewrites the mass',
    Math.abs(implied - typed) > 0.1, `${typed} kg typed, ${implied} kg implied`);

  const heavier = grams(headline('ballastChange'));
  type('[data-tank="measured"]', '-1400');
  check('and a different reading gives a different answer',
    grams(headline('ballastChange')) !== heavier);

  check('and the box is read-only while it is derived, not silently ignored',
    q('[data-hull="mass"]').readOnly === true);

  type('[data-tank="measured"]', '');
  check('and clearing it goes back to the typed mass',
    Math.abs(Number(q('[data-hull="mass"]').value) - typed) < 1e-6,
    q('[data-hull="mass"]').value);
  check('and hands the box back', q('[data-hull="mass"]').readOnly === false);
}

// ---- can it fly ------------------------------------------------------------

{
  const surface = grams(q('[data-margin="surface"]').textContent);
  const dive = grams(q('[data-margin="dive"]').textContent);
  check('the two margins are reported', Number.isFinite(surface) && Number.isFinite(dive),
    `${surface} g up, ${dive} g down`);
  check('and this setup can do both', surface > 0 && dive < 0);

  /* A pump too small has to warn rather than hand back a ballast figure that
     flies nothing — the page's whole operational value is this check. */
  type('[data-hull="pumpRange"]', '5');
  const warned = [...document.querySelectorAll('[data-messages] .warn')].map((p) => p.textContent);
  check('a pump too small to surface or dive is a warning on the page',
    warned.some((w) => /cannot surface/.test(w)) && warned.some((w) => /cannot dive/.test(w)),
    warned.join(' | '));
  type('[data-hull="pumpRange"]', '250');
  check('and it clears when the pump is big enough again',
    document.querySelectorAll('[data-messages] .warn').length === 0);
}

// ---- the hull against the water -------------------------------------------

{
  const notes = () => [...document.querySelectorAll('[data-messages] .note')].map((p) => p.textContent);
  check('the page states which way the hull moves against the water',
    notes().some((n) => /per 100 dbar/.test(n)), notes().join(' | '));

  /* And it has to actually follow the number, not print a fixed sentence: a
     hull far softer than seawater goes the other way. */
  const stiff = notes().find((n) => /per 100 dbar/.test(n));
  type('[data-hull="compressibility"]', '0.00002');
  const soft = notes().find((n) => /per 100 dbar/.test(n));
  check('and it changes when the hull is made softer than seawater',
    /compresses less/.test(stiff ?? '') && /compresses more/.test(soft ?? ''),
    `${stiff} → ${soft}`);
  type('[data-hull="compressibility"]', '0.000001');
}

// ---- choosing a vehicle ----------------------------------------------------

{
  const massOf = () => Number(q('[data-hull="mass"]').value);
  pick('[data-vehicle]', 'seaexplorer');
  const seaexplorer = massOf();
  pick('[data-vehicle]', 'spray');
  check('picking a vehicle loads its numbers', massOf() !== seaexplorer,
    `${seaexplorer} kg then ${massOf()} kg`);
  check('and its volume comes with them',
    Math.abs(Number(q('[data-hull="volume"]').value) - (massOf() / 1025) * 1000) < 1e-3,
    q('[data-hull="volume"]').value);
  pick('[data-vehicle]', 'slocum');
}

// ---- remembering, and the link ---------------------------------------------

{
  type('[data-water="2.depth"]', '750');
  const stored = JSON.parse(window.localStorage.getItem('glider-ballast-inputs') ?? 'null');
  check('the setup is remembered', stored?.water?.[2]?.depth === 750, JSON.stringify(stored?.water));
  check('and the whole of it rides in the address bar',
    /^#b=/.test(window.location.hash) && decodeURIComponent(window.location.hash).includes('750'),
    window.location.hash.slice(0, 40));

  q('[data-action="reset"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  check('Reset puts the depth back', q('[data-water="2.depth"]').value === '1000');
  check('and forgets', window.localStorage.getItem('glider-ballast-inputs') === null);
}

// ---- the export ------------------------------------------------------------

{
  q('[data-action="copy"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const copied = q('[data-said] textarea')?.value ?? '';
  check('the ballast sheet copies with every point in it',
    /Ballast change/.test(copied) && /Surface buoyancy/.test(copied)
    && /Bottom inflection pump to neutral/.test(copied),
    `${copied.split('\n').length} lines`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
