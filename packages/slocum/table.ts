/**
 * Turning a set of per-sensor series into something rectangular.
 *
 * This is the step where a decoder can quietly stop being a decoder. Each
 * Slocum sensor is written on its own subset of cycles — the flight computer
 * logs `m_depth` every few seconds and `m_lat` only when the glider surfaces,
 * and the science computer keeps its own clock entirely — so there is no
 * single time base in the file, and both CSV and netCDF need one.
 *
 * Two ways to make one, and the difference matters enough to be the reader's
 * choice rather than ours:
 *
 * - **`union`**, the default. Rows are every distinct time any sensor
 *   reported at; a cell is blank where that sensor did not report then.
 *   Nothing is invented and nothing is dropped — the file can be
 *   reconstructed from the table. It is what `dbd2asc` produces, and it is
 *   sparse: a hundred sensors on a hundred different schedules make a table
 *   that is mostly blank, which is an honest picture of what a glider logs.
 *
 * - **`interpolate`**. Rows are one chosen sensor's time base and everything
 *   else is linearly interpolated onto it, `NaN` outside its range. Dense and
 *   immediately usable, and **every value in it other than the base column is
 *   a number the glider never recorded**. That is usually what you want and
 *   it is never what the instrument said.
 *
 * The default is the lossless one on the principle this repository applies
 * everywhere else: a tool may offer to interpolate, and must not do it
 * without being asked.
 */

import { familyOf, gliderOf, homeOf, resolutionOf, type Series } from './types.ts';

export type Join = 'union' | 'interpolate';

export interface Column {
  name: string;
  /** As the glider's sensor list spells it: `m`, `rad`, `degc`, `nodim`. */
  unit: string;
  values: Float64Array;
  /**
   * Whether the glider wrote this or we worked it out. A derived column is
   * not a measurement and the distinction survives into the CSV header and
   * the netCDF attributes.
   */
  source: 'recorded' | 'derived' | 'interpolated';
  /** Which file it came from, when several were decoded together. */
  from?: string;
}

export interface Table {
  /** Row times, epoch seconds UTC, ascending. */
  time: Float64Array;
  columns: Column[];
  rows: number;
  /**
   * Anything the reader is owed an explanation for: rows dropped for having
   * no clock, a truncation, the fact that interpolation happened at all.
   * Shown, never swallowed.
   */
  notes: string[];
}

export interface BuildOptions {
  join?: Join;
  /**
   * For `interpolate`: the sensor whose time base becomes the rows. Defaults
   * to whichever supplied series has the most samples, which is the densest
   * honest choice.
   */
  base?: string;
  /**
   * A ceiling on rows, because this materialises a dense matrix and a whole
   * deployment is hundreds of files. Exceeding it truncates *and says so* —
   * a silent cap reads as "that is all the data there was".
   */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 500_000;

/**
 * Sensors whose values are compass-like angles, where interpolating across
 * the 0/2π wrap linearly is wrong: 350° and 10° average to 180°, pointing
 * exactly backwards, and nothing about the output says so.
 *
 * Matched by name because the unit cannot settle it — `rad` is also a fin
 * deflection and a pitch, both of which are signed angles about zero that
 * interpolate perfectly well linearly and would be *damaged* by wrapping
 * them into [0, 2π).
 */
const ANGULAR = /(heading|_hdg|direction|_dir)$/;

/** Whether a sensor needs the sin/cos treatment when interpolated. */
export function isAngular(name: string): boolean {
  return ANGULAR.test(name);
}

/**
 * Linear interpolation, `NaN` outside the source range rather than
 * extrapolated. Both time bases must be ascending, which they are: a Slocum
 * clock only goes forwards.
 */
export function interpolateOnto(
  targetTime: Float64Array,
  sourceTime: Float64Array,
  sourceValue: Float64Array,
): Float64Array {
  const out = new Float64Array(targetTime.length).fill(NaN);
  const n = sourceTime.length;
  if (n === 0) return out;
  if (n === 1) {
    // One sample is a value at an instant, not a function of time. Placing it
    // on the nearest row would be a guess; leaving the column empty says what
    // is true, which is that there is nothing to interpolate between.
    return out;
  }

  let j = 0;
  for (let i = 0; i < targetTime.length; i++) {
    const t = targetTime[i];
    if (!Number.isFinite(t) || t < sourceTime[0] || t > sourceTime[n - 1]) continue;
    while (j < n - 1 && sourceTime[j + 1] < t) j++;
    const t0 = sourceTime[j];
    const t1 = sourceTime[j + 1];
    const v0 = sourceValue[j];
    const v1 = sourceValue[j + 1];
    out[i] = t0 === t1 ? v0 : v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
  }
  return out;
}

/** The same, decomposed into sin and cos so the 0/2π seam interpolates. */
export function interpolateAngleOnto(
  targetTime: Float64Array,
  sourceTime: Float64Array,
  sourceValue: Float64Array,
): Float64Array {
  const sin = new Float64Array(sourceValue.length);
  const cos = new Float64Array(sourceValue.length);
  for (let i = 0; i < sourceValue.length; i++) {
    sin[i] = Math.sin(sourceValue[i]);
    cos[i] = Math.cos(sourceValue[i]);
  }
  const si = interpolateOnto(targetTime, sourceTime, sin);
  const ci = interpolateOnto(targetTime, sourceTime, cos);
  const out = new Float64Array(targetTime.length);
  const twoPi = 2 * Math.PI;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(si[i])) {
      out[i] = NaN;
      continue;
    }
    // The range is half-open, [0, 2π), and the seam is exactly where this
    // function is used. `atan2` returns a whisker below zero for a heading
    // interpolated onto due north, and the wrap then lands on 2π itself —
    // inside the range only if the subtraction happens to be representable,
    // and reported as 359.999999° either way. Clamped back to 0, so due north
    // is one number rather than two.
    const wrapped = ((Math.atan2(si[i], ci[i]) % twoPi) + twoPi) % twoPi;
    out[i] = wrapped >= twoPi - 1e-12 ? 0 : wrapped;
  }
  return out;
}

/**
 * The order a glider table reads best in.
 *
 * Left alone, the columns arrive in the order the *cache file* lists its
 * sensors, which is alphabetical across the whole of the glider's namespace.
 * Nothing chose that, and it is close to the worst possible order: on the
 * test fixture it put `c_ballast_pumped` — three values out of 1,328 — in the
 * first column and `sci_water_temp`, with 853, in the sixty-second. A reader
 * opening the CSV in a spreadsheet sees a screen of blanks.
 *
 * So the quantities anyone opens a glider file *for* come first, in the order
 * they are usually read — where it was, how deep, then the CTD and what is
 * derived from it — and everything else follows by how much of it there is,
 * which puts the nearly-empty columns last.
 *
 * **Priority beats fill, deliberately.** `m_lat` has four values in the
 * fixture and `m_veh_temp` has sixty-four, and position is still the more
 * useful column. Sorting by fill alone would bury it.
 */
/**
 * The suffix `groupSeries` adds when both computers wrote a sensor.
 *
 * A **file extension**, not the computer's name, and that is not cosmetic:
 * `_flight`/`_science` reads better and collides with the namespace. Measured
 * on this glider's 2,709 sensors, two are already called `m_leak_science` and
 * `m_leakdetect_voltage_science` — so a rule that strips `_science` would take
 * those for suffixed variants of `m_leak` and `m_leakdetect_voltage`. Nothing
 * ends in `_sbd`, `_tbd`, `_mbd`, `_nbd`, `_dbd` or `_ebd`.
 */
const FAMILY_SUFFIX = /_[smdtne][bc]d$/;

const LEADING: readonly RegExp[] = [
  // Where it was. The dead-reckoned track first, then the fixes it is drawn
  // between — which is the same order OG1 puts LATITUDE before LATITUDE_GPS.
  /^m_lat(_[smdtne][bc]d)?$/,
  /^m_lon(_[smdtne][bc]d)?$/,
  /^m_gps_lat(_[smdtne][bc]d)?$/,
  /^m_gps_lon(_[smdtne][bc]d)?$/,

  // How deep. The science computer's pressure is the measurement; the flight
  // computer's is a slow relay of it, and `m_depth` is the glider's own idea.
  /^sci_water_pressure(_[smdtne][bc]d)?$/,
  /^sci_rbrctd_seapressure_00(_[smdtne][bc]d)?$/,
  /^m_pressure(_[smdtne][bc]d)?$/,
  /^m_depth(_[smdtne][bc]d)?$/,

  // The CTD.
  /^sci_water_temp(_[smdtne][bc]d)?$/,
  /^sci_rbrctd_temperature_00(_[smdtne][bc]d)?$/,
  /^sci_water_cond(_[smdtne][bc]d)?$/,
  /^sci_rbrctd_conductivity_00(_[smdtne][bc]d)?$/,

  // What is derived from it, in the order the derivation runs.
  /^salinity_practical$/,
  /^salinity_(absolute|reference)$/,
  /^temperature_conservative$/,
  /^density$/,
  /^sigma0$/,
  /^sound_speed$/,

];

// Deliberately nothing else. Earlier drafts also grouped "all other science"
// and "attitude" ahead of the engineering channels, and both produced the
// anomaly this ordering exists to remove: `sci_flbbcd_timestamp` with one
// value outranked `m_present_time` with 362, and `m_water_vy` with two
// outranked `m_veh_temp` with sixty-four. Past the quantities a reader came
// for, how much of a thing there is *is* the useful ordering.

/** Where a column sits in the list above, or past the end of it. */
function rank(name: string): number {
  const at = LEADING.findIndex((pattern) => pattern.test(name));
  return at === -1 ? LEADING.length : at;
}

function filled(values: Float64Array): number {
  let n = 0;
  for (const v of values) if (Number.isFinite(v)) n++;
  return n;
}

/**
 * Sort columns into that order: the named quantities first, then the rest by
 * how populated they are, then by name so the result is deterministic.
 *
 * Exported because derived columns are appended after the table is built, and
 * the ordering has to be applied again once they are — one definition, so the
 * two call sites cannot drift.
 */
export function orderColumns(columns: readonly Column[]): Column[] {
  const fill = new Map(columns.map((c) => [c, filled(c.values)]));

  // Where the same sensor was written by both computers, only the copy on the
  // computer the sensor *belongs* to keeps its place at the front.
  // `sci_water_pressure` is measured by the science computer and relayed to
  // the flight computer, which logs it a handful of times a segment — 853
  // values against 4 in the fixture. Both are real and both are kept, but the
  // relay is not the measurement, and putting it sixth while `m_pressure`
  // with 230 values waits behind it is what this rule exists to stop.
  //
  // Decided by the sensor's own prefix rather than by which column has more
  // in it: `sci_` says the science computer measured it, so a `_sbd` copy is
  // a relay however many samples it happens to carry. Sample counts only
  // imply that, and imply it wrongly whenever a decimated science file is
  // paired with a dense flight one.
  const relay = (c: Column) => {
    const match = FAMILY_SUFFIX.exec(c.name);
    if (!match) return false;
    const extension = match[0].slice(1);
    return familyOf(`x.${extension}`) !== homeOf(c.name.replace(FAMILY_SUFFIX, ''));
  };

  return [...columns].sort((a, b) => {
    const byRank = (relay(a) ? LEADING.length : rank(a.name))
      - (relay(b) ? LEADING.length : rank(b.name));
    if (byRank !== 0) return byRank;
    const byFill = fill.get(b)! - fill.get(a)!;
    if (byFill !== 0) return byFill;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Which computer inside the glider wrote a series. */
const computerOf = (file: string | undefined): string => familyOf(file ?? '');

/** The vehicle, falling back to the filename when a series carries no glider. */
const vehicleOf = (s: Series): string => s.glider ?? gliderOf(s.from ?? '');

/**
 * Collapse series that are the same quantity, and keep apart the ones that
 * are not.
 *
 * Three different things look identical at this point:
 *
 * - **The same sensor across segments.** A deployment is hundreds of files
 *   and `sci_water_temp` in segment 169 continues `sci_water_temp` in
 *   segment 170. One column, concatenated in time.
 *
 * - **The same sensor at two resolutions.** `sbd`, `mbd` and `dbd` are three
 *   decimations of one flight record, as `tbd`, `nbd` and `ebd` are of one
 *   science record — the short ones go over Iridium, the long ones come off
 *   the glider on recovery. Dropping both must give one column per sensor, so
 *   the samples are merged and **deduplicated by time**.
 *
 *   Merged per *sensor*, not per file, because the lists are not nested: the
 *   operator picks each with `sbdlist.dat` and `mbdlist.dat` independently.
 *   Measured on segment 171 of the test deployment, the sbd carries 64
 *   sensors and the mbd 134, sharing 58 — six are in the sbd alone. So the
 *   result is the union of both, not the fuller file wholesale.
 *
 * - **The same sensor name from the two computers.** `sci_water_pressure` is
 *   measured by the science computer and *relayed* to the flight computer,
 *   which logs it at its own much slower rate — 853 samples against 4 in the
 *   fixture pair. Both are real, they are not the same record, and merging
 *   them would interleave a full-rate profile with a handful of stale relays
 *   under one name. Two columns.
 *
 * - **The same sensor name from two gliders.** A fleet directory holds
 *   `m_depth` for every vehicle in it, and they are obviously not one series.
 *
 * # The key is (sensor, glider, computer), and both halves were learned late
 *
 * The **glider** is the vehicle; flight and science are the two computers
 * inside it. Leave the glider out of the key and a fleet directory silently
 * merges two vehicles' `m_depth` into one column, interleaved and looking
 * exactly like data.
 *
 * And the computer, not the *extension*: keying on the extension made `.tbd`
 * and `.ebd` different records, so a reader who dropped both after a recovery
 * got every science sensor twice — under a note claiming they came from "both
 * computers", which they did not. In both cases the rows were right, because
 * the join keys on the timestamp; it was the columns that were wrong.
 */
function groupSeries(series: readonly Series[]): {
  series: Series[];
  renamed: string[];
  deduplicated: number;
  disagreed: number;
} {
  const renamed: string[] = [];
  const groups = new Map<string, Series[]>();
  for (const s of series) {
    // A pipe, because Slocum sensor names and glider names are `[a-z0-9_]`
    // and the computer is one of two words, so none can contain one — and
    // unlike the NUL this was first written with, it survives grep and is
    // visible in an editor.
    const key = `${s.name}|${vehicleOf(s)}|${computerOf(s.from)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  // A name claimed by more than one glider has to say which glider, and one
  // claimed by both computers has to say which file. A name claimed once
  // keeps it, so the ordinary single-vehicle case reads unchanged.
  const vehicles = new Map<string, Set<string>>();
  const families = new Map<string, Set<string>>();
  for (const key of groups.keys()) {
    const [name, glider, computer] = key.split('|');
    const byVehicle = vehicles.get(name) ?? new Set<string>();
    byVehicle.add(glider);
    vehicles.set(name, byVehicle);
    const withinVehicle = families.get(`${name}|${glider}`) ?? new Set<string>();
    withinVehicle.add(computer);
    families.set(`${name}|${glider}`, withinVehicle);
  }

  const merged: Series[] = [];
  let deduplicated = 0;
  let disagreed = 0;

  for (const [key, bucket] of groups) {
    const [name, glider, computer] = key.split('|');
    // Named for the fullest file that contributed, so the suffix is always an
    // extension the reader really has in hand.
    const source = [...bucket].sort(
      (a, b) => resolutionOf(a.from ?? '') - resolutionOf(b.from ?? ''),
    )[0];
    const extension = (source.from ?? '').split('.').pop()?.toLowerCase() ?? '';

    let label = name;
    if ((vehicles.get(name)?.size ?? 1) > 1 && glider) label += `_${glider}`;
    if ((families.get(`${name}|${glider}`)?.size ?? 1) > 1 && computer !== 'unknown') {
      label += `_${extension}`;
    }
    if (label !== name) renamed.push(label);

    if (bucket.length === 1) {
      merged.push({ ...bucket[0], name: label });
      continue;
    }

    // Concatenate, then sort by time: segments arrive in whatever order the
    // reader picked them, and the join below needs ascending time.
    //
    // Ties break on how complete the file is, so that where one instant is in
    // both a `.tbd` and the `.ebd` it was decimated from, the fuller file's
    // sample is the one kept.
    const pairs: [number, number, number][] = [];
    for (const s of bucket) {
      const rank = resolutionOf(s.from ?? '');
      for (let i = 0; i < s.time.length; i++) pairs.push([s.time[i], s.value[i], rank]);
    }
    pairs.sort((a, b) => a[0] - b[0] || a[2] - b[2]);

    const time: number[] = [];
    const value: number[] = [];
    for (const [t, v] of pairs) {
      if (time.length > 0 && t === time[time.length - 1]) {
        // The same instant twice. Between two decimations of one record this
        // is the ordinary case rather than a fault, so it is counted, not
        // announced — unless the two disagree about the value, which they
        // should never do and which the reader is told about.
        deduplicated++;
        if (!Object.is(v, value[value.length - 1])) disagreed++;
        continue;
      }
      time.push(t);
      value.push(v);
    }

    merged.push({
      name: label,
      unit: bucket[0].unit,
      time: Float64Array.from(time),
      value: Float64Array.from(value),
      from: bucket.map((s) => s.from ?? '').join(' '),
    });
  }
  return { series: merged, renamed: renamed.sort(), deduplicated, disagreed };
}

/**
 * Build a table from any number of series, from any number of files.
 *
 * Flight and science files merge here with nothing special done to their
 * clocks: both computers stamp epoch seconds and the science clock is set
 * from the flight's, so their samples interleave on one axis. They are not
 * the *same* clock, though — see the note this adds when both are present.
 */
export function buildTable(series: readonly Series[], options: BuildOptions = {}): Table {
  const { join = 'union', maxRows = DEFAULT_MAX_ROWS } = options;
  const notes: string[] = [];

  const grouped = groupSeries(series);
  const usable = grouped.series.filter((s) => s.time.length > 0);
  if (grouped.renamed.length > 0) {
    notes.push(
      `${grouped.renamed.join(', ')}: this sensor is written by both computers, so the ` +
        'columns say which one they came from. The science copy is the measurement; ' +
        'the flight copy is what was relayed to the flight computer, at its own slower rate.',
    );
  }
  if (grouped.deduplicated > 0) {
    notes.push(
      `${grouped.deduplicated.toLocaleString()} sample(s) appeared in more than one file from ` +
        'the same computer — sbd, mbd and dbd are three decimations of one flight record, as ' +
        'tbd, nbd and ebd are of one science record — and were merged rather than repeated.',
    );
  }
  if (grouped.disagreed > 0) {
    notes.push(
      `${grouped.disagreed.toLocaleString()} of those disagreed about the value, which should ` +
        'not happen between two decimations of one record. The value from the fuller file was ' +
        'kept, and the two files differ from each other over those samples.',
    );
  }
  if (usable.length === 0) {
    return { time: new Float64Array(0), columns: [], rows: 0, notes: ['No sensor reported a value.'] };
  }

  // A sample whose cycle had no clock has nowhere to go in a time-indexed
  // table. Counted rather than dropped quietly.
  let clockless = 0;

  let rowTime: Float64Array;
  if (join === 'interpolate') {
    const named = options.base ? usable.find((s) => s.name === options.base) : undefined;
    const base =
      named ??
      usable.reduce((best, s) => (s.time.length > best.time.length ? s : best), usable[0]);
    rowTime = Float64Array.from([...base.time].filter((t) => Number.isFinite(t)));
    clockless += base.time.length - rowTime.length;
    notes.push(
      `Rows are ${base.name}'s own sample times. Every other column is linearly ` +
        'interpolated onto them and is not a value the glider recorded.',
    );
  } else {
    const seen = new Set<number>();
    for (const s of usable) {
      for (const t of s.time) {
        if (Number.isFinite(t)) seen.add(t);
        else clockless++;
      }
    }
    rowTime = Float64Array.from(seen).sort();
  }

  if (clockless > 0) {
    notes.push(`${clockless} sample(s) had no clock on their cycle and are not in the table.`);
  }

  if (rowTime.length > maxRows) {
    notes.push(
      `Truncated to the first ${maxRows.toLocaleString()} of ${rowTime.length.toLocaleString()} rows. ` +
        'Fewer files, or fewer sensors, would bring the whole span under the limit.',
    );
    rowTime = rowTime.slice(0, maxRows);
  }

  // Row lookup for the union join. Exact equality is right here: these are
  // the very same doubles that came out of the file, not recomputed ones.
  const rowOf = new Map<number, number>();
  if (join === 'union') rowTime.forEach((t, i) => rowOf.set(t, i));

  const columns: Column[] = usable.map((s) => {
    if (join === 'interpolate') {
      const values = isAngular(s.name)
        ? interpolateAngleOnto(rowTime, s.time, s.value)
        : interpolateOnto(rowTime, s.time, s.value);
      return { name: s.name, unit: s.unit, values, source: 'interpolated' as const, from: s.from };
    }
    const values = new Float64Array(rowTime.length).fill(NaN);
    for (let i = 0; i < s.time.length; i++) {
      const row = rowOf.get(s.time[i]);
      if (row !== undefined) values[row] = s.value[i];
    }
    return { name: s.name, unit: s.unit, values, source: 'recorded' as const, from: s.from };
  });

  const flight = usable.some((s) => s.name.startsWith('m_') || s.name.startsWith('c_'));
  const science = usable.some((s) => s.name.startsWith('sci_'));
  if (flight && science && join === 'union') {
    notes.push(
      'Flight and science samples are on one axis. The science computer keeps its own ' +
        'clock, set from the flight computer, so the two agree to within that sync.',
    );
  }

  return { time: rowTime, columns: orderColumns(columns), rows: rowTime.length, notes };
}
