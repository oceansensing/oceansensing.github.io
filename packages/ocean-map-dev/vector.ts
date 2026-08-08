/* What an imported vector file becomes, whatever format it arrived in.
 *
 * These types were `KmzStyle`, `KmzFeature`, `KmzOverlay` and `KmzDocument`,
 * declared in `kmz.ts` because KML was the only thing the map could open.
 * GeoJSON and shapefiles produce the same shapes, so the model moved out and
 * the name went with it — a type called `Kmz*` that three formats produce is
 * the label-outliving-the-thing-it-describes shape this project keeps
 * meeting, and it is cheaper to fix at two readers than at twenty.
 *
 * `kmz.ts` re-exports the old names, so nothing that already imports them had
 * to change in the same commit as a new feature.
 *
 * No Leaflet and no DOM. See BOUNDARIES.md S1.
 */

import type { LonLat } from './schema';

/** What a feature's own styling asks for, already converted from its format's
    own way of spelling it — KML's `aabbggrr`, or simplestyle's `stroke`. */
export interface VectorStyle {
  /** `#rrggbb`. */
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  fill?: string;
  fillOpacity?: number;
  /** KML's PolyStyle can switch either off independently. */
  filled?: boolean;
  outlined?: boolean;
}

export interface VectorFeature {
  kind: 'point' | 'line' | 'polygon';
  /** A point is one position; a line is a path; a polygon is rings, outer first. */
  coordinates: LonLat[] | LonLat[][];
  name?: string;
  /** Plain text, never markup — every format here can carry arbitrary HTML in
      a description or an attribute, and a file from a colleague or a data
      portal is untrusted input even when the reader chose to open it. */
  description?: string;
  /** The enclosing group — a KML Folder, or a layer within an archive — so the
      map can label by it. */
  folder?: string;
  style?: VectorStyle;
}

/* A georeferenced image — a scanned chart, a satellite grab, a model figure.
   KML only: neither GeoJSON nor a shapefile carries one. Placed either on a
   north/south/east/west box or, with gx:LatLonQuad, on four arbitrary
   corners. Exactly one of `bounds` and `corners` is set. */
export interface VectorOverlay {
  name?: string;
  /** North, south, east, west edges in degrees, from LatLonBox. */
  bounds?: { north: number; south: number; east: number; west: number };
  /** Four corners from gx:LatLonQuad, counterclockwise from the south-west —
      so SW, SE, NE, NW, which is the order KML writes them in. Opposite edges
      need not be parallel, which is why this needs a projective warp rather
      than a box. */
  corners?: [LonLat, LonLat, LonLat, LonLat];
  /** Degrees counterclockwise about the centre, from LatLonBox. */
  rotation: number;
  /** From the overlay's own `color`, whose alpha is the opacity. */
  opacity: number;
  /** Higher draws on top. */
  drawOrder: number;
  /** The image, lifted out of the archive. */
  image: Uint8Array;
  mediaType: string;
}

export interface VectorDocument {
  name?: string;
  features: VectorFeature[];
  overlays: VectorOverlay[];
  /** What was present and not drawn, counted by kind. A partial render that
      says nothing is the failure mode this project keeps meeting; this is what
      lets the map report "drew 412, skipped 3 NetworkLinks" instead. */
  skipped: Record<string, number>;
  /** What was drawn, but not as the file spelled it — currently only the
      0–360 longitude fold. Separate from `skipped` because the two are
      different claims and sharing the field made the map say "skipped 326
      longitude folded from 0–360s", which is the wrong word, the wrong
      grammar and the wrong reassurance: nothing was skipped. */
  notes?: string[];
}

/** Count something into `skipped` without the caller repeating the `?? 0`. */
export function skip(doc: { skipped: Record<string, number> }, what: string, n = 1): void {
  doc.skipped[what] = (doc.skipped[what] ?? 0) + n;
}

// ---- longitude ---------------------------------------------------------

/**
 * Bring a geometry into the copy of the world the map draws in.
 *
 * **This is not pedantry about a standard, it is the first file we tested
 * against.** ERDDAP's `.geoJson` publishes 0–360 longitudes — a PIRATA buoy
 * at 10°W comes out as `[350, 0]` — which RFC 7946 does not allow and which
 * Leaflet will happily draw a whole world copy east of where the reader is
 * looking. Vector markers exist in one copy of the world (see the date-line
 * section of CLAUDE.md), so the buoy is simply not on the map.
 *
 * **Per geometry, never per coordinate.** Folding each vertex on its own is
 * the obvious version and it tears anything that legitimately crosses the
 * antimeridian: a line running 170 → 190 becomes 170 → −170 and is drawn the
 * long way round the world. So a geometry moves only when *all* of it is at
 * or past 180, which is exactly the rule `rehomeBathy()` follows for a
 * contour and for the same reason.
 *
 * Safe to apply to a conforming file: valid GeoJSON has nothing above 180
 * except a point exactly on the antimeridian, and moving 180 to −180 names
 * the same meridian.
 *
 * Returns whether it moved anything, so the import can say so rather than
 * silently relocating the reader's data.
 */
export function foldLongitudes(coordinates: LonLat[] | LonLat[][]): boolean {
  const rings: LonLat[][] = Array.isArray(coordinates[0]?.[0])
    ? (coordinates as LonLat[][])
    : [coordinates as LonLat[]];
  let lowest = Infinity;
  for (const ring of rings) for (const [lon] of ring) lowest = Math.min(lowest, lon);
  if (!Number.isFinite(lowest) || lowest < 180) return false;
  for (const ring of rings) {
    for (const point of ring) point[0] -= 360;
  }
  return true;
}

// ---- reporting ---------------------------------------------------------

/** "412 features · skipped 3 NetworkLinks" — for the map to show. */
export function summarise(doc: VectorDocument): string {
  const parts = [`${doc.features.length} feature${doc.features.length === 1 ? '' : 's'}`];
  if (doc.overlays.length) {
    parts.push(`${doc.overlays.length} image${doc.overlays.length === 1 ? '' : 's'}`);
  }
  for (const [what, n] of Object.entries(doc.skipped)) {
    parts.push(`skipped ${n} ${what}${n === 1 ? '' : 's'}`);
  }
  for (const note of doc.notes ?? []) parts.push(note);
  return parts.join(' · ');
}
