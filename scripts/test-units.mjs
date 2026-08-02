#!/usr/bin/env node
/**
 * The renderer-independent half of the map, tested directly.
 *
 *   npm run test:units
 *
 * These modules import neither Leaflet nor the DOM, so unlike test-map.mjs
 * this needs no build, no jsdom and no fixtures — it imports the TypeScript
 * through Node's own type stripping and calls the functions.
 *
 * Worth having separately from test:map, which exercises the same code only
 * through a rendered map: an off-by-one in the minute carry or a sign error
 * in the bearing is visible there as a slightly wrong string in a popup, if
 * at all. Here it is the assertion.
 *
 * Every edge case below is one the source comments claim to handle. A comment
 * saying "minutes carry into the degrees" is a promise; this is where it is
 * kept.
 */
import {
  coordText,
  ddm,
  elapsed,
  initialBearing,
  spanText,
  stamp,
  wrapLongitude,
} from '../src/lib/ocean-map/geo.ts';
import { rampColour, rampStops } from '../src/lib/ocean-map/ramp.ts';
import { tileKeysFor } from '../src/lib/ocean-map/tiles.ts';

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${what}` + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};
const near = (what, got, want, tol = 1e-6) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}` + (ok ? '' : `  got ${got}, want ${want}`));
};

// ---- degrees and decimal minutes -----------------------------------------

check('a plain position', coordText(37.5, -75.5), '37° 30.00′ N, 075° 30.00′ W');

/* The carry. 45.99999 deg is 59.9994', which rounds to 60.00' — printing it
   as `45° 60.00′` is the bug this guards, and it looks almost right. */
check('minutes carry into the degrees', ddm(45.99999, 'N', 'S', 2), '46° 00.00′ N');
check('and the carry survives in a full position',
  coordText(45.99999, -0.99999), '46° 00.00′ N, 001° 00.00′ W');

// Longitude is padded to three digits so a column of positions lines up.
check('longitude pads to three digits', ddm(-67.5, 'E', 'W', 3), '067° 30.00′ W');
check('latitude pads to two', ddm(7.25, 'N', 'S', 2), '07° 15.00′ N');
check('the equator reads north', ddm(0, 'N', 'S', 2), '00° 00.00′ N');
check('a southern position', coordText(-33.75, 18.5), '33° 45.00′ S, 018° 30.00′ E');

/* A track that has wrapped past the antimeridian carries longitudes past
   ±180; reporting 293°E rather than 067°W is the failure. */
check('a wrapped longitude is folded', coordText(10, 293), '10° 00.00′ N, 067° 00.00′ W');
check('and one wrapped the other way', coordText(10, -190), '10° 00.00′ N, 170° 00.00′ E');
check('exactly the antimeridian', wrapLongitude(180), -180);
check('a longitude two turns out', wrapLongitude(720 + 45), 45);

// It also accepts a {lat, lng} — which is what an L.LatLng is, structurally.
check('accepts a point object', coordText({ lat: 37.5, lng: -75.5 }), coordText(37.5, -75.5));

// ---- distance and bearing -------------------------------------------------

near('due north is 0°', initialBearing({ lat: 10, lng: 0 }, { lat: 20, lng: 0 }), 0, 1e-9);
near('due south is 180°', initialBearing({ lat: 20, lng: 0 }, { lat: 10, lng: 0 }), 180, 1e-9);
near('due east from the equator is 90°',
  initialBearing({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }), 90, 1e-9);
near('due west from the equator is 270°',
  initialBearing({ lat: 0, lng: 0 }, { lat: 0, lng: -10 }), 270, 1e-9);
/* Great-circle, not rhumb: NY to London leaves on about 051°, where a rhumb
   line would be about 078°. Getting this wrong yields a plausible number, so
   the check is against the value rather than the format. */
near('New York to London departs on ~51°T',
  initialBearing({ lat: 40.7128, lng: -74.006 }, { lat: 51.5072, lng: -0.1276 }), 51.2, 0.5);
near('bearing is never negative',
  initialBearing({ lat: 0, lng: 1 }, { lat: 0, lng: 0 }), 270, 1e-9);

// ---- spans ---------------------------------------------------------------

check('a short span keeps two decimals', spanText(1852), '1.85 km · 1.00 nm');
check('a medium span keeps one', spanText(50000), '50.0 km · 27.0 nm');
check('a long span is whole units', spanText(500000), '500 km · 270 nm');

// ---- timestamps ----------------------------------------------------------

check('a stamp is trimmed to the minute', stamp('2026-08-02T14:35:09Z'), '2026-08-02 14:35Z');
check('a missing stamp says so', stamp(undefined), 'unknown');
check('elapsed days count from one', elapsed('2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'), ' · day 12');
check('elapsed is empty without both ends', elapsed(undefined, '2026-08-02T00:00:00Z'), '');
check('a fix before deployment is not reported', elapsed('2026-08-10T00:00:00Z', '2026-08-01T00:00:00Z'), '');

// ---- colour ramps --------------------------------------------------------

check('hex stops parse to rgb', rampStops(['#000000', '#ff8800']), [[0, 0, 0], [255, 136, 0]]);
const bw = rampStops(['#000000', '#ffffff']);
check('the bottom of the range', rampColour(bw, 0, 0, 10), [0, 0, 0]);
check('the top of the range', rampColour(bw, 10, 0, 10), [255, 255, 255]);
check('the middle interpolates', rampColour(bw, 5, 0, 10), [127.5, 127.5, 127.5]);
check('below the range clamps', rampColour(bw, -50, 0, 10), [0, 0, 0]);
check('above the range clamps', rampColour(bw, 999, 0, 10), [255, 255, 255]);
/* A view of uniform water gives lo === hi. The span falls back to 1, so the
   value sits at the bottom of the ramp and the whole view paints one flat
   colour — which is honest for water that really is uniform. What matters is
   that it is a colour at all: without the fallback this divides by zero and
   every channel comes out NaN, which paints nothing and reports nothing. */
check('a zero-width range paints the bottom stop, not NaN', rampColour(bw, 5, 5, 5), [0, 0, 0]);
check('and none of its channels are NaN',
  rampColour(bw, 5, 5, 5).every(Number.isFinite), true);
const three = rampStops(['#000000', '#ff0000', '#ffffff']);
check('a mid stop is hit exactly', rampColour(three, 5, 0, 10), [255, 0, 0]);

// ---- which tiles a view needs --------------------------------------------

const INDEX = {
  size: 20,
  west: -180,
  south: -80,
  minZoom: 6,
  available: ['20_-80', '20_-100', '40_-80', '20_160', '20_-180', '0_0'],
};
const box = (south, west, north, east) => ({ south, west, north, east });

check('below the threshold no tiles are asked for',
  tileKeysFor(INDEX, 5, box(25, -75, 30, -70)), []);
check('a missing index asks for nothing', tileKeysFor(null, 9, box(25, -75, 30, -70)), []);
check('a view inside one tile', tileKeysFor(INDEX, 7, box(25, -75, 30, -70)), ['20_-80']);
check('a view straddling two takes both',
  tileKeysFor(INDEX, 7, box(25, -95, 30, -70)), ['20_-100', '20_-80']);
check('and one straddling a latitude seam',
  tileKeysFor(INDEX, 7, box(35, -75, 45, -70)), ['20_-80', '40_-80']);
/* A view whose edge lands exactly on a lattice line still takes the tile
   beyond it. That is the overlap convention rather than a correctness
   property — the shared edge has no width — but it is worth pinning: mutation
   showed `<=` could quietly become `<` with nothing noticing, and the cost of
   the wrong choice is a tier that drops out along seams while panning. */
check('a view ending exactly on a seam includes the tile beyond',
  tileKeysFor(INDEX, 7, box(25, -75, 40, -70)), ['20_-80', '40_-80']);
check('tiles the index does not list are skipped',
  tileKeysFor(INDEX, 7, box(25, -140, 30, -130)), []);

/* The date line. A view panned east past the antimeridian carries longitudes
   past 180, and the lattice starts at -180 — so the fold has to be a floored
   modulo, not a remainder, or half the world comes back negative and misses.
   This is the same arithmetic that had the isobaths drawing on one side only. */
check('a view past the antimeridian folds onto the lattice',
  tileKeysFor(INDEX, 7, box(25, 175, 30, 185)), ['20_160', '20_-180']);
/* Panned *west* past -180, which is the case that actually distinguishes a
   floored modulo from a remainder: going east the two agree, so a test that
   only pans east passes against the bug. Found by mutation — replacing the
   fold with `%` broke nothing until this line existed. */
check('and a view panned west past it',
  tileKeysFor(INDEX, 7, box(25, -185, 30, -175)), ['20_160', '20_-180']);
check('and one far past it',
  tileKeysFor(INDEX, 7, box(25, 355, 30, 365)), ['20_-20', '20_0'].filter((k) => INDEX.available.includes(k)));

/* A view wider than the world would name the same tile twice without the
   dedupe — which two of the three original copies of this function lacked. */
const wide = tileKeysFor(INDEX, 7, box(-10, -400, 10, 400));
check('a view spanning more than one turn lists each tile once',
  wide.length, new Set(wide).size);

console.log(
  failures
    ? `\n${failures} failing check(s) in the renderer-independent modules.`
    : '\nok    geo, ramp and tiles behave as their comments claim'
);
process.exit(failures ? 1 : 0);
