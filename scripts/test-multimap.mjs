#!/usr/bin/env node
/**
 * Two maps on one page.
 *
 *   npm run test:multimap
 *
 * The map used to be a singleton — it found itself by id, read its status
 * line by id, and reached across the document for its controls. Making it
 * one-per-container was the change that lets it be reused; this is the check
 * that it actually worked, which until now was only an argument.
 *
 * Its own harness rather than a case inside test-map.mjs, and for a measured
 * reason: a second map animates too, and both sets of particles land in the
 * same recorded canvas, which skewed that file's per-frame displacement
 * statistics. The interference is in the instrument, not the product — but a
 * suite that has to be read around is worse than two suites.
 *
 * Deliberately bare fixtures. This asks whether two instances stay out of
 * each other's way, not whether either draws the ocean correctly; test-map.mjs
 * owns that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><body>' +
    /* One page-level storm line, outside both figures — this site's
       arrangement, and the thing two maps could end up fighting over. */
    '<div class="storm-status" data-storm-status><span class="label">STALE</span></div>' +
    '<figure class="map-figure" data-ocean-map>' +
    '<div id="first-map" data-ocean-map-canvas data-map-storage-key="first-view" ' +
    'data-map-home="[[7,-100],[45,-20]]"></div>' +
    '<figcaption><span class="status" data-map-status>one</span>' +
    '<span class="bathy-controls" data-bathy-controls hidden>' +
    '<input type="range" data-bathy-opacity min="10" max="100" step="5" /></span>' +
    '</figcaption></figure>' +
    '<figure class="map-figure" data-ocean-map>' +
    '<div id="second-map" data-ocean-map-canvas data-map-storage-key="second-view" ' +
    'data-map-home="[[50,-30],[60,-10]]"></div>' +
    '<figcaption><span class="status" data-map-status>two</span>' +
    '<span class="bathy-controls" data-bathy-controls hidden>' +
    '<input type="range" data-bathy-opacity min="10" max="100" step="5" /></span>' +
    '</figcaption></figure>' +
    '</body>',
  { pretendToBeVisual: true, url: 'http://localhost/' }
);
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser'])
  globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.sessionStorage = window.sessionStorage;
globalThis.localStorage = window.localStorage;
window.matchMedia ??= (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.scrollIntoView = function () {};
/* A no-op animation frame, deliberately: the particle loop never runs, which
   keeps this harness about instance isolation and off the frame budget.
   test-map.mjs is where the animation is measured. */
globalThis.requestAnimationFrame = window.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = window.devicePixelRatio = 1;
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy(
    { canvas: this, createImageData: () => ({ data: new Uint8ClampedArray(4) }), getImageData: () => ({ data: new Uint8ClampedArray(4) }), measureText: () => ({ width: 0 }) },
    { get: (t, k) => (k in t ? t[k] : () => {}) }
  );
};
// Both maps ask for a size; jsdom reports none, so give them one.
for (const p of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'])
  Object.defineProperty(window.HTMLElement.prototype, p, { get: () => 600, configurable: true });

/* Empty-but-well-shaped answers. Enough for a map to build; nothing to draw.
   The current grids need the u/v header fields — without them
   it dereferences a null component and takes the page down, which is a
   fixture problem rather than anything the maps are doing wrong. */
const grid = (extra = {}) => ({
  header: {
    nx: 4, ny: 3, lo1: 0, la1: 1, dx: 1, dy: 1,
    refTime: '2026-08-02T12:00:00Z', forecastTime: 0,
    source: 'test', units: 'degC', details: [], ...extra,
  },
  data: Array.from({ length: 12 }, () => 0),
});
const EMPTY_GRID = grid();
const UV = [
  grid({ parameterCategory: 2, parameterNumber: 2 }),
  grid({ parameterCategory: 2, parameterNumber: 3 }),
];
globalThis.fetch = async (u) => {
  const url = String(u);
  const json = url.includes('ocean-assets')
    ? { generated: '2026-08-02T12:00:00Z', storms: [], usvs: [], gliders: [] }
    : url.includes('argo')
      ? { floats: [] }
      : url.includes('coastline')
        ? { rings: [] }
        : url.includes('boundaries')
          ? { countries: [], states: [] }
          : url.includes('bathy')
            ? { type: 'FeatureCollection', features: [] }
            : url.includes('currents')
              ? UV
              : EMPTY_GRID;
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
};

const bundle = fs
  .readdirSync(path.join('dist', '_astro'))
  .find((f) => f.startsWith('AssetMap') && f.includes('script') && f.endsWith('.js'));
if (!bundle) {
  console.error('no AssetMap bundle in dist/_astro — run `npm run build` first');
  process.exit(1);
}
await import('./' + path.join('..', 'dist', '_astro', bundle));
await new Promise((r) => setTimeout(r, 2000));

const first = document.getElementById('first-map');
const second = document.getElementById('second-map');
const figureOf = (el) => el.closest('[data-ocean-map]');

let failures = 0;
const check = (what, ok) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
};

check('both containers get a map', !!first?._map && !!second?._map);
check('and they are different instances', first?._map !== second?._map);

/* Each opens on its own home. The two boxes do not overlap, so a map showing
   the other's bounds — the singleton failure — is unmistakable. */
const centre = (el) => el?._map?.getCenter?.();
const inBox = (c, s, w, n, e) => !!c && c.lat > s && c.lat < n && c.lng > w && c.lng < e;
check('the first opens on its own home', inBox(centre(first), 5, -102, 47, -18));
check('the second opens on its own', inBox(centre(second), 48, -32, 62, -8));

// Each keeps its own saved view rather than overwriting a shared key.
first._map.fire('moveend');
second._map.fire('moveend');
const savedFirst = window.sessionStorage.getItem('first-view');
const savedSecond = window.sessionStorage.getItem('second-view');
check('each writes its own saved view', !!savedFirst && !!savedSecond);
check('and the two views differ', savedFirst !== savedSecond);

/* Controls belong to the figure they sit in. Moving one map's isobath slider
   must not move the other's layer — the document-wide querySelector this
   replaced would have driven whichever slider came first in the page. */
const sliderIn = (el) => figureOf(el).querySelector('[data-bathy-opacity]');
const paneOpacity = (el) => el.querySelector('.leaflet-bathy-pane')?.style.opacity;
sliderIn(second).value = '30';
sliderIn(second).dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
check('a control drives its own map', Math.abs(Number(paneOpacity(second)) - 0.3) < 1e-6);
check('and leaves the other alone', Math.abs(Number(paneOpacity(first)) - 0.7) < 1e-6);

/* Exactly one map adopts a page-level storm line. Both adopting had them
   wiring the same zoom buttons and fighting over a click; neither adopting
   stopped the line updating at all.

   Asserted on *which* map holds it, not on how many boxes are marked — with a
   single box on the page the count is 1 either way, so a count cannot tell one
   claimant from two. It caught nothing until this was written the other way
   round: the marker names the claimant, and a second map taking the box too
   overwrites it with its own id. */
const box = document.querySelector('[data-storm-status]');
check('the page-level storm line is claimed', box.dataset.oceanMapClaimed !== undefined);
check('and only by the first map to ask', box.dataset.oceanMapClaimed === 'first-map');

console.log(
  failures ? `\n${failures} failing check(s) — the maps are not independent.` : '\nok    two maps coexist on one page'
);
process.exit(failures ? 1 : 0);
