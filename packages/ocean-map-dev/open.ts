/* One button, four formats: KMZ, KML, GeoJSON and shapefile.
 *
 * A reader should not have to tell the map what they just handed it, and the
 * extension cannot be trusted to — ERDDAP serves GeoJSON from a `.geoJson`
 * query string, portals serve shapefiles as `.zip`, and a `.json` may be
 * anything at all. So the **bytes decide** and the extension is not consulted
 * except to group a shapefile's parts, where it is the only thing that can.
 *
 * No Leaflet and no DOM — `parseXml` is injected the way `kmz.ts` takes it.
 * See BOUNDARIES.md S1.
 */

import { readGeoJson } from './geojson.ts';
import { readKmz } from './kmz.ts';
import { readShapefile } from './shapefile.ts';
import type { VectorDocument } from './vector.ts';
import { isZip, listEntries, readEntry, writeZip } from './zip.ts';

export class UnknownFormatError extends Error {}

/** A file as the reader handed it over. */
export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

const extensionOf = (name: string) => name.toLowerCase().split('.').pop() ?? '';
const baseOf = (name: string) => name.replace(/\.[^.]*$/, '');

/* The sidecars a shapefile set may bring. `.shp` and `.dbf` are the two that
   carry anything; `.prj` decides whether the numbers are degrees. The rest
   are indexes and metadata this reader has no use for, and they are dropped
   at the grouping stage rather than being mistaken for files of their own. */
const SHAPEFILE_PARTS = new Set(['shp', 'dbf', 'prj']);
const SHAPEFILE_IGNORED = new Set(['shx', 'sbn', 'sbx', 'cpg', 'qix', 'fbn', 'fbx', 'ain', 'aih', 'atx', 'xml', 'qpj']);

/**
 * Turn what the reader picked into a list of things that can be opened and
 * stored one at a time.
 *
 * Everything passes through unchanged except a loose shapefile set — three
 * files that are one layer. Those are bundled into a store-only ZIP, which
 * makes them a single `bytes` like every other format: `StoredOverlay` holds
 * one blob per record, so without this a reloaded page would come back with
 * geometry and no attributes, or nothing at all.
 *
 * A `.shp` with no `.dbf` beside it is still a layer and is passed through —
 * it draws, and `readShapefile` says the attributes are missing rather than
 * leaving a page of empty popups to explain itself.
 */
export function bundleParts(files: NamedBytes[]): NamedBytes[] {
  const sets = new Map<string, NamedBytes[]>();
  const singles: NamedBytes[] = [];

  for (const file of files) {
    const extension = extensionOf(file.name);
    if (SHAPEFILE_PARTS.has(extension)) {
      const key = baseOf(file.name);
      sets.set(key, [...(sets.get(key) ?? []), file]);
    } else if (SHAPEFILE_IGNORED.has(extension)) {
      /* Selected along with the rest — a reader picking a whole folder gets
         these too — and of no use here. Dropped quietly: they are not a
         failed import, they are not part of the layer, and reporting them
         would be noise on every single shapefile. */
    } else {
      singles.push(file);
    }
  }

  const bundled: NamedBytes[] = [];
  for (const [base, parts] of sets) {
    const shp = parts.find((p) => extensionOf(p.name) === 'shp');
    if (!shp) {
      /* A `.dbf` or `.prj` on its own. Named rather than ignored, because the
         reader believes they have just added a layer. */
      throw new UnknownFormatError(
        `${parts.map((p) => p.name).join(' and ')} — a shapefile needs its .shp too`
      );
    }
    if (parts.length === 1) {
      bundled.push(shp);
      continue;
    }
    bundled.push({ name: `${base}.zip`, bytes: writeZip(parts) });
  }
  return [...bundled, ...singles];
}

/* Inside an archive: a KMZ holds a `.kml`, a zipped shapefile holds a `.shp`.
   Both are ordinary ZIPs, so which one it is comes from what is in it. */
async function openZip(
  bytes: Uint8Array,
  name: string,
  parseXml: (xml: string) => Document
): Promise<VectorDocument> {
  const entries = listEntries(bytes);
  const find = (extension: string) =>
    entries.find((e) => e.name.toLowerCase().endsWith(`.${extension}`));

  if (find('kml')) return readKmz(bytes, parseXml);

  const shp = find('shp');
  if (shp) {
    /* Matched on the `.shp`'s own base name so an archive holding several
       layers takes the first rather than pairing one layer's geometry with
       another's attributes — which would draw, and be wrong. */
    const base = baseOf(shp.name).toLowerCase();
    const sibling = async (extension: string) => {
      const entry = entries.find((e) => e.name.toLowerCase() === `${base}.${extension}`);
      return entry ? readEntry(bytes, entry) : undefined;
    };
    const dbf = await sibling('dbf');
    const prjBytes = await sibling('prj');
    const others = entries.filter(
      (e) => e.name.toLowerCase().endsWith('.shp') && e.name.toLowerCase() !== shp.name.toLowerCase()
    );
    const doc = readShapefile({
      shp: await readEntry(bytes, shp),
      dbf,
      prj: prjBytes ? new TextDecoder().decode(prjBytes) : undefined,
      name: baseOf(shp.name.split('/').pop() ?? name),
    });
    if (others.length) {
      doc.notes = [
        ...(doc.notes ?? []),
        `${others.length} more layer${others.length === 1 ? '' : 's'} in the archive not opened`,
      ];
    }
    return doc;
  }

  throw new UnknownFormatError(
    `${name} is a ZIP with no .kml and no .shp in it — ` +
      `it holds ${entries.length} file${entries.length === 1 ? '' : 's'}`
  );
}

/**
 * Open one file, whatever it is.
 *
 * The sniffing order is by how certain each test is: a magic number first, a
 * structural character last.
 */
export async function openVector(
  bytes: Uint8Array,
  name: string,
  parseXml: (xml: string) => Document
): Promise<VectorDocument> {
  if (!bytes.length) throw new UnknownFormatError(`${name} is empty`);

  if (isZip(bytes)) return openZip(bytes, name, parseXml);

  /* A bare `.shp`, identified by its own file code rather than its name — the
     one format here with a magic number of its own. */
  if (bytes.length >= 100) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getInt32(0, false) === 9994) {
      return readShapefile({ shp: bytes, name: baseOf(name) });
    }
  }

  /* Text from here. Only the first bytes are decoded: these files run to
     megabytes and the question is settled by the first non-space character. */
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();

  if (head.startsWith('{') || head.startsWith('[')) return readGeoJson(bytes, name);

  /* KML, or an XML document claiming to be something else. `readKmz` handles
     bare KML, and its own parser will say so if this is not KML at all. */
  if (head.startsWith('<')) return readKmz(bytes, parseXml);

  throw new UnknownFormatError(
    `${name} is not a format this map reads — it takes KML, KMZ, GeoJSON and shapefiles`
  );
}

// ---- from a link -------------------------------------------------------

export class FetchRefused extends Error {}

/* A ceiling, because a URL says nothing about what is behind it. A file the
   reader picked, they can see the size of; a link they pasted may be a
   gigabyte of GeoJSON that locks the tab up while it parses. 64 MB is well
   past anything this map is likely to be pointed at — the biggest thing it
   fetches for itself is a 4.2 MB coastline — and far short of hanging a
   phone. */
const MAX_BYTES = 64 * 1024 * 1024;
/* Reported in the same unit it is measured in. Dividing a MiB ceiling by 1e6
   printed "past the 67.108864 MB limit", which is neither the number in the
   source nor a number anybody would write. */
const asMB = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** A name for the layer, from the URL's own last path segment. */
function nameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop();
  /* ERDDAP puts the format in the path and the query does the work, so
     `pmelTaoDyAirt.geoJson` is a better name than the host — but a bare
     directory URL has nothing useful, and the host is what a reader would
     recognise. */
  return last && /\./.test(last) ? decodeURIComponent(last) : url.hostname;
}

/**
 * Open a file the reader linked to rather than picked.
 *
 * **A URL the reader typed is not a URL a file chose**, and that distinction
 * is the whole reason this is allowed while KML's `NetworkLink` is still
 * refused. `NetworkLink` has a document fetch a host *it* names, which leaks
 * where the reader is and when, to somebody the reader never agreed to talk
 * to. This is the reader asking for a specific thing.
 *
 * **The failure is deliberately vague, and the message has to be too.** A
 * browser reports a blocked cross-origin fetch as an opaque `TypeError` with
 * no reason attached — by design, so a page cannot use fetch failures to probe
 * a private network. So this cannot tell "the host forbids browsers" from
 * "the host is down" from "you are offline", and it must not pretend to.
 * Measured: `gliders.ioos.us` sends `access-control-allow-origin: *` and works;
 * `data.pmel.noaa.gov` and `erddap.ifremer.fr` send nothing and cannot be read
 * from a browser at all, whatever the map does.
 *
 * `fetchImpl` is injected the way `parseXml` is, so this stays testable with
 * no network. See BOUNDARIES.md S1 — and note this is deliberately *not*
 * routed through `dataBase` (S3), which governs the map's own data. This is
 * the reader's.
 */
export async function fetchVector(
  href: string,
  parseXml: (xml: string) => Document,
  fetchImpl: typeof fetch = fetch
): Promise<{ doc: VectorDocument; bytes: Uint8Array; name: string }> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new FetchRefused(`${href} is not a URL`);
  }
  /* http(s) only. `file:` would read the reader's own disk through a path
     they typed, and the file picker is the right way to do that; the rest —
     `data:`, `blob:`, `javascript:` — have no business here. */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefused(`${url.protocol} links are not fetched — use http or https`);
  }

  let response: Response;
  try {
    response = await fetchImpl(url.href, { mode: 'cors', redirect: 'follow' });
  } catch {
    throw new FetchRefused(
      `${url.hostname} could not be read from the browser. It may not allow it ` +
        `(many data servers do not send CORS headers), or it may be unreachable — ` +
        `the browser does not say which. Downloading the file and adding it works either way`
    );
  }
  if (!response.ok) {
    throw new FetchRefused(`${url.hostname} answered ${response.status} ${response.statusText}`);
  }

  /* Checked before reading where the server declares it, and again after,
     since `content-length` is optional and a chunked response has none. */
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new FetchRefused(
      `that link is ${asMB(declared)} MB, past the ${asMB(MAX_BYTES)} MB limit`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    throw new FetchRefused(
      `that link returned ${asMB(bytes.byteLength)} MB, past the ${asMB(MAX_BYTES)} MB limit`
    );
  }

  const name = nameFromUrl(url);
  return { doc: await openVector(bytes, name, parseXml), bytes, name };
}
