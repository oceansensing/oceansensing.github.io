/* Geometry and coordinate formatting, with no renderer in it.
 *
 * Nothing here imports Leaflet, and nothing here should. These are the parts
 * an iOS port would keep verbatim while reimplementing the drawing, so a
 * `Point` is a plain pair rather than an `L.LatLng` — Leaflet's own objects
 * satisfy it structurally, so callers need no conversion.
 */

export interface Point {
  lat: number;
  lng: number;
}

const RAD = Math.PI / 180;

/** Fold a longitude into -180..180. */
export function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Initial great-circle bearing from `a` to `b`, in degrees true. */
export function initialBearing(a: Point, b: Point): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const dλ = (b.lng - a.lng) * RAD;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Kilometres and nautical miles: the chart unit belongs on an ocean map. */
export function spanText(metres: number): string {
  const km = metres / 1000;
  const nm = metres / 1852;
  const round = (v: number) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v));
  return `${round(km)} km · ${round(nm)} nm`;
}

/* Degrees and decimal minutes, which is what a chart, a GPS and a float's own
   position report all speak — the readouts here are meant to be compared
   against those without arithmetic in between.

   Two details that are easy to get wrong and look almost right: minutes are
   rounded before the degrees are taken, or 59.999' becomes 60.00' and the
   degree beside it never carries; and longitude is padded to three digits,
   because 067° and 67° sort and scan differently in a column of positions. */
export function ddm(value: number, positive: string, negative: string, width: number): string {
  const hemisphere = value >= 0 ? positive : negative;
  let degrees = Math.floor(Math.abs(value));
  let minutes = (Math.abs(value) - degrees) * 60;
  if (Number(minutes.toFixed(2)) >= 60) {
    minutes = 0;
    degrees += 1;
  }
  return `${String(degrees).padStart(width, '0')}° ${minutes.toFixed(2).padStart(5, '0')}′ ${hemisphere}`;
}

/** A position in degrees and decimal minutes, longitude folded first. */
export function coordText(lat: number | Point, lng?: number): string {
  const y = typeof lat === 'number' ? lat : lat.lat;
  const x = typeof lat === 'number' ? (lng as number) : lat.lng;
  // Folded, so a track that has wrapped past the antimeridian does not
  // report 293°E.
  return `${ddm(y, 'N', 'S', 2)}, ${ddm(wrapLongitude(x), 'E', 'W', 3)}`;
}

/** "2026-08-02 14:00Z", or "unknown". */
export function stamp(t?: string): string {
  return t ? `${t.slice(0, 16).replace('T', ' ')}Z` : 'unknown';
}

/** " · day 12" — how long a platform has been out at its last fix. */
export function elapsed(from?: string, to?: string): string {
  if (!from || !to) return '';
  const days = Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
  return Number.isFinite(days) && days >= 0 ? ` · day ${days + 1}` : '';
}
