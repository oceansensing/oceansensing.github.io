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

/** "2026-08-04 00Z", and the minutes only when there are any.

    Model runs and forecast steps both land on the hour, so `stamp()` spends
    four characters printing `:00` on a line — the map's attribution — that
    already wraps. Its own callers are platform fix times, which are not on
    the hour and read better in a column with the minutes always present, so
    this is a second formatter rather than a change to that one. */
export function hourStamp(t?: string): string {
  if (!t) return 'unknown';
  return t.slice(14, 16) === '00'
    ? `${t.slice(0, 10)} ${t.slice(11, 13)}Z`
    : `${t.slice(0, 10)} ${t.slice(11, 16)}Z`;
}

/** "+3 h", "now", "-2 h" — how far a valid time is from the reader's clock.

    This is the part a lead time cannot say. Leads are counted from the model
    run, and ESPC's runs land 24-33 hours after their nominal hour, so T+36
    is a field for about three hours from now today and would be a day and a
    half out if a run ever landed promptly. With one frame published there is
    no lead control on screen either, so without this a forecast field reads
    as the present.

    Rounded to whole hours, and `now` covers the half hour either side: the
    map is redrawn hourly, so a number that claims more precision than that
    would be stale before it was read. */
export function hoursAhead(valid?: string, now: number = Date.now()): string {
  if (!valid) return '';
  const hours = Math.round((Date.parse(valid) - now) / 3.6e6);
  if (!Number.isFinite(hours)) return '';
  return hours === 0 ? 'now' : hours > 0 ? `+${hours} h` : `${hours} h`;
}

/** " · day 12" — how long a platform has been out at its last fix. */
export function elapsed(from?: string, to?: string): string {
  if (!from || !to) return '';
  const days = Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
  return Number.isFinite(days) && days >= 0 ? ` · day ${days + 1}` : '';
}

/* The graticule's spacing ladder, and the labels that ride it.

   These live here rather than beside the drawing because they are the
   renderer-independent half of a graticule: a native port reimplements the
   polylines and keeps the ladder and the wording exactly. */

/** Degrees between grid lines at a zoom. */
const GRID_STEPS: readonly (readonly [number, number])[] = [
  [3, 30], [5, 10], [7, 5], [9, 2], [99, 1],
];

/** **Spacing follows the zoom.** A fixed 10° was unreadable at both ends:
    eighteen meridians crowding the globe view, and at zoom 8 often not one
    line on screen — a grid that is either noise or absent is not a grid.
    The ladder stops at 1° because below a degree the scale bar is the
    better instrument. */
export function gridStepFor(zoom: number): number {
  return GRID_STEPS.find(([upTo]) => zoom <= upTo)![1];
}

/** Short form — `060°W`, `40°N` — not the degrees-and-decimal-minutes the
    readout uses. A graticule label is read at a glance and sits over the
    map; the readout is where a position is read exactly.

    Longitude is padded to three digits and latitude to two, so a column of
    them scans straight. */
export function gridLabel(v: number, pos: string, neg: string, pad: number): string {
  const at = pad === 3 ? wrapLongitude(v) : v;
  const d = Math.abs(at);
  /* Neither end of the axis takes a hemisphere: 0 is the equator or the
     prime meridian, and 180 is the antimeridian — "180°W" is both wrong and,
     one line further east, contradicted by "180°E" for the same meridian. */
  const hemi = d === 0 || d === 180 ? '' : at > 0 ? pos : neg;
  return `${String(Math.round(d)).padStart(pad, '0')}°${hemi}`;
}

/** The lowest zoom at which one world still fills a viewport this wide.

    Vector markers live in exactly one copy of the world, so a view wider
    than 360° has ocean in it that no platform can ever occupy. Measured on
    an 1858 px container at zoom 2, where the world is 1024 px across: 1.81
    copies on screen, a 653° view, and the fleet spanning 360° of it — about
    45% of the width permanently bare.

    **Fractional on purpose.** Rounding up to a whole zoom level was the
    first idea and is worse: between 1025 and 2047 px it jumps to a level
    showing half the world, so the reader loses the global view to fix an
    edge artefact. Leaflet snaps a requested zoom before clamping it to
    `minZoom`, so a fractional floor survives the +/- buttons and the wheel.

    `floor` is the map's own minimum, which wins on narrow screens: at
    1024 px and below one world already covers the viewport at zoom 2, so
    there is nothing to raise. 256 is Leaflet's tile size — the world is
    256 × 2^zoom pixels across. */
export function minZoomForWidth(widthPx: number, floor: number): number {
  if (!(widthPx > 0)) return floor;
  return Math.max(floor, Math.log2(widthPx / 256));
}
