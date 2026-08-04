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
 * Palettes come from packages/ocean-map/data/basemap-ocean.json, sampled offline by
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
const behaviour = fs.readFileSync('packages/ocean-map/index.ts', 'utf8');
const styling = fs.readFileSync('src/components/AssetMap.astro', 'utf8');
const particlePane = /paneName:\s*'([^']+)'/.exec(behaviour)?.[1];
if (!particlePane) {
  console.error('FAIL  cannot find the particle pane name in packages/ocean-map/index.ts');
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

const palette = JSON.parse(fs.readFileSync('packages/ocean-map/data/map-palette.json', 'utf8'));
const basemaps = JSON.parse(fs.readFileSync('packages/ocean-map/data/basemap-ocean.json', 'utf8')).basemaps;

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

/* **What a velocity field has to clear, and what it does not.**

   A particle is a thin moving line covering the whole map, and the only
   thing behind it is the water — the bathymetry, whichever of its tones, or
   whichever colour scale has replaced it. That is the background, it is
   everywhere, and there is no casing or shape to fall back on: if a particle
   does not clear it, the layer is invisible. Held to MIN_DELTA_E, tone by
   tone.

   A marker is none of those things. It is a small filled dot with a dark
   outline, sitting still, in a place the reader is looking at deliberately.
   Shape, size and stillness separate it from a drifting trail long before
   hue does — which is the same argument Argo's long-standing exemption has
   always rested on. So a particle only has to stay *distinguishable* from a
   marker, not clear the full background bar.

   Getting this the wrong way round is what put the current ramp at ΔE 21.8
   from the shelf while comfortably clear of every marker: the gate was
   spending its strictness where it mattered least. */
const MARKER_DELTA_E = 15;

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

/* Every knowing concession, from the palette. A pair named here may sit
   under the bar; every other pair may not. Checked both ways below — see
   `_concessions`. */
const concessions = new Map(
  (palette.concessions ?? []).map((c) => [c.pair, { ...c, seen: null }])
);

/* Worst distance per pair, gathered rather than asserted, so a pair can be
   judged against the concession list once all of its stops are in. */
const pairs = new Map();
/* Each pair carries the bar it is judged against, since a particle owes a
   background more than it owes a marker — see MARKER_DELTA_E. */
const note_pair = (pair, d, bar = MIN_DELTA_E) => {
  const seen = pairs.get(pair);
  pairs.set(pair, { worst: Math.min(seen?.worst ?? Infinity, d), bar });
};


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

/* Every particle ramp against every basemap — so, like the markers, every
   step of every one has to survive all of them.

   Plural since the wind arrived. It was one ramp and a bare
   `palette.currents` here, which meant a second ramp could be added to the
   palette and drawn on the map without this file ever looking at it — the
   gate would have gone on saying `ok` about a colour it had never seen. */
const PARTICLE_RAMPS = { currents: palette.currents, wind: palette.wind };

/* **Every tone, not 90% of them by area.** Markers are judged on
   prevalence-weighted coverage, because a marker is a filled dot with a dark
   casing and one uncommon water tone should not veto a colour that is clear
   over the rest of the ocean. A particle is a thin moving line with no
   casing, and — the part that actually matters — the tone that gets outvoted
   is *not* a random oddity. It is GEBCO's pale mint shelf, 4.9% of ocean
   pixels and the water this map is most used to look at, since that is where
   the gliders work. Weighting by pixel area makes the abyssal plain
   important and the shelf noise, which is backwards for this map.

   That is not hypothetical: the amber ramp this replaced sat ΔE 21.8 from
   the shelf and 18.7 from Esri's palest tone, passed at 94.3% weighted
   coverage, and was reported as invisible on the shelf. */
for (const [field, ramp] of Object.entries(PARTICLE_RAMPS)) {
  for (const [mapName, info] of Object.entries(basemaps)) {
    for (const { colour: water, share } of info.ocean) {
      const d = Math.min(...ramp.map((c) => deltaE(hex(c), hex(water))));
      note_pair(`${field} vs ${water}`, d);
      results.push({
        what: `${field} vs ${water}`,
        on: `${mapName} (${(share * 100).toFixed(1)}% of it)`,
        coverage: d >= MIN_DELTA_E || concessions.has(`${field} vs ${water}`) ? 1 : 0,
        worst: d,
      });
    }
  }
}

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
  /* The particle ramps used to be checked here too, one row per stop. They
     are measured in the separation pass below instead, aggregated to one
     pair per colormap — because a concession names a colormap a particle
     runs close to, not a stop index, and ten rows saying the same thing
     about `haline` bury the one line a reader needs. The markers stay
     per-stop: nothing concedes against them, so each row is pass or fail on
     its own. */
}

/* Particles must not read as assets. They are thin moving lines and the
   markers are filled dots, but keeping them apart in colour too means a
   glance is never ambiguous. */
for (const [field, ramp] of Object.entries(PARTICLE_RAMPS)) {
  for (const colour of ramp) {
    for (const [name, feature] of Object.entries(palette.features)) {
      note_pair(`${field} vs ${name}`, deltaE(hex(colour), hex(feature)), MARKER_DELTA_E);
    }
    /* Each marker-safe colormap is a background the reader can switch on
       under the particles, so it is judged as one pair per map rather than
       one per stop — a concession names a colormap, not a stop index. */
    for (const [name, stops] of Object.entries(palette.colormaps ?? {})) {
      if (!safeMaps.has(name)) continue;
      for (const stop of stops) note_pair(`${field} vs ${name}`, deltaE(hex(colour), hex(stop)));
    }
  }
}

/* The two particle ramps against each other. This pair only became a
   question when wind stopped being exclusive with the currents: both can now
   drift over the same water, and unlike a marker against a particle there is
   no filled dot and no outline to fall back on. */
for (const w of palette.wind) {
  for (const c of palette.currents) note_pair('wind vs currents', deltaE(hex(w), hex(c)));
}

for (const [pair, { worst, bar }] of pairs) {
  const allowed = concessions.get(pair);
  if (allowed) allowed.seen = worst;
  results.push({
    what: pair,
    on: allowed ? 'conceded separation' : `separation (bar ${bar})`,
    coverage: worst >= bar || allowed ? 1 : 0,
    worst,
  });
}

/* Both directions. A pair under the bar must be named, which the loop above
   enforces; a pair that is named must actually be under it, or the list
   quietly accumulates concessions nobody is making any more and stops being
   worth reading. */
for (const [pair, c] of concessions) {
  if (c.seen === null) {
    results.push({ what: `concession "${pair}"`, on: 'a pair never measured',
                   coverage: 0, worst: 0 });
  } else if (c.seen >= (pairs.get(pair)?.bar ?? MIN_DELTA_E)) {
    results.push({ what: `concession "${pair}"`, on: 'a pair that clears — remove it',
                   coverage: 0, worst: c.seen });
  } else {
    notes.push(`conceded: ${pair} at ΔE ${c.seen.toFixed(1)} (declared ${c.deltaE}) — see _concessions`);
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
