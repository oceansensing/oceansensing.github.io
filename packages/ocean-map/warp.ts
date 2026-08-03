/* Fitting a rectangular image onto an arbitrary quadrilateral.
 *
 * `gx:LatLonQuad` gives an overlay four corners rather than a north/south/
 * east/west box, so the image is not merely scaled and rotated — opposite
 * edges need not be parallel. That is a projective transform, and it is the
 * one thing an axis-aligned image overlay cannot express.
 *
 * No renderer and no DOM here, only numbers: the caller projects the four
 * corners into whatever pixel space it draws in and asks for the matrix. A
 * native port needs exactly the same homography, and can keep this.
 */

export type Pixel = [number, number];

/* The 4×4 CSS `matrix3d` is column-major, and only these eight of its sixteen
   entries carry the 2D projective transform:

     ⎡ a  b  0  c ⎤        x' = (a·x + b·y + c) / (g·x + h·y + 1)
     ⎢ d  e  0  f ⎥        y' = (d·x + e·y + f) / (g·x + h·y + 1)
     ⎢ 0  0  1  0 ⎥
     ⎣ g  h  0  1 ⎦        …written down the columns for CSS.
*/
export interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

/**
 * The transform taking the unit square to `corners`.
 *
 * Corners are given in the order the unit square's own are: (0,0), (1,0),
 * (1,1), (0,1) — top-left, top-right, bottom-right, bottom-left.
 */
export function unitSquareTo(corners: [Pixel, Pixel, Pixel, Pixel]): Homography {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;

  /* How far the quadrilateral departs from a parallelogram. If both are zero
     the mapping is affine and the projective terms drop out — which is not
     only a shortcut but a necessity, since the denominator below vanishes. */
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;

  if (dx3 === 0 && dy3 === 0) {
    return {
      a: x1 - x0, b: x2 - x1, c: x0,
      d: y1 - y0, e: y2 - y1, f: y0,
      g: 0, h: 0,
    };
  }

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const denominator = dx1 * dy2 - dy1 * dx2;
  // Degenerate: three corners collinear, or the quad collapsed to a line.
  if (denominator === 0) {
    return { a: 1, b: 0, c: x0, d: 0, e: 1, f: y0, g: 0, h: 0 };
  }

  const g = (dx3 * dy2 - dy3 * dx2) / denominator;
  const h = (dx1 * dy3 - dy1 * dx3) / denominator;
  return {
    a: x1 - x0 + g * x1,
    b: x3 - x0 + h * x3,
    c: x0,
    d: y1 - y0 + g * y1,
    e: y3 - y0 + h * y3,
    f: y0,
    g,
    h,
  };
}

/** Where the transform sends a point of the unit square. Used to check it. */
export function apply(m: Homography, x: number, y: number): Pixel {
  const w = m.g * x + m.h * y + 1;
  return [(m.a * x + m.b * y + m.c) / w, (m.d * x + m.e * y + m.f) / w];
}

/**
 * A CSS `matrix3d(…)` placing an image of `width` × `height` on `corners`.
 *
 * The element keeps its natural size and `transform-origin: 0 0`; the scale
 * by 1/width, 1/height is folded into the matrix so the unit-square transform
 * above can be reused unchanged.
 */
export function matrix3d(
  width: number,
  height: number,
  corners: [Pixel, Pixel, Pixel, Pixel]
): string {
  const m = unitSquareTo(corners);
  const w = width || 1;
  const h = height || 1;
  const values = [
    m.a / w, m.d / w, 0, m.g / w,
    m.b / h, m.e / h, 0, m.h / h,
    0, 0, 1, 0,
    m.c, m.f, 0, 1,
  ];
  // Rounded: a 17-digit float per entry is noise in a style attribute that is
  // rewritten on every pan.
  return `matrix3d(${values.map((v) => Number(v.toFixed(6))).join(', ')})`;
}
