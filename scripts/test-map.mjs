#!/usr/bin/env node
/**
 * Runs the built asset-map bundle against the real data in a headless DOM.
 *
 *   npm run build && node scripts/test-map.mjs
 *
 * Exists because the map is the one piece of the site with meaningful
 * client-side logic; this exercises it end to end (Leaflet, coastline,
 * storms, markers, controls) without needing a browser.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const dom = new JSDOM(
  '<!doctype html><body><div id="asset-map"></div><span id="map-status"></span></body>',
  { pretendToBeVisual: true, url: 'http://localhost/' }
);
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser'])
  globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.matchMedia ??= (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.scrollIntoView = function () {};
/* jsdom has no canvas backend, and the particle layer wants a 2d context
   the moment it starts. A no-op context lets it construct and run its setup
   for real — which is what catches plugin-loading regressions — while the
   drawing goes nowhere. Installing the native `canvas` package just to
   render particles nobody looks at is not worth the CI fragility. */
const noopContext = new Proxy(
  {},
  { get: (_, key) => (key === 'canvas' ? null : () => {}), set: () => true }
);
window.HTMLCanvasElement.prototype.getContext = () => noopContext;

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;

const box = { width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500, x: 0, y: 0 };
window.Element.prototype.getBoundingClientRect = () => box;
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 500, configurable: true });

const files = {
  coastline: JSON.parse(fs.readFileSync('public/map/coastline.json', 'utf8')),
  boundaries: JSON.parse(fs.readFileSync('public/map/boundaries.json', 'utf8')),
  'ocean-assets': JSON.parse(fs.readFileSync('public/map/ocean-assets.json', 'utf8')),
  currents: JSON.parse(fs.readFileSync('public/map/currents.json', 'utf8')),
};
globalThis.fetch = async (u) => {
  const key = Object.keys(files).find((k) => String(u).includes(k));
  if (!key) throw new Error('unexpected fetch: ' + u);
  return { json: async () => files[key] };
};

const assets = files['ocean-assets'];

/* Stand in for the StormStatus component: one hidden zoom button per storm,
   plus one naming a storm that is not in the data — that one must stay
   hidden. AssetMap reveals and wires the rest. */
const statusEl = document.getElementById('map-status');
for (const id of [...assets.storms.map((s) => s.id), 'zz992026']) {
  const b = document.createElement('button');
  b.dataset.stormZoom = id;
  b.hidden = true;
  statusEl.after(b);
}
const bundle = fs.readdirSync('dist/_astro').find((f) => f.startsWith('AssetMap') && f.endsWith('.js'));
if (!bundle) {
  console.error('no AssetMap bundle in dist/_astro — run `npm run build` first');
  process.exit(1);
}
await import('./' + path.join('..', 'dist', '_astro', bundle));
await new Promise((r) => setTimeout(r, 1500));

const host = document.getElementById('asset-map');

// Open a marker popup for real, then read what it rendered.
let popupHtml = '';
const marker = [...host.querySelectorAll('path')].find(
  (p) => p.getAttribute('fill') === '#f08c00' || p.getAttribute('fill') === '#e8368f'
);
if (marker) {
  marker.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  popupHtml = host.querySelector('.leaflet-popup-content')?.innerHTML ?? '';
}

/* Zoom buttons: the ones naming a real storm are revealed and wired, the
   unknown one stays hidden. Clicking must centre the map on that storm. */
const zoomButtons = [...document.querySelectorAll('[data-storm-zoom]')];
const known = zoomButtons.filter((b) => assets.storms.some((s) => s.id === b.dataset.stormZoom));
const unknown = zoomButtons.find((b) => b.dataset.stormZoom === 'zz992026');
let movedTo = null;
const target = assets.storms[0];
if (known[0] && target) {
  known[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const c = host._map?.getCenter?.() ?? null;
  movedTo = c && { lat: c.lat, lng: c.lng };
}
const near = (a, b) => a !== null && Math.abs(a) < b;

/* The animated current field. Reading the grid directly catches a pipeline
   that silently flips north for south — the particles would still animate,
   just with the Gulf Stream running the wrong way. */
const [cu, cv] = files.currents;
const ch = cu.header;
const currentAt = (lat, lon) => {
  const k = Math.round((ch.la1 - lat) / ch.dy) * ch.nx + Math.round((lon - ch.lo1) / ch.dx);
  return [cu.data[k], cv.data[k]];
};
const [gsU, gsV] = currentAt(35.5, -74.5);   // Gulf Stream off Hatteras
const [landU] = currentAt(32.5, -83.5);      // inland Georgia

/* Storm history is solid; the forecast is dashed. Distinguishing them by the
   dash attribute is what proves the observed track is actually drawn rather
   than the forecast being counted twice. */
const stormPaths = [...host.querySelectorAll('path[stroke="#d1495b"]')];
const solidStorm = stormPaths.filter((p) => !p.getAttribute('stroke-dasharray'));
const dashedStorm = stormPaths.filter((p) => p.getAttribute('stroke-dasharray'));
const withHistory = assets.storms.filter((s) => (s.history?.length ?? 0) > 1);

const status = document.getElementById('map-status').textContent;
const checks = [
  ['leaflet initialised', host.classList.contains('leaflet-container')],
  ['borders + markers drawn', host.querySelectorAll('path').length > 200],
  ['layer switcher', host.querySelectorAll('.leaflet-control-layers-selector').length >= 10],
  ['bathymetry is the default base', !!host.querySelector('.leaflet-tile-pane .leaflet-layer')],
  ['view toggle', host.querySelectorAll('.view-toggle a').length === 2],
  ['data pipeline completed', /assets reporting within/.test(status)],
  ['asset tracks drawn', host.querySelectorAll('path[stroke="#e8368f"], path[stroke="#f08c00"]').length >= assets.assets.length],
  ['glider colour is not the old teal', !host.querySelector('path[stroke="#0a7d8c"]')],
  ['popup shows deployment date', popupHtml.includes('Deployed')],
  ['popup links the dataset', /href="https?:[^"]*erddap[^"]*"/i.test(popupHtml)],
  // Theme-driven layers carry a class instead of a baked-in colour, so the
  // stylesheet can restyle them when the reader switches to dark mode.
  ['borders are theme-classed', host.querySelectorAll('path.map-border-country').length > 20],
  ['state lines are theme-classed', host.querySelectorAll('path.map-border-state').length > 20],
  ['track casings are theme-classed', host.querySelectorAll('path.map-casing').length > 0],
  ['asset markers are theme-classed', host.querySelectorAll('path.map-asset').length === assets.assets.length],
  ['no hardcoded border/casing colours left', !host.querySelector('path[stroke="#4a525c"], path[stroke="#6b7480"], path[stroke="#0d1218"], path[stroke="#8a949f"]')],
  // Zoom-to-storm buttons in the status line above the map.
  ['zoom buttons revealed for real storms', known.length > 0 && known.every((b) => !b.hidden)],
  ['zoom button hidden for an unknown storm', !!unknown && unknown.hidden],
  ['clicking a zoom button centres that storm',
    !!movedTo && near(movedTo.lat - target.lat, 1) && near(movedTo.lng - target.lon, 1)],
  /* leaflet-velocity is UMD and wants Leaflet on the global, which the
     bundled build does not set. Without the workaround the bundle throws
     "L is not defined" on load and no canvas is ever created. */
  ['animated current layer loaded', !!host.querySelector('.leaflet-currents-pane canvas')],
  ['currents grid is well formed',
    files.currents.length === 2 && cu.header.parameterNumber === 2 && cv.header.parameterNumber === 3 &&
    cu.data.length === ch.nx * ch.ny && cv.data.length === ch.nx * ch.ny],
  ['currents are not upside down (Gulf Stream runs NE, fast)',
    gsU > 0.1 && gsV > 0.4 && Math.hypot(gsU, gsV) > 0.6],
  ['currents mask land', landU === null],
  // One shared window drives storm history, glider tracks and USV tracks.
  ['history window is published once', typeof assets.historyDays === 'number' && !('activeWindowDays' in assets)],
  ['storms carry observed history', withHistory.length === assets.storms.length],
  ['observed storm track drawn solid, forecast dashed',
    solidStorm.length >= withHistory.length && dashedStorm.length > 0],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  ok &&= pass;
}
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
