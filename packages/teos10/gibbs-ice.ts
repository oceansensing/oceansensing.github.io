/**
 * TEOS-10: the Gibbs function of ice Ih (IAPWS-06).
 *
 * Its own standard and its own file. Seawater's Gibbs function is a real
 * polynomial; this one is a sum of two complex logarithmic terms, and the
 * published form is written in complex arithmetic because that is the form
 * the fit takes -- the imaginary parts cancel at the end, but only at the
 * end.
 *
 * The map's rule about dependencies applies here too: a complex-number
 * library for six operations on two constants would be a package to keep in
 * step forever, so the operations are inline below. Every one of them is
 * three lines.
 *
 * Needed for one thing the calculator reports and could not otherwise: the
 * freezing temperature, which is where the chemical potential of water in
 * seawater equals that of ice. That is a root of a function of *both*
 * standards, which is why they meet in `properties.ts` rather than here.
 *
 * The coefficients are transcribed from GSW-C's `gsw_oceanographic_toolbox.c`
 * and gated against the reference implementation by `npm run test:teos10`.
 */

import { DB2PA, T0 } from './constants.ts';

/** A complex number as a real pair. Only ever a local; nothing escapes. */
type C = readonly [number, number];

const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const sub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const scale = (r: number, a: C): C => [r * a[0], r * a[1]];

const div = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};

/** log of a complex number: log|z| + i arg z. */
const log = (a: C): C => [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1], a[0])];

/** Real r divided by complex a, which is the only mixed division needed. */
const rdiv = (r: number, a: C): C => div([r, 0], a);

/** The recurring `log((1 + w) / (1 - w))` of the published form. */
const logRatio = (w: C): C => log(div(add([1, 0], w), sub([1, 0], w)));

// ---- IAPWS-06 coefficients ------------------------------------------------

const t1: C = [3.68017112855051e-2, 5.10878114959572e-2];
const t2: C = [3.37315741065416e-1, 3.35449415919309e-1];
const r1: C = [4.47050716285388e1, 6.56876847463481e1];
const r20: C = [-7.25974574329220e1, -7.81008427112870e1];
const r21: C = [-5.57107698030123e-5, 4.64578634580806e-5];
const r22: C = [2.34801409215913e-11, -2.85651142904972e-11];

/** 1/Pt, where Pt = 611.657 Pa is the experimental triple-point pressure. */
const REC_PT = 1.634903221903779e-3;
/** Triple-point temperature, K. */
const TT = 273.16;
const REC_TT = 3.660858105139845e-3;

const g00 = -6.32020233335886e5;
const g01 = 6.55022213658955e-1;
const g02 = -1.89369929326131e-8;
const g03 = 3.3974612327105304e-15;
const g04 = -5.564648690589909e-22;
const s0 = -3.32733756492168e3;

/**
 * Specific Gibbs energy of ice Ih and its derivatives.
 *
 * `nt` and `np` are the orders of the derivative with respect to in-situ
 * temperature (degrees C, ITS-90) and sea pressure (dbar). Orders summing
 * above two are not defined and return NaN.
 */
export function gibbsIce(nt: number, np: number, t: number, p: number): number {
  const tau = (t + T0) * REC_TT;
  const dzi = DB2PA * p * REC_PT;

  if (nt === 0 && np === 0) {
    const tauT1 = rdiv(tau, t1);
    const sqTauT1 = mul(tauT1, tauT1);
    const tauT2 = rdiv(tau, t2);
    const sqTauT2 = mul(tauT2, tauT2);

    const g0 = g00 + dzi * (g01 + dzi * (g02 + dzi * (g03 + g04 * dzi)));
    const r2 = add(r20, scale(dzi, add(r21, scale(dzi, r22))));

    const g = add(
      mul(r1, add(scale(tau, logRatio(tauT1)), mul(t1, sub(log(sub([1, 0], sqTauT1)), sqTauT1)))),
      mul(r2, add(scale(tau, logRatio(tauT2)), mul(t2, sub(log(sub([1, 0], sqTauT2)), sqTauT2))))
    );

    return g0 - TT * (s0 * tau - g[0]);
  }

  if (nt === 1 && np === 0) {
    const tauT1 = rdiv(tau, t1);
    const tauT2 = rdiv(tau, t2);
    const r2 = add(r20, scale(dzi, add(r21, scale(dzi, r22))));

    const g = add(
      mul(r1, sub(logRatio(tauT1), scale(2.0, tauT1))),
      mul(r2, sub(logRatio(tauT2), scale(2.0, tauT2)))
    );

    return -s0 + g[0];
  }

  if (nt === 0 && np === 1) {
    const tauT2 = rdiv(tau, t2);
    const sqTauT2 = mul(tauT2, tauT2);

    const g0p = REC_PT * (g01 + dzi * (2.0 * g02 + dzi * (3.0 * g03 + 4.0 * g04 * dzi)));
    const r2p = scale(REC_PT, add(r21, scale(2.0 * dzi, r22)));

    const g = mul(r2p, add(scale(tau, logRatio(tauT2)), mul(t2, sub(log(sub([1, 0], sqTauT2)), sqTauT2))));

    return g0p + TT * g[0];
  }

  if (nt === 1 && np === 1) {
    const tauT2 = rdiv(tau, t2);
    const r2p = scale(REC_PT, add(r21, scale(2.0 * dzi, r22)));
    return mul(r2p, sub(logRatio(tauT2), scale(2.0, tauT2)))[0];
  }

  if (nt === 2 && np === 0) {
    const r2 = add(r20, scale(dzi, add(r21, scale(dzi, r22))));
    const term = (r: C, tk: C): C =>
      mul(r, sub(add(rdiv(1.0, sub(tk, [tau, 0])), rdiv(1.0, add(tk, [tau, 0]))), rdiv(2.0, tk)));
    return REC_TT * add(term(r1, t1), term(r2, t2))[0];
  }

  if (nt === 0 && np === 2) {
    const sqRecPt = REC_PT * REC_PT;
    const tauT2 = rdiv(tau, t2);
    const sqTauT2 = mul(tauT2, tauT2);

    const g0pp = sqRecPt * (2.0 * g02 + dzi * (6.0 * g03 + 12.0 * g04 * dzi));
    const r2pp = scale(2.0 * sqRecPt, r22);

    const g = mul(r2pp, add(scale(tau, logRatio(tauT2)), mul(t2, sub(log(sub([1, 0], sqTauT2)), sqTauT2))));

    return g0pp + TT * g[0];
  }

  return NaN;
}

/**
 * Specific enthalpy of ice Ih, J/kg.
 *
 * `h = g - T g_T` as always, but written out rather than composed from two
 * calls to `gibbsIce`: the temperature derivative shares almost every term
 * with the value, so evaluating them together halves the work and, more to
 * the point, is the form IAPWS-06 publishes.
 *
 * Needed by `latentHeatMelting`, which is the enthalpy step across the phase
 * change at the freezing point.
 */
export function enthalpyIce(t: number, p: number): number {
  const tau = (t + T0) * REC_TT;
  const dzi = DB2PA * p * REC_PT;

  const g0 = g00 + dzi * (g01 + dzi * (g02 + dzi * (g03 + g04 * dzi)));
  const r2 = add(r20, scale(dzi, add(r21, scale(dzi, r22))));

  const sqTauT1 = rdiv(tau * tau, mul(t1, t1));
  const sqTauT2 = rdiv(tau * tau, mul(t2, t2));

  const g = add(
    mul(mul(r1, t1), add(log(sub([1, 0], sqTauT1)), sqTauT1)),
    mul(mul(r2, t2), add(log(sub([1, 0], sqTauT2)), sqTauT2))
  );

  return g0 + TT * g[0];
}
