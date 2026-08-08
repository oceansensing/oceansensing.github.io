/**
 * Seawater properties worked out from what the glider recorded.
 *
 * A Slocum CTD writes conductivity, in-situ temperature and pressure. Nobody
 * wants those three: they want salinity, density and the stratification. The
 * arithmetic is TEOS-10 and `packages/teos10` already has it, checked against
 * GSW on every build, so this is the join between the two and nothing more.
 *
 * **Off by default, and labelled.** Every column here is `source: 'derived'`,
 * which reaches the CSV heading and the netCDF `comment` attribute. A derived
 * salinity in a file of recorded sensors, with nothing to say which is which,
 * is the failure this package is otherwise built to avoid.
 *
 * # The units are the whole risk
 *
 * Slocum writes conductivity in **S/m** and pressure in **bar**; TEOS-10 and
 * PSS-78 want **mS/cm** and **dbar**. Both conversions are ×10, both are
 * silent when wrong, and neither produces anything that looks broken: a
 * salinity computed from S/m read as mS/cm comes out near 3, which is a
 * number, and a density computed from bar read as dbar is wrong in the third
 * decimal.
 *
 * So the unit string is read *and* the result is range-checked. The string
 * alone is not enough — believing a units attribute is how this project once
 * drew sea-ice concentration in the bottom hundredth of its colour ramp — and
 * the range check alone would not say which input was at fault.
 */

import {
  ctFromT,
  density,
  potentialDensity,
  saFromSP,
  soundSpeed,
  spFromC,
  srFromSP,
  type SalinityAtlas,
} from '@c4po/teos10';

import { interpolateOnto, type Column, type Table } from './table.ts';
import { isLatLonSensor, isValidNmea, nmeaToDecimal } from './nmea.ts';

/** What the glider's CTD is called, on either computer. */
const CONDUCTIVITY = ['sci_water_cond', 'sci_rbrctd_conductivity_00'];
const TEMPERATURE = ['sci_water_temp', 'sci_rbrctd_temperature_00'];
const PRESSURE = ['sci_water_pressure', 'sci_rbrctd_seapressure_00'];

/**
 * What PSS-78 is defined over, and outside which it is an extrapolated fit
 * rather than a salinity. Values outside come back NaN with a note, not
 * clamped — the same rule the seawater calculator states on its own page.
 */
const SP_RANGE = [2, 42];
/** A conductivity this low is a glider in air, or a pump that has not run. */
const MIN_CONDUCTIVITY_MS_CM = 1;

export interface DeriveOptions {
  /**
   * The Absolute Salinity Anomaly atlas. Without it — or without a position —
   * Absolute Salinity falls back to Reference Salinity, which is a different
   * quantity, and that is said in the notes rather than left to be assumed.
   */
  atlas?: SalinityAtlas | null;
}

export interface DeriveResult {
  columns: Column[];
  notes: string[];
}

const finite = (v: number) => Number.isFinite(v);

/**
 * The suffix `buildTable` adds when a sensor is written by both computers —
 * `sci_water_pressure_tbd`.
 *
 * Anchored to the actual extensions rather than "three letters after an
 * underscore", which is what this was first written as and which strips the
 * `_lat` off `m_lat`: the position lookup then found no position at all and
 * silently reported Reference Salinity for a file that had a perfectly good
 * fix in it.
 */
const FAMILY_SUFFIX = /_[smdtne][bc]d$/;



/**
 * The first of `names` the table has a column for, following the suffix when
 * one was added.
 *
 * `prefer` decides which copy wins when both computers wrote the sensor. For
 * the CTD that is the science computer — it holds the measurement, where the
 * flight computer holds a slow relay of it. For position it is the other way
 * round: the fix is the flight computer's.
 */
function findColumn(
  table: Table,
  names: readonly string[],
  prefer: 'science' | 'flight' = 'science',
): Column | undefined {
  for (const name of names) {
    const variants = table.columns.filter(
      (c) => c.name === name || (c.name.replace(FAMILY_SUFFIX, '') === name && FAMILY_SUFFIX.test(c.name)),
    );
    if (variants.length === 0) continue;
    if (variants.length === 1) return variants[0];
    const science = variants.find((c) => /_[tne][bc]d$/.test(c.name));
    const flight = variants.find((c) => !/_[tne][bc]d$/.test(c.name));
    return (prefer === 'science' ? science ?? flight : flight ?? science) ?? variants[0];
  }
  return undefined;
}

/** Positions for every row, for the anomaly lookup. */
function positionsFor(table: Table): { lat: Float64Array; lon: Float64Array; note?: string } | null {
  // `m_lat` is the glider's dead-reckoned position and `m_gps_lat` only exists
  // while it is on the surface with a fix, so the first is the one that spans
  // a dive. Both are NMEA.
  const latColumn = findColumn(table, ['m_lat', 'm_gps_lat'], 'flight');
  const lonColumn = findColumn(table, ['m_lon', 'm_gps_lon'], 'flight');
  if (!latColumn || !lonColumn || !isLatLonSensor(latColumn.name.replace(FAMILY_SUFFIX, ''))) {
    return null;
  }

  // Fixes are NMEA and only exist when the glider surfaced, so there are a
  // handful per segment against thousands of CTD samples.
  const times: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < table.rows; i++) {
    const rawLat = latColumn.values[i];
    const rawLon = lonColumn.values[i];
    if (!isValidNmea(rawLat, true) || !isValidNmea(rawLon, false)) continue;
    times.push(table.time[i]);
    lats.push(nmeaToDecimal(rawLat));
    lons.push(nmeaToDecimal(rawLon));
  }
  if (times.length === 0) return null;

  if (times.length === 1) {
    return {
      lat: new Float64Array(table.rows).fill(lats[0]),
      lon: new Float64Array(table.rows).fill(lons[0]),
      note: 'One position fix in these files; it is used for every row.',
    };
  }

  // Interpolating position is a different thing from interpolating a
  // measurement: it is an input to a 4°-lattice lookup, not a column anybody
  // reads. A whole dive sits well inside one cell of that lattice.
  const time = Float64Array.from(times);
  return {
    lat: fillEnds(interpolateOnto(table.time, time, Float64Array.from(lats)), lats),
    lon: fillEnds(interpolateOnto(table.time, time, Float64Array.from(lons)), lons),
    note:
      'Position between surfacings is interpolated, for the salinity anomaly lookup only. ' +
      'It is not written as a column.',
  };
}

/** Hold the first and last fix past the ends, rather than losing those rows. */
function fillEnds(values: Float64Array, source: readonly number[]): Float64Array {
  const first = source[0];
  const last = source[source.length - 1];
  let i = 0;
  while (i < values.length && !finite(values[i])) values[i++] = first;
  let j = values.length - 1;
  while (j >= 0 && !finite(values[j])) values[j--] = last;
  return values;
}

/**
 * Append salinity, temperature, density and sound speed to a table that has a
 * CTD in it. Returns no columns and one note when it does not.
 */
export function deriveSeawater(table: Table, options: DeriveOptions = {}): DeriveResult {
  const notes: string[] = [];

  const condColumn = findColumn(table, CONDUCTIVITY);
  const tempColumn = findColumn(table, TEMPERATURE);
  const presColumn = findColumn(table, PRESSURE);

  const missing = [
    condColumn ? null : 'conductivity',
    tempColumn ? null : 'temperature',
    presColumn ? null : 'pressure',
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      columns: [],
      notes: [`No seawater properties: these files carry no ${missing.join(', no ')}.`],
    };
  }

  // Slocum's own unit strings decide the scale, and the values then have to
  // agree with them. `s/m` → mS/cm and `bar` → dbar are both ×10.
  const condScale = /^s\/m$/i.test(condColumn!.unit) ? 10 : 1;
  const presScale = /^bar$/i.test(presColumn!.unit) ? 10 : 1;
  if (condScale === 1 && !/ms\/cm/i.test(condColumn!.unit)) {
    notes.push(
      `Conductivity is in "${condColumn!.unit}", which is not the S/m these files normally use. ` +
        'It has been taken as mS/cm, so the salinity below rests on that reading of the unit.',
    );
  }
  if (presScale === 1 && !/dbar/i.test(presColumn!.unit)) {
    notes.push(
      `Pressure is in "${presColumn!.unit}", not the bar these files normally use — ` +
        'it has been taken as dbar.',
    );
  }

  const rows = table.rows;
  const sp = new Float64Array(rows).fill(NaN);
  const sa = new Float64Array(rows).fill(NaN);
  const ct = new Float64Array(rows).fill(NaN);
  const rho = new Float64Array(rows).fill(NaN);
  const sigma0 = new Float64Array(rows).fill(NaN);
  const sound = new Float64Array(rows).fill(NaN);

  const position = options.atlas ? positionsFor(table) : null;
  if (position?.note) notes.push(position.note);

  let usable = 0;
  let outOfRange = 0;
  let dry = 0;
  let withAnomaly = 0;

  for (let i = 0; i < rows; i++) {
    const c = condColumn!.values[i] * condScale; // mS/cm
    const t = tempColumn!.values[i]; // °C, ITS-90
    const p = presColumn!.values[i] * presScale; // dbar
    if (!finite(c) || !finite(t) || !finite(p)) continue;

    // The CTD reads near zero out of the water, and PSS-78 will happily turn
    // that into a salinity of 0.03. Not a measurement of anything.
    if (c < MIN_CONDUCTIVITY_MS_CM) {
      dry++;
      continue;
    }

    const practical = spFromC(c, t, p);
    if (!finite(practical) || practical < SP_RANGE[0] || practical > SP_RANGE[1]) {
      outOfRange++;
      continue;
    }

    sp[i] = practical;

    // `saFromSP` returns NaN rather than quietly handing back Reference
    // Salinity under Absolute Salinity's name — that refusal is the whole
    // point of the TEOS-10 package, so the fallback is made here, counted,
    // and reflected in what the column is *called*.
    const absolute = position
      ? saFromSP(practical, p, position.lon[i], position.lat[i], options.atlas ?? null)
      : NaN;
    const anomalyApplied = finite(absolute);
    if (anomalyApplied) withAnomaly++;
    const salinity = anomalyApplied ? absolute : srFromSP(practical);

    sa[i] = salinity;
    ct[i] = ctFromT(salinity, t, p);
    rho[i] = density(salinity, t, p);
    sigma0[i] = potentialDensity(salinity, t, p, 0) - 1000;
    sound[i] = soundSpeed(salinity, t, p);
    usable++;
  }

  if (usable === 0) {
    return {
      columns: [],
      notes: [...notes, 'No row had a usable conductivity, temperature and pressure together.'],
    };
  }
  if (dry > 0) {
    notes.push(`${dry} row(s) had the CTD out of the water and are left empty.`);
  }
  if (outOfRange > 0) {
    notes.push(
      `${outOfRange} row(s) gave a practical salinity outside PSS-78's ${SP_RANGE[0]}–${SP_RANGE[1]} ` +
        'and are left empty rather than reported.',
    );
  }
  // The column is named for the quantity it holds, not for the one that was
  // wanted. Reference Salinity in a column headed `salinity_absolute` is the
  // substitution TEOS-10 exists to prevent, and it is invisible in the
  // numbers: the two differ by 0.03 g/kg at most, in the fourth digit.
  const everyRow = withAnomaly === usable && usable > 0;
  const salinityName = everyRow ? 'salinity_absolute' : 'salinity_reference';

  if (!everyRow) {
    const why = !options.atlas
      ? 'the anomaly atlas was not loaded'
      : !position
        ? 'these files carry no valid position'
        : `the anomaly was unavailable for ${usable - withAnomaly} of ${usable} rows`;
    notes.push(
      `Salinity is reported as Reference Salinity, not Absolute Salinity, because ${why}. ` +
        'The two differ by up to 0.03 g/kg — about 0.024 kg/m³ of density — which is why the ' +
        'column is named for what it is. Conservative Temperature, density, sigma0 and sound ' +
        'speed are computed from it and carry the same approximation.',
    );
  }

  const derived = (name: string, unit: string, values: Float64Array): Column => ({
    name,
    unit,
    values,
    source: 'derived',
    from: `derived from ${condColumn!.name}, ${tempColumn!.name}, ${presColumn!.name}`,
  });

  return {
    columns: [
      derived('salinity_practical', 'PSU', sp),
      derived(salinityName, 'g/kg', sa),
      derived('temperature_conservative', 'degc', ct),
      derived('density', 'kg/m^3', rho),
      derived('sigma0', 'kg/m^3', sigma0),
      derived('sound_speed', 'm/s', sound),
    ],
    notes,
  };
}
