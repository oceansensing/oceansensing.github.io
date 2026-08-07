/**
 * Marching squares, for the density contours on a T-S diagram.
 *
 * The T-S diagram is the figure physical oceanography is drawn in, and what
 * makes it readable is the family of curved density contours behind the
 * points: two samples on the same line weigh the same however different they
 * look. Those lines have no closed form -- density is a polynomial in the
 * wrong variables -- so they are traced.
 *
 * Renderer-independent, like everything else here: it returns line segments
 * in the caller's own coordinates and knows nothing about pixels, SVG or
 * canvas. A native port keeps it.
 *
 * There was a marching-squares module in this repository before, cut when the
 * sea-ice edge it served was removed. This is not that one brought back: it
 * traces many levels over a small grid rather than one level over a large
 * one, which is the opposite trade, and it runs in the browser rather than in
 * a pipeline.
 */

/** One traced segment, in the same units as the grid's axes. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The grid a contour is traced through. `v[j][i]` is the value at (i, j). */
export interface Field {
  v: number[][];
  /** Value of x at column 0, and the spacing between columns. */
  x0: number;
  dx: number;
  /** Value of y at row 0, and the spacing between rows. */
  y0: number;
  dy: number;
}

/** Where a level crosses the edge between two corner values. */
const cross = (a: number, b: number, level: number): number => {
  const d = b - a;
  /* An exactly flat edge would put the crossing anywhere; the midpoint is the
     only answer that does not depend on which corner is named first. */
  return Math.abs(d) < 1e-30 ? 0.5 : (level - a) / d;
};

/**
 * Every segment of one contour level.
 *
 * Standard marching squares over the sixteen corner patterns. The two saddle
 * cases -- where opposite corners are above the level and the other two below
 * -- are genuinely ambiguous, and are resolved by the cell's own mean, which
 * is the usual choice and the one that keeps a ridge connected rather than
 * pinching it into two hooks.
 *
 * Cells with a non-finite corner are skipped rather than guessed at. On a T-S
 * diagram that is the region below the freezing point and above the
 * standard's range, where there is no seawater to draw a line through.
 */
export function contour(field: Field, level: number): Segment[] {
  const { v, x0, dx, y0, dy } = field;
  const out: Segment[] = [];
  const rows = v.length;
  if (rows < 2) return out;
  const cols = v[0].length;

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      // Corners, anticlockwise from the bottom left.
      const bl = v[j][i];
      const br = v[j][i + 1];
      const tr = v[j + 1][i + 1];
      const tl = v[j + 1][i];
      if (!Number.isFinite(bl) || !Number.isFinite(br)
        || !Number.isFinite(tr) || !Number.isFinite(tl)) continue;

      let code = 0;
      if (bl >= level) code |= 1;
      if (br >= level) code |= 2;
      if (tr >= level) code |= 4;
      if (tl >= level) code |= 8;
      if (code === 0 || code === 15) continue;

      const xa = x0 + i * dx;
      const ya = y0 + j * dy;

      // Crossing points on each of the four edges, computed lazily.
      const bottom = () => ({ x: xa + cross(bl, br, level) * dx, y: ya });
      const right = () => ({ x: xa + dx, y: ya + cross(br, tr, level) * dy });
      const top = () => ({ x: xa + cross(tl, tr, level) * dx, y: ya + dy });
      const left = () => ({ x: xa, y: ya + cross(bl, tl, level) * dy });

      const push = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      };

      switch (code) {
        case 1: case 14: push(left(), bottom()); break;
        case 2: case 13: push(bottom(), right()); break;
        case 3: case 12: push(left(), right()); break;
        case 4: case 11: push(right(), top()); break;
        case 6: case 9: push(bottom(), top()); break;
        case 7: case 8: push(left(), top()); break;
        case 5: case 10: {
          const mean = (bl + br + tr + tl) / 4;
          const joined = code === 5 ? mean >= level : mean < level;
          if (joined) {
            push(left(), top());
            push(bottom(), right());
          } else {
            push(left(), bottom());
            push(right(), top());
          }
          break;
        }
      }
    }
  }
  return out;
}

/**
 * A ladder of round contour levels spanning a range.
 *
 * `steps` is the ladder to choose from, finest first; the coarsest that keeps
 * the count at or under `most` wins. Fixing the step instead gives three
 * lines on one view and eighty on another, which is the same failure the
 * map's graticule has a note about.
 */
export function levels(
  lo: number, hi: number, most = 12,
  steps: number[] = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20]
): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const step = steps.find((s) => (hi - lo) / s <= most) ?? steps[steps.length - 1];
  const out: number[] = [];
  const first = Math.ceil(lo / step) * step;
  for (let x = first; x <= hi + step * 1e-9; x += step) {
    // Snap to the step, or 0.1 + 0.2 shows up in a label as 0.30000000000000004.
    out.push(Math.round(x / step) * step);
  }
  return out;
}
