/**
 * TEOS-10 seawater properties, from one call.
 *
 * `evaluate` takes whatever a reader actually has — a conductivity and an
 * in-situ temperature, or an Absolute Salinity and a Conservative
 * Temperature, at a pressure or a depth — resolves it to the (SA, t, p) the
 * Gibbs function wants, and reports everything that follows.
 *
 * Two things it will not do, both deliberately:
 *
 * - **It never silently substitutes.** Absolute Salinity without a position
 *   is Reference Salinity wearing SA's name, and the difference is the entire
 *   reason TEOS-10 replaced EOS-80. So when the anomaly is unavailable the
 *   result says which salinity it actually used, in `notes`, and the page
 *   shows it.
 * - **It reports out-of-range rather than clamping.** The standard is fitted
 *   over a stated domain; outside it the polynomials still return numbers,
 *   and those numbers are not seawater.
 *
 * No DOM and no fetch here or anywhere below it, apart from `atlas.ts`, whose
 * one network call is passed in.
 */

import { CP0, DB2PA, SSO, UPS } from './constants.ts';
import { depthFromPressure, gravity, pressureFromDepth, zFromP } from './depth.ts';
import {
  chlorinity, cFromSP, deltaSA, saFromSP, saFromSstar, spFromC, spFromSA,
  spFromSK, spFromSR, srFromSP, sstarFromSA,
  type Anomaly,
} from './salinity.ts';
import {
  ctFromPT, ctFromT, ptFromCT, ptFromT, pt0FromT, tFromCT, tMaxDensity,
} from './temperature.ts';
import {
  adiabaticLapseRate, chemPotentialSalt, chemPotentialWater, density,
  dilutionCoefficient, enthalpy, entropy, freezingCT, freezingTemperature,
  gibbsEnergy, halineContraction, heatCapacity, helmholtzEnergy, internalEnergy,
  isentropicCompressibility, isothermalCompressibility, latentHeatEvaporation,
  latentHeatMelting, potentialDensity, potentialEnthalpy, soundSpeed,
  specificVolume, specificVolumeAnomaly, spiciness0, spiciness1, spiciness2,
  thermalExpansion,
} from './properties.ts';

export * from './constants.ts';
export * from './contour.ts';
export * from './depth.ts';
export * from './gibbs.ts';
export * from './gibbs-ice.ts';
export * from './properties.ts';
export * from './salinity.ts';
export * from './temperature.ts';
export { ATLAS_URL, decodeAtlas, loadAtlas, SalinityAtlas } from './atlas.ts';

/** Which salinity variable the reader is supplying. */
export type SalinityKind = 'SP' | 'SA' | 'SR' | 'Sstar' | 'C' | 'R' | 'SK';

/** Which temperature. `t68` is IPTS-68, for data archived before 1990. */
export type TemperatureKind = 't' | 't68' | 'pt' | 'CT';

/** Sea pressure, or depth in metres positive downwards. */
export type PressureKind = 'p' | 'z';

export interface Input {
  salinityKind: SalinityKind;
  salinity: number;
  temperatureKind: TemperatureKind;
  temperature: number;
  pressureKind: PressureKind;
  pressure: number;
  /** Reference pressure for a potential temperature, in or out. */
  ptRef?: number;
  /** Degrees east and north. Both are needed for the salinity anomaly. */
  lon?: number;
  lat?: number;
  atlas?: Anomaly | null;
}

export interface Quantity {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** Decimal places to show. Chosen per quantity, not per magnitude. */
  digits: number;
  /** Shown on hover and in the exported table. */
  note?: string;
}

export interface Group {
  title: string;
  rows: Quantity[];
}

export interface Result {
  /** Absolute Salinity actually used, g/kg. NaN if the input was unusable. */
  sa: number;
  /** In-situ temperature actually used, degrees C on ITS-90. */
  t: number;
  /** Sea pressure actually used, dbar. */
  p: number;
  lat: number;
  lon: number;
  /** True when SA is the measured Absolute Salinity rather than SR. */
  anomalyApplied: boolean;
  /** Everything worth saying about how the inputs were read. */
  notes: string[];
  /** Statements that make the numbers untrustworthy rather than merely odd. */
  warnings: string[];
  groups: Group[];
}

/* The domain IAPWS-08 is fitted over. Outside it the Gibbs function still
   returns numbers, and they are an extrapolation of a fit rather than a
   property of seawater — so this warns and does not clamp. */
const SA_MAX = 42;
const P_MAX = 10000;
const T_MAX = 40;

/** PSS-78 is defined over this range; the Hill extension reaches down to 0. */
const SP_MIN = 2;
const SP_MAX = 42;

const nz = (x: number): number => (Number.isFinite(x) ? x : NaN);

/**
 * Resolve the reader's inputs to (SA, t, p).
 *
 * The three are coupled: a conductivity needs an in-situ temperature to give
 * Practical Salinity, a Conservative Temperature needs an Absolute Salinity
 * to give in-situ temperature, and Absolute Salinity needs Practical
 * Salinity. Whichever pair the reader supplies, one of those loops closes.
 *
 * It is solved by fixed-point rather than by refusing the combination: the
 * dependence is weak — SA moves t by millikelvins — so five passes is far
 * past convergence, and it costs nothing measurable. The alternative was
 * telling a reader with a conductivity and a Conservative Temperature that
 * their data is not a valid combination, which it plainly is.
 */
function resolve(input: Input, p: number, lon: number, lat: number) {
  const atlas = input.atlas ?? null;
  const ptRef = input.ptRef ?? 0;
  let sa = NaN;
  let sp = NaN;
  let t = NaN;
  let anomalyApplied = false;

  // A seed good enough for the first temperature conversion.
  const seed = input.salinity;
  sa = input.salinityKind === 'SA' ? seed
    : input.salinityKind === 'SR' ? seed
    : input.salinityKind === 'Sstar' ? seed
    : input.salinityKind === 'SK' ? srFromSP(spFromSK(seed))
    : input.salinityKind === 'SP' ? srFromSP(seed)
    : SSO;

  for (let pass = 0; pass < 5; pass++) {
    // 1. temperature, given the salinity we have so far
    switch (input.temperatureKind) {
      case 't': t = input.temperature; break;
      /* IPTS-68 to ITS-90. The factor is exact by convention, not fitted —
         every pre-1990 archive needs it and it is 0.01 degC at 40 degC. */
      case 't68': t = input.temperature / 1.00024; break;
      case 'pt': t = ptFromT(sa, input.temperature, ptRef, p); break;
      case 'CT': t = tFromCT(sa, input.temperature, p); break;
    }

    // 2. Practical Salinity, given that temperature
    switch (input.salinityKind) {
      case 'SP': sp = input.salinity; break;
      case 'SK': sp = spFromSK(input.salinity); break;
      case 'C': sp = spFromC(input.salinity, t, p); break;
      /* A conductivity *ratio* is against C(35, 15, 0), which is what a
         salinometer reports and what PSS-78 is actually defined on. */
      case 'R': sp = spFromC(input.salinity * 42.914, t, p); break;
      case 'SR': sp = spFromSR(input.salinity); break;
      case 'SA': sp = spFromSA(input.salinity, p, lon, lat, atlas); break;
      case 'Sstar': sp = NaN; break;
    }

    // 3. Absolute Salinity
    if (input.salinityKind === 'SA') {
      sa = input.salinity;
      anomalyApplied = Number.isFinite(sp);
    } else if (input.salinityKind === 'Sstar') {
      const fromStar = saFromSstar(input.salinity, p, lon, lat, atlas);
      anomalyApplied = Number.isFinite(fromStar);
      sa = anomalyApplied ? fromStar : input.salinity;
      sp = spFromSA(sa, p, lon, lat, atlas);
    } else if (input.salinityKind === 'SR') {
      sa = input.salinity;
      anomalyApplied = false;
    } else {
      const withAnomaly = saFromSP(sp, p, lon, lat, atlas);
      anomalyApplied = Number.isFinite(withAnomaly);
      sa = anomalyApplied ? withAnomaly : srFromSP(sp);
    }
  }

  /* SA is a mass fraction and cannot be negative. A tiny negative is what a
     near-zero conductivity gives through PSS-78, and it is a real reading of
     fresh water rather than an error — so it is floored here and the value
     the reader typed is still what the salinity rows report. */
  if (Number.isFinite(sa) && sa < 0) sa = 0;

  return { sa, sp, t, anomalyApplied, ptRef };
}

/** Every TEOS-10 property of one water sample. */
export function evaluate(input: Input): Result {
  const notes: string[] = [];
  const warnings: string[] = [];

  const lon = nz(input.lon ?? NaN);
  const lat = nz(input.lat ?? NaN);
  const positioned = Number.isFinite(lon) && Number.isFinite(lat);

  /* Depth needs a latitude, because gravity does. Without one the equator is
     assumed, which is the largest of the assumptions this page makes: about
     5 m at 5000 dbar between there and 60 degrees. So it is said out loud. */
  const gLat = Number.isFinite(lat) ? lat : 0;
  const p = input.pressureKind === 'p'
    ? input.pressure
    : pressureFromDepth(-Math.abs(input.pressure), gLat);
  if (input.pressureKind === 'z' && !Number.isFinite(lat)) {
    notes.push('Depth converted to pressure at the equator — enter a latitude to correct for gravity.');
  }

  const { sa, sp, t, anomalyApplied, ptRef } = resolve(input, p, lon, lat);

  if (!positioned && input.salinityKind !== 'SA' && input.salinityKind !== 'SR') {
    notes.push('No position, so Absolute Salinity is Reference Salinity — enter one to apply the anomaly.');
  } else if (positioned && !anomalyApplied && input.salinityKind !== 'SR') {
    notes.push('That position is outside the anomaly atlas, so Absolute Salinity is Reference Salinity.');
  } else if (anomalyApplied && input.salinityKind !== 'SA') {
    const d = sa - srFromSP(sp);
    if (Number.isFinite(d)) {
      notes.push(`Absolute Salinity carries a composition anomaly of ${d >= 0 ? '+' : ''}${d.toFixed(4)} g/kg.`);
    }
  }

  if (!Number.isFinite(sa) || !Number.isFinite(t) || !Number.isFinite(p)) {
    warnings.push('Those inputs do not describe a water sample.');
  } else {
    if (sa > SA_MAX) warnings.push(`Absolute Salinity above ${SA_MAX} g/kg is outside the range TEOS-10 is fitted over.`);
    if (p > P_MAX || p < 0) warnings.push(`Sea pressure outside 0 to ${P_MAX} dbar is outside the range TEOS-10 is fitted over.`);
    if (t > T_MAX) warnings.push(`Temperature above ${T_MAX} °C is outside the range TEOS-10 is fitted over.`);
    const tf = freezingTemperature(sa, p, 0);
    if (t < tf) warnings.push(`This water is ${(tf - t).toFixed(2)} °C below its freezing point of ${tf.toFixed(3)} °C.`);
    if ((input.salinityKind === 'C' || input.salinityKind === 'R') && (sp < SP_MIN || sp > SP_MAX)) {
      notes.push(sp < SP_MIN
        ? `Practical Salinity below ${SP_MIN} uses the Hill et al. (1986) extension to PSS-78.`
        : `Practical Salinity above ${SP_MAX} is outside PSS-78.`);
    }
  }

  const groups = build(sa, sp, t, p, gLat, lon, lat, ptRef, positioned, input.atlas ?? null);
  return { sa, t, p, lat, lon, anomalyApplied, notes, warnings, groups };
}

function build(
  sa: number, sp: number, t: number, p: number, gLat: number,
  lon: number, lat: number, ptRef: number, positioned: boolean, atlas: Anomaly | null
): Group[] {
  const pt0 = pt0FromT(sa, t, p);
  const ct = ctFromT(sa, t, p);
  const rho = density(sa, t, p);
  const alpha = thermalExpansion(sa, t, p);
  const beta = halineContraction(sa, t, p);
  const sigma = (pRef: number) => potentialDensity(sa, t, p, pRef) - 1000.0;

  const q = (key: string, label: string, value: number, unit: string, digits: number, note?: string): Quantity =>
    ({ key, label, value, unit, digits, note });

  return [
    {
      title: 'Salinity',
      rows: [
        q('SP', 'Practical Salinity', sp, '', 4, 'PSS-78 — what a CTD measures. Dimensionless by construction.'),
        q('SA', 'Absolute Salinity', sa, 'g/kg', 4, 'The salinity the equation of state uses. SR plus the measured composition anomaly.'),
        q('SR', 'Reference Salinity', srFromSP(sp), 'g/kg', 4, 'SP on a mass basis, with Standard Seawater composition assumed.'),
        q('Sstar', 'Preformed Salinity', sstarFromSA(sa, p, lon, lat, atlas), 'g/kg', 4, 'The conservative salinity: what SA was before biogeochemistry changed it.'),
        q('dSA', 'Salinity anomaly', positioned ? deltaSA(sp, p, lon, lat, atlas) : NaN, 'g/kg', 5, 'SA − SR. Reaches 0.03 g/kg in the North Pacific.'),
        q('C', 'Conductivity', cFromSP(sp, t, p), 'mS/cm', 4, 'At the in-situ temperature and pressure.'),
        q('R', 'Conductivity ratio', cFromSP(sp, t, p) / 42.914, '', 6, 'Against C(35, 15 °C, 0 dbar) = 42.914 mS/cm.'),
        q('Cl', 'Chlorinity', chlorinity(sp), 'g/kg', 4, 'SP / 1.80655, the historical definition.'),
      ],
    },
    {
      title: 'Temperature',
      rows: [
        q('t', 'In-situ temperature', t, '°C', 4, 'ITS-90. What a thermometer at depth reads.'),
        q('pt0', 'Potential temperature', pt0, '°C', 4, 'Referenced to the surface. Removes the warming from compression.'),
        q('pt', `Potential temperature (${ptRef} dbar)`, ptFromT(sa, t, p, ptRef), '°C', 4, 'Referenced to the pressure you chose.'),
        q('CT', 'Conservative Temperature', ct, '°C', 4, 'Potential enthalpy divided by cp0. Conserved about a hundred times better than pt.'),
        q('t68', 'In-situ temperature (IPTS-68)', t * 1.00024, '°C', 4, 'For comparison with data archived before 1990.'),
        q('tf', 'Freezing temperature', freezingTemperature(sa, p, 0), '°C', 4, 'Air-free, at this pressure. Where the chemical potential of water equals that of ice.'),
        q('CTf', 'Freezing temperature (CT)', freezingCT(sa, p, 0), '°C', 4),
        q('tmd', 'Temperature of maximum density', tMaxDensity(sa, p), '°C', 4, 'Below the freezing point above about SA 24 g/kg, which is why the open ocean does not overturn like a lake.'),
      ],
    },
    {
      title: 'Pressure and depth',
      rows: [
        q('p', 'Sea pressure', p, 'dbar', 3, 'Absolute pressure less one standard atmosphere.'),
        q('z', 'Height', zFromP(p, gLat), 'm', 3, 'Negative in the ocean, as TEOS-10 defines it.'),
        q('depth', 'Depth', depthFromPressure(p, gLat), 'm', 3, 'The same number said the way people say it.'),
        /* The latitude is in the label, not only in the note. Gravity varies
           by half a percent from the equator to the pole, so "Gravity" alone
           is a number whose meaning is off-screen -- and a note is a tooltip,
           which does not exist on a touchscreen. It is also the only place
           the page says out loud that it fell back to the equator when no
           position was given. */
        q('grav', `Gravity at ${Math.abs(gLat).toFixed(1)}°${gLat < 0 ? 'S' : 'N'}`,
          gravity(gLat, p), 'm/s²', 6,
          positioned ? 'At the latitude you gave, and this pressure.'
            : 'No latitude given, so the equator is assumed.'),
      ],
    },
    {
      title: 'Density',
      rows: [
        /* "In-situ", not just "Density", and the word is load-bearing: this
           row sits beside σ₀ and a reader will try to subtract 1000 from one
           to get the other. They differ by the compression of the water above
           the parcel — 4.2 kg/m³ at 1000 dbar — and nothing but this word
           says so before the subtraction is attempted. Reported as a bug in
           the numbers, which is what a label that needs explaining looks
           like from outside. */
        q('rho', 'In-situ density', rho, 'kg/m³', 5,
          'At this pressure, so it includes the compression. 1 / g_P, not a fitted polynomial.'),
        q('v', 'Specific volume', specificVolume(sa, t, p), 'm³/kg', 9),
        q('sigma0', 'σ₀', sigma(0), 'kg/m³', 5,
          'The parcel moved adiabatically to the surface, then density − 1000. '
          + 'Not the in-situ density less 1000 — decompressing it first is worth about 4 kg/m³ per 1000 dbar.'),
        q('sigma1', 'σ₁', sigma(1000), 'kg/m³', 5, 'Referenced to 1000 dbar.'),
        q('sigma2', 'σ₂', sigma(2000), 'kg/m³', 5, 'Referenced to 2000 dbar.'),
        q('sigma3', 'σ₃', sigma(3000), 'kg/m³', 5, 'Referenced to 3000 dbar.'),
        q('sigma4', 'σ₄', sigma(4000), 'kg/m³', 5, 'Referenced to 4000 dbar.'),
        q('delta', 'Specific volume anomaly', specificVolumeAnomaly(sa, t, p), 'm³/kg', 9, 'Against Standard Seawater at 0 °C and the same pressure.'),
        q('spice0', 'Spiciness (0 dbar)', spiciness0(sa, ct), 'kg/m³', 5, 'Across the T–S diagram, orthogonal to density: same weight, different water.'),
        q('spice1', 'Spiciness (1000 dbar)', spiciness1(sa, ct), 'kg/m³', 5),
        q('spice2', 'Spiciness (2000 dbar)', spiciness2(sa, ct), 'kg/m³', 5),
      ],
    },
    {
      title: 'Expansion and compressibility',
      rows: [
        q('alpha', 'Thermal expansion', alpha, '1/K', 9, 'With respect to in-situ temperature.'),
        q('beta', 'Haline contraction', beta, 'kg/g', 9, 'At constant in-situ temperature.'),
        q('alphaBeta', 'α / β', alpha / beta, 'g/(kg K)', 5, 'The slope of a density surface on a T–S diagram; sets the Turner angle.'),
        q('kappa', 'Isentropic compressibility', isentropicCompressibility(sa, t, p), '1/Pa', 13, 'What a sinking parcel feels, and what sets the sound speed.'),
        q('kappaT', 'Isothermal compressibility', isothermalCompressibility(sa, t, p), '1/Pa', 13, 'Larger — compressing at fixed temperature lets the heat out.'),
        q('lapse', 'Adiabatic lapse rate', adiabaticLapseRate(sa, t, p) * DB2PA, 'K/dbar', 9, 'How much a parcel warms per decibar of descent with no heat exchange.'),
      ],
    },
    {
      title: 'Energy, entropy and heat',
      rows: [
        q('cp', 'Isobaric heat capacity', heatCapacity(sa, t, p), 'J/(kg K)', 4),
        q('cp0', 'cp0', CP0, 'J/(kg K)', 8, 'The fixed constant that defines Conservative Temperature. Not a heat capacity of any real seawater.'),
        q('eta', 'Specific entropy', entropy(sa, t, p), 'J/(kg K)', 5),
        q('h', 'Specific enthalpy', enthalpy(sa, t, p), 'J/kg', 3),
        q('h0', 'Potential enthalpy', potentialEnthalpy(sa, t, p), 'J/kg', 3, 'Enthalpy the parcel would have at the surface. CT is this over cp0.'),
        q('u', 'Internal energy', internalEnergy(sa, t, p), 'J/kg', 3),
        q('g', 'Gibbs energy', gibbsEnergy(sa, t, p), 'J/kg', 5),
        q('f', 'Helmholtz energy', helmholtzEnergy(sa, t, p), 'J/kg', 5),
        q('muW', 'Chemical potential of water', chemPotentialWater(sa, t, p), 'J/kg', 4),
        q('muS', 'Chemical potential of sea salt', chemPotentialSalt(sa, t, p), 'J/g', 5),
        q('dilution', 'Dilution coefficient', dilutionCoefficient(sa, t, p), 'J/kg', 5, 'What it costs to dilute the parcel, which sets how a freshwater flux moves everything else.'),
      ],
    },
    {
      title: 'Sound and phase change',
      rows: [
        q('c', 'Sound speed', soundSpeed(sa, t, p), 'm/s', 4),
        q('Levap', 'Latent heat of evaporation', latentHeatEvaporation(sa, pt0), 'J/kg', 1, 'A surface quantity, taken at the potential temperature.'),
        q('Lmelt', 'Latent heat of melting', latentHeatMelting(sa, p), 'J/kg', 1, 'Ice into seawater at the freezing point. Needs both standards.'),
      ],
    },
  ];
}

/**
 * A quantity as text.
 *
 * The decision it makes is fixed against exponential, and it is made from the
 * *value* rather than from the quantity, because both are right for the same
 * row at different inputs: specific volume is 9.7e-4 in seawater and would be
 * printed as 0.000969525146 by a fixed rule, which is a number nobody can
 * read at a glance and which no longer lines up in a column.
 *
 * The threshold is a thousandth: below it, six significant figures in
 * exponential. Above it, the row's own `digits`, which is chosen per quantity
 * so that a column of them lines up rather than being scaled to whatever this
 * particular sample happens to be.
 *
 * Lives here rather than in the page so the screen, the clipboard, the CSV
 * and a second host all say the same thing.
 */
export function formatValue(q: Quantity): string {
  const v = q.value;
  if (!Number.isFinite(v)) return '—';
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e7)) {
    return v.toExponential(5).replace('e', '×10^').replace('^+', '^');
  }
  return v.toFixed(q.digits);
}

/** The resolved inputs, for a caller wanting the three numbers alone. */
export function state(input: Input): { sa: number; t: number; p: number } {
  const r = evaluate(input);
  return { sa: r.sa, t: r.t, p: r.p };
}

/** Every row, flattened — for CSV, the clipboard, and the batch table. */
export function rows(result: Result): Quantity[] {
  return result.groups.flatMap((g) => g.rows);
}

/* Re-exported so a caller needs one import for the common conversions. */
export { ctFromPT, ctFromT, ptFromCT, ptFromT, pt0FromT, tFromCT, UPS };
