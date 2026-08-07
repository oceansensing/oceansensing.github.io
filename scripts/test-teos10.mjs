#!/usr/bin/env node
/**
 * The TEOS-10 package, checked against the standard it claims to implement.
 *
 *   npm run test:teos10
 *
 * Needs no build, no jsdom and no network: `packages/teos10` imports neither
 * Leaflet nor the DOM, so this loads the TypeScript through Node's own type
 * stripping and calls the functions.
 *
 * It has three kinds of check, and the second is the one that does the real
 * work:
 *
 * 1. **Against the reference.** `scripts/fixtures/teos10/reference.json` holds
 *    what GSW says at twenty-four points spanning the domain. This anchors
 *    the value of every function.
 *
 * 2. **Against calculus.** Every derivative branch of the Gibbs function is
 *    checked against a central difference of the branch below it, over a few
 *    thousand points. `g_TT` has to be the temperature derivative of `g_T`,
 *    and `g_T` the temperature derivative of `g`; a mistyped coefficient in
 *    any branch breaks that chain at the point it sits in, wherever that is.
 *    The fixture cannot do this -- twenty-four points is coverage of the
 *    branches, not of the space -- and the reference implementation is not
 *    needed for it, because the claim is internal.
 *
 * 3. **Against physics.** Anchors nobody has to look up: pure water is
 *    densest at 3.98 degC, sound travels at about 1500 m/s, seawater freezes
 *    near -1.9 degC. These would not catch a subtle coefficient error and
 *    they would catch a catastrophic one, which is what they are for.
 *
 * Plus the round trips, the atlas, and `evaluate`'s promise never to report
 * Reference Salinity under the name Absolute Salinity.
 *
 * MUTATION-TESTED, AND WHAT IT CANNOT SEE
 * ---------------------------------------
 * Every realistic transcription error was planted and caught: a transposed
 * pair of digits ten places into a coefficient, a dropped digit, a flipped
 * sign, the `log(x)` guard disabled, a constant off in its last digit, a sign
 * error in the ice arithmetic, and the whole atlas zeroed.
 *
 * What it does not catch is a change in a coefficient's *last* digit, and
 * that is a limit worth stating rather than papering over: 1e-15 of a
 * coefficient that is then multiplied by a normalised pressure changes the
 * answer by less than the order the terms are summed in does. There is no
 * threshold that sees it and passes correct code.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

import {
  CP0, DB2PA, OFFSET, SFAC, SSO, T0, UPS,
} from '../packages/teos10/constants.ts';
import { gibbs } from '../packages/teos10/gibbs.ts';
import { enthalpyIce, gibbsIce } from '../packages/teos10/gibbs-ice.ts';
import {
  chemPotentialWater, density, dilutionCoefficient, enthalpy, entropy,
  freezingTemperature, halineContraction, heatCapacity,
  isentropicCompressibility, isothermalCompressibility, latentHeatEvaporation,
  latentHeatMelting, potentialDensity, potentialEnthalpy, soundSpeed,
  specificVolume, spiciness0, spiciness1, spiciness2, thermalExpansion,
} from '../packages/teos10/properties.ts';
import {
  ctFromPT, ctFromT, ctMaxDensity, ptFromCT, ptFromT, pt0FromT, tFromCT,
  tMaxDensity,
} from '../packages/teos10/temperature.ts';
import {
  cFromSP, deltaSA, saFromSP, saFromSstar, spFromC, spFromSA, srFromSP,
  sstarFromSA, sstarFromSP,
} from '../packages/teos10/salinity.ts';
import { gravity, pressureFromDepth, zFromP } from '../packages/teos10/depth.ts';
import { decodeAtlas } from '../packages/teos10/atlas.ts';
import { evaluate } from '../packages/teos10/index.ts';

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
};

/**
 * Compare a list against the reference.
 *
 * The tolerance is relative, with a floor at a hundredth of the list's own
 * largest value -- because several of these quantities pass through zero.
 * The Gibbs function is 1.4e-6 J/kg at one sample, from terms of 1e5; the
 * freezing point of pure water is 0 by definition. At those points a
 * difference of 1e-16 is the last bit of a double, and dividing by the answer
 * turns it into an apparent error of 1e-10. Judging small values against the
 * scale of the list they sit in is the standard way round that, and it still
 * asks for thirteen significant figures of the largest value.
 */
const RTOL = 1e-11;
function against(what, want, got, rtol = RTOL) {
  const scale = Math.max(...want.map((v) => (v === null ? 0 : Math.abs(v))));
  let worst = 0;
  let worstAt = 0;
  let mismatched = 0;
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const g = got[i];
    if (w === null) {
      if (Number.isFinite(g)) mismatched++;
      continue;
    }
    if (!Number.isFinite(g)) { mismatched++; continue; }
    const err = Math.abs(g - w) / Math.max(Math.abs(w), scale * 1e-2);
    if (err > worst) { worst = err; worstAt = i; }
  }
  check(
    `${what} matches the reference at ${want.length} points`,
    mismatched === 0 && worst <= rtol,
    mismatched ? `${mismatched} disagree on being finite at all`
      : `worst ${worst.toExponential(2)} at sample ${worstAt}`
  );
}

// ---- 1. against the reference implementation ------------------------------

const ref = JSON.parse(fs.readFileSync('scripts/fixtures/teos10/reference.json', 'utf8'));
const S = ref.samples;
const map = (f) => S.map(([sa, t, p]) => f(sa, t, p));

console.log(`\n-- against GSW ${ref.gsw}, ${S.length} samples --`);

for (const [key, want] of Object.entries(ref.gibbs)) {
  const [ns, nt, np] = key.split('').map(Number);
  against(`gibbs(${ns},${nt},${np})`, want, map((sa, t, p) => gibbs(ns, nt, np, sa, t, p)));
}

for (const [key, want] of Object.entries(ref.gibbsIce)) {
  const [nt, np] = key.split('').map(Number);
  against(`gibbsIce(${nt},${np})`, want, ref.iceSamples.map(([t, p]) => gibbsIce(nt, np, t, p)));
}

const P = ref.properties;
against('enthalpyIce', P.enthalpyIce, ref.iceSamples.map(([t, p]) => enthalpyIce(t, p)));
against('density', P.density, map(density));
against('specificVolume', P.specificVolume, map(specificVolume));
against('enthalpy', P.enthalpy, map(enthalpy));
against('heatCapacity', P.heatCapacity, map(heatCapacity));
against('thermalExpansion', P.thermalExpansion, map(thermalExpansion));
against('halineContraction', P.halineContraction, map(halineContraction));
against('isentropicCompressibility', P.isentropicCompressibility, map(isentropicCompressibility));
against('soundSpeed', P.soundSpeed, map(soundSpeed));
against('chemPotentialWater', P.chemPotentialWater, map(chemPotentialWater));
against('dilutionCoefficient', P.dilutionCoefficient, map(dilutionCoefficient));
against('freezingTemperature', P.freezingTemperature, map((sa, t, p) => freezingTemperature(sa, p, 0)));
against('freezingTemperature (air-saturated)', P.freezingTemperatureSaturated,
  map((sa, t, p) => freezingTemperature(sa, p, 1)));
against('latentHeatMelting', P.latentHeatMelting, map((sa, t, p) => latentHeatMelting(sa, p)));
against('latentHeatEvaporation', P.latentHeatEvaporation,
  map((sa, t, p) => latentHeatEvaporation(sa, pt0FromT(sa, t, p))));
against('potentialDensity (0 dbar)', P.potentialDensity0, map((sa, t, p) => potentialDensity(sa, t, p, 0)));
against('potentialDensity (2000 dbar)', P.potentialDensity2000, map((sa, t, p) => potentialDensity(sa, t, p, 2000)));
against('spiciness0', P.spiciness0, map((sa, t, p) => spiciness0(sa, ctFromT(sa, t, p))));
against('spiciness1', P.spiciness1, map((sa, t, p) => spiciness1(sa, ctFromT(sa, t, p))));
against('spiciness2', P.spiciness2, map((sa, t, p) => spiciness2(sa, ctFromT(sa, t, p))));

const T = ref.temperature;
against('pt0FromT', T.pt0FromT, map(pt0FromT));
against('ptFromT (1000 dbar)', T.ptFromT1000, map((sa, t, p) => ptFromT(sa, t, p, 1000)));
against('ctFromT', T.ctFromT, map(ctFromT));
against('ctFromPT', T.ctFromPT, map((sa, t) => ctFromPT(sa, t)));
against('ptFromCT', T.ptFromCT, map((sa, t, p) => ptFromCT(sa, ctFromT(sa, t, p))));
against('tFromCT', T.tFromCT, map((sa, t, p) => tFromCT(sa, ctFromT(sa, t, p), p)));

const spGrid = S.map((_, i) => 1.0 + i * (60.0 - 1.0) / (S.length - 1));
const cGrid = S.map((_, i) => 0.5 + i * (42.0 - 0.5) / (S.length - 1));
const latGrid = S.map((_, i) => -80.0 + i * 160.0 / (S.length - 1));
against('spFromC', ref.salinity.spFromC, S.map(([, t, p], i) => spFromC(spGrid[i], t, p)));
against('cFromSP', ref.salinity.cFromSP, S.map(([, t, p], i) => cFromSP(cGrid[i], t, p)));
against('srFromSP', ref.salinity.srFromSP,
  S.map((_, i) => srFromSP(i * 42.0 / (S.length - 1))));
against('zFromP', ref.depth.zFromP, S.map(([, , p], i) => zFromP(p, latGrid[i])));
against('pressureFromDepth', ref.depth.pressureFromDepth,
  S.map(([, , p], i) => pressureFromDepth(-p / 1.02, latGrid[i])));
against('gravity', ref.depth.gravity,
  S.map(([, , p], i) => gravity(-90.0 + i * 180.0 / (S.length - 1), p)));

/* The maximum-density temperature is the one place this package deliberately
   answers differently: GSW finds it from the 75-term polynomial's alpha and
   this finds the exact root of g_TP, so they agree only to the polynomial's
   own accuracy. Checked at a tolerance that says so, and then checked against
   its own definition below, which is the stronger statement. */
{
  /* ...and only where GSW's polynomial is inside its funnel. Deep down it is
     not: at SA 42 and 10,000 dbar the state GSW returns has an exact thermal
     expansion of -1.5e-4 rather than zero, so the two answers are 8 degC
     apart and it is the polynomial that has left the building. Comparing
     there would be asserting that this package reproduces an extrapolation
     error. Shallow, they agree to a few hundredths, and the exact statement
     -- that alpha vanishes at the answer -- is checked below over the whole
     grid to 1e-15. */
  let worst = 0;
  let n = 0;
  for (let i = 0; i < S.length; i++) {
    const want = T.ctMaxDensity[i];
    if (want === null || S[i][2] > 1000) continue;
    n++;
    worst = Math.max(worst, Math.abs(ctMaxDensity(S[i][0], S[i][2]) - want));
  }
  check(`the density maximum agrees with GSW's polynomial above 1000 dbar (${n} samples)`,
    worst < 0.05, `worst ${worst.toExponential(2)} degC`);
}

// ---- 2. against calculus -------------------------------------------------
//
// Each derivative branch against a central difference of the branch below it.
// This is what covers the space the fixture cannot.

console.log('\n-- every derivative branch against a central difference of the one below --');

const DERIV_GRID = [];
for (const sa of [0.5, 5, 15, 25, 35.16504, 40]) {
  for (const t of [-1, 5, 12, 20, 30, 38]) {
    for (const p of [0, 50, 400, 1500, 4000, 8000]) DERIV_GRID.push([sa, t, p]);
  }
}

/* Step sizes: large enough that the difference is not lost to rounding, small
   enough that the O(h^2) truncation stays below the threshold. Both bounds
   were measured -- ten times either way fails. */
const H = { sa: 1e-3, t: 1e-2, p: 1.0 };

function differencing(name, lower, upper, axis) {
  const h = H[axis];
  /* gibbs returns pressure derivatives per *pascal* while its argument is in
     decibars, so a difference taken in decibars is 1e4 times too large and
     has to be divided down. Getting this backwards is a factor of 1e8, which
     is how it was caught: the first version multiplied. */
  const scale = axis === 'p' ? 1 / DB2PA : 1;
  let worst = 0;
  let worstAt = null;
  for (const [sa, t, p] of DERIV_GRID) {
    if (axis === 'sa' && sa - h <= 0) continue;
    const at = (d) => lower(
      axis === 'sa' ? sa + d : sa,
      axis === 't' ? t + d : t,
      axis === 'p' ? p + d : p
    );
    const fd = (at(h) - at(-h)) / (2 * h) * scale;
    const exact = upper(sa, t, p);
    const err = Math.abs(fd - exact) / Math.max(Math.abs(exact), 1e-30);
    if (err > worst) { worst = err; worstAt = [sa, t, p]; }
  }
  check(`${name} is the ${axis} derivative of the branch below it`,
    worst < 1e-5,
    `worst ${worst.toExponential(2)}${worst > 1e-5 ? ` at ${worstAt}` : ''} over ${DERIV_GRID.length} points`);
}

const g = (ns, nt, np) => (sa, t, p) => gibbs(ns, nt, np, sa, t, p);
differencing('g_SA', g(0, 0, 0), g(1, 0, 0), 'sa');
differencing('g_T', g(0, 0, 0), g(0, 1, 0), 't');
differencing('g_P', g(0, 0, 0), g(0, 0, 1), 'p');
differencing('g_SA_SA', g(1, 0, 0), g(2, 0, 0), 'sa');
differencing('g_T_T', g(0, 1, 0), g(0, 2, 0), 't');
differencing('g_P_P', g(0, 0, 1), g(0, 0, 2), 'p');
differencing('g_SA_T', g(1, 0, 0), g(1, 1, 0), 't');
differencing('g_SA_P', g(1, 0, 0), g(1, 0, 1), 'p');
differencing('g_T_P', g(0, 1, 0), g(0, 1, 1), 'p');

/* The same for ice, which has its own standard and its own arithmetic -- and
   where a sign error in the complex expansion would be invisible in the value
   and glaring in the derivative. */
{
  const ICE_GRID = [];
  for (const t of [-40, -25, -12, -4, -0.5]) for (const p of [0, 200, 2000, 8000]) ICE_GRID.push([t, p]);
  const ice = (nt, np) => (t, p) => gibbsIce(nt, np, t, p);
  const diffIce = (name, lower, upper, axis, h) => {
    const scale = axis === 'p' ? 1 / DB2PA : 1;
    let worst = 0;
    for (const [t, p] of ICE_GRID) {
      const at = (d) => lower(axis === 't' ? t + d : t, axis === 'p' ? p + d : p);
      const fd = (at(h) - at(-h)) / (2 * h) * scale;
      const exact = upper(t, p);
      worst = Math.max(worst, Math.abs(fd - exact) / Math.max(Math.abs(exact), 1e-30));
    }
    check(`ice ${name} is the ${axis} derivative of the branch below it`,
      worst < 1e-5, `worst ${worst.toExponential(2)}`);
  };
  diffIce('g_T', ice(0, 0), ice(1, 0), 't', 1e-2);
  diffIce('g_P', ice(0, 0), ice(0, 1), 'p', 1.0);
  diffIce('g_T_T', ice(1, 0), ice(2, 0), 't', 1e-2);
  diffIce('g_T_P', ice(1, 0), ice(1, 1), 'p', 1.0);
  diffIce('g_P_P', ice(0, 1), ice(0, 2), 'p', 1.0);
}

// ---- the properties, against their own definitions ------------------------

console.log('\n-- properties against the definitions they are built from --');

{
  const worstOf = (f) => {
    let worst = 0;
    for (const [sa, t, p] of DERIV_GRID) worst = Math.max(worst, Math.abs(f(sa, t, p)));
    return worst;
  };

  const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

  check('alpha is (1/v) dv/dt', worstOf((sa, t, p) => {
    const fd = (specificVolume(sa, t + 1e-2, p) - specificVolume(sa, t - 1e-2, p)) / 2e-2;
    return rel(fd / specificVolume(sa, t, p), thermalExpansion(sa, t, p));
  }) < 1e-6);

  check('beta is -(1/v) dv/dSA', worstOf((sa, t, p) => {
    const fd = (specificVolume(sa + 1e-3, t, p) - specificVolume(sa - 1e-3, t, p)) / 2e-3;
    return rel(-fd / specificVolume(sa, t, p), halineContraction(sa, t, p));
  }) < 1e-6);

  check('isothermal compressibility is -(1/v) dv/dP at fixed t', worstOf((sa, t, p) => {
    const fd = (specificVolume(sa, t, p + 1) - specificVolume(sa, t, p - 1)) / 2 / DB2PA;
    return rel(-fd / specificVolume(sa, t, p), isothermalCompressibility(sa, t, p));
  }) < 1e-6);

  check('cp is T times dEta/dT', worstOf((sa, t, p) => {
    const fd = (entropy(sa, t + 1e-2, p) - entropy(sa, t - 1e-2, p)) / 2e-2;
    return rel((T0 + t) * fd, heatCapacity(sa, t, p));
  }) < 1e-6);

  /* Potential enthalpy has two definitions that must agree: CP0 times
     Conservative Temperature, and the enthalpy the parcel would have at the
     surface. One goes through a fitted polynomial and the other through the
     Gibbs function, so this is a real cross-check rather than an identity. */
  check('potential enthalpy is the enthalpy this parcel would have at the surface',
    worstOf((sa, t, p) => rel(enthalpy(sa, pt0FromT(sa, t, p), 0), potentialEnthalpy(sa, t, p))) < 1e-9);

  check('sound speed is v / sqrt(kappa v)', worstOf((sa, t, p) => {
    const v = specificVolume(sa, t, p);
    return rel(Math.sqrt(v / isentropicCompressibility(sa, t, p)), soundSpeed(sa, t, p));
  }) < 1e-12);

  check('the density maximum is where thermal expansion vanishes',
    worstOf((sa, t, p) => {
      const tmd = tMaxDensity(sa, p);
      return Number.isFinite(tmd) ? Math.abs(thermalExpansion(sa, tmd, p)) : 0;
    }) < 1e-15);
}

// ---- the round trips ------------------------------------------------------

console.log('\n-- round trips --');

{
  const worst = (label, f, tol) => {
    let w = 0;
    for (const [sa, t, p] of DERIV_GRID) w = Math.max(w, Math.abs(f(sa, t, p)));
    check(label, w < tol, `worst ${w.toExponential(2)}`);
  };
  worst('t -> CT -> t', (sa, t, p) => tFromCT(sa, ctFromT(sa, t, p), p) - t, 1e-9);
  worst('t -> pt -> t', (sa, t, p) => ptFromT(sa, ptFromT(sa, t, p, 500), 500, p) - t, 1e-9);
  worst('pt -> CT -> pt', (sa, t) => ptFromCT(sa, ctFromPT(sa, t)) - t, 1e-9);
  worst('SP -> C -> SP', (sa, t, p) => spFromC(cFromSP(sa, t, p), t, p) - sa, 1e-9);
  worst('p -> z -> p', (sa, t, p) => pressureFromDepth(zFromP(p, 45), 45) - p, 1e-8);
}

// ---- 3. against physics ---------------------------------------------------

console.log('\n-- anchors nobody has to look up --');

{
  /* Pure water is densest at 3.98 degC and 999.972 kg/m^3 -- the definition
     of the litre until 1964, and the most-quoted number in the subject. */
  const tmd = tMaxDensity(0, 0);
  check('pure water is densest at 3.98 degC', Math.abs(tmd - 3.98) < 0.01, `${tmd.toFixed(4)} degC`);
  const rhoMax = density(0, tmd, 0);
  check('and at 999.9749 kg/m3', Math.abs(rhoMax - 999.9749) < 0.001, `${rhoMax.toFixed(4)}`);

  const rho25 = density(0, 25, 0);
  check('pure water at 25 degC is 997.047 kg/m3', Math.abs(rho25 - 997.047) < 0.001, `${rho25.toFixed(4)}`);

  /* sigma_t of Standard Seawater at 25 degC: the number every textbook
     table opens with. */
  const sigma = density(SSO, 25, 0) - 1000;
  check('Standard Seawater at 25 degC has sigma 23.343', Math.abs(sigma - 23.343) < 0.002, `${sigma.toFixed(4)}`);

  const tf = freezingTemperature(SSO, 0, 0);
  check('Standard Seawater freezes at -1.919 degC', Math.abs(tf + 1.919) < 0.002, `${tf.toFixed(4)}`);

  const c = soundSpeed(SSO, 25, 0);
  check('sound at 25 degC and the surface is 1534 m/s', Math.abs(c - 1534) < 1, `${c.toFixed(2)}`);

  const cp = heatCapacity(SSO, 25, 0);
  check('its heat capacity is 3999 J/(kg K)', Math.abs(cp - 3998.98) < 0.05, `${cp.toFixed(2)}`);
  check('which is not cp0, and must not be', Math.abs(cp - CP0) > 5,
    `${(cp - CP0).toFixed(2)} J/(kg K) apart`);

  /* Conservative Temperature equals in-situ temperature at the surface only
     where the parcel is at the reference state; the interesting claim is that
     it differs from potential temperature by less than a degree but not by
     zero, which is the whole reason it exists. */
  const dct = ctFromPT(35, 30) - 30;
  check('CT differs from pt by a few hundredths at 30 degC', Math.abs(dct) > 0.01 && Math.abs(dct) < 1,
    `${dct.toFixed(4)} degC`);

  check('cp0 is the defined constant, not a measured one', CP0 === 3991.86795711963);
  check('SSO, UPS, SFAC and OFFSET are the published values',
    SSO === 35.16504 && UPS === SSO / 35 && SFAC === 0.0248826675584615
    && OFFSET === 5.971840214030754e-1);
}

// ---- the salinity anomaly atlas -------------------------------------------

console.log('\n-- the Absolute Salinity Anomaly atlas --');

{
  const gz = fs.readFileSync('public/teos10/saar.bin.gz');
  const raw = zlib.gunzipSync(gz);
  const atlas = decodeAtlas(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

  const A = ref.atlas;
  const Q = ref.positions;
  /* The shipped atlas is quantised to 1e-7 in the ratio, so agreement is
     bounded by half a quantum rather than by machine precision -- 1.8e-6 g/kg
     in Absolute Salinity, four orders below the last digit the page prints.
     The tolerance states that budget rather than hiding it. */
  const QUANTUM = 1e-7;
  const near = (label, want, got, tol) => {
    let worst = 0;
    let missing = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] === null) continue;
      if (!Number.isFinite(got[i])) { missing++; continue; }
      worst = Math.max(worst, Math.abs(got[i] - want[i]));
    }
    check(`${label} matches the reference at ${want.length} positions`,
      missing === 0 && worst <= tol,
      missing ? `${missing} came back with no answer` : `worst ${worst.toExponential(2)}`);
  };

  near('SAAR', A.saar, Q.map(([, p, lon, lat]) => atlas.saar(p, lon, lat)), QUANTUM / 2);
  near('saFromSP', A.saFromSP, Q.map(([sp, p, lon, lat]) => saFromSP(sp, p, lon, lat, atlas)), 2e-6);
  near('spFromSA', A.spFromSA,
    Q.map(([sp, p, lon, lat], i) => spFromSA(A.saFromSP[i], p, lon, lat, atlas)), 2e-6);
  near('sstarFromSP', A.sstarFromSP, Q.map(([sp, p, lon, lat]) => sstarFromSP(sp, p, lon, lat, atlas)), 2e-6);
  /* S* multiplies the anomaly by about 1.35 SA, so it carries a larger share
     of the quantisation than SA does: 5e-8 x 1.35 x 35 is 2.4e-6 g/kg, and
     the tolerance states that budget rather than being widened until it
     passed. */
  near('sstarFromSA', A.sstarFromSA,
    Q.map(([, p, lon, lat], i) => sstarFromSA(A.saFromSP[i], p, lon, lat, atlas)), 3e-6);
  near('saFromSstar', A.saFromSstar,
    Q.map(([, p, lon, lat], i) => saFromSstar(A.sstarFromSP[i], p, lon, lat, atlas)), 3e-6);
  near('deltaSA', A.deltaSA, Q.map(([sp, p, lon, lat]) => deltaSA(sp, p, lon, lat, atlas)), 2e-6);

  /* The anomaly's whole justification is that it is not negligible. If the
     North Pacific correction ever came back as zero the atlas would be
     loading, decoding and interpolating a table of nothing. */
  const pacific = saFromSP(35, 2000, 200, 30, atlas) - srFromSP(35);
  check('the North Pacific anomaly is the ~0.02 g/kg it is supposed to be',
    pacific > 0.015 && pacific < 0.03, `${pacific.toFixed(5)} g/kg`);

  /* The Baltic has its own rule and does not consult the atlas at all, so it
     must still answer with no atlas passed. */
  const baltic = saFromSP(8, 5, 20, 60, null);
  check('the Baltic rule works without the atlas', Math.abs(baltic - 8.1048) < 0.001, `${baltic.toFixed(4)}`);
  check('and it is not the ordinary SR', Math.abs(baltic - srFromSP(8)) > 0.05,
    `${(baltic - srFromSP(8)).toFixed(4)} g/kg apart`);
}

// ---- what evaluate() promises ---------------------------------------------

console.log('\n-- evaluate() --');

{
  const base = {
    salinityKind: 'SP', salinity: 35,
    temperatureKind: 't', temperature: 10,
    pressureKind: 'p', pressure: 1000,
  };
  const row = (r, key) => r.groups.flatMap((g) => g.rows).find((q) => q.key === key);

  /* The one promise this package makes beyond arithmetic: with no position it
     must not report Reference Salinity under the name Absolute Salinity
     without saying so. Both halves are checked -- the number *and* the note --
     because reporting the right number silently is exactly the failure. */
  const bare = evaluate(base);
  check('with no position, SA is exactly SR', row(bare, 'SA').value === row(bare, 'SR').value);
  check('and it says so', bare.notes.some((n) => /Reference Salinity/.test(n)));
  check('and the anomaly is not claimed', bare.anomalyApplied === false);

  const gz = fs.readFileSync('public/teos10/saar.bin.gz');
  const raw = zlib.gunzipSync(gz);
  const atlas = decodeAtlas(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const placed = evaluate({ ...base, lon: 200, lat: 30, atlas });
  check('with a position, SA is not SR', row(placed, 'SA').value !== row(placed, 'SR').value);
  check('and the anomaly is reported', placed.anomalyApplied === true
    && Math.abs(row(placed, 'dSA').value - (placed.sa - row(placed, 'SR').value)) < 1e-12);

  /* Conductivity and Conservative Temperature is a legitimate pair and a
     circular one -- SP needs t, t needs SA, SA needs SP. The fixed point has
     to close, and closing on the wrong number would look fine. */
  const viaC = evaluate({
    ...base, salinityKind: 'C', salinity: cFromSP(35, 10, 1000),
    temperatureKind: 'CT', temperature: ctFromT(srFromSP(35), 10, 1000),
  });
  check('conductivity with a Conservative Temperature resolves to the same water',
    Math.abs(row(viaC, 'SP').value - 35) < 1e-8 && Math.abs(viaC.t - 10) < 1e-8,
    `SP ${row(viaC, 'SP').value.toFixed(9)}, t ${viaC.t.toFixed(9)}`);

  const frozen = evaluate({ ...base, temperature: -3 });
  check('water below its freezing point is flagged',
    frozen.warnings.some((w) => /freezing point/.test(w)));

  const briny = evaluate({ ...base, salinity: 60 });
  check('salinity past the fitted range is flagged',
    briny.warnings.some((w) => /outside the range/.test(w)));

  const deep = evaluate({ ...base, pressureKind: 'z', pressure: 1000 });
  check('a depth with no latitude says which latitude it assumed',
    deep.notes.some((n) => /equator/.test(n)));
  check('and a depth at 45 degrees is not the same pressure as at the equator',
    Math.abs(evaluate({ ...base, pressureKind: 'z', pressure: 5000, lat: 60 }).p
      - evaluate({ ...base, pressureKind: 'z', pressure: 5000, lat: 0 }).p) > 20);

  /* IPTS-68 is a real conversion, not a relabel: 0.01 degC at 40 degC. */
  const old = evaluate({ ...base, temperatureKind: 't68', temperature: 40 });
  check('IPTS-68 temperatures are converted', Math.abs(old.t - 40 / 1.00024) < 1e-12);

  check('every row has a unit or is deliberately dimensionless',
    bare.groups.every((grp) => grp.rows.every((q) => typeof q.unit === 'string')));
  check('every row has a label and a key',
    bare.groups.every((grp) => grp.rows.every((q) => q.label.length > 0 && q.key.length > 0)));
  const keys = bare.groups.flatMap((grp) => grp.rows.map((q) => q.key));
  check('no two rows share a key', new Set(keys).size === keys.length, `${keys.length} rows`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
