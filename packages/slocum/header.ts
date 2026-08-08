/**
 * The ASCII half of a Slocum file: the header, and the sensor list that says
 * what each cycle of the binary half contains.
 *
 * Both parsers work on bytes rather than a decoded string. A Slocum file is
 * ASCII down to a byte boundary and then abruptly binary, so decoding the
 * whole thing as text first would mangle the half that matters — and
 * `TextDecoder` on a 40 MB `.dbd` to read 400 bytes of header is work for
 * nothing.
 */

import type { FileHeader, Sensor } from './types.ts';

/** Lines are LF-terminated. Verified against real files; no CR anywhere. */
const LF = 10;

const ASCII = new TextDecoder('ascii');

/**
 * A ceiling on how far to look for `num_ascii_tags`.
 *
 * The tag count is itself a header line, so the header cannot be read without
 * first reading part of it. Rather than trust an unbounded scan on a file
 * that may not be a Slocum file at all, stop well past the 14 tags every
 * observed version writes.
 */
const MAX_HEADER_LINES = 64;

function readLine(bytes: Uint8Array, at: number): { text: string; next: number } {
  const end = bytes.indexOf(LF, at);
  if (end < 0) throw new Error('Slocum header: file ends mid-line');
  return { text: ASCII.decode(bytes.subarray(at, end)), next: end + 1 };
}

function splitTag(line: string): [string, string] {
  const colon = line.indexOf(':');
  if (colon < 0) throw new Error(`Slocum header: line has no colon: ${JSON.stringify(line)}`);
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}

const int = (raw: Record<string, string>, key: string, fallback = 0): number => {
  const v = raw[key];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

export interface HeaderResult {
  header: FileHeader;
  /**
   * Where the ASCII ends. For a factored file that is the start of the binary
   * preamble; for an unfactored one the inline sensor list has already been
   * consumed, so it is the same thing either way.
   */
  asciiEnd: number;
  /** The inline sensor list, or `''` when the file is factored. */
  inlineSensorList: string;
}

/**
 * Read the ASCII header, and the inline sensor list if the file carries one.
 *
 * Files off a glider are almost always **factored** — `sensor_list_factored:
 * 1` — meaning the sensor list is not in the file and decoding is impossible
 * without the matching `<crc>.cac`. That is not an error here: this function
 * reports the CRC and lets the caller go and find it.
 */
export function readHeader(bytes: Uint8Array): HeaderResult {
  const raw: Record<string, string> = {};

  // The first line is where a file that is not a Slocum file at all gets
  // turned away, so every way of failing it says the same thing. A reader who
  // has dragged in the wrong file needs to be told that; "line has no colon"
  // is true, and is about the wrong subject.
  let at = 0;
  let firstKey = '';
  let firstValue = '';
  try {
    const first = readLine(bytes, at);
    at = first.next;
    [firstKey, firstValue] = splitTag(first.text);
  } catch {
    throw new Error('Not a Slocum file: it does not begin with a dbd_label line');
  }
  if (firstKey !== 'dbd_label') {
    throw new Error(
      `Not a Slocum file: expected a dbd_label line, got ${JSON.stringify(firstKey)}`,
    );
  }
  raw[firstKey] = firstValue;

  let lines = 1;
  while (lines < MAX_HEADER_LINES) {
    const line = readLine(bytes, at);
    at = line.next;
    const [key, value] = splitTag(line.text);
    raw[key] = value;
    lines += 1;
    if (raw.num_ascii_tags !== undefined && lines >= int(raw, 'num_ascii_tags')) break;
  }
  if (raw.num_ascii_tags === undefined) {
    throw new Error('Slocum header: num_ascii_tags never appeared');
  }

  const header: FileHeader = {
    dbdLabel: raw.dbd_label ?? '',
    encodingVer: int(raw, 'encoding_ver'),
    numAsciiTags: int(raw, 'num_ascii_tags'),
    allSensors: raw.all_sensors ?? '',
    the8x3Filename: raw.the8x3_filename ?? '',
    fullFilename: raw.full_filename ?? '',
    filenameExtension: raw.filename_extension ?? '',
    missionName: raw.mission_name ?? '',
    fileopenTime: raw.fileopen_time ?? '',
    totalNumSensors: int(raw, 'total_num_sensors'),
    sensorsPerCycle: int(raw, 'sensors_per_cycle'),
    stateBytesPerCycle: int(raw, 'state_bytes_per_cycle'),
    sensorListCrc: raw.sensor_list_crc ?? '',
    sensorListFactored: int(raw, 'sensor_list_factored'),
    raw,
  };

  let inlineSensorList = '';
  if (header.sensorListFactored === 0) {
    const start = at;
    for (let i = 0; i < header.totalNumSensors; i++) at = readLine(bytes, at).next;
    inlineSensorList = ASCII.decode(bytes.subarray(start, at));
  }

  return { header, asciiEnd: at, inlineSensorList };
}

export interface SensorList {
  /** Indexed by cycle position — what the state bytes address. */
  sensors: Sensor[];
  /** Every name the glider knows, in namespace order, active or not. */
  all: string[];
}

/**
 * Parse a cache file, or the equivalent inline list.
 *
 * One line per sensor in the glider's whole namespace — typically a few
 * thousand — of which only those with a cycle position other than `-1` are
 * written in this file:
 *
 * ```
 * s: F    0   -1 1 cc_behavior_state enum      inactive
 * s: T   64    0 4 c_ballast_pumped  cc        cycle position 0
 * ```
 *
 * The columns are: the `s:` marker, an availability flag, the index in the
 * namespace, the **cycle position**, the byte size, the name, and the unit.
 * The unit may be absent.
 *
 * The cycle positions are required to be contiguous from zero, because the
 * binary decoder walks them as an array. A gap would mean every sensor after
 * it was read at the wrong offset — plausible values, wrong sensor — so it is
 * refused rather than filled.
 */
export function parseSensorList(text: string, totalNumSensors: number): SensorList {
  const lines = text.split('\n');
  const all: string[] = new Array(totalNumSensors);
  const byPosition = new Map<number, Sensor>();

  let seen = 0;
  for (const line of lines) {
    if (seen >= totalNumSensors) break;
    const words = line.trim().split(/\s+/);
    if (words.length < 6 || words[0][0] !== 's') {
      // Blank lines and anything else are skipped; a cache file that is
      // genuinely short is caught by the count check below, which says how
      // short rather than which line looked wrong.
      continue;
    }

    const position = Number.parseInt(words[3], 10);
    const bytes = Number.parseInt(words[4], 10);
    const name = words[5];
    const unit = words.length >= 7 ? words[6] : '';
    all[seen] = name;
    seen += 1;

    if (position === -1) continue;
    if (byPosition.has(position)) {
      throw new Error(`Slocum sensor list: two sensors claim cycle position ${position}`);
    }
    byPosition.set(position, { name, unit, bytes });
  }

  if (seen < totalNumSensors) {
    throw new Error(
      `Slocum sensor list: ${seen} sensors, expected ${totalNumSensors} — wrong cache file?`,
    );
  }

  const sensors: Sensor[] = [];
  for (let i = 0; i < byPosition.size; i++) {
    const sensor = byPosition.get(i);
    if (!sensor) {
      throw new Error(
        `Slocum sensor list: no sensor at cycle position ${i} of ${byPosition.size}`,
      );
    }
    sensors.push(sensor);
  }

  return { sensors, all };
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * `Wed_May__7_22:16:18_2025` → epoch seconds, or `NaN`.
 *
 * The field is C `asctime` with spaces mapped to underscores, and `asctime`
 * **space-pads a single-digit day** — so the 7th of a month arrives with a
 * doubled separator and an empty field where the 17th has neither. Dropping
 * empty parts collapses both spellings to the same five fields; without that,
 * days 1–9 parse differently from the rest of the month. `SlocumIO.jl` has
 * the same note, and the fixture is one of the affected days.
 *
 * Parsed by hand rather than with `Date.parse`, which is free to interpret an
 * unrecognised string however it likes and would read this as local time.
 */
export function parseFileopenTime(text: string): number {
  const parts = text.split('_').filter(Boolean);
  if (parts.length < 5) return NaN;
  const month = MONTHS[parts[1]];
  if (month === undefined) return NaN;
  const day = Number.parseInt(parts[2], 10);
  const year = Number.parseInt(parts[4], 10);
  const hms = parts[3].split(':').map((n) => Number.parseInt(n, 10));
  if (hms.length !== 3 || hms.some(Number.isNaN) || Number.isNaN(day) || Number.isNaN(year)) {
    return NaN;
  }
  return Date.UTC(year, month, day, hms[0], hms[1], hms[2]) / 1000;
}
