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
  /* Mirrors the component's own markup, figure and all. The wrapper is not
     decoration: the map scopes its legend, controls and status line to the
     nearest [data-ocean-map] rather than to the document, which is what lets
     two maps share a page. A flat list of siblings would still pass by
     falling back to the parent element, and would not test the scoping. */
  '<!doctype html><body>' +
  // Rendered before the figure on the real page, so deliberately outside it.
  '<div class="storm-status" data-storm-status><span class="label">STALE</span>' +
  '<ul><li><strong>STALE</strong><span class="facts">STALE</span></li></ul></div>' +
  '<figure class="map-figure" data-ocean-map>' +
  '<div id="asset-map" data-ocean-map-canvas data-map-storage-key="asset-map-view"></div>' +
  '<figcaption>' +
  '<span class="key sst" data-sst-key hidden></span>' +
  // Seeded with the wrong field on purpose: the module has to name whichever
  // particle field is on, so a key that merely happens to say "current"
  // because the markup did would prove nothing.
  '<span class="key current" data-flow-key>STALE</span>' +
  '<span class="field-controls" data-field-controls hidden>' +
  '<select data-field-map></select><input type="number" data-field-min />' +
  '<input type="number" data-field-max /><button type="button" data-field-auto></button></span>' +
  '<span class="forecast-controls" data-forecast-controls hidden></span>' +
  '<span class="bathy-controls" data-bathy-controls hidden>' +
  '<input type="range" data-bathy-opacity min="10" max="100" step="5" /></span>' +
  '<span class="om-kmz-controls" data-kmz-controls><input type="file" data-kmz-file />' +
  '<span data-kmz-list hidden></span></span>' +
  '<span data-kmz-note></span>' +
  '<span class="status" id="map-status" data-map-status></span>' +
  '</figcaption></figure>' +
    // The storm-status block above carries deliberately wrong server-rendered
    // content: if the client does not rebuild it, the assertions below will
    // still see "STALE".
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
const drawn = { moveTo: 0, lineTo: 0, stroke: 0, arc: 0, styles: new Set(), fills: new Set(), segments: [], images: [] };
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
        /* The raster layers go through ImageData rather than path calls, so
           the recorder has to return a real buffer — and keeping the buffer
           afterwards is what lets the checks below read the pixels that were
           actually painted, rather than trusting that a draw happened. */
        if (key === 'createImageData') {
          const [w, h] = args;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        if (key === 'putImageData') {
          drawn.images.push(args[0]);
          return undefined;
        }
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
  coastline: JSON.parse(fs.readFileSync('scripts/fixtures/map/coastline.json', 'utf8')),
  boundaries: JSON.parse(fs.readFileSync('scripts/fixtures/map/boundaries.json', 'utf8')),
  'ocean-assets': JSON.parse(fs.readFileSync('scripts/fixtures/map/ocean-assets.json', 'utf8')),
  currents: JSON.parse(fs.readFileSync('scripts/fixtures/map/currents.json', 'utf8')),
  'currents-atlantic': JSON.parse(fs.readFileSync('scripts/fixtures/map/currents-atlantic.json', 'utf8')),
  'currents-arctic': JSON.parse(fs.readFileSync('scripts/fixtures/map/currents-arctic.json', 'utf8')),
  'currents-60m': JSON.parse(fs.readFileSync('scripts/fixtures/map/currents-60m.json', 'utf8')),
  'currents-atlantic-60m': JSON.parse(fs.readFileSync('scripts/fixtures/map/currents-atlantic-60m.json', 'utf8')),
  'currents-arctic-60m': JSON.parse(fs.readFileSync('scripts/fixtures/map/currents-arctic-60m.json', 'utf8')),
  argo: JSON.parse(fs.readFileSync('scripts/fixtures/map/argo.json', 'utf8')),
  'sss-navy': JSON.parse(fs.readFileSync('scripts/fixtures/map/sss-navy.json', 'utf8')),
  'sst-oisst': JSON.parse(fs.readFileSync('scripts/fixtures/map/sst-oisst.json', 'utf8')),
  'sst-oisst-atlantic': JSON.parse(fs.readFileSync('scripts/fixtures/map/sst-oisst-atlantic.json', 'utf8')),
  'sst-oisst-arctic': JSON.parse(fs.readFileSync('scripts/fixtures/map/sst-oisst-arctic.json', 'utf8')),
};

/* A stand-in wind field, synthetic on purpose and with a value no current
   fixture has. 12 m/s blowing due east everywhere: a real ECMWF grid would
   agree with the currents in direction often enough that the readout naming
   one field while sampling the other could pass, and a constant makes the
   two things this layer can get wrong arithmetic rather than eyeballed —
   the **speed calibration**, which must not be 27x the currents', and the
   **convention**, where a wind blowing east is reported as coming FROM 270,
   not toward 90. */
{
  const nx = 360, ny = 181;
  const head = (category, number) => ({
    parameterCategory: category, parameterNumber: number, parameterUnit: 'm.s-1',
    nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1,
    refTime: '2026-08-03T21:00:00Z', modelRun: '2026-08-03T12:00:00Z',
    source: 'ECMWF IFS', height: 10, lead: 9, details: [],
  });
  files.wind = [
    { header: head(2, 2), data: Array.from({ length: nx * ny }, () => 12) },
    { header: head(2, 3), data: Array.from({ length: nx * ny }, () => 0) },
  ];
}

/* ---- forecast frames -------------------------------------------------

   Synthetic, and per product on purpose. The bug this guards against is a
   layer stepping to another hour and fetching *someone else's* frame: the
   first version handed every layer the same frame object, so one click had
   the 60 m field, the temperature and the salinity all fetch the surface
   current grid. Nothing about that is visible on screen — a vector file
   read as a scalar simply draws nothing, and 60 m drawing surface water
   looks like a current.

   So each frame here carries a value unique to its product *and* its lead,
   and the checks below assert who asked for what. The real files are
   gitignored, hence stubs rather than reads. */
const FRAME_LEADS = [0, 12, 24];
/* Stamped relative to the moment the suite runs, because that is what
   production looks like: the build is minutes old, so lead 0 really is the
   hour nearest the reader's clock and everything downstream — tiles,
   particles, readouts — sees the state the map opens in.

   A fixed stamp was tried and is worse than it looks. Pinned to
   2026-08-03 06:00Z it drifts into the past as the day goes on, so "nearest
   to now" wanders onto lead 12, the step-back landed on a frame with no
   tiles, and five unrelated checks failed for a reason nothing in their
   own text hinted at. */
const frameStamp = (lead) => {
  const at = new Date(Date.now() + lead * 3600e3);
  at.setUTCMinutes(0, 0, 0);
  return at.toISOString().replace('.000', '');
};

const frameList = (stem) =>
  FRAME_LEADS.map((lead) => ({
    lead,
    valid: frameStamp(lead),
    url: `/map/${lead ? `${stem}-f${lead}h` : stem}.json`,
  }));

/* Lead 0 is the file already in `files`; the rest are stubs of it with the
   lead written through, so a frame that came from the wrong product or the
   wrong hour is detectable rather than merely plausible. */
for (const stem of ['currents', 'currents-60m']) {
  files[stem][0].header.forecast = frameList(stem);
  files[stem][0].header.lead = 0;
  for (const lead of FRAME_LEADS.slice(1)) {
    files[`${stem}-f${lead}h`] = files[stem].map((part) => ({
      header: {
        ...part.header, lead, refTime: frameStamp(lead),
        tileIndex: undefined, forecast: undefined,
        details: (part.header.details ?? []).map((d) => ({
          ...d, url: d.url.replace(/\.json$/, `-f${lead}h.json`),
        })),
      },
      data: part.data,
    }));
    for (const region of ['currents-atlantic', 'currents-arctic']) {
      const base = stem === 'currents-60m' ? `${region}-60m` : region;
      files[`${base}-f${lead}h`] = files[base];
    }
  }
}
for (const stem of ['sss-navy']) {
  files[stem].header.forecast = frameList(stem);
  files[stem].header.lead = 0;
  for (const lead of FRAME_LEADS.slice(1)) {
    files[`${stem}-f${lead}h`] = {
      header: {
        ...files[stem].header, lead, refTime: frameStamp(lead),
        tileIndex: undefined, forecast: undefined, details: [],
      },
      data: files[stem].data,
    };
  }
}

/* The 1/12 degree tiles are ~92 MB and gitignored — CI builds them, nothing
   here has them. So the tier logic is exercised against a synthetic index
   and one synthetic tile: it is the choosing that can break, not the data.
   The index offers exactly one tile, over the seeded Atlantic view, so
   flying away from it must fall back. */
const TILE_KEY = '0_-60';
const NEIGHBOURS = ['0_-40', '20_-60', '20_-40'];
files['tiles/index'] = {
  size: 20, west: -180, south: -80, north: 85, minZoom: 4, deg: 0.08,
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
      { header: { ...head(2), lo1, la1, depth: 0 }, data: flat(() => 0.4) },
      { header: { ...head(3), lo1, la1, depth: 0 }, data: flat(() => 0.3) },
    ];
    /* The 60 m tiles carry a deliberately different velocity. It is the only
       way to tell whether the readout sampled the layer the reader has on or
       just whichever grid loaded last. */
    files[`tiles-60m/${key}`] = [
      { header: { ...head(2), lo1, la1, depth: 60 }, data: flat(() => 0.1) },
      { header: { ...head(3), lo1, la1, depth: 60 }, data: flat(() => 0.0) },
    ];
  }
}
files['tiles-60m/index'] = { ...files['tiles/index'], depth: 60 };

/* Native-resolution SST tiles. Without a fixture for this index the fetch
   threw, the catch swallowed it and the layer quietly used the regional grid
   — so the whole tile tier went untested while looking fine. The tile is a
   constant, distinct from every other field, so "which tier is showing" is
   answerable from the value alone. */
{
  const nx = 251;
  const ny = 251;
  files['tiles-sst-navy/index'] = {
    size: 20, west: -180, south: -80, north: 85, minZoom: 4, deg: 0.08,
    refTime: '2026-08-02T12:00:00Z',
    available: [TILE_KEY, ...NEIGHBOURS],
  };
  const corner = (key) => {
    const [sy, wx] = key.split('_').map(Number);
    return { lo1: ((wx % 360) + 360) % 360, la1: sy + 20 };
  };
  for (const key of [TILE_KEY, ...NEIGHBOURS]) {
    const { lo1, la1 } = corner(key);
    files[`tiles-sst-navy/${key}`] = {
      header: {
        nx, ny, lo1, la1, dx: 0.08, dy: 0.08,
        refTime: '2026-08-02T12:00:00Z', source: 'US Navy ESPC-D-V02', units: 'degC',
      },
      data: Array.from({ length: nx * ny }, () => 21.5),
    };
  }
}

/* A stand-in Navy SST field, kept synthetic on purpose even though the real
   one now builds: a constant differs from OISST everywhere, so the readout
   naming one field while sampling the other cannot pass. Real data would
   agree with OISST to about a degree — the two were measured within 1 C at
   five separated points — which is exactly what makes it a poor discriminator
   for this check. */
{
  const nx = 360;
  const ny = 166;
  files['sst-navy'] = {
    header: {
      nx, ny, lo1: 0.125, la1: 85.125, dx: 1, dy: 1,
      /* Same run **and same hour** as the currents fixture, because in
         production it is: both come from one aggregation at one step. The
         credit a layer contributes is its source, its valid time and its
         run, so a stub disagreeing on any of the three splits the line for a
         reason production does not have and the shared-source check has
         nothing left to catch. The hour was 08-01 12Z here — the run time,
         picked arbitrarily — until the valid time went into the credit. */
      refTime: '2026-08-03T15:00:00Z', source: 'US Navy ESPC-D-V02', units: 'degC',
      modelRun: '2026-08-01T12:00:00Z',
      details: [], tileIndex: '/map/tiles-sst-navy/index.json',
    },
    data: Array.from({ length: nx * ny }, () => 7.5),
  };
}
/* Isobaths. Both tiers are stubbed at *disjoint latitudes*, which is what
   makes the coarse/fine swap testable from the outside: the global file
   draws only at 22-24 N and a tile only at 25-27 N, so which tier is on the
   map can be read off the geometry rather than off an internal handle. A
   tier reading the wrong file lands in the wrong place rather than merely
   "something got drawn" — the bug the 60 m current layer shipped with when
   its tile path was hardcoded. */
const bathyFetched = [];
/* The offline basemap weighs 4.2 MB — eleven times what it did when it
   loaded with the page. It must cost nothing at all until someone selects
   it, which is the only reason it can be published at a resolution worth
   having. */
const coastlineFetched = [];
/* Every fetch, in order. The forecast checks below need to know which layer
   asked for which frame, and that is only answerable from the whole log. */
const fetched = [];
const ring = (lon, lat) => [
  [lon, lat], [lon + 2, lat], [lon + 2, lat + 2], [lon, lat + 2], [lon, lat],
];
const contour = (d, lon, lat) => ({
  type: 'Feature',
  properties: { d },
  geometry: { type: 'LineString', coordinates: ring(lon, lat) },
});
const bathyDeepGeo = {
  type: 'FeatureCollection',
  features: [
    contour(200, -78, 22), contour(4000, -70, 22),
    /* Either side of the antimeridian in the file's own coordinates. A view
       centred on the date line has to show both at once, which a single
       shared shift cannot do: whichever way it moves, one of these two ends
       up a world away. They have to be homed independently. */
    contour(1000, -179, 10),
    contour(1000, 175, 10),
  ],
};
// A tile carries every level, deep ones included — that is the whole point
// of the change, and why the global set has to stand down when one is up.
const bathyTileGeo = {
  type: 'FeatureCollection',
  features: [contour(20, -76, 25), contour(100, -74, 25), contour(4000, -72, 25)],
};
const bathyIndex = {
  size: 20, west: -180, south: -80, north: 85, minZoom: 6,
  levels: [20, 40, 60, 80, 100, 200, 400, 600, 800, 1000, 2000, 4000, 6000, 8000, 10000],
  available: ['20_-80', '20_-100', '0_-80', '0_-100', '40_-80', '40_-100'],
};

/* The bathymetry service, stubbed from the start rather than partway
   through: asset popups now ask for depth too, and the first of those fires
   long before the readout checks below install their own stub. */
let identifyUrl = null;
let gazetteerUrl = null;
globalThis.fetch = async (u) => {
  fetched.push(String(u));
  if (String(u).includes('coastline.json')) coastlineFetched.push(String(u));
  if (String(u).includes('/map/bathy')) {
    bathyFetched.push(String(u));
    if (String(u).includes('bathy-deep')) return { json: async () => bathyDeepGeo };
    if (String(u).includes('index.json')) return { json: async () => bathyIndex };
    return { json: async () => bathyTileGeo };
  }
  if (String(u).includes('ImageServer/identify')) {
    identifyUrl = String(u);
    return { json: async () => ({ value: '-2431.5' }) };
  }
  /* Marine Regions. The high-seas answer is a 404 with an empty list, so the
     stub reproduces that shape rather than a happy path only — treating it
     as an error is the mistake worth guarding against, and most of this
     fleet works outside anyone's EEZ. */
  if (String(u).includes('getGazetteerRecordsByLatLong')) {
    gazetteerUrl = String(u);
    const highSeas = /\/30\.0000\//.test(String(u));
    return {
      status: highSeas ? 404 : 200,
      json: async () =>
        highSeas ? [] : [{ preferredGazetteerName: 'United States Exclusive Economic Zone' }],
    };
  }
  // Longest key first: "currents" is a substring of "currents-detail", so
  // insertion order would hand the detail request the coarse grid.
  const key = Object.keys(files)
    .sort((a, b) => b.length - a.length)
    .find((k) => String(u).includes(k));
  if (!key) throw new Error('unexpected fetch: ' + u);
  return { json: async () => files[key] };
};

const assets = files['ocean-assets'];
// Read here rather than beside the particle checks: the hit-target and
// Argo checks above them need it too.
const palette = JSON.parse(fs.readFileSync('packages/ocean-map/data/map-palette.json', 'utf8'));

/* Stand in for the StormStatus component: one hidden zoom button per storm,
   plus one naming a storm that is not in the data — that one must stay
   hidden. AssetMap reveals and wires the rest.

   Inside [data-storm-status], because that is where StormStatus.astro puts
   them and where the map looks. They used to be dropped next to the map's
   status line, which passed only while the map scanned the whole document
   for them. */
const seedBox = document.querySelector('[data-storm-status]');
for (const id of [...assets.storms.map((s) => s.id), 'zz992026']) {
  const b = document.createElement('button');
  b.dataset.stormZoom = id;
  b.hidden = true;
  seedBox.append(b);
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
    'Currents at 0m (ESPC)',
    'Current speed (Mercator)',
    'Hurricanes',
    'NOAA USVs',
    'Ocean gliders',
    'Country & state borders',
    'Lat/lon grid',
  ],
  /* No `known` list, exactly as every view saved before that field existed.
     Argo is missing from `overlays` for the same reason — it did not exist
     either — and must therefore keep its default rather than be treated as
     a layer the reader turned off. */
};
window.sessionStorage.setItem('asset-map-view', JSON.stringify(SEEDED_VIEW));

const KMZ_FIXTURE =
  'UEsDBBQAAAAIAJqtAl2FC8lSbgIAACMGAAAHAAAAZG9jLmttbI1U204bMRB9z1dYW4knss6lJLQ4RqQIVAnaqMAHuMnsrhWvHXkdwv59x95LLiTQSLHH9pyZ4zOzZtdvuSKvYAtp9CTqx72IgJ6bhdTpJHp5vuteRte8w5bohZ66mESZc6vvlG42m9isQKeyiDU4ih50EA8izm7NfJ2DdgjTIgf+tLavUJKVEprRsNNhT65UQORiEilIEfMgNYQ9zuZGGcuTpIe/JGG0WrONXLiMDxmtDEa3kA4hbGZUuRdgnHh4r9cGSKRSvM9omJlZO4UBOJ43JqM7QWgdumL6KFYNWTSR70xIDLmEkmtjc6EY9TYrvPOLVfwLejLaLjG0BwSiLTKTaabw796BjcvAvofXpJAB8rozagG4FwR9gLRotPU5lJhDLuxye0z69TlbQDG3cuWw4PxMuau/Z6m7+vF8620aFsTLEY4s9ev+gBROeAAm2YVjLsy2d2kkt0O8cqgqZbGlfHGMxeYSDgreHV/EF+fDEQ490h1/jXvnwzEOfjHwJ2N/4gu4xTR1r6LR7U2P3fupYk1umrvPjMS+PEniMFXtvpuF0Vr4gwrcWBAflWBq3hoSJ5vEt1/ayoptCXZq1nohbPmzqL4RYf8ckXGE/L2A7XRJwmY9jY5J2ESih3mq7FLr/83e6BdKuG+Og3lxYKLDh4wOc3s9aSPOZzWf4sfTKP24Vk7eg8nB2bK+2NEWwMZ7R6ly/KyDPZJ0R99OqNw26j6VUy31C9zG2CUil0FxHDMLCfdvboGPLryJfKUgNjalSr5CjK8uo8El5EN/uhujw+6t1/E3vvBKlLVE80xY12hE9z2QTft+M/+o839QSwMEFAAAAAgAmq0CXVrM13MNAAAAMAAAAA4AAABmaWxlcy9pY29uLnBuZ+sM8HPn5ZLiYiASAABQSwECFAMUAAAACACarQJdhQvJUm4CAAAjBgAABwAAAAAAAAAAAAAAgAEAAAAAZG9jLmttbFBLAQIUAxQAAAAIAJqtAl1azNdzDQAAADAAAAAOAAAAAAAAAAAAAACAAZMCAABmaWxlcy9pY29uLnBuZ1BLBQYAAAAAAgACAHEAAADMAgAAAAA=';

const OVERLAY_FIXTURE =
  'UEsDBBQAAAAIAMCxAl2+9dEdbwEAAHwDAAAHAAAAZG9jLmttbK2TzW7CMAzH7zxF1fOo+RgDTSZI27RpEhJoGw+QtaZUtDFKAoW3XxrKCmgHDsvJtv6y/XNsnOyLPNiRNhmrcdiNOmFAKuYkU+k4XHy9tkfhRLRw7VROqcw4XFm7eQQoyzLiDak0M5EiC04BvagXCnzheFuQsgKVLEg8r6S2BsE7LXzTvFXJzJXM5aGWfG71jg5BXClrIcacsxbfvaV/CEcfEy3LmU5Iix5C47SCAN9jVgJXmpZimeVkwOeLNipF8FEEL6m0U2mnrJ547zpgbVeiP3KFvYWGt1XgAeFoIUljRXt4j+AtLMn7TuAtl89l1GyldUMU/Q7Cr4NwVgku2f+exUI5ntMQGsDu/9IOr2kH17T9K9pBTXtO1LoN6YMKtnTagMveq20ybp1oL4tNThHrFKzjuRGke8XRucToXkB0bkOY5zKmQup13f48U6f/mHNW7XXMrN2FSEummsxdNc7zGEIthCaXK9QcRnUt4gdQSwMEFAAAAAgAwLECXW5F7FJEAAAASQAAAA8AAABmaWxlcy9jaGFydC5wbmfrDPBz5+WS4mJgYOD19HAJAtIcIMzBBCS9czXvACkBTxfHkIo5yQkrLBpleXU5GQRmBjBeYt/lCZRj8HT1c1nnlNAEAFBLAQIUAxQAAAAIAMCxAl2+9dEdbwEAAHwDAAAHAAAAAAAAAAAAAACAAQAAAABkb2Mua21sUEsBAhQDFAAAAAgAwLECXW5F7FJEAAAASQAAAA8AAAAAAAAAAAAAAIABlAEAAGZpbGVzL2NoYXJ0LnBuZ1BLBQYAAAAAAgACAHIAAAAFAgAAAAA=';

const QUAD_FIXTURE =
  'UEsDBBQAAAAIAPC0Al3xtSyzEwEAADYCAAAHAAAAZG9jLmttbK2R0U6EMBBF3/mKhme21cUFQoZuYozGZBOjrh/QlNIlQmeFIvj3lq5mJfHFxD7dNmdm7u3Admob8q66vkZThJf0IiTKSCxro4vwZX+7ysItD+DVUY40fREerD3mjI3jSPGojK57apRljmBrug5PWK6nBakRdaOoxNaDarIedp1vUA6tMpaDEa3iz6OwB2BeB3DX4WDKB+evER9fxJMoRUf6HxxIbLDjUlb+ADvdA0LgXqLhcOhUxau6UT3zdfRoNDD/CswjM6unfCfsDs3jIMq5KXbuG4RVPV+lSRQnZJXGdOMEvZplFGd07cSGZlGc0mSeey4BtuwXAFum+T3dtSjJm+O/o/17AOf6z0bZeUnz+vgnUEsDBBQAAAAIAPC0Al3L73oURQAAAEoAAAAPAAAAZmlsZXMvc3dhdGgucG5n6wzwc+flkuJiYGDg9fRwCQLSbCDMwQQk89dVyAMpQU8Xx5CKOck7hBc0tklkaLMw7F+hf3Hn9CvxQEkGT1c/l3VOCU0AUEsBAhQDFAAAAAgA8LQCXfG1LLMTAQAANgIAAAcAAAAAAAAAAAAAAIABAAAAAGRvYy5rbWxQSwECFAMUAAAACADwtAJdy+96FEUAAABKAAAADwAAAAAAAAAAAAAAgAE4AQAAZmlsZXMvc3dhdGgucG5nUEsFBgAAAAACAAIAcgAAAKoBAAAAAA==';

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
let popupDepth = '';
let popupEez = '';
let gazetteerBeforeEez = null;
const marker = [...host.querySelectorAll('path')].find(
  (p) => p.getAttribute('fill') === '#f08c00' || p.getAttribute('fill') === '#e8368f'
);
if (marker) {
  marker.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  popupHtml = host.querySelector('.leaflet-popup-content')?.innerHTML ?? '';
  // Depth arrives after the popup does, so read it while this popup is still
  // the one on screen — by assertion time several others have opened.
  await new Promise((r) => setTimeout(r, 400));
  popupDepth = host.querySelector('.leaflet-popup-content [data-depth]')?.textContent ?? '';
  popupEez = host.querySelector('.leaflet-popup-content [data-eez]')?.textContent ?? '';
  // Captured here, not at assertion time: the EEZ block later on turns the
  // layer on and legitimately does query the gazetteer.
  gazetteerBeforeEez = gazetteerUrl;
}

/* Tap targets. The visible dots are a few pixels across — far smaller than
   a fingertip — so each asset carries an invisible circle to catch near
   misses. Two things have to hold, and checking only one of them passes
   trivially: the target must cover ground the dot does not (a dead-centre
   click would open the popup either way), and clicking it must open the
   same detail as the dot itself. Leaflet's own _containsPoint is the hit
   test both renderers use, so asking it directly is what the pointer asks. */
const layers = Object.values(host._map._layers);
const px = (x, y) => window.L.point(x, y);
const assetDot = layers.find((l) => l.options?.className === 'map-asset');
const OFFSET = 10; // px — a miss by a fingertip's width, not a pixel

let dotCoversOffset = null;
let targetCoversOffset = null;
let tapPopupMatches = null;
if (assetDot?._point) {
  const near = assetDot._point.add(px(OFFSET, 0));
  dotCoversOffset = assetDot._containsPoint(near);

  const target = layers.find(
    (l) =>
      l.options?.className === 'map-tap-target' &&
      l.getLatLng?.().equals(assetDot.getLatLng()) &&
      l._containsPoint?.(near)
  );
  targetCoversOffset = !!target;

  if (target) {
    host._map.closePopup();
    assetDot._path.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const viaDot = host.querySelector('.leaflet-popup-content')?.innerHTML ?? '';
    host._map.closePopup();
    target._path.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const viaTarget = host.querySelector('.leaflet-popup-content')?.innerHTML ?? '';
    tapPopupMatches = !!viaDot && viaDot === viaTarget;
    host._map.closePopup();
  }
}

/* Argo is drawn on canvas, where there is no element to enlarge — the
   renderer hit-tests arithmetically, so the tolerance is what widens it. */
const argoDot = layers.find(
  (l) => l.options?.renderer && l.options?.fillColor === palette.features.argo
);
const argoCoversOffset = argoDot?._point
  ? argoDot._containsPoint(argoDot._point.add(px(OFFSET, 0)))
  : null;

/* The date line. Vector markers exist in one copy of the world, so panning
   past 180° used to show basemap with no platforms on it — the fleet sliced
   down the meridian. Counted rather than eyeballed: how many float markers
   actually fall inside the viewport, against how many floats are really
   there once longitude is wrapped into the same copy as the centre. */
const argoInView = () => {
  const b = host._map.getBounds();
  let n = 0;
  host._map.eachLayer((l) => {
    if (l.options?.fillColor !== palette.features.argo) return;
    const at = l.getLatLng();
    if (at.lng >= b.getWest() && at.lng <= b.getEast() && at.lat >= b.getSouth() && at.lat <= b.getNorth()) n += 1;
  });
  return n;
};
const expectedInView = () => {
  const b = host._map.getBounds();
  const c = host._map.getCenter().lng;
  return (files.argo.floats ?? []).filter((f) => {
    const lng = c + window.L.Util.wrapNum(f.lon - c, [-180, 180], true);
    return lng >= b.getWest() && lng <= b.getEast() && f.lat >= b.getSouth() && f.lat <= b.getNorth();
  }).length;
};
const atDateLine = await (async () => {
  host._map.setView([10, 180], 3, { animate: false });
  await new Promise((r) => setTimeout(r, 800));
  return { drawn: argoInView(), expected: expectedInView() };
})();
const atGreenwich = await (async () => {
  host._map.setView([10, 0], 3, { animate: false });
  await new Promise((r) => setTimeout(r, 800));
  return { drawn: argoInView(), expected: expectedInView() };
})();

/* Hovering an asset names it beside the pointer. Fired through Leaflet's own
   event so the tooltip machinery runs, and read out of the DOM rather than
   from the layer, since binding a tooltip and actually showing one are
   different things. */
let hoverLabel = '';
let hoverFollowsPointer = false;
let hoverCleared = false;
{
  const dot = Object.values(host._map._layers).find((l) => l.options?.className === 'map-asset');
  if (dot) {
    dot.fire('mouseover', { latlng: dot.getLatLng(), layerPoint: dot._point }, true);
    await new Promise((r) => setTimeout(r, 150));
    const tip = host.querySelector('.leaflet-tooltip.map-hover');
    hoverLabel = tip?.textContent ?? '';
    hoverFollowsPointer = dot.getTooltip()?.options?.sticky === true;
    dot.fire('mouseout', {}, true);
    await new Promise((r) => setTimeout(r, 150));
    // Read now: later checks click markers, which opens labels again.
    /* Asked of the layer, not the DOM: Leaflet fades a tooltip out over
       200 ms, so the element outlives the close and a DOM check here is a
       race against an animation rather than a test of behaviour. */
    hoverCleared = dot.isTooltipOpen() === false;
  }
}

/* Zoom buttons: the ones naming a real storm are revealed and wired, and no
   button survives for a storm the data does not have. The stand-in seeded
   for 'zz992026' is gone by now rather than merely hidden — the client
   rebuilds the status box from the fetched data, which is a stronger
   guarantee than the hidden flag it used to rely on, and the check below is
   written against the invariant rather than the mechanism. */
const zoomButtons = [...document.querySelectorAll('[data-storm-zoom]')];
const known = zoomButtons.filter((b) => assets.storms.some((s) => s.id === b.dataset.stormZoom));
const staleShown = zoomButtons.filter(
  (b) => !b.hidden && !assets.storms.some((s) => s.id === b.dataset.stormZoom)
);
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
const sortedSegments = [...drawn.segments].sort((a, b) => a - b);
// Kept because driftAt() below empties the recorder for each window.
const openingSegments = sortedSegments;
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
const argoRadiusAt = {};
const driftAt = async (zoom) => {
  /* Empty the recorder rather than slicing from a mark. It stops recording
     at 400k segments to stay within memory, and two windows are enough to
     reach that — so a third sample read an empty tail and looked like a
     field that had stopped drawing, when the recorder had simply stopped
     listening. */
  drawn.segments.length = 0;
  host._map.setZoom(zoom);
  // The layer rebuilds its interpolated field after a zoom, in slices, so
  // give it room before sampling.
  await new Promise((r) => setTimeout(r, 3000));
  const got = [...drawn.segments];
  const dot = Object.values(host._map._layers).find(
    (l) => l.options?.renderer && l.options?.fillColor === palette.features.argo
  );
  argoRadiusAt[zoom] = dot?.options?.radius ?? null;
  console.log(`   [z${zoom}] ${got.length} segments captured`);
  return p90(got);
};
const driftNear = await driftAt(8);
const driftFar = await driftAt(5);
/* And a third, right out at the globe, which is where a real failure hid.
   Two samples in the middle of the range both looked fine while zoom 2 drew
   123k particle strokes of exactly zero length — every draw call happening
   and nothing appearing. The Jacobian was measured with an API that rounds
   to whole pixels, and at zoom 2 a tenth of a degree is 0.28 px, so the
   probe collapsed to zero and the scale blew up by ~200x. */
const driftGlobe = await driftAt(2);
const drifts = [driftNear, driftFar, driftGlobe];
const driftRatio = drifts.every((d) => d > 0)
  ? Math.max(...drifts) / Math.min(...drifts)
  : Infinity;

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

/* A click that lands on an asset while measuring is a survey point, not a
   request for its popup. Leaflet does not forward a click on an interactive
   layer to the map, so without explicit handling the tap is swallowed and
   the reader has to steer around their own fleet to measure between it. */
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
host._map.closePopup();
measureButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
assetDot?._path.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 150));
const measuringTookTheClick = (measureReadout?.textContent ?? '') === 'Click a second point';
// And it lands on the asset, not wherever in its hit circle the tap fell.
const vertex = Object.values(host._map._layers).find(
  (l) => l.options?.radius === 4 && l.options?.fillColor === '#ffffff'
);
const measuredAtTheAsset =
  !!vertex && !!assetDot && vertex.getLatLng().equals(assetDot.getLatLng());
const measuringSuppressedPopup = !host.querySelector('.leaflet-popup');

// Escape must put the map back the way it was.
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const measureCleared = (measureReadout?.textContent ?? '') === '' &&
  measureButton?.getAttribute('aria-pressed') === 'false';

/* The right-click readout. The depth lookup is stubbed; what matters here is
   that a popup opens with the position and the current already filled from
   the loaded grid, without waiting on the network. */
host._map.fire('contextmenu', { latlng: window.L.latLng(36.5, -74.5) });
await new Promise((r) => setTimeout(r, 300));
const readoutHtml = host.querySelector('.om-point-readout .leaflet-popup-content')?.innerHTML ?? '';
const identifyAtReadout = identifyUrl;

/* Depth. Two animated fields, mutually exclusive, and the readout has to
   name and sample whichever one is on — reporting 60 m water as "surface
   current" would be wrong with nothing on screen to give it away.

   The synthetic tiles carry a different velocity per depth (0.4/0.3 at the
   surface, 0.1/0 at 60 m), so the number in the readout says which chain of
   files the layer actually followed. A 60 m layer that fell back to the
   surface tile index would read 0.50, and a label check alone would miss it. */
host._map.setView([10, -50], 8);          // inside the synthetic tile 0_-60
await new Promise((r) => setTimeout(r, 600));
host._map.closePopup();
host._map.fire('contextmenu', { latlng: window.L.latLng(10, -50) });
await new Promise((r) => setTimeout(r, 200));
const surfaceRead = host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '';

const overlayLabels = [...host.querySelectorAll('.leaflet-control-layers-overlays label')];
const deepToggle = overlayLabels.find((l) => /60m/.test(l.textContent));
deepToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 600));
const labelled = (re) =>
  [...host.querySelectorAll('.leaflet-control-layers-overlays label')].find((l) => re.test(l.textContent));
// The control rebuilds its inputs on redraw, so re-find rather than reuse.
const surfaceOffWithDeepOn = labelled(/Currents at 0m/)?.querySelector('input')?.checked === false;
host._map.closePopup();
host._map.fire('contextmenu', { latlng: window.L.latLng(11, -51) });
await new Promise((r) => setTimeout(r, 200));
const deepRead = host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '';

/* ---- sea surface temperature ---------------------------------------------

   The layers are off by default, so each is switched on the way a reader
   would and the pixels it painted are read back. Checking that a draw
   happened would not be enough: the point is that the colours come from the
   gated ramp and that the readout samples the field that is actually on. */
const overlayLabelled = (re) =>
  [...host.querySelectorAll('.leaflet-control-layers-overlays label')].find((l) => re.test(l.textContent));

const rampRgb = palette.colormaps[palette.defaultColormap.sst].map((h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
]);
// Distance from a pixel to the nearest point on the ramp, allowing for the
// interpolation between stops.
const offRamp = ([r, g, b]) => {
  let best = Infinity;
  for (let i = 0; i < rampRgb.length - 1; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const a = rampRgb[i], c = rampRgb[i + 1];
      const d = Math.hypot(
        r - (a[0] + (c[0] - a[0]) * t),
        g - (a[1] + (c[1] - a[1]) * t),
        b - (a[2] + (c[2] - a[2]) * t)
      );
      if (d < best) best = d;
    }
  }
  return best;
};

/* Inside the synthetic tile area. The Navy layer reaches native resolution
   from zoom 4 now, so a probe outside the tiles falls into a hole in the
   assembled grid and the readout has no temperature to report — which is a
   property of the fixture, not of the map. */
host._map.setView([10, -50], 4, { animate: false });
await new Promise((r) => setTimeout(r, 400));

const sstOisstToggle = overlayLabelled(/OISST/);
const sstNavyToggle = overlayLabelled(/SST \(ESPC\)/);
drawn.images.length = 0;
sstOisstToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 900));

const painted = drawn.images[drawn.images.length - 1] ?? null;
let opaque = 0;
let strayColour = 0;
if (painted) {
  for (let k = 0; k < painted.data.length; k += 4) {
    if (painted.data[k + 3] === 0) continue;
    opaque += 1;
    if (offRamp([painted.data[k], painted.data[k + 1], painted.data[k + 2]]) > 12) strayColour += 1;
  }
}

host._map.closePopup();
host._map.fire('contextmenu', { latlng: window.L.latLng(10, -50) });
await new Promise((r) => setTimeout(r, 200));
const oisstRead = host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '';

// The synthetic Navy field is a constant 7.5 C everywhere, so if the readout
// still reports the OISST value the two layers are not really exclusive.
sstNavyToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 900));
const oisstOffWithNavyOn =
  overlayLabelled(/OISST/)?.querySelector('input')?.checked === false;
host._map.closePopup();
host._map.fire('contextmenu', { latlng: window.L.latLng(11, -51) });
await new Promise((r) => setTimeout(r, 200));
const navyRead = host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '';

/* Read here and nowhere else: this is the one moment both ESPC layers are on
   — the Navy field was just switched on and the animated currents have been
   on since startup. Later the basemap changes and OISST comes back, so the
   same reading taken at the end says nothing about the case this checks. */
const sharedSourceAttribution =
  host.querySelector('.leaflet-control-attribution')?.textContent ?? '';

const currentsOnWithNavy = [/Currents at 0m/, /Currents at 60m/].some(
  (label) => overlayLabelled(label)?.querySelector('input')?.checked === true
);

const sstLegend = document.querySelector('[data-sst-key]');
const legendShown = sstLegend && !sstLegend.hidden;

/* The ramp is stretched over the water in view, so the range has to follow
   the view — and the legend has to follow the range, or the numbers on the
   bar describe some other piece of ocean. Two very different views: tropics
   against high latitude. */
const sstLayerOn = () => Object.values(host._map._layers).find((l) => typeof l.getRange === 'function' && host._map.hasLayer(l));

/* The seam. These grids start at the prime meridian and span exactly 360°,
   so the column after the last one is the first — and clamping there left an
   unpainted stripe down the map with the basemap showing through. Counted by
   column rather than by eye: over open water every column should be painted,
   so a column that is entirely empty between two full ones is the bug. */
const seamGap = async () => {
  // South Atlantic: the meridian crosses open water here. At 20N it crosses
  // the Sahara, where the seam column is unpainted either way — which made
  // the first version of this check pass against the bug it was written for.
  host._map.setView([-30, 0], 3, { animate: false });
  await new Promise((r) => setTimeout(r, 900));
  drawn.images.length = 0;
  sstLayerOn()?._render?.();
  await new Promise((r) => setTimeout(r, 200));
  const img = drawn.images[drawn.images.length - 1];
  if (!img) return null;
  const filled = [];
  for (let x = 0; x < img.width; x++) {
    let n = 0;
    for (let y = 0; y < img.height; y++) if (img.data[(y * img.width + x) * 4 + 3] > 0) n += 1;
    filled.push(n);
  }
  // An empty column flanked by well-covered ones on both sides.
  /* Count *runs* of empty columns flanked by painted ones, not single
     columns. The gap is as wide as one grid cell — six pixels at zoom 3 —
     so every column in it has an empty neighbour, and a single-column test
     finds nothing. That version passed against the very bug it was written
     for, which is why this one was checked against it both ways. */
  let gaps = 0;
  const solid = (x) => x >= 0 && x < filled.length && filled[x] > img.height / 4;
  for (let x = 0; x < filled.length; x++) {
    if (filled[x] !== 0) continue;
    const start = x;
    while (x < filled.length && filled[x] === 0) x += 1;
    if (solid(start - 1) && solid(x)) gaps += 1;
  }
  return gaps;
};
const rangeAt = async (lat, lng, zoom) => {
  host._map.setView([lat, lng], zoom, { animate: false });
  await new Promise((r) => setTimeout(r, 700));
  return { range: sstLayerOn()?.getRange?.() ?? null, label: sstLegend?.textContent ?? '' };
};
/* Back to OISST first: the check above left the synthetic Navy field on, and
   that one is a constant everywhere by construction, so its range is the same
   in every view — it would pass a fixed-range bug straight through. */
overlayLabelled(/OISST/)?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 900));

/* The Navy field is a 1/12° model, and the point of the tile tier is that it
   is served at that resolution rather than a regional subsample. Checked by
   the spacing of the grid the layer is actually holding, at a zoom inside
   the tile threshold. */
const nativeSst = await (async () => {
  overlayLabelled(/SST \(ESPC\)/)?.querySelector('input')?.click();
  await new Promise((r) => setTimeout(r, 300));
  host._map.setView([10, -50], 5, { animate: false });   // inside the synthetic tiles
  await new Promise((r) => setTimeout(r, 1200));
  const layer = Object.values(host._map._layers).find(
    (l) => typeof l.getGrid === 'function' && host._map.hasLayer(l)
  );
  const grid = layer?.getGrid?.();
  const out = { dx: grid?.header?.dx ?? null, value: null };
  const h = grid?.header;
  if (h) out.value = grid.data[Math.round(h.ny / 2) * h.nx + Math.round(h.nx / 2)];
  /* Hand the map back to OISST rather than switching Navy off: the checks
     after this one need *an* SST layer showing, and turning Navy off leaves
     none. Exclusivity takes Navy down on its own. */
  const back = overlayLabelled(/OISST/)?.querySelector('input');
  if (back && !back.checked) back.click();
  await new Promise((r) => setTimeout(r, 900));
  return out;
})();

/* Salinity is the same machinery as temperature with a different ramp, unit
   and rounding step — so what is worth checking is that it is genuinely a
   different field and not a relabelled copy: its own ramp on the bar, psu in
   the readout, and a half-unit range where temperature rounds to whole ones.
   Open ocean spans only a few psu, so whole-unit rounding would leave a
   typical view in a corner of the ramp. */
const salinity = await (async () => {
  /* By the layer's name in the switcher, which is "SSS (ESPC)". The readout
     and the legend still say "Salinity" — that is FIELDS[...].label, the
     quantity rather than the layer, and "Salinity: 34.2 psu" reads better
     there than the acronym would. The two are deliberately not the same
     string. */
  const toggle = overlayLabelled(/SSS \(ESPC\)/);
  toggle?.querySelector('input')?.click();
  await new Promise((r) => setTimeout(r, 1200));
  host._map.setView([25, -55], 4, { animate: false });
  await new Promise((r) => setTimeout(r, 1200));
  host._map.closePopup();
  host._map.fire('contextmenu', { latlng: window.L.latLng(25, -55) });
  await new Promise((r) => setTimeout(r, 250));
  const layer = Object.values(host._map._layers).find(
    (l) => typeof l.getRange === 'function' && host._map.hasLayer(l)
  );
  const out = {
    offered: !!toggle,
    readout: host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '',
    range: layer?.getRange?.() ?? null,
    step: layer?.options?.field?.step ?? null,
    legend: sstLegend?.textContent ?? '',
    sstStillOn: overlayLabelled(/OISST/)?.querySelector('input')?.checked,
  };
  /* The automatic range is held to seawater. This grid runs 3.0 to 43.5 psu
     — Chesapeake and the Baltic at one end, the Red Sea at the other — and
     without the clamp one estuary in the corner of a view spends most of the
     ramp on water nobody is looking at. A range the reader pins by hand is
     deliberately not clamped, so both halves are checked. */
  host._map.setView([20, -60], 2, { animate: false });
  await new Promise((r) => setTimeout(r, 900));
  const wide = Object.values(host._map._layers).find(
    (l) => typeof l.getRange === 'function' && host._map.hasLayer(l)
  );
  out.globalAuto = wide?.getRange?.() ?? null;
  out.freshInView = (() => {
    const g = wide?._grid;
    return g ? g.data.some((v) => typeof v === 'number' && v < 29) : false;
  })();

  const minIn2 = document.querySelector('[data-field-min]');
  const maxIn2 = document.querySelector('[data-field-max]');
  if (minIn2 && maxIn2) {
    minIn2.value = '10';
    maxIn2.value = '40';
    minIn2.dispatchEvent(new window.Event('change', { bubbles: true }));
    maxIn2.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const pinnedLayer = Object.values(host._map._layers).find(
      (l) => typeof l.getRange === 'function' && host._map.hasLayer(l)
    );
    out.pinnedOutsideWindow = pinnedLayer?.getRange?.() ?? null;
    document.querySelector('[data-field-auto]')?.click();
    await new Promise((r) => setTimeout(r, 600));
  }

  const back = overlayLabelled(/OISST/)?.querySelector('input');
  if (back && !back.checked) back.click();
  await new Promise((r) => setTimeout(r, 900));
  return out;
})();

/* Reader control over the colour scale. Three separable behaviours, so three
   checks: the colormap actually changes the pixels, a pinned range survives a
   pan that would otherwise rescale it, and Auto gives the view back. */
const scaleControls = await (async () => {
  const picker = document.querySelector('[data-field-map]');
  const minIn = document.querySelector('[data-field-min]');
  const maxIn = document.querySelector('[data-field-max]');
  const auto = document.querySelector('[data-field-auto]');
  const on = () => Object.values(host._map._layers).find(
    (l) => typeof l.getRange === 'function' && host._map.hasLayer(l)
  );
  const paint = () => {
    drawn.images.length = 0;
    on()?._render?.();
    const img = drawn.images[drawn.images.length - 1];
    if (!img) return null;
    for (let k = 0; k < img.data.length; k += 4) {
      if (img.data[k + 3] !== 0) return [img.data[k], img.data[k + 1], img.data[k + 2]];
    }
    return null;
  };

  host._map.setView([25, -55], 4, { animate: false });
  await new Promise((r) => setTimeout(r, 900));

  // Flattened across the optgroups.
  const options = [...picker.querySelectorAll('option')].map((o) => o.value);
  const before = paint();
  // Pick a map that is not the current one.
  picker.value = options.find((o) => o !== picker.value) ?? options[0];
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const afterMap = paint();

  // Pin a range, then pan somewhere with different water.
  minIn.value = '5';
  maxIn.value = '9';
  minIn.dispatchEvent(new window.Event('change', { bubbles: true }));
  maxIn.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const pinned = on()?.getRange?.();
  host._map.setView([60, -30], 4, { animate: false });
  await new Promise((r) => setTimeout(r, 900));
  const pinnedAfterPan = on()?.getRange?.();

  auto.click();
  await new Promise((r) => setTimeout(r, 400));
  const backToAuto = on()?.getRange?.();

  return { before, afterMap, pinned, pinnedAfterPan, backToAuto, options };
})();

const seamGaps = await seamGap();

const tropics = await rangeAt(12, -50, 4);
const polar = await rangeAt(70, -10, 4);
const wholeDegrees = (r) => !!r && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[1] > r[0];

/* ---- the forecast hour ----------------------------------------------- */
const forecastControls = host.closest('[data-ocean-map]')?.querySelector('[data-forecast-controls]')
  ?? document.querySelector('[data-forecast-controls]');
const forecastButtons = () => [...(forecastControls?.querySelectorAll('button') ?? [])];
const forecastActive = () => forecastButtons().filter((b) => b.classList.contains('active')).map((b) => b.textContent);

/* The frame nearest the reader's own clock, not lead 0. Those agree on a
   healthy day and part on the bad one this was asked for: a run 40 hours
   late makes lead 0 a field for 40 hours ago while a later frame is valid
   about now. The fixture stamps lead 0 at 2026-08-03 06Z, which is in the
   past by the time this runs, so "nearest" is a real decision here. */
const forecastDefault = forecastActive();

/* Who fetched what. The first version of this feature handed every layer the
   same frame object, so one click had the 60 m field, the temperature and
   the salinity all fetch the *surface current* grid — invisible on screen,
   since a vector file read as a scalar draws nothing and 60 m drawing
   surface water still looks like a current. */
/* Note the fixture stamps lead 0 in the past, so "Now" is whichever frame is
   nearest the wall clock when the suite runs — not necessarily lead 0. That
   is the behaviour under test, so the step picks a button by *not* being the
   active one rather than by its label. */
const beforeStep = fetched.length;
/* Skip the first button: frames are ordered by lead, so that one is lead 0,
   and stepping *to* lead 0 re-requests the base files rather than any frame
   — a step that looks like a step and asks for nothing new. The first
   version of this check picked it and found an empty frame list, which is
   indistinguishable from the swap being broken. */
const stepButton = forecastButtons().slice(1).find((b) => !b.classList.contains('active'));
stepButton?.click();
/* Long enough for the swap to land. Slicing the log at a mark is not enough
   on its own — initial loads are still in flight and land inside the slice —
   so the assertions below look only at frame files, which nothing but a step
   requests. */
await new Promise((r) => setTimeout(r, 1500));
const askedByStep = fetched.slice(beforeStep).map((u) => String(u).split('/map/')[1]).filter(Boolean);
const frameAsks = askedByStep.filter((f) => /-f\d+h/.test(f));
const steppedActive = forecastActive();

/* Step back before anything else runs. This is a probe, and everything below
   — the tile tier, the particle drift, the readouts — assumes the map is on
   the hour it opened with. Leaving it parked on a forecast frame silently
   failed five unrelated checks, each of them correctly: on that frame the
   fixture publishes no tiles, so the region really was the finest grid in
   use. A test that moves the world and does not put it back is a slow
   landmine for whatever gets added underneath it. */
forecastButtons().find((b) => b.textContent === 'Now')?.click();
await new Promise((r) => setTimeout(r, 900));

/* Read before the reset runs. Both of these look at live DOM, so once the
   map is back at defaults they would report the reset state rather than what
   they were written to check. */
const toneBeforeReset = host.dataset.basemapTone;
const attributionBeforeReset = host.querySelector('.leaflet-control-attribution')?.textContent ?? '';

/* Last, and deliberately so: this one is destructive by design. It puts the
   basemap, the layers, the colour scale and the view back to defaults, so
   anything checked after it would be reading the reset state rather than
   what it meant to test. Two earlier checks failed exactly that way. */
/* EEZ boundaries. Off by default, so the check is that switching it on puts
   the layer in its own pane below the platforms — a boundary that covered a
   glider would be the one thing this layer must not do. */
const eezLayer = await (async () => {
  const toggle = [...host.querySelectorAll('.leaflet-control-layers-overlays label')]
    .find((l) => /EEZ/.test(l.textContent));
  const before = host.querySelectorAll('.leaflet-eez-pane img').length;
  toggle?.querySelector('input')?.click();
  await new Promise((r) => setTimeout(r, 900));
  const pane = host.querySelector('.leaflet-eez-pane');
  // With the layer on, the readout should name the jurisdiction — and say
  // "high seas" where there is none rather than reporting a failure.
  host._map.closePopup();
  host._map.fire('contextmenu', { latlng: window.L.latLng(36.5, -74.5) });
  await new Promise((r) => setTimeout(r, 400));
  const jurisdictionOn = host.querySelector('.om-point-readout [data-eez]')?.textContent ?? '';
  host._map.closePopup();
  host._map.fire('contextmenu', { latlng: window.L.latLng(30.0, -45.0) });
  await new Promise((r) => setTimeout(r, 400));
  const openOcean = host.querySelector('.om-point-readout [data-eez]')?.textContent ?? '';
  host._map.closePopup();

  const out = {
    jurisdictionOn,
    openOcean,
    askedGazetteer: /typeID=70/.test(gazetteerUrl ?? ''),
    offered: !!toggle,
    offByDefault: before === 0,
    hasPane: !!pane,
    // Below the markers, above the fields.
    belowMarkers: pane
      ? Number(getComputedStyle(pane).zIndex) < 400 && Number(getComputedStyle(pane).zIndex) > 260
      : false,
    requested: [...host.querySelectorAll('.leaflet-eez-pane img')].some((i) =>
      /geo\.vliz\.be/.test(i.src) && /eez_boundaries/.test(i.src)
    ),
  };
  toggle?.querySelector('input')?.click();
  await new Promise((r) => setTimeout(r, 300));
  return out;
})();

const globalReset = await (async () => {
  const controls = document.querySelector('[data-field-controls]');
  const picker = controls.querySelector('[data-field-map]');
  const minIn = controls.querySelector('[data-field-min]');
  const maxIn = controls.querySelector('[data-field-max]');
  const named = (re) => [...host.querySelectorAll('.leaflet-control-layers-overlays label')]
    .find((l) => re.test(l.textContent));
  const baseNamed = (re) => [...host.querySelectorAll('.leaflet-control-layers-base label')]
    .find((l) => re.test(l.textContent));

  // Push everything off its default.
  baseNamed(/OpenStreetMap/)?.querySelector('input')?.click();
  named(/Lat\/lon grid/)?.querySelector('input')?.click();
  await new Promise((r) => setTimeout(r, 400));
  picker.value = 'jet';
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  minIn.value = '1';
  maxIn.value = '2';
  minIn.dispatchEvent(new window.Event('change', { bubbles: true }));
  maxIn.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));

  const reset = [...host.querySelectorAll('.om-view-toggle a')].find((a) => a.textContent === 'Reset');
  reset?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1200));

  const layer = Object.values(host._map._layers).find(
    (l) => typeof l.getRange === 'function' && host._map.hasLayer(l)
  );
  return {
    basemapBack: baseNamed(/GEBCO/)?.querySelector('input')?.checked === true,
    layersBack: named(/Lat\/lon grid/)?.querySelector('input')?.checked === false,
    scaleBack: picker.value === palette.defaultColormap.sst,
    // Auto again: the pinned 1–2 must be gone.
    mapBack: !layer || String(layer.getRange?.()) !== '1,2',
    storageCleared: window.sessionStorage.getItem('asset-map-view') === null ||
      !JSON.parse(window.sessionStorage.getItem('asset-map-view')).fields?.sst?.range,
  };
})();


const status = document.getElementById('map-status').textContent;
/* ---- a reader's own KMZ overlay -------------------------------------------

   Uploaded through the real file input, so this exercises the decode, the
   styling and the drawing rather than a shortcut into the renderer. */
const kmzUpload = await (async () => {
  const input = document.querySelector('[data-kmz-file]');
  if (!input) return null;
  const bytes = Uint8Array.from(atob(KMZ_FIXTURE), (c) => c.charCodeAt(0));
  const file = new window.File([bytes], 'survey.kmz', { type: 'application/vnd.google-earth.kmz' });
  // jsdom has no DataTransfer, so the FileList is stood up directly.
  Object.defineProperty(input, 'files', {
    value: Object.assign([file], { item: (i) => [file][i], length: 1 }),
    configurable: true,
  });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const drawn = [];
  host._map.eachLayer((l) => {
    if (l.options?.pane === 'user' && l.options?.color) drawn.push(l.options);
  });
  return {
    drawn,
    note: document.querySelector('[data-kmz-note]')?.textContent ?? '',
    listed: document.querySelectorAll('[data-kmz-list] button').length,
    inSwitcher: [...document.querySelectorAll('.leaflet-control-layers-overlays label')]
      .filter((l) => /survey/i.test(l.textContent)).length,
  };
})();

/* A second upload, this one carrying georeferenced images. */
const kmzOverlay = await (async () => {
  const input = document.querySelector('[data-kmz-file]');
  if (!input) return null;
  const bytes = Uint8Array.from(atob(OVERLAY_FIXTURE), (c) => c.charCodeAt(0));
  const file = new window.File([bytes], 'overlay.kmz', { type: 'application/vnd.google-earth.kmz' });
  Object.defineProperty(input, 'files', {
    value: Object.assign([file], { item: (i) => [file][i], length: 1 }),
    configurable: true,
  });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const images = [];
  host._map.eachLayer((l) => {
    if (l.options?.pane === 'user' && typeof l.getBounds === 'function' && l._url) {
      images.push({ url: l._url, opacity: l.options.opacity, alt: l.options.alt, bounds: l.getBounds() });
    }
  });
  return { images, note: document.querySelector('[data-kmz-note]')?.textContent ?? '' };
})();

/* A third upload: an image on four arbitrary corners. */
const kmzQuad = await (async () => {
  const input = document.querySelector('[data-kmz-file]');
  if (!input) return null;
  const bytes = Uint8Array.from(atob(QUAD_FIXTURE), (c) => c.charCodeAt(0));
  const file = new window.File([bytes], 'quad.kmz', { type: 'application/vnd.google-earth.kmz' });
  Object.defineProperty(input, 'files', {
    value: Object.assign([file], { item: (i) => [file][i], length: 1 }),
    configurable: true,
  });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  const element = host.querySelector('.om-kmz-quad');
  return {
    drawn: !!element,
    note: document.querySelector('[data-kmz-note]')?.textContent ?? '',
    opacity: element?.style.opacity,
    /* jsdom loads no images, so naturalWidth stays 0 and the matrix is never
       computed — the transform is checked in a real browser instead. What is
       worth asserting here is that the layer is built and placed at all. */
    inUserPane: element?.parentElement?.classList.contains('leaflet-user-pane') ?? false,
  };
})();

/* ---- isobaths -------------------------------------------------------------

   The layer is off by default and neither tier is fetched until it is
   switched on, which is most of the point: the deep file alone is 1.2 MB
   gzipped and a reader who never asks for the seafloor must not pay for it.
   Everything below drives the layer switcher the way a reader would. */
/* jsdom does no layout, so nothing below can see that the contours render
   at all — which is exactly how this shipped invisible the first time. The
   site's reset gives every svg `max-width: 100%`, a Leaflet pane is a 0x0
   positioned box, and the SVG inside a custom pane therefore computed to
   0x0 and clipped every path away: right geometry, right transform, right
   stroke, no pixels. Leaflet ships the counter-rule for its own overlay
   pane only. This asserts the rule survives in the built CSS; it is a guard
   against deleting the fix, not a rendering test. */
const builtCss = fs
  .readdirSync(path.join('dist', '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join('dist', '_astro', f), 'utf8'))
  .join('\n');
/* Every fetch has to go through the configured dataBase. Two did not — the
   isobath tile request and the hourly refresh poll — because both are
   template literals and the sweep that rewrote the quoted paths never matched
   them. A second deployment pointing dataBase at another host would silently
   have fetched those two from its own origin.

   Read from the source rather than the bundle, which inlines the default and
   so contains '/map/' legitimately. Comments are stripped first: prose about
   the old paths is not a path, and the first version of this failed on its own
   explanatory comment. */
const moduleSource = fs.readFileSync('packages/ocean-map/index.ts', 'utf8');
const withoutComments = moduleSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const hardcodedPaths = [...withoutComments.matchAll(/['"`]\/map\/[^'"`]*/g)].map((m) => m[0]);
/* One is expected: the default value of the dataBase option itself, which is
   where the path belongs. Anything else is a fetch that ignores the option. */
const strayPaths = hardcodedPaths.filter((hit) => hit !== "'/map/");

/* Every instance of the map must look and behave the same wherever it is
   placed, so all of its styling lives in the package's own stylesheet and a
   host page contributes placement only. A rule written into a page instead
   would apply to that page's map and no other — the two would drift, and the
   one anybody checks is whichever they opened.

   Scans the site's own CSS and the style blocks of its components for
   anything that styles the map: a `--map-*` declaration, or a selector
   reaching for the class or the tone attribute. Markup is not searched,
   because the container legitimately carries `data-ocean-map` hooks. */
const siteStyles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (entry.name.endsWith('.css')) return [[full, fs.readFileSync(full, 'utf8')]];
    if (!entry.name.endsWith('.astro')) return [];
    const blocks = [...fs.readFileSync(full, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
    return blocks.map((block) => [full, block[1]]);
  });
})('src');

const strayMapStyles = siteStyles
  .filter(([, css]) =>
    /--map-[\w-]+\s*:/.test(css) || /\.ocean-map|data-basemap-tone|\.map-(coast|bathy|land|grid|eez|asset|casing)\b/.test(css)
  )
  .map(([file]) => file);

/* Two of the map's colours are keyed to the *basemap* rather than the theme —
   the isobath halo and the shoreline tint — because what they have to be seen
   against is the water GEBCO or Esri paints, which dark mode does not change.
   Both are set in the theme blocks first and overridden for a dark basemap
   after, and the override is one compound selector shorter than the blocks it
   has to beat. So it lost, and only in dark mode: over GEBCO the isobath halo
   resolved to the dark casing its own comment says must never happen, and it
   had been wrong since the day it was written. Light mode, which is what
   anyone checks by eye, was right throughout.

   This resolves the cascade over the built CSS for a map on a dark basemap
   and asserts the basemap rule wins. jsdom cannot: it does not cascade custom
   properties, which is why nothing here caught it. */
const specificity = (selector) =>
  (
    selector
      .replace(/::[\w-]+/g, ' ')
      // :not() and friends contribute their argument, not themselves
      .replace(/:(?:not|is|has)\(/g, '(')
      .replace(/[()]/g, ' ')
      .match(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []
  ).reduce((n, part) => n + (part.startsWith('#') ? 1000 : 1), 0);

/* Every rule setting one of these, in document order. The selector is
   whatever precedes the brace and cannot contain one, so an @media wrapper
   is skipped rather than captured — a media query does not affect the
   cascade between two rules of equal specificity anyway; source order does. */
const rulesSetting = (property) =>
  [...builtCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body], order) => ({ selector: selector.trim(), body, order }))
    .filter((rule) => new RegExp(`(^|;)\\s*${property}\\s*:`).test(rule.body));

const basemapBeatsTheme = (property) => {
  const rules = rulesSetting(property);
  if (rules.length < 2) return false;
  const winner = rules.reduce((best, rule) =>
    specificity(rule.selector) > specificity(best.selector) ||
    (specificity(rule.selector) === specificity(best.selector) && rule.order > best.order)
      ? rule
      : best
  );
  return /\[data-basemap-tone=['"]?dark/.test(winner.selector);
};

const paneSvgUnclamped =
  /\.leaflet-pane>svg\{[^}]*max-width:none/.test(builtCss.replace(/\s+/g, '')) ||
  /\.leaflet-pane>svg\{[^}]*max-width:none/.test(builtCss);

/* The particle scale has to follow the view, not just the zoom.

   It divides out the viewport area and the projection's Jacobian, so it
   changes with any pan across latitude — but it used to be refreshed only
   when the zoom changed. That left it measured against whatever bounds
   existed when the layer was built, which is before the page has finished
   laying the map out: on a page opening at globe zoom it came out 259
   against a settled 0.436, six hundred times too fast, and stayed there
   until the reader happened to zoom. 120,000 zero-length strokes, a globe of
   straight streaks, no error anywhere.

   jsdom does no layout, so it cannot reproduce that race — at construction
   the bounds are already the settled ones. What it *can* reproduce is the
   cause: a pan with no zoom change must still rescale. That is the exact
   line that was wrong, and reverting the fix fails this. */
const scaleNow = () => {
  let found = null;
  host._map.eachLayer((l) => {
    if (l._windy && found === null) found = l.options?.velocityScale ?? null;
  });
  return found;
};
host._map.setView([12, -60], host._map.getZoom(), { animate: false });
await new Promise((r) => setTimeout(r, 400));
const scaleSouth = scaleNow();
host._map.setView([46, -60], host._map.getZoom(), { animate: false });
await new Promise((r) => setTimeout(r, 400));
const scaleNorth = scaleNow();

const bathyPaneZ = (name) =>
  Number(host.querySelector(`.leaflet-${name}-pane`)?.style.zIndex ?? NaN);
const bathyRequestsBeforeSwitchOn = bathyFetched.length;

/* The offline basemap, exercised the way a reader reaches it: it must have
   asked for nothing up to here, and drawn land once selected. */
const coastlineRequestsBeforeSwitchOn = coastlineFetched.length;
const coastlineBase = [...host.querySelectorAll('.leaflet-control-layers-base label')]
  .find((l) => /Coastline only/.test(l.textContent));
coastlineBase?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 600));
const coastlineRequestsAfterSwitchOn = coastlineFetched.length;
const landDrawn = Object.values(host._map._layers).filter(
  (l) => /map-land/.test(l.options?.className ?? '')
).length;
/* Back to GEBCO, and switching away and back must not fetch it twice: the
   latch is what keeps a 4.2 MB file from being re-read on every toggle. */
[...host.querySelectorAll('.leaflet-control-layers-base label')]
  .find((l) => /GEBCO/.test(l.textContent))?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 300));
coastlineBase?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 400));
const coastlineRequestsAfterToggling = coastlineFetched.length;
[...host.querySelectorAll('.leaflet-control-layers-base label')]
  .find((l) => /GEBCO/.test(l.textContent))?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 300));

const bathyToggle = overlayLabelled(/^\s*Isobaths/);
bathyToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 400));

// Zoom 7 is inside the tile tier, and the view spans both stubs' latitudes,
// so if both tiers drew at once both would be visible.
host._map.setView([24.5, -75], 7, { animate: false });
await new Promise((r) => setTimeout(r, 900));

const bathyLayersAt7 = Object.values(host._map._layers).filter((l) =>
  /map-bathy/.test(l.options?.className ?? '')
);
const bathyDeepAsked = bathyFetched.filter((u) => u.includes('bathy-deep')).length;
const bathyTilesAsked = bathyFetched.filter((u) => /bathy-tiles\/-?\d/.test(u));

/* Which tier drew what, read off the geometry rather than trusted: the deep
   stub sits at 21-23 N and a tile stub at 25-27 N, so a tier reading the
   other tier's file lands in the wrong place. */
const bathyAtLat = (lo, hi) =>
  bathyLayersAt7.filter((l) => {
    const c = l.getBounds?.()?.getCenter?.();
    return c && c.lat > lo && c.lat < hi;
  }).length;
const coarseDrawnAtFineZoom = bathyAtLat(21.5, 24.5);
const fineDrawn = bathyAtLat(24.8, 28);

/* No colour on any contour. CSS owns the stroke so a theme switch restyles
   the layer with no redraw, and Leaflet's own default is the only `color`
   allowed to be there — anything else is a hardcoded colour the contrast
   gate cannot see. */
const bathyColoured = bathyLayersAt7.filter(
  (l) => l.options?.color && l.options.color !== '#3388ff'
);

// Below the tile threshold the fine tier stands down and the coarse one
// comes back, so the map is never left with no isobaths at all.
const tilesBeforeZoomOut = bathyTilesAsked.length;
host._map.setView([24.5, -75], 4, { animate: false });
await new Promise((r) => setTimeout(r, 700));
const atLat = (lo, hi) =>
  Object.values(host._map._layers).filter((l) => {
    const c = l.getBounds?.()?.getCenter?.();
    return /map-bathy/.test(l.options?.className ?? '') && c && c.lat > lo && c.lat < hi;
  }).length;
const fineGoneAtCoarseZoom = atLat(24.8, 28) === 0;
const coarseBackAtCoarseZoom = atLat(21.5, 24.5) > 0;
const noNewTilesBelowThreshold =
  bathyFetched.filter((u) => /bathy-tiles\/-?\d/.test(u)).length === tilesBeforeZoomOut;

/* Opacity is one property on the pane rather than a restyle of every
   contour, and it is part of the reader's view — a build landing mid-session
   reloads the page, and a slider that silently sprang back to default would
   read as not holding. */
const bathySlider = document.querySelector('[data-bathy-opacity]');
const bathySliderShown = !document.querySelector('[data-bathy-controls]')?.hidden;
let bathyOpacityApplied = false;
let bathyOpacitySaved = false;
if (bathySlider) {
  bathySlider.value = '35';
  bathySlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  bathyOpacityApplied =
    Math.abs(Number(host.querySelector('.leaflet-bathy-pane')?.style.opacity) - 0.35) < 1e-6;
  const saved = JSON.parse(window.sessionStorage.getItem('asset-map-view') ?? '{}');
  bathyOpacitySaved = Math.abs((saved.bathyOpacity ?? 0) - 0.35) < 1e-6;
}

/* Panning east past the antimeridian. Vector layers live in one copy of the
   world, so a contour written at -179 is drawn 360 deg west of a view
   centred at 185 and simply vanishes — the same fault rehome() fixes for
   markers, which it deliberately does not apply to lines. */
host._map.setView([10, 185], 5, { animate: false });
await new Promise((r) => setTimeout(r, 800));
const acrossDateLine = (() => {
  const b = host._map.getBounds();
  return Object.values(host._map._layers).filter((l) => {
    if (!/map-bathy/.test(l.options?.className ?? '')) return false;
    const lb = l.getBounds?.();
    return lb && lb.isValid() && b.intersects(lb);
  }).length;
})();

/* Sitting on the seam, with contours either side of it. */
host._map.setView([11, 180], 4, { animate: false });
await new Promise((r) => setTimeout(r, 800));
const straddling = (() => {
  const b = host._map.getBounds();
  const seen = { west: 0, east: 0 };
  for (const l of Object.values(host._map._layers)) {
    if (!/map-bathy/.test(l.options?.className ?? '')) continue;
    for (const line of l.getLatLngs?.() ?? []) {
      if (!line.length) continue;
      const lng = line[0].lng;
      const lat = line[0].lat;
      if (lat < 9 || lat > 13) continue;               // the two date-line stubs only
      if (!b.contains(window.L.latLng(lat, lng))) continue;
      if (lng < 180) seen.west++; else seen.east++;
    }
  }
  return seen;
})();

/* ---- the wind field --------------------------------------------------

   Read here, last, because switching it on switches the currents off — it
   joins their exclusivity group — and every check above wants a current
   field on the map. */
const windToggle = overlayLabelled(/Wind at 10m/);
const flowKey = () => host.closest('[data-ocean-map]')?.querySelector('[data-flow-key]')
  ?? document.querySelector('[data-flow-key]');
const flowKeyBefore = flowKey()?.textContent ?? '';

host._map.setView([20, -50], 5, { animate: false });
await new Promise((r) => setTimeout(r, 300));

/* What the currents drift at, measured immediately before the swap, so the
   wind is compared against this run's own number rather than a remembered
   one. */
const sampleDrift = async () => {
  // Emptied rather than sliced, for the reason driftAt() records: the
  // recorder stops at 400k segments, so a late sample can read an empty
  // tail that looks exactly like a field which stopped drawing.
  drawn.segments.length = 0;
  await new Promise((r) => setTimeout(r, 1600));
  return p90([...drawn.segments]);
};
const currentPx = await sampleDrift();

windToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 900));
const currentsOffWithWind = [/Currents at 0m/, /Currents at 60m/].every(
  (label) => overlayLabelled(label)?.querySelector('input')?.checked === false
);
const windPx = await sampleDrift();
const flowKeyWithWind = flowKey()?.textContent ?? '';
console.log(`wind: p90 ${windPx.toFixed(2)} px/frame against the currents' ${currentPx.toFixed(2)}`);

host._map.closePopup();
host._map.fire('contextmenu', { latlng: window.L.latLng(20, -50) });
await new Promise((r) => setTimeout(r, 250));
const windRead = host.querySelector('.om-point-readout .leaflet-popup-content')?.textContent ?? '';

const windAttribution = host.querySelector('.leaflet-control-attribution')?.textContent ?? '';

windToggle?.querySelector('input')?.click();
await new Promise((r) => setTimeout(r, 600));

// Put the map back where the checks below expect it.
host._map.setView([25, -75], 6, { animate: false });
await new Promise((r) => setTimeout(r, 300));

const checks = [
  ['leaflet initialised', host.classList.contains('leaflet-container')],
  ['panning across latitude rescales the particle field, with no zoom change',
    scaleSouth !== null && scaleNorth !== null && scaleSouth !== scaleNorth],

  // ---- a reader's own KMZ overlay
  ['an uploaded KMZ is decoded and drawn',
    !!kmzUpload && kmzUpload.drawn.length === 5],
  ['it joins the layer switcher under its own name',
    !!kmzUpload && kmzUpload.inSwitcher === 1 && kmzUpload.listed === 1],
  ['and reports what it drew and skipped',
    !!kmzUpload && /5 features/.test(kmzUpload.note) && /skipped/.test(kmzUpload.note)],
  ['the file\'s own colours and widths reach the map',
    !!kmzUpload && kmzUpload.drawn.some((o) => o.color === '#ff0000' && o.weight === 3)],
  /* PolyStyle's `outline` governs a polygon's edge only. Applied to
     everything it silently erases lines — the sample shares one style between
     its legs and its unoutlined boxes, and every leg rendered stroke="none":
     drawn, right colour in the options, invisible on screen. */
  ['GroundOverlay images are lifted out of the archive and drawn',
    !!kmzOverlay && kmzOverlay.images.length === 2],
  ['each as a blob, not a request back to the file\'s own host',
    !!kmzOverlay && kmzOverlay.images.every((i) => i.url.startsWith('blob:'))],
  ['georeferenced by their LatLonBox',
    !!kmzOverlay && kmzOverlay.images.some((i) =>
      Math.abs(i.bounds.getNorth() - 38) < 1e-6 && Math.abs(i.bounds.getWest() + 76) < 1e-6)],
  /* KML puts the opacity in the overlay's colour alpha, not in an opacity
     tag — b2 is 178/255. */
  ['with the colour alpha read as opacity',
    !!kmzOverlay && kmzOverlay.images.some((i) => Math.abs(i.opacity - 178 / 255) < 1e-3)],
  /* An absolute href would have a document the reader opened fetch from a
     host it names; refused for the reason NetworkLink is, and counted. */
  ['an image hosted elsewhere is refused and reported',
    !!kmzOverlay && /hosted elsewhere/.test(kmzOverlay.note)],
  ['a gx:LatLonQuad overlay is drawn on its four corners',
    !!kmzQuad && kmzQuad.drawn && kmzQuad.inUserPane],
  ['carrying its own opacity', !!kmzQuad && kmzQuad.opacity === '0.8'],
  /* Four points or it is not a quadrilateral; the fixture's second overlay
     gives two. */
  ['a quad with the wrong number of corners is refused',
    !!kmzQuad && /skipped 1 GroundOverlay/.test(kmzQuad.note)],
  ['a polygon-only outline switch does not erase the lines',
    !!kmzUpload &&
      kmzUpload.drawn.some((o) => o.color === '#ff0000' && o.fill !== true && o.stroke !== false) &&
      // the polygon sharing that style still honours its own outline: 0
      kmzUpload.drawn.some((o) => o.color === '#ff0000' && o.fill === true && o.stroke === false)],


  // ---- isobaths
  ['isobaths fetch nothing until the layer is switched on',
    bathyRequestsBeforeSwitchOn === 0],
  /* Same rule for the offline basemap, and here it is what makes the file
     affordable: rebuilt from Natural Earth 10m it is 4.2 MB against 0.3, so
     loading it with the page for a basemap most readers never pick would be
     a poor trade for all of them. */
  // ---- the forecast hour
  ['the forecast hour is offered as one button per published frame',
    forecastButtons().length === FRAME_LEADS.length],
  /* Not lead 0 — the frame nearest the reader's clock. The two agree on a
     healthy day and part on a late run, which is the case this exists for. */
  ['it opens on the frame nearest now, not on lead 0',
    forecastDefault.length === 1 && forecastDefault[0] === 'Now'],
  ['stepping to another hour marks that button and only that one',
    steppedActive.length === 1 && steppedActive[0] !== 'Now'],
  /* The bug: every layer was handed the same frame object, so one click had
     four layers fetch the surface current grid. Each product must ask for
     its own file, and exactly once. */
  ['each layer fetches its own frame, not another product\'s',
    frameAsks.length >= 2 &&
      new Set(frameAsks).size === frameAsks.length &&
      frameAsks.some((f) => f.startsWith('currents-f')) &&
      frameAsks.some((f) => f.startsWith('currents-60m-f'))],
  /* Every frame file asked for must be the *same* hour. Mixing them is the
     failure that looks most like success — each layer sharp and plausible,
     the map showing two different times and saying one. */
  ['and all of them the same hour',
    frameAsks.length > 0 &&
      new Set(frameAsks.map((f) => f.match(/-f(\d+)h/)[1])).size === 1],

  ['the offline basemap is offered', !!coastlineBase],
  ['and fetches nothing until it is selected', coastlineRequestsBeforeSwitchOn === 0],
  ['selecting it fetches the file once and draws land',
    coastlineRequestsAfterSwitchOn === 1 && landDrawn > 100],
  ['switching away and back does not fetch it again',
    coastlineRequestsAfterToggling === 1],
  ['switching them on fetches the global deep file once',
    bathyDeepAsked === 1],
  ['at zoom >= 6 the fine tiles draw and the coarse global set stands down',
    fineDrawn > 0 && bathyTilesAsked.length > 0 && coarseDrawnAtFineZoom === 0],
  ['and below the threshold the coarse set comes back',
    coarseBackAtCoarseZoom && fineGoneAtCoarseZoom],
  ['each depth is one multi-line path, not one layer per contour',
    bathyLayersAt7.length > 0 && bathyLayersAt7.length < 40],
  ['contours carry a class and no colour, so CSS can theme them',
    bathyColoured.length === 0 &&
      bathyLayersAt7.every((l) => /map-bathy/.test(l.options.className))],
  ['vectors in a custom pane are not clamped to 0x0 by the site reset',
    paneSvgUnclamped],
  ['the isobath halo follows the basemap even in dark mode',
    basemapBeatsTheme('--map-bathy-halo')],
  ['and so does the shoreline tint',
    basemapBeatsTheme('--map-coast')],
  ['no page styles the map, so every instance of it looks the same',
    strayMapStyles.length === 0],
  ['every data fetch goes through the configured dataBase',
    strayPaths.length === 0 && hardcodedPaths.length === 1],
  /* The shoreline replaced a Natural Earth polyline whose vertices were 16
     px apart at zoom 7 — as coarse as the isobaths were before they were
     fixed, and drawn a few pixels off the basemap's own coast. It is a
     separate layer and a separate pane, so the isobath opacity slider does
     not drag it along. */
  ['a coastline layer is offered separately from the isobaths',
    !!overlayLabelled(/^\s*Coastline/) && !!overlayLabelled(/^\s*Isobaths/)],
  ['the isobath layer no longer draws its own coastline',
    !/coastline\.json/.test(bathyFetched.join(' ')) &&
      bathyLayersAt7.every((l) => /map-bathy/.test(l.options.className))],
  ['the shoreline sits above the isobaths, below the currents',
    bathyPaneZ('coast') > bathyPaneZ('bathy') &&
      bathyPaneZ('coast') < bathyPaneZ('currents')],
  ['isobaths sit above the scalar fields and below the currents',
    bathyPaneZ('bathy') > bathyPaneZ('sst') && bathyPaneZ('bathy') < bathyPaneZ('currents')],
  ['no tiles are requested below the threshold', noNewTilesBelowThreshold],
  ['contours survive panning past the date line', acrossDateLine > 0],
  ['and a view sitting on the seam shows both sides at once',
    straddling.west > 0 && straddling.east > 0],
  ['the opacity slider shows with the layer and moves the pane',
    bathySliderShown && bathyOpacityApplied],
  ['and the opacity it sets rides in the saved view', bathyOpacitySaved],
  ['borders + markers drawn', host.querySelectorAll('path').length > 200],
  ['layer switcher', host.querySelectorAll('.leaflet-control-layers-selector').length >= 10],
  ['bathymetry is the default base', !!host.querySelector('.leaflet-tile-pane .leaflet-layer')],
  ['view toggle', host.querySelectorAll('.om-view-toggle a').length === 3],
  /* The global reset. Checked by setting the map as far from default as the
     controls allow — a different basemap, a layer switched on, a pinned
     scale, a non-default colormap — and asserting every one of them comes
     back, including the stored view that would otherwise restore it all on
     the next reload. */
  ['reset puts basemap, layers, colour scale and saved view back',
    globalReset.basemapBack && globalReset.layersBack && globalReset.scaleBack &&
      globalReset.mapBack && globalReset.storageCleared],
  ['data pipeline completed', /assets reporting within/.test(status)],
  ['asset tracks drawn', host.querySelectorAll('path[stroke="#e8368f"], path[stroke="#f08c00"]').length >= assets.assets.length],
  ['glider colour is not the old teal', !host.querySelector('path[stroke="#0a7d8c"]')],
  ['hovering an asset names it',
    (assets.assets ?? []).some((a) => a.id === hoverLabel)],
  ['the label follows the pointer rather than anchoring', hoverFollowsPointer],
  ['hover label is gone once the pointer leaves', hoverCleared],
  ['popup shows deployment date', popupHtml.includes('Deployed')],
  /* An asset popup answers both halves of the same question now: what the
     platform is, and what water it is sitting in. Before, the second half
     was only reachable by right-clicking somewhere near it. */
  /* Positions are degrees and decimal minutes, to be compared against a
     chart or a GPS without arithmetic. Longitude is padded to three digits.
     The carry is the case that fails quietly: rounding the minutes before
     taking the degrees prints 45° 60.00′ instead of 46° 00.00′, which is
     both wrong and plausible. */
  ['asset positions are degrees and decimal minutes',
    /\d{2}° \d{2}\.\d{2}′ [NS], \d{3}° \d{2}\.\d{2}′ [EW]/.test(popupHtml)],
  ['minutes never reach 60', (() => {
    const host2 = host.querySelectorAll('.leaflet-popup-content');
    const all = [...host2].map((n) => n.textContent).join(' ') + popupHtml;
    return !/\d+° 60\.\d{2}′/.test(all) && !/\d+° 6[0-9]\.\d{2}′/.test(all);
  })()],
  ['asset popup reports the seafloor', /Seafloor/.test(popupHtml)],
  ['asset popup reports the current there', /Current/.test(popupHtml)],
  // -2431.5 from the stub, rounded: 2,432.
  ['asset popup fills the depth in from the service', /2,432 m deep/.test(popupDepth)],
  /* The row follows the layer. With the EEZ layer off — the default — a
     popup should carry no jurisdiction at all and should not have asked the
     gazetteer for one. */
  ['no jurisdiction row while the EEZ layer is off', popupEez === ''],
  ['and no request made for it either', gazetteerBeforeEez === null],
  ['a near miss falls outside the drawn dot', dotCoversOffset === false],
  [`tap target catches a miss by ${OFFSET} px`, targetCoversOffset === true],
  ['tap target opens the same detail as the dot', tapPopupMatches === true],
  [`argo hit tolerance catches a miss by ${OFFSET} px`, argoCoversOffset === true],
  ['measuring takes a click on an asset', measuringTookTheClick],
  ['measuring suppresses the asset popup', measuringSuppressedPopup],
  ['the measured point snaps to the asset, not the tap', measuredAtTheAsset],
  ['popup links the dataset', /href="https?:[^"]*erddap[^"]*"/i.test(popupHtml)],
  /* All three popup links are built by one helper, so checking the rendered
     one checks the mechanism. rel matters as much as target: without
     noopener the opened page can navigate this one through window.opener. */
  ['popup links open in their own tab', /target="_blank"/.test(popupHtml)],
  ['and cannot reach back through window.opener',
    /rel="[^"]*\bnoopener\b[^"]*"/.test(popupHtml)],
  ['a new tab is announced, not just shown',
    /aria-label="[^"]*opens in a new tab[^"]*"/.test(popupHtml)],
  // Theme-driven layers carry a class instead of a baked-in colour, so the
  // stylesheet can restyle them when the reader switches to dark mode.
  ['borders are theme-classed', host.querySelectorAll('path.map-border-country').length > 20],
  ['state lines are theme-classed', host.querySelectorAll('path.map-border-state').length > 20],
  ['track casings are theme-classed', host.querySelectorAll('path.map-casing').length > 0],
  ['asset markers are theme-classed', host.querySelectorAll('path.map-asset').length === assets.assets.length],
  ['no hardcoded border/casing colours left', !host.querySelector('path[stroke="#4a525c"], path[stroke="#6b7480"], path[stroke="#0d1218"], path[stroke="#8a949f"]')],
  // Zoom-to-storm buttons in the status line above the map.
  ['zoom buttons revealed for real storms', known.length > 0 && known.every((b) => !b.hidden)],
  ['no zoom button shown for a storm absent from the data', staleShown.length === 0],
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
  ['basemap tone follows the basemap actually showing', toneBeforeReset === 'light'],
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
  /* The status line is built twice — once by StormStatus.astro at build
     time, once here from fresh data — and the two drifting apart is the
     hazard that arrangement carries. Check both ends: the rebuilt link, and
     the markup Astro actually emitted into dist/. Checking only one would
     let the advisory open in place until the first refresh, or after it. */
  ['rebuilt advisory link opens in its own tab',
    [...stormBox.querySelectorAll('a[href]')].every(
      (a) => a.target === '_blank' && /\bnoopener\b/.test(a.rel)
    ) && stormBox.querySelectorAll('a[href]').length > 0],
  ['build-time advisory link matches it', (() => {
    const page = fs.readFileSync('dist/observations/hurricanes/index.html', 'utf8');
    /* Scoped to the status line. Matching every anchor that mentions NHC
       swept in the ordinary prose link in the page's source list, which is
       body copy and rightly navigates in place — the check failed on content,
       not on a regression.

       **No `length > 0` here, unlike the rebuilt check above.** That page is
       built from live data, and on a quiet day there are genuinely no
       tropical cyclones and so no links — which is a correct page, not a
       regression. It went unnoticed while the build read the same committed
       snapshot the fixture came from; moving the data out made the two
       diverge and the check failed the moment the last storm dissipated.
       The property under test is how an advisory link opens, so it is
       asserted of the links that exist. The rebuilt check keeps the
       existence half, because its fixture guarantees a storm. */
    const block = /<div[^>]*class="storm-status"[\s\S]*?<\/div>/.exec(page)?.[0] ?? '';
    const links = [...block.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    return links.every((tag) => /target="_blank"/.test(tag) && /\bnoopener\b/.test(tag));
  })()],
  ['argo fleet is loaded', fleet.length > 500],
  ['argo coverage is global', spansHemispheres && spansLongitudes],
  ['every float became a marker', argoMarkers === fleet.length && fleet.length > 500],
  ['argo dots reach the canvas', argoDrawn > 0],
  ['argo dots use the gated colour', argoColoured],
  /* Two thousand dots close into a sheet at globe zoom, so they shrink for
     the wide views. Checked through a real zoom rather than by calling the
     sizing function, since the restyle only happens if the zoomend handler
     is wired and setStyle actually carries a radius. */
  ['argo dots shrink for the global view',
    argoRadiusAt[2] > 0 && argoRadiusAt[8] > 0 && argoRadiusAt[2] < argoRadiusAt[8]],
  ['argo dots are outlined, which is what separates them from the particles', argoOutlined],
  /* Argo's window is deliberately not the shared one: a float surfaces once
     per ten-day cycle, so the five days that suit a glider hid half the
     fleet. It must be at least a full cycle, and must still follow the
     shared window upward if that is ever set longer. */
  ['floats are drawn on both sides of the date line',
    atDateLine.expected > 200 && atDateLine.drawn >= atDateLine.expected * 0.98],
  ['and still all present over the prime meridian',
    atGreenwich.expected > 200 && atGreenwich.drawn >= atGreenwich.expected * 0.98],
  ['argo window covers at least one float cycle', files.argo.historyDays >= 10],
  ['argo window is never shorter than the shared one',
    files.argo.historyDays >= assets.historyDays],
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
    /36° 30\.00′ N/.test(readoutHtml) && /074° 30\.00′ W/.test(readoutHtml)],
  ['the readout carries the current from the loaded grid, with no request',
    /Current at surface/.test(readoutHtml) && /m\/s toward/.test(readoutHtml)],
  ['a 60 m field is offered alongside the surface one', !!deepToggle],
  ['turning 60 m on turns the surface off', surfaceOffWithDeepOn],
  ['readout names the surface and reads the surface grid',
    /Current at surface/.test(surfaceRead) && /0\.50 m\/s/.test(surfaceRead)],
  ['readout names 60 m and reads the 60 m grid',
    /Current at 60 m/.test(deepRead) && /0\.10 m\/s/.test(deepRead) &&
    /11° 00\.00′ N/.test(deepRead)],
  ['the 60 m grid is published at 60 m', files['currents-60m'][0].header.depth === 60],
  ['the full set of colour scales is offered', scaleControls.options.length >= 20],
  /* The trailing "and the default is marker-safe" clause that used to hang
     off this one has moved to its own check below, where it belongs: the
     defaults are now deliberately outside the safe set and the rule that
     matters is that each such default is named in defaultExempt. */
  ['the standard maps are offered alongside the marker-safe ones',
    scaleControls.options.includes('jet') && scaleControls.options.includes('viridis') &&
      scaleControls.options.includes('cmo.thermal')],
  ['choosing a colour scale changes what is painted',
    !!scaleControls.before && !!scaleControls.afterMap &&
      scaleControls.before.join() !== scaleControls.afterMap.join()],
  ['a pinned range is honoured', String(scaleControls.pinned) === '5,9'],
  ['and survives panning to different water',
    String(scaleControls.pinnedAfterPan) === '5,9'],
  ['Auto hands the scale back to the view',
    !!scaleControls.backToAuto && String(scaleControls.backToAuto) !== '5,9'],
  ['with the layer on, the readout names the jurisdiction',
    /United States EEZ/.test(eezLayer.jurisdictionOn)],
  ['a point outside every EEZ reads as high seas, not an error',
    /high seas/.test(eezLayer.openOcean)],
  ['the EEZ query asks for the EEZ record alone, not the whole gazetteer',
    eezLayer.askedGazetteer],
  ['an EEZ boundary layer is offered, off by default',
    eezLayer.offered && eezLayer.offByDefault],
  ['EEZ boundaries sit above the fields and below the platforms',
    eezLayer.hasPane && eezLayer.belowMarkers],
  ['EEZ tiles come from Marine Regions', eezLayer.requested],
  ['a salinity layer is offered', salinity.offered],
  ['turning salinity on turns the temperature raster off', salinity.sstStillOn === false],
  ['the readout reports salinity in psu, not degrees',
    /Salinity/.test(salinity.readout) && /psu/.test(salinity.readout) &&
      !/Salinity[^]*°C/.test(salinity.readout)],
  ['the salinity key carries psu and its own ramp',
    /psu/.test(salinity.legend)],
  /* Tests the mechanism, not the water: assert the step the layer is using
     and that the bounds are multiples of it. An earlier version asserted a
     narrow span, which failed the moment the view included the Amazon plume
     at 20.5 psu — that was the data being right, not the code being wrong. */
  ['the salinity auto range is held to seawater, 29-39 psu',
    !!salinity.globalAuto && salinity.freshInView &&
      salinity.globalAuto[0] >= 29 && salinity.globalAuto[1] <= 39],
  ['but a range the reader pins by hand is not clamped',
    !!salinity.pinnedOutsideWindow &&
      salinity.pinnedOutsideWindow[0] === 10 && salinity.pinnedOutsideWindow[1] === 40],
  /* Both defaults are scales oceanography reads these fields with, and
     neither clears the markers — recorded in defaultExempt rather than
     reclassified, and test:contrast prints what each costs. Asserted here so
     the pair cannot drift apart: a default that is not marker-safe and not
     named is a default nothing is reporting on. */
  ['the fields open on jet and cmo.haline',
    palette.defaultColormap.sst === 'jet' &&
      palette.defaultColormap.sss === 'cmo.haline'],
  ['and every default outside the safe set is named in defaultExempt',
    Object.entries(palette.defaultColormap).every(
      ([field, map]) =>
        palette.markerSafe.includes(map) || (palette.defaultExempt ?? []).includes(field)
    )],
  ['salinity rounds to half a unit, where temperature rounds to whole ones',
    salinity.step === 0.5 &&
      !!salinity.range &&
      Number.isInteger(salinity.range[0] / 0.5) &&
      Number.isInteger(salinity.range[1] / 0.5) &&
      Number.isInteger(tropics.range?.[0]) && Number.isInteger(polar.range?.[1])],
  ['SST reaches native 1/12° resolution, not a regional subsample',
    nativeSst.dx === 0.08 && nativeSst.value === 21.5],
  ['an SST layer is offered for each source', !!sstOisstToggle && !!sstNavyToggle],
  /* Staleness has to be visible. The currents served a two-day-old model run
     while every check stayed green, and the only thing that gave it away was
     the run printed in the attribution. */
  ['the SST layer credits its source on screen',
    /(ESPC-D-V02|OISST)/.test(attributionBeforeReset)],
  /* The currents and the Navy fields come off the same model at the same
     hour, and with the quantity written into each string the control named
     ESPC twice on a line already long enough to wrap. A layer credits who
     published the data and when and nothing about itself, so the two
     strings are identical and Leaflet — which counts attributions by their
     text — shows one.

     The guard on `currentsOnWithNavy` is the whole check: without it this
     passes just as well when neither layer is on, which is how the first
     version of it passed against the duplicate it was written to catch. */
  ['both ESPC layers are on where this is measured', currentsOnWithNavy],
  ['a source shared by two layers is credited once',
    (sharedSourceAttribution.match(/ESPC-D-V02/g) ?? []).length === 1],
  ['and the run it came from is still on screen',
    /\d{4}-\d{2}-\d{2} \d{2}(:\d{2})?Z run/.test(sharedSourceAttribution)],
  /* The map publishes one forecast frame, so there is no lead control on
     screen to say the field is ahead of the reader's clock — the credit is
     the only thing that does. Without the valid time a T+36 field reads as
     the present, which is this project's oldest failure shape: a render that
     is wrong and says nothing. */
  ['and the hour it is valid for, with how far off it is',
    /valid \d{4}-\d{2}-\d{2} \d{2}(:\d{2})?Z \((now|[+-]\d+ h)\)/
      .test(sharedSourceAttribution)],
  ['the Navy SST file records which run it came from',
    typeof files['sst-navy'].header.modelRun === 'string' ||
      typeof JSON.parse(fs.readFileSync('scripts/fixtures/map/sst-navy.json', 'utf8')).header.modelRun === 'string'],
  ['switching SST on paints the raster', opaque > 5000],
  ['every painted pixel comes from the gated ramp', painted && strayColour === 0],
  ['the readout reports a sea surface temperature', /Sea surface/.test(oisstRead)],
  ['turning the Navy field on turns OISST off', oisstOffWithNavyOn],
  ['and the readout follows the field that is on',
    // 21.5 is the synthetic Navy tile; OISST there is real data, ~28.
    /21\.5 °C/.test(navyRead) && !/21\.5 °C/.test(oisstRead)],
  ['the temperature key appears with the layer', legendShown],
  ['no unpainted column at the 0/360 seam', seamGaps === 0],
  ['the range is whole degrees bounding the view',
    wholeDegrees(tropics.range) && wholeDegrees(polar.range)],
  ['and it follows the view rather than being fixed',
    !!tropics.range && !!polar.range &&
      (tropics.range[0] !== polar.range[0] || tropics.range[1] !== polar.range[1]) &&
      tropics.range[0] > polar.range[0]],
  ['the legend prints the range it is drawing',
    polar.label.includes(String(polar.range?.[0])) &&
      polar.label.includes(String(polar.range?.[1]))],
  ['the 60 m grid points only at 60 m products',
    files['currents-60m'][0].header.tileIndex.includes('-60m') &&
    files['currents-60m'][0].header.details.every((d) => d.url.includes('-60m'))],
  ['the readout asks NOAA for the depth at that point',
    (() => {
      // The geometry is percent-encoded JSON, so decode before matching.
      if (!identifyAtReadout) return false;
      const geom = decodeURIComponent(identifyAtReadout);
      return geom.includes('"y":36.5') && geom.includes('"x":-74.5');
    })()],
  /* With worldCopyJump off the centre can wander past ±180 after enough
     panning, and a stored view is read back much later. */
  /* ---- the wind field ---- */
  ['a wind layer is offered, off by default',
    !!windToggle && windToggle.querySelector('input')?.checked === false],
  /* Three particle fields share one ramp and one pane, so two at once is two
     sets of drifting lines with nothing to tell them apart — the same reason
     the two current depths exclude each other. */
  ['turning wind on turns both current fields off', currentsOffWithWind],
  /* The calibration, and the reason it is a check rather than a constant
     anyone can nudge: wind runs 27x the median current speed, so sharing the
     currents' DRIFT would streak it across the map — the exact runaway this
     harness already catches for the zoom scaling. Compared against the
     currents measured moments earlier at the same view, not a number written
     down once. */
  ['wind drifts at a readable rate, not 27x the currents',
    windPx > 0.05 && currentPx > 0.05 && windPx / currentPx < 4],
  /* All three fields share the amber ramp, so this line is the only thing on
     screen that says which of them is drawing. */
  ['the legend key names the field that is on',
    /current/i.test(flowKeyBefore) && /wind at 10\s*m/i.test(flowKeyWithWind)],
  /* **A current is named for where it goes, a wind for where it comes
     from.** The fixture blows due east at 12 m/s, so the honest report is
     "from 270" — "toward 90" would be exactly backwards and entirely
     plausible on screen. */
  ['the readout reports wind at its height, not a current',
    /Wind at 10 m/.test(windRead) && !/Current at/.test(windRead)],
  ['and in the meteorological convention, from rather than toward',
    /from 270°T/.test(windRead) && !/toward/.test(windRead)],
  ['and at the speed the grid actually holds', /12\.0 m\/s/.test(windRead)],
  ['the wind layer credits ECMWF, not the Navy',
    /ECMWF/.test(windAttribution) && !/ESPC/.test(windAttribution)],

  ['a wandered centre is folded before it is saved', (() => {
    host._map.setView([10, 312.5], 3, { animate: false });
    const saved = JSON.parse(window.sessionStorage.getItem('asset-map-view') ?? '{}');
    return host._map.getCenter().lng > 180 && saved.lng >= -180 && saved.lng <= 180;
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
const lens = openingSegments;
const at = (q) => (lens.length ? lens[Math.floor(lens.length * q)].toFixed(2) : 'n/a');
console.log(
  `particles: ${drawn.stroke} strokes, ${drawn.lineTo} segments — ` +
    `px/frame p10 ${at(0.1)} median ${at(0.5)} p90 ${at(0.9)} max ${at(0.999)}`
);
/* Speed and lifetime are only meaningful together — a trail is one times the
   other, so an over-long life and a runaway velocity look the same on
   screen. Print both, so tuning one is done with the other in view. */
{
  const cfg = Object.values(host._map._layers).find((l) => l.options?.particleAge);
  if (cfg) {
    const seconds = cfg.options.particleAge / cfg.options.frameRate;
    console.log(
      `particle life: ${cfg.options.particleAge} frames at ${cfg.options.frameRate}/s ` +
        `= ${seconds.toFixed(1)} s — trail ~${(seconds * cfg.options.frameRate * driftFar).toFixed(0)} px ` +
        `at the z5 p90`
    );
  }
}
console.log(
  `drift vs zoom: p90 ${driftNear.toFixed(2)} px/frame at z8, ${driftFar.toFixed(2)} at z5, ` +
    `${driftGlobe.toFixed(2)} at z2 ` +
    `(ratio ${driftRatio.toFixed(1)}, want < 4)`
);
console.log(
  `grids: inside region dx ${gridInsideRegion?.dx} · outside dx ${gridOutsideRegion?.dx} ` +
    `(coarse ${coarseHeader.dx}, fine ${fineHeader.dx})`
);
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
