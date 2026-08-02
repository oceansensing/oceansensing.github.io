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
import { hex, deltaE } from './lib/colour.mjs';

/* Everything below compares a feature colour with the water behind it, which
   only means anything if the feature is composited normally. It is not a
   hypothetical: the particle canvas once shared a pane with the Mercator
   raster, which is multiplied over the basemap, so what reached the screen
   was multiply(amber, water) — near-invisible — while this gate happily
   measured the amber. The gate was right about a colour nobody could see.
   So check the assumption before trusting the numbers. */
/* Two files, because behaviour and styling now live apart: the module names
   the pane, the component styles it. The check spans both on purpose — a
   blend mode reappearing in either place is what it exists to catch. */
const behaviour = fs.readFileSync('src/lib/ocean-map/index.ts', 'utf8');
const styling = fs.readFileSync('src/components/AssetMap.astro', 'utf8');
const particlePane = /paneName:\s*'([^']+)'/.exec(behaviour)?.[1];
if (!particlePane) {
  console.error('FAIL  cannot find the particle pane name in src/lib/ocean-map/index.ts');
  process.exit(1);
}
const blended = new RegExp(
  `leaflet-${particlePane}-pane\\)?\\s*\\{[^}]*mix-blend-mode`,
  's'
).test(`${behaviour}\n${styling}`);
if (blended) {
  console.error(
    `FAIL  the particle pane (${particlePane}) has a mix-blend-mode.\n` +
      '      Particles must composite normally, or the colours checked here are\n' +
      '      not the colours that reach the screen.'
  );
  process.exit(1);
}

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
const notes = [];

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

/* An SST layer replaces the water under everything else, so every stop of
   its ramp is another background the markers and the particles have to
   survive — treated exactly like a basemap ocean, each stop weighted as its
   own full-coverage tone. This is why the ramp is dark and low-chroma
   rather than the conventional rainbow: the usual pale-yellow-to-red warm
   end sits on top of the storm, USV and particle colours, and the warm end
   is the tropics, which is where the storms are. */
/* Every colormap a reader can choose is another set of water colours:
   whichever is switched on becomes the background for every marker and
   particle. All of them are checked, not just the defaults — an option that
   hides a platform is not an option. */
const safeMaps = new Set(palette.markerSafe ?? []);
const sstWater = Object.entries(palette.colormaps ?? {})
  .filter(([name]) => safeMaps.has(name))
  .flatMap(([name, stops]) => stops.map((colour, i) => ({ colour, label: `${name}[${i}]` })));

/* The other colour scales are offered but not guaranteed, and the guarantee
   that remains is that the *classification* is honest: every map called
   marker-safe really clears the bar everywhere, and every map not called
   marker-safe really does not. Without the second half the list would rot
   into a warning nobody needs — a map that quietly became safe would still
   be labelled a risk, and the label would stop meaning anything. */
const worstForMap = {};
for (const [name, stops] of Object.entries(palette.colormaps ?? {})) {
  const worst = Math.min(
    ...stops.flatMap((c) => Object.values(palette.features).map((f) => deltaE(hex(c), hex(f))))
  );
  worstForMap[name] = worst;
  const declaredSafe = safeMaps.has(name);
  results.push({
    what: `${name} is ${declaredSafe ? 'marker-safe' : 'flagged as risky'}`,
    on: 'colormap classification',
    coverage: declaredSafe === worst >= MIN_DELTA_E ? 1 : 0,
    worst,
  });
}

/* A default is normally required to be marker-safe: it is what a reader who
   never touches the picker looks at. Where one is not, it has to be named in
   defaultExempt with the reasoning, and the clearance it actually gives is
   reported — the same bargain separationExempt strikes. Recording it beats
   dropping the check, which would let a default drift onto a scale that
   hides the fleet with nothing to say so. */
const defaultExempt = new Set(palette.defaultExempt ?? []);
for (const field of Object.keys(palette.defaultColormap ?? {})) {
  const name = palette.defaultColormap[field];
  const safe = safeMaps.has(name);
  if (!safe && defaultExempt.has(field)) {
    notes.push(
      `${field} defaults to ${name}, which is not marker-safe ` +
        `(worst ΔE ${worstForMap[name]?.toFixed(1)}) — deliberate, see _defaultColormap`
    );
    continue;
  }
  results.push({
    what: `${field} defaults to ${name}, which is marker-safe`,
    on: 'defaults',
    coverage: safe ? 1 : 0,
    worst: safe ? Infinity : (worstForMap[name] ?? Infinity),
  });
}
if (sstWater.length) {
  for (const [name, colour] of Object.entries(palette.features)) {
    for (const stop of sstWater) {
      const d = deltaE(hex(colour), hex(stop.colour));
      results.push({
        what: `${name} (${colour})`,
        on: `SST ramp ${stop.label} (${stop.colour})`,
        coverage: d >= MIN_DELTA_E ? 1 : 0,
        worst: d,
      });
    }
  }
  palette.currents.forEach((colour, i) => {
    for (const stop of sstWater) {
      const d = deltaE(hex(colour), hex(stop.colour));
      results.push({
        what: `currents[${i}] (${colour})`,
        on: `SST ramp ${stop.label} (${stop.colour})`,
        coverage: d >= MIN_DELTA_E ? 1 : 0,
        worst: d,
      });
    }
  });
}

/* Particles must not read as assets. They are thin moving lines and the
   markers are filled dots, but keeping them apart in colour too means a
   glance is never ambiguous. */
const exempt = new Set(palette.separationExempt ?? []);
for (const [i, colour] of palette.currents.entries()) {
  for (const [name, feature] of Object.entries(palette.features)) {
    const d = deltaE(hex(colour), hex(feature));
    if (exempt.has(name)) {
      // Named exemption, with the reason in map-palette.json. Reported, not
      // hidden — a silently lowered threshold would cover this and every
      // future clash along with it.
      if (i === 0) notes.push(`${name} exempt from particle separation (ΔE ${d.toFixed(1)}) — see _separation`);
      continue;
    }
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
for (const note of notes) console.log(`note  ${note}`);
if (!ok) {
  console.error(
    `\nSome colours blend into the water behind them (need ΔE ${MIN_DELTA_E} over ` +
      `${MIN_COVERAGE * 100}% of it).` +
      '\nPick another colour, or if the basemap changed, re-run scripts/sample-basemaps.py.'
  );
}
process.exit(ok ? 0 : 1);
