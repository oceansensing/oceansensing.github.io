/**
 * Colour maths shared by the contrast gate and the ramp search.
 *
 * CIEDE2000 rather than WCAG contrast ratio or CIE76 — see the note at the
 * top of scripts/test-contrast.mjs for why: WCAG compares luminance alone and
 * would fail colours that are plainly visible by hue, and CIE76 understates
 * differences in exactly the blue region ocean backgrounds occupy.
 */

export const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`not a hex colour: ${h}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function lab([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  // sRGB D65 -> XYZ, normalised to the D65 white point
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const k = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * k(y) - 16, 500 * (k(x) - k(y)), 200 * (k(y) - k(z))];
}

/** CIEDE2000. */
export function deltaE(c1, c2) {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / rad;
    return h >= 0 ? h : h + 360;
  };
  const hp1 = hp(b1, ap1);
  const hp2 = hp(b2, ap2);

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);

  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hpb;
  if (Cp1 * Cp2 === 0) hpb = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hpb = (hp1 + hp2) / 2;
  else hpb = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hpb - 30) * rad) +
    0.24 * Math.cos(2 * hpb * rad) +
    0.32 * Math.cos((3 * hpb + 6) * rad) -
    0.2 * Math.cos((4 * hpb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt(
    (dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh)
  );
}

/** How much of a basemap's water a colour is clearly separable from. */
