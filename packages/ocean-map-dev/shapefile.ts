/* Reading an ESRI shapefile, with no renderer and no dependency in it.
 *
 * A shapefile is not a file, it is a set: `.shp` holds geometry, `.dbf` holds
 * the attributes, `.prj` holds the coordinate system. All three matter here —
 * without the `.dbf` every feature is nameless, and without the `.prj` there
 * is no way to know whether the numbers are degrees.
 *
 * Written out by hand for the same reason `fetch-coastline.py` reads
 * shapefiles with forty lines of `struct`: the format is a header, a record
 * header and pairs of little-endian doubles, and shpjs pulls in a projection
 * library to do it. What that costs is written down below — this refuses a
 * projected file rather than reprojecting it.
 *
 * No Leaflet and no DOM. See BOUNDARIES.md S1.
 */

import type { LonLat } from './schema';
import { foldLongitudes, skip, type VectorDocument, type VectorFeature } from './vector.ts';

export class ShapefileError extends Error {}

/** The parts of a shapefile set, however they were delivered. */
export interface ShapefileParts {
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: string;
  /** For messages — the base name the reader chose, without an extension. */
  name?: string;
}

/* Shape types, from the ESRI white paper. The Z and M variants carry extra
   arrays *after* the XY pairs, so the XY reading below is identical for all
   three families and the trailing values are simply not read. That is why
   this handles 25 of the 27 defined types in one branch each. */
const NULL_SHAPE = 0;
const POINT = [1, 11, 21];
const POLYLINE = [3, 13, 23];
const POLYGON = [5, 15, 25];
const MULTIPOINT = [8, 18, 28];

// ---- the .prj half -----------------------------------------------------

/**
 * Decide whether a `.prj` describes plain longitude/latitude degrees.
 *
 * **This is the most important function in the file, and refusing is the
 * right answer.** The map takes degrees; a shapefile in State Plane, UTM or
 * Web Mercator carries metres, and metres read as degrees put a survey of
 * Chesapeake Bay somewhere off West Africa — a plausible-looking layer in
 * completely the wrong place, which is the exact failure shape this project
 * catalogues. Reprojecting properly means a projection library and a datum
 * transform, which is a far larger thing than this module.
 *
 * So a projected file is **refused by name**, with the projection quoted back,
 * rather than drawn wrong or silently dropped.
 *
 * A missing `.prj` is *not* refused: it is extremely common, and the geometry
 * itself settles it — degrees fit in ±180/±90 and projected coordinates do
 * not, by orders of magnitude. `plausibleDegrees()` below is that check.
 */
export function geographic(prj: string | undefined): { ok: boolean; reason?: string } {
  if (!prj) return { ok: true };
  const wkt = prj.trim();
  if (!wkt) return { ok: true };
  /* PROJCS wraps a GEOGCS, so the test is which one is outermost — a file
     whose WKT begins PROJCS is projected however much geography it quotes
     inside. */
  if (/^\s*PROJCS/i.test(wkt)) {
    const name = /^\s*PROJCS\s*\[\s*"([^"]*)"/i.exec(wkt)?.[1] ?? 'a projected system';
    return {
      ok: false,
      reason:
        `it is in ${name}, whose coordinates are not degrees — ` +
        `reproject it to WGS 84 (EPSG:4326) and try again`,
    };
  }
  return { ok: true };
}

/* Degrees or not, decided from the numbers. This is what covers a set with no
   `.prj` at all, and it is deliberately generous: anything inside the valid
   range of a longitude and a latitude is accepted, and anything outside it
   cannot be degrees under any convention, including the 0–360 one. */
function plausibleDegrees(box: { xMin: number; yMin: number; xMax: number; yMax: number }): boolean {
  return (
    Number.isFinite(box.xMin) &&
    Number.isFinite(box.yMin) &&
    box.xMin >= -360 && box.xMax <= 360 &&
    box.yMin >= -90 && box.yMax <= 90
  );
}

// ---- the .dbf half -----------------------------------------------------

interface DbfField {
  name: string;
  type: string;
  length: number;
}

/* dBase III+, which is what every shapefile writer emits. The header is 32
   bytes, then a 32-byte descriptor per field terminated by 0x0D, then fixed
   width records each prefixed by a deletion flag. */
function readDbf(bytes: Uint8Array): Record<string, string>[] {
  if (bytes.length < 32) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  if (!recordLength || headerLength < 33) return [];

  /* Field names are ASCII; the values may not be. There is a language driver
     byte and an optional `.cpg` sidecar, and honouring either properly means
     a table of DOS code pages — so this decodes as UTF-8 and falls back to
     latin1, which between them cover what a modern exporter writes and what
     an old one wrote for Western Europe. */
  const ascii = new TextDecoder('ascii');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin1 = new TextDecoder('latin1');
  const decode = (slice: Uint8Array) => {
    try {
      return utf8.decode(slice);
    } catch {
      return latin1.decode(slice);
    }
  };

  const fields: DbfField[] = [];
  for (let at = 32; at + 32 <= headerLength && bytes[at] !== 0x0d; at += 32) {
    const raw = ascii.decode(bytes.subarray(at, at + 11));
    fields.push({
      name: raw.replace(/\0.*$/, '').trim(),
      type: String.fromCharCode(bytes[at + 11]),
      length: bytes[at + 16],
    });
  }
  if (!fields.length) return [];

  const rows: Record<string, string>[] = [];
  for (let r = 0; r < records; r++) {
    const start = headerLength + r * recordLength;
    if (start + recordLength > bytes.length) break;
    // 0x2A marks a record deleted in place; it is still in the file.
    if (bytes[start] === 0x2a) {
      rows.push({});
      continue;
    }
    const row: Record<string, string> = {};
    let at = start + 1;
    for (const field of fields) {
      const value = decode(bytes.subarray(at, at + field.length)).trim();
      /* `L` is a one-character logical. Everything else is already text in
         the file — numbers included, dBase stores them right-aligned ASCII —
         so there is nothing to parse and nothing to get wrong. */
      if (value) row[field.name] = field.type === 'L' ? (/^[YyTt]$/.test(value) ? 'true' : 'false') : value;
      at += field.length;
    }
    rows.push(row);
  }
  return rows;
}

// ---- the .shp half -----------------------------------------------------

/* Shoelace sign. The spec says a polygon's outer rings run clockwise and its
   holes run counter-clockwise, which is the only thing distinguishing "a
   polygon with a hole" from "two polygons" — a record carries both as a flat
   list of parts with nothing else to tell them apart. */
function clockwise(ring: LonLat[]): boolean {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += (x2 - x1) * (y2 + y1);
  }
  return sum > 0;
}

function readPoints(view: DataView, at: number, count: number): LonLat[] {
  const points: LonLat[] = [];
  for (let i = 0; i < count; i++) {
    const x = view.getFloat64(at + i * 16, true);
    const y = view.getFloat64(at + i * 16 + 8, true);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

/* Split a record's flat part list into rings.

   The offsets are counted from the start of the record's *content*, and they
   are: shape type at 0 (4 bytes), the bounding box at 4 (four doubles, 32
   bytes), NumParts at 36, NumPoints at 40, then the part index array. Getting
   this four bytes wrong reads a part count out of the middle of the bounding
   box — which is a double, so it comes out as a nonsense integer in the
   billions and the next read is out of bounds. That is the good case: it
   throws. A smaller wrong number would have drawn something. */
function readParts(view: DataView, at: number): { parts: number[]; points: LonLat[]; end: number } {
  const partCount = view.getInt32(at + 36, true);
  const pointCount = view.getInt32(at + 40, true);
  const partsAt = at + 44;
  const parts: number[] = [];
  for (let i = 0; i < partCount; i++) parts.push(view.getInt32(partsAt + i * 4, true));
  const pointsAt = partsAt + partCount * 4;
  return { parts, points: readPoints(view, pointsAt, pointCount), end: pointsAt + pointCount * 16 };
}

/**
 * Decode a shapefile set into features.
 */
export function readShapefile(input: ShapefileParts): VectorDocument {
  const { shp, dbf, prj, name } = input;
  const doc: VectorDocument = { features: [], overlays: [], skipped: {} };
  if (name) doc.name = name;

  if (shp.length < 100) throw new ShapefileError('the .shp file is too short to be a shapefile');
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  // The file code is big-endian 9994, which is what says this is a .shp.
  if (view.getInt32(0, false) !== 9994) {
    throw new ShapefileError('not a shapefile — the .shp header is missing its file code');
  }

  const crs = geographic(prj);
  if (!crs.ok) throw new ShapefileError(`${name ?? 'that shapefile'} cannot be drawn: ${crs.reason}`);

  const box = {
    xMin: view.getFloat64(36, true),
    yMin: view.getFloat64(44, true),
    xMax: view.getFloat64(52, true),
    yMax: view.getFloat64(60, true),
  };
  if (!plausibleDegrees(box)) {
    throw new ShapefileError(
      `${name ?? 'that shapefile'} is not in degrees — its bounds run ` +
        `${box.xMin.toFixed(0)} to ${box.xMax.toFixed(0)} across and ` +
        `${box.yMin.toFixed(0)} to ${box.yMax.toFixed(0)} up. ` +
        `Reproject it to WGS 84 (EPSG:4326) and try again`
    );
  }

  const rows = dbf ? readDbf(dbf) : [];
  /* The name column is whichever of these the file happens to have. A
     shapefile's attribute names are the author's, so there is no standard to
     follow — this is the same list the GeoJSON reader uses, upper-cased
     variants included, since dBase field names are traditionally caps. */
  const NAME_KEYS = ['NAME', 'Name', 'name', 'TITLE', 'Title', 'title', 'LABEL', 'Label',
    'STATION', 'Station', 'station', 'ID', 'Id', 'id'];

  /* The 100-byte header is followed by records back to back. The header's own
     length field is in 16-bit words and counts itself, but it is not trusted
     to be right — the loop stops at the end of the bytes actually held. */
  let at = 100;
  let index = 0;
  while (at + 8 <= shp.length) {
    const contentWords = view.getInt32(at + 4, false);
    const contentAt = at + 8;
    const contentLength = contentWords * 2;
    if (contentLength <= 0 || contentAt + contentLength > shp.length) break;

    const type = view.getInt32(contentAt, true);
    const row = rows[index] ?? {};
    const nameKey = NAME_KEYS.find((key) => row[key]);
    const attributes = Object.entries(row).filter(([key]) => key !== nameKey);
    const shared = {
      name: nameKey ? row[nameKey] : undefined,
      description: attributes.length
        ? attributes.map(([key, value]) => `${key}: ${value}`).join('\n')
        : undefined,
      folder: name,
    };

    if (type === NULL_SHAPE) {
      skip(doc, 'null shape');
    } else if (POINT.includes(type)) {
      const points = readPoints(view, contentAt + 4, 1);
      if (points.length) doc.features.push({ kind: 'point', coordinates: points, ...shared });
      else skip(doc, 'unreadable position');
    } else if (MULTIPOINT.includes(type)) {
      const count = view.getInt32(contentAt + 36, true);
      for (const point of readPoints(view, contentAt + 40, count)) {
        doc.features.push({ kind: 'point', coordinates: [point], ...shared });
      }
    } else if (POLYLINE.includes(type)) {
      const { parts, points } = readParts(view, contentAt);
      for (let i = 0; i < parts.length; i++) {
        const line = points.slice(parts[i], parts[i + 1] ?? points.length);
        if (line.length >= 2) doc.features.push({ kind: 'line', coordinates: line, ...shared });
        else skip(doc, 'degenerate line');
      }
    } else if (POLYGON.includes(type)) {
      const { parts, points } = readParts(view, contentAt);
      /* Rings accumulate into a polygon until the next clockwise ring starts
         a new one. A record holding one outer ring and two holes becomes one
         feature; a record holding two outer rings becomes two. */
      let current: LonLat[][] = [];
      const flush = () => {
        if (current.length) doc.features.push({ kind: 'polygon', coordinates: current, ...shared });
        current = [];
      };
      for (let i = 0; i < parts.length; i++) {
        const ring = points.slice(parts[i], parts[i + 1] ?? points.length);
        if (ring.length < 3) {
          skip(doc, 'degenerate ring');
          continue;
        }
        if (clockwise(ring) && current.length) flush();
        current.push(ring);
      }
      flush();
    } else {
      skip(doc, `unsupported shape type ${type}`);
    }

    at = contentAt + contentLength;
    index++;
  }

  if (!doc.features.length && !Object.keys(doc.skipped).length) {
    throw new ShapefileError(`${name ?? 'that shapefile'} holds no shapes`);
  }

  /* Same fold as the GeoJSON reader, and it is not hypothetical here either:
     a shapefile written from a model grid on 0–360 longitudes is ordinary. */
  let folded = 0;
  for (const feature of doc.features) if (foldLongitudes(feature.coordinates)) folded++;
  if (folded) {
    doc.notes = [`folded ${folded} 0–360 longitude${folded === 1 ? '' : 's'} into −180–180`];
  }
  if (!dbf) {
    /* Said out loud, because the map looks fine and every popup is empty —
       which reads as the map losing the attributes rather than as the reader
       having left a file behind. */
    doc.notes = [...(doc.notes ?? []), 'no .dbf, so no names or attributes'];
  }
  return doc;
}
