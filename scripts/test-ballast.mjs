#!/usr/bin/env node
/**
 * The glider ballast arithmetic.
 *
 *   npm run test:ballast
 *
 * Needs no build and no jsdom: `packages/glider-ballast` imports neither
 * Leaflet nor the DOM, so this loads the TypeScript through Node's own type
 * stripping and calls the functions.
 *
 * THERE IS NO REFERENCE IMPLEMENTATION, AND THAT SHAPES EVERY CHECK
 * ----------------------------------------------------------------
 * `test:teos10` can hold its package against GSW. Nothing plays that role
 * here — ballast procedures are per-vehicle spreadsheets, not a published
 * standard — so the checks are of three kinds, none of which needs one:
 *
 * 1. **Identities.** Ballasting for a point must make the buoyancy at that
 *    point exactly zero; the mass a tank reading implies must give that
 *    reading back. These are the definitions, and they catch a sign or a
 *    factor of a thousand instantly.
 * 2. **Against TEOS-10.** The rate at which buoyancy changes with depth has
 *    a closed form — `dB/dp = rho V (kappa_water - kappa_hull)` — and the
 *    water's compressibility comes from a package that *is* checked against
 *    a reference. So the module's own finite difference is held against a
 *    quantity computed independently of it.
 * 3. **Arithmetic anybody can redo on paper.** A 50 litre hull in 1025 and
 *    in 1027 kg/m^3 water differs by 100 g. If that is wrong nothing else
 *    matters.
 *
 * Plus the operational logic: the margins that decide whether a glider can
 * surface and dive, and the warnings that fire when it cannot.
 */

import {
  VEHICLES, SEAWATER_COMPRESSIBILITY, ROUND_WATER, ballast, buoyancy,
  displacement, massFromTank, vehicleById,
} from '../packages/glider-ballast/index.ts';
import { density, isothermalCompressibility } from '../packages/teos10/index.ts';

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
};
const near = (what, got, want, tol, unit = '') => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}` + (ok ? '' : `  got ${got}${unit}, want ${want}${unit}`));
};

/* A hull with no compressibility and no thermal expansion: displacement is
   then exactly its volume, so every conversion is visible on paper. */
const RIGID = {
  mass: 51.25,
  volume: 50,
  compressibility: 0,
  thermalExpansion: 0,
  referenceTemperature: 15,
  pumpRange: 300,
};

const REAL = VEHICLES[0].hull;
const WATER = [
  { name: 'Surface', sa: 35.5, t: 24, p: 0 },
  { name: 'Mixed layer', sa: 35.6, t: 19, p: 40 },
  { name: 'Bottom inflection', sa: 35.1, t: 6, p: 1000 },
];
const TANK = { name: 'Tank', sa: 0.5, t: 20, p: 0 };

// ---- 3. arithmetic anybody can redo --------------------------------------

console.log('\n-- arithmetic on paper --');

{
  /* Pure water at 4 degC is 999.9749 kg/m^3 — a number `test:teos10` pins
     against GSW — so a rigid 50 L hull displaces 49.99875 kg there and a
     50 kg vehicle is 1.25 g negative. Every factor of a thousand in the
     module has to be right for that to come out.

     The first version of this check asserted 1000 kg/m^3 flat and was wrong
     by 45 g: fresh water is only 1000 near its density maximum, and 15 degC
     is 999.1. The module was right and the paper sum was not, which is the
     ordinary way round for a made-up round number. */
  const fresh = buoyancy(RIGID, 50, { name: '', sa: 0, t: 4, p: 0 });
  near('a 50 kg, 50 L vehicle in fresh water at 4 degC is 1.25 g negative',
    fresh, -1.25, 0.01, ' g');
  near('and that is exactly what the density implies',
    fresh, (density(0, 4, 0) * 0.05 - 50) * 1000, 1e-9, ' g');

  /* Two waters 2 kg/m^3 apart move a 50 L hull by 100 g. This is the whole
     reason the density has to be right to a thousandth. */
  const a = 50 * (1025 / 1000) * 1000;
  const b = 50 * (1027 / 1000) * 1000;
  near('2 kg/m3 of density is 100 g on a 50 L hull', b - a, 100, 1e-9, ' g');
}

// ---- the hull's own geometry ----------------------------------------------

console.log('\n-- displacement --');

{
  near('a rigid hull displaces its volume whatever the conditions',
    displacement(RIGID, 30, 5000), 50, 1e-12, ' L');

  /* One part per million per dbar on 50 L is 0.05 mL per dbar, so 1000 dbar
     is 50 mL. Small, and 50 mL of seawater is about 51 g — a third of a
     typical pump's travel, which is why it is in the calculation at all. */
  const squeezed = displacement(REAL, REAL.referenceTemperature, 1000);
  near('a 1e-6 per dbar hull loses 0.1% of its volume in 1000 dbar',
    squeezed, REAL.volume * (1 - 1e-3), 1e-9, ' L');

  const warmed = displacement(REAL, REAL.referenceTemperature + 10, 0);
  near('and gains its thermal coefficient times ten degrees',
    warmed, REAL.volume * (1 + REAL.thermalExpansion * 10), 1e-12, ' L');

  check('the pump adds cubic centimetres, not litres',
    Math.abs(displacement(RIGID, 15, 0, 250) - 50.25) < 1e-12,
    `${displacement(RIGID, 15, 0, 250)} L`);
}

// ---- 1. the identities ----------------------------------------------------

console.log('\n-- the identities ballasting is defined by --');

for (let k = 0; k < WATER.length; k++) {
  const r = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: k });
  near(`ballasting for ${WATER[k].name.toLowerCase()} makes it neutral there`,
    r.readings[k].buoyancy, 0, 1e-7, ' g');
  near('and the neutral density is that point\'s own',
    r.neutralDensity, density(WATER[k].sa, WATER[k].t, WATER[k].p), 1e-12, ' kg/m3');
  near('and the pump has nothing to do there', r.readings[k].pumpNeeded, 0, 1e-7, ' cc');
}

{
  const r = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 1 });
  near('the ballast change is the mass change', r.ballastChange, (r.mass - REAL.mass) * 1000, 1e-9, ' g');
  near('and the tank reading follows from the ballasted mass',
    r.tankBuoyancy, buoyancy(REAL, r.mass, TANK), 1e-9, ' g');

  /* The direction has to be right or the operator adds lead when they should
     take it out. The mixed layer here is denser than the vehicle was
     ballasted for, so it needs to get heavier. */
  check('heavier water means adding lead', r.ballastChange > 0, `${r.ballastChange.toFixed(1)} g`);
  const lighter = ballast({
    hull: { ...REAL, mass: REAL.mass + 1 }, tank: TANK, water: WATER, neutralAt: 1,
  });
  check('and an overweight vehicle means taking it out',
    lighter.ballastChange < 0, `${lighter.ballastChange.toFixed(1)} g`);
}

{
  /* Nobody knows a glider's mass to the gram; everybody can float it and read
     a scale. The two directions have to agree exactly. */
  for (const grams of [-1500, -12, 0, 340]) {
    const m = massFromTank(REAL, TANK, grams);
    near(`a tank reading of ${grams} g round-trips to the mass and back`,
      buoyancy(REAL, m, TANK), grams, 1e-8, ' g');
  }
}

{
  /* The pump displacement that zeroes a buoyancy has to actually zero it. */
  const r = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 1 });
  for (const reading of r.readings) {
    near(`the pump figure for ${reading.water.name.toLowerCase()} does zero it`,
      buoyancy(REAL, r.mass, reading.water, reading.pumpNeeded), 0, 1e-6, ' g');
  }
}

// ---- 2. against TEOS-10 ---------------------------------------------------

console.log('\n-- against a compressibility computed independently --');

{
  /* dB/dp = rho V (kappa_water - kappa_hull). The left side is this module's
     own finite difference; the right side uses TEOS-10's isothermal
     compressibility, which is gated against GSW and knows nothing about
     gliders. Agreement means the hull term is entering with the right sign
     and the right magnitude — the two ways this could be wrong and look
     plausible. */
  for (const w of WATER) {
    const mass = 52;
    const dp = 1;
    const slope = (buoyancy(REAL, mass, { ...w, p: w.p + dp })
      - buoyancy(REAL, mass, { ...w, p: w.p - dp })) / (2 * dp);
    const rho = density(w.sa, w.t, w.p);
    const V = displacement(REAL, w.t, w.p);
    // TEOS-10 gives 1/Pa; a dbar is 1e4 Pa.
    const kappaWater = isothermalCompressibility(w.sa, w.t, w.p) * 1e4;
    /* The hull term is `kappa / (1 - kappa p)`, not `kappa`. `V = V0 f (1 -
       kappa p)`, so `dV/dp` is `-V0 f kappa` — which is `-V kappa` only at
       the surface. Dropping the denominator was worth 3e-4 of the answer at
       1000 dbar, which this caught: the module differences rho and V
       honestly and never writes the closed form, so it was the closed form
       here that was approximate. That is the argument its own header makes
       for not reasoning about slopes. */
    const kappaHull = REAL.compressibility / (1 - REAL.compressibility * w.p);
    const predicted = rho * (V / 1000) * (kappaWater - kappaHull) * 1000;
    near(`buoyancy changes with depth at the rate TEOS-10 implies, at ${w.name.toLowerCase()}`,
      slope, predicted, Math.abs(predicted) * 1e-4, ' g/dbar');
  }

  check('and seawater is the more compressible of the two here',
    SEAWATER_COMPRESSIBILITY > REAL.compressibility,
    `water ${SEAWATER_COMPRESSIBILITY.toExponential(1)} against hull ${REAL.compressibility.toExponential(1)} per dbar`);

  /* Which follows through to the sign an operator sees: a hull stiffer than
     the water gets *more* buoyant on the way down. Stated because it is the
     thing most often had backwards, and asserted rather than assumed. */
  const mass = 52;
  const deep = buoyancy(REAL, mass, { name: '', sa: 35, t: 10, p: 1000 });
  const shallow = buoyancy(REAL, mass, { name: '', sa: 35, t: 10, p: 0 });
  check('so at fixed temperature and salinity it gains buoyancy with depth',
    deep > shallow, `${(deep - shallow).toFixed(0)} g over 1000 dbar`);

  /* And the other way for a hull softer than water, which the module must
     handle without any of this being wired in. */
  const soft = { ...REAL, compressibility: 1e-5 };
  check('and a hull softer than water loses it instead',
    buoyancy(soft, mass, { name: '', sa: 35, t: 10, p: 1000 })
      < buoyancy(soft, mass, { name: '', sa: 35, t: 10, p: 0 }));
}

// ---- can it surface, and can it dive --------------------------------------

console.log('\n-- the two questions that decide the mission --');

{
  const r = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 1 });
  near('the surface margin is the buoyancy with the pump fully out',
    r.surfaceMargin, buoyancy(REAL, r.mass, WATER[0], REAL.pumpRange), 1e-9, ' g');
  near('the dive margin is the buoyancy with it fully in',
    r.diveMargin, buoyancy(REAL, r.mass, WATER[2], -REAL.pumpRange), 1e-9, ' g');
  check('and this vehicle can do both', r.surfaceMargin > 0 && r.diveMargin < 0
    && r.warnings.length === 0,
    `+${r.surfaceMargin.toFixed(0)} g up, ${r.diveMargin.toFixed(0)} g down`);

  /* The margins are taken at the shallowest and deepest points, not at
     whichever the operator happened to list first — the three inputs are
     named for a profile but nothing makes them arrive in order. */
  const shuffled = [WATER[2], WATER[0], WATER[1]];
  const same = ballast({ hull: REAL, tank: TANK, water: shuffled, neutralAt: 2 });
  near('and they do not depend on the order the points were entered',
    same.surfaceMargin, r.surfaceMargin, 1e-9, ' g');
  near('nor does the dive margin', same.diveMargin, r.diveMargin, 1e-9, ' g');

  /* A pump too small to overcome the spread has to say so rather than
     reporting a ballast figure that flies nothing. */
  const tiny = ballast({ hull: { ...REAL, pumpRange: 5 }, tank: TANK, water: WATER, neutralAt: 1 });
  check('a pump too small to reach the surface is a warning, not a number',
    tiny.warnings.some((w) => /cannot surface/.test(w)), tiny.warnings.join(' | '));
  check('and one too small to dive is another',
    tiny.warnings.some((w) => /cannot dive/.test(w)));
  check('and each names how many grams short it is',
    tiny.warnings.every((w) => /\d+ g/.test(w)));

  const far = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 0 });
  check('ballasting for the surface leaves it unable to dive',
    far.warnings.some((w) => /cannot dive/.test(w)), far.warnings.join(' | '));
}

// ---- what the report says about itself ------------------------------------

console.log('\n-- the notes --');

{
  const r = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 1 });
  check('a tank far from the target says the big reading is expected',
    r.notes.some((n) => /expected rather than wrong/.test(n)), r.notes.join(' | '));
  check('and the hull-against-water comparison is stated in grams per 100 dbar',
    r.notes.some((n) => /per 100 dbar/.test(n)));
  check('and the temperature one in grams per five degrees',
    r.notes.some((n) => /5 °C/.test(n)));

  const seawaterTank = ballast({
    hull: REAL, tank: { name: 'Tank', sa: 35.5, t: 19.5, p: 0 }, water: WATER, neutralAt: 1,
  });
  check('a tank near the target does not',
    !seawaterTank.notes.some((n) => /expected rather than wrong/.test(n)),
    seawaterTank.notes.join(' | '));

  const none = ballast({ hull: REAL, tank: TANK, water: WATER, neutralAt: 7 });
  check('and no chosen point is a question rather than a crash',
    none.warnings.length === 1 && Number.isNaN(none.ballastChange));
}

// ---- the shipped vehicles -------------------------------------------------

console.log('\n-- the vehicle list --');

{
  check('four families are offered', VEHICLES.length === 4,
    VEHICLES.map((v) => v.name).join(', '));
  check('every one is flagged as illustrative, because none is a ballast sheet',
    VEHICLES.every((v) => v.illustrative === true));

  /* The volumes are stated to be the mass over 1025 kg/m^3 and nothing else.
     Checking it keeps them from drifting into looking like measurements. */
  for (const v of VEHICLES) {
    /* To the millilitre, not exactly: the volumes are rounded to what the
       page displays, so that reading a box back gives the number that was
       stored and Reset can tell it has reset. A millilitre is about a gram
       of buoyancy here, which is the resolution any of this is worth. */
    near(`${v.name}'s volume is its mass over ${ROUND_WATER}, to the millilitre`,
      v.hull.volume, (v.hull.mass / ROUND_WATER) * 1000, 5e-4, ' L');
    check(`${v.name} is therefore neutral in ${ROUND_WATER} kg/m3 water to within a gram`,
      Math.abs(v.hull.mass - ROUND_WATER * v.hull.volume / 1000) * 1000 < 1);
    check(`and its volume survives being shown to three decimals`,
      Number(v.hull.volume.toFixed(3)) === v.hull.volume, `${v.hull.volume}`);
    check(`${v.name} has a pump, a mass and both hull terms`,
      v.hull.pumpRange > 0 && v.hull.mass > 0
      && v.hull.compressibility > 0 && v.hull.thermalExpansion > 0);
  }

  check('and they can be looked up by id', vehicleById('slocum')?.name === 'Slocum G3'
    && vehicleById('nope') === undefined);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
