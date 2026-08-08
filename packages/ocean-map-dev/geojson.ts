/* Reading GeoJSON, with no renderer in it.
 *
 * Leaflet has `L.geoJSON` and this deliberately does not use it. The point of
 * BOUNDARIES.md S1 is that a native port keeps the reading and rewrites only
 * the drawing, and going through Leaflet here would put the validation, the
 * property flattening and the longitude fold below on the wrong side of that
 * line — as well as handing a popup arbitrary HTML out of a stranger's file.
 *
 * What arrives here is untrusted. A GeoJSON is a file a reader was sent, or a
 * URL a service generated, so every field is checked rather than believed and
 * anything unreadable is **counted** rather than dropped in silence.
 *
 * No Leaflet and no DOM. See BOUNDARIES.md S1.
 */

import type { LonLat } from './schema';
import { foldLongitudes, skip, type VectorDocument, type VectorFeature, type VectorStyle }
  from './vector.ts';

export class GeoJsonError extends Error {}

/* Properties worth showing as the feature's name, in the order they are
   tried. `station` and `platform_code` are here because the first file this
   was built against is an ERDDAP table of moorings, where they are the
   identity — and no generic reader would guess them from `name` alone. */
const NAME_KEYS = [
  'name', 'Name', 'NAME',
  'title', 'Title', 'TITLE',
  'label', 'Label',
  'station', 'Station', 'STATION',
  'station_name', 'site', 'id', 'ID', 'wmo_platform_code', 'callsign',
];

/* simplestyle-spec, which is what GitHub, Mapbox and most exporters write.
   There is no styling in the GeoJSON standard itself, so this is a
   convention — but it is the only one in wide use, and reading it costs
   nothing where ignoring it means a reader's carefully coloured file arrives
   in one colour. */
function styleFrom(properties: Record<string, unknown>): VectorStyle | undefined {
  const style: VectorStyle = {};
  const hex = (v: unknown) =>
    typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())
      ? `#${v.trim().replace(/^#/, '').toLowerCase()}`
      : undefined;
  const unit = (v: unknown) =>
    typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined;

  const stroke = hex(properties['stroke']);
  if (stroke) style.stroke = stroke;
  const fill = hex(properties['fill']);
  if (fill) style.fill = fill;
  const strokeOpacity = unit(properties['stroke-opacity']);
  if (strokeOpacity !== undefined) style.strokeOpacity = strokeOpacity;
  const fillOpacity = unit(properties['fill-opacity']);
  if (fillOpacity !== undefined) style.fillOpacity = fillOpacity;
  const width = properties['stroke-width'];
  if (typeof width === 'number' && width > 0) style.strokeWidth = width;

  return Object.keys(style).length ? style : undefined;
}

/* Every property as plain text, one per line. Never markup: a GeoJSON
   property is a string a stranger wrote, and `index.ts` builds the popup with
   `textContent`, so this is belt and braces on the same rule `kmz.ts`
   describes at more length.

   The style keys are left out — the reader can see the colour on the map, and
   repeating `stroke: #ff0000` in a popup is noise. */
const STYLE_KEYS = new Set([
  'stroke', 'fill', 'stroke-width', 'stroke-opacity', 'fill-opacity',
  'marker-size', 'marker-symbol', 'marker-color',
]);

function describe(properties: Record<string, unknown>, nameKey?: string): string | undefined {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (key === nameKey || STYLE_KEYS.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // nested objects are not a caption
    lines.push(`${key}: ${String(value).replace(/<[^>]*>/g, '').trim()}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** One position, checked. GeoJSON is `[lon, lat]` — the opposite order to
    every `L.latLng` in the map, which is the one thing everybody gets wrong
    once. Altitude is a legal third element and is read and dropped. */
function position(raw: unknown): LonLat | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined;
  const lon = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  if (Math.abs(lat) > 90) return undefined;
  return [lon, lat];
}

function positions(raw: unknown): LonLat[] {
  if (!Array.isArray(raw)) return [];
  const out: LonLat[] = [];
  for (const item of raw) {
    const point = position(item);
    if (point) out.push(point);
  }
  return out;
}

interface Shared {
  name?: string;
  description?: string;
  style?: VectorStyle;
  folder?: string;
}

/* One geometry becomes one or more features. A Multi* is expanded rather than
   kept whole: the map draws a `VectorFeature` as a single Leaflet layer, and
   the parts of a MultiPolygon are genuinely separate shapes. */
function featuresFrom(
  geometry: unknown,
  shared: Shared,
  doc: VectorDocument,
  depth = 0
): VectorFeature[] {
  if (!geometry || typeof geometry !== 'object') return [];
  const { type, coordinates, geometries } = geometry as {
    type?: unknown;
    coordinates?: unknown;
    geometries?: unknown;
  };
  if (typeof type !== 'string') return [];

  const made: VectorFeature[] = [];
  const push = (kind: VectorFeature['kind'], coords: LonLat[] | LonLat[][]) => {
    made.push({ kind, coordinates: coords, ...shared });
  };

  switch (type) {
    case 'Point': {
      const point = position(coordinates);
      if (point) push('point', [point]);
      else skip(doc, 'unreadable position');
      break;
    }
    case 'MultiPoint': {
      for (const point of positions(coordinates)) push('point', [point]);
      break;
    }
    case 'LineString': {
      const line = positions(coordinates);
      // Two points is the least that draws; one is a point badly spelled.
      if (line.length >= 2) push('line', line);
      else skip(doc, 'degenerate line');
      break;
    }
    case 'MultiLineString': {
      for (const part of Array.isArray(coordinates) ? coordinates : []) {
        const line = positions(part);
        if (line.length >= 2) push('line', line);
        else skip(doc, 'degenerate line');
      }
      break;
    }
    case 'Polygon': {
      const rings = (Array.isArray(coordinates) ? coordinates : [])
        .map(positions)
        .filter((ring) => ring.length >= 3);
      if (rings.length) push('polygon', rings);
      else skip(doc, 'degenerate polygon');
      break;
    }
    case 'MultiPolygon': {
      for (const polygon of Array.isArray(coordinates) ? coordinates : []) {
        const rings = (Array.isArray(polygon) ? polygon : [])
          .map(positions)
          .filter((ring) => ring.length >= 3);
        if (rings.length) push('polygon', rings);
        else skip(doc, 'degenerate polygon');
      }
      break;
    }
    case 'GeometryCollection': {
      /* Nested collections are legal and a collection containing itself is
         not, but this reads files it did not write — so the depth is bounded
         rather than trusted. */
      if (depth > 4) {
        skip(doc, 'deeply nested geometry');
        break;
      }
      for (const inner of Array.isArray(geometries) ? geometries : []) {
        made.push(...featuresFrom(inner, shared, doc, depth + 1));
      }
      break;
    }
    default:
      skip(doc, `unsupported ${type} geometry`);
  }
  return made;
}

/**
 * Decode GeoJSON into features.
 *
 * Takes bytes rather than a parsed object so it matches `readKmz` and so the
 * caller does not have to know the encoding: GeoJSON is UTF-8 by RFC 7946.
 */
export function readGeoJson(bytes: Uint8Array, sourceName?: string): VectorDocument {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new GeoJsonError(
      `${sourceName ?? 'the file'} is not valid JSON — ${
        error instanceof Error ? error.message : 'could not be parsed'
      }`
    );
  }
  if (!root || typeof root !== 'object') {
    throw new GeoJsonError('not a GeoJSON object');
  }

  const doc: VectorDocument = { features: [], overlays: [], skipped: {} };
  const top = root as Record<string, unknown>;
  if (typeof top['name'] === 'string') doc.name = top['name'];

  /* A file may be a FeatureCollection, a lone Feature, or a bare geometry —
     all three are valid GeoJSON and services emit all three. */
  const entries: unknown[] =
    top['type'] === 'FeatureCollection'
      ? Array.isArray(top['features'])
        ? (top['features'] as unknown[])
        : []
      : [root];

  if (top['type'] === 'FeatureCollection' && !Array.isArray(top['features'])) {
    throw new GeoJsonError('a FeatureCollection with no features array');
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const isFeature = item['type'] === 'Feature';
    const geometry = isFeature ? item['geometry'] : item;
    const properties =
      isFeature && item['properties'] && typeof item['properties'] === 'object'
        ? (item['properties'] as Record<string, unknown>)
        : {};

    /* A Feature with a null geometry is legal GeoJSON — it carries attributes
       and no location. There is nothing to draw, so it is counted. */
    if (isFeature && geometry === null) {
      skip(doc, 'feature without geometry');
      continue;
    }

    const nameKey = NAME_KEYS.find(
      (key) => typeof properties[key] === 'string' || typeof properties[key] === 'number'
    );
    const shared: Shared = {
      name: nameKey === undefined ? undefined : String(properties[nameKey]),
      description: describe(properties, nameKey),
      style: styleFrom(properties),
    };
    doc.features.push(...featuresFrom(geometry, shared, doc));
  }

  /* The fold is applied here rather than inside `featuresFrom` so it runs once
     per drawn feature and can be counted. See `foldLongitudes` for why this
     exists at all — the first file this was tested against needs it. */
  let folded = 0;
  for (const feature of doc.features) {
    if (foldLongitudes(feature.coordinates)) folded++;
  }
  if (folded) {
    /* Reported, not silent. The reader's data has been moved 360° and is
       entitled to say so — this is the one place an import changes what the
       file said, and an unannounced correction is indistinguishable from the
       map being wrong about where something is. */
    doc.notes = [
      ...(doc.notes ?? []),
      `folded ${folded} 0–360 longitude${folded === 1 ? '' : 's'} into −180–180`,
    ];
  }

  return doc;
}
