/**
 * The reader's view, as a URL fragment they can send someone.
 *
 * **The same object the saved view already stores**, encoded rather than
 * re-modelled. `saveView` had worked out what "the view" is — centre, zoom,
 * basemap, which overlays, each field's colour scale and range, the particle
 * tints and speeds, the isobath opacity, the forecast hour — and a second
 * definition of that would drift from the first the day a tenth thing became
 * part of a view. So this is a codec, not a model.
 *
 * **A fragment, not a query.** It never reaches the server, so it cannot
 * split a CDN cache entry or turn one page into a thousand cached URLs; it
 * can be rewritten without a navigation; and on a static host there is no
 * server to interpret a query anyway. It is also the convention every other
 * map permalink uses, which matters for a string people paste to each other.
 *
 * **No Leaflet and no DOM**, so `test:units` exercises the round trip with no
 * build and no jsdom — and a native port that wants to open a shared link
 * keeps the parsing.
 *
 * Everything is validated on the way in. A hash is the one input here that
 * arrives from outside: it has been through a chat client, an email, and
 * whatever truncated it on the way. `decode` drops what it cannot read
 * rather than refusing the whole link, so a mangled colour scale still lands
 * you in the right ocean.
 */

/** The shape `saveView` writes and `restoreView` reads. */
export interface SharedView {
  lat: number;
  lng: number;
  zoom: number;
  base?: string;
  overlays?: string[];
  fields?: Record<string, { map?: string; range?: [number, number] | null }>;
  tints?: Record<string, string | null>;
  speeds?: Record<string, number>;
  bathyOpacity?: number;
  lead?: number | null;
}

/* Joins the lists. A comma would be encoded as %2C by URLSearchParams and
   these strings already carry spaces and parentheses — "SST (ESPC)" — so the
   separator is the one character that survives unescaped and does not occur
   in a layer name, a colormap key or a tint. */
const SEP = '~';

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** How many decimals of the centre are worth keeping at this zoom.
 *
 * A permalink that pins the centre to seven decimals is quoting a nanometre
 * of ocean and spending eight characters twice to do it. Web Mercator puts
 * `256 * 2^zoom / 360` pixels in a degree, so one more decimal than that
 * needs lands inside a pixel — which is the most a reader could tell apart,
 * and the point past which precision is only length.
 *
 * Measured: 2 decimals at the globe, 4 at zoom 10. A first pass used one
 * decimal per two zoom levels, which gave the same 2 at the globe and **6**
 * at zoom 10 — two digits describing sub-millimetre positions of a map
 * whose finest data is 3 km. */
const places = (zoom: number) =>
  Math.max(1, Math.min(7, Math.ceil(Math.log10((256 * 2 ** zoom) / 360)) + 1));

export function encode(v: SharedView): string {
  const p = new URLSearchParams();
  const d = places(v.zoom);
  /* zoom/lat/lng, in that order, because that is the order every other map
     permalink uses and someone will read this one by eye. */
  p.set('v', `${+v.zoom.toFixed(2)}/${+v.lat.toFixed(d)}/${+v.lng.toFixed(d)}`);
  if (v.base) p.set('b', v.base);
  if (v.overlays) p.set('l', v.overlays.join(SEP));

  const fields = Object.entries(v.fields ?? {})
    .map(([key, choice]) => {
      const range = choice?.range;
      const at = Array.isArray(range) ? `:${range[0]}:${range[1]}` : '';
      return `${key}:${choice?.map ?? ''}${at}`;
    });
  if (fields.length) p.set('c', fields.join(SEP));

  const tints = Object.entries(v.tints ?? {}).filter(([, t]) => t);
  if (tints.length) p.set('t', tints.map(([k, t]) => `${k}:${t}`).join(SEP));

  const speeds = Object.entries(v.speeds ?? {}).filter(([, s]) => s !== 1);
  if (speeds.length) p.set('s', speeds.map(([k, s]) => `${k}:${s}`).join(SEP));

  if (typeof v.bathyOpacity === 'number') p.set('o', String(+v.bathyOpacity.toFixed(2)));
  if (typeof v.lead === 'number') p.set('f', String(v.lead));
  return p.toString();
}

export function decode(hash: string): SharedView | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const at = (p.get('v') ?? '').split('/');
  const [zoom, lat, lng] = [num(at[0] ?? null), num(at[1] ?? null), num(at[2] ?? null)];
  /* The centre and zoom are the one part that has to be there: without them
     there is no view to restore and the rest describes nothing. */
  if (zoom === undefined || lat === undefined || lng === undefined) return null;
  if (lat < -90 || lat > 90 || zoom < 0 || zoom > 22) return null;

  const view: SharedView = { zoom, lat, lng };
  const base = p.get('b');
  if (base) view.base = base;

  const layers = p.get('l');
  /* An empty `l` is meaningful and is not the same as no `l`: it says the
     reader had every overlay switched off, which is a view someone might
     well want to send. */
  if (layers !== null) view.overlays = layers === '' ? [] : layers.split(SEP);

  const colours = p.get('c');
  if (colours) {
    const fields: NonNullable<SharedView['fields']> = {};
    for (const entry of colours.split(SEP)) {
      const [key, map, lo, hi] = entry.split(':');
      if (!key) continue;
      const a = num(lo ?? null);
      const b = num(hi ?? null);
      fields[key] = {
        map: map || undefined,
        range: a !== undefined && b !== undefined ? [a, b] : null,
      };
    }
    view.fields = fields;
  }

  const tints = p.get('t');
  if (tints) {
    view.tints = {};
    for (const entry of tints.split(SEP)) {
      const [key, tint] = entry.split(':');
      if (key && tint) view.tints[key] = tint;
    }
  }

  const speeds = p.get('s');
  if (speeds) {
    view.speeds = {};
    for (const entry of speeds.split(SEP)) {
      const [key, rate] = entry.split(':');
      const n = num(rate ?? null);
      if (key && n !== undefined) view.speeds[key] = n;
    }
  }

  const opacity = num(p.get('o'));
  if (opacity !== undefined) view.bathyOpacity = opacity;
  const lead = num(p.get('f'));
  if (lead !== undefined) view.lead = lead;
  return view;
}
