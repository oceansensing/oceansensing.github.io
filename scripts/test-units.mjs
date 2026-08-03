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
  hourStamp,
  hoursAhead,
  initialBearing,
  spanText,
  stamp,
  wrapLongitude,
} from '../packages/ocean-map/geo.ts';
import { rampColour, rampStops } from '../packages/ocean-map/ramp.ts';
import { tileKeysFor } from '../packages/ocean-map/tiles.ts';
import { apply, matrix3d, unitSquareTo } from '../packages/ocean-map/warp.ts';
import {
  kmlColour,
  parseCoordinates,
  readKmz,
  summarise,
} from '../packages/ocean-map/kmz.ts';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

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

/* hourStamp exists to drop `:00` from a line that already wraps, and to keep
   the minutes whenever dropping them would lose something. Both halves, or
   the second one rots into "always drop the minutes". */
check('an hour stamp drops zero minutes', hourStamp('2026-08-04T00:00:00Z'), '2026-08-04 00Z');
check('an hour stamp keeps real minutes', hourStamp('2026-08-04T00:30:00Z'), '2026-08-04 00:30Z');
check('a missing hour stamp says so', hourStamp(undefined), 'unknown');

/* The clock is passed in rather than taken from Date.now(), so these cases
   are the same in a year's time — the frozen-fixture bug that took a
   scheduled run down once already. */
const NOW = Date.parse('2026-08-03T21:00:00Z');
check('a field ahead of the clock is signed', hoursAhead('2026-08-04T00:00:00Z', NOW), '+3 h');
check('a field behind the clock is signed', hoursAhead('2026-08-03T19:00:00Z', NOW), '-2 h');
check('the half hour either side reads as now', hoursAhead('2026-08-03T21:20:00Z', NOW), 'now');
check('rounding is to the nearest hour, not down', hoursAhead('2026-08-03T23:40:00Z', NOW), '+3 h');
check('no valid time, nothing claimed', hoursAhead(undefined, NOW), '');
check('an unparseable time claims nothing', hoursAhead('not a time', NOW), '');

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

// ---- KMZ ------------------------------------------------------------------

/* KML writes colours **aabbggrr** — alpha first, channels reversed from CSS.
   Read naively the sample's opaque red comes out blue, which is plausible
   enough to ship. */
check('an opaque KML red is red, not blue', kmlColour('ff0000ff'), { hex: '#ff0000', opacity: 1 });
check('a half-transparent green', kmlColour('7f00ff00'), { hex: '#00ff00', opacity: 127 / 255 });
check('a malformed colour is simply absent', kmlColour('nope'), undefined);
check('and so is a missing one', kmlColour(undefined), undefined);

// "lon,lat[,alt]" — altitude is read and dropped, and latitude is sanity-checked.
check('coordinates drop altitude', parseCoordinates('-75.5,36.5,0 -74,37,0'), [[-75.5, 36.5], [-74, 37]]);
check('an impossible latitude is refused', parseCoordinates('10,200 1,2'), [[1, 2]]);
check('empty coordinates are empty', parseCoordinates(undefined), []);

const parseXml = (text) => new (new JSDOM('').window.DOMParser)().parseFromString(text, 'application/xml');
const load = (f) => readKmz(new Uint8Array(fs.readFileSync(`scripts/fixtures/${f}`)), parseXml);

const survey = await load('survey.kmz');
check('the document keeps its name', survey.name, 'Survey plan');
check('every geometry is found', survey.features.length, 5);
check('geometry kinds', survey.features.map((f) => f.kind).sort(),
  ['line', 'line', 'point', 'point', 'polygon']);
check('folders are carried through',
  [...new Set(survey.features.map((f) => f.folder))].sort(), ['Areas', 'Legs']);

const leg = survey.features.find((f) => f.name === 'Leg 1');
/* Its styleUrl points at a StyleMap, whose "normal" pair points at the real
   style — following only the first hop leaves it unstyled. */
check('a StyleMap resolves to the normal style', leg.style.stroke, '#ff0000');
check('and carries the width', leg.style.strokeWidth, 3);
check('description markup is flattened to text', leg.description, 'CTD line\n12 stations');

const ring = survey.features.find((f) => f.name === 'Box');
check('a polygon keeps its holes', ring.coordinates.length, 2);
check('PolyStyle fill and outline switches are read',
  [ring.style.filled, ring.style.outlined], [true, false]);

/* MultiGeometry needs no special case, but each part has to become its own
   feature while keeping the placemark's name. */
check('MultiGeometry splits into its parts',
  survey.features.filter((f) => f.name === 'Both').map((f) => f.kind).sort(), ['line', 'point']);

/* Not drawn, and counted rather than dropped in silence — a partial render
   that says nothing is the failure this project keeps meeting. */
check('what cannot be drawn is counted',
  [survey.skipped.NetworkLink, survey.skipped.GroundOverlay], [1, 1]);
check('embedded resources are counted too', survey.skipped['embedded resource'], 1);
check('and summarised for the reader',
  summarise(survey).startsWith('5 features · skipped'), true);

// Stored rather than deflated, and not called doc.kml.
const stored = await load('stored.kmz');
check('an uncompressed entry reads too', stored.features.length, 5);
check('and a .kml under any name is found', stored.name, 'Survey plan');

// A bare .kml, which readers hand over as often as a .kmz.
const plain = await load('plain.kml');
check('a bare KML needs no unzipping', plain.features.length, 5);

// ---- GroundOverlay images -------------------------------------------------

const overlaid = await load('overlay.kmz');
check('overlay images come out of the archive', overlaid.overlays.length, 2);
check('with their bytes, not just a name',
  overlaid.overlays.every((o) => o.image instanceof Uint8Array && o.image.length > 0), true);
check('and a media type a browser will draw',
  [...new Set(overlaid.overlays.map((o) => o.mediaType))], ['image/png']);
check('the PNG signature survives the round trip',
  [...overlaid.overlays[0].image.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

/* drawOrder is the file's to decide, and Leaflet stacks within a pane by
   insertion order — so the decoder sorts rather than leaving it to chance. */
check('drawOrder decides the stacking', overlaid.overlays.map((o) => o.drawOrder), [1, 2]);
check('and the lower one is the "Under" overlay', overlaid.overlays[0].name, 'Under');

const chart = overlaid.overlays.find((o) => o.name === 'Survey chart');
check('LatLonBox edges are read',
  [chart.bounds.north, chart.bounds.south, chart.bounds.east, chart.bounds.west], [38, 36, -74, -76]);
check('rotation is carried through', chart.rotation, 30);
/* The overlay's own colour is white with alpha — KML uses it as an opacity
   for the image rather than a tint. */
check('colour alpha becomes opacity', Math.round(chart.opacity * 100) / 100, 0.7);
check('an overlay with no colour is opaque', overlaid.overlays[0].opacity, 1);

/* An absolute href is refused for the reason NetworkLink is: it would have a
   document the reader opened fetch from a host it names. */
check('an image hosted elsewhere is refused, and counted',
  overlaid.skipped['overlay image hosted elsewhere'], 1);
check('the archive image is not also counted as a spare resource',
  overlaid.skipped['embedded resource'], undefined);
check('images are summarised alongside features',
  /1 feature · 2 images/.test(summarise(overlaid)), true);

// ---- gx:LatLonQuad --------------------------------------------------------

const quadded = await load('quad.kmz');
check('a quad overlay is read', quadded.overlays.length, 1);
const swath = quadded.overlays[0];
check('four corners, in the file\'s order — SW, SE, NE, NW',
  swath.corners, [[-76, 36], [-73.5, 36.4], [-73, 38.2], [-75.8, 37.6]]);
check('a quad has no box', swath.bounds, undefined);
/* Its corners already carry the orientation, so there is no separate
   rotation to apply on top. */
check('and no rotation of its own', swath.rotation, 0);
check('alpha still becomes opacity', Math.round(swath.opacity * 100) / 100, 0.8);
/* Anything that is not four points is not a quadrilateral. */
check('a malformed quad is refused and counted', quadded.skipped.GroundOverlay, 1);

/* The warp itself: a projective transform has to land every corner exactly,
   or the image creeps away from its georeference at the edges. */
const quad = [[10, 20], [210, 40], [190, 180], [30, 140]];
const homography = unitSquareTo(quad);
const landed = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(homography, x, y));
check('the unit square lands on all four corners',
  landed.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]), quad);
/* Opposite edges not parallel is exactly what a box cannot express, so the
   projective terms must be non-zero — an affine fallback would look almost
   right and be wrong away from the corners. */
check('a non-parallelogram needs the projective terms',
  homography.g !== 0 && homography.h !== 0, true);
const rect = unitSquareTo([[0, 0], [100, 0], [100, 50], [0, 50]]);
check('but a plain rectangle stays affine', [rect.g, rect.h], [0, 0]);
check('a degenerate quad does not produce NaN',
  Object.values(unitSquareTo([[0, 0], [0, 0], [0, 0], [0, 0]])).every(Number.isFinite), true);
check('matrix3d emits sixteen values',
  matrix3d(200, 100, quad).replace(/matrix3d\(|\)/g, '').split(',').length, 16);

// A bare .kml names images that travelled beside it and are not here.
const plainOverlay = await load('plain.kml');
check('a bare KML has no images to give', plainOverlay.overlays.length, 0);

/* Descriptions carry arbitrary HTML and a file from a colleague or a portal is
   untrusted input even when the reader chose to open it. Markup is stripped
   rather than filtered — an allow-list is a thing to get subtly wrong. */
const hostile = await load('hostile.kmz');
const desc = hostile.features[0].description;
check('a script tag does not survive', /<script|onerror|<img/i.test(desc), false);
check('but the readable text does', desc.includes('safe text'), true);

console.log(
  failures
    ? `\n${failures} failing check(s) in the renderer-independent modules.`
    : '\nok    geo, ramp and tiles behave as their comments claim'
);
process.exit(failures ? 1 : 0);
