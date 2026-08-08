/**
 * OceanGliders OG1.0 — the community trajectory format.
 *
 * Spec: https://oceangliderscommunity.github.io/OG-format-user-manual/OG_Format.html
 * (v1.0.0, June 2024). The format's own reference examples include
 * `unit_345_20231112T000000_R`, which is a Slocum G2, so this mapping has a
 * worked example to follow.
 *
 * # What this can and cannot claim
 *
 * **The structure, variables, units and attributes are OG1.0.** The
 * *encoding* is netCDF-3 classic, because a browser cannot write HDF5 without
 * shipping a megabyte of WASM — see `netcdf.ts`. Everywhere OG1 uses an
 * `NC_STRING` this uses a fixed-width `char` array, which is the classic-era
 * CF equivalent and reads correctly in xarray, MATLAB and `ncdump`.
 *
 * `cdl.ts` writes the identical document as CDL text, which `ncgen -4` turns
 * into a genuine netCDF-4 file in one command. That is the exact route to a
 * byte-conformant file, and it is why the CDL export exists.
 *
 * So: **"OG1.0 structure, netCDF-3 encoding"**, not "validated OG1.0". The
 * community's checkers are themselves experimental
 * (http://conventions.castelao.net/OG/validate says so), and claiming a
 * compliance nobody has verified is the kind of label this project keeps
 * paying for.
 *
 * # What the glider does not record
 *
 * OG1 wants a value at every measurement for things a Slocum file has
 * sparsely or not at all. Each is computed, and each says so in its own
 * attributes rather than passing as recorded:
 *
 * - **LATITUDE/LONGITUDE** — interpolated between the glider's own
 *   dead-reckoned fixes. The GPS fixes themselves go to `LATITUDE_GPS` /
 *   `LONGITUDE_GPS` / `TIME_GPS`, which is exactly the split OG1 defines
 *   these variables for.
 * - **DEPTH** — from pressure and latitude through TEOS-10's exact
 *   depth-from-pressure, not the 1 dbar ≈ 1 m approximation.
 * - **PHASE, SEGMENT_NUMBER, PROFILE_NUMBER, PROFILE_DIRECTION** — see below.
 * - **PSAL** — PSS-78 from the recorded conductivity, temperature and
 *   pressure.
 *
 * # A note on units, where the spec and its own example disagree
 *
 * The spec's geophysical table gives `CNDC:units = "mS cm-1"`; the Slocum
 * example file writes `"mhos/m"`, which is S/m — ten times smaller. This
 * follows the **spec**, since that is the normative document and the example
 * is demonstrably loose elsewhere (it writes `DEPLOYMENT_LATITUDE = "nan"`
 * into a double and leaves most vocabulary attributes empty). Slocum records
 * S/m, so the conversion is the same ×10 `derive.ts` already makes.
 */

import { depthFromPressure, spFromC } from '@c4po/teos10';

import { interpolateOnto, type Column, type Table } from './table.ts';
import { isValidNmea, nmeaToDecimal } from './nmea.ts';
import {
  packStrings,
  real,
  text,
  type NcAttribute,
  type NcDocument,
  type NcVariable,
} from './netcdf.ts';

// ── The metadata a Slocum file cannot supply ─────────────────────────────────

/**
 * One field of the deployment metadata.
 *
 * Declared as data rather than as form markup so the page, the validation, the
 * saved profile and the documentation all read the same list. A field added
 * here appears in the form and in the file with no other change — the same
 * bargain `FIELDS` strikes in the map's scalar layer.
 */
export interface Og1Field {
  key: keyof Og1Metadata;
  label: string;
  /** OG1 marks this mandatory; the export is refused without it. */
  required: boolean;
  group: 'platform' | 'deployment' | 'people' | 'programme' | 'quality' | 'sensor';
  kind?: 'text' | 'number' | 'datetime' | 'select';
  options?: readonly string[];
  placeholder?: string;
  help?: string;
}

export interface Og1Metadata {
  // ── platform ──
  platformSerial: string;
  platformType: string;
  platformModel: string;
  wmoIdentifier: string;
  platform: string;
  platformVocabulary: string;
  // ── deployment ──
  dataMode: string;
  deploymentTime: string;
  deploymentLatitude: string;
  deploymentLongitude: string;
  internalMissionIdentifier: string;
  title: string;
  // ── people ──
  contributorName: string;
  contributorEmail: string;
  contributorRole: string;
  contributorRoleVocabulary: string;
  contributorId: string;
  contributingInstitutions: string;
  contributingInstitutionsRole: string;
  contributingInstitutionsRoleVocabulary: string;
  contributingInstitutionsVocabulary: string;
  namingAuthority: string;
  institution: string;
  // ── programme ──
  site: string;
  siteVocabulary: string;
  program: string;
  programVocabulary: string;
  project: string;
  network: string;
  dataUrl: string;
  doi: string;
  webLink: string;
  comment: string;
  // ── quality ──
  rtqcMethod: string;
  rtqcMethodDoi: string;
  // ── sensor ──
  ctdSensorType: string;
  ctdSerial: string;
  ctdModel: string;
}

/** The NERC vocabularies OG1 points at, so the defaults are not invented. */
const VOCAB = {
  platform: 'http://vocab.nerc.ac.uk/collection/L06/current/27/',
  role: 'http://vocab.nerc.ac.uk/collection/W08/current/',
  institution: 'https://edmo.seadatanet.org/',
  parameter: 'http://vocab.nerc.ac.uk/collection/OG1/current/',
  sensorType: 'http://vocab.nerc.ac.uk/collection/L05/current/',
  phase:
    'https://github.com/OceanGlidersCommunity/OG-format-user-manual/blob/main/vocabularyCollection/phase.md',
  standardName:
    'https://cfconventions.org/Data/cf-standard-names/current/build/cf-standard-name-table.html',
} as const;

export const OG1_FIELDS: readonly Og1Field[] = [
  // ── platform ──
  { key: 'platformSerial', label: 'Platform serial', required: true, group: 'platform',
    placeholder: 'unit_507',
    help: 'The glider as its own files name it. It becomes the first part of the file name and of `id`.' },
  { key: 'platformType', label: 'Platform type', required: true, group: 'platform',
    kind: 'select', options: ['slocum', 'seaglider', 'seaexplorer', 'spray'] },
  { key: 'platformModel', label: 'Platform model', required: true, group: 'platform',
    placeholder: 'G3' },
  { key: 'wmoIdentifier', label: 'WMO identifier', required: true, group: 'platform',
    placeholder: '4802960',
    help: 'The platform\'s WMO number. Required by OG1; leave the deployment unregistered at your own risk.' },
  { key: 'platform', label: 'Platform description', required: true, group: 'platform' },
  { key: 'platformVocabulary', label: 'Platform vocabulary', required: true, group: 'platform' },

  // ── deployment ──
  { key: 'title', label: 'Title', required: true, group: 'deployment' },
  { key: 'dataMode', label: 'Data mode', required: true, group: 'deployment',
    kind: 'select', options: ['R', 'delayed', 'recovery'],
    help: 'R for near-real-time — which is what an sbd/tbd pair off Iridium is.' },
  { key: 'deploymentTime', label: 'Deployment time (UTC)', required: true, group: 'deployment',
    kind: 'datetime' },
  { key: 'deploymentLatitude', label: 'Deployment latitude', required: true, group: 'deployment',
    kind: 'number', placeholder: '38.21' },
  { key: 'deploymentLongitude', label: 'Deployment longitude', required: true, group: 'deployment',
    kind: 'number', placeholder: '-73.74' },
  { key: 'internalMissionIdentifier', label: 'Internal mission identifier', required: false,
    group: 'deployment', placeholder: 'electa_20250501' },

  // ── people ──
  { key: 'contributorName', label: 'PI name', required: true, group: 'people',
    help: 'OG1 makes the PI mandatory. Several contributors are separated by commas.' },
  { key: 'contributorEmail', label: 'PI email', required: true, group: 'people' },
  { key: 'contributorRole', label: 'PI role', required: true, group: 'people' },
  { key: 'contributorRoleVocabulary', label: 'Role vocabulary', required: true, group: 'people' },
  { key: 'contributorId', label: 'Contributor ID (ORCID)', required: false, group: 'people' },
  { key: 'contributingInstitutions', label: 'Operating institution', required: true,
    group: 'people', help: 'OG1 makes the operator mandatory.' },
  { key: 'contributingInstitutionsRole', label: 'Institution role', required: true, group: 'people' },
  { key: 'contributingInstitutionsRoleVocabulary', label: 'Institution role vocabulary',
    required: true, group: 'people' },
  { key: 'contributingInstitutionsVocabulary', label: 'Institution vocabulary', required: false,
    group: 'people' },
  { key: 'namingAuthority', label: 'Naming authority', required: false, group: 'people' },
  { key: 'institution', label: 'Institution', required: false, group: 'people' },

  // ── programme ──
  { key: 'site', label: 'Site', required: false, group: 'programme' },
  { key: 'siteVocabulary', label: 'Site vocabulary', required: false, group: 'programme' },
  { key: 'program', label: 'Programme', required: false, group: 'programme' },
  { key: 'programVocabulary', label: 'Programme vocabulary', required: false, group: 'programme' },
  { key: 'project', label: 'Project', required: false, group: 'programme' },
  { key: 'network', label: 'Network', required: false, group: 'programme' },
  { key: 'dataUrl', label: 'Data URL', required: false, group: 'programme' },
  { key: 'doi', label: 'DOI', required: false, group: 'programme' },
  { key: 'webLink', label: 'Web link', required: false, group: 'programme' },
  { key: 'comment', label: 'Comment', required: false, group: 'programme' },

  // ── quality ──
  { key: 'rtqcMethod', label: 'Real-time QC method', required: true, group: 'quality',
    help: 'This decoder applies none, so the honest default says so.' },
  { key: 'rtqcMethodDoi', label: 'QC method DOI', required: false, group: 'quality' },

  // ── sensor ──
  { key: 'ctdSensorType', label: 'CTD sensor type', required: false, group: 'sensor',
    help: 'Names the SENSOR_<type>_<serial> variable the CTD parameters point at.' },
  { key: 'ctdSerial', label: 'CTD serial number', required: false, group: 'sensor' },
  { key: 'ctdModel', label: 'CTD model', required: false, group: 'sensor' },
];

/**
 * What the form starts with.
 *
 * Only the genuinely universal answers are filled in — the vocabularies OG1
 * itself names, the fixed title, and a QC statement that is true of this
 * decoder. Nothing that identifies a glider, a person or an institution is
 * guessed: a plausible wrong WMO number is worse than an empty box.
 */
export const OG1_DEFAULTS: Og1Metadata = {
  platformSerial: '',
  platformType: 'slocum',
  platformModel: '',
  wmoIdentifier: '',
  platform: 'sub-surface gliders',
  platformVocabulary: VOCAB.platform,
  dataMode: 'R',
  deploymentTime: '',
  deploymentLatitude: '',
  deploymentLongitude: '',
  internalMissionIdentifier: '',
  title: 'OceanGliders trajectory file',
  contributorName: '',
  contributorEmail: '',
  contributorRole: 'PI',
  contributorRoleVocabulary: VOCAB.role,
  contributorId: '',
  contributingInstitutions: '',
  contributingInstitutionsRole: 'Operator',
  contributingInstitutionsRoleVocabulary: VOCAB.role,
  contributingInstitutionsVocabulary: VOCAB.institution,
  namingAuthority: '',
  institution: '',
  site: '',
  siteVocabulary: '',
  program: '',
  programVocabulary: '',
  project: '',
  network: '',
  dataUrl: '',
  doi: '',
  webLink: '',
  comment: '',
  rtqcMethod: 'No QC applied',
  rtqcMethodDoi: '',
  ctdSensorType: 'CTD',
  ctdSerial: '',
  ctdModel: '',
};

/** Which mandatory fields are still empty. Empty array means ready. */
export function missingFields(metadata: Og1Metadata): Og1Field[] {
  return OG1_FIELDS.filter((f) => f.required && !String(metadata[f.key] ?? '').trim());
}

// ── Time formatting ──────────────────────────────────────────────────────────

/**
 * `YYYYmmddTHHMMss`, which is what OG1 specifies for `start_date`,
 * `date_created` and the time coverage.
 *
 * Note the spec's own Slocum example writes `time_coverage_start` as
 * `"2023-11-12T10:10Z"` instead, which is a different format from the one the
 * table two pages earlier requires. This follows the table.
 */
export function stampCompact(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '';
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
}

/** Accepts what a datetime-local input gives, or an ISO string, or nothing. */
export function parseWhen(value: string): number {
  if (!value.trim()) return NaN;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? NaN : ms / 1000;
}

// ── Finding the Slocum sensors that carry each OG1 quantity ──────────────────

/** The family suffix `buildTable` adds when both computers wrote a sensor. */
const FAMILY = /_[smdtne][bc]d$/;

function column(table: Table, names: readonly string[]): Column | undefined {
  for (const name of names) {
    const exact = table.columns.find((c) => c.name === name);
    if (exact) return exact;
    const suffixed = table.columns.filter(
      (c) => FAMILY.test(c.name) && c.name.replace(FAMILY, '') === name,
    );
    if (suffixed.length > 0) {
      // The science copy is the measurement where both exist.
      return suffixed.find((c) => /_[tne][bc]d$/.test(c.name)) ?? suffixed[0];
    }
  }
  return undefined;
}

const CONDUCTIVITY = ['sci_water_cond', 'sci_rbrctd_conductivity_00'];
const TEMPERATURE = ['sci_water_temp', 'sci_rbrctd_temperature_00'];
const PRESSURE = ['sci_water_pressure', 'sci_rbrctd_seapressure_00'];

/**
 * The glider's own behaviour state, when it is logged.
 *
 * OceanGliders publishes a translation table from `cc_final_behavior_state`
 * to the OG PHASE vocabulary. It is far better than inferring phase from the
 * pressure record — it is what the glider was *commanded* to do rather than
 * what it appears to have done — but it is frequently not in the decimated
 * files sent over Iridium, which is why the inference below exists at all.
 */
const BEHAVIOUR = ['cc_final_behavior_state', 'm_depth_state'];

/** Slocum `cc_final_behavior_state` → OG1 PHASE, from the published table. */
const BEHAVIOUR_TO_PHASE: Record<number, number> = {
  0: 5, // inflection
  1: 2, // descent
  2: 1, // ascent
  3: 4, // parking
  5: 3, // surfacing
};

// ── The derived per-measurement fields ───────────────────────────────────────

const PHASE_UNKNOWN = 0;
const PHASE_ASCENT = 1;
const PHASE_DESCENT = 2;
const PHASE_SURFACING = 3;
const PHASE_INFLECTION = 5;

/** At or above this pressure the glider is at the surface. */
const SURFACE_DBAR = 1;

export interface PhaseResult {
  phase: Int8Array;
  segment: Int32Array;
  profile: Int32Array;
  direction: Int8Array;
  /** For `phase_calculation_method` — what was actually done. */
  method: string;
}

/**
 * PHASE, and the segment and profile numbering that follows from it.
 *
 * Uses the glider's own behaviour state where the file carries it. Otherwise
 * infers from the rate of change of pressure, with the threshold taken from
 * the data rather than fixed: a quarter of the median absolute rate, floored
 * so a stationary record does not divide everything into noise. A fixed
 * threshold in dbar/s would be wrong for a shallow-water flight and wrong
 * again for a deep one.
 */
export function derivePhase(
  time: Float64Array,
  pressureDbar: Float64Array,
  behaviour?: Column,
): PhaseResult {
  const n = time.length;
  const phase = new Int8Array(n);
  const direction = new Int8Array(n);

  let method: string;

  if (behaviour && behaviour.values.some(Number.isFinite)) {
    method =
      'From the glider’s own cc_final_behavior_state, via the OceanGliders Slocum ' +
      'phase translation table.';
    let last = PHASE_UNKNOWN;
    for (let i = 0; i < n; i++) {
      const state = behaviour.values[i];
      if (Number.isFinite(state)) last = BEHAVIOUR_TO_PHASE[state] ?? PHASE_UNKNOWN;
      phase[i] = last;
    }
  } else {
    method =
      'Inferred from the rate of change of pressure: the glider’s own behaviour state ' +
      'was not logged in these files. Descent and ascent are where the smoothed rate ' +
      'exceeds a quarter of its median absolute value; at or above ' +
      `${SURFACE_DBAR} dbar the phase is surfacing.`;

    // Rate by central difference over the nearest finite neighbours, so gaps
    // in a sparse union table do not each become an inflection.
    const rate = new Float64Array(n).fill(NaN);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(pressureDbar[i])) idx.push(i);
    for (let k = 0; k < idx.length; k++) {
      const a = idx[Math.max(0, k - 1)];
      const b = idx[Math.min(idx.length - 1, k + 1)];
      const dt = time[b] - time[a];
      if (dt > 0) rate[idx[k]] = (pressureDbar[b] - pressureDbar[a]) / dt;
    }

    const magnitudes = [...rate].filter((v) => Number.isFinite(v)).map(Math.abs).sort((x, y) => x - y);
    const median = magnitudes.length ? magnitudes[magnitudes.length >> 1] : 0;
    const threshold = Math.max(0.005, 0.25 * median);

    let last = PHASE_UNKNOWN;
    for (let i = 0; i < n; i++) {
      const p = pressureDbar[i];
      const r = rate[i];
      if (Number.isFinite(p) && p <= SURFACE_DBAR) last = PHASE_SURFACING;
      else if (Number.isFinite(r)) {
        last = r > threshold ? PHASE_DESCENT : r < -threshold ? PHASE_ASCENT : PHASE_INFLECTION;
      }
      phase[i] = last;
    }
  }

  for (let i = 0; i < n; i++) {
    direction[i] = phase[i] === PHASE_DESCENT ? 1 : phase[i] === PHASE_ASCENT ? -1 : 0;
  }

  // SEGMENT_NUMBER starts at 1 and increments each time the glider *enters*
  // the surface phase; PROFILE_NUMBER each time a dive or a climb begins.
  const segment = new Int32Array(n);
  const profile = new Int32Array(n).fill(-9999);
  let segmentNumber = 1;
  let profileNumber = 0;
  let previous = PHASE_UNKNOWN;
  for (let i = 0; i < n; i++) {
    if (phase[i] === PHASE_SURFACING && previous !== PHASE_SURFACING && i > 0) segmentNumber++;
    const profiling = phase[i] === PHASE_ASCENT || phase[i] === PHASE_DESCENT;
    if (profiling && phase[i] !== previous) profileNumber++;
    segment[i] = segmentNumber;
    if (profiling) profile[i] = profileNumber;
    previous = phase[i];
  }

  return { phase, segment, profile, direction, method };
}

// ── Building the document ────────────────────────────────────────────────────

/** QC flag 0: "No QC has been applied". Every variable gets one. */
const QC_NONE = 0;

const QC_ATTRS = (): NcAttribute[] => [
  text('long_name', 'quality flag'),
  { name: '_FillValue', type: 'byte', value: [QC_NONE] },
  { name: 'valid_range', type: 'byte', value: [0, 4] },
  { name: 'flag_values', type: 'byte', value: [0, 1, 2, 3, 4] },
  text(
    'flag_meanings',
    'No_QC_has_been_applied Good_data Probably_good_data Probably_bad_data Bad_data',
  ),
];

interface Param {
  name: string;
  longName: string;
  standardName?: string;
  units: string;
  values: Float64Array;
  /** Which sensor variable it came off, for PARAMETER_SENSOR. */
  sensor: string;
  derived?: string;
}

export interface Og1Result {
  document: NcDocument;
  /** `<platform_serial>_<start_date>_<data_mode>`, the OG1 `id`. */
  id: string;
  /** What was computed rather than recorded, for the reader. */
  notes: string[];
}

/**
 * Map a decoded table onto an OG1.0 document.
 *
 * Throws if a mandatory metadata field is missing — the file would not be
 * OG1 and writing it anyway is the sort of near-miss this whole package is
 * built to avoid. Ask `missingFields` first.
 */
export function buildOg1(table: Table, metadata: Og1Metadata): Og1Result {
  const missing = missingFields(metadata);
  if (missing.length > 0) {
    throw new Error(
      `OG1 needs ${missing.length} more field(s): ${missing.map((f) => f.label).join(', ')}`,
    );
  }
  if (table.rows === 0) throw new Error('OG1: nothing decoded to write');

  const notes: string[] = [];
  const n = table.rows;
  const time = table.time;

  // ── position ──
  const latRaw = column(table, ['m_lat']);
  const lonRaw = column(table, ['m_lon']);
  const gpsLatRaw = column(table, ['m_gps_lat']);
  const gpsLonRaw = column(table, ['m_gps_lon']);

  const decimal = (source: Column | undefined, isLat: boolean): Float64Array => {
    const out = new Float64Array(n).fill(NaN);
    if (!source) return out;
    for (let i = 0; i < n; i++) {
      const v = source.values[i];
      if (isValidNmea(v, isLat)) out[i] = nmeaToDecimal(v);
    }
    return out;
  };

  const gpsLat = decimal(gpsLatRaw, true);
  const gpsLon = decimal(gpsLonRaw, false);
  const fixLat = decimal(latRaw, true);
  const fixLon = decimal(lonRaw, false);

  // OG1 wants a position at every measurement. Slocum has them only where it
  // surfaced or dead-reckoned, so the track is interpolated between them —
  // which is what LATITUDE is for, LATITUDE_GPS being the fixes themselves.
  const spread = (fixes: Float64Array): Float64Array => {
    const at: number[] = [];
    const value: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(fixes[i])) { at.push(time[i]); value.push(fixes[i]); }
    }
    if (at.length === 0) return new Float64Array(n).fill(NaN);
    if (at.length === 1) return new Float64Array(n).fill(value[0]);
    const filled = interpolateOnto(time, Float64Array.from(at), Float64Array.from(value));
    // Hold the first and last fix past the ends rather than losing those rows.
    for (let i = 0; !Number.isFinite(filled[i]) && i < n; i++) filled[i] = value[0];
    for (let i = n - 1; !Number.isFinite(filled[i]) && i >= 0; i--) filled[i] = value[value.length - 1];
    return filled;
  };

  const latitude = spread(fixLat);
  const longitude = spread(fixLon);
  const positioned = latitude.some(Number.isFinite);
  if (positioned) {
    notes.push(
      'LATITUDE and LONGITUDE are interpolated between the glider’s own fixes; the fixes ' +
        'themselves are in LATITUDE_GPS and LONGITUDE_GPS.',
    );
  } else {
    notes.push('These files carry no valid position, so LATITUDE and LONGITUDE are empty.');
  }

  // ── the CTD ──
  const condColumn = column(table, CONDUCTIVITY);
  const tempColumn = column(table, TEMPERATURE);
  const presColumn = column(table, PRESSURE);

  const params: Param[] = [];
  const sensorName = sensorVariableName(metadata);

  // Slocum writes pressure in bar and conductivity in S/m; OG1 wants decibar
  // and mS cm-1. Both are ×10 and both are silent when wrong.
  const pressure = new Float64Array(n).fill(NaN);
  if (presColumn) {
    const scale = /^bar$/i.test(presColumn.unit) ? 10 : 1;
    for (let i = 0; i < n; i++) pressure[i] = presColumn.values[i] * scale;
    params.push({
      name: 'PRES', units: 'decibar', values: pressure, sensor: sensorName,
      standardName: 'sea_water_pressure',
      longName:
        'Pressure (spatial coordinate) exerted by the water body by profiling pressure ' +
        'sensor and correction to read zero at sea level',
    });
  }

  const conductivity = new Float64Array(n).fill(NaN);
  if (condColumn) {
    const scale = /^s\/m$/i.test(condColumn.unit) ? 10 : 1;
    for (let i = 0; i < n; i++) conductivity[i] = condColumn.values[i] * scale;
    params.push({
      name: 'CNDC', units: 'mS cm-1', values: conductivity, sensor: sensorName,
      standardName: 'sea_water_electrical_conductivity',
      longName: 'Electrical conductivity of the water body by CTD',
    });
  }

  const temperature = new Float64Array(n).fill(NaN);
  if (tempColumn) {
    for (let i = 0; i < n; i++) temperature[i] = tempColumn.values[i];
    params.push({
      name: 'TEMP', units: 'degree_Celsius', values: temperature, sensor: sensorName,
      standardName: 'sea_water_temperature',
      longName: 'Temperature of the water body by CTD or STD',
    });
  }

  // ── DEPTH, from pressure and latitude ──
  const depth = new Float64Array(n).fill(NaN);
  if (presColumn) {
    // TEOS-10's exact depth-from-pressure, which needs a latitude for the
    // gravity variation. Without one the equator is the documented fallback,
    // and it is worth about 0.5% at the pole.
    const fallback = Number.parseFloat(metadata.deploymentLatitude);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(pressure[i])) continue;
      const lat = Number.isFinite(latitude[i]) ? latitude[i] : fallback;
      depth[i] = depthFromPressure(pressure[i], Number.isFinite(lat) ? lat : 0);
    }
    notes.push('DEPTH is computed from pressure and latitude with TEOS-10, not assumed equal to it.');
  }

  // ── PSAL ──
  const salinity = new Float64Array(n).fill(NaN);
  if (condColumn && tempColumn && presColumn) {
    let usable = 0;
    for (let i = 0; i < n; i++) {
      const c = conductivity[i];
      const t = temperature[i];
      const p = pressure[i];
      if (!Number.isFinite(c) || !Number.isFinite(t) || !Number.isFinite(p) || c < 1) continue;
      const sp = spFromC(c, t, p);
      if (sp >= 2 && sp <= 42) { salinity[i] = sp; usable++; }
    }
    if (usable > 0) {
      params.push({
        name: 'PSAL', units: '1', values: salinity, sensor: sensorName,
        standardName: 'sea_water_practical_salinity',
        longName: 'Practical salinity of the water body by CTD and computation using UNESCO 1983 algorithm',
        derived: 'Computed from CNDC, TEMP and PRES with PSS-78. Not a recorded measurement.',
      });
      notes.push('PSAL is computed from the recorded conductivity, temperature and pressure.');
    }
  }

  // ── attitude and through-water velocity, where recorded ──
  const radiansToDegrees = (c: Column | undefined): Float64Array | null => {
    if (!c) return null;
    const out = new Float64Array(n).fill(NaN);
    const scale = /^rad$/i.test(c.unit) ? 180 / Math.PI : 1;
    for (let i = 0; i < n; i++) out[i] = c.values[i] * scale;
    return out;
  };

  const pitch = radiansToDegrees(column(table, ['m_pitch']));
  if (pitch) {
    params.push({ name: 'GLIDER_PITCH', units: 'degree', values: pitch, sensor: sensorName,
      longName: 'Pitch of the glider' });
  }
  const roll = radiansToDegrees(column(table, ['m_roll']));
  if (roll) {
    params.push({ name: 'GLIDER_ROLL', units: 'degree', values: roll, sensor: sensorName,
      longName: 'Roll of the glider' });
  }
  const altimeter = column(table, ['m_altimeter_status', 'm_altitude']);
  if (altimeter && altimeter.name.includes('altitude')) {
    params.push({ name: 'ALTITUDE', units: 'm', values: Float64Array.from(altimeter.values),
      sensor: sensorName, longName: 'Height of the glider above the seafloor' });
  }

  // ── PHASE and the numbering that follows it ──
  const behaviour = column(table, BEHAVIOUR);
  const { phase, segment, profile, direction, method } = derivePhase(time, pressure, behaviour);
  notes.push(`PHASE: ${method}`);

  // ── the document ──
  const startDate = stampCompact(time[0]);
  const id = `${metadata.platformSerial}_${startDate}_${metadata.dataMode}`;

  const variables: NcVariable[] = [];
  const coordinates = 'TIME LONGITUDE LATITUDE DEPTH';

  const withQc = (variable: NcVariable) => {
    variables.push(variable);
    variables.push({
      name: `${variable.name}_QC`,
      type: 'byte',
      dimensions: ['N_MEASUREMENTS'],
      attributes: QC_ATTRS(),
      data: new Int8Array(n), // all zero: no QC has been applied
    });
  };

  withQc({
    name: 'TIME', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Time elapsed since 1970-01-01T00:00:00Z'),
      text('standard_name', 'time'),
      text('units', 'seconds since 1970-01-01T00:00:00Z'),
      text('calendar', 'gregorian'),
      real('_FillValue', -1),
      real('valid_min', 1e9),
      real('valid_max', 4e9),
      text('axis', 'T'),
      text('ancillary_variables', 'TIME_QC'),
      text('vocabulary', `${VOCAB.parameter}TIME/`),
    ],
    data: time,
  });

  withQc({
    name: 'LATITUDE', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Latitude north (WGS84)'),
      text('standard_name', 'latitude'),
      text('units', 'degrees_north'),
      real('_FillValue', -9999.9),
      real('valid_min', -90),
      real('valid_max', 90),
      text('axis', 'Y'),
      text('ancillary_variables', 'LATITUDE_QC'),
      text('interpolation_methodology',
        'Linear in time between the glider’s own dead-reckoned fixes'),
      text('vocabulary', `${VOCAB.parameter}LAT/`),
    ],
    data: latitude,
  });

  withQc({
    name: 'LONGITUDE', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'longitude of each measurement and GPS location'),
      text('standard_name', 'longitude'),
      text('units', 'degrees_east'),
      real('_FillValue', -9999.9),
      real('valid_min', -180),
      real('valid_max', 180),
      text('axis', 'X'),
      text('ancillary_variables', 'LONGITUDE_QC'),
      text('interpolation_methodology',
        'Linear in time between the glider’s own dead-reckoned fixes'),
      text('vocabulary', `${VOCAB.parameter}LON/`),
    ],
    data: longitude,
  });

  withQc({
    name: 'DEPTH', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Depth below sea surface'),
      text('standard_name', 'depth'),
      text('units', 'm'),
      text('positive', 'down'),
      real('_FillValue', -9999.9),
      real('valid_min', -10),
      real('valid_max', 12000),
      text('axis', 'Z'),
      text('ancillary_variables', 'DEPTH_QC'),
      text('comment', 'Computed from PRES and LATITUDE using TEOS-10 (gsw_z_from_p).'),
      text('vocabulary', `${VOCAB.parameter}DEPTH/`),
    ],
    data: depth,
  });

  // The GPS fixes as recorded: TIME_GPS carries a time only where there is a
  // fix, which is what distinguishes it from TIME.
  const gpsTime = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (Number.isFinite(gpsLat[i])) gpsTime[i] = time[i];

  withQc({
    name: 'TIME_GPS', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'time of each GPS location'),
      text('units', 'seconds since 1970-01-01T00:00:00Z'),
      text('calendar', 'gregorian'),
      real('_FillValue', -1),
      real('valid_min', 1e9),
      real('valid_max', 4e9),
      text('ancillary_variables', 'TIME_GPS_QC'),
    ],
    data: gpsTime,
  });
  withQc({
    name: 'LATITUDE_GPS', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'latitude of each GPS location'),
      text('standard_name', 'latitude'),
      text('units', 'degrees_north'),
      real('_FillValue', -9999.9),
      real('valid_min', -90), real('valid_max', 90),
      text('ancillary_variables', 'LATITUDE_GPS_QC'),
    ],
    data: gpsLat,
  });
  withQc({
    name: 'LONGITUDE_GPS', type: 'double', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'longitude of each GPS location'),
      text('standard_name', 'longitude'),
      text('units', 'degrees_east'),
      real('_FillValue', -9999.9),
      real('valid_min', -180), real('valid_max', 180),
      text('ancillary_variables', 'LONGITUDE_GPS_QC'),
    ],
    data: gpsLon,
  });

  // ── PHASE and numbering ──
  withQc({
    name: 'PHASE', type: 'byte', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'behavior of the glider at sea'),
      text('phase_vocabulary', VOCAB.phase),
      text('phase_calculation_method', method),
      { name: '_FillValue', type: 'byte', value: [0] },
      text('ancillary_variables', 'PHASE_QC'),
    ],
    data: phase,
  });
  variables.push({
    name: 'SEGMENT_NUMBER', type: 'int', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Identifier of numbered segment within the dataset'),
      text('segment_number_calculation_method',
        'SEGMENT_NUMBER is 1 at the start of a deployment and increments by 1 each time ' +
        'the glider enters the surface phase (PHASE=3)'),
      { name: '_FillValue', type: 'int', value: [-9999] },
    ],
    data: segment,
  });
  variables.push({
    name: 'PROFILE_NUMBER', type: 'int', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Identifier of numbered profile within the dataset'),
      text('profile_number_calculation_method',
        'PROFILE_NUMBER increments by one each time the glider starts an ascending or ' +
        'descending profile, and is fill elsewhere'),
      { name: '_FillValue', type: 'int', value: [-9999] },
    ],
    data: profile,
  });
  variables.push({
    name: 'PROFILE_DIRECTION', type: 'byte', dimensions: ['N_MEASUREMENTS'],
    attributes: [
      text('long_name', 'Vertical direction of profile'),
      text('profile_direction_calculation_method',
        'PROFILE_DIRECTION is 1 when the glider is descending, -1 when ascending, 0 otherwise'),
      { name: '_FillValue', type: 'byte', value: [0] },
    ],
    data: direction,
  });

  // ── the geophysical parameters ──
  for (const param of params) {
    const attributes: NcAttribute[] = [
      text('long_name', param.longName),
      text('units', param.units),
      text('vocabulary', `${VOCAB.parameter}${param.name}/`),
      { name: '_FillValue', type: 'float', value: [NaN] },
      text('coordinates', coordinates),
      text('sensor', sensorName),
      text('ancillary_variables', `${param.name}_QC`),
    ];
    if (param.standardName) attributes.splice(1, 0, text('standard_name', param.standardName));
    if (param.derived) attributes.push(text('comment', param.derived));
    withQc({
      name: param.name, type: 'float', dimensions: ['N_MEASUREMENTS'],
      attributes, data: param.values,
    });
  }

  // ── the sensor variable the parameters point at ──
  variables.push({
    name: sensorName, type: 'byte', dimensions: [],
    attributes: [
      text('long_name', metadata.ctdModel || 'CTD'),
      text('sensor_type', metadata.ctdSensorType || 'CTD'),
      text('sensor_type_vocabulary', VOCAB.sensorType),
      text('sensor_model', metadata.ctdModel || ''),
      text('sensor_serial_number', metadata.ctdSerial || ''),
    ],
    data: [0],
  });

  // ── the scalar metadata variables ──
  // OG1 declares these as NC_STRING, which classic does not have; a char
  // array of the exact length is the classic equivalent.
  const scalarText = (name: string, value: string, attributes: NcAttribute[]): NcVariable => {
    const padded = value || ' ';
    return {
      name, type: 'char', dimensions: [`STRING${padded.length}`], attributes, data: padded,
      // What OG1 actually declares. The char array above is what classic can
      // encode; `cdl.ts` emits this, and `ncgen -4` then makes the real thing.
      strings: [padded],
    };
  };

  const strings: { name: string; value: string; attributes: NcAttribute[] }[] = [
    { name: 'TRAJECTORY', value: id, attributes: [
      text('cf_role', 'trajectory_id'), text('long_name', 'trajectory name')] },
    { name: 'PLATFORM_TYPE', value: metadata.platformType, attributes: [
      text('long_name', 'type of glider'), text('platform_type_vocabulary', VOCAB.platform)] },
    { name: 'PLATFORM_MODEL', value: metadata.platformModel, attributes: [
      text('long_name', 'model of the glider'), text('platform_model_vocabulary', VOCAB.platform)] },
    { name: 'PLATFORM_SERIAL_NUMBER', value: metadata.platformSerial, attributes: [
      text('long_name', 'glider serial number')] },
    { name: 'WMO_IDENTIFIER', value: metadata.wmoIdentifier, attributes: [
      text('long_name', 'wmo id')] },
  ];

  const stringDims = new Map<string, number>();
  for (const s of strings) {
    const length = (s.value || ' ').length;
    stringDims.set(`STRING${length}`, length);
    variables.push(scalarText(s.name, s.value, s.attributes));
  }

  const deploymentAt = parseWhen(metadata.deploymentTime);
  variables.push({
    name: 'DEPLOYMENT_TIME', type: 'double', dimensions: [],
    attributes: [
      text('long_name', 'Date of deployment'),
      text('standard_name', 'time'),
      text('units', 'seconds since 1970-01-01T00:00:00Z'),
      text('calendar', 'gregorian'),
      text('axis', 'T'),
    ],
    data: [Number.isFinite(deploymentAt) ? deploymentAt : NaN],
  });
  variables.push({
    name: 'DEPLOYMENT_LATITUDE', type: 'double', dimensions: [],
    attributes: [text('long_name', 'latitude of deployment'), text('units', 'degrees_north')],
    data: [Number.parseFloat(metadata.deploymentLatitude)],
  });
  variables.push({
    name: 'DEPLOYMENT_LONGITUDE', type: 'double', dimensions: [],
    attributes: [text('long_name', 'longitude of deployment'), text('units', 'degrees_east')],
    data: [Number.parseFloat(metadata.deploymentLongitude)],
  });

  // ── PARAMETER / PARAMETER_SENSOR / PARAMETER_UNITS ──
  const names = packStrings(params.map((p) => p.name));
  const sensors = packStrings(params.map((p) => p.sensor));
  const units = packStrings(params.map((p) => p.units));
  variables.push(
    { name: 'PARAMETER', type: 'char', dimensions: ['N_PARAM', `STRING${names.width}`],
      attributes: [text('long_name', 'list of parameters in the file')], data: names.data,
      strings: params.map((p) => p.name) },
    { name: 'PARAMETER_SENSOR', type: 'char',
      dimensions: ['N_PARAM', `STRING${sensors.width}`],
      attributes: [text('long_name', 'sensor that measured each parameter')], data: sensors.data,
      strings: params.map((p) => p.sensor) },
    { name: 'PARAMETER_UNITS', type: 'char', dimensions: ['N_PARAM', `STRING${units.width}`],
      attributes: [text('long_name', 'units of each parameter')], data: units.data,
      strings: params.map((p) => p.units) },
  );
  stringDims.set(`STRING${names.width}`, names.width);
  stringDims.set(`STRING${sensors.width}`, sensors.width);
  stringDims.set(`STRING${units.width}`, units.width);

  // ── global attributes ──
  const finite = (values: Float64Array) => [...values].filter(Number.isFinite);
  const lats = finite(latitude);
  const lons = finite(longitude);
  const depths = finite(depth);
  const created = stampCompact(Date.now() / 1000);

  const globals: NcAttribute[] = [
    text('title', metadata.title),
    text('platform', metadata.platform),
    text('platform_vocabulary', metadata.platformVocabulary),
    text('id', id),
    text('featureType', 'trajectory'),
    text('Conventions', 'CF-1.10, ACDD-1.3, OG-1.0'),
    text('start_date', Number.isFinite(deploymentAt) ? stampCompact(deploymentAt) : startDate),
    text('date_created', created),
    text('rtqc_method', metadata.rtqcMethod),
    text('time_coverage_start', startDate),
    text('time_coverage_end', stampCompact(time[n - 1])),
    text('contributor_name', metadata.contributorName),
    text('contributor_email', metadata.contributorEmail),
    text('contributor_role', metadata.contributorRole),
    text('contributor_role_vocabulary', metadata.contributorRoleVocabulary),
    text('contributing_institutions', metadata.contributingInstitutions),
    text('contributing_institutions_role', metadata.contributingInstitutionsRole),
    text('contributing_institutions_role_vocabulary',
      metadata.contributingInstitutionsRoleVocabulary),
    text('standard_name_vocabulary', VOCAB.standardName),
    text('source', 'Slocum glider binary data'),
    text('processing_level',
      'Decoded from the glider’s binary files. No quality control has been applied.'),
    text('history',
      `${created}: decoded from Slocum binary and written as OG1.0 by the C4PO Slocum ` +
      'decoder (https://oceansensing.org/data/slocum/), in the browser'),
    text('format_note',
      'OG1.0 structure encoded as netCDF-3 classic: NC_STRING is unavailable in classic, ' +
      'so string variables are fixed-width char arrays. The accompanying CDL export ' +
      'produces a netCDF-4 file via `ncgen -4`.'),
  ];

  const optional: [string, string][] = [
    ['naming_authority', metadata.namingAuthority],
    ['institution', metadata.institution],
    ['internal_mission_identifier', metadata.internalMissionIdentifier],
    ['contributor_id', metadata.contributorId],
    ['contributing_institutions_vocabulary', metadata.contributingInstitutionsVocabulary],
    ['site', metadata.site],
    ['site_vocabulary', metadata.siteVocabulary],
    ['program', metadata.program],
    ['program_vocabulary', metadata.programVocabulary],
    ['project', metadata.project],
    ['network', metadata.network],
    ['data_url', metadata.dataUrl],
    ['doi', metadata.doi],
    ['rtqc_method_doi', metadata.rtqcMethodDoi],
    ['web_link', metadata.webLink],
    ['comment', metadata.comment],
  ];
  for (const [name, value] of optional) if (value?.trim()) globals.push(text(name, value.trim()));

  if (lats.length) {
    globals.push(
      real('geospatial_lat_min', Math.min(...lats)),
      real('geospatial_lat_max', Math.max(...lats)),
    );
  }
  if (lons.length) {
    globals.push(
      real('geospatial_lon_min', Math.min(...lons)),
      real('geospatial_lon_max', Math.max(...lons)),
    );
  }
  if (depths.length) {
    globals.push(
      real('geospatial_vertical_min', Math.min(...depths)),
      real('geospatial_vertical_max', Math.max(...depths)),
      text('geospatial_vertical_positive', 'down'),
      text('geospatial_vertical_units', 'm'),
    );
  }

  const dimensions = [
    { name: 'N_MEASUREMENTS', length: n },
    { name: 'N_PARAM', length: params.length },
    ...[...stringDims].sort((a, b) => a[1] - b[1]).map(([name, length]) => ({ name, length })),
  ];

  return { document: { dimensions, attributes: globals, variables }, id, notes };
}

/**
 * `SENSOR_<type>_<serial>`, upper-cased with everything but letters and digits
 * turned into underscores — the naming rule OG1 states, so that a sensor
 * serial containing a hyphen still yields a legal CF variable name.
 */
export function sensorVariableName(metadata: Og1Metadata): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const type = clean(metadata.ctdSensorType || 'CTD');
  const serial = clean(metadata.ctdSerial || 'UNKNOWN');
  return `SENSOR_${type}_${serial}`;
}

/** `<id>.nc`, the OG1 file naming convention. */
export function og1FileName(id: string, extension = 'nc'): string {
  return `${id}.${extension}`;
}
