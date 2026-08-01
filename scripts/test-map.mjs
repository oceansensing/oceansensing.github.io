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
  '<!doctype html><body><div id="asset-map"></div><span id="map-status"></span>' +
    // Deliberately wrong server-rendered content: if the client does not
    // rebuild it, the assertions below will still see "STALE".
    '<div class="storm-status" data-storm-status><span class="label">STALE</span>' +
    '<ul><li><strong>STALE</strong><span class="facts">STALE</span></li></ul></div></body>',
  { pretendToBeVisual: true, url: 'http://localhost/' }
);
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser'])
  globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
// Browser globals the bundle uses bare; in jsdom they hang off window only.
globalThis.sessionStorage = window.sessionStorage;
globalThis.localStorage = window.localStorage;
window.matchMedia ??= (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.scrollIntoView = function () {};
/* jsdom has no canvas backend, so instead of rendering pixels the 2d context
   is recorded. That is the only way to prove the particles actually animate
   without pulling in the native `canvas` package: the draw calls tell you
   whether segments are being stroked, in which colours, and whether the
   particles are moving. Pixels would be nicer but not worth the CI fragility.

   requestAnimationFrame is stubbed below, so leaflet-velocity's loop really
   runs here — unlike a headless browser pane, which never paints. */
const drawn = { moveTo: 0, lineTo: 0, stroke: 0, styles: new Set(), segments: [] };
const properties = {};
let penX = 0;
let penY = 0;
const recordingContext = new Proxy(
  {},
  {
    get: (_, key) => {
      if (key === 'canvas') return null;
      if (key in properties) return properties[key];
      return (...args) => {
        if (key === 'moveTo') {
          drawn.moveTo += 1;
          [penX, penY] = args;
        } else if (key === 'lineTo') {
          drawn.lineTo += 1;
          if (drawn.segments.length < 500) {
            drawn.segments.push(Math.hypot(args[0] - penX, args[1] - penY));
          }
        } else if (key === 'stroke') {
          drawn.stroke += 1;
          if (typeof properties.strokeStyle === 'string') drawn.styles.add(properties.strokeStyle);
        }
      };
    },
    set: (_, key, value) => {
      properties[key] = value;
      return true;
    },
  }
);
window.HTMLCanvasElement.prototype.getContext = () => recordingContext;

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
/* Seed a saved view, as the hourly auto-reload leaves behind, and check the
   map comes back to it instead of resetting to the basin. Every overlay is
   listed so the rest of the checks still have their layers. */
const SEEDED_VIEW = {
  lat: 12.34,
  lng: -45.67,
  zoom: 6,
  base: 'Bathymetry (GEBCO)',
  overlays: [
    'Surface currents (animated)',
    'Current speed (Mercator)',
    'Hurricanes',
    'NOAA USVs',
    'IOOS gliders',
    'Country & state borders',
    'Lat/lon grid',
  ],
};
window.sessionStorage.setItem('asset-map-view', JSON.stringify(SEEDED_VIEW));

const bundle = fs.readdirSync('dist/_astro').find((f) => f.startsWith('AssetMap') && f.endsWith('.js'));
if (!bundle) {
  console.error('no AssetMap bundle in dist/_astro — run `npm run build` first');
  process.exit(1);
}
await import('./' + path.join('..', 'dist', '_astro', bundle));
await new Promise((r) => setTimeout(r, 1500));

const host = document.getElementById('asset-map');

// Read the restored view before anything below moves the map.
const restoredCentre = host._map?.getCenter?.() ?? null;
const restoredZoom = host._map?.getZoom?.() ?? null;
const restoredBase = !!host.querySelector('img[src*="gebco"], .leaflet-tile-pane img[src*="gebco"]');

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

/* The storm line is rendered at build time and then re-rendered here from
   the fetched data. Seeding it with markup that does NOT match the data is
   what proves the client actually rebuilt it rather than leaving the
   server's version in place. */
const stormBox = document.querySelector('[data-storm-status]');
const rebuiltNames = [...stormBox.querySelectorAll('li a, li strong')].map((e) => e.textContent);
const rebuiltFacts = [...stormBox.querySelectorAll('.facts')].map((e) => e.textContent);
const expectedNames = assets.storms.map((s) => s.name);

/* Particle animation. Segment lengths are the give-away: if the field were
   dead, or the velocity scale far too small, the particles would be stroked
   at zero length and nothing would appear on screen even though the draw
   calls all happened. */
const palette = JSON.parse(fs.readFileSync('src/data/map-palette.json', 'utf8'));
const sortedSegments = [...drawn.segments].sort((a, b) => a - b);
const medianSegment = sortedSegments.length ? sortedSegments[Math.floor(sortedSegments.length / 2)] : 0;
const paletteUsed = [...drawn.styles].every((c) => palette.currents.includes(c));

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
  /* The hourly auto-reload saves the reader's view first; without this the
     refresh would silently dump them back at the basin every time. */
  ['saved view is restored, not reset to the basin',
    !!restoredCentre &&
      Math.abs(restoredCentre.lat - SEEDED_VIEW.lat) < 0.5 &&
      Math.abs(restoredCentre.lng - SEEDED_VIEW.lng) < 0.5 &&
      restoredZoom === SEEDED_VIEW.zoom],
  ['saved basemap choice is restored', restoredBase],
  ['storm line rebuilt from fetched data',
    rebuiltNames.length === expectedNames.length &&
      expectedNames.every((n, i) => rebuiltNames[i] === n)],
  ['rebuilt storm line keeps its facts and zoom button',
    rebuiltFacts.length === expectedNames.length &&
      rebuiltFacts.every((f) => f && f.includes('·')) &&
      stormBox.querySelectorAll('button.zoom[data-storm-zoom]').length === expectedNames.length],
  ['particles are actually stroked', drawn.stroke > 0 && drawn.moveTo > 100 && drawn.lineTo > 100],
  /* Guards against the sub-pixel regression, where the plugin's own zoom
     scaling left the median at 0.13 px and nothing appeared to move. Stated
     as a median so deliberately unhurried drift still passes. */
  ['particles move more than a sub-pixel each frame', medianSegment > 0.4],
  ['particles are drawn in the checked palette', drawn.styles.size > 0 && paletteUsed],
  ['view is written back for the next reload',
    (() => {
      const saved = JSON.parse(window.sessionStorage.getItem('asset-map-view') ?? 'null');
      return !!saved && typeof saved.zoom === 'number' && Array.isArray(saved.overlays);
    })()],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  ok &&= pass;
}
const lens = [...drawn.segments].sort((a, b) => a - b);
const at = (q) => (lens.length ? lens[Math.floor(lens.length * q)].toFixed(2) : 'n/a');
console.log(
  `particles: ${drawn.stroke} strokes, ${drawn.lineTo} segments — ` +
    `px/frame p10 ${at(0.1)} median ${at(0.5)} p90 ${at(0.9)} max ${at(0.999)}`
);
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
