#!/usr/bin/env node
/**
 * The Slocum decoder, against what dbdreader says about the same files.
 *
 *   npm run test:slocum
 *
 * Like test:units this needs no build and no jsdom — `packages/slocum`
 * imports neither the DOM nor anything else — so it runs the TypeScript
 * through Node's own type stripping and calls the functions.
 *
 * WHAT IT CHECKS AGAINST, AND WHY THAT IS THE ONLY HONEST OPTION
 * -------------------------------------------------------------
 * The Slocum binary format has no specification. Every reader of it,
 * including this one, is a reimplementation of the vendor's `dbd2asc`, and
 * a decoder that is subtly wrong does not fail: it produces floats, in the
 * right shape, in a plausible range. There is nothing on screen and nothing
 * in a type to say the third column is the wrong sensor.
 *
 * So the reference is `dbdreader`, recorded once into
 * `scripts/fixtures/slocum/reference.json` by `scripts/make-slocum-fixture.py`
 * — the same bargain `test:teos10` strikes with GSW. `SlocumIO.jl`, which
 * this package is ported from, was itself validated against dbdreader, so
 * agreeing here is agreeing with both.
 *
 * A FINGERPRINT, NOT A SUMMARY
 * ----------------------------
 * Each sensor's time and value arrays are compared by SHA-256 over their raw
 * IEEE-754 bytes. Every value, exactly, or it fails. A tolerance would be the
 * wrong instrument twice over: these are not computed quantities where a last
 * bit is debatable, they are bytes copied out of a file — and the failures
 * this format actually produces are whole-column shifts, which a loose
 * comparison of summary statistics can absorb.
 *
 * NaN is canonicalised to one bit pattern first. IEEE-754 does not specify a
 * NaN payload and there is no reason for CPython's and V8's to agree; without
 * this, identical data would fingerprint differently.
 *
 * THE FIXTURE FILES ARE REAL
 * --------------------------
 * One matched flight/science pair from the electa MARACOOS deployment
 * (VIMS/C4PO, May 2025), plus the two caches they need and one compressed
 * cache. Real rather than synthetic on the rule this repository learned from
 * the shapefile reader: a file written by the writer that matches this reader
 * agrees with it by construction and proves nothing. That rule earned its
 * keep immediately there, and the first thing these fixtures did here was
 * settle whether a 1-byte sensor is signed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { gunzipSync } from 'node:zlib';

import { openDbd, describe, readSeries } from '../packages/slocum/dbd.ts';
import { buildTable, interpolateAngleOnto, interpolateOnto, isAngular } from '../packages/slocum/table.ts';
import { toCsv, exportName, isoTime } from '../packages/slocum/csv.ts';
import { toNetcdf } from '../packages/slocum/netcdf.ts';
import { deriveSeawater } from '../packages/slocum/derive.ts';
import { familyOf, sortFileNames } from '../packages/slocum/index.ts';
import { decodeAtlas } from '../packages/teos10/atlas.ts';
import { parseSensorList, parseFileopenTime, readHeader } from '../packages/slocum/header.ts';
import { decompressStream, isCompressedName } from '../packages/slocum/lz4.ts';
import {
  isLatLonSensor,
  isValidNmea,
  nmeaToDecimal,
} from '../packages/slocum/nmea.ts';
import { MissingCacheError } from '../packages/slocum/types.ts';

const DIR = new URL('./fixtures/slocum/', import.meta.url);
const read = (name) => new Uint8Array(readFileSync(new URL(name, DIR)));
const text = (name) => readFileSync(new URL(name, DIR), 'utf8');

const reference = JSON.parse(text('reference.json'));

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${what}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`),
  );
};

/** The canonical quiet NaN, matching what the fixture recorder wrote. */
const CANONICAL_NAN = new Uint8Array([0, 0, 0, 0, 0, 0, 0xf8, 0x7f]);

const fingerprint = (values) => {
  const hash = createHash('sha256');
  const eight = new Uint8Array(8);
  const view = new DataView(eight.buffer);
  for (const v of values) {
    if (Number.isNaN(v)) {
      hash.update(CANONICAL_NAN);
    } else {
      view.setFloat64(0, v, true);
      hash.update(eight);
    }
  }
  return hash.digest('hex');
};

// ── The two data files, sensor by sensor ─────────────────────────────────────

for (const [name, want] of Object.entries(reference.files)) {
  console.log(`\n--- ${name} ---`);
  const crc = want.header.sensor_list_crc;
  const file = openDbd(read(name), { name, cache: text(`${crc}.cac`) });

  check(
    `${name}: the header reads as dbdreader read it`,
    {
      encoding_ver: file.header.encodingVer,
      sensors_per_cycle: file.header.sensorsPerCycle,
      state_bytes_per_cycle: file.header.stateBytesPerCycle,
      total_num_sensors: file.header.totalNumSensors,
      sensor_list_factored: file.header.sensorListFactored,
      sensor_list_crc: file.header.sensorListCrc,
      fileopen_time: file.header.fileopenTime,
    },
    {
      encoding_ver: want.header.encoding_ver,
      sensors_per_cycle: want.header.sensors_per_cycle,
      state_bytes_per_cycle: want.header.state_bytes_per_cycle,
      total_num_sensors: want.header.total_num_sensors,
      sensor_list_factored: want.header.sensor_list_factored,
      sensor_list_crc: want.header.sensor_list_crc,
      fileopen_time: want.header.fileopen_time,
    },
  );

  // Cycle order is the whole point: the state bytes address sensors by
  // position, so a list that holds the right sensors in the wrong order
  // decodes every one of them from another sensor's bytes.
  const wrongSensors = want.sensors
    .map((s, i) => {
      const got = file.sensors[i];
      if (got && got.name === s.name && got.unit === s.unit && got.bytes === s.bytes) return null;
      return { at: i, want: s, got: got ?? null };
    })
    .filter(Boolean);
  check(`${name}: the sensor list matches, in cycle order`, wrongSensors, []);
  check(`${name}: no extra sensors past the end of it`, file.sensors.length, want.sensors.length);

  // Every sensor, every value. A count mismatch of exactly one would be the
  // final cycle being dropped — the separator-terminates-rather-than-separates
  // bug, which is invisible any other way.
  const series = readSeries(file);
  const wrongCounts = [];
  const wrongTimes = [];
  const wrongValues = [];
  for (const s of series) {
    const w = want.params[s.name];
    if (!w) continue;
    if (s.time.length !== w.n) wrongCounts.push({ sensor: s.name, got: s.time.length, want: w.n });
    if (fingerprint(s.time) !== w.time) wrongTimes.push(s.name);
    if (fingerprint(s.value) !== w.value) wrongValues.push(s.name);
  }
  check(`${name}: every sensor emits as many values as dbdreader`, wrongCounts, []);
  check(`${name}: every sensor's time base is byte-identical`, wrongTimes, []);
  check(`${name}: every sensor's values are byte-identical`, wrongValues, []);

  // The initial cycle is Slocum's fully-UPDATED file-open state, not a
  // measurement. Both references drop it; keeping it is off by one, forever.
  const clock = readSeries(file, [file.timeName])[0];
  const kept = readSeries(file, [file.timeName], { skipInitialCycle: false })[0];
  check(
    `${name}: keeping the initial cycle adds exactly one`,
    kept.time.length - clock.time.length,
    1,
  );

  // NMEA conversion, gated separately from the decode. A decoder that read
  // the bytes correctly and converted position wrongly would otherwise pass
  // every check above.
  const wrongLatLon = [];
  for (const [sensor, w] of Object.entries(want.latlon)) {
    const raw = readSeries(file, [sensor])[0];
    const converted = Float64Array.from(raw.value, nmeaToDecimal);
    if (fingerprint(converted) !== w.value) wrongLatLon.push(sensor);
    if (!isLatLonSensor(sensor)) wrongLatLon.push(`${sensor} (not recognised as a position)`);
  }
  check(`${name}: NMEA positions convert as dbdreader converts them`, wrongLatLon, []);
}

// ── The compressed cache ─────────────────────────────────────────────────────

console.log('\n--- the compressed path ---');
{
  const want = reference.compressed;
  const blob = decompressStream(read(want.file));
  const sha = createHash('sha256').update(blob).digest('hex');
  check(`${want.file}: decompresses to the reference bytes`, sha, want.sha256);
  check(`${want.file}: to the reference length`, blob.length, want.bytes);

  // And that the bytes are a cache file rather than merely the right length:
  // the strongest thing available with no second implementation to compare
  // against is that it parses, and that its own counts agree with each other.
  const decoded = new TextDecoder('ascii').decode(blob);
  check(`${want.file}: begins as a sensor list`, decoded.slice(0, 60), want.head.slice(0, 60));
  const lines = decoded.split('\n').filter((l) => l.startsWith('s:'));
  const list = parseSensorList(decoded, lines.length);
  check(`${want.file}: parses, and its positions are contiguous from zero`, {
    namespace: list.all.length,
    active: list.sensors.length,
    firstName: list.all[0],
  }, {
    namespace: lines.length,
    active: list.sensors.length,
    firstName: 'sci_ad2cp_file_state',
  });

  check('a compressed name is recognised by its shape, not a list',
    ['x.scd', 'x.tcd', 'x.dcd', 'x.ccc', 'x.sbd', 'x.cac', 'noext'].map(isCompressedName),
    [true, true, true, true, false, false, false]);
}

// ── Things the decoder must refuse, and how it says so ───────────────────────

console.log('\n--- refusals ---');
{
  const sbd = 'electa-2025-120-1-169.sbd';

  // Far and away the commonest failure: the file is factored and the cache
  // was not supplied. Useless unless it names which cache.
  let missing = null;
  try {
    openDbd(read(sbd), { name: sbd });
  } catch (error) {
    missing = error;
  }
  check('a factored file with no cache is refused', missing instanceof MissingCacheError, true);
  check('and the refusal names the cache to go and find', missing?.crc, '0f682cb2');

  // The wrong cache is worse than none: it parses. Only the counts disagree.
  let wrong = '';
  try {
    openDbd(read(sbd), { name: sbd, cache: text('92610b65.cac') });
  } catch (error) {
    wrong = error.message;
  }
  check('the wrong cache file is refused, not decoded',
    /105 sensors, expected 2709/.test(wrong), true);

  let notSlocum = '';
  try {
    openDbd(new Uint8Array([0x50, 0x4b, 3, 4, 10, 10, 10, 10]), { name: 'a.zip' });
  } catch (error) {
    notSlocum = error.message;
  }
  check('a file that is not Slocum at all is refused', /Not a Slocum file|ends mid-line/.test(notSlocum), true);

  // A truncated preamble means the ASCII was believed and the binary was not
  // what it claimed. Every sentinel is checked for exactly this reason.
  const corrupt = read(sbd);
  const { asciiEnd } = readHeader(corrupt);
  corrupt[asciiEnd + 2] = 0xff; // break the byte-order marker
  let broken = '';
  try {
    openDbd(corrupt, { name: sbd, cache: text('0f682cb2.cac') });
  } catch (error) {
    broken = error.message;
  }
  check('a broken byte-order marker is refused', /byte-order marker/.test(broken), true);
}

// ── The small pure functions ─────────────────────────────────────────────────

console.log('\n--- formats and conversions ---');
{
  // asctime space-pads a single-digit day, so once the dockserver maps spaces
  // to underscores the 7th of a month has a doubled separator that the 17th
  // does not. Both must parse. The fixture is one of the affected days, which
  // is why this is not hypothetical.
  check('a space-padded single-digit day parses',
    parseFileopenTime('Wed_May__7_22:16:18_2025'), Date.UTC(2025, 4, 7, 22, 16, 18) / 1000);
  check('and a two-digit day parses the same way',
    parseFileopenTime('Sun_Jul_21_23:00:36_2024'), Date.UTC(2024, 6, 21, 23, 0, 36) / 1000);
  check('the fixture header agrees with its own filename (day 127 of 2025)',
    new Date(parseFileopenTime('Wed_May__7_22:16:18_2025') * 1000).toISOString(),
    '2025-05-07T22:16:18.000Z');
  check('an unparseable time is NaN rather than a wrong date',
    Number.isNaN(parseFileopenTime('not a time')), true);

  check('NMEA degrees and minutes convert', nmeaToDecimal(3812.9969).toFixed(6), '38.216615');
  check('and carry their sign', nmeaToDecimal(-7344.5).toFixed(6), (-73.741667).toFixed(6));
  check('a whole degree is unchanged by the minutes term', nmeaToDecimal(4500), 45);

  // dbdreader checks only the degree bound, so 5360.0 passes there and
  // converts to a clean 54.0 that nothing downstream can question.
  check('minutes of 60 or more are not a position', isValidNmea(5360, true), false);
  check('but 53 degrees 59.9 minutes is', isValidNmea(5359.9, true), true);
  check('a latitude past 90 degrees is not', isValidNmea(9100, true), false);
  check('while the same number as a longitude is', isValidNmea(9100, false), true);
  check('and the glider\'s no-fix sentinel is not', isValidNmea(69696969, true), false);
}

// ── One thing this cannot check, stated as a check ───────────────────────────

{
  // A 1-byte sensor is read as *signed*, following both dbdreader's C
  // extension and SlocumIO.jl. Nothing in these fixtures distinguishes that
  // from unsigned: every 1-byte value in them is 0, 1 or 2, and reading the
  // wrong signedness is a mutation that survives the whole suite above.
  //
  // So the limit is asserted rather than written in a comment. If a fixture
  // ever carries a 1-byte value past 127 this fails, and whoever sees it can
  // delete this and gate the real thing instead.
  const observed = [];
  for (const [name, want] of Object.entries(reference.files)) {
    const file = openDbd(read(name), { name, cache: text(`${want.header.sensor_list_crc}.cac`) });
    const oneByte = file.sensors.filter((s) => s.bytes === 1).map((s) => s.name);
    for (const s of readSeries(file, oneByte)) {
      for (const v of s.value) if (Number.isFinite(v)) observed.push(Math.abs(v));
    }
  }
  check('no 1-byte value in the fixtures reaches 128, so signedness is untested here',
    observed.length > 0 && Math.max(...observed) < 128, true);
}

// ── describe() reads a header without needing the cache ──────────────────────

{
  const header = describe(read('electa-2025-120-1-169.tbd'), 'electa-2025-120-1-169.tbd');
  check('a header can be read before the cache is found', header.sensorListCrc, '92610b65');
}

// ── The table, and what it promises about not inventing anything ─────────────

console.log('\n--- the table ---');

const SBD = 'electa-2025-120-1-169.sbd';
const TBD = 'electa-2025-120-1-169.tbd';
const flight = openDbd(read(SBD), { name: SBD, cache: text('0f682cb2.cac') });
const science = openDbd(read(TBD), { name: TBD, cache: text('92610b65.cac') });
const allSeries = [...readSeries(flight), ...readSeries(science)];
const table = buildTable(allSeries);

{
  // The union join's whole claim is that it loses nothing. Checked by
  // counting: every value a sensor reported has to be somewhere in its
  // column, and no column may hold more than its sensor reported.
  const wrong = [];
  for (const s of allSeries) {
    if (s.time.length === 0) continue;
    const name = table.columns.some((c) => c.name === s.name)
      ? s.name
      : `${s.name}_${s.from.split('.').pop()}`;
    const column = table.columns.find((c) => c.name === name);
    if (!column) {
      wrong.push(`${s.name}: no column`);
      continue;
    }
    let placed = 0;
    for (const v of column.values) if (!Number.isNaN(v)) placed++;
    let reported = 0;
    for (const v of s.value) if (!Number.isNaN(v)) reported++;
    if (placed !== reported) wrong.push(`${name}: ${placed} placed, ${reported} reported`);
  }
  check('a union table places every recorded value and invents none', wrong, []);

  // The sensor both computers write. Merging these would put a 4-sample relay
  // and an 853-sample profile under one heading.
  const both = table.columns.filter((c) => c.name.startsWith('sci_water_pressure'));
  check('a sensor written by both computers becomes two named columns',
    both.map((c) => c.name).sort(), ['sci_water_pressure_sbd', 'sci_water_pressure_tbd']);
  check('and the reader is told why', table.notes.some((n) => /both computers/.test(n)), true);

  const scienceCopy = both.find((c) => c.name.endsWith('_tbd'));
  let finite = 0;
  let deepest = 0;
  for (const v of scienceCopy.values) if (Number.isFinite(v)) { finite++; if (v > deepest) deepest = v; }
  check('the science copy is the full-rate one', finite, 853);
  check('and it reaches the dive depth dbdreader reports',
    Math.round(deepest * 10 * 10) / 10, 125.2);

  // Rows are the union of every sensor's own times, so the count is the
  // number of distinct stamps rather than the sum.
  const stamps = new Set();
  for (const s of allSeries) for (const t of s.time) if (Number.isFinite(t)) stamps.add(t);
  check('rows are the distinct times, not the sum of the samples', table.rows, stamps.size);
}

{
  const onto = buildTable(allSeries, { join: 'interpolate', base: 'sci_m_present_time' });
  check('interpolating uses the named sensor\'s own time base',
    onto.rows, science.sensors.length > 0
      ? readSeries(science, ['sci_m_present_time'])[0].time.length : -1);
  check('and says so, because none of those values were recorded',
    onto.notes.some((n) => /not a value the glider recorded/.test(n)), true);

  const t = Float64Array.from([0, 1, 2, 3]);
  const src = Float64Array.from([1, 3]);
  check('linear interpolation is linear between its samples',
    [...interpolateOnto(t, src, Float64Array.from([10, 30]))], [NaN, 10, 20, 30]);
  check('and refuses to extrapolate past either end',
    [...interpolateOnto(Float64Array.from([-1, 4]), src, Float64Array.from([10, 30]))],
    [NaN, NaN]);
  check('a single sample gives nothing to interpolate between',
    [...interpolateOnto(t, Float64Array.from([1]), Float64Array.from([10]))],
    [NaN, NaN, NaN, NaN]);

  // 350° to 10° passes through north, not through south. The contrast is the
  // check: linear interpolation of the raw radians gives 180°, pointing
  // exactly backwards, and nothing in the output would say so.
  const at = Float64Array.from([1.5]);
  const when = Float64Array.from([1, 2]);
  const headings = Float64Array.from([(350 * Math.PI) / 180, (10 * Math.PI) / 180]);
  const wrapped = (interpolateAngleOnto(at, when, headings)[0] * 180) / Math.PI;
  const naive = (interpolateOnto(at, when, headings)[0] * 180) / Math.PI;
  check('a heading interpolates across north',
    Math.min(Math.abs(wrapped - 0), Math.abs(wrapped - 360)) < 1, true);
  check('where interpolating the raw angle would point exactly backwards',
    Math.abs(naive - 180) < 1, true);
  check('and due north comes back as 0, not as 2 pi',
    interpolateAngleOnto(at, when, headings)[0] < Math.PI, true);

  // The function above being right is not the same as `buildTable` reaching
  // for it, and that dispatch is one `isAngular` call that a refactor could
  // drop with nothing on screen to say so. Synthetic series, because the
  // point is the routing rather than the decode: the fixture's own heading
  // happens not to cross north, so it could not tell the two apart.
  const clock = { name: 'm_present_time', unit: 'timestamp', from: 'x.sbd',
    time: Float64Array.from([1, 1.5, 2]), value: Float64Array.from([1, 1.5, 2]) };
  const heading = { name: 'm_heading', unit: 'rad', from: 'x.sbd',
    time: Float64Array.from([1, 2]), value: headings };
  const plain = { name: 'm_depth', unit: 'm', from: 'x.sbd',
    time: Float64Array.from([1, 2]), value: Float64Array.from([0, 100]) };
  const routed = buildTable([clock, heading, plain],
    { join: 'interpolate', base: 'm_present_time' });
  const midHeading = (routed.columns.find((c) => c.name === 'm_heading').values[1] * 180) / Math.PI;
  check('buildTable sends a heading through the angular path',
    Math.min(Math.abs(midHeading - 0), Math.abs(midHeading - 360)) < 1, true);
  check('and leaves an ordinary sensor on the linear one',
    routed.columns.find((c) => c.name === 'm_depth').values[1], 50);
  check('an angular sensor is recognised by name, not by its unit',
    ['m_heading', 'c_heading', 'm_water_vx', 'm_fin', 'm_pitch'].map(isAngular),
    [true, true, false, false, false]);

  // A deployment is hundreds of segments off the same computer, and the same
  // sensor in each is one record continued — one column, not one per file.
  // The fixture is a single segment, so this is the only thing that exercises
  // the concatenation, and the segments are handed over out of order because
  // a reader's file picker gives them in whatever order it likes.
  const seg = (file, times) => ({
    name: 'sci_water_temp', unit: 'degc', from: file,
    time: Float64Array.from(times), value: Float64Array.from(times, (t) => t * 10),
  });
  const spliced = buildTable([
    seg('g-2025-120-1-2.tbd', [30, 40]),
    seg('g-2025-120-1-1.tbd', [10, 20]),
  ]);
  check('the same sensor across segments becomes one column',
    spliced.columns.length, 1);
  check('and its samples end up in time order however the files arrived',
    [...spliced.columns[0].values], [100, 200, 300, 400]);

  // The union join places each value by its own time, so it would look right
  // even if the concatenated series were left jumbled. Interpolation is where
  // the ordering is load-bearing: it walks the source forwards and a series
  // that goes backwards mid-way silently stops producing values.
  const jumbled = buildTable(
    [
      seg('g-2025-120-1-2.tbd', [30, 40]),
      seg('g-2025-120-1-1.tbd', [10, 20]),
      { name: 'sci_m_present_time', unit: 'timestamp', from: 'g-2025-120-1-1.tbd',
        time: Float64Array.from([15, 25, 35]), value: Float64Array.from([15, 25, 35]) },
    ],
    { join: 'interpolate', base: 'sci_m_present_time' },
  );
  check('interpolating a sensor spliced from several segments walks it in order',
    [...jumbled.columns.find((c) => c.name === 'sci_water_temp').values],
    [150, 250, 350]);
  check('while the two computers stay two columns',
    buildTable([seg('g-2025-120-1-1.tbd', [10]), seg('g-2025-120-1-1.sbd', [20])])
      .columns.map((c) => c.name).sort(),
    ['sci_water_temp_sbd', 'sci_water_temp_tbd']);
}

// ── CSV ──────────────────────────────────────────────────────────────────────

console.log('\n--- csv ---');
{
  const csv = toCsv(table);
  const lines = csv.trimEnd().split('\n');
  check('one header row and one row per table row', lines.length, table.rows + 1);
  check('the heading carries the units the glider gave',
    lines[0].includes('sci_water_temp_tbd (degc)') || lines[0].includes('sci_water_temp (degc)'), true);
  check('the first two columns are the time, twice', lines[0].startsWith('time,time_utc,'), true);

  // Blank, not zero and not NaN. A union table is mostly blank and the
  // difference between "not recorded" and "recorded as zero" is the whole
  // reason this join exists.
  const cells = lines[1].split(',');
  check('a sensor that did not report leaves an empty field', cells.includes(''), true);
  check('and nothing is written as NaN', /NaN/.test(csv), false);

  check('a time round-trips to ISO and back',
    isoTime(1746656184.004), '2025-05-07T22:16:24.004Z');
  // The ordinary case is a matched pair, which is one segment in two files.
  check('a matched pair is named for the segment, not as a span of one',
    exportName([SBD, TBD], 'csv'), 'electa-2025-120-1-169.csv');
  check('and one file keeps its own name', exportName([SBD], 'nc'), 'electa-2025-120-1-169.nc');
  check('while several segments give the span they cover',
    exportName(['g-2025-120-1-1.sbd', 'g-2025-120-1-1.tbd', 'g-2025-120-1-9.sbd'], 'csv'),
    'g-2025-120-1-1_to_g-2025-120-1-9.csv');
}

// ── netCDF ───────────────────────────────────────────────────────────────────

console.log('\n--- netcdf ---');
{
  const bytes = toNetcdf(table, { title: 'fixture', sources: [SBD, TBD] });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  check('it is a classic netCDF file',
    [...bytes.slice(0, 4)], [0x43, 0x44, 0x46, 0x01]);
  check('with no record dimension, so numrecs is zero', view.getInt32(4, false), 0);
  check('one dimension, named time, of the table\'s length', {
    tag: view.getInt32(8, false),
    count: view.getInt32(12, false),
    nameLength: view.getInt32(16, false),
    name: new TextDecoder().decode(bytes.subarray(20, 24)),
    length: view.getInt32(24, false),
  }, { tag: 0x0a, count: 1, nameLength: 4, name: 'time', length: table.rows });

  // The real risk in a hand-written netCDF is the offsets: every `begin` is
  // patched after the header is sized, and one wrong pad puts a variable's
  // data a few bytes out — which reads as plausible numbers, not as a
  // corrupt file. So the file is walked by its own header and each variable's
  // data compared with the column it came from.
  //
  // The layout was separately confirmed by reading a file of this fixture
  // with scipy.io.netcdf_file, which is an implementation nobody here wrote.
  // This check is what keeps it true.
  const parsed = readNetcdf(bytes);
  check('every variable the table has is in the file',
    parsed.variables.length, table.columns.length + 1);
  check('the time variable holds the table\'s times',
    [...parsed.read('time').slice(0, 3)], [...table.time.slice(0, 3)]);

  const mismatched = [];
  for (const column of table.columns) {
    const safe = column.name.replace(/[^A-Za-z0-9_]/g, '_');
    const got = parsed.read(safe);
    if (!got) { mismatched.push(`${safe}: absent`); continue; }
    for (let i = 0; i < table.rows; i++) {
      const a = got[i];
      const b = column.values[i];
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
        mismatched.push(`${safe}: row ${i} is ${a}, should be ${b}`);
        break;
      }
    }
  }
  check('and every value in it is at the offset its header claims', mismatched, []);

  check('the units attribute on time is genuinely udunits',
    parsed.attrOf('time', 'units'), 'seconds since 1970-01-01T00:00:00Z');
  check('a Slocum unit string is carried verbatim, not translated',
    parsed.attrOf('sci_water_temp_tbd', 'units') ?? parsed.attrOf('sci_water_temp', 'units'),
    'degc');
  check('and the file does not claim CF conventions it does not meet',
    parsed.globals.Conventions ?? null, null);
  check('while saying where its units came from',
    /not udunits/.test(parsed.globals.units_note ?? ''), true);
}

// ── Derived seawater ─────────────────────────────────────────────────────────

console.log('\n--- derived seawater ---');
{
  const withoutAtlas = deriveSeawater(table);
  check('with no atlas the salinity column is named Reference Salinity',
    withoutAtlas.columns.map((c) => c.name), [
      'salinity_practical', 'salinity_reference', 'temperature_conservative',
      'density', 'sigma0', 'sound_speed',
    ]);
  check('and it says why, rather than leaving the substitution to be assumed',
    withoutAtlas.notes.some((n) => /Reference Salinity, not Absolute Salinity/.test(n)), true);
  check('every derived column is labelled as derived',
    withoutAtlas.columns.every((c) => c.source === 'derived'), true);

  const gz = readFileSync(new URL('../public/teos10/saar.bin.gz', import.meta.url));
  const raw = gunzipSync(gz);
  const atlas = decodeAtlas(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const withAtlas = deriveSeawater(table, { atlas });
  check('with the atlas and a position it is Absolute Salinity',
    withAtlas.columns[1].name, 'salinity_absolute');

  const sp = withAtlas.columns[0].values;
  const sa = withAtlas.columns[1].values;
  const sr = withoutAtlas.columns[1].values;
  let maxAnomaly = 0;
  for (let i = 0; i < sa.length; i++) {
    if (Number.isFinite(sa[i]) && Number.isFinite(sr[i])) {
      maxAnomaly = Math.max(maxAnomaly, Math.abs(sa[i] - sr[i]));
    }
  }
  // The anomaly is real but small on this shelf; the North Pacific reaches
  // 0.03 g/kg. A zero here would mean the atlas was never consulted.
  check('the anomaly is applied, and is the size the North Atlantic shelf gives',
    maxAnomaly > 1e-5 && maxAnomaly < 0.01, true);

  // Every derived value against what the water actually is. These would not
  // catch a subtle error and they catch every gross one — a conductivity
  // read as S/m instead of mS/cm puts salinity near 3.
  const range = (values) => {
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    for (const v of values) if (Number.isFinite(v)) { n++; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { n, lo, hi };
  };
  const salt = range(sp);
  check('practical salinity is Mid-Atlantic Bight shelf water',
    salt.n === 853 && salt.lo > 30 && salt.hi < 36, true);
  const dens = range(withAtlas.columns[3].values);
  check('density is seawater at one atmosphere',
    dens.lo > 1020 && dens.hi < 1030, true);
  const sound = range(withAtlas.columns[5].values);
  check('sound speed is in the right few tens of m/s',
    sound.lo > 1450 && sound.hi < 1550, true);
  const ct = range(withAtlas.columns[2].values);
  check('and Conservative Temperature tracks the thermocline the CTD saw',
    ct.lo > 7 && ct.lo < 9 && ct.hi > 16 && ct.hi < 18, true);

  // Slocum writes pressure in bar and TEOS-10 wants dbar. Getting that ×10
  // wrong moves density by about half a unit — inside every range above, so
  // none of them would notice. What does notice is the gap between in-situ
  // density and sigma0, which *is* the compression: ~0.57 kg/m³ over this
  // dive's 125 dbar, and a tenth of that if the pressure were read as bar.
  const rho = withAtlas.columns[3].values;
  const sig = withAtlas.columns[4].values;
  let compression = 0;
  for (let i = 0; i < rho.length; i++) {
    if (Number.isFinite(rho[i]) && Number.isFinite(sig[i])) {
      compression = Math.max(compression, rho[i] - 1000 - sig[i]);
    }
  }
  check('pressure reaches TEOS-10 in dbar, not the bar the glider wrote',
    compression > 0.4 && compression < 0.8, true);
}

// ── Naming files ─────────────────────────────────────────────────────────────

console.log('\n--- file names ---');
{
  check('the two computers are told apart by extension',
    ['a.sbd', 'a.mbd', 'a.dbd', 'a.tbd', 'a.nbd', 'a.ebd', 'a.dcd', 'a.ecd', 'a.cac', 'a.ccc', 'a.txt']
      .map(familyOf),
    ['flight', 'flight', 'flight', 'science', 'science', 'science',
      'flight', 'science', 'cache', 'cache', 'unknown']);

  // Packing the four fields into one integer gives the segment three digits,
  // and deployments run past 999 routinely — 1000 then sorts before 999.
  check('segments past 999 still sort after them',
    sortFileNames(['g-2025-120-1-1000.sbd', 'g-2025-120-2-1.sbd', 'g-2025-120-1-999.sbd']),
    ['g-2025-120-1-999.sbd', 'g-2025-120-1-1000.sbd', 'g-2025-120-2-1.sbd']);
  check('and a day boundary sorts before a segment',
    sortFileNames(['g-2025-121-1-1.sbd', 'g-2025-120-1-400.sbd']),
    ['g-2025-120-1-400.sbd', 'g-2025-121-1-1.sbd']);
}

/**
 * A minimal netCDF-3 classic reader, so the writer is checked by walking the
 * file the way any other reader would rather than by trusting it.
 */
function readNetcdf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 4;
  const int = () => { const v = view.getInt32(at, false); at += 4; return v; };
  const pad = () => { at += (4 - (at % 4)) % 4; };
  const str = () => {
    const n = int();
    const s = new TextDecoder().decode(bytes.subarray(at, at + n));
    at += n;
    pad();
    return s;
  };
  const attrs = () => {
    const tag = int();
    const n = int();
    const out = {};
    if (tag === 0 && n === 0) return out;
    for (let i = 0; i < n; i++) {
      const name = str();
      const type = int();
      const count = int();
      if (type === 2) {
        out[name] = new TextDecoder().decode(bytes.subarray(at, at + count));
        at += count;
        pad();
      } else if (type === 6) {
        const values = [];
        for (let k = 0; k < count; k++) { values.push(view.getFloat64(at, false)); at += 8; }
        out[name] = values;
      } else {
        throw new Error(`netCDF reader: unexpected attribute type ${type}`);
      }
    }
    return out;
  };

  int(); // numrecs
  const dims = [];
  if (int() === 0x0a) {
    const n = int();
    for (let i = 0; i < n; i++) dims.push({ name: str(), length: int() });
  } else {
    at += 4;
  }
  const globals = attrs();

  const variables = [];
  if (int() === 0x0b) {
    const n = int();
    for (let i = 0; i < n; i++) {
      const name = str();
      const rank = int();
      const dimIds = [];
      for (let k = 0; k < rank; k++) dimIds.push(int());
      const attributes = attrs();
      const type = int();
      const size = int();
      const begin = int();
      variables.push({ name, dimIds, attributes, type, size, begin });
    }
  }

  return {
    dims,
    globals,
    variables,
    attrOf(name, key) {
      return variables.find((v) => v.name === name)?.attributes[key];
    },
    read(name) {
      const v = variables.find((x) => x.name === name);
      if (!v) return null;
      const count = v.size / 8;
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat64(v.begin + i * 8, false);
      return out;
    },
  };
}

console.log(
  failures
    ? `\n${failures} failing check(s) in the Slocum decoder.`
    : '\nok    the Slocum decoder agrees with dbdreader, and the table, CSV and netCDF hold',
);
process.exit(failures ? 1 : 0);
