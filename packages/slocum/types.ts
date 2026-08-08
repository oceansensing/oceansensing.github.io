/**
 * The shapes a Slocum file decodes into.
 *
 * A sensor's **cycle position** — its index in the 2-bit state-byte encoding
 * of one cycle — is implicit in its position in `sensors`. It is deliberately
 * not a field on `Sensor`: the state bytes index into that array by position,
 * so an explicit index is a second copy of the same fact and the two can
 * disagree. `SlocumIO.jl` makes the same choice for the same reason.
 */

/** One sensor written in each cycle. */
export interface Sensor {
  /** e.g. `m_present_time`, `sci_water_temp`. */
  name: string;
  /** As the cache file spells it — `m`, `rad`, `degc`, `nodim`, `enum`. */
  unit: string;
  /** 1, 2, 4 or 8. Decides how the value is read out of the chunk. */
  bytes: number;
}

/** The ASCII header at the top of every file in the family. */
export interface FileHeader {
  dbdLabel: string;
  encodingVer: number;
  numAsciiTags: number;
  allSensors: string;
  the8x3Filename: string;
  fullFilename: string;
  filenameExtension: string;
  missionName: string;
  /** C `asctime`, underscore-separated: `Wed_May__7_22:16:18_2025`. */
  fileopenTime: string;
  /** Every sensor the glider knows about, active in this file or not. */
  totalNumSensors: number;
  /** How many of them are written each cycle. */
  sensorsPerCycle: number;
  stateBytesPerCycle: number;
  /** 8 hex characters naming the `.cac` file this needs. */
  sensorListCrc: string;
  /** 0 = the sensor list is in this file; 1 = it is in `<crc>.cac`. */
  sensorListFactored: number;
  /** Everything as it appeared, including keys not modelled above. */
  raw: Record<string, string>;
}

/** A file opened far enough to read values out of. */
export interface DbdFile {
  /** What it was called, for messages and for the netCDF global attributes. */
  name: string;
  header: FileHeader;
  /** Indexed by cycle position. */
  sensors: Sensor[];
  /** Sensor name → cycle position. */
  position: Map<string, number>;
  /** Every name in the glider's namespace, active this file or not. */
  allSensorNames: string[];
  /** Where the binary section starts — after the ASCII, past the preamble. */
  dataOffset: number;
  /** Decided by the preamble's 0x1234 marker, not assumed. */
  littleEndian: boolean;
  /** `m_present_time` or `sci_m_present_time`, whichever this file has. */
  timeName: string;
  timePosition: number;
  /** The decoded bytes — already decompressed if the file was. */
  bytes: Uint8Array;
  /**
   * Which vehicle this came off, from the header's own `full_filename`.
   * Two gliders' `m_depth` are different records and must not merge.
   */
  glider: string;
}

/**
 * One sensor's values, on its own time base.
 *
 * Each sensor is written on its own subset of cycles, so there is no single
 * time base for a file and this is not a column of a table yet. `table.ts`
 * is what turns a set of these into something rectangular.
 */
export interface Series {
  name: string;
  unit: string;
  /** Epoch seconds, UTC. */
  time: Float64Array;
  value: Float64Array;
  /**
   * The file it came out of.
   *
   * Load-bearing when several files are decoded together, because a sensor
   * name is not unique across them: `sci_water_pressure` is written by the
   * science computer at full rate *and* relayed to the flight computer,
   * which logs it a handful of times a segment. Two columns, same name, three
   * orders of magnitude apart in how much they say. Without a source there is
   * nothing to tell them apart by but position.
   */
  from?: string;
  /**
   * Which glider it came off — the vehicle, not the computer inside it.
   *
   * The grouping key is (sensor, glider, computer). Leave the glider out and
   * a fleet directory silently merges `m_depth` from two vehicles into one
   * column, interleaved and looking exactly like data.
   */
  glider?: string;
}

/** The 2-bit state of one sensor in one cycle. */
export const NOTSET = 0;
export const SAME = 1;
export const UPDATED = 2;

/**
 * Thrown when a file says its sensor list lives in a cache file we were not
 * given. Carries the CRC so the caller can say *which* file to go and find —
 * this is far and away the commonest way decoding fails, and "missing cache"
 * without the name is not an actionable message.
 */
export class MissingCacheError extends Error {
  readonly crc: string;
  readonly file: string;
  constructor(crc: string, file: string) {
    super(`${file} needs the sensor-list cache ${crc}.cac`);
    this.name = 'MissingCacheError';
    this.crc = crc;
    this.file = file;
  }
}

/**
 * Which glider a file came off.
 *
 * Slocum names a segment `<glider>-YYYY-DDD-M-S.ext` — the vehicle, the year,
 * the day of year, the mission and the segment — so the glider is everything
 * before that trailing run of numbers. `electa-2025-120-1-169` is `electa`.
 *
 * **Read from the header's `full_filename`, not from the name on disk.** The
 * two usually agree and the header is the one the glider wrote; a file the
 * reader renamed, or one still under its 8.3 name (`02150008.sbd`), would
 * otherwise be its own vehicle.
 *
 * The glider is the vehicle. Flight and science are the two computers *in*
 * it — see `familyOf` — so telling two records apart needs both: `m_depth`
 * off one glider is not `m_depth` off another, and neither is the flight
 * computer's copy of a science sensor.
 */
export function gliderOf(fullFilename: string): string {
  const stem = (fullFilename.split('/').pop() ?? '').replace(/\.[^.]*$/, '');
  const match = /^(.*?)-\d+-\d+-\d+-\d+$/.exec(stem);
  return (match ? match[1] : stem).toLowerCase();
}

/**
 * Which computer inside the glider wrote a file, from its name alone.
 *
 * The flight computer writes `sbd`/`mbd`/`dbd` and the science computer
 * `tbd`/`nbd`/`ebd`, in ascending order of how much they hold — the short
 * ones are the decimated subsets sent over Iridium mid-deployment, the long
 * ones are what is recovered from the glider afterwards. `c` in the middle
 * means the same file compressed.
 *
 * **The three within a family are one record, not three.** A `.tbd` is a
 * decimation of the same samples the `.ebd` holds, off the same sensors on
 * the same clock, so dropping both after a recovery must not produce two
 * columns per sensor. Only *across* families are two same-named sensors
 * genuinely different records — `sci_water_pressure` is measured by the
 * science computer and relayed to the flight computer at a much slower rate.
 */
export function familyOf(name: string): 'flight' | 'science' | 'cache' | 'unknown' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (/^[smd](b|c)d$/.test(ext)) return 'flight';
  if (/^[tne](b|c)d$/.test(ext)) return 'science';
  if (ext === 'cac' || ext === 'ccc') return 'cache';
  return 'unknown';
}

/**
 * Which computer a sensor *belongs* to, from its name.
 *
 * Slocum prefixes say what a sensor is. `sci_` is measured by the science
 * computer; `m_` is measured by the flight computer and `c_` is commanded on
 * it; `u_` are parameters the user sets and `f_` are factory values, with
 * `x_`, `s_` and `xs_` the remaining derived channels.
 *
 * Measured on this glider's two namespaces: the science computer's 105
 * sensors are **100% `sci_`**, and the flight computer's 2,709 include 1,022
 * `sci_` ones — which it knows about only because science values can be
 * relayed to it. So a `sci_` sensor found in a flight file is a relay of a
 * measurement made elsewhere, and that is worth knowing without counting
 * samples: the prefix says it outright, where sample counts only imply it.
 *
 * `m_leakdetect_voltage_science` is the trap to keep in mind here. It is an
 * `m_` sensor — measured by the *flight* computer — that happens to describe
 * the science bay. The prefix is the signal; a word inside the name is not.
 */
export function homeOf(sensor: string): 'flight' | 'science' {
  return sensor.startsWith('sci_') ? 'science' : 'flight';
}

/**
 * How much of the record a file holds, most complete first.
 *
 * Used only to settle a disagreement: where a sample appears in two files of
 * one family with different values — which should not happen, since they are
 * decimations of the same measurements — the fuller file wins.
 */
export function resolutionOf(name: string): number {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (/^[de](b|c)d$/.test(ext)) return 0; // dbd, ebd — the whole record
  if (/^[mn](b|c)d$/.test(ext)) return 1; // mbd, nbd — medium
  if (/^[st](b|c)d$/.test(ext)) return 2; // sbd, tbd — the Iridium subset
  return 3;
}
