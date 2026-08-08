/* Reading a ZIP archive, with no renderer and no dependency in it.
 *
 * This was inside `kmz.ts`, where it was written for one caller: a KMZ is a
 * ZIP holding a KML. A shapefile is the other archive this map now opens —
 * `.shp`, `.dbf` and `.prj` are three files and are almost always handed over
 * zipped — so the reader is shared rather than written twice.
 *
 * There is still no dependency. The central directory is a few `DataView`
 * reads and `DecompressionStream('deflate-raw')` inflates natively, so jszip
 * or fflate would buy about forty lines. That was the bargain when only KMZ
 * needed it and it is a better one now that two formats do.
 *
 * No DOM and no Leaflet, so a native port keeps it and `test:units` exercises
 * it in Node. See BOUNDARIES.md S1.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

/** The two bytes every ZIP starts with, so a caller can sniff before reading. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/* The End Of Central Directory record is at the end, after a comment of
   unknown length, so it is found by scanning backwards for its signature. */
function endOfCentralDirectory(view: DataView, length: number): number {
  for (let i = length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new ZipError('not a ZIP archive — no end-of-central-directory record');
}

export function listEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = endOfCentralDirectory(view, bytes.length);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const text = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new ZipError('corrupt ZIP central directory');
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

export async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
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
    throw new ZipError(`unsupported ZIP compression method ${entry.method}`);
  }
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw')
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- writing -----------------------------------------------------------

/* Only the reader was ever needed until shapefiles arrived, and this exists
   for one specific case: a reader who selects `stations.shp`, `stations.dbf`
   and `stations.prj` from a file picker rather than handing over a zip of
   them. Those parts have to be kept together to survive a reload, and
   `StoredOverlay` holds **one** `bytes` per record — so they are bundled into
   an archive on the way into storage and come back out through the same
   reader as a zipped shapefile would.

   The alternative was widening the stored record to hold several parts, which
   is a schema change to data already in readers' browsers, needing a
   migration, for a case this handles in forty lines.

   Stored, never deflated: these are bytes we have just read and are about to
   put in IndexedDB, so the compression would cost time to save space that a
   `.shp` full of doubles does not give up anyway. */

/* CRC-32, which a ZIP entry carries and unzip tools check. Writing a wrong
   one produces an archive that this reader accepts — it never looks — and
   that every other tool calls corrupt, which is the kind of thing that is
   discovered a long way from here. */
let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bundle named byte runs into a store-only ZIP. */
export function writeZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);

    const local = new Uint8Array(30 + name.length + file.bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.bytes.length, true);
    lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true); // stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.bytes.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const directorySize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const total = offset + directorySize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
