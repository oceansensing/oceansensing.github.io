/* Reading a KMZ, with no renderer in it.
 *
 * A KMZ is a ZIP holding a KML document and its resources. Both halves are
 * handled here without a dependency: the central directory is a few DataView
 * reads, and `DecompressionStream('deflate-raw')` inflates natively. Adding
 * jszip or fflate for this would be about 40 lines of saving.
 *
 * The XML parser is injected rather than imported, so this module has no DOM
 * dependency of its own and can be tested in Node against a real file. That
 * is also what makes it portable: a native port keeps the ZIP reading, the
 * geometry extraction and the colour conversion, and supplies its own parser.
 *
 * What it does not do is draw anything. See index.ts for that.
 */

import type { LonLat } from './schema';
import { isZip, listEntries, readEntry } from './zip.ts';
import { type VectorDocument, type VectorFeature, type VectorOverlay, type VectorStyle }
  from './vector.ts';

/* The feature model lives in `vector.ts` now, because GeoJSON and shapefiles
   produce the same shapes and a type called `Kmz*` that three formats build
   is a name that has outlived what it describes. The old names are kept as
   aliases so every existing importer — `index.ts`, the harnesses — went on
   working without being dragged into that rename. */
export type KmzStyle = VectorStyle;
export type KmzFeature = VectorFeature;
export type KmzOverlay = VectorOverlay;
export type KmzDocument = VectorDocument;
export { summarise } from './vector.ts';

export class KmzError extends Error {}

// ---- the ZIP half -----------------------------------------------------

/* The ZIP half moved to `zip.ts` when shapefiles arrived, since those are
   handed over zipped too and one reader is better than two. Nothing about it
   changed on the way out. */

// ---- colours ----------------------------------------------------------

/* KML writes colours as **aabbggrr** — alpha first and the channels reversed
   from CSS. Read naively, the sample file's opaque red `ff0000ff` comes out
   blue, which looks plausible enough to ship. */
export function kmlColour(value: string | null | undefined): { hex: string; opacity: number } | undefined {
  const raw = value?.trim();
  if (!raw || !/^[0-9a-f]{8}$/i.test(raw)) return undefined;
  const alpha = parseInt(raw.slice(0, 2), 16);
  const blue = raw.slice(2, 4);
  const green = raw.slice(4, 6);
  const red = raw.slice(6, 8);
  return { hex: `#${red}${green}${blue}`.toLowerCase(), opacity: alpha / 255 };
}

/** "lon,lat[,alt] lon,lat[,alt] …" — altitude is read and dropped. */
export function parseCoordinates(text: string | null | undefined): LonLat[] {
  if (!text) return [];
  const out: LonLat[] = [];
  for (const chunk of text.trim().split(/\s+/)) {
    const [lon, lat] = chunk.split(',');
    const x = Number(lon);
    const y = Number(lat);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) <= 90) out.push([x, y]);
  }
  return out;
}

// ---- the KML half -----------------------------------------------------

/* Not supported, and each counted rather than ignored. NetworkLink is left
   out deliberately as well as for effort: it fetches a URL chosen by the
   file, which is not something a document a reader opened should get to do. */
const UNSUPPORTED = ['NetworkLink', 'PhotoOverlay', 'ScreenOverlay', 'Model'];

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const text = (parent: Element, tag: string): string | undefined => {
  const found = parent.getElementsByTagName(tag)[0]?.textContent?.trim();
  return found || undefined;
};

/* Plain text, never markup. A KML description may carry arbitrary HTML, and a
   file from a colleague or a data portal is untrusted input even when the
   reader chose to open it — putting that in a popup is a script-injection
   vector. Markup is stripped rather than filtered: a subset allow-list is a
   thing to get subtly wrong, and these descriptions are usually prose or a
   small table whose text survives flattening. */
function describe(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const flattened = raw
    .replace(/<br\s*\/?>|<\/p>|<\/tr>|<\/div>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return flattened || undefined;
}

function styleFrom(element: Element): KmzStyle | undefined {
  const style: KmzStyle = {};
  const line = element.getElementsByTagName('LineStyle')[0];
  if (line) {
    const colour = kmlColour(text(line, 'color'));
    if (colour) {
      style.stroke = colour.hex;
      style.strokeOpacity = colour.opacity;
    }
    const width = Number(text(line, 'width'));
    if (Number.isFinite(width) && width > 0) style.strokeWidth = width;
  }
  const poly = element.getElementsByTagName('PolyStyle')[0];
  if (poly) {
    const colour = kmlColour(text(poly, 'color'));
    if (colour) {
      style.fill = colour.hex;
      style.fillOpacity = colour.opacity;
    }
    // Either can be switched off independently of the colour.
    const fill = text(poly, 'fill');
    const outline = text(poly, 'outline');
    if (fill !== undefined) style.filled = fill !== '0';
    if (outline !== undefined) style.outlined = outline !== '0';
  }
  const icon = element.getElementsByTagName('IconStyle')[0];
  if (icon && !style.stroke) {
    const colour = kmlColour(text(icon, 'color'));
    if (colour) {
      style.stroke = colour.hex;
      style.strokeOpacity = colour.opacity;
    }
  }
  return Object.keys(style).length ? style : undefined;
}

interface PendingOverlay extends Omit<KmzOverlay, 'image' | 'mediaType'> {
  href: string;
}

/** Parse a KML document. Exported so a caller holding plain KML can skip the zip. */
export function parseKml(doc: Document): KmzDocument & { pending: PendingOverlay[] } {
  const skipped: Record<string, number> = {};
  const count = (what: string) => {
    skipped[what] = (skipped[what] ?? 0) + 1;
  };

  if (doc.getElementsByTagName('parsererror').length) {
    throw new KmzError('the KML inside is not well-formed XML');
  }

  /* Shared styles, by id. StyleMap points at other styles by url; its
     "normal" pair is the one that matters, the other being the hover state. */
  const shared = new Map<string, KmzStyle>();
  for (const element of doc.getElementsByTagName('Style')) {
    const id = element.getAttribute('id');
    const style = styleFrom(element);
    if (id && style) shared.set(`#${id}`, style);
  }
  const mapped = new Map<string, string>();
  for (const element of doc.getElementsByTagName('StyleMap')) {
    const id = element.getAttribute('id');
    for (const pair of element.getElementsByTagName('Pair')) {
      if (text(pair, 'key') === 'normal') {
        const url = text(pair, 'styleUrl');
        if (id && url) mapped.set(`#${id}`, url);
      }
    }
  }

  for (const tag of UNSUPPORTED) {
    const n = doc.getElementsByTagName(tag).length;
    if (n) skipped[tag] = n;
  }

  const features: KmzFeature[] = [];
  for (const placemark of doc.getElementsByTagName('Placemark')) {
    const name = text(placemark, 'name');
    const description = describe(placemark.getElementsByTagName('description')[0]?.textContent ?? undefined);

    let folder: string | undefined;
    for (let node = placemark.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'Folder') {
        folder = node.getElementsByTagName('name')[0]?.textContent?.trim() || undefined;
        break;
      }
    }

    let style = styleFrom(placemark);
    if (!style) {
      let url = text(placemark, 'styleUrl');
      if (url && mapped.has(url)) url = mapped.get(url);
      if (url) style = shared.get(url);
    }

    const add = (kind: KmzFeature['kind'], coordinates: KmzFeature['coordinates']) => {
      const empty = Array.isArray(coordinates[0])
        ? (coordinates as LonLat[][]).every((r) => !r.length)
        : !coordinates.length;
      if (empty) return;
      features.push({ kind, coordinates, name, description, folder, style });
    };

    /* MultiGeometry needs no special case: the geometry tags are collected
       from the placemark whatever nests them, and each becomes its own
       feature carrying the placemark's name and style. */
    for (const point of placemark.getElementsByTagName('Point')) {
      add('point', parseCoordinates(text(point, 'coordinates')));
    }
    for (const line of placemark.getElementsByTagName('LineString')) {
      add('line', parseCoordinates(text(line, 'coordinates')));
    }
    for (const ring of placemark.getElementsByTagName('LinearRing')) {
      // Only rings that are not part of a Polygon; a bare LinearRing is a line.
      if (ring.parentElement?.parentElement?.tagName === 'Polygon') continue;
      add('line', parseCoordinates(text(ring, 'coordinates')));
    }
    for (const polygon of placemark.getElementsByTagName('Polygon')) {
      const rings: LonLat[][] = [];
      const outer = polygon.getElementsByTagName('outerBoundaryIs')[0];
      if (outer) rings.push(parseCoordinates(text(outer, 'coordinates')));
      for (const inner of polygon.getElementsByTagName('innerBoundaryIs')) {
        rings.push(parseCoordinates(text(inner, 'coordinates')));
      }
      add('polygon', rings.filter((r) => r.length));
    }
    if (placemark.getElementsByTagName('Track').length) count('gx:Track');
  }

  /* Descriptors only: the bytes live in the archive, which parseKml cannot
     see. readKmz resolves them; a bare .kml has no archive, so its overlays
     are counted as unreachable rather than half-drawn. */
  const pending: PendingOverlay[] = [];
  for (const element of doc.getElementsByTagName('GroundOverlay')) {
    const href = text(element.getElementsByTagName('Icon')[0] ?? element, 'href');

    const box = element.getElementsByTagName('LatLonBox')[0];
    /* Namespaced, so it has to be matched on local name: `gx:LatLonQuad` is
       invisible to getElementsByTagName('LatLonQuad'), which is why the
       branch that used to count these never once fired and every quad
       overlay was reported as a plain unreadable GroundOverlay. */
    const quad = element.getElementsByTagNameNS('*', 'LatLonQuad')[0];

    let bounds: KmzOverlay['bounds'];
    let corners: KmzOverlay['corners'];
    if (box) {
      const edge = (tag: string) => Number(text(box, tag));
      const read = {
        north: edge('north'), south: edge('south'), east: edge('east'), west: edge('west'),
      };
      if (Object.values(read).every(Number.isFinite)) bounds = read;
    } else if (quad) {
      const points = parseCoordinates(text(quad, 'coordinates'));
      // Four and only four; anything else is not a quadrilateral.
      if (points.length === 4) corners = points as [LonLat, LonLat, LonLat, LonLat];
    }

    if (!href || (!bounds && !corners)) {
      count('GroundOverlay');
      continue;
    }
    /* An absolute URL is refused for the same reason NetworkLink is: it would
       have a document the reader opened fetch from a host it names, leaking
       where they are and when. Images inside the archive are self-contained. */
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      count('overlay image hosted elsewhere');
      continue;
    }
    const colour = kmlColour(text(element, 'color'));
    pending.push({
      href: href.replace(/^\.?\//, ''),
      name: text(element, 'name'),
      bounds,
      corners,
      // A quad has no rotation of its own; its corners already carry it.
      rotation: box ? Number(text(box, 'rotation')) || 0 : 0,
      opacity: colour?.opacity ?? 1,
      drawOrder: Number(text(element, 'drawOrder')) || 0,
    });
  }

  return {
    pending,
    overlays: [],
    name: doc.getElementsByTagName('Document')[0]?.getElementsByTagName('name')[0]?.textContent?.trim()
      || doc.getElementsByTagName('name')[0]?.textContent?.trim()
      || undefined,
    features,
    skipped,
  };
}

// ---- both halves together ---------------------------------------------

/**
 * Decode a KMZ (or a bare KML) into features.
 *
 * `parseXml` is injected so this file needs no DOM: pass
 * `(s) => new DOMParser().parseFromString(s, 'application/xml')` in a browser.
 */
export async function readKmz(
  bytes: Uint8Array,
  parseXml: (xml: string) => Document
): Promise<KmzDocument> {
  if (!isZip(bytes)) {
    // A bare .kml, which readers hand over just as often as a .kmz. Its
    // overlays name images that travelled with it and are not here.
    const plain = parseKml(parseXml(new TextDecoder().decode(bytes)));
    if (plain.pending.length) plain.skipped['overlay image missing'] = plain.pending.length;
    return plain;
  }
  const entries = listEntries(bytes);
  const kml =
    entries.find((e) => e.name.toLowerCase() === 'doc.kml') ??
    entries.find((e) => e.name.toLowerCase().endsWith('.kml'));
  if (!kml) throw new KmzError('no .kml inside the archive');
  const parsed = parseKml(parseXml(new TextDecoder().decode(await readEntry(bytes, kml))));

  /* Overlay images, lifted out of the archive. Matched case-insensitively and
     without any leading "./" — a KMZ written on Windows will happily refer to
     `Files/Chart.PNG` from a KML that stores it as `files/chart.png`. */
  const used = new Set<string>();
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  for (const overlay of parsed.pending) {
    const entry = byName.get(overlay.href.toLowerCase());
    const extension = overlay.href.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = MEDIA_TYPES[extension];
    if (!entry || !mediaType) {
      // Named an image the archive does not hold, or a format no browser draws.
      parsed.skipped['overlay image missing'] = (parsed.skipped['overlay image missing'] ?? 0) + 1;
      continue;
    }
    used.add(entry.name);
    const { href, ...rest } = overlay;
    parsed.overlays.push({ ...rest, image: await readEntry(bytes, entry), mediaType });
  }
  /* Draw order is the file's to decide, and Leaflet stacks within a pane by
     insertion, so it is applied here rather than left to chance. */
  parsed.overlays.sort((a, b) => a.drawOrder - b.drawOrder);

  /* Whatever is left is a custom icon or something else the map has no use
     for. Counted rather than dropped in silence. */
  const spare = entries.filter(
    (e) => !e.name.endsWith('/') && !e.name.toLowerCase().endsWith('.kml') && !used.has(e.name)
  );
  if (spare.length) parsed.skipped['embedded resource'] = spare.length;
  return parsed;
}
