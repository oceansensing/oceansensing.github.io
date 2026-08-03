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

/** What a placemark's own style asks for, already converted from KML's forms. */
export interface KmzStyle {
  /** `#rrggbb`, from KML's `aabbggrr`. */
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  fill?: string;
  fillOpacity?: number;
  /** PolyStyle can switch either off independently. */
  filled?: boolean;
  outlined?: boolean;
}

export interface KmzFeature {
  kind: 'point' | 'line' | 'polygon';
  /** A point is one position; a line is a path; a polygon is rings, outer first. */
  coordinates: LonLat[] | LonLat[][];
  name?: string;
  /** Plain text. KML descriptions carry arbitrary HTML and this deliberately
      does not pass it through — see `describe()`. */
  description?: string;
  /** The enclosing Folder, if any, so the map can group by it. */
  folder?: string;
  style?: KmzStyle;
}

export interface KmzDocument {
  name?: string;
  features: KmzFeature[];
  /** What was present and not drawn, counted by kind. A partial render that
      says nothing is the failure mode this project keeps meeting; this is what
      lets the map report "drew 412, skipped 3 NetworkLinks" instead. */
  skipped: Record<string, number>;
}

export class KmzError extends Error {}

// ---- the ZIP half -----------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

/* The End Of Central Directory record is at the end, after a comment of
   unknown length, so it is found by scanning backwards for its signature. */
function endOfCentralDirectory(view: DataView, length: number): number {
  for (let i = length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new KmzError('not a ZIP archive — no end-of-central-directory record');
}

function listEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = endOfCentralDirectory(view, bytes.length);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const text = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new KmzError('corrupt ZIP central directory');
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: text.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function read(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /* The local header repeats the name and extra fields, and its extra field
     length may differ from the central directory's — so it has to be read
     here rather than reused. */
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return body;
  if (entry.method !== 8) {
    throw new KmzError(`unsupported ZIP compression method ${entry.method}`);
  }
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw')
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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
const UNSUPPORTED = ['NetworkLink', 'GroundOverlay', 'PhotoOverlay', 'ScreenOverlay', 'Model'];

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

/** Parse a KML document. Exported so a caller holding plain KML can skip the zip. */
export function parseKml(doc: Document): KmzDocument {
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

  return {
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
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zipped) {
    // A bare .kml, which readers hand over just as often as a .kmz.
    return parseKml(parseXml(new TextDecoder().decode(bytes)));
  }
  const entries = listEntries(bytes);
  const kml =
    entries.find((e) => e.name.toLowerCase() === 'doc.kml') ??
    entries.find((e) => e.name.toLowerCase().endsWith('.kml'));
  if (!kml) throw new KmzError('no .kml inside the archive');
  const parsed = parseKml(parseXml(new TextDecoder().decode(await read(bytes, kml))));

  /* Resources are listed rather than loaded. Custom icons and overlay images
     would each need extracting to a blob URL and revoking again; until the
     map draws them, saying how many were passed over is more honest than
     silently dropping them. */
  const resources = entries.filter((e) => !e.name.toLowerCase().endsWith('.kml') && !e.name.endsWith('/'));
  if (resources.length) parsed.skipped['embedded resource'] = resources.length;
  return parsed;
}

/** "412 features · skipped 3 NetworkLinks" — for the map to show. */
export function summarise(doc: KmzDocument): string {
  const parts = [`${doc.features.length} feature${doc.features.length === 1 ? '' : 's'}`];
  for (const [what, n] of Object.entries(doc.skipped)) {
    parts.push(`skipped ${n} ${what}${n === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
