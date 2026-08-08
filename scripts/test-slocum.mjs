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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gunzipSync } from 'node:zlib';

import { openDbd, describe, readSeries } from '../packages/slocum/dbd.ts';
import { buildTable, interpolateAngleOnto, interpolateOnto, isAngular, orderColumns } from '../packages/slocum/table.ts';
import { toCsv, exportName, isoTime } from '../packages/slocum/csv.ts';
import { toNetcdf } from '../packages/slocum/netcdf.ts';
import { deriveSeawater } from '../packages/slocum/derive.ts';
import { familyOf, gliderOf, homeOf, sortFileNames } from '../packages/slocum/index.ts';
import {
  buildOg1,
  derivePhase,
  missingFields,
  og1FileName,
  sensorVariableName,
  stampCompact,
  OG1_DEFAULTS,
  OG1_FIELDS,
} from '../packages/slocum/og1.ts';
import { toCdl } from '../packages/slocum/cdl.ts';
import {
  splitDeployments,
  deploymentLabel,
  deploymentStem,
} from '../packages/slocum/deployment.ts';
import { writeNetcdf } from '../packages/slocum/netcdf.ts';
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

  // The decimated file the glider transmits and the full one recovered from
  // it are the *same* record at two resolutions, not two records. Keying the
  // grouping on the extension made them two, so a reader who dropped both
  // after a recovery got every science sensor twice — with a note claiming
  // they came from "both computers", which they did not.
  const shared = buildTable([
    seg('g-2025-120-1-1.tbd', [10, 30]),          // what came over Iridium
    seg('g-2025-120-1-1.ebd', [10, 20, 30, 40]),  // what was recovered
  ]);
  check('a tbd and the ebd it was decimated from give one column, not two',
    shared.columns.map((c) => c.name), ['sci_water_temp']);
  check('and the samples they share are merged rather than repeated',
    [...shared.columns[0].values], [100, 200, 300, 400]);
  // ── the glider, which is the level above the computer ──
  //
  // A fleet directory holds `m_depth` for every vehicle in it. Leave the
  // glider out of the key and they merge into one column, interleaved and
  // looking exactly like data.
  const vehicle = (name, glider, file, times) => ({
    name, unit: 'm', glider, from: file,
    time: Float64Array.from(times), value: Float64Array.from(times, (t) => t * 10),
  });

  const fleet = buildTable([
    vehicle('m_depth', 'electa', 'electa-2025-120-1-1.sbd', [10, 20]),
    vehicle('m_depth', 'unit_507', 'unit_507-2025-120-1-1.sbd', [10, 20]),
  ]);
  check('two gliders\' sensors of one name stay two columns',
    fleet.columns.map((c) => c.name).sort(), ['m_depth_electa', 'm_depth_unit_507']);
  check('and neither loses samples to the other',
    fleet.columns.map((c) => [...c.values].filter(Number.isFinite).length), [2, 2]);

  // Both levels at once: glider first, then the file within it.
  const both3 = buildTable([
    vehicle('sci_water_pressure', 'electa', 'electa-2025-120-1-1.tbd', [10]),
    vehicle('sci_water_pressure', 'electa', 'electa-2025-120-1-1.sbd', [10]),
    vehicle('sci_water_pressure', 'unit_507', 'unit_507-2025-120-1-1.tbd', [10]),
  ]);
  check('a name claimed by two gliders and two computers says both',
    both3.columns.map((c) => c.name).sort(),
    ['sci_water_pressure_electa_sbd', 'sci_water_pressure_electa_tbd',
     'sci_water_pressure_unit_507']);

  // The vehicle comes from the header, not the name on disk, so a renamed
  // file still reports the glider that wrote it.
  {
    const renamedFile = openDbd(read(SBD), { name: 'whatever-i-called-it.sbd', cache: text('0f682cb2.cac') });
    check('the glider is read from the header, not the filename',
      renamedFile.glider, 'electa');
  }
  check('a glider name is the stem before the year and segment', [
    gliderOf('electa-2025-120-1-169'),
    gliderOf('unit_507-2025-120-1-169.sbd'),
    gliderOf('sea076-2023-249-0-0.dbd'),
  ], ['electa', 'unit_507', 'sea076']);

  // ── the prefix convention, which is what says who owns a sensor ──
  //
  // Measured on this glider: the science computer's namespace is 100% `sci_`,
  // and the flight computer's 2,709 sensors include 1,022 `sci_` ones, which
  // it knows only because science values are relayed to it.
  check('the prefix says which computer a sensor belongs to',
    ['sci_water_temp', 'm_depth', 'c_heading', 'x_low_power_status', 'u_max_altimeter']
      .map(homeOf),
    ['science', 'flight', 'flight', 'flight', 'flight']);
  check('and it is the prefix, not a word inside the name',
    homeOf('m_leakdetect_voltage_science'), 'flight');
  {
    const science = parseSensorList(text('92610b65.cac'), 105).all;
    const flight = parseSensorList(text('0f682cb2.cac'), 2709).all;
    check('the science computer\'s namespace is entirely sci_',
      science.filter((n) => homeOf(n) !== 'science'), []);
    check('while the flight computer knows the science sensors it can be sent',
      flight.filter((n) => homeOf(n) === 'science').length, 1022);
  }

  // The flight computer's three decimations behave the same way as the
  // science computer's, and their sensor lists are *not* nested: the operator
  // chooses each with `sbdlist.dat` and `mbdlist.dat` independently. Measured
  // on segment 171 of the test deployment, the sbd carries 64 sensors and the
  // mbd 134, sharing 58 — so merging has to be per sensor, and the result is
  // the union of both rather than the fuller file wholesale.
  const flightPair = buildTable([
    vehicle('m_present_time', 'electa', 'electa-2025-120-1-1.sbd', [10, 30]),
    vehicle('m_iridium_call_num', 'electa', 'electa-2025-120-1-1.sbd', [10]),
    vehicle('m_present_time', 'electa', 'electa-2025-120-1-1.dbd', [10, 20, 30, 40]),
    vehicle('m_heading', 'electa', 'electa-2025-120-1-1.dbd', [10, 20]),
  ]);
  check('an sbd and a dbd of one segment merge, as a tbd and an ebd do',
    flightPair.columns.map((c) => c.name).sort(),
    ['m_heading', 'm_iridium_call_num', 'm_present_time']);
  check('the shared sensor holds the union of both files\' samples, not double',
    [...flightPair.columns.find((c) => c.name === 'm_present_time').values]
      .filter(Number.isFinite), [100, 200, 300, 400]);
  check('and a sensor only one of them logged survives',
    [...flightPair.columns.find((c) => c.name === 'm_iridium_call_num').values]
      .filter(Number.isFinite), [100]);

  // The suffix must be something a real sensor name cannot end in, or the
  // rules that strip it will take a genuine sensor for a suffixed variant.
  // `_flight`/`_science` reads better and fails this: two sensors in this
  // glider's namespace are already called `m_leak_science` and
  // `m_leakdetect_voltage_science`.
  {
    const namespace = [
      ...parseSensorList(text('0f682cb2.cac'), 2709).all,
      ...parseSensorList(text('92610b65.cac'), 105).all,
    ];
    const collides = (suffix) => namespace.filter((n) => n.endsWith(suffix));
    check('no sensor name ends in the suffix the columns use',
      ['_sbd', '_tbd', '_mbd', '_nbd', '_dbd', '_ebd'].flatMap(collides), []);
    check('unlike the computer names, which is why they are not used',
      ['_flight', '_science'].flatMap(collides).sort(),
      ['m_leak_science', 'm_leakdetect_voltage_science']);
  }

  check('with the merging said out loud',
    shared.notes.some((n) => /appeared in more than one file from the same computer/.test(n)),
    true);

  // Where they disagree — which two decimations of one record never should —
  // the fuller file wins and the reader is told, rather than one of them
  // silently prevailing.
  const conflicting = buildTable([
    { name: 'sci_water_temp', unit: 'degc', from: 'g-2025-120-1-1.tbd',
      time: Float64Array.from([10]), value: Float64Array.from([99]) },
    { name: 'sci_water_temp', unit: 'degc', from: 'g-2025-120-1-1.ebd',
      time: Float64Array.from([10]), value: Float64Array.from([12]) },
  ]);
  check('a disagreement between them keeps the fuller file\'s value',
    [...conflicting.columns[0].values], [12]);
  check('and says so, because it should not happen',
    conflicting.notes.some((n) => /disagreed about the value/.test(n)), true);
}

// ── Column order ─────────────────────────────────────────────────────────────

console.log('\n--- column order ---');
{
  // Left alone the columns arrive in the cache file's namespace order, which
  // is alphabetical over the glider's whole sensor list — so `c_ballast_pumped`
  // with 3 values of 1,328 led and `sci_water_temp` with 853 was sixty-second.
  // Nothing chose that, and a reader opening the CSV saw a screen of blanks.
  const ordered = orderColumns([...table.columns, ...deriveSeawater(table).columns]);
  const names = ordered.map((c) => c.name);
  const fill = (c) => {
    let n = 0;
    for (const v of c.values) if (Number.isFinite(v)) n++;
    return n;
  };

  check('position leads, dead-reckoned track before the GPS fixes',
    names.slice(0, 4), ['m_lat', 'm_lon', 'm_gps_lat', 'm_gps_lon']);
  check('then depth, then the CTD, then what is derived from it',
    names.slice(4, 15),
    ['sci_water_pressure_tbd', 'm_pressure', 'm_depth', 'sci_water_temp', 'sci_water_cond',
     'salinity_practical', 'salinity_reference', 'temperature_conservative',
     'density', 'sigma0', 'sound_speed']);

  // Priority beats fill on purpose: m_lat has four values and m_veh_temp has
  // sixty-four, and position is still the more useful column.
  check('a sparse but important column still leads a fuller unimportant one',
    names.indexOf('m_lat') < names.indexOf('m_veh_temp') &&
      fill(ordered[names.indexOf('m_lat')]) < fill(ordered[names.indexOf('m_veh_temp')]),
    true);

  // Past the named quantities it is purely by how much there is, so the
  // nearly-empty engineering channels end up at the far right where they
  // belong. The list above is exactly the named block, so the rest starts
  // where it ends — no separate count to keep in step.
  const named = new Set([
    'm_lat', 'm_lon', 'm_gps_lat', 'm_gps_lon',
    'sci_water_pressure_tbd', 'm_pressure', 'm_depth', 'sci_water_temp', 'sci_water_cond',
    'salinity_practical', 'salinity_reference', 'temperature_conservative',
    'density', 'sigma0', 'sound_speed',
  ]);
  const tail = ordered.filter((c) => !named.has(c.name));
  const fills = tail.map(fill);
  check('every named column comes before every unnamed one',
    ordered.findIndex((c) => !named.has(c.name)), named.size);
  check('and past them it is strictly by how populated a column is',
    fills.every((n, i) => i === 0 || fills[i - 1] >= n), true);
  check('so the emptiest column is the last one',
    fills[fills.length - 1], Math.min(...fills));
  check('and the old alphabetical order is gone',
    names[0] === 'c_ballast_pumped', false);

  // The relay copy is not the measurement: putting it sixth while m_pressure
  // with 230 values waited behind it is what this rule exists to stop.
  check('the sparse relay copy is demoted behind the full-rate one',
    names.indexOf('sci_water_pressure_sbd') > names.indexOf('m_pressure'), true);
  check('but it is still there, not dropped',
    names.includes('sci_water_pressure_sbd'), true);

  check('ordering keeps every column and invents none',
    ordered.length, table.columns.length + deriveSeawater(table).columns.length);
  check('and is stable, so two runs give the same file',
    orderColumns(ordered).map((c) => c.name), names);

  // buildTable applies it, so the CSV, the preview and the netCDF agree
  // without any of them having to remember to.
  check('a freshly built table is already ordered',
    table.columns.map((c) => c.name).slice(0, 2), ['m_lat', 'm_lon']);
}

// ── Deployments ──────────────────────────────────────────────────────────────
//
// A reader drops whatever is in front of them, and two gliders — or one
// glider's spring and summer deployments — must not be written into one file.
// Every filename and every sensor matches across those, so nothing downstream
// could tell them apart afterwards.

console.log('\n--- deployments ---');
{
  const DAY = 86400;
  const T0 = Date.UTC(2025, 4, 1) / 1000;
  const seg = (file, glider, startDay, hours = 2) => ({
    file,
    series: [{
      name: 'm_present_time', unit: 'timestamp', glider, from: file,
      time: Float64Array.from([T0 + startDay * DAY, T0 + startDay * DAY + hours * 3600]),
      value: Float64Array.from([1, 2]),
    }],
  });
  const split = (files, options) => splitDeployments(files, options).deployments;
  const labels = (files, options) => split(files, options).map(deploymentLabel);

  check('back-to-back segments are one deployment',
    labels([seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 0.2), seg('c.sbd', 'electa', 0.5)]),
    ['electa 2025-05-01']);

  check('a gap of four days is two deployments',
    labels([seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 5)]),
    ['electa 2025-05-01', 'electa 2025-05-06']);

  // Two days is a long silence and not a new deployment: a glider can miss
  // satellite passes, sit under ice, or wait out weather.
  check('a gap of two days is not',
    labels([seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 2)]), ['electa 2025-05-01']);

  // The boundary itself, from both sides.
  check('the boundary is at three days exactly',
    [labels([seg('a.sbd', 'e', 0, 0), seg('b.sbd', 'e', 3, 0)]).length,
     labels([seg('a.sbd', 'e', 0, 0), seg('b.sbd', 'e', 2.99, 0)]).length],
    [2, 1]);
  check('and the caller can move it',
    labels([seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 2)], { gapSeconds: DAY })
      .length, 2);

  check('two gliders flying at once are two deployments, never one',
    labels([seg('a.sbd', 'electa', 0), seg('b.sbd', 'unit_507', 0.1)]),
    ['electa 2025-05-01', 'unit_507 2025-05-01']);

  check('and each glider is split on its own timeline',
    labels([
      seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 10),
      seg('c.sbd', 'unit_507', 0), seg('d.sbd', 'unit_507', 20),
    ]).length, 4);

  // Files arrive in whatever order the picker gave them.
  check('the order they were dropped in does not matter',
    labels([seg('c.sbd', 'electa', 5), seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 0.5)]),
    ['electa 2025-05-01', 'electa 2025-05-06']);

  // Measured against the deployment's furthest reach, not the previous
  // segment's end, so one long segment overlapping a short one is not a gap.
  check('a long segment enclosing a short one is not a boundary',
    labels([seg('long.sbd', 'electa', 0, 24 * 8), seg('short.sbd', 'electa', 1, 1),
            seg('after.sbd', 'electa', 7)]).length, 1);

  check('every segment ends up in exactly one deployment',
    split([seg('a.sbd', 'electa', 0), seg('b.sbd', 'electa', 5), seg('c.sbd', 'unit_507', 0)])
      .flatMap((d) => d.segments.map((x) => x.file)).sort(),
    ['a.sbd', 'b.sbd', 'c.sbd']);

  // A file with no usable clock cannot be placed against a gap. Putting it in
  // the first deployment would be inventing a fact, so it is set aside and
  // named rather than quietly included.
  const clockless = splitDeployments([
    seg('good.sbd', 'electa', 0),
    { file: 'noclock.sbd', series: [{ name: 'm_depth', unit: 'm', glider: 'electa',
      from: 'noclock.sbd', time: Float64Array.from([NaN]), value: Float64Array.from([1]) }] },
  ]);
  check('a file with no clock is set aside, not silently included',
    { deployments: clockless.deployments.length, undated: clockless.undated },
    { deployments: 1, undated: ['noclock.sbd'] });

  check('a deployment names itself by glider and start day',
    deploymentStem(split([seg('a.sbd', 'electa', 0)])[0]), 'electa-20250501');

  // The real pair, which is one deployment: two files, minutes apart.
  const real = splitDeployments([
    { file: SBD, series: readSeries(flight) },
    { file: TBD, series: readSeries(science) },
  ]);
  check('the fixture pair is one deployment of one glider',
    real.deployments.map(deploymentLabel), ['electa 2025-05-07']);
  check('holding both files', real.deployments[0].segments.length, 2);
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

// ── OG1.0 ───────────────────────────────────────────────────────────────────
//
// The structure is checked against the spec's own tables rather than against
// its example file, which is looser than the document it illustrates — it
// writes `DEPLOYMENT_LATITUDE = "nan"` into a double and leaves most
// vocabulary attributes empty.
//
// Spec: https://oceangliderscommunity.github.io/OG-format-user-manual/OG_Format.html

console.log('\n--- OG1.0 ---');

const OG1_META = {
  ...OG1_DEFAULTS,
  platformSerial: 'electa',
  platformModel: 'G3',
  wmoIdentifier: '4802960',
  deploymentTime: '2025-05-01T14:00:00',
  deploymentLatitude: '38.21',
  deploymentLongitude: '-73.74',
  contributorName: 'A Person',
  contributorEmail: 'person@example.org',
  contributingInstitutions: 'Virginia Institute of Marine Science',
  ctdSerial: '0221',
  ctdModel: 'RBRlegato3',
};

{
  // Nothing that identifies a glider, a person or an institution may be
  // guessed: a plausible wrong WMO number is worse than an empty box.
  const missing = missingFields(OG1_DEFAULTS).map((f) => f.key).sort();
  check('the defaults leave every identifying field to be filled in', missing, [
    'contributingInstitutions', 'contributorEmail', 'contributorName',
    'deploymentLatitude', 'deploymentLongitude', 'deploymentTime',
    'platformModel', 'platformSerial', 'wmoIdentifier',
  ]);
  check('and a filled form is complete', missingFields(OG1_META).length, 0);

  // Writing a near-OG1 file is worse than refusing: it is the near-miss this
  // whole package exists to avoid.
  let refused = '';
  try {
    buildOg1(table, OG1_DEFAULTS);
  } catch (error) {
    refused = error.message;
  }
  check('an incomplete form is refused, and says what is missing',
    /needs 9 more field\(s\)/.test(refused) && /WMO identifier/.test(refused), true);

  check('every field the form declares exists on the metadata object',
    OG1_FIELDS.filter((f) => !(f.key in OG1_DEFAULTS)).map((f) => f.key), []);
}

const og1 = buildOg1(table, OG1_META);
const og1Bytes = writeNetcdf(og1.document);
const og1File = readNetcdf(og1Bytes);
const og1Var = (name) => og1File.variables.find((v) => v.name === name);
const og1Global = (name) => og1File.globals[name];

{
  // ── the naming convention ──
  check('the id follows <platform_serial>_<start_date>_<data_mode>',
    og1.id, 'electa_20250507T221614_R');
  check('and the file is named for it', og1FileName(og1.id), 'electa_20250507T221614_R.nc');
  check('the start date is the compact form the spec asks for, not ISO with separators',
    /^\d{8}T\d{6}$/.test(og1.id.split('_')[1]), true);
  check('a time stamps compactly', stampCompact(Date.UTC(2024, 3, 25, 14, 58, 5) / 1000),
    '20240425T145805');

  // ── dimensions ──
  check('N_MEASUREMENTS is the number of measurements',
    og1File.dims.find((d) => d.name === 'N_MEASUREMENTS')?.length, table.rows);
  check('and N_PARAM counts the geophysical parameters',
    og1File.dims.find((d) => d.name === 'N_PARAM')?.length,
    og1Var('PARAMETER').size / og1Var('PARAMETER').size * 6);

  // ── mandatory global attributes ──
  const mandatory = ['title', 'platform', 'platform_vocabulary', 'id', 'featureType',
    'Conventions', 'start_date', 'date_created', 'rtqc_method'];
  check('every mandatory global attribute is present',
    mandatory.filter((name) => !(name in og1File.globals)), []);
  check('featureType is the fixed value the spec gives', og1Global('featureType'), 'trajectory');
  check('and Conventions names all three', og1Global('Conventions'),
    'CF-1.10, ACDD-1.3, OG-1.0');

  // The PI and the operating institution are mandatory in the spec's own
  // wording even though they sit in the "highly desirable" rows.
  check('the PI and the operator reach the file', {
    name: og1Global('contributor_name'),
    role: og1Global('contributor_role'),
    institution: og1Global('contributing_institutions'),
  }, {
    name: 'A Person',
    role: 'PI',
    institution: 'Virginia Institute of Marine Science',
  });

  // ── mandatory variables ──
  const required = ['TIME', 'LATITUDE', 'LONGITUDE', 'DEPTH', 'TIME_GPS', 'LATITUDE_GPS',
    'LONGITUDE_GPS', 'TRAJECTORY', 'PLATFORM_MODEL', 'WMO_IDENTIFIER',
    'DEPLOYMENT_TIME', 'DEPLOYMENT_LATITUDE', 'DEPLOYMENT_LONGITUDE'];
  check('every mandatory variable is present',
    required.filter((name) => !og1Var(name)), []);

  // ── the coordinate variables say what the spec says they say ──
  check('TIME carries its standard name, units and calendar', {
    standard_name: og1File.attrOf('TIME', 'standard_name'),
    units: og1File.attrOf('TIME', 'units'),
    calendar: og1File.attrOf('TIME', 'calendar'),
  }, {
    standard_name: 'time',
    units: 'seconds since 1970-01-01T00:00:00Z',
    calendar: 'gregorian',
  });
  check('LATITUDE and LONGITUDE are in degrees, named as CF names them', {
    lat: [og1File.attrOf('LATITUDE', 'standard_name'), og1File.attrOf('LATITUDE', 'units')],
    lon: [og1File.attrOf('LONGITUDE', 'standard_name'), og1File.attrOf('LONGITUDE', 'units')],
  }, {
    lat: ['latitude', 'degrees_north'],
    lon: ['longitude', 'degrees_east'],
  });
  check('DEPTH is metres, positive down', {
    standard_name: og1File.attrOf('DEPTH', 'standard_name'),
    units: og1File.attrOf('DEPTH', 'units'),
    positive: og1File.attrOf('DEPTH', 'positive'),
  }, { standard_name: 'depth', units: 'm', positive: 'down' });

  // ── the geophysical parameters, and the units question the spec and its
  //    own example disagree about ──
  check('CNDC is in the units the spec\'s table gives, not the example file\'s',
    og1File.attrOf('CNDC', 'units'), 'mS cm-1');
  check('TEMP and PRES likewise',
    [og1File.attrOf('TEMP', 'units'), og1File.attrOf('PRES', 'units')],
    ['degree_Celsius', 'decibar']);
  check('each parameter points at the OG1 vocabulary',
    ['CNDC', 'TEMP', 'PRES', 'PSAL'].map((n) => og1File.attrOf(n, 'vocabulary')),
    ['CNDC', 'TEMP', 'PRES', 'PSAL'].map(
      (n) => `http://vocab.nerc.ac.uk/collection/OG1/current/${n}/`));
  check('and names its coordinates and its sensor',
    [og1File.attrOf('TEMP', 'coordinates'), og1File.attrOf('TEMP', 'sensor')],
    ['TIME LONGITUDE LATITUDE DEPTH', 'SENSOR_CTD_0221']);
  check('the sensor variable it points at exists', !!og1Var('SENSOR_CTD_0221'), true);
  check('and its name follows OG1\'s upper-case underscore rule',
    sensorVariableName({ ...OG1_META, ctdSensorType: 'dissolved gas sensors', ctdSerial: '2025-0123' }),
    'SENSOR_DISSOLVED_GAS_SENSORS_2025_0123');

  // ── a QC companion for everything, all zero: no QC has been applied ──
  const wantsQc = ['TIME', 'LATITUDE', 'LONGITUDE', 'DEPTH', 'PRES', 'TEMP', 'CNDC', 'PSAL', 'PHASE'];
  check('every measured variable has a QC companion',
    wantsQc.filter((name) => !og1Var(`${name}_QC`)), []);
  check('and the flags say no QC has been applied, which is true',
    [...og1File.read('TEMP_QC')].every((v) => v === 0), true);
  check('the flag meanings are the IODE scheme',
    og1File.attrOf('TEMP_QC', 'flag_values'), [0, 1, 2, 3, 4]);

  // ── the values themselves ──
  const finite = (a) => [...a].filter(Number.isFinite);
  const pres = finite(og1File.read('PRES'));
  const depth = finite(og1File.read('DEPTH'));
  const cndc = finite(og1File.read('CNDC'));
  const psal = finite(og1File.read('PSAL'));

  check('PRES is the recorded pressure in decibar, not the bar the glider wrote',
    Math.round(Math.max(...pres) * 100) / 100, 125.24);
  // Depth is *less* than pressure in dbar, by the local gravity and the
  // compressibility of the water column — about 0.8% at this latitude. Equal
  // would mean the 1 dbar = 1 m approximation had crept in.
  const ratio = Math.max(...depth) / Math.max(...pres);
  check('DEPTH is computed from pressure and latitude, not assumed equal to it',
    ratio > 0.985 && ratio < 0.998, true);
  check('CNDC is ten times the S/m the glider recorded',
    Math.round(Math.max(...cndc) * 10) / 10, 42.6);
  check('PSAL is shelf water', Math.min(...psal) > 30 && Math.max(...psal) < 36, true);

  // LATITUDE is filled at every measurement where LATITUDE_GPS is not: that
  // difference is the whole reason OG1 defines both.
  const lat = og1File.read('LATITUDE');
  const gpsLat = og1File.read('LATITUDE_GPS');
  check('LATITUDE is filled at every measurement, as OG1 requires',
    finite(lat).length, table.rows);
  check('while LATITUDE_GPS holds only the fixes',
    finite(gpsLat).length < finite(lat).length && finite(gpsLat).length > 0, true);
  check('and both are off New Jersey',
    Math.round(Math.max(...finite(lat)) * 10) / 10, 38.2);

  // ── PHASE and the numbering ──
  check('PHASE uses the published vocabulary',
    og1File.attrOf('PHASE', 'phase_vocabulary').includes('vocabularyCollection/phase.md'), true);
  check('and says how it was arrived at, because it was not recorded',
    /Inferred from the rate of change of pressure/.test(
      og1File.attrOf('PHASE', 'phase_calculation_method')), true);

  const phase = [...og1File.read('PHASE')];
  const seen = new Set(phase);
  check('every phase value is in the vocabulary',
    [...seen].filter((v) => ![0, 1, 2, 3, 4, 5, 6, 7].includes(v)), []);
  check('the glider dives, climbs and surfaces',
    [1, 2, 3].every((v) => seen.has(v)), true);

  // This segment surfaces at each end and yo-yos at 3.5 dbar in between, so
  // there are two surfacings and four complete dive-climb cycles. A threshold
  // that took a 3.5 dbar inflection for a surfacing would give six.
  check('SEGMENT_NUMBER counts surfacings, not shallow inflections',
    Math.max(...og1File.read('SEGMENT_NUMBER')), 2);
  check('and PROFILE_NUMBER counts the dives and climbs',
    Math.max(...og1File.read('PROFILE_NUMBER')), 8);
  check('PROFILE_DIRECTION is 1 descending, -1 ascending, 0 elsewhere',
    [...new Set(og1File.read('PROFILE_DIRECTION'))].sort(), [-1, 0, 1]);

  // ── the scalar metadata ──
  const chars = (name) => new TextDecoder().decode(
    Uint8Array.from(og1File.read(name, 'char'))).replace(/\0+$/, '').trim();
  check('the platform variables carry what the form was given', {
    trajectory: chars('TRAJECTORY'),
    type: chars('PLATFORM_TYPE'),
    model: chars('PLATFORM_MODEL'),
    wmo: chars('WMO_IDENTIFIER'),
  }, {
    trajectory: 'electa_20250507T221614_R',
    type: 'slocum',
    model: 'G3',
    wmo: '4802960',
  });
  check('and the deployment position is where the form said',
    [og1File.read('DEPLOYMENT_LATITUDE')[0], og1File.read('DEPLOYMENT_LONGITUDE')[0]],
    [38.21, -73.74]);

  check('the file says how it was encoded, rather than implying conformance',
    /netCDF-3 classic/.test(og1Global('format_note')), true);
}

// ── PHASE, on data built to have a known answer ──────────────────────────────

{
  // The fixture cannot exercise the branch that uses the glider's own state,
  // because these files do not log it — which is itself the reason the
  // inference exists. Synthetic, because what is being checked is the
  // translation table rather than the decode.
  const time = Float64Array.from({ length: 6 }, (_, i) => i * 10);
  // A Column, which is what derivePhase takes — `values`, not a Series' `value`.
  const state = { name: 'cc_final_behavior_state', unit: 'enum', source: 'recorded',
    values: Float64Array.from([1, 1, 2, 2, 5, 5]) };
  const flat = new Float64Array(6).fill(50);
  const fromState = derivePhase(time, flat, state);
  check('the glider\'s own behaviour state is translated, when it is logged',
    [...fromState.phase], [2, 2, 1, 1, 3, 3]);
  check('and the file says that is what happened',
    /own cc_final_behavior_state/.test(fromState.method), true);

  // A clean dive and climb, with no state logged.
  const t = Float64Array.from({ length: 40 }, (_, i) => i * 10);
  const p = Float64Array.from(t, (_, i) => (i < 20 ? i * 5 : (39 - i) * 5));
  const inferred = derivePhase(t, p);
  check('without it, a descent then an ascent is inferred from the pressure',
    [inferred.phase[5], inferred.phase[30]], [2, 1]);
  check('the surface is where the pressure is', inferred.phase[0], 3);
  check('and one dive and one climb is two profiles',
    Math.max(...inferred.profile), 2);
}

// ── CDL ──────────────────────────────────────────────────────────────────────

console.log('\n--- CDL ---');
{
  const cdl = toCdl(og1.document, { name: og1.id });
  const lines = cdl.split('\n');

  check('it opens as a netCDF CDL named for the id', lines[0], `netcdf ${og1.id} {`);
  check('and closes', lines[lines.length - 2], '}');

  // The point of the CDL is that `ncgen -4` can make what a browser cannot:
  // OG1's string variables as real NC_STRINGs rather than char arrays.
  check('the metadata variables are declared as strings, which classic cannot hold',
    ['TRAJECTORY', 'PLATFORM_TYPE', 'PLATFORM_MODEL', 'WMO_IDENTIFIER']
      .filter((n) => !cdl.includes(`\tstring ${n} ;`)), []);
  check('and the parameter lists are string arrays',
    cdl.includes('\tstring PARAMETER(N_PARAM) ;'), true);
  check('so the char-array dimensions they needed are not declared',
    /^\tSTRING\d+ = /m.test(cdl), false);

  // A numeric literal without its type suffix is read by ncgen as an int, so
  // a byte _FillValue would silently become an int attribute.
  check('byte attributes carry their suffix', cdl.includes('TEMP_QC:_FillValue = 0b ;'), true);
  check('float fill values carry theirs', cdl.includes('TEMP:_FillValue = NaNf ;'), true);
  check('and doubles look like doubles rather than integers',
    cdl.includes('TIME:valid_min = 1000000000. ;'), true);

  check('the data section is there', cdl.includes('\ndata:\n'), true);
  check('with the trajectory written as text',
    cdl.includes(` TRAJECTORY = "${og1.id}" ;`), true);
  check('and the parameter names as a list',
    /PARAMETER = "PRES", "CNDC", "TEMP", "PSAL"/.test(cdl), true);

  // Every declaration in the CDL must describe the same file the netCDF
  // writer produced. Checked against the netCDF read back by the reader
  // below, not against the document both were built from.
  const declared = [...cdl.matchAll(/^\t(?:byte|char|short|int|float|double|string) (\w+)/gm)]
    .map((m) => m[1]);
  check('the CDL declares exactly the variables the netCDF holds',
    declared.slice().sort(), og1File.variables.map((v) => v.name).sort());

  const headerOnly = toCdl(og1.document, { name: og1.id, data: false });
  check('a header-only CDL omits the data', headerOnly.includes('\ndata:\n'), false);

  // ── and the claim the CDL export exists to make ──
  //
  // Everything above checks the text against what this repository believes.
  // Only `ncgen` can say whether it is valid CDL, and `ncgen` ships with
  // netCDF rather than with Node, so this runs where it is installed and
  // says `skip` where it is not. Never `ok` when skipped: a check that goes
  // quiet and keeps passing is the shape this project has paid for before.
  const ncgen = findNcgen();
  if (!ncgen) {
    console.log('skip  ncgen is not installed, so the CDL is unproven here ' +
      '(conda create -p env -c conda-forge libnetcdf)');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'slocum-cdl-'));
    const cdlPath = join(dir, `${og1.id}.cdl`);
    const ncPath = join(dir, `${og1.id}.nc`);
    writeFileSync(cdlPath, cdl);

    let status = 0;
    let output = '';
    try {
      output = execFileSync(ncgen, ['-4', '-o', ncPath, cdlPath], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      status = error.status ?? 1;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    check('ncgen -4 compiles the CDL', { status, output: output.trim() }, { status: 0, output: '' });
    check('and produces a netCDF-4 file', existsSync(ncPath) && readFileSync(ncPath).length > 1000, true);

    // netCDF-3 has no NC_STRING, so a CDL that declares one must be refused
    // rather than quietly downgraded — which is the whole reason this export
    // is worth having alongside the .nc.
    let classic = 0;
    try {
      execFileSync(ncgen, ['-3', '-o', join(dir, 'classic.nc'), cdlPath], { stdio: 'pipe' });
    } catch (error) {
      classic = error.status ?? 1;
    }
    check('while ncgen -3 refuses it, because classic has no string type',
      classic !== 0, true);

    rmSync(dir, { recursive: true, force: true });
  }
}

/** `ncgen`, wherever this machine happens to keep it. */
function findNcgen() {
  const candidates = [
    process.env.NCGEN,
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map((d) => join(d, 'ncgen')),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* an unreadable PATH entry is not this check's problem */ }
  }
  return null;
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
      } else {
        // 1 byte, 3 short, 4 int, 5 float, 6 double. All of these appear in an
        // OG1 file: the QC flag values are bytes and the fill values follow
        // their variable's own type.
        const width = { 1: 1, 3: 2, 4: 4, 5: 4, 6: 8 }[type];
        if (!width) throw new Error(`netCDF reader: unexpected attribute type ${type}`);
        const values = [];
        for (let k = 0; k < count; k++) {
          values.push(
            type === 6 ? view.getFloat64(at, false)
              : type === 5 ? view.getFloat32(at, false)
              : type === 4 ? view.getInt32(at, false)
              : type === 3 ? view.getInt16(at, false)
              : view.getInt8(at),
          );
          at += width;
        }
        pad();
        out[name] = values;
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
    read(name, as) {
      const v = variables.find((x) => x.name === name);
      if (!v) return null;
      // 1 byte, 2 char, 3 short, 4 int, 5 float, 6 double.
      const width = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }[v.type];
      const count = Math.floor(v.size / width);
      const out = v.type === 6 || v.type === 5 ? new Float64Array(count) : new Int32Array(count);
      for (let i = 0; i < count; i++) {
        const at = v.begin + i * width;
        out[i] = v.type === 6 ? view.getFloat64(at, false)
          : v.type === 5 ? view.getFloat32(at, false)
          : v.type === 4 ? view.getInt32(at, false)
          : v.type === 3 ? view.getInt16(at, false)
          : as === 'char' ? view.getUint8(at)
          : view.getInt8(at);
      }
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
