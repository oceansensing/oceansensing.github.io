/**
 * A decoder for the Slocum glider file family, in the browser.
 *
 * Teledyne Webb's gliders log to a binary format — `sbd`, `tbd`, `mbd`,
 * `nbd`, `dbd`, `ebd` and their LZ4-compressed twins — and reading it has
 * meant the vendor's `dbd2asc`, a Python extension, or a Julia package. This
 * is the same job with nothing to install, and the files never leave the
 * machine they are on.
 *
 * It is a port of [`SlocumIO.jl`](https://github.com/oceansensing/SlocumIO.jl),
 * which was itself validated against `dbdreader` byte for byte, and
 * `npm run test:slocum` holds this port to the same fixture.
 *
 * # No DOM, no Leaflet, no dependencies
 *
 * Every module here takes bytes and returns numbers, so `test:slocum` runs it
 * with no build and no jsdom, and a native port of this decoder — the obvious
 * next thing, since the same files are read on a ship with no network — keeps
 * all of it. The one dependency is `@c4po/teos10`, used only by the optional
 * derived columns.
 *
 * # The shape of the job
 *
 * ```ts
 * const file = openDbd(bytes, { name, cache });   // needs <crc>.cac
 * const series = readSeries(file);                // per-sensor, own time bases
 * const table = buildTable(series);               // rectangular, lossless
 * const csv = toCsv(table);
 * ```
 *
 * The step that deserves attention is the third. A Slocum file has no single
 * time base — every sensor is written on its own subset of cycles — so making
 * one is a choice, and `table.ts` makes the lossless one unless asked
 * otherwise.
 */

export { openDbd, describe, readSeries } from './dbd.ts';
export type { OpenOptions, ReadOptions } from './dbd.ts';

export { readHeader, parseSensorList, parseFileopenTime } from './header.ts';
export type { HeaderResult, SensorList } from './header.ts';

export { decompressBlock, decompressStream, isCompressedName, MAX_BLOCK_BYTES } from './lz4.ts';

export {
  isLatLonSensor,
  isLatitudeSensor,
  isValidNmea,
  nmeaToDecimal,
  LATLON_SENSORS,
} from './nmea.ts';

export {
  buildTable,
  interpolateOnto,
  interpolateAngleOnto,
  isAngular,
  orderColumns,
} from './table.ts';
export type { BuildOptions, Column, Join, Table } from './table.ts';

export { toCsv, isoTime, exportName } from './csv.ts';
export type { CsvOptions } from './csv.ts';

export { toNetcdf, TYPES } from './netcdf.ts';
export type { NetcdfOptions } from './netcdf.ts';

export { deriveSeawater } from './derive.ts';
export {
  buildOg1,
  derivePhase,
  missingFields,
  og1FileName,
  parseWhen,
  sensorVariableName,
  stampCompact,
  OG1_DEFAULTS,
  OG1_FIELDS,
} from './og1.ts';
export type { Og1Field, Og1Metadata, Og1Result, PhaseResult } from './og1.ts';

export {
  splitDeployments,
  spanOf,
  deploymentLabel,
  deploymentStem,
  DEFAULT_GAP_SECONDS,
} from './deployment.ts';
export type { Deployment, Segment, SplitOptions } from './deployment.ts';

export { toCdl, quote as cdlQuote } from './cdl.ts';
export type { CdlOptions } from './cdl.ts';

export { writeNetcdf, packStrings, safeNames } from './netcdf.ts';
export type { NcAttribute, NcDimension, NcDocument, NcType, NcVariable } from './netcdf.ts';
export type { DeriveOptions, DeriveResult } from './derive.ts';

export {
  familyOf,
  gliderOf,
  homeOf,
  resolutionOf,
  MissingCacheError,
  NOTSET,
  SAME,
  UPDATED,
} from './types.ts';
export type { DbdFile, FileHeader, Sensor, Series } from './types.ts';

/**
 * Sort file names the way a deployment runs.
 *
 * Slocum names a segment `glider-YYYY-DDD-M-S.ext` — year, day of year,
 * mission, segment — and the fields are compared **separately** rather than
 * packed into one number. Packing gives each field a fixed width, and a
 * deployment that runs past segment 999 then overflows into the mission
 * field and sorts out of order. `SlocumIO.jl` has the same note; multi-week
 * deployments reach four-digit segments routinely.
 */
export function sortFileNames<T extends string>(names: readonly T[]): T[] {
  const parts = (name: string) => {
    const match = /-(\d+)-(\d+)-(\d+)-(\d+)\.[a-zA-Z]{3}$/.exec(name);
    if (!match) return { stem: name.toLowerCase(), keys: [0, 0, 0, 0] };
    return {
      stem: name.slice(0, match.index).toLowerCase(),
      keys: match.slice(1, 5).map(Number),
    };
  };
  return [...names].sort((a, b) => {
    const pa = parts(a);
    const pb = parts(b);
    if (pa.stem !== pb.stem) return pa.stem < pb.stem ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      if (pa.keys[i] !== pb.keys[i]) return pa.keys[i] - pb.keys[i];
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
