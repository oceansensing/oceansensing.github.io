/**
 * A table as CSV.
 *
 * **No comment lines.** Provenance belongs in a file like this and there is
 * nowhere parser-safe to put it: `#` header blocks are a convention only some
 * readers know, and `pandas.read_csv` needs to be told about them or it
 * treats the first one as data. So the CSV is data alone and the netCDF
 * export is the one that carries the header, the model run and the notes.
 * The filename says which glider and which day.
 *
 * **Blank means not recorded, and that is not the same as zero.** A union
 * table is mostly blank by nature — a hundred sensors on a hundred schedules
 * — and writing `NaN` or `0` into those cells would each be a claim the file
 * does not make. An empty field is what every CSV reader already understands
 * as missing.
 */

import type { Table } from './table.ts';

/** Full precision, because a decoder that rounds is not a decoder. */
const number = (v: number): string => (Number.isFinite(v) ? String(v) : '');

/** Quote only when the value would otherwise break the row. */
const field = (s: string): string =>
  /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;

/** `1746656184.004` → `2025-05-07T22:16:24.004Z`. */
export function isoTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '';
  return new Date(epochSeconds * 1000).toISOString();
}

export interface CsvOptions {
  /**
   * Append the unit to each column heading — `m_depth (m)`. On by default:
   * the units are the one piece of the sensor list a CSV can carry, and
   * without them a column of radians is indistinguishable from degrees.
   */
  units?: boolean;
}

/**
 * Write the table.
 *
 * Two time columns, deliberately. `time` is the glider's own epoch seconds,
 * which is what every other glider tool expects and what joins back to the
 * raw file; `time_utc` is ISO 8601, which is what a person reads. Neither is
 * derived from anything but the other.
 */
export function toCsv(table: Table, options: CsvOptions = {}): string {
  const { units = true } = options;

  const head = ['time', 'time_utc'];
  for (const column of table.columns) {
    const label =
      units && column.unit && column.unit !== 'nodim'
        ? `${column.name} (${column.unit})`
        : column.name;
    head.push(field(label));
  }

  const lines: string[] = [head.join(',')];
  const row: string[] = new Array(head.length);

  for (let i = 0; i < table.rows; i++) {
    row[0] = number(table.time[i]);
    row[1] = isoTime(table.time[i]);
    for (let c = 0; c < table.columns.length; c++) {
      row[c + 2] = number(table.columns[c].values[i]);
    }
    lines.push(row.join(','));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * A filename that says what the file is without being opened.
 *
 * Built from the glider's own `full_filename` — `electa-2025-120-1-169` is
 * the glider, the year, the day of year, the mission and the segment — so a
 * directory of exports sorts the way the source files did. Several files
 * decoded together take the first and last.
 */
export function exportName(sources: readonly string[], extension: string): string {
  // Deduplicated, because the ordinary case is a *matched pair* — the flight
  // and science halves of one segment, which differ only in their extension.
  // Left in, that names the file `…-169_to_…-169`, a span of one.
  const stems = [...new Set(sources.map((s) => s.replace(/\.[^.]*$/, '')).filter(Boolean))].sort();
  if (stems.length === 0) return `slocum.${extension}`;
  if (stems.length === 1) return `${stems[0]}.${extension}`;
  return `${stems[0]}_to_${stems[stems.length - 1]}.${extension}`;
}
