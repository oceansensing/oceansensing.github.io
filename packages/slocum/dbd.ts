/**
 * The binary half of a Slocum file.
 *
 * Ported from `SlocumIO.jl`'s `reader.jl`, which was itself validated against
 * `dbdreader` byte for byte. `scripts/test-slocum.mjs` holds this port to the
 * same standard, against a fixture recorded from dbdreader.
 *
 * # What a file looks like after the ASCII
 *
 * A 17-byte preamble, once, whose whole job is to declare the byte order:
 *
 * ```
 * 0      's'                          start tag
 * 1      int8                         diagnostic, arbitrary
 * 2-3    uint16  0x1234               the byte-order marker
 * 4-7    float32 123.456              and a check that it was believed
 * 8-15   float64 123456789.12345      and another
 * 16     'd'                          end tag
 * ```
 *
 * Then a cycle at a time, to the end of the file:
 *
 * ```
 * state_bytes_per_cycle bytes         2 bits per sensor, MSB first
 * chunk                               the UPDATED sensors' values, in cycle order
 * 1 byte                              separator
 * ```
 *
 * # Two details that are easy to get wrong, and silent when you do
 *
 * **The separator separates rather than terminates.** The final cycle has
 * none, so a well-formed file ends with `chunk_end === length`. A reader that
 * requires the separator drops the last complete cycle of every file it
 * reads — a whole cycle of data, no error, nothing on screen to say so.
 *
 * **The state buffer has to be cleared each cycle.** Only `4 ×
 * state_bytes_per_cycle` entries get written, and that can be fewer than
 * there are sensors when the header and the cache disagree. Left dirty, a
 * sensor beyond the written range keeps the *previous* cycle's state, and the
 * chunk offsets after it are then all wrong: plausible numbers, wrong sensor.
 */

import { decompressStream, isCompressedName } from './lz4.ts';
import { parseSensorList, readHeader } from './header.ts';
import type { DbdFile, Series } from './types.ts';
import { gliderOf, MissingCacheError, NOTSET, SAME, UPDATED } from './types.ts';

/** The two names Slocum gives the per-cycle clock, flight and science. */
const TIME_NAMES = ['m_present_time', 'sci_m_present_time'];

const PREAMBLE_BYTES = 17;

export interface OpenOptions {
  /**
   * The text of the matching `<crc>.cac`. Required whenever the file is
   * factored, which in practice is always — a file off a glider carries no
   * sensor list of its own.
   */
  cache?: string;
  /** What to call the file in messages. */
  name?: string;
}

/**
 * Read a file's header without decoding anything.
 *
 * This is what a caller needs before it can help: it reports the CRC of the
 * cache the file wants, so a page can ask for that file by name rather than
 * failing with "missing cache".
 */
export function describe(bytes: Uint8Array, name = '') {
  const input = isCompressedName(name) ? decompressStream(bytes) : bytes;
  const { header } = readHeader(input);
  return header;
}

/**
 * Open a file far enough to read values out of.
 *
 * Decompresses first if the name says the file is compressed, resolves the
 * sensor list from the file itself or from the supplied cache, and validates
 * the byte-order preamble.
 */
export function openDbd(bytes: Uint8Array, options: OpenOptions = {}): DbdFile {
  const name = options.name ?? '';
  const input = isCompressedName(name) ? decompressStream(bytes) : bytes;

  const { header, asciiEnd, inlineSensorList } = readHeader(input);

  let listText = inlineSensorList;
  if (header.sensorListFactored !== 0) {
    if (!options.cache) throw new MissingCacheError(header.sensorListCrc, name);
    listText = options.cache;
  }
  const { sensors, all } = parseSensorList(listText, header.totalNumSensors);

  if (sensors.length !== header.sensorsPerCycle) {
    throw new Error(
      `${name || 'file'}: header says ${header.sensorsPerCycle} sensors per cycle, ` +
        `the sensor list has ${sensors.length} — mismatched cache file?`,
    );
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const littleEndian = checkPreamble(view, asciiEnd, name);

  const position = new Map<string, number>();
  sensors.forEach((sensor, i) => position.set(sensor.name, i));

  const timeName = TIME_NAMES.find((n) => position.has(n));
  if (timeName === undefined) {
    throw new Error(
      `${name || 'file'}: no clock — neither ${TIME_NAMES.join(' nor ')} is in this file`,
    );
  }

  return {
    name,
    header,
    sensors,
    position,
    allSensorNames: all,
    dataOffset: asciiEnd + PREAMBLE_BYTES,
    littleEndian,
    timeName,
    timePosition: position.get(timeName)!,
    bytes: input,
    // The header's own name for itself, so a renamed file still reports the
    // vehicle that wrote it.
    glider: gliderOf(header.fullFilename || name),
  };
}

/**
 * Validate the preamble and return the file's byte order.
 *
 * Every sentinel is checked, not just the marker. They cost nothing and they
 * are the only thing standing between a corrupt or misidentified file and a
 * decode that produces confident nonsense — which, for a format whose values
 * are unlabelled floats, is indistinguishable from real data.
 */
function checkPreamble(view: DataView, at: number, name: string): boolean {
  const where = name ? `${name}: ` : '';
  const start = view.getUint8(at);
  if (start !== 0x73) {
    throw new Error(`${where}binary section does not start with 's' (got 0x${start.toString(16)})`);
  }

  const marker = view.getUint16(at + 2, true);
  const littleEndian = marker === 0x1234;
  if (!littleEndian && view.getUint16(at + 2, false) !== 0x1234) {
    throw new Error(`${where}byte-order marker is 0x${marker.toString(16)}, not 0x1234`);
  }

  const f32 = view.getFloat32(at + 4, littleEndian);
  if (Math.abs(f32 - 123.456) > 1e-3) {
    throw new Error(`${where}float32 sentinel reads ${f32}, expected 123.456`);
  }
  const f64 = view.getFloat64(at + 8, littleEndian);
  if (Math.abs(f64 - 123456789.12345) > 1e-3) {
    throw new Error(`${where}float64 sentinel reads ${f64}, expected 123456789.12345`);
  }

  const end = view.getUint8(at + 16);
  if (end !== 0x64) {
    throw new Error(`${where}preamble does not end with 'd' (got 0x${end.toString(16)})`);
  }
  return littleEndian;
}

export interface ReadOptions {
  /**
   * Drop the first cycle. Slocum writes it as an initialisation cycle with
   * every sensor UPDATED, so its values are the state at file open rather
   * than a measurement. dbdreader and SlocumIO both drop it by default and
   * the fixture is recorded that way.
   */
  skipInitialCycle?: boolean;
  /**
   * Also emit a NaN for cycles where a sensor was NOTSET, instead of leaving
   * it out of that sensor's time base entirely.
   */
  returnNaNs?: boolean;
}

/**
 * Read sensors out of an opened file, each on its own time base.
 *
 * With no `names`, every sensor in the file is read — which is what a decoder
 * page wants, since the reader is choosing columns afterwards.
 *
 * **There is no single time base and this deliberately does not invent one.**
 * A sensor is written on the cycles it was written on; `table.ts` is where a
 * set of these becomes something rectangular, and it says how.
 */
export function readSeries(
  file: DbdFile,
  names?: readonly string[],
  options: ReadOptions = {},
): Series[] {
  const { skipInitialCycle = true, returnNaNs = false } = options;
  const count = file.sensors.length;
  const bytes = file.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  const stateBytes = file.header.stateBytesPerCycle;

  const requested = names ? [...names] : file.sensors.map((s) => s.name);

  // Which positions to collect. The clock is always collected: it is the time
  // base every emitted value is stamped with, whether or not it was asked for.
  const wanted = new Uint8Array(count);
  wanted[file.timePosition] = 1;
  const outFor = new Map<number, { time: number[]; value: number[] }>();
  for (const name of requested) {
    const at = file.position.get(name);
    if (at === undefined) continue; // absent sensors come back empty, not as an error
    wanted[at] = 1;
    if (!outFor.has(at)) outFor.set(at, { time: [], value: [] });
  }

  const size = new Int32Array(count);
  for (let i = 0; i < count; i++) size[i] = file.sensors[i].bytes;

  const state = new Uint8Array(count);
  const offset = new Int32Array(count); // -2 NOTSET, -1 SAME, >=0 byte offset
  const memory = new Float64Array(count).fill(NaN); // last UPDATED value
  const current = new Float64Array(count).fill(NaN);

  // NOTSET emits only when asked for; otherwise a sensor's time base is the
  // cycles it actually appears on.
  const floor = returnNaNs ? -2 : -1;

  let at = file.dataOffset;
  let firstCycle = true;

  while (at < end) {
    if (at + stateBytes > end) break;

    // ── the state bytes: four 2-bit fields each, MSB first ──
    state.fill(NOTSET);
    let sensor = 0;
    for (let b = 0; b < stateBytes; b++) {
      const byte = view.getUint8(at + b);
      for (let k = 0; k < 4 && sensor < count; k++, sensor++) {
        state[sensor] = (byte >> (6 - 2 * k)) & 0x03;
      }
    }
    at += stateBytes;

    // ── one pass for the chunk size and every wanted sensor's place in it ──
    let chunk = 0;
    for (let i = 0; i < count; i++) {
      const st = state[i];
      if (st === UPDATED) {
        if (wanted[i]) offset[i] = chunk;
        chunk += size[i];
      } else if (st === SAME) {
        if (wanted[i]) offset[i] = -1;
      } else if (wanted[i]) {
        offset[i] = -2;
      }
    }

    // A chunk that runs past the end is a genuinely truncated file — which
    // happens, since these arrive over Iridium. Stop, keeping what decoded.
    const chunkStart = at;
    if (chunkStart + chunk > end) break;

    for (let i = 0; i < count; i++) {
      if (!wanted[i]) continue;
      const off = offset[i];
      if (off >= 0) {
        const v = readValue(view, chunkStart + off, size[i], file.littleEndian);
        current[i] = v;
        memory[i] = v;
      } else if (off === -1) {
        current[i] = memory[i];
      } else {
        current[i] = NaN;
      }
    }

    at = chunkStart + chunk + 1; // the +1 is the separator

    if (skipInitialCycle && firstCycle) {
      firstCycle = false;
      continue;
    }
    firstCycle = false;

    const stamp = current[file.timePosition];
    for (const [pos, out] of outFor) {
      if (offset[pos] >= floor) {
        out.time.push(stamp);
        out.value.push(offset[pos] === -2 ? NaN : current[pos]);
      }
    }
  }

  return requested.map((name) => {
    const pos = file.position.get(name);
    const sensor = pos === undefined ? undefined : file.sensors[pos];
    const out = pos === undefined ? undefined : outFor.get(pos);
    return {
      name,
      unit: sensor?.unit ?? '',
      time: Float64Array.from(out?.time ?? []),
      value: Float64Array.from(out?.value ?? []),
      from: file.name,
      glider: file.glider,
    };
  });
}

/**
 * One value out of the chunk.
 *
 * The byte size in the sensor list decides the type, and the mapping is not
 * uniform: 1 and 2 bytes are signed integers, 4 and 8 are IEEE floats. Every
 * value is promoted to a double on the way out, which is lossless for all
 * four and is what the rest of this package works in.
 */
function readValue(view: DataView, at: number, bytes: number, littleEndian: boolean): number {
  switch (bytes) {
    case 1: return view.getInt8(at);
    case 2: return view.getInt16(at, littleEndian);
    case 4: return view.getFloat32(at, littleEndian);
    case 8: return view.getFloat64(at, littleEndian);
    default: throw new Error(`Slocum: a sensor claims ${bytes} bytes, which is not 1, 2, 4 or 8`);
  }
}
