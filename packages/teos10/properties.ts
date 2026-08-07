/**
 * TEOS-10: every property the calculator reports, from the Gibbs function.
 *
 * This file is deliberately thin. Density is not a fitted polynomial here --
 * it is `1 / g_P`, and sound speed, heat capacity, entropy and the expansion
 * coefficients are each two or three symbols of the same function's partial
 * derivatives. That is the whole argument for evaluating the Gibbs function
 * rather than the 75-term approximation the GSW toolbox uses by default:
 * every property is then thermodynamically consistent with every other one
 * by construction, rather than to within the fit's residual.
 *
 * Where a quantity has no exact form -- spiciness, which is *defined* as a
 * polynomial -- that is said in its own comment.
 *
 * Coefficients transcribed from GSW-C; see `gibbs.ts` on why by machine.
 */

import { CP0, DB2PA, OFFSET, P0, REC_DB2PA, SFAC, SSO, T0 } from './constants.ts';
import { gibbs } from './gibbs.ts';
import { enthalpyIce, gibbsIce } from './gibbs-ice.ts';
import { ctFromPT, ctFromT, ptFromT, tFromCT } from './temperature.ts';

/** Specific volume, m^3/kg. The pressure derivative of the Gibbs function. */
export function specificVolume(sa: number, t: number, p: number): number {
  return gibbs(0, 0, 1, sa, t, p);
}

/** In-situ density, kg/m^3. */
export function density(sa: number, t: number, p: number): number {
  return 1.0 / gibbs(0, 0, 1, sa, t, p);
}

/** Specific entropy, J/(kg K). */
export function entropy(sa: number, t: number, p: number): number {
  return -gibbs(0, 1, 0, sa, t, p);
}

/** Specific enthalpy, J/kg. `h = g + T s`. */
export function enthalpy(sa: number, t: number, p: number): number {
  return gibbs(0, 0, 0, sa, t, p) - (T0 + t) * gibbs(0, 1, 0, sa, t, p);
}

/**
 * Specific internal energy, J/kg. `u = h - P v`, with P the *absolute*
 * pressure -- so one standard atmosphere is added to the sea pressure, which
 * is the whole reason `P0` exists as a constant.
 */
export function internalEnergy(sa: number, t: number, p: number): number {
  return enthalpy(sa, t, p) - (P0 + DB2PA * p) * specificVolume(sa, t, p);
}

/** Specific Helmholtz energy, J/kg. `f = g - P v`. */
export function helmholtzEnergy(sa: number, t: number, p: number): number {
  return gibbs(0, 0, 0, sa, t, p) - (P0 + DB2PA * p) * specificVolume(sa, t, p);
}

/** Specific Gibbs energy itself, J/kg. */
export function gibbsEnergy(sa: number, t: number, p: number): number {
  return gibbs(0, 0, 0, sa, t, p);
}

/**
 * Potential enthalpy, J/kg -- enthalpy the parcel would have at the surface.
 *
 * This is the quantity Conservative Temperature is built from: CT is exactly
 * this divided by `CP0`.
 */
export function potentialEnthalpy(sa: number, t: number, p: number): number {
  return CP0 * ctFromT(sa, t, p);
}

/** Isobaric heat capacity, J/(kg K). */
export function heatCapacity(sa: number, t: number, p: number): number {
  return -(t + T0) * gibbs(0, 2, 0, sa, t, p);
}

/** Thermal expansion coefficient with respect to in-situ temperature, 1/K. */
export function thermalExpansion(sa: number, t: number, p: number): number {
  return gibbs(0, 1, 1, sa, t, p) / gibbs(0, 0, 1, sa, t, p);
}

/** Haline contraction coefficient at constant in-situ temperature, kg/g. */
export function halineContraction(sa: number, t: number, p: number): number {
  return -gibbs(1, 0, 1, sa, t, p) / gibbs(0, 0, 1, sa, t, p);
}

/**
 * Isothermal compressibility, 1/Pa -- the fractional volume change per pascal
 * at fixed temperature. Larger than the isentropic value below, because
 * compressing at fixed temperature means letting the heat out.
 */
export function isothermalCompressibility(sa: number, t: number, p: number): number {
  return -gibbs(0, 0, 2, sa, t, p) / gibbs(0, 0, 1, sa, t, p);
}

/**
 * Isentropic (adiabatic) compressibility, 1/Pa. This is the one that sets the
 * speed of sound, and the one a sinking parcel actually experiences.
 */
export function isentropicCompressibility(sa: number, t: number, p: number): number {
  let n0=0, n1=1, n2=2;
  let g_tt = 0, g_tp = 0;

  g_tt    = gibbs(n0,n2,n0,sa,t,p);
  g_tp    = gibbs(n0,n1,n1,sa,t,p);

  return ((g_tp*g_tp - g_tt*gibbs(n0,n0,n2,sa,t,p)) /
          (gibbs(n0,n0,n1,sa,t,p)*g_tt));
}

/** Speed of sound, m/s. */
export function soundSpeed(sa: number, t: number, p: number): number {
  let n0=0, n1=1, n2=2;
  let g_tt = 0, g_tp = 0;

  g_tt    = gibbs(n0,n2,n0,sa,t,p);
  g_tp    = gibbs(n0,n1,n1,sa,t,p);

  return (gibbs(n0,n0,n1,sa,t,p) *
          Math.sqrt(g_tt/(g_tp*g_tp - g_tt*gibbs(n0,n0,n2,sa,t,p))));
}

/**
 * Adiabatic lapse rate, K/Pa -- how much a parcel warms per pascal as it
 * sinks without exchanging heat. Multiply by 1e4 for K/dbar, which is the
 * unit that makes the number legible: it is about 1.5e-4 K/dbar in warm
 * water, so a kilometre of descent is roughly 0.15 degC of nothing happening.
 */
export function adiabaticLapseRate(sa: number, t: number, p: number): number {
  return -gibbs(0, 1, 1, sa, t, p) / gibbs(0, 2, 0, sa, t, p);
}

/** Chemical potential of water in seawater, J/kg. */
export function chemPotentialWater(sa: number, t: number, p: number): number {
  let g03_g = 0, g08_g = 0, g_sa_part = 0, x = 0, x2 = 0, y = 0, z = 0, kg2g = 1e-3;

  x2 = SFAC*sa;
  x = Math.sqrt(x2);
  y = t*0.025;
  z = p*1e-4;

  g03_g = 101.342743139674 + z*(100015.695367145 +
      z*(-2544.5765420363 + z*(284.517778446287 +
      z*(-33.3146754253611 + (4.20263108803084 - 0.546428511471039*z)*z)))) +
      y*(5.90578347909402 + z*(-270.983805184062 +
      z*(776.153611613101 + z*(-196.51255088122 +
      (28.9796526294175 - 2.13290083518327*z)*z))) +
      y*(-12357.785933039 + z*(1455.0364540468 +
      z*(-756.558385769359 + z*(273.479662323528 +
      z*(-55.5604063817218 + 4.34420671917197*z)))) +
      y*(736.741204151612 + z*(-672.50778314507 +
      z*(499.360390819152 + z*(-239.545330654412 +
      (48.8012518593872 - 1.66307106208905*z)*z))) +
      y*(-148.185936433658 + z*(397.968445406972 +
      z*(-301.815380621876 + (152.196371733841 - 26.3748377232802*z)*z)) +
      y*(58.0259125842571 + z*(-194.618310617595 +
      z*(120.520654902025 + z*(-55.2723052340152 + 6.48190668077221*z))) +
      y*(-18.9843846514172 + y*(3.05081646487967 - 9.63108119393062*z) +
      z*(63.5113936641785 + z*(-22.2897317140459 + 8.17060541818112*z))))))));

  g08_g = x2*(1416.27648484197 +
      x*(-2432.14662381794 + x*(2025.80115603697 +
      y*(543.835333000098 + y*(-68.5572509204491 +
      y*(49.3667694856254 + y*(-17.1397577419788 +
      2.49697009569508*y))) - 22.6683558512829*z) +
      x*(-1091.66841042967 - 196.028306689776*y +
      x*(374.60123787784 - 48.5891069025409*x +
      36.7571622995805*y) + 36.0284195611086*z) +
      z*(-54.7919133532887 + (-4.08193978912261 -
      30.1755111971161*z)*z)) +
      z*(199.459603073901 + z*(-52.2940909281335 +
      (68.0444942726459 - 3.41251932441282*z)*z)) +
      y*(-493.407510141682 + z*(-175.292041186547 +
      (83.1923927801819 - 29.483064349429*z)*z) +
      y*(-43.0664675978042 + z*(383.058066002476 +
      z*(-54.1917262517112 + 25.6398487389914*z)) +
      y*(-10.0227370861875 - 460.319931801257*z +
      y*(0.875600661808945 + 234.565187611355*z))))) +
      y*(168.072408311545));

  g_sa_part = 8645.36753595126 +
      x*(-7296.43987145382 + x*(8103.20462414788 +
      y*(2175.341332000392 + y*(-274.2290036817964 +
      y*(197.4670779425016 + y*(-68.5590309679152 +
      9.98788038278032*y))) - 90.6734234051316*z) +
      x*(-5458.34205214835 - 980.14153344888*y +
      x*(2247.60742726704 - 340.1237483177863*x +
      220.542973797483*y) + 180.142097805543*z) +
      z*(-219.1676534131548 + (-16.32775915649044 -
      120.7020447884644*z)*z)) +
      z*(598.378809221703 + z*(-156.8822727844005 +
      (204.1334828179377 - 10.23755797323846*z)*z)) +
      y*(-1480.222530425046 + z*(-525.876123559641 +
      (249.57717834054571 - 88.449193048287*z)*z) +
      y*(-129.1994027934126 + z*(1149.174198007428 +
      z*(-162.5751787551336 + 76.9195462169742*z)) +
      y*(-30.0682112585625 - 1380.9597954037708*z +
      y*(2.626801985426835 + 703.695562834065*z))))) +
      y*(1187.3715515697959);

  return kg2g*(g03_g + g08_g - 0.5*x2*g_sa_part);
}

/** Its temperature derivative, J/(kg K) -- needed by the freezing point. */
function dChemPotentialWaterDt(sa: number, t: number, p: number): number {
  let g03_t = 0, g08_sa_t = 0, x = 0, x2 = 0, y = 0, z = 0, g08_t = 0, kg2g = 1e-3;
  /*
  ! Note. The kg2g, a factor of 1e-3, is needed to convert the output of this
  ! function into units of J/g. See section (2.9) of the TEOS-10 Manual.
  */

  x2 = SFAC*sa;
  x = Math.sqrt(x2);
  y = t*0.025;
  z = p*REC_DB2PA;
      /* the input pressure (p) is sea pressure in units of dbar. */

  g03_t = 5.90578347909402 + z*(-270.983805184062 +
  z*(776.153611613101 + z*(-196.51255088122 + (28.9796526294175 -
  2.13290083518327*z)*z))) +
  y*(-24715.571866078 + z*(2910.0729080936 +
  z*(-1513.116771538718 + z*(546.959324647056 +
  z*(-111.1208127634436 + 8.68841343834394*z)))) +
  y*(2210.2236124548363 + z*(-2017.52334943521 +
  z*(1498.081172457456 + z*(-718.6359919632359 +
  (146.4037555781616 - 4.9892131862671505*z)*z))) +
  y*(-592.743745734632 + z*(1591.873781627888 +
  z*(-1207.261522487504 + (608.785486935364 -
  105.4993508931208*z)*z)) +
  y*(290.12956292128547 + z*(-973.091553087975 +
  z*(602.603274510125 + z*(-276.361526170076 +
  32.40953340386105*z))) +
  y*(-113.90630790850321 + y*(21.35571525415769 -
  67.41756835751434*z) +
  z*(381.06836198507096 + z*(-133.7383902842754 +
  49.023632509086724*z)))))));

  g08_t = x2*(168.072408311545 +
  x*(-493.407510141682 + x*(543.835333000098 +
  x*(-196.028306689776 + 36.7571622995805*x) +
  y*(-137.1145018408982 + y*(148.10030845687618 +
  y*(-68.5590309679152 + 12.4848504784754*y))) -
  22.6683558512829*z) + z*(-175.292041186547 +
  (83.1923927801819 - 29.483064349429*z)*z) +
  y*(-86.1329351956084 + z*(766.116132004952 +
  z*(-108.3834525034224 + 51.2796974779828*z)) +
  y*(-30.0682112585625 - 1380.9597954037708*z +
  y*(3.50240264723578 + 938.26075044542*z)))));

  g08_sa_t = 1187.3715515697959 +
  x*(-1480.222530425046 + x*(2175.341332000392 +
  x*(-980.14153344888 + 220.542973797483*x) +
  y*(-548.4580073635929 + y*(592.4012338275047 +
  y*(-274.2361238716608 + 49.9394019139016*y))) -
  90.6734234051316*z) + z*(-525.876123559641 +
  (249.57717834054571 - 88.449193048287*z)*z) +
  y*(-258.3988055868252 + z*(2298.348396014856 +
  z*(-325.1503575102672 + 153.8390924339484*z)) +
  y*(-90.2046337756875 - 4142.8793862113125*z +
  y*(10.50720794170734 + 2814.78225133626*z))));

  return kg2g*((g03_t + g08_t)*0.025 - 0.5*SFAC*0.025*sa*g08_sa_t);
}

/** Chemical potential of sea salt in seawater, J/g. */
export function chemPotentialSalt(sa: number, t: number, p: number): number {
  return gibbs(1, 0, 0, sa, t, p);
}

/**
 * The dilution coefficient, `SA * g_SA_SA`, J/kg.
 *
 * What it costs energetically to dilute the parcel, which is what sets how
 * much a freshwater flux changes everything else.
 */
export function dilutionCoefficient(sa: number, t: number, p: number): number {
  let g08 = 0, x = 0, x2 = 0, y = 0, z = 0;

  x2 = SFAC*sa;
  x = Math.sqrt(x2);
  y = t*0.025;
  z = p*1e-4;
      /*note.the input pressure (p) is sea pressure in units of dbar.*/

  g08 = 2.0*(8103.20462414788 +
            y*(2175.341332000392 +
                y*(-274.2290036817964 +
                    y*(197.4670779425016 +
                        y*(-68.5590309679152 + 9.98788038278032*y))) -
            90.6734234051316*z) +
                1.5*x*(-5458.34205214835 - 980.14153344888*y +
                    (4.0/3.0)*x*(2247.60742726704 -
                    340.1237483177863*1.25*x + 220.542973797483*y) +
                180.142097805543*z) +
            z*(-219.1676534131548 +
                (-16.32775915649044 - 120.7020447884644*z)*z));

  g08 = x2*g08 +
            x*(-7296.43987145382 +
                z*(598.378809221703 +
                    z*(-156.8822727844005 +
                        (204.1334828179377 - 10.23755797323846*z)*z)) +
                y*(-1480.222530425046 +
                    z*(-525.876123559641 +
                        (249.57717834054571 - 88.449193048287*z)*z) +
                    y*(-129.1994027934126 +
                        z*(1149.174198007428 +
                            z*(-162.5751787551336 + 76.9195462169742*z)) +
                    y*(-30.0682112585625 - 1380.9597954037708*z +
                        y*(2.626801985426835 + 703.695562834065*z))))) +
        11625.62913253464 + 1702.453469893412*y;

  return 0.25*SFAC*g08;
  /*
  ! Note that this function avoids the singularity that occurs at SA = 0 if
  ! the straightforward expression for the dilution coefficient of seawater,
  ! SA*g_SA_SA is simply evaluated as SA.*gibbs(2,0,0,SA,t,p).
  */
}

/**
 * Freezing temperature of seawater, degrees C (ITS-90).
 *
 * `saturationFraction` is how much of the equilibrium air content is
 * dissolved -- 0 for air-free water, 1 for saturated. Air lowers the freezing
 * point by about 2.4 mK at zero salinity.
 *
 * **Exact rather than the polynomial**: this is the root of the condition
 * that the chemical potential of water in seawater equals the Gibbs energy of
 * ice, so it is the one place in this package where both standards meet.
 */
export function freezingTemperature(sa: number, p: number, saturationFraction = 0): number {
  /* Freezing-point polynomial coefficients, local because `a`, `b` and `t0`
     are names this module uses for other things at other scales. */
  const a = 0.014289763856964, b = 0.057000649899720;
  const t0 = 0.002519, t1 = -5.946302841607319, t2 = 4.136051661346983,
    t3 = -1.115150523403847e1, t4 = 1.476878746184548e1, t5 = -1.088873263630961e1,
    t6 = 2.961018839640730, t7 = -7.433320943962606, t8 = -1.561578562479883,
    t9 = 4.073774363480365e-2, t10 = 1.158414435887717e-2, t11 = -4.122639292422863e-1,
    t12 = -1.123186915628260e-1, t13 = 5.715012685553502e-1, t14 = 2.021682115652684e-1,
    t15 = 4.140574258089767e-2, t16 = -6.034228641903586e-1, t17 = -1.205825928146808e-2,
    t18 = -2.812172968619369e-1, t19 = 1.877244474023750e-2, t20 = -1.204395563789007e-1,
    t21 = 2.349147739749606e-1, t22 = 2.748444541144219e-3;
  let sa_r = 0, x = 0, p_r = 0;
  let df_dt = 0, tf = 0, tfm = 0, tf_old = 0, f = 0, return_value = 0;

  /* The initial value of t_freezing_exact (for air-free seawater) */
  sa_r = sa*1e-2;
  x = Math.sqrt(sa_r);
  p_r = p*1e-4;

  tf = t0
  + sa_r*(t1 + x*(t2 + x*(t3 + x*(t4 + x*(t5 + t6*x)))))
  + p_r*(t7 + p_r*(t8 + t9*p_r))
  + sa_r*p_r*(t10 + p_r*(t12 + p_r*(t15 + t21*sa_r))
  + sa_r*(t13 + t17*p_r + t19*sa_r)
  + x*(t11 + p_r*(t14 + t18*p_r) + sa_r*(t16 + t20*p_r
  + t22*sa_r)));

  /* Adjust for the effects of dissolved air */
  tf -= saturationFraction*(1e-3)*(2.4 - sa/(2.0*SSO));

  df_dt = 1e3*dChemPotentialWaterDt(sa,tf,p) -
          gibbsIce(1,0,tf,p);
  /*
  ! df_dt here is the initial value of the derivative of the function f whose
  ! zero (f = 0) we are finding (see Eqn. (3.33.2) of IOC et al (2010)).
  */

  tf_old = tf;
  f = 1e3*chemPotentialWater(sa,tf_old,p) -
          gibbsIce(0,0,tf_old,p);
  tf = tf_old - f/df_dt;
  tfm = 0.5*(tf + tf_old);
  df_dt = 1e3*dChemPotentialWaterDt(sa,tfm,p) -
          gibbsIce(1,0,tfm,p);
  tf = tf_old - f/df_dt;

  tf_old = tf;
  f = 1e3*chemPotentialWater(sa,tf_old,p) -
          gibbsIce(0,0,tf_old,p);
  tf = tf_old - f/df_dt;

  /* Adjust for the effects of dissolved air */
  return_value = tf -
          saturationFraction*(1e-3)*(2.4 - sa/(2.0*SSO));
  return return_value;
}

/** Freezing temperature expressed as Conservative Temperature, degrees C. */
export function freezingCT(sa: number, p: number, saturationFraction = 0): number {
  return ctFromT(sa, freezingTemperature(sa, p, saturationFraction), p);
}

/**
 * Latent heat of evaporation, J/kg.
 *
 * A surface quantity, so its temperature argument is the surface one: at
 * p = 0 the in-situ and potential temperatures are the same number, which is
 * why GSW takes `t` here and immediately treats it as pt.
 */
export function latentHeatEvaporation(sa: number, t: number): number {
  return latentHeatEvaporationCT(sa, ctFromPT(sa, t));
}

/** The same, from Conservative Temperature. This is the fitted form. */
export function latentHeatEvaporationCT(sa: number, ct: number): number {
  const c0 = 2.499065844825125e6, c1 = -1.544590633515099e-1,
    c2 = -9.096800915831875e4, c3 = 1.665513670736000e2,
    c4 = 4.589984751248335e1, c5 = 1.894281502222415e1,
    c6 = 1.192559661490269e3, c7 = -6.631757848479068e3,
    c8 = -1.104989199195898e2, c9 = -1.207006482532330e3,
    c10 = -3.148710097513822e3, c11 = 7.437431482069087e2,
    c12 = 2.519335841663499e3, c13 = 1.186568375570869e1,
    c14 = 5.731307337366114e2, c15 = 1.213387273240204e3,
    c16 = 1.062383995581363e3, c17 = -6.399956483223386e2,
    c18 = -1.541083032068263e3, c19 = 8.460780175632090e1,
    c20 = -3.233571307223379e2, c21 = -2.031538422351553e2,
    c22 = 4.351585544019463e1, c23 = -8.062279018001309e2,
    c24 = 7.510134932437941e2, c25 = 1.797443329095446e2,
    c26 = -2.389853928747630e1, c27 = 1.021046205356775e2;

  const x = Math.sqrt(SFAC * sa);
  const y = ct / 40.0;

  return (c0 + x*(c1 + c4*y + x*(c3
             + y*(c7 + c12*y) + x*(c6 + y*(c11 + y*(c17 + c24*y))
             + x*(c10 + y*(c16 + c23*y) + x*(c15 + c22*y + c21*x)))))
             + y*(c2 + y*(c5 + c8*x + y*(c9 + x*(c13 + c18*x)
             + y*(c14 + x*(c19 + c25*x) + y*(c20 + c26*x + c27*y))))));
}

/**
 * Latent heat of melting of ice into seawater, J/kg.
 *
 * The enthalpy difference across the phase change at the freezing point, so
 * it needs both standards -- seawater's chemical potential of water on one
 * side, ice's enthalpy on the other.
 */
export function latentHeatMelting(sa: number, p: number): number {
  const tf = freezingTemperature(sa, p, 0.0);
  return 1000.0 * (chemPotentialWater(sa, tf, p)
    - (T0 + tf) * dChemPotentialWaterDt(sa, tf, p))
    - enthalpyIce(tf, p);
}

/**
 * Potential density referenced to `pRef`, kg/m^3.
 *
 * Exact: the parcel is moved adiabatically to `pRef` and its density
 * evaluated there. Subtract 1000 for the sigma the literature quotes --
 * sigma-0, sigma-2 and sigma-4 are this at 0, 2000 and 4000 dbar.
 */
export function potentialDensity(sa: number, t: number, p: number, pRef: number): number {
  return density(sa, ptFromT(sa, t, p, pRef), pRef);
}

/**
 * Specific volume anomaly against Standard Seawater at the same pressure,
 * m^3/kg -- the quantity the dynamic height integral is built from.
 */
export function specificVolumeAnomaly(sa: number, t: number, p: number): number {
  return specificVolume(sa, t, p) - specificVolume(SSO, tFromCT(SSO, 0.0, p), p);
}

/**
 * Spiciness, kg/m^3, at reference pressures 0, 1000 and 2000 dbar.
 *
 * The one family here with no exact form, and not because nobody has fitted
 * one: spiciness *is* defined as these polynomials (McDougall and Krzysik,
 * 2015). It measures the direction across a T-S diagram orthogonal to
 * density, so two water masses with the same sigma and different spiciness
 * are the same weight and different water.
 */
export function spiciness0(sa: number, ct: number): number {
  let s01 = -9.22982898371678e1, s02 = -1.35727873628866e1, s03 =  1.87353650994010e1, s04 = -1.61360047373455e1, s05 =  3.76112762286425e1, s06 = -4.27086671461257e1, s07 =  2.00820111041594e1, s08 =  2.87969717584045e2, s09 =  1.13747111959674e1, s10 =  6.07377192990680e1, s11 = -7.37514033570187e1, s12 = -7.51171878953574e1, s13 =  1.63310989721504e2, s14 = -8.83222751638095e1, s15 = -6.41725302237048e2, s16 =  2.79732530789261e1, s17 = -2.49466901993728e2, s18 =  3.26691295035416e2, s19 =  2.66389243708181e1, s20 = -2.93170905757579e2, s21 =  1.76053907144524e2, s22 =  8.27634318120224e2, s23 = -7.02156220126926e1, s24 =  3.82973336590803e2, s25 = -5.06206828083959e2, s26 =  6.69626565169529e1, s27 =  3.02851235050766e2, s28 = -1.96345285604621e2, s29 = -5.74040806713526e2, s30 =  7.03285905478333e1, s31 = -2.97870298879716e2, s32 =  3.88340373735118e2, s33 = -8.29188936089122e1, s34 = -1.87602137195354e2, s35 =  1.27096944425793e2, s36 =  2.11671167892147e2, s37 = -3.15140919876285e1, s38 =  1.16458864953602e2, s39 = -1.50029730802344e2, s40 =  3.76293848660589e1, s41 =  6.47247424373200e1, s42 = -4.47159994408867e1, s43 = -3.23533339449055e1, s44 =  5.30648562097667, s45 = -1.82051249177948e1, s46 =  2.33184351090495e1, s47 = -6.22909903460368, s48 = -9.55975464301446, s49 =  6.61877073960113;
  let xs = 0, ys = 0, spiciness0 = 0;

  xs      = Math.sqrt(SFAC*sa + OFFSET);
  ys      = ct*0.025;

  spiciness0= s01+ys*(s02+ys*(s03+ys*(s04+ys*(s05+ys*(s06+s07*ys)))))
          +xs*(s08+ys*(s09+ys*(s10+ys*(s11+ys*(s12+ys*(s13+s14*ys)))))
          +xs*(s15+ys*(s16+ys*(s17+ys*(s18+ys*(s19+ys*(s20+s21*ys)))))
          +xs*(s22+ys*(s23+ys*(s24+ys*(s25+ys*(s26+ys*(s27+s28*ys)))))
          +xs*(s29+ys*(s30+ys*(s31+ys*(s32+ys*(s33+ys*(s34+s35*ys)))))
          +xs*(s36+ys*(s37+ys*(s38+ys*(s39+ys*(s40+ys*(s41+s42*ys)))))
          +xs*(s43+ys*(s44+ys*(s45+ys*(s46+ys*(s47+ys*(s48+s49*ys)))))
          ))))));
  return spiciness0;
}

export function spiciness1(sa: number, ct: number): number {
  let s01 = -9.19874584868912e1, s02 = -1.33517268529408e1, s03 =  2.18352211648107e1, s04 = -2.01491744114173e1, s05 =  3.70004204355132e1, s06 = -3.78831543226261e1, s07 =  1.76337834294554e1, s08 =  2.87838842773396e2, s09 =  2.14531420554522e1, s10 =  3.14679705198796e1, s11 = -4.04398864750692e1, s12 = -7.70796428950487e1, s13 =  1.36783833820955e2, s14 = -7.36834317044850e1, s15 = -6.41753415180701e2, s16 =  1.33701981685590, s17 = -1.75289327948412e2, s18 =  2.42666160657536e2, s19 =  3.17062400799114e1, s20 = -2.28131490440865e2, s21 =  1.39564245068468e2, s22 =  8.27747934506435e2, s23 = -3.50901590694775e1, s24 =  2.87473907262029e2, s25 = -4.00227341144928e2, s26 =  6.48307189919433e1, s27 =  2.16433334701578e2, s28 = -1.48273032774305e2, s29 = -5.74545648799754e2, s30 =  4.50446431127421e1, s31 = -2.30714981343772e2, s32 =  3.15958389253065e2, s33 = -8.60635313930106e1, s34 = -1.22978455069097e2, s35 =  9.18287282626261e1, s36 =  2.12120473062203e2, s37 = -2.21528216973820e1, s38 =  9.19013417923270e1, s39 = -1.24400776026014e2, s40 =  4.08512871163839e1, s41 =  3.91127352213516e1, s42 = -3.10508021853093e1, s43 = -3.24790035899152e1, s44 =  3.91029016556786, s45 = -1.45362719385412e1, s46 =  1.96136194246355e1, s47 = -7.06035474689088, s48 = -5.36884688614009, s49 =  4.43247303092448;
  let xs = 0, ys = 0, spiciness1 = 0;

  xs      = Math.sqrt(SFAC*sa + OFFSET);
  ys      = ct*0.025;
  spiciness1= s01+ys*(s02+ys*(s03+ys*(s04+ys*(s05+ys*(s06+s07*ys)))))
          +xs*(s08+ys*(s09+ys*(s10+ys*(s11+ys*(s12+ys*(s13+s14*ys)))))
          +xs*(s15+ys*(s16+ys*(s17+ys*(s18+ys*(s19+ys*(s20+s21*ys)))))
          +xs*(s22+ys*(s23+ys*(s24+ys*(s25+ys*(s26+ys*(s27+s28*ys)))))
          +xs*(s29+ys*(s30+ys*(s31+ys*(s32+ys*(s33+ys*(s34+s35*ys)))))
          +xs*(s36+ys*(s37+ys*(s38+ys*(s39+ys*(s40+ys*(s41+s42*ys)))))
          +xs*(s43+ys*(s44+ys*(s45+ys*(s46+ys*(s47+ys*(s48+s49*ys)))))
          ))))));
  return spiciness1;
}

export function spiciness2(sa: number, ct: number): number {
  let s01 = -9.17327320732265e1, s02 = -1.31200235147912e1, s03 =  2.49574345782503e1, s04 = -2.41678075247398e1, s05 =  3.61654631402053e1, s06 = -3.22582164667710e1, s07 =  1.45092623982509e1, s08 =  2.87776645983195e2, s09 =  3.13902307672447e1, s10 =  1.69777467534459, s11 = -5.69630115740438, s12 = -7.97586359017987e1, s13 =  1.07507460387751e2, s14 = -5.58234404964787e1, s15 = -6.41708068766557e2, s16 = -2.53494801286161e1, s17 = -9.86755437385364e1, s18 =  1.52406930795842e2, s19 =  4.23888258264105e1, s20 = -1.60118811141438e2, s21 =  9.67497898053989e1, s22 =  8.27674355478637e2, s23 =  5.27561234412133e-1, s24 =  1.87440206992396e2, s25 = -2.83295392345171e2, s26 =  5.14485994597635e1, s27 =  1.29975755062696e2, s28 = -9.36526588377456e1, s29 = -5.74911728972948e2, s30 =  1.91175851862772e1, s31 = -1.59347231968841e2, s32 =  2.33884725744938e2, s33 = -7.87744010546157e1, s34 = -6.04757235443685e1, s35 =  5.27869695599657e1, s36 =  2.12517758478878e2, s37 = -1.24351794740528e1, s38 =  6.53904308937490e1, s39 = -9.44804080763788e1, s40 =  3.93874257887364e1, s41 =  1.49425448888996e1, s42 = -1.62350721656367e1, s43 = -3.25936844276669e1, s44 =  2.44035700301595, s45 = -1.05079633683795e1, s46 =  1.51515796259082e1, s47 = -7.06609886460683, s48 = -1.48043337052968, s49 =  2.10066653978515;
  let xs = 0, ys = 0, spiciness2 = 0;

  xs      = Math.sqrt(SFAC*sa + OFFSET);
  ys      = ct*0.025;

  spiciness2= s01+ys*(s02+ys*(s03+ys*(s04+ys*(s05+ys*(s06+s07*ys)))))
          +xs*(s08+ys*(s09+ys*(s10+ys*(s11+ys*(s12+ys*(s13+s14*ys)))))
          +xs*(s15+ys*(s16+ys*(s17+ys*(s18+ys*(s19+ys*(s20+s21*ys)))))
          +xs*(s22+ys*(s23+ys*(s24+ys*(s25+ys*(s26+ys*(s27+s28*ys)))))
          +xs*(s29+ys*(s30+ys*(s31+ys*(s32+ys*(s33+ys*(s34+s35*ys)))))
          +xs*(s36+ys*(s37+ys*(s38+ys*(s39+ys*(s40+ys*(s41+s42*ys)))))
          +xs*(s43+ys*(s44+ys*(s45+ys*(s46+ys*(s47+ys*(s48+s49*ys)))))
          ))))));
  return spiciness2;
}
