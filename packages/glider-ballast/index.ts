/**
 * Ballasting an underwater glider.
 *
 * A glider flies by being slightly the wrong weight on purpose. Ballasting is
 * setting the fixed part of that — the lead — so the buoyancy engine's own
 * range straddles neutral across the water the vehicle will actually fly in.
 * Get it wrong and the glider either cannot surface or cannot dive, and you
 * find out after it is in the water.
 *
 * The whole calculation is one equation:
 *
 *     B = rho(SA, t, p) * V(t, p) - m
 *
 * buoyancy is the weight of the water displaced less the weight of the
 * vehicle. Everything else here is bookkeeping around it: the density comes
 * from `@c4po/teos10`, and the volume from the hull's own compressibility and
 * thermal expansion.
 *
 * **The sign of what happens with depth is not assumed anywhere.** Whether a
 * glider gains or loses buoyancy as it descends depends on how its hull's
 * compressibility compares with seawater's own, and that is a property of the
 * vehicle rather than a fact about gliders. So this evaluates rho and V
 * separately at each point and subtracts, rather than reasoning about which
 * way anything moves. The same goes for temperature: seawater expands about
 * 1.8e-4 per degree at 10 degC and an aluminium hull about 7e-5, so the water
 * usually wins, but the arithmetic does not depend on it.
 *
 * The closed form is `dB/dp = rho V (kappa_water - kappa_hull / (1 - kappa_hull
 * p))`, and the denominator is not decoration — dropping it is worth 3e-4 of
 * the answer at 1000 dbar, because `V` already carries the `(1 - kappa p)`
 * factor and its derivative therefore does not. `test:ballast` writes that
 * form out to check this module against TEOS-10's own compressibility, and
 * got it wrong on the first attempt. Which is the argument for not writing it
 * here: subtracting two honestly-evaluated numbers has no such corner.
 *
 * Renderer-independent: no DOM, no fetch, no framework. The Absolute Salinity
 * of each water point is resolved by the caller, because that needs the
 * atlas and the atlas needs the network.
 */

import { density } from '@c4po/teos10';

/* Three separate thousands, named separately on purpose. They are the same
   number, so one constant would work and would let a litres-to-cubic-metres
   conversion pass for a grams-to-kilograms one at review. Every unit change
   below says which it is. */
const G_PER_KG = 1000;
const CC_PER_L = 1000;
const L_PER_M3 = 1000;

/** Mass of water displaced, kg, for a volume in litres. */
const displacedMass = (rho: number, litres: number) => rho * (litres / L_PER_M3);

/**
 * The vehicle, as a ballast sheet describes it.
 *
 * `volume` and `mass` are the pair that decides everything; the two hull
 * coefficients say how the volume moves with conditions. All four are
 * vehicle-specific — see `vehicles.ts` on why this package ships no
 * manufacturer data.
 */
export interface Hull {
  /** Total mass in air, kg — vehicle, payload, batteries and lead. */
  mass: number;
  /** Displaced volume at `referenceTemperature` and zero pressure, litres. */
  volume: number;
  /** Fractional volume change per dbar, positive for a hull that compresses. */
  compressibility: number;
  /** Fractional volume change per degree C, positive for one that expands. */
  thermalExpansion: number;
  /** The temperature `volume` was measured at, degrees C. */
  referenceTemperature: number;
  /** Buoyancy engine travel, plus and minus this many cc about neutral. */
  pumpRange: number;
}

/** A water sample the glider will fly through, already resolved to TEOS-10. */
export interface Water {
  /** What to call it: "Surface", "Mixed layer", "Bottom inflection". */
  name: string;
  /** Absolute Salinity, g/kg. */
  sa: number;
  /** In-situ temperature, degrees C on ITS-90. */
  t: number;
  /** Sea pressure, dbar. */
  p: number;
}

export interface Reading {
  water: Water;
  /** In-situ density there, kg/m^3. */
  density: number;
  /** What the hull displaces there, litres. */
  volume: number;
  /** Net buoyancy with the pump at mid-travel, grams. Positive floats. */
  buoyancy: number;
  /** Pump displacement that would zero it, cc. Positive means pump out. */
  pumpNeeded: number;
  /** Whether that is inside the engine's travel. */
  withinPump: boolean;
}

export interface Input {
  hull: Hull;
  /** The ballast tank: its water, and how deep the vehicle floats in it. */
  tank: Water;
  /** The three points the glider will fly through. */
  water: Water[];
  /** Which of them to be neutral at, by index. */
  neutralAt: number;
}

export interface Report {
  /** Density, displacement and buoyancy in the tank, before any change. */
  tank: { density: number; volume: number; buoyancy: number };
  /** Grams of ballast to add. Negative means take lead out. */
  ballastChange: number;
  /** What the glider should read in the tank once it is right, grams. */
  tankBuoyancy: number;
  /** The in-situ density it ends up neutral at, kg/m^3. */
  neutralDensity: number;
  /** Total mass after ballasting, kg. */
  mass: number;
  /** All three points, computed with the ballasted mass. */
  readings: Reading[];
  /** Grams in hand at the shallowest point with the pump fully out. */
  surfaceMargin: number;
  /** Grams in hand at the deepest point with the pump fully in. Negative
      is what you want: the vehicle has to be heavy enough to go down. */
  diveMargin: number;
  /** Anything that would stop the glider flying, in the order it matters. */
  warnings: string[];
  /** Things worth knowing that are not faults. */
  notes: string[];
}

/**
 * What the hull displaces at a given temperature and pressure, litres.
 *
 * First order in both terms, which is what a ballast sheet's two coefficients
 * can support: they are themselves fitted over the vehicle's operating range,
 * so carrying a second order here would be precision the inputs do not have.
 */
export function displacement(hull: Hull, t: number, p: number, pumpCc = 0): number {
  const thermal = 1 + hull.thermalExpansion * (t - hull.referenceTemperature);
  const squeeze = 1 - hull.compressibility * p;
  return hull.volume * thermal * squeeze + pumpCc / CC_PER_L;
}

/**
 * Net buoyancy in grams: positive floats, negative sinks.
 *
 * Grams rather than newtons because that is the unit the whole practice is
 * conducted in — you add grams of lead, and you read grams on the scale under
 * the tank. It is a mass equivalent, not a force, so gravity never enters.
 */
export function buoyancy(hull: Hull, mass: number, water: Water, pumpCc = 0): number {
  const rho = density(water.sa, water.t, water.p);
  const volume = displacement(hull, water.t, water.p, pumpCc);
  return (displacedMass(rho, volume) - mass) * G_PER_KG;
}

/**
 * The mass a tank measurement implies.
 *
 * The practical direction: nobody knows a glider's mass to the gram, but
 * everybody can float it in a tank and read how buoyant it is. Given the tank
 * water and the hull's displacement there, that reading *is* the mass.
 */
export function massFromTank(hull: Hull, tank: Water, buoyancyGrams: number): number {
  const rho = density(tank.sa, tank.t, tank.p);
  return displacedMass(rho, displacement(hull, tank.t, tank.p)) - buoyancyGrams / G_PER_KG;
}

const read = (hull: Hull, mass: number, water: Water): Reading => {
  const rho = density(water.sa, water.t, water.p);
  const volume = displacement(hull, water.t, water.p);
  const grams = (displacedMass(rho, volume) - mass) * G_PER_KG;
  /* The displacement change that would zero it: `B = rho V - m`, so the
     volume to add is `-B / rho`. In cubic metres that is kilograms over
     kg/m^3; the two thousands take it to cubic centimetres. */
  const pumpNeeded = (-grams / G_PER_KG) / rho * L_PER_M3 * CC_PER_L;
  return {
    water,
    density: rho,
    volume,
    buoyancy: grams,
    pumpNeeded,
    withinPump: Math.abs(pumpNeeded) <= hull.pumpRange,
  };
};

/**
 * Ballast a glider for one of the water points it will fly through.
 *
 * Returns what to change, what the tank should then read, and what the
 * vehicle will do at each of the points — including whether the buoyancy
 * engine has the travel to reach neutral at all of them, which is the
 * question that decides whether the mission works.
 */
export function ballast(input: Input): Report {
  const { hull, tank, water } = input;
  const warnings: string[] = [];
  const notes: string[] = [];

  const target = water[input.neutralAt];
  if (!target) {
    return {
      tank: { density: NaN, volume: NaN, buoyancy: NaN },
      ballastChange: NaN, tankBuoyancy: NaN, neutralDensity: NaN, mass: NaN,
      readings: [], surfaceMargin: NaN, diveMargin: NaN,
      warnings: ['Select which water point to be neutral at.'],
      notes,
    };
  }

  const tankRho = density(tank.sa, tank.t, tank.p);
  const tankVolume = displacement(hull, tank.t, tank.p);
  const tankBefore = (displacedMass(tankRho, tankVolume) - hull.mass) * G_PER_KG;

  /* Neutral at the target means the vehicle weighs exactly what it displaces
     there. Everything else follows from this one line. */
  const targetRho = density(target.sa, target.t, target.p);
  const targetVolume = displacement(hull, target.t, target.p);
  const mass = displacedMass(targetRho, targetVolume);

  const ballastChange = (mass - hull.mass) * G_PER_KG;
  const tankBuoyancy = (displacedMass(tankRho, tankVolume) - mass) * G_PER_KG;

  const readings = water.map((w) => read(hull, mass, w));

  /* Can it get back up, and can it get down? Not the same question as
     reaching neutral: the engine has to overcome the buoyancy at the extreme
     points, and those are the shallowest and deepest of the three rather than
     whichever the operator listed first. */
  const shallowest = readings.reduce((a, b) => (b.water.p < a.water.p ? b : a), readings[0]);
  const deepest = readings.reduce((a, b) => (b.water.p > a.water.p ? b : a), readings[0]);
  const surfaceMargin = buoyancy(hull, mass, shallowest.water, hull.pumpRange);
  const diveMargin = buoyancy(hull, mass, deepest.water, -hull.pumpRange);

  if (Number.isFinite(surfaceMargin) && surfaceMargin <= 0) {
    warnings.push(
      `With the pump fully out the glider is still ${Math.abs(surfaceMargin).toFixed(0)} g `
      + `negative at ${shallowest.water.name.toLowerCase()} — it cannot surface.`
    );
  }
  if (Number.isFinite(diveMargin) && diveMargin >= 0) {
    warnings.push(
      `With the pump fully in the glider is still ${diveMargin.toFixed(0)} g `
      + `positive at ${deepest.water.name.toLowerCase()} — it cannot dive.`
    );
  }
  for (const r of readings) {
    if (!r.withinPump && Number.isFinite(r.pumpNeeded)) {
      notes.push(
        `Reaching neutral at ${r.water.name.toLowerCase()} needs `
        + `${r.pumpNeeded.toFixed(0)} cc, past the pump's ±${hull.pumpRange} cc.`
      );
    }
  }

  /* A tank far from the target density gives a large tank reading, and that
     is arithmetic rather than a mistake — but it looks like one. Ballasting a
     seawater vehicle in a fresh tank is ordinary practice and the scale then
     reads over a kilogram negative, which is alarming if nobody says why. */
  const tankGap = targetRho - tankRho;
  if (Number.isFinite(tankGap) && Math.abs(tankGap) > 2) {
    notes.push(
      `The tank is ${Math.abs(tankGap).toFixed(1)} kg/m³ `
      + `${tankGap > 0 ? 'lighter' : 'heavier'} than the target water, `
      + `so the expected tank reading is ${tankBuoyancy.toFixed(0)} g.`
    );
  }

  /* Which way the hull moves against the water is the thing operators most
     often have backwards, and it is decided by two comparisons rather than by
     a rule of thumb. Both are stated, at the target point, from the numbers
     actually in play. */
  if (Number.isFinite(targetRho)) {
    const dp = 100;
    const perHundred = (buoyancy(hull, mass, { ...target, p: target.p + dp })
      - buoyancy(hull, mass, target));
    notes.push(
      `The hull ${perHundred > 0 ? 'compresses less' : 'compresses more'} than the water: `
      + `${perHundred > 0 ? '+' : ''}${perHundred.toFixed(0)} g per 100 dbar of depth, `
      + 'at this temperature and salinity.'
    );
    const dt = 5;
    const perFive = (buoyancy(hull, mass, { ...target, t: target.t - dt })
      - buoyancy(hull, mass, target));
    notes.push(
      `Cooling by 5 °C changes buoyancy by ${perFive > 0 ? '+' : '−'}`
      + `${Math.abs(perFive).toFixed(0)} g.`
    );
  }

  return {
    tank: { density: tankRho, volume: tankVolume, buoyancy: tankBefore },
    ballastChange,
    tankBuoyancy,
    neutralDensity: targetRho,
    mass,
    readings,
    surfaceMargin,
    diveMargin,
    warnings,
    notes,
  };
}

export * from './vehicles.ts';
