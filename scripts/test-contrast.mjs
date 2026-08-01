#!/usr/bin/env node
/**
 * Checks every map feature colour against the ocean colours of every basemap.
 *
 *   npm run test:contrast
 *
 * The map offers two bathymetries with opposite tone — Esri Ocean is light
 * (ocean luminance around 0.33) and GEBCO is dark (around 0.10) — so a colour
 * that reads well on one can vanish on the other. That is exactly what
 * happened to the first pass at the current particles. This gate makes the
 * regression impossible to land quietly.
 *
 * Distance is CIEDE2000 rather than WCAG contrast ratio. WCAG compares
 * luminance only, which would fail the storm red and the glider magenta on
 * both basemaps even though both are plainly visible — their separation is
 * hue, not lightness. CIE76 is the easy alternative but is known to
 * understate differences in exactly the blue region every one of these
 * backgrounds occupies, so it would wave through colours that disappear.
 *
 * Palettes come from src/data/basemap-ocean.json, sampled offline by
 * scripts/sample-basemaps.py, so this needs no network.
 */
import fs from 'node:fs';

const palette = JSON.parse(fs.readFileSync('src/data/map-palette.json', 'utf8'));
const basemaps = JSON.parse(fs.readFileSync('src/data/basemap-ocean.json', 'utf8')).basemaps;

/* Fail with something readable if the palette is the wrong shape — an older
   sampler emitted bare colour strings instead of {colour, share} pairs, and
   without this the first thing anyone sees is a TypeError deep in a colour
   conversion. */
for (const [name, info] of Object.entries(basemaps)) {
  const bad = !Array.isArray(info?.ocean) || info.ocean.some((o) => typeof o?.colour !== 'string' || typeof o?.share !== 'number');
  if (bad) {
    console.error(
      `FAIL  ${name}: basemap-ocean.json is not in the expected {colour, share} form.` +
        '\n      Regenerate it with: npm run data:basemaps'
    );
    process.exit(1);
  }
}

/* Separation a feature needs from the water behind it, and how much of that
   water it has to clear. Calibrated against colours already known to read
   well on both maps — the storm red, USV orange and glider magenta all clear
   every water tone on both basemaps.

   Coverage rather than worst case, because worst case lets one uncommon tone
   veto a colour that is obvious everywhere else: GEBCO renders shallow banks
   a pale mint that is under a tenth of its water, and judging white against
   only that would reject it despite it being unmissable over the deep navy
   that covers most of the map. */
const MIN_DELTA_E = 22;
const MIN_COVERAGE = 0.9;

const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`not a hex colour: ${h}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function lab([r, g, b]) {
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
function deltaE(c1, c2) {
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
function against(colour, oceans) {
  let covered = 0;
  let total = 0;
  let worst = Infinity;
  for (const { colour: water, share } of oceans) {
    const d = deltaE(hex(colour), hex(water));
    total += share;
    if (d >= MIN_DELTA_E) covered += share;
    worst = Math.min(worst, d);
  }
  return { coverage: total ? covered / total : 0, worst };
}

const results = [];

// Point and line features are drawn whichever basemap is showing, so they
// have to survive all of them.
for (const [name, colour] of Object.entries(palette.features)) {
  for (const [mapName, info] of Object.entries(basemaps)) {
    results.push({
      what: `${name} (${colour})`,
      on: mapName,
      ...against(colour, info.ocean),
    });
  }
}

/* One particle ramp for every basemap — so, like the markers, every step of
   it has to survive all of them. */
palette.currents.forEach((colour, i) => {
  for (const [mapName, info] of Object.entries(basemaps)) {
    results.push({ what: `currents[${i}] (${colour})`, on: mapName, ...against(colour, info.ocean) });
  }
});

/* Particles must not read as assets. They are thin moving lines and the
   markers are filled dots, but keeping them apart in colour too means a
   glance is never ambiguous. */
for (const [i, colour] of palette.currents.entries()) {
  for (const [name, feature] of Object.entries(palette.features)) {
    const d = deltaE(hex(colour), hex(feature));
    results.push({
      what: `currents[${i}] vs ${name}`,
      on: 'feature separation',
      coverage: d >= MIN_DELTA_E ? 1 : 0,
      worst: d,
    });
  }
}

let ok = true;
for (const r of results) {
  const pass = r.coverage >= MIN_COVERAGE;
  ok &&= pass;
  console.log(
    `${pass ? 'ok  ' : 'FAIL'}  ${r.what.padEnd(30)} vs ${r.on.padEnd(26)}` +
      ` clears ${(r.coverage * 100).toFixed(0)}% of water (worst ΔE ${r.worst.toFixed(1)})`
  );
}
if (!ok) {
  console.error(
    `\nSome colours blend into the water behind them (need ΔE ${MIN_DELTA_E} over ` +
      `${MIN_COVERAGE * 100}% of it).` +
      '\nPick another colour, or if the basemap changed, re-run scripts/sample-basemaps.py.'
  );
}
process.exit(ok ? 0 : 1);
