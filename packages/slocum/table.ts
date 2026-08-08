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

import type { Series } from './types.ts';

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

/** `electa-2025-120-1-169.tbd` → `tbd`. */
const extensionOf = (file: string | undefined): string =>
  (file ?? '').split('.').pop()?.toLowerCase() ?? '';

/**
 * Collapse series that are the same quantity, and keep apart the ones that
 * are not.
 *
 * Two different things look identical at this point and must not be treated
 * alike:
 *
 * - **The same sensor across segments.** A deployment is hundreds of files
 *   and `sci_water_temp` in segment 169 continues `sci_water_temp` in
 *   segment 170. One column, concatenated in time.
 *
 * - **The same sensor name from the two computers.** `sci_water_pressure` is
 *   measured by the science computer and *relayed* to the flight computer,
 *   which logs it at its own much slower rate — 853 samples against 4 in the
 *   fixture pair. Both are real, they are not the same record, and merging
 *   them would interleave a full-rate profile with a handful of stale relays
 *   under one name. Two columns, distinguished by the file family they came
 *   from.
 *
 * The distinction is the *extension*, not the file: flight (`sbd`/`mbd`/
 * `dbd`) and science (`tbd`/`nbd`/`ebd`) are different instruments, while two
 * segments off the same computer are one.
 */
function groupSeries(series: readonly Series[]): { series: Series[]; renamed: string[] } {
  const renamed: string[] = [];
  const groups = new Map<string, Series[]>();
  for (const s of series) {
    // A pipe, because Slocum sensor names are `[a-z0-9_]` and extensions are
    // three letters, so neither can contain one — and unlike the NUL this was
    // first written with, it survives grep and is visible in an editor.
    const key = `${s.name}|${extensionOf(s.from)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  // A name claimed by more than one family has to say which; a name claimed
  // by one keeps it, so the ordinary single-pair case reads unchanged.
  const families = new Map<string, Set<string>>();
  for (const key of groups.keys()) {
    const [name, ext] = key.split('|');
    const seen = families.get(name) ?? new Set<string>();
    seen.add(ext);
    families.set(name, seen);
  }

  const merged: Series[] = [];
  for (const [key, bucket] of groups) {
    const [name, ext] = key.split('|');
    const ambiguous = (families.get(name)?.size ?? 1) > 1;
    const label = ambiguous && ext ? `${name}_${ext}` : name;
    if (label !== name) renamed.push(label);

    if (bucket.length === 1) {
      merged.push({ ...bucket[0], name: label });
      continue;
    }

    // Concatenate, then sort by time: segments arrive in whatever order the
    // reader picked them, and the join below needs ascending time.
    const total = bucket.reduce((n, s) => n + s.time.length, 0);
    const pairs = new Array<[number, number]>(total);
    let at = 0;
    for (const s of bucket) {
      for (let i = 0; i < s.time.length; i++) pairs[at++] = [s.time[i], s.value[i]];
    }
    pairs.sort((a, b) => a[0] - b[0]);
    merged.push({
      name: label,
      unit: bucket[0].unit,
      time: Float64Array.from(pairs, (p) => p[0]),
      value: Float64Array.from(pairs, (p) => p[1]),
      from: bucket.map((s) => s.from ?? '').join(' '),
    });
  }
  return { series: merged, renamed: renamed.sort() };
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
        'columns carry the file family they came from. The science copy is the measurement; ' +
        'the flight copy is what was relayed to the flight computer, at its own slower rate.',
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
        'Decode fewer files, or fewer sensors, for the whole span.',
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

  return { time: rowTime, columns, rows: rowTime.length, notes };
}
