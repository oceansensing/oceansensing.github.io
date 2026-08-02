/* Colour ramps. No renderer, no DOM — see geo.ts for why that matters.
 *
 * The ramps themselves live in map-palette.json, which scripts/test-contrast.mjs
 * measures against the sampled water colours of every basemap. Do not inline a
 * colour anywhere: the gate cannot see it.
 */

/** "#rrggbb" stops to [r, g, b] triples. */
export function rampStops(hexes: string[]): number[][] {
  return hexes.map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
}

/** Linear interpolation along a ramp, clamped at both ends. */
export function rampColour(stops: number[][], t: number, lo: number, hi: number): number[] {
  // A view of uniform water would divide by zero and paint one flat colour.
  const span = hi - lo || 1;
  const x = Math.min(1, Math.max(0, (t - lo) / span)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [
    a[0]! + (b[0]! - a[0]!) * f,
    a[1]! + (b[1]! - a[1]!) * f,
    a[2]! + (b[2]! - a[2]!) * f,
  ];
}
