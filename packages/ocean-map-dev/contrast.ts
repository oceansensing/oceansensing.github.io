/* Perceptual colour distance, and choosing a particle ramp with it — at
   runtime, in the browser.

   **Sandbox only.** Production picks its two ramps once, offline, and
   `scripts/test-contrast.mjs` verifies them; that is why every colour on the
   published map has been checked against every background it can appear over.
   Choosing at runtime gives up exactly that guarantee, which is the thing
   being tested here and the reason this lives in `ocean-map-dev`.

   No Leaflet and no DOM, so it stays testable in Node and portable — the same
   rule the production package's renderer-independent half follows.

   The maths is CIEDE2000, matching `scripts/lib/colour.mjs` so a runtime
   answer and a gate answer are comparable. WCAG contrast ratio is the obvious
   substitute and is wrong here: it compares luminance only, and would call the
   storm red and the glider magenta identical. CIE76 is the other easy one and
   understates differences in exactly the blue region ocean basemaps occupy. */

export type Rgb = [number, number, number];

export function hex(value: string): Rgb {
  const h = value.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function lab([r, g, b]: Rgb): [number, number, number] {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}

/** CIEDE2000. */
export function deltaE(c1: Rgb, c2: Rgb): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const h = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const angle = (Math.atan2(y, x) * 180) / Math.PI;
    return angle >= 0 ? angle : angle + 360;
  };
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  let dhp = h2p - h1p;
  if (Math.abs(dhp) > 180) dhp -= Math.sign(dhp) * 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  let avgHp = h1p + h2p;
  if (C1p * C2p !== 0) avgHp = Math.abs(h1p - h2p) > 180 ? (avgHp + 360) / 2 : avgHp / 2;
  const T =
    1 -
    0.17 * Math.cos(((avgHp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * avgHp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);
  const Sl = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const Rt =
    -2 *
    Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7)) *
    Math.sin((60 * Math.exp(-(((avgHp - 275) / 25) ** 2)) * Math.PI) / 180);
  return Math.sqrt(
    ((L2 - L1) / Sl) ** 2 +
      ((C2p - C1p) / Sc) ** 2 +
      (dHp / Sh) ** 2 +
      Rt * ((C2p - C1p) / Sc) * (dHp / Sh)
  );
}

/* Building a ramp ------------------------------------------------------- */

/** Lab back to sRGB, clipped to gamut. */
function toHex(L: number, a: number, b: number): string {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [X, Y, Z] = [0.95047 * f(fx), 1.0 * f(fy), 1.08883 * f(fz)];
  const g = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return (
    '#' +
    [
      g(X * 3.2406 + Y * -1.5372 + Z * -0.4986),
      g(X * -0.9689 + Y * 1.8758 + Z * 0.0415),
      g(X * 0.0557 + Y * -0.204 + Z * 1.057),
    ]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Five stops along a line of constant hue and chroma, dark to light — the
    shape both production ramps have. */
export function rampAt(hue: number, chroma: number, L0: number, L1: number): string[] {
  const r = (hue * Math.PI) / 180;
  return [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const L = L0 + (L1 - L0) * t;
    return toHex(L, chroma * Math.cos(r), chroma * Math.sin(r));
  });
}

/** How far a ramp stays from a set of colours, at its closest approach. */
export function clearance(ramp: string[], against: string[]): number {
  if (!against.length) return Infinity;
  let worst = Infinity;
  for (const a of against) {
    const c = hex(a);
    for (const s of ramp) worst = Math.min(worst, deltaE(hex(s), c));
  }
  return worst;
}

/* The candidate set is built once. Scoring it is the per-change cost, and it
   is linear in candidates x backgrounds — a few milliseconds, which is why
   this runs on a layer or colormap change and never inside a frame.

   It covers the lightness axis at every chroma rather than pairing pale with
   low chroma and dark with high, which the first version did. That shortcut
   left the tight balls around named colours empty — asking for a deep blue
   found no candidate at all, because deep blue is high chroma at low
   lightness and only three of the six profiles were dark. */
const CANDIDATES: { hue: number; ramp: string[] }[] = [];
for (let hue = 0; hue < 360; hue += 6) {
  for (const chroma of [20, 40, 60, 80, 100]) {
    for (const L0 of [24, 36, 48, 60, 72, 84]) {
      CANDIDATES.push({ hue, ramp: rampAt(hue, chroma, L0, L0 + 8) });
    }
  }
}

export interface RampChoice {
  ramp: string[];
  /** Closest approach to the background it was chosen against. */
  clearance: number;
  /** Closest approach to whatever it had to stay clear of besides. */
  apart: number;
  hue: number;
}

/** Pick a ramp that stays as far as possible from `background`, while also
    keeping `apartFrom` (the other particle field, and the markers) at arm's
    length.

    `like` is an exemplar colour restricting the search to ramps that read as
    that colour — the reader saying "I want it purple" and getting the purple
    that works, rather than a free picker that lets them choose one that does
    not. `null` searches everything.

    **It is an exemplar rather than a hue angle, and that is the second
    correction this function needed.** Restricting by hue was tried first and
    the labels lied twice over. The angles were guessed rather than measured,
    so "Blue 260" was cyan's angle and "Red 25" was orange's. Measuring them
    fixed half of it and exposed the rest: hue does not name a colour on its
    own. Pure blue and pale pink sit within 12 degrees of each other in Lab —
    *lightness* is what separates them — so a hue-banded search asked for blue
    over a blue background quite reasonably returned `#ffb0ff`, the pale end of
    that band being what clears the water best. Filtering on distance to an
    exemplar constrains both axes at once, in the same metric everything else
    here speaks. */
export function pickRamp(
  background: string[],
  apartFrom: string[],
  like: string | null,
  likeness = 18
): RampChoice {
  const target = like === null ? null : hex(like);
  let best: RampChoice | null = null;
  for (const c of CANDIDATES) {
    // Judged on the middle stop: a ramp spans only 8 of lightness, so its
    // midpoint is what the eye takes the whole field to be.
    if (target && deltaE(hex(c.ramp[2]), target) > likeness) continue;
    const bg = clearance(c.ramp, background);
    const apart = clearance(c.ramp, apartFrom);
    // The background is what a particle owes most — it is everywhere and
    // there is nothing behind it. Rank on that, with the rest as a floor.
    const score = Math.min(bg, apart * 1.5);
    if (!best || score > Math.min(best.clearance, best.apart * 1.5)) {
      best = { ramp: c.ramp, clearance: bg, apart, hue: c.hue };
    }
  }
  // Only if the likeness bar was so tight that nothing matched.
  return best ?? { ramp: rampAt(30, 40, 78, 86), clearance: 0, apart: 0, hue: 30 };
}
