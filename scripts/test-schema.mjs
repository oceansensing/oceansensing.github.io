#!/usr/bin/env node
/**
 * Every published file, checked against the contract in schema.ts.
 *
 *   npm run test:schema
 *
 * The shapes of these files were agreed on by nothing: written by four Python
 * scripts, read by a TypeScript module that cast most of them to `any`. Both
 * of the worst data bugs in this project were drift across that gap, and both
 * showed up as a blank or wrong layer rather than an error — ERDDAP's empty
 * field where THREDDS writes NaN, and a time index that went out of range and
 * left a two-day-old model run being served while the build reported success.
 *
 * Checks what is on disk rather than a sample, so it runs against whatever the
 * pipelines last produced. In CI it is invoked twice, and deliberately: once
 * inside `verify`, which sees the committed snapshot, and again after the data
 * refresh steps, which is the only place fresh upstream drift can be caught.
 * `verify` runs before those steps.
 *
 * Absent files are skipped, not failed. The tiles are gitignored and built in
 * CI, so a local run legitimately has none of them.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAP = 'public/map';
let failures = 0;
let checked = 0;
const fail = (file, msg) => {
  failures++;
  console.log(`FAIL  ${file}: ${msg}`);
};

const read = (rel) => {
  const p = path.join(MAP, rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(rel, `is not valid JSON — ${e.message}`);
    return undefined;
  }
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
/* Always UTC with the trailing Z, and fractional seconds are allowed — the
   NHC and PMEL both publish them, which this first rejected. The Z is
   required rather than optional: a stamp without it parses as local time and
   is wrong by hours, which surfaces as a track drawn in the wrong place
   rather than as an error. */
const isTime = (v) =>
  isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(v);
const isLonLat = (v) =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) &&
  v[0] >= -360 && v[0] <= 360 && v[1] >= -90 && v[1] <= 90;

const field = (file, obj, key, ok, what, optional = false) => {
  if (obj[key] === undefined) {
    if (!optional) fail(file, `missing ${key}`);
    return;
  }
  if (!ok(obj[key])) fail(file, `${key} should be ${what}, got ${JSON.stringify(obj[key])?.slice(0, 40)}`);
};

// ---- ocean-assets.json ------------------------------------------------

const assets = read('ocean-assets.json');
if (assets) {
  checked++;
  const f = 'ocean-assets.json';
  field(f, assets, 'updated', isTime, 'an ISO timestamp');
  field(f, assets, 'historyDays', isNum, 'a number');
  field(f, assets, 'sources', (v) => v && typeof v === 'object', 'an object');
  for (const key of ['storms', 'assets']) field(f, assets, key, Array.isArray, 'an array');

  for (const s of assets.storms ?? []) {
    const at = `${f} storm ${s.id}`;
    for (const k of ['id', 'name', 'classification', 'advisoryUrl']) field(at, s, k, isStr, 'a string');
    /* Strings, not numbers, and deliberately: the NHC publishes these with
       qualifiers and a blank is a real answer. Parsing them to numbers would
       turn "no report" into zero. */
    for (const k of ['intensityKt', 'pressureMb'])
      field(at, s, k, (v) => typeof v === 'string', 'a string (blank is a real answer)');
    for (const k of ['lat', 'lon', 'movementDir', 'movementSpeedKt']) field(at, s, k, isNum, 'a number');
    field(at, s, 'lastUpdate', isTime, 'an ISO timestamp');
    for (const k of ['track', 'cone', 'history'])
      field(at, s, k, (v) => Array.isArray(v) && v.every(isLonLat), 'an array of [lon, lat]');
  }

  for (const a of assets.assets ?? []) {
    const at = `${f} asset ${a.id}`;
    for (const k of ['id', 'kind', 'title', 'institution', 'info']) field(at, a, k, isStr, 'a string');
    field(at, a, 'kind', (v) => v === 'usv' || v === 'glider', "'usv' or 'glider'");
    for (const k of ['deployed', 'time']) field(at, a, k, isTime, 'an ISO timestamp');
    for (const k of ['lat', 'lon']) field(at, a, k, isNum, 'a number');
    field(at, a, 'track', (v) => Array.isArray(v) && v.every(isLonLat), 'an array of [lon, lat]');
    field(at, a, 'where', isStr, 'a string', true);
  }
}

// ---- argo.json --------------------------------------------------------

const argo = read('argo.json');
if (argo) {
  checked++;
  const f = 'argo.json';
  field(f, argo, 'updated', isTime, 'an ISO timestamp');
  field(f, argo, 'source', isStr, 'a string');
  field(f, argo, 'floats', Array.isArray, 'an array');
  /* Its own window, and this is the one number here that is not a taste call:
     a float cycle is ten days, so the five-day window a glider wants would
     leave half the fleet off the map with nothing on screen to say so. */
  field(f, argo, 'historyDays', (v) => isNum(v) && v >= 10, 'at least 10 (a float cycle)');
  for (const p of (argo.floats ?? []).slice(0, 500)) {
    const at = `${f} float ${p.id}`;
    field(at, p, 'id', isStr, 'a string');
    field(at, p, 'time', isTime, 'an ISO timestamp');
    for (const k of ['lat', 'lon']) field(at, p, k, isNum, 'a number');
  }
}

// ---- gridded fields ---------------------------------------------------

const gridHeader = (f, h, { vector = false } = {}) => {
  for (const k of ['nx', 'ny', 'lo1', 'la1', 'dx', 'dy']) field(f, h, k, isNum, 'a number');
  field(f, h, 'refTime', isTime, 'an ISO timestamp');
  field(f, h, 'modelRun', isTime, 'an ISO timestamp', true);
  if (vector) for (const k of ['parameterCategory', 'parameterNumber']) field(f, h, k, isNum, 'a number');
  for (const d of h.details ?? []) {
    for (const k of ['west', 'east', 'south', 'north', 'minZoom', 'deg']) field(`${f} details`, d, k, isNum, 'a number');
    field(`${f} details`, d, 'url', isStr, 'a string');
    field(`${f} details`, d, 'label', isStr, 'a string');
  }
};

const gridBody = (f, header, data) => {
  if (!Array.isArray(data)) return fail(f, 'data should be an array');
  const want = header.nx * header.ny;
  /* The length has to match exactly. A ragged grid is what ERDDAP's empty
     fields produced, and it did not throw — the rows simply shifted west, so
     Antarctica came back 81 cells wide against 360 in open water and the map
     drew the wrong ocean in the right colours. */
  if (data.length !== want) fail(f, `data has ${data.length} values, but nx*ny is ${want}`);
  const bad = data.findIndex((v) => v !== null && !isNum(v));
  if (bad >= 0) fail(f, `data[${bad}] is ${JSON.stringify(data[bad])} — expected a number or null`);
};

for (const name of ['sst-oisst', 'sst-navy', 'sss-navy']) {
  const g = read(`${name}.json`);
  if (!g) continue;
  checked++;
  const f = `${name}.json`;
  if (!g.header) { fail(f, 'missing header'); continue; }
  gridHeader(f, g.header);
  field(f, g.header, 'units', isStr, 'a string');
  gridBody(f, g.header, g.data);
}

for (const name of ['currents', 'currents-60m']) {
  const g = read(`${name}.json`);
  if (!g) continue;
  checked++;
  const f = `${name}.json`;
  if (!Array.isArray(g) || g.length !== 2) {
    fail(f, `should be exactly two components (u, v), got ${Array.isArray(g) ? g.length : typeof g}`);
    continue;
  }
  for (const [i, part] of g.entries()) {
    gridHeader(`${f}[${i}]`, part.header, { vector: true });
    gridBody(`${f}[${i}]`, part.header, part.data);
  }
  /* A global grid must span a full turn of longitude — that is the exact
     condition leaflet-velocity uses to wrap particles across the
     antimeridian, and without it they pile up against the edge. */
  const h = g[0].header;
  if (Math.abs(h.nx * h.dx - 360) > h.dx) {
    fail(f, `spans ${(h.nx * h.dx).toFixed(2)}° of longitude; a global grid must span 360°`);
  }
}

// ---- tile indices -----------------------------------------------------

for (const dir of fs.existsSync(MAP) ? fs.readdirSync(MAP).filter((d) => d.includes('tiles')) : []) {
  const idx = read(path.join(dir, 'index.json'));
  if (!idx) continue;
  checked++;
  const f = `${dir}/index.json`;
  for (const k of ['size', 'west', 'south', 'minZoom']) field(f, idx, k, isNum, 'a number');
  field(f, idx, 'available', (v) => Array.isArray(v) && v.every(isStr), 'an array of keys');
  /* Keys are `<south>_<west>` on the lattice the index declares. A key off the
     lattice is a tile nothing will ever ask for. */
  for (const key of idx.available ?? []) {
    const [s, w] = String(key).split('_').map(Number);
    if (!Number.isFinite(s) || !Number.isFinite(w)) fail(f, `key ${key} is not <south>_<west>`);
    else if ((s - idx.south) % idx.size || (w - idx.west) % idx.size)
      fail(f, `key ${key} is off the ${idx.size}° lattice`);
  }
}

// ---- vector overlays --------------------------------------------------

const coast = read('coastline.json');
if (coast) {
  checked++;
  field('coastline.json', coast, 'rings', (v) => Array.isArray(v) && v.every((r) => Array.isArray(r) && r.every(isLonLat)), 'rings of [lon, lat]');
}
const bounds = read('boundaries.json');
if (bounds) {
  checked++;
  for (const k of ['countries', 'states'])
    field('boundaries.json', bounds, k, (v) => Array.isArray(v) && v.every((r) => Array.isArray(r) && r.every(isLonLat)), 'lines of [lon, lat]');
}

const bathy = read('bathy-deep.json');
if (bathy) {
  checked++;
  const f = 'bathy-deep.json';
  field(f, bathy, 'type', (v) => v === 'FeatureCollection', "'FeatureCollection'");
  field(f, bathy, 'features', Array.isArray, 'an array');
  let bad = 0;
  for (const ft of bathy.features ?? []) {
    if (
      ft?.type !== 'Feature' ||
      !isNum(ft?.properties?.d) ||
      ft?.geometry?.type !== 'LineString' ||
      !Array.isArray(ft?.geometry?.coordinates) ||
      ft.geometry.coordinates.length < 2
    ) bad++;
  }
  if (bad) fail(f, `${bad} feature(s) are not a LineString with a numeric depth`);
}

console.log(
  failures
    ? `\n${failures} problem(s) — a published file does not match schema.ts.`
    : `ok    ${checked} published file(s) match the contract in schema.ts`
);
process.exit(failures ? 1 : 0);
