/**
 * The geometry of an exported figure, worked out without drawing anything.
 *
 * A PNG of this map is not a screenshot. What makes it worth more than one is
 * that it carries its own **provenance**: the colour bar and its range, a key
 * per animated field, and the credit line naming every source with the model
 * run and valid hour it came from. So the figure is a map with a band under
 * it, and this module decides how tall that band is and what goes where.
 *
 * **No Leaflet and no DOM**, so `test:units` exercises it with no build and
 * no jsdom, and a native port keeps the layout. The one browser capability it
 * genuinely needs is text measurement — you cannot wrap a credit line without
 * knowing how wide it is — so `measure` is **injected**, which is the same
 * escape hatch `kmz.ts` uses for `DOMParser` (see BOUNDARIES S1). A caller in
 * a browser passes `(s) => ctx.measureText(s).width`; the unit tests pass
 * arithmetic.
 *
 * Everything here is in **figure pixels**, already multiplied by `scale`. The
 * caller sets one transform and then draws in these coordinates, so nothing
 * downstream has to remember to multiply — which is exactly the sort of thing
 * that goes wrong once and then goes wrong everywhere.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A colour bar or a particle key, as it will be drawn. */
export interface FigureKey {
  /** The words: "SST 18 to 28 °C", or "Current". */
  label: string;
  /** CSS colours across the swatch. One entry paints a flat swatch. */
  ramp: string[];
  swatch: Rect;
  /** Baseline for the label text, to the right of the swatch. */
  text: { x: number; y: number };
}

export interface FigurePlan {
  width: number;
  height: number;
  map: Rect;
  /** Null when there is nothing to say — no keys and no credit. */
  band: Rect | null;
  keys: FigureKey[];
  credits: Array<{ text: string; x: number; y: number }>;
  /** Font sizes in figure pixels, so the caller does not re-derive them. */
  fonts: { key: number; credit: number };
}

export interface FigureRequest {
  /** The map's size in CSS pixels. */
  mapW: number;
  mapH: number;
  /** 1 for screen, 2 for print. Multiplies everything. */
  scale?: number;
  keys?: Array<{ label: string; ramp: string[] }>;
  /** The credit, exactly as the map shows it: sources joined by "; ". */
  credit?: string;
  /** Width of a string at a given font size, in unscaled pixels. */
  measure: (text: string, fontSize: number) => number;
}

/* Unscaled, in CSS pixels; every one is multiplied by `scale` below. The
   swatch is wider than it is tall because a colour bar has to show a *ramp* —
   a square reads as a single colour, which is the one thing it must not. */
const PAD = 10;
const KEY_FONT = 11;
const CREDIT_FONT = 10;
const SWATCH_W = 54;
const SWATCH_H = 9;
const KEY_GAP = 14;
const LINE = 1.45;

/** Split the credit into its sources.
 *
 * The map joins them with a semicolon rather than Leaflet's comma, because
 * the credits contain commas of their own — `US Navy ESPC-D-V02 — valid
 * 2026-08-05 00Z (+8 h), 2026-08-03 12Z run` is one source — so splitting on
 * a comma would report four sources where there is one. */
export function creditSources(credit: string): string[] {
  return credit
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Greedy word wrap.
 *
 * A credit line is long, and the figure is only as wide as the map — on a
 * phone that is about 360 px against a credit that routinely runs past 200
 * characters, so wrapping is the common case rather than the edge one.
 *
 * A single word longer than the line is emitted on its own rather than
 * dropped or split: a truncated URL is worse than an overhanging one, and
 * this is provenance. */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0] as string;
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (measure(candidate) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Where everything goes.
 *
 * The band's height is **derived from its contents**, never assumed: keys
 * wrap onto as many rows as they need and the credit wraps to as many lines
 * as it takes, and the band is however tall that came to. A fixed height was
 * the first idea and is wrong in both directions — it clips a six-source
 * credit on a phone and leaves a stripe of empty paper under a one-source
 * credit on a wide screen.
 */
export function planFigure(request: FigureRequest): FigurePlan {
  const scale = request.scale ?? 1;
  const s = (v: number) => v * scale;
  const keyFont = s(KEY_FONT);
  const creditFont = s(CREDIT_FONT);
  const pad = s(PAD);
  const width = Math.round(request.mapW * scale);
  const mapH = Math.round(request.mapH * scale);
  const inner = width - pad * 2;

  const measureAt = (text: string, size: number) => request.measure(text, size) * scale;

  /* Keys flow left to right and wrap, the way the legend on the page does.
     Each occupies its swatch plus its label plus a gap. */
  const keys: FigureKey[] = [];
  const rowH = Math.max(keyFont * LINE, s(SWATCH_H) + s(4));
  let cursorX = pad;
  let cursorY = mapH + pad;
  for (const key of request.keys ?? []) {
    const labelW = measureAt(key.label, KEY_FONT);
    const itemW = s(SWATCH_W) + s(5) + labelW;
    if (cursorX > pad && cursorX + itemW > width - pad) {
      cursorX = pad;
      cursorY += rowH;
    }
    keys.push({
      label: key.label,
      ramp: key.ramp,
      swatch: {
        x: cursorX,
        y: cursorY + (rowH - s(SWATCH_H)) / 2,
        w: s(SWATCH_W),
        h: s(SWATCH_H),
      },
      // Baseline, not top: the caller draws with textBaseline 'middle'.
      text: { x: cursorX + s(SWATCH_W) + s(5), y: cursorY + rowH / 2 },
    });
    cursorX += itemW + s(KEY_GAP);
  }
  if (keys.length) cursorY += rowH;

  /* Every source on its own line, each wrapped. One source per line rather
     than one long paragraph, because a reader scanning a figure for "where
     did the temperature come from" is looking for a line, not a clause. */
  const credits: Array<{ text: string; x: number; y: number }> = [];
  const creditLineH = creditFont * LINE;
  const sources = creditSources(request.credit ?? '');
  if (sources.length && keys.length) cursorY += s(4);
  for (const source of sources) {
    for (const line of wrapText(source, inner, (t) => measureAt(t, CREDIT_FONT))) {
      credits.push({ text: line, x: pad, y: cursorY + creditLineH / 2 });
      cursorY += creditLineH;
    }
  }

  const hasBand = keys.length > 0 || credits.length > 0;
  const height = hasBand ? Math.round(cursorY + pad) : mapH;
  return {
    width,
    height,
    map: { x: 0, y: 0, w: width, h: mapH },
    band: hasBand ? { x: 0, y: mapH, w: width, h: height - mapH } : null,
    keys,
    credits,
    fonts: { key: keyFont, credit: creditFont },
  };
}

/**
 * The download filename.
 *
 * Names the place and the moment, because the alternative is a downloads
 * folder full of `map.png`, `map (1).png`, `map (2).png` and no way to tell
 * which basin any of them is. The coordinates are plain degrees rather than
 * the degrees-and-decimal-minutes the map shows a reader: a filename goes
 * through shells, ZIPs and email clients, and `45° 30.00′ N` does not.
 */
export function figureName(
  view: { lat: number; lng: number; zoom: number },
  at: string,
  scale = 1
): string {
  const deg = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(1)}${v < 0 ? neg : pos}`;
  const when = at.slice(0, 16).replace('T', ' ').replace(/[: ]/g, '-');
  /* `@2x` only when it is one, so the ordinary case keeps the plain name.
     It also stops a screen export and a print export made in the same
     minute from being the same file. */
  const at2x = scale > 1 ? `@${scale}x` : '';
  return `c4po-ocean-${deg(view.lat, 'N', 'S')}-${deg(view.lng, 'E', 'W')}-z${
    Math.round(view.zoom)
  }-${when}Z${at2x}.png`;
}
