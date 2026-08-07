/**
 * TEOS-10: potential temperature and Conservative Temperature.
 *
 * Three temperatures describe the same water and the calculator reports all
 * of them, because which one you want depends on what you are doing:
 *
 * - **in-situ t** is what a thermometer reads. It is not conserved: move a
 *   parcel down and it warms by compression alone.
 * - **potential temperature pt** removes that, by moving the parcel
 *   adiabatically to a reference pressure. It is very nearly conserved.
 * - **Conservative Temperature CT** is potential enthalpy divided by the
 *   fixed constant `CP0`. It is conserved to about a hundred times better
 *   than pt, which is why TEOS-10 recommends it for models and for heat
 *   budgets.
 *
 * The conversions run through entropy, and none of them has a closed form in
 * the direction anyone wants, so each is a Newton iteration seeded by a
 * polynomial. The iteration counts here are not adjustable: they are the ones
 * the standard specifies, chosen so the result is at machine precision, and
 * `npm run test:teos10` checks them against the reference implementation.
 *
 * Coefficients transcribed from GSW-C; see `gibbs.ts` on why by machine.
 */

import { CP0, SFAC, SSO, T0, UPS } from './constants.ts';
import { entropyPart, entropyPartZeroP, gibbs, gibbsPt0Pt0 } from './gibbs.ts';

/**
 * Potential temperature referenced to the surface, degrees C.
 *
 * The seed is a polynomial good to about 0.01 degC, and two modified
 * Newton-Raphson steps take it to machine precision -- the second step is
 * what makes it exact rather than merely close, so neither is optional.
 */
export function pt0FromT(sa: number, t: number, p: number): number {
  let no_iter = 0;
  let pt0 = 0, pt0_old = 0, dentropy = 0, dentropy_dt = 0;
  let s1 = 0, true_entropy_part = 0, pt0m = 0;

  s1      = sa/UPS;

  pt0     = t+p*( 8.65483913395442e-6  -
            s1 *  1.41636299744881e-6  -
             p *  7.38286467135737e-9  +
             t *(-8.38241357039698e-6  +
            s1 *  2.83933368585534e-8  +
             t *  1.77803965218656e-8  +
             p *  1.71155619208233e-10));

  dentropy_dt     = CP0/((T0+pt0)*(1.0-0.05*(1.0-sa/SSO)));

  true_entropy_part = entropyPart(sa,t,p);

  for (no_iter=1; no_iter <= 2; no_iter++) {
      pt0_old     = pt0;
      dentropy    = entropyPartZeroP(sa,pt0_old) -
                    true_entropy_part;
      pt0         = pt0_old - dentropy/dentropy_dt;
      pt0m        = 0.5*(pt0 + pt0_old);
      dentropy_dt = -gibbsPt0Pt0(sa,pt0m);
      pt0         = pt0_old - dentropy/dentropy_dt;
  }
  return pt0;
}

/**
 * Potential temperature referenced to any pressure `pRef`, degrees C.
 *
 * With `pRef` of 0 this is `pt0FromT` by a slower route; the calculator uses
 * it for the reference pressures the reader asks for, and `potentialDensity`
 * uses it for sigma-1 through sigma-4.
 */
export function ptFromT(sa: number, t: number, p: number, p_ref: number): number {
  let n0=0, n2=2, no_iter = 0;
  let s1 = 0, pt = 0, ptm = 0, pt_old = 0, dentropy = 0, dentropy_dt = 0, true_entropy_part = 0;

  s1      = sa/UPS;
  pt      = t+(p-p_ref)*( 8.65483913395442e-6  -
                    s1 *  1.41636299744881e-6  -
             (p+p_ref) *  7.38286467135737e-9  +
                    t  *(-8.38241357039698e-6  +
                    s1 *  2.83933368585534e-8  +
                    t  *  1.77803965218656e-8  +
             (p+p_ref) *  1.71155619208233e-10));

  dentropy_dt     = CP0/((T0 + pt)*(1.0-0.05*(1.0 - sa/SSO)));
  true_entropy_part       = entropyPart(sa,t,p);
  for (no_iter=1; no_iter <= 2; no_iter++) {
      pt_old      = pt;
      dentropy    = entropyPart(sa,pt_old,p_ref) - true_entropy_part;
      pt          = pt_old - dentropy/dentropy_dt;
      ptm         = 0.5*(pt + pt_old);
      dentropy_dt = -gibbs(n0,n2,n0,sa,ptm,p_ref);
      pt          = pt_old - dentropy/dentropy_dt;
  }
  return pt;
}

/**
 * Conservative Temperature from potential temperature, degrees C.
 *
 * This one *is* closed-form: potential enthalpy is a polynomial in SA and pt,
 * and CT is that divided by `CP0`. Every other conversion in this file is an
 * iteration because it is this one inverted.
 */
export function ctFromPT(sa: number, pt: number): number {
  let x2 = 0, x = 0, y = 0, pot_enthalpy = 0;

  x2              = SFAC*sa;
  x               = Math.sqrt(x2);
  y               = pt*0.025e0;   /*! normalize for F03 and F08 */
  pot_enthalpy    =  61.01362420681071e0 + y*(168776.46138048015e0 +
       y*(-2735.2785605119625e0 + y*(2574.2164453821433e0 +
       y*(-1536.6644434977543e0 + y*(545.7340497931629e0 +
       (-50.91091728474331e0 - 18.30489878927802e0*y)*y))))) +
       x2*(268.5520265845071e0 + y*(-12019.028203559312e0 +
       y*(3734.858026725145e0 + y*(-2046.7671145057618e0 +
       y*(465.28655623826234e0 + (-0.6370820302376359e0 -
       10.650848542359153e0*y)*y)))) +
       x*(937.2099110620707e0 + y*(588.1802812170108e0+
       y*(248.39476522971285e0 + (-3.871557904936333e0-
       2.6268019854268356e0*y)*y)) +
       x*(-1687.914374187449e0 + x*(246.9598888781377e0 +
       x*(123.59576582457964e0 - 48.5891069025409e0*x)) +
       y*(936.3206544460336e0 +
       y*(-942.7827304544439e0 + y*(369.4389437509002e0 +
       (-33.83664947895248e0 - 9.987880382780322e0*y)*y))))));

  return pot_enthalpy/CP0;
}

/** Potential temperature from Conservative Temperature, degrees C. */
export function ptFromCT(sa: number, ct: number): number {
  let a5ct = 0, b3ct = 0, ct_factor = 0, pt_num = 0, pt_recden = 0, ct_diff = 0;
  let pt = 0, pt_old = 0, ptm = 0, dpt_dct = 0, s1 = 0;
  let a0      = -1.446013646344788e-2, a1      = -3.305308995852924e-3, a2      =  1.062415929128982e-4, a3      =  9.477566673794488e-1, a4      =  2.166591947736613e-3, a5      =  3.828842955039902e-3, b0      =  1.000000000000000e0, b1      =  6.506097115635800e-4, b2      =  3.830289486850898e-3, b3      =  1.247811760368034e-6;

  s1      = sa/UPS;

  a5ct    = a5*ct;
  b3ct    = b3*ct;

  ct_factor       = (a3 + a4*s1 + a5ct);
  pt_num          = a0 + s1*(a1 + a2*s1) + ct*ct_factor;
  pt_recden       = 1.0/(b0 + b1*s1 + ct*(b2 + b3ct));
  pt              = pt_num*pt_recden;

  dpt_dct = pt_recden*(ct_factor + a5ct - (b2 + b3ct + b3ct)*pt);

      /*
      **  Start the 1.5 iterations through the modified Newton-Raphson
      **  iterative method.
      */

  ct_diff = ctFromPT(sa,pt) - ct;
  pt_old  = pt;
  pt      = pt_old - ct_diff*dpt_dct;
  ptm     = 0.5*(pt + pt_old);

  dpt_dct = -CP0/((ptm + T0)*gibbsPt0Pt0(sa,ptm));

  pt      = pt_old - ct_diff*dpt_dct;
  ct_diff = ctFromPT(sa,pt) - ct;
  pt_old  = pt;
  return pt_old - ct_diff*dpt_dct;
}

/** Conservative Temperature from in-situ temperature, degrees C. */
export function ctFromT(sa: number, t: number, p: number): number {
  return ctFromPT(sa, pt0FromT(sa, t, p));
}

/** In-situ temperature from Conservative Temperature, degrees C. */
export function tFromCT(sa: number, ct: number, p: number): number {
  let pt0 = 0, p0=0.0;

  pt0     = ptFromCT(sa,ct);
  return ptFromT(sa,pt0,p0,p);
}

/**
 * The in-situ temperature of maximum density, degrees C.
 *
 * Fresh water is densest near 4 degC; seawater's maximum moves down as
 * salinity rises and crosses the freezing point near SA 24 g/kg, which is why
 * a deep lake overturns in autumn and the open ocean does not. The calculator
 * reports it so it can say which side of that line the water sits on.
 *
 * **Solved exactly, where GSW solves it from the 75-term polynomial.** Density
 * is greatest where the thermal expansion coefficient vanishes, and alpha is
 * `g_TP / g_P` with `g_P` the specific volume -- strictly positive. So the
 * maximum is the root of `g_TP` alone, which this file already has to machine
 * precision, and no approximation of alpha need enter. `g_TP` rises through
 * zero exactly once over the range seawater occupies, so bisection cannot
 * land on the wrong root, and 80 halvings of a 60-degree bracket is the
 * floating-point limit.
 *
 * Returns NaN where there is no maximum in range, which is the honest answer
 * for water fresh enough that it sits outside the bracket rather than a
 * clamped edge value.
 */
export function tMaxDensity(sa: number, p: number): number {
  const gTP = (t: number) => gibbs(0, 1, 1, sa, t, p);
  /* The bracket has to reach a long way below zero, because pressure pushes
     the maximum down hard: it is near 4 degC for fresh water at the surface
     and about -33 degC at 10,000 dbar. Well below the freezing point, so at
     depth this is a formal root rather than a temperature water reaches —
     which is exactly what makes it worth reporting, since it says the
     maximum is unreachable rather than merely cold. */
  let lo = -45;
  let hi = 45;
  if (gTP(lo) > 0 || gTP(hi) < 0) return NaN;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (gTP(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** The Conservative Temperature of maximum density, degrees C. */
export function ctMaxDensity(sa: number, p: number): number {
  return ctFromT(sa, tMaxDensity(sa, p), p);
}
