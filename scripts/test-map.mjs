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
          // Generous: the zoom comparison below samples windows out of this,
          // and a 500-entry cap made every window after the first empty.
          if (drawn.segments.length < 400000) {
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
  'currents-atlantic': JSON.parse(fs.readFileSync('public/map/currents-atlantic.json', 'utf8')),
  'currents-arctic': JSON.parse(fs.readFileSync('public/map/currents-arctic.json', 'utf8')),
  argo: JSON.parse(fs.readFileSync('public/map/argo.json', 'utf8')),
};

/* The 1/12 degree tiles are ~92 MB and gitignored — CI builds them, nothing
   here has them. So the tier logic is exercised against a synthetic index
   and one synthetic tile: it is the choosing that can break, not the data.
   The index offers exactly one tile, over the seeded Atlantic view, so
   flying away from it must fall back. */
const TILE_KEY = '0_-60';
const NEIGHBOURS = ['0_-40', '20_-60', '20_-40'];
files['tiles/index'] = {
  size: 20, west: -180, south: -80, north: 85, minZoom: 7, deg: 0.08,
  modelRun: '2026-07-31T12:00:00Z',
  available: [TILE_KEY, ...NEIGHBOURS],
};
{
  // A real tile's spacing, so "finer than the region it beat" means something.
  const nx = 251;
  const ny = 251;
  const head = (n) => ({
    parameterCategory: 2, parameterNumber: n, nx, ny,
    lo1: 300, la1: 20, dx: 0.08, dy: 0.08, refTime: '2026-08-01T21:00:00Z',
  });
  const flat = (f) => Array.from({ length: nx * ny }, (_, i) => f(i));
  const corner = (key) => {
    const [s, w] = key.split('_').map(Number);
    return { lo1: ((w % 360) + 360) % 360, la1: s + 20 };
  };
  for (const key of [TILE_KEY, ...NEIGHBOURS]) {
    const { lo1, la1 } = corner(key);
    files[`tiles/${key}`] = [
      { header: { ...head(2), lo1, la1 }, data: flat(() => 0.4) },
      { header: { ...head(3), lo1, la1 }, data: flat(() => 0.3) },
    ];
  }
}
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
  /* Sat on the corner where four tiles meet, so the view spans all four and
     the join is exercised rather than a single tile being handed straight
     through. Still inside the Atlantic region, so the tier ordering is a
     real choice. */
  lat: 20.0,
  lng: -40.0,
  // Zoom 7: past the tiles' minimum, and narrow enough that the view sits
  // inside the single tile the synthetic index advertises.
  zoom: 7,
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
const tileHeader = files[`tiles/${TILE_KEY}`][0].header;

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

/* Continental interiors must have every surrounding cell null. leaflet-
   velocity multiplies nulls straight through as zero, so a single ocean
   corner anywhere near a land point gives it a real velocity and particles
   stream across the continent — which is exactly what happened over
   Greenland before the coastal erosion went in. */
const INLAND = [
  ['central Greenland', 72.0, -42.0],
  ['Svalbard interior', 78.5, 16.5],
  ['central Australia', -25.0, 133.0],
  ['Sahara', 23.0, 12.0],
  ['central Asia', 45.0, 85.0],
  ['Amazon basin', -5.0, -62.0],
  ['central Africa', 5.0, 22.0],
];
const inlandCorners = (lat, lon) => {
  const fi = Math.floor(((((lon - ch.lo1) % 360) + 360) % 360) / ch.dx);
  const fj = Math.floor((ch.la1 - lat) / ch.dy);
  const out = [];
  for (const j of [fj, fj + 1])
    for (const i of [fi, fi + 1]) {
      if (j < 0 || j >= ch.ny) continue;
      out.push(cu.data[j * ch.nx + (((i % ch.nx) + ch.nx) % ch.nx)]);
    }
  return out;
};
const dryInland = INLAND.filter(([, lat, lon]) => inlandCorners(lat, lon).every((x) => x === null));

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
const fineHeader = files['currents-atlantic'][0].header;
const arcticHeader = files['currents-arctic'][0].header;
const advertised = coarseHeader.details ?? [];
const arcticRegion = advertised.find((d) => d.url.includes('arctic'));

/* Particle animation. Segment lengths are the give-away: if the field were
   dead, or the velocity scale far too small, the particles would be stroked
   at zero length and nothing would appear on screen even though the draw
   calls all happened. */
const palette = JSON.parse(fs.readFileSync('src/data/map-palette.json', 'utf8'));
const sortedSegments = [...drawn.segments].sort((a, b) => a - b);
const medianSegment = sortedSegments.length ? sortedSegments[Math.floor(sortedSegments.length / 2)] : 0;
/* Every stroke on the canvas is either a particle or an Argo dot's outline
   — nothing else strokes there. Checking membership rather than "all of them
   are particle colours" keeps this precise now that the dots are outlined,
   while still catching a particle drawn in a colour the gate never saw. */
const allowedStrokes = new Set([...palette.currents, palette.features.argoEdge]);
const paletteUsed =
  [...drawn.styles].every((c) => allowedStrokes.has(c)) &&
  palette.currents.some((c) => drawn.styles.has(c));

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
const argoOutlined = drawn.styles.has(palette.features.argoEdge);
const spansHemispheres =
  fleet.some((f) => f.lat > 20) && fleet.some((f) => f.lat < -20);
const spansLongitudes =
  Math.max(...fleet.map((f) => f.lon)) - Math.min(...fleet.map((f) => f.lon)) > 300;

/* Drift has to be about the current, not the viewport. The check that came
   before this one sampled a single zoom, so it could not tell a field that
   holds still from one that accelerates as you zoom in — which is exactly
   what shipped: 0.08 px/frame at zoom 3 against 10.7 at zoom 9, particles
   crossing the map every second. Sample two zooms and compare. */
const p90 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : 0);
const driftAt = async (zoom) => {
  const from = drawn.segments.length;
  host._map.setZoom(zoom);
  // The layer rebuilds its interpolated field after a zoom, in slices, so
  // give it room before sampling.
  await new Promise((r) => setTimeout(r, 3000));
  const got = drawn.segments.slice(from);
  console.log(`   [z${zoom}] ${got.length} segments captured`);
  return p90(got);
};
const driftNear = await driftAt(8);
const driftFar = await driftAt(5);
const driftRatio =
  driftNear > 0 && driftFar > 0 ? Math.max(driftNear / driftFar, driftFar / driftNear) : Infinity;

/* Measuring. Two legs from a known start, checked against distances and
   bearings computed independently below — a transposed sin/cos in the
   bearing formula gives numbers that look perfectly reasonable. */
const measureButton = host.querySelector('.measure-control a');
const measureReadout = host.querySelector('.measure-readout');
const clickMap = (lat, lng) => host._map.fire('click', { latlng: window.L ? window.L.latLng(lat, lng) : { lat, lng } });

measureButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const measureArmed = measureButton?.getAttribute('aria-pressed') === 'true';
const beforeMeasure = host.querySelectorAll('path').length;
// Norfolk -> Bermuda -> Halifax, roughly.
for (const [lat, lng] of [[36.9, -76.3], [32.3, -64.8], [44.6, -63.6]]) clickMap(lat, lng);
await new Promise((r) => setTimeout(r, 200));
const measureText = measureReadout?.textContent ?? '';
const measureDrew = host.querySelectorAll('path').length > beforeMeasure;

// Independent great-circle maths, deliberately not the component's.
const toRad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const R = 6371008.8;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const legs = haversine([36.9, -76.3], [32.3, -64.8]) + haversine([32.3, -64.8], [44.6, -63.6]);
const shownKm = Number((measureText.match(/([\d.]+)\s*km/) || [])[1]);
const shownNm = Number((measureText.match(/([\d.]+)\s*nm/) || [])[1]);
const shownBearing = Number((measureText.match(/(\d+)°T/) || [])[1]);

// Independent initial great-circle bearing, Norfolk -> Halifax.
const bearing = (a, b) => {
  const [φ1, φ2, dλ] = [toRad(a[0]), toRad(b[0]), toRad(b[1] - a[1])];
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
const expectedBearing = bearing([36.9, -76.3], [44.6, -63.6]);

// Escape must put the map back the way it was.
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const measureCleared = (measureReadout?.textContent ?? '') === '' &&
  measureButton?.getAttribute('aria-pressed') === 'false';

/* The right-click readout. The depth lookup is stubbed; what matters here is
   that a popup opens with the position and the current already filled from
   the loaded grid, without waiting on the network. */
let identifyUrl = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...rest) => {
  if (String(u).includes('ImageServer/identify')) {
    identifyUrl = String(u);
    return { json: async () => ({ value: '-2431.5' }) };
  }
  return realFetch(u, ...rest);
};
host._map.fire('contextmenu', { latlng: window.L.latLng(36.5, -74.5) });
await new Promise((r) => setTimeout(r, 300));
const readoutHtml = host.querySelector('.point-readout .leaflet-popup-content')?.innerHTML ?? '';

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
  ['no flow over continental interiors',
    dryInland.length === INLAND.length],
  /* The other direction: erosion aggressive enough to kill the western
     boundary currents would be worse than the bleed it fixes. Both of these
     hug their coasts and were lost at the first threshold tried. */
  ['coastal erosion spared the Gulf Stream', Math.hypot(gsU, gsV) > 0.6],
  ['coastal erosion spared the Kuroshio', Math.hypot(kuU, kuV) > 0.5],
  /* Global coverage, and it has to close on itself: leaflet-velocity only
     wraps the grid across the antimeridian when it spans a full 360, and
     without that particles pile up at the edge instead of crossing. */
  ['currents grid spans the globe', Math.floor(ch.nx * ch.dx) >= 360],
  ['currents reach the far hemisphere (Kuroshio runs NE, fast)',
    kuU > 0.2 && kuV > 0.2 && Math.hypot(kuU, kuV) > 0.5],
  ['Antarctic Circumpolar runs eastward', accU !== null && accU > 0],
  // Two grids, picked by zoom.
  ['global grid advertises every detail region',
    advertised.length >= 2 && advertised.every((d) => typeof d.minZoom === 'number' && d.url && d.deg)],
  ['detail grids are genuinely finer', fineHeader.dx < coarseHeader.dx && arcticHeader.dy < coarseHeader.dy],
  /* High latitude spends its samples on latitude, not longitude: at 66N a
     0.48 deg cell is 22 km wide while 0.12 deg of latitude is 13 km, so
     latitude is what limits how close to a coastline the flow resolves. */
  ['arctic grid resolves latitude more finely than longitude',
    arcticHeader.dy < arcticHeader.dx && arcticHeader.dy < fineHeader.dy],
  /* A band, not a box — adding one region per complaint does not converge,
     as Greenland being fixed while the Bering Strait was not showed. */
  ['arctic grid is a band spanning every longitude',
    Math.floor(arcticHeader.nx * arcticHeader.dx) >= 360 &&
      arcticRegion.west <= -180 && arcticRegion.east >= 180],
  /* The map only uses a region when the whole viewport fits inside it, so
     regions that merely touch leave a strip where any straddling view drops
     back to the coarse grid. They have to overlap. */
  ['detail regions overlap in latitude, leaving no coarse strip',
    (() => {
      const atlantic = advertised.find((d) => d.url.includes('atlantic'));
      return arcticRegion.south < atlantic.north;
    })()],
  /* Three tiers, finest that fits. The seeded view is zoom 6 inside the one
     advertised tile, so the tile beats the Atlantic region beats the globe. */
  ['inside a tile, the tile is the one in use',
    !!gridInsideRegion && gridInsideRegion.dx === tileHeader.dx],
  ['the tile really is finer than the region it beat', tileHeader.dx < fineHeader.dx],
  ['tiles spanning the view are joined into one grid',
    !!gridInsideRegion && gridInsideRegion.nx > tileHeader.nx &&
      gridInsideRegion.ny > tileHeader.ny],
  ['flown off the tile and out of every region, it falls back to the globe',
    !!gridOutsideRegion && gridOutsideRegion.dx === coarseHeader.dx],
  ['the global grid says where the tiles live',
    typeof coarseHeader.tileIndex === 'string' && coarseHeader.tileIndex.includes('tiles')],
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
  ['argo dots are outlined, which is what separates them from the particles', argoOutlined],
  ['argo window matches every other asset',
    files.argo.historyDays === assets.historyDays],
  ['particles are actually stroked', drawn.stroke > 0 && drawn.moveTo > 100 && drawn.lineTo > 100],
  /* Guards against the sub-pixel regression, where the plugin's own zoom
     scaling left the median at 0.13 px and nothing appeared to move. Stated
     as a median so deliberately unhurried drift still passes. */
  ['particles move more than a sub-pixel each frame', medianSegment > 0.4],
  ['drift barely changes with zoom', driftRatio < 4],
  ['particles are drawn in the checked palette', drawn.styles.size > 0 && paletteUsed],
  // Measuring, and the point readout.
  ['measure button arms the tool', measureArmed],
  ['measuring draws a line', measureDrew],
  ['measured distance matches an independent great-circle sum',
    Number.isFinite(shownKm) && Math.abs(shownKm - legs / 1000) / (legs / 1000) < 0.02],
  ['distance is given in nautical miles too',
    Number.isFinite(shownNm) && Math.abs(shownNm - legs / 1852) / (legs / 1852) < 0.02],
  /* The value, not just the format: a transposed sin/cos still prints a
     plausible "123°T", and the format-only check this replaced sailed past
     exactly that mutation. */
  ['bearing matches an independent calculation',
    Number.isFinite(shownBearing) &&
      Math.abs(((shownBearing - expectedBearing + 540) % 360) - 180) < 2],
  ['escape clears the measurement', measureCleared],
  ['right-click opens a readout with the position',
    /36\.5000°N/.test(readoutHtml) && /74\.5000°W/.test(readoutHtml)],
  ['the readout carries the current from the loaded grid, with no request',
    /Surface current/.test(readoutHtml) && /m\/s toward/.test(readoutHtml)],
  ['the readout asks NOAA for the depth at that point',
    (() => {
      // The geometry is percent-encoded JSON, so decode before matching.
      if (!identifyUrl) return false;
      const geom = decodeURIComponent(identifyUrl);
      return geom.includes('"y":36.5') && geom.includes('"x":-74.5');
    })()],
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
  `drift vs zoom: p90 ${driftNear.toFixed(2)} px/frame at z8 vs ${driftFar.toFixed(2)} at z5 ` +
    `(ratio ${driftRatio.toFixed(1)}, want < 4)`
);
console.log(
  `grids: inside region dx ${gridInsideRegion?.dx} · outside dx ${gridOutsideRegion?.dx} ` +
    `(coarse ${coarseHeader.dx}, fine ${fineHeader.dx})`
);
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
