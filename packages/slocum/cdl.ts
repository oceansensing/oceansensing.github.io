/**
 * The same document as CDL — netCDF's own text form.
 *
 * # Why a text export earns its place
 *
 * This page cannot write netCDF-4, because netCDF-4 is HDF5 and that is a
 * library rather than a file layout (see `netcdf.ts`). CDL is the way round
 * it: `ncgen -4 file.cdl -o file.nc` produces a genuine netCDF-4 file, and
 * `ncgen` ships with every netCDF installation an operator already has if they
 * are working with glider data at all.
 *
 * So the two exports are not the same file in two wrappers. The netCDF one is
 * immediately usable and encodes OG1's string variables as fixed-width `char`
 * arrays, which is what classic can express. The CDL one declares them as
 * **`string`**, which is what OG1 actually specifies, and one `ncgen` away
 * from being that file exactly.
 *
 * It is also the form the OceanGliders spec ships its own reference examples
 * in, so a CDL is directly comparable with them by eye and by `diff`.
 */

import type { NcAttribute, NcDocument, NcType, NcVariable } from './netcdf.ts';

/** How CDL spells each type. */
const KEYWORD: Record<NcType, string> = {
  byte: 'byte', char: 'char', short: 'short', int: 'int', float: 'float', double: 'double',
};

/**
 * The suffix that pins a numeric literal's type.
 *
 * Not decoration: without it `ncgen` types a bare `0` as an int, so a
 * `_FillValue` of `0` on a byte variable becomes an int attribute and the
 * file no longer says what it meant. `double` takes no suffix but must carry
 * a decimal point for the same reason.
 */
const SUFFIX: Record<NcType, string> = {
  byte: 'b', char: '', short: 's', int: '', float: 'f', double: '',
};

function literal(type: NcType, value: number): string {
  if (Number.isNaN(value)) return type === 'float' ? 'NaNf' : 'NaN';
  if (value === Infinity) return type === 'float' ? 'Infinityf' : 'Infinity';
  if (value === -Infinity) return type === 'float' ? '-Infinityf' : '-Infinity';
  if (type === 'double' || type === 'float') {
    // A double literal has to look like one, or ncgen reads it as an integer.
    const s = Number.isInteger(value) ? `${value}.` : String(value);
    return `${s}${SUFFIX[type]}`;
  }
  return `${Math.trunc(value)}${SUFFIX[type]}`;
}

/** CDL string quoting: the escapes ncgen understands, and nothing else. */
export function quote(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch < ' ') out += `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

function attributeText(prefix: string, attr: NcAttribute): string {
  const value =
    typeof attr.value === 'string'
      ? quote(attr.value)
      : attr.value.map((v) => literal(attr.type, v)).join(', ');
  return `\t\t${prefix}:${attr.name} = ${value} ;`;
}

/** Wrap a long value list the way ncdump does, so a CDL stays readable. */
function wrap(values: readonly string[], indent = '    '): string {
  const lines: string[] = [];
  let line = '';
  for (const value of values) {
    const piece = line ? `${line}, ${value}` : value;
    if (piece.length > 72) {
      lines.push(line + ',');
      line = value;
    } else {
      line = piece;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

export interface CdlOptions {
  /**
   * The name after `netcdf`. Conventionally the file's own stem, which for
   * OG1 is the `id`.
   */
  name: string;
  /**
   * Emit `string` for variables that carry one, rather than the char arrays
   * classic needs. On by default: the whole point of the CDL export is to
   * reach the netCDF-4 form, and `ncgen -3` will refuse it, which is the
   * correct refusal rather than a silent downgrade.
   */
  nativeStrings?: boolean;
  /** Include the data section. Off gives a header-only CDL, as `ncdump -h`. */
  data?: boolean;
}

/**
 * Serialise a document as CDL.
 *
 * Only the dimensions actually used are declared — with `nativeStrings` on,
 * the `STRING<n>` dimensions that exist purely to give a char array its width
 * have nothing left referring to them, and an unused dimension in a file that
 * claims to be a format is a loose end a reader has to reason about.
 */
export function toCdl(document: NcDocument, options: CdlOptions): string {
  const { name, nativeStrings = true, data = true } = options;
  const asString = (v: NcVariable) => nativeStrings && v.strings !== undefined;

  const used = new Set<string>();
  for (const variable of document.variables) {
    if (asString(variable)) {
      // A string variable keeps every dimension but the trailing width one.
      for (const dim of variable.dimensions.slice(0, variable.strings!.length > 1 ? 1 : 0)) {
        used.add(dim);
      }
    } else {
      for (const dim of variable.dimensions) used.add(dim);
    }
  }

  const out: string[] = [`netcdf ${name} {`];

  out.push('dimensions:');
  for (const dim of document.dimensions) {
    if (used.has(dim.name)) out.push(`\t${dim.name} = ${dim.length} ;`);
  }

  out.push('variables:');
  for (const variable of document.variables) {
    const string = asString(variable);
    const keyword = string ? 'string' : KEYWORD[variable.type];
    const dims = string
      ? variable.strings!.length > 1
        ? variable.dimensions.slice(0, 1)
        : []
      : variable.dimensions;
    const shape = dims.length ? `(${dims.join(', ')})` : '';
    out.push(`\t${keyword} ${variable.name}${shape} ;`);
    for (const attr of variable.attributes ?? []) {
      out.push(attributeText(variable.name, attr));
    }
  }

  out.push('');
  out.push('// global attributes:');
  for (const attr of document.attributes ?? []) out.push(attributeText('', attr));

  if (data) {
    out.push('');
    out.push('data:');
    out.push('');
    for (const variable of document.variables) {
      const values = valuesOf(variable, asString(variable));
      out.push(` ${variable.name} = ${wrap(values)} ;`);
      out.push('');
    }
  }

  out.push('}');
  return `${out.join('\n')}\n`;
}

function valuesOf(variable: NcVariable, _string: boolean): string[] {
  // Whichever way it was declared, text is written as text: CDL spells the
  // data of `string V(N)` and of `char V(N, STRLEN)` the same way, as a
  // comma-separated list of quoted strings. Only the declaration differs.
  if (variable.strings) return variable.strings.map(quote);
  if (typeof variable.data === 'string') {
    return [quote(variable.data.replace(/\0+$/, ''))];
  }
  const values: string[] = [];
  for (let i = 0; i < variable.data.length; i++) {
    values.push(literal(variable.type, variable.data[i]));
  }
  return values;
}
