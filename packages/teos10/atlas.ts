/**
 * TEOS-10: the Absolute Salinity Anomaly atlas.
 *
 * The one part of this package that needs the network, and the one part that
 * is not computable: the anomaly was *measured* across the world ocean and
 * published as a lookup table. Everything else here is a standard you can
 * evaluate from first principles; this is a map of what the salt is actually
 * made of, which varies because rivers, biology and the deep circulation put
 * different things in different oceans.
 *
 * It reaches 0.03 g/kg in the North Pacific, where silicate and alkalinity
 * accumulate along the deep flow path. That is about 0.024 kg/m^3 of density
 * — thirty times the precision anyone quotes it to, and invisible unless you
 * apply it.
 *
 * **Fetched, not bundled, and only when a position is given.** 188 KB
 * gzipped, so a reader who never enters a latitude never pays for it. That is
 * the same bargain the map strikes with its coastline and its isobaths.
 *
 * The file is built by `scripts/make-saar-atlas.py`, which verifies its own
 * extraction against the GSW reference implementation before writing.
 */

/** Where the atlas lives, relative to the site root. */
export const ATLAS_URL = '/teos10/saar.bin.gz';

/** GSW writes "no value" as 9e90 and tests for it at this threshold. */
const SENTINEL = 1e10;
const NO_DATA = -32768;

/* The barrier through Central America and the Isthmus of Panama. Two lattice
   cells either side of it are different oceans, and interpolating across it
   would carry Caribbean water into the Pacific. GSW carries the same six
   points; they define a polyline, and a corner on the far side of it from the
   query is replaced by the mean of the corners on the near side. */
const LONGS_PAN = [260.0, 272.59, 276.5, 278.65, 280.73, 292.0];
const LATS_PAN = [19.55, 13.97, 9.6, 8.1, 9.33, 3.4];

/* The four corners of a lattice cell, anticlockwise from the southwest. */
const DELI = [0, 1, 1, 0];
const DELJ = [0, 0, 1, 1];

export interface AtlasData {
  nx: number;
  ny: number;
  nz: number;
  longs: Float64Array;
  lats: Float64Array;
  pRef: Float64Array;
  /** Number of valid levels in each water column; 255 where there is none. */
  ndepth: Uint8Array;
  /** The anomaly ratio, quantised. Indexed `iz + nz * (iy + ny * ix)`. */
  saar: Int16Array;
  quantum: number;
}

/**
 * The Absolute Salinity Anomaly Ratio at a position.
 *
 * The algorithm is GSW's, and deliberately so — the atlas is only as good as
 * the interpolation it was designed for. Resampling it onto its own lattice
 * and interpolating naively was measured at 0.07 g/kg of error, which is
 * larger than the anomaly it is trying to represent.
 */
export class SalinityAtlas {
  /* Written out rather than as a parameter property: Node strips types
     without compiling them, and a parameter property is the one TypeScript
     construct that is not merely annotation. `test:teos10` imports this file
     directly, so it has to survive that. */
  readonly d: AtlasData;

  constructor(data: AtlasData) {
    this.d = data;
  }

  /** SAAR at sea pressure `p` (dbar), or NaN where the atlas has no answer. */
  saar(p: number, lon: number, lat: number): number {
    const d = this.d;
    if (!Number.isFinite(p) || !Number.isFinite(lon) || !Number.isFinite(lat)) return NaN;
    if (lat < -86.0 || lat > 90.0) return NaN;

    let x = lon % 360.0;
    if (x < 0.0) x += 360.0;

    const dLong = d.longs[1] - d.longs[0];
    const dLat = d.lats[1] - d.lats[0];

    let ix = Math.floor((d.nx - 1) * (x - d.longs[0]) / (d.longs[d.nx - 1] - d.longs[0]));
    if (ix > d.nx - 2) ix = d.nx - 2;
    let iy = Math.floor((d.ny - 1) * (lat - d.lats[0]) / (d.lats[d.ny - 1] - d.lats[0]));
    if (iy > d.ny - 2) iy = d.ny - 2;

    /* How deep the deepest of the four surrounding columns goes. Asking below
       that is asking about rock, so the query is pulled up to the deepest
       level that has water in it — which is why a point under the seafloor
       still gets an answer rather than a hole in the map. */
    let deepest = -Infinity;
    for (let k = 0; k < 4; k++) {
      const nd = d.ndepth[iy + DELJ[k] + (ix + DELI[k]) * d.ny];
      if (nd > 0 && nd !== 255) deepest = Math.max(deepest, nd);
    }
    /* Four dry corners means land: the anomaly is zero rather than unknown,
       which matters because an estuary sample still wants an SA. */
    if (deepest === -Infinity) return 0.0;

    const pq = Math.min(p, d.pRef[deepest - 1]);
    const iz = bracket(d.pRef, pq);

    const r1 = (x - d.longs[ix]) / (d.longs[ix + 1] - d.longs[ix]);
    const s1 = (lat - d.lats[iy]) / (d.lats[iy + 1] - d.lats[iy]);
    const t1 = (pq - d.pRef[iz]) / (d.pRef[iz + 1] - d.pRef[iz]);

    const inPanama = LONGS_PAN[0] <= x && x <= LONGS_PAN[LONGS_PAN.length - 1]
      && LATS_PAN[LATS_PAN.length - 1] <= lat && lat <= LATS_PAN[0];

    const layer = (dz: number): number => {
      const v = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const raw = d.saar[iz + dz + d.nz * (iy + DELJ[k] + (ix + DELI[k]) * d.ny)];
        v[k] = raw === NO_DATA ? 9e90 : raw * d.quantum;
      }
      if (inPanama) addBarrier(v, x, lat, d.longs[ix], d.lats[iy], dLong, dLat);
      else if (Math.abs(v[0] + v[1] + v[2] + v[3]) >= SENTINEL) addMean(v);
      return (1.0 - s1) * (v[0] + r1 * (v[1] - v[0])) + s1 * (v[3] + r1 * (v[2] - v[3]));
    };

    const upper = layer(0);
    let lower = layer(1);
    /* A cell whose lower level is dry keeps the value above it rather than
       interpolating towards nothing — the water does not get fresher because
       the grid ran out. */
    if (Math.abs(lower) >= SENTINEL) lower = upper;

    const out = upper + t1 * (lower - upper);
    return Math.abs(out) >= SENTINEL ? NaN : out;
  }
}

/** `x[k] <= z < x[k+1]`, clamped so the caller always gets a usable pair. */
function bracket(x: Float64Array | number[], z: number): number {
  const n = x.length;
  if (z <= x[0]) return 0;
  if (z >= x[n - 1]) return n - 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (z >= x[mid]) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Replace missing corners with the mean of the ones that are there. */
function addMean(v: number[]): void {
  let sum = 0;
  let n = 0;
  for (const x of v) if (Math.abs(x) <= 100.0) { sum += x; n++; }
  const mean = n ? sum / n : 0.0;
  for (let k = 0; k < 4; k++) if (Math.abs(v[k]) >= SENTINEL) v[k] = mean;
}

/** The same, but a corner across the Panama line also counts as missing. */
function addBarrier(
  v: number[], lon: number, lat: number,
  longGrid: number, latGrid: number, dLong: number, dLat: number
): void {
  const panLat = (at: number): number => {
    const k = bracket(LONGS_PAN, at);
    const r = (at - LONGS_PAN[k]) / (LONGS_PAN[k + 1] - LONGS_PAN[k]);
    return LATS_PAN[k] + r * (LATS_PAN[k + 1] - LATS_PAN[k]);
  };

  const above0 = panLat(lon) <= lat;
  const west = panLat(longGrid);
  const east = panLat(longGrid + dLong);
  const above = [
    west <= latGrid, east <= latGrid,
    east <= latGrid + dLat, west <= latGrid + dLat,
  ];

  let sum = 0;
  let n = 0;
  for (let k = 0; k < 4; k++) {
    if (Math.abs(v[k]) <= 100.0 && above0 === above[k]) { sum += v[k]; n++; }
  }
  const mean = n ? sum / n : 0.0;
  for (let k = 0; k < 4; k++) {
    if (Math.abs(v[k]) >= SENTINEL || above0 !== above[k]) v[k] = mean;
  }
}

/**
 * Read the packed atlas.
 *
 * Every dimension and both axes are in the file rather than assumed here, so
 * a rebuilt atlas with a different lattice cannot be silently misread — which
 * is the one failure mode a binary format invites and the reason the header
 * costs 1.4 KB.
 */
export function decodeAtlas(buffer: ArrayBuffer): SalinityAtlas {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SAAR') throw new Error('not a salinity atlas');
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`atlas version ${version} is not supported`);

  const nx = view.getUint16(6, true);
  const ny = view.getUint16(8, true);
  const nz = view.getUint16(10, true);
  const quantum = view.getFloat64(16, true);

  let at = 24;
  const longs = new Float64Array(buffer.slice(at, at + nx * 8));
  at += nx * 8;
  const lats = new Float64Array(buffer.slice(at, at + ny * 8));
  at += ny * 8;
  const pRef = new Float64Array(buffer.slice(at, at + nz * 8));
  at += nz * 8;
  const ndepth = new Uint8Array(buffer.slice(at, at + ny * nx));
  at += ny * nx;
  at += at % 2;
  const saar = new Int16Array(buffer.slice(at, at + nz * ny * nx * 2));

  return new SalinityAtlas({ nx, ny, nz, longs, lats, pRef, ndepth, saar, quantum });
}

/**
 * Fetch and decode the atlas.
 *
 * **The gzip is undone here rather than by the browser**, because a static
 * host does not compress an unknown binary type — measured on this one, PNG
 * comes back uncompressed while SVG does not — so the file is stored already
 * compressed and inflated with `DecompressionStream`, the same mechanism the
 * map uses to read a KMZ.
 *
 * A host that *does* decompress it transparently would then hand us plain
 * bytes, so the gzip magic is sniffed rather than assumed. Two bytes of
 * checking removes a whole class of "works here, not there".
 */
export async function loadAtlas(url: string = ATLAS_URL): Promise<SalinityAtlas> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`atlas: ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return decodeAtlas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
