/* Which tiles a view needs. No renderer — see geo.ts for why that matters.
 *
 * This was three copies, one each for the current, field and isobath tiers,
 * identical but for whether they returned null or an empty array — and only
 * one of the three deduplicated its keys, so a view spanning more than a full
 * turn of longitude could ask for the same tile twice. One implementation,
 * with the deduplicating behaviour, is now shared by all three.
 */

export interface TileIndex {
  /** Degrees of latitude and longitude per tile. */
  size: number;
  /** South-west origin of the lattice. */
  south: number;
  west: number;
  /** Below this the tier stands down and the coarser grid serves. */
  minZoom: number;
  /** Keys that were actually written; the rest are land or empty ocean. */
  available: string[];
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/* Overlap rather than containment, and that is measured rather than assumed:
   a zoom-7 viewport is ~9 deg across against a 20 deg tile and straddles a
   seam often enough that requiring containment kept dropping the tier back to
   the coarse grid while panning. */
export function tileKeysFor(index: TileIndex | null | undefined, zoom: number, view: BBox): string[] {
  if (!index || zoom < index.minZoom) return [];
  const { size, south: s0, west: w0 } = index;
  const floorTo = (v: number, origin: number) => Math.floor((v - origin) / size) * size + origin;
  const keys: string[] = [];
  for (let sy = floorTo(view.south, s0); sy <= view.north; sy += size) {
    for (let wx = floorTo(view.west, w0); wx <= view.east; wx += size) {
      // Longitude wraps; latitude does not. Floored modulo, because the
      // lattice starts west of the prime meridian and half the world is
      // negative.
      const wrapped = ((((wx - w0) % 360) + 360) % 360) + w0;
      const key = `${sy}_${wrapped}`;
      if (index.available.includes(key) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}
