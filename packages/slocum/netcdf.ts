/**
 * A table as netCDF, written by hand.
 *
 * **netCDF-3 classic (CDF-1), not netCDF-4.** netCDF-4 is HDF5 underneath —
 * a general-purpose hierarchical container with B-trees, chunking and
 * optional compression, which is a library, not a file writer. Classic is a
 * published binary layout of about two hundred lines: a magic number, a
 * dimension list, an attribute list, a variable list, then the data,
 * big-endian and padded to four bytes. Every tool that reads glider netCDF
 * reads it — `ncdump`, xarray, MATLAB, Ferret, ERDDAP.
 *
 * That is the same argument `kmz.ts` makes about ZIP libraries and `lz4.ts`
 * about LZ4, and it matters more here than either: this file is served to a
 * browser, and a netCDF-4 writer would mean shipping a WASM build of HDF5 to
 * export a table of doubles.
 *
 * **Fixed dimensions, no record dimension.** `time` could be UNLIMITED, and a
 * file written for appending usually makes it so. This one is written whole
 * and never appended to, and a record dimension costs the interleaved record
 * layout — every variable's rows woven together — for no benefit. Fixed
 * dimensions lay each variable out contiguously, which is both less code and
 * less to get wrong. It is entirely valid netCDF either way.
 *
 * **It does not claim CF.** The variable names are the glider's own sensor
 * names and the units are the glider's own unit strings — `degc`, `nodim`,
 * `enum`, `X` — which are not udunits and not CF standard names. Writing
 * `Conventions = "CF-1.8"` would be a claim that some tool downstream will
 * eventually believe. `time` is the one variable whose units are genuinely
 * udunits, because that one we compute.
 */

import type { Table } from './table.ts';

const NC_BYTE = 1;
const NC_CHAR = 2;
const NC_SHORT = 3;
const NC_INT = 4;
const NC_FLOAT = 5;
const NC_DOUBLE = 6;

const NC_DIMENSION = 0x0a;
const NC_VARIABLE = 0x0b;
const NC_ATTRIBUTE = 0x0c;

/**
 * CDF-1 stores every offset as a 32-bit integer, so the whole file has to fit
 * in one. Refused up front with the number, rather than written and found
 * unreadable: a file whose offsets have wrapped opens and gives wrong data.
 */
const MAX_FILE_BYTES = 2 ** 31 - 1;

type AttrValue = string | number[];

interface Attr {
  name: string;
  value: AttrValue;
}

class Writer {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  length = 0;

  private room(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(this.bytes.buffer);
  }

  int(value: number) {
    this.room(4);
    this.view.setInt32(this.length, value, false); // netCDF is big-endian throughout
    this.length += 4;
  }

  double(value: number) {
    this.room(8);
    this.view.setFloat64(this.length, value, false);
    this.length += 8;
  }

  raw(source: Uint8Array) {
    this.room(source.length);
    this.bytes.set(source, this.length);
    this.length += source.length;
  }

  /** Pad with zeros to the next 4-byte boundary, as the format requires. */
  pad() {
    const over = this.length % 4;
    if (over === 0) return;
    this.room(4 - over);
    this.bytes.fill(0, this.length, this.length + (4 - over));
    this.length += 4 - over;
  }

  /** A netCDF string: its length, its bytes, then padding. */
  text(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.int(encoded.length);
    this.raw(encoded);
    this.pad();
  }

  /** Rewrite an int already written, once its value is known. */
  patchInt(at: number, value: number) {
    this.view.setInt32(at, value, false);
  }

  /** Where the next int will land, so it can be patched later. */
  get here() {
    return this.length;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function writeAttrs(out: Writer, attrs: readonly Attr[]) {
  if (attrs.length === 0) {
    out.int(0); // ABSENT is a zero tag...
    out.int(0); // ...and a zero count
    return;
  }
  out.int(NC_ATTRIBUTE);
  out.int(attrs.length);
  for (const attr of attrs) {
    out.text(attr.name);
    if (typeof attr.value === 'string') {
      const encoded = new TextEncoder().encode(attr.value);
      out.int(NC_CHAR);
      out.int(encoded.length);
      out.raw(encoded);
      out.pad();
    } else {
      out.int(NC_DOUBLE);
      out.int(attr.value.length);
      for (const v of attr.value) out.double(v);
    }
  }
}

/**
 * netCDF names allow letters, digits and underscore, and may not begin with a
 * digit. Slocum sensor names already satisfy that — this is here for the
 * derived columns and for whatever a future sensor is called.
 *
 * Collisions are resolved rather than allowed: two different sensors reduced
 * to one name would silently drop a column, which is the failure this whole
 * package exists to avoid.
 */
function safeNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    let name = raw.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(name)) name = `v_${name}`;
    let unique = name;
    let n = 2;
    while (used.has(unique)) unique = `${name}_${n++}`;
    used.add(unique);
    return unique;
  });
}

export interface NetcdfOptions {
  /** What the file is, for the `title` attribute. */
  title?: string;
  /** The files it was decoded from. */
  sources?: readonly string[];
  /** Free-form provenance, one per line, appended to `history`. */
  history?: readonly string[];
  /** Anything else, verbatim. */
  attributes?: Record<string, string>;
}

/**
 * Write a table as a netCDF-3 classic file.
 *
 * Every variable is a double on one fixed `time` dimension. Promoting the
 * float32 sensors would be lossless and pointless; keeping them as float32
 * would mean the table's own `NaN` blanks needed a second fill value. One
 * type is simpler and the file is not large enough for it to matter.
 */
export function toNetcdf(table: Table, options: NetcdfOptions = {}): Uint8Array {
  const out = new Writer();
  const names = safeNames(table.columns.map((c) => c.name));

  // ── magic, numrecs ──
  out.raw(new Uint8Array([0x43, 0x44, 0x46, 0x01])); // "CDF\x01"
  out.int(0); // no record dimension, so no records

  // ── dimensions ──
  out.int(NC_DIMENSION);
  out.int(1);
  out.text('time');
  out.int(table.rows);

  // ── global attributes ──
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const history = [
    `${now}: decoded from Slocum binary by the C4PO Slocum decoder ` +
      '(https://oceansensing.org/data/slocum/), in the browser',
    ...(table.notes ?? []),
    ...(options.history ?? []),
  ].join('\n');

  const global: Attr[] = [
    { name: 'title', value: options.title ?? 'Slocum glider data' },
    { name: 'source', value: (options.sources ?? []).join(' ') || 'Slocum glider binary data' },
    { name: 'history', value: history },
    {
      name: 'units_note',
      value:
        'Variable units are the glider sensor list’s own strings, unmodified. ' +
        'They are not udunits and this file does not claim CF conventions. The ' +
        'time variable is the exception and is genuinely udunits.',
    },
  ];
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    global.push({ name, value });
  }
  writeAttrs(out, global);

  // ── variables ──
  // `begin` cannot be known until the header is complete, so each is written
  // as a placeholder and patched once the header length is final.
  out.int(NC_VARIABLE);
  out.int(table.columns.length + 1);

  const beginAt: number[] = [];
  const sizes: number[] = [];

  const writeVar = (name: string, attrs: Attr[]) => {
    out.text(name);
    out.int(1); // one dimension...
    out.int(0); // ...which is `time`, the only one
    writeAttrs(out, attrs);
    out.int(NC_DOUBLE);
    const bytes = table.rows * 8; // already a multiple of 4, so no padding
    out.int(bytes); // vsize
    sizes.push(bytes);
    beginAt.push(out.here);
    out.int(0); // begin, patched below
  };

  writeVar('time', [
    { name: 'units', value: 'seconds since 1970-01-01T00:00:00Z' },
    { name: 'long_name', value: 'time' },
    { name: 'standard_name', value: 'time' },
    { name: 'calendar', value: 'gregorian' },
    { name: 'axis', value: 'T' },
  ]);

  table.columns.forEach((column, i) => {
    const attrs: Attr[] = [
      { name: 'units', value: column.unit || 'unknown' },
      { name: 'long_name', value: column.name },
      { name: '_FillValue', value: [NaN] },
    ];
    if (names[i] !== column.name) attrs.push({ name: 'slocum_sensor', value: column.name });
    if (column.source === 'derived') {
      attrs.push({
        name: 'comment',
        value: 'Derived from recorded sensors, not measured by the glider.',
      });
    } else if (column.source === 'interpolated') {
      attrs.push({
        name: 'comment',
        value: 'Linearly interpolated onto the table’s time base; not a recorded sample.',
      });
    }
    if (column.from) attrs.push({ name: 'slocum_file', value: column.from });
    writeVar(names[i], attrs);
  });

  // ── patch the offsets, now that the header is done ──
  let at = out.length;
  const total = sizes.reduce((sum, n) => sum + n, at);
  if (total > MAX_FILE_BYTES) {
    throw new Error(
      `netCDF classic cannot hold ${(total / 2 ** 30).toFixed(1)} GB — ` +
        'its offsets are 32-bit. Export fewer sensors, or fewer files, or use CSV.',
    );
  }
  for (let i = 0; i < beginAt.length; i++) {
    out.patchInt(beginAt[i], at);
    at += sizes[i];
  }

  // ── data, in variable order ──
  for (const t of table.time) out.double(t);
  for (const column of table.columns) {
    for (const v of column.values) out.double(v);
  }

  return out.finish();
}

/** The type tags, exported so a test can name them rather than repeat 6. */
export const TYPES = { NC_BYTE, NC_CHAR, NC_SHORT, NC_INT, NC_FLOAT, NC_DOUBLE };
