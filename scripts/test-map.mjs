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
const drawn = { moveTo: 0, lineTo: 0, stroke: 0, arc: 0, styles: new Set(), fills: new Set(), segments: [] };
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
        } else if (key === 'arc') {
          drawn.arc += 1;
        } else if (key === 'fill') {
          if (typeof properties.fillStyle === 'string') drawn.fills.add(properties.fillStyle);
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
  'currents-detail': JSON.parse(fs.readFileSync('public/map/currents-detail.json', 'utf8')),
  argo: JSON.parse(fs.readFileSync('public/map/argo.json', 'utf8')),
};
globalThis.fetch = async (u) => {
  // Longest key first: "currents" is a substring of "currents-detail", so
  // insertion order would hand the detail request the coarse grid.
  const key = Object.keys(files)
    .sort((a, b) => b.length - a.length)
    .find((k) => String(u).includes(k));
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
  // Deliberately NOT the default basemap — restoring the default would
  // prove nothing.
  base: 'Bathymetry (Esri Ocean)',
  overlays: [
    'Surface currents (animated)',
    'Current speed (Mercator)',
    'Hurricanes',
    'NOAA USVs',
    'IOOS gliders',
    'Country & state borders',
    'Lat/lon grid',
  ],
  /* No `known` list, exactly as every view saved before that field existed.
     Argo is missing from `overlays` for the same reason — it did not exist
     either — and must therefore keep its default rather than be treated as
     a layer the reader turned off. */
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

const velocityLayer = (() => {
  let found = null;
  host._map?.eachLayer?.((l) => {
    if (l._windy) found = l;
  });
  return found;
})();
const gridOf = () => velocityLayer?.options?.data?.[0]?.header ?? null;

/* The seeded view sits at zoom 6 inside the Atlantic detail region, so by
   now the fine grid should have been lazily fetched and swapped in. */
const gridInsideRegion = gridOf();

// Read the restored view before anything below moves the map.
const restoredCentre = host._map?.getCenter?.() ?? null;
const restoredZoom = host._map?.getZoom?.() ?? null;
const restoredBase = !!host.querySelector('.leaflet-tile-pane img[src*="arcgisonline"]');

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
/* Longitude wraps, so index it the way leaflet-velocity does — a floored
   modulo. The grid now starts at 0 degrees east and a plain subtraction
   sends anything in the western hemisphere to a negative index. */
const currentAt = (lat, lon) => {
  const i = Math.round(((((lon - ch.lo1) % 360) + 360) % 360) / ch.dx) % ch.nx;
  const j = Math.round((ch.la1 - lat) / ch.dy);
  if (j < 0 || j >= ch.ny) return [null, null];
  const k = j * ch.nx + i;
  return [cu.data[k], cv.data[k]];
};
const [gsU, gsV] = currentAt(35.5, -74.5);      // Gulf Stream off Hatteras
const [kuU, kuV] = currentAt(35.0, 141.0);      // Kuroshio, the far side of the world
const [accU] = currentAt(-55.0, -150.0);        // Antarctic Circumpolar, due east
const [landU] = currentAt(-25.0, 133.0);        // central Australia

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

/* The zoom button above flew the map to the storm, which this season is in
   the eastern Pacific — outside the detail region. So the layer should have
   fallen back to the coarse grid, which tests the swap the other way. */
const gridOutsideRegion = gridOf();
const coarseHeader = files.currents[0].header;
const fineHeader = files['currents-detail'][0].header;

/* Particle animation. Segment lengths are the give-away: if the field were
   dead, or the velocity scale far too small, the particles would be stroked
   at zero length and nothing would appear on screen even though the draw
   calls all happened. */
const palette = JSON.parse(fs.readFileSync('src/data/map-palette.json', 'utf8'));
const sortedSegments = [...drawn.segments].sort((a, b) => a - b);
const medianSegment = sortedSegments.length ? sortedSegments[Math.floor(sortedSegments.length / 2)] : 0;
const paletteUsed = [...drawn.styles].every((c) => palette.currents.includes(c));

/* Argo: two thousand dots on a canvas rather than SVG, so they leave no DOM
   to inspect. Arcs are the tell — the particle layer only ever strokes
   lines, so every arc came from Leaflet's canvas renderer. */
const fleet = files.argo.floats ?? [];
/* Leaflet's canvas renderer culls to the viewport, so the arc count is
   whatever is on screen — a handful here, not the whole fleet. What proves
   the fleet arrived is that every float became a marker on the map; what
   proves the canvas ran is that any arcs were drawn at all. */
let argoMarkers = 0;
host._map?.eachLayer?.((l) => {
  if (l.options?.fillColor === palette.features.argo) argoMarkers += 1;
});
const argoDrawn = drawn.arc;
const argoColoured = drawn.fills.has(palette.features.argo);
const spansHemispheres =
  fleet.some((f) => f.lat > 20) && fleet.some((f) => f.lat < -20);
const spansLongitudes =
  Math.max(...fleet.map((f) => f.lon)) - Math.min(...fleet.map((f) => f.lon)) > 300;

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
  /* Global coverage, and it has to close on itself: leaflet-velocity only
     wraps the grid across the antimeridian when it spans a full 360, and
     without that particles pile up at the edge instead of crossing. */
  ['currents grid spans the globe', Math.floor(ch.nx * ch.dx) >= 360],
  ['currents reach the far hemisphere (Kuroshio runs NE, fast)',
    kuU > 0.2 && kuV > 0.2 && Math.hypot(kuU, kuV) > 0.5],
  ['Antarctic Circumpolar runs eastward', accU !== null && accU > 0],
  // Two grids, picked by zoom.
  ['global grid advertises the detail grid',
    !!coarseHeader.detail && typeof coarseHeader.detail.minZoom === 'number' &&
      coarseHeader.detail.url.includes('currents-detail')],
  ['detail grid is genuinely finer', fineHeader.dx < coarseHeader.dx],
  ['detail grid covers the region it advertises',
    Math.abs(fineHeader.lo1 - (coarseHeader.detail.west + 360)) < fineHeader.dx &&
      fineHeader.la1 >= coarseHeader.detail.north - fineHeader.dy - 0.5],
  ['inside the region, the fine grid is the one in use',
    !!gridInsideRegion && gridInsideRegion.dx === fineHeader.dx],
  ['panned outside it, the layer falls back to the global grid',
    !!gridOutsideRegion && gridOutsideRegion.dx === coarseHeader.dx],
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
  ['saved basemap choice is restored over the default', restoredBase],
  /* Dark mode dims only light basemaps, so the tone published on the
     container has to follow the basemap actually showing. Restoring a saved
     basemap goes through map.addLayer, which fires no baselayerchange — the
     tone went stale there until it was set by hand. */
  ['basemap tone follows the basemap actually showing',
    host.dataset.basemapTone === 'light'],
  ['GEBCO is listed first in the basemap switcher',
    [...host.querySelectorAll('.leaflet-control-layers-base label')][0]
      ?.textContent.trim() === 'Bathymetry (GEBCO)'],
  ['storm line rebuilt from fetched data',
    rebuiltNames.length === expectedNames.length &&
      expectedNames.every((n, i) => rebuiltNames[i] === n)],
  ['rebuilt storm line keeps its facts and zoom button',
    rebuiltFacts.length === expectedNames.length &&
      rebuiltFacts.every((f) => f && f.includes('·')) &&
      stormBox.querySelectorAll('button.zoom[data-storm-zoom]').length === expectedNames.length],
  ['argo fleet is loaded', fleet.length > 500],
  ['argo coverage is global', spansHemispheres && spansLongitudes],
  ['every float became a marker', argoMarkers === fleet.length && fleet.length > 500],
  ['argo dots reach the canvas', argoDrawn > 0],
  ['argo dots use the gated colour', argoColoured],
  ['argo window matches every other asset',
    files.argo.historyDays === assets.historyDays],
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
console.log(
  `grids: inside region dx ${gridInsideRegion?.dx} · outside dx ${gridOutsideRegion?.dx} ` +
    `(coarse ${coarseHeader.dx}, fine ${fineHeader.dx})`
);
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
