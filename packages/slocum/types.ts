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
   * name is not unique across the pair: `sci_water_pressure` is written by
   * the science computer at full rate *and* relayed to the flight computer,
   * which logs it a handful of times a segment. Two columns, same name, three
   * orders of magnitude apart in how much they say. Without a source there is
   * nothing to tell them apart by but position.
   */
  from?: string;
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
