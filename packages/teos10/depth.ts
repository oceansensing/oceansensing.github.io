/**
 * TEOS-10: height against pressure, and gravity.
 *
 * Not a thermodynamic conversion but a geometric one, and it is the place a
 * calculator most easily goes subtly wrong. Sea pressure and depth are not
 * proportional: gravity varies with latitude by about half a percent between
 * the equator and the pole, and the water column's own weight per metre
 * depends on how dense it is. TEOS-10 resolves this by defining `z` through
 * the geopotential of Standard Seawater at 0 degC, which is what
 * `enthalpySSO0` below is.
 *
 * So depth *needs a latitude*, and the calculator asks for one. Ignoring it
 * costs about 5 m at 5000 dbar between 0 and 60 degrees -- small, and larger
 * than any other error on this page.
 *
 * `z` is negative in the ocean, as TEOS-10 defines it. The calculator shows a
 * positive depth alongside, because that is what people say.
 *
 * Coefficients transcribed from GSW-C; see `gibbs.ts` on why by machine.
 */

import { DB2PA, DEG2RAD, GAMMA } from './constants.ts';

/* The four tail coefficients of the 75-term specific-volume polynomial that
   the two reference-column functions below need. Named as GSW names them so
   they can be checked against the published table. */
const v005 = -1.2647261286e-8;
const v006 = 1.9613503930e-9;
const h006 = -2.10787688100e-9;
const h007 = 2.80192913290e-10;

/**
 * Specific volume of Standard Seawater at 0 degC and pressure `p`, m^3/kg.
 *
 * A 75-term-polynomial artefact -- the one place this package uses that fit
 * rather than the Gibbs function, because the definition of `z` is written in
 * terms of it. Substituting the exact specific volume here would give a `z`
 * that is more accurate and no longer TEOS-10's.
 */
function specvolSSO0(p: number): number {
  let z = 0, return_value = 0;

  z = p*1.0e-4;

  return_value = 9.726613854843870e-04 + z*(-4.505913211160929e-05
          + z*(7.130728965927127e-06 + z*(-6.657179479768312e-07
          + z*(-2.994054447232880e-08 + z*(v005 + v006*z)))));
  return return_value;
}

/** Its pressure integral: the geopotential of that reference column, J/kg. */
function enthalpySSO0(p: number): number {
  let dynamic_enthalpy_sso_0_p = 0, z = 0;

  z = p*1.0e-4;

  dynamic_enthalpy_sso_0_p =
                  z*( 9.726613854843870e-4 + z*(-2.252956605630465e-5
                  + z*( 2.376909655387404e-6 + z*(-1.664294869986011e-7
                  + z*(-5.988108894465758e-9 + z*(h006 + h007*z))))));
  return dynamic_enthalpy_sso_0_p*DB2PA*1.0e4;
}

/**
 * Height from sea pressure, m -- negative in the ocean.
 *
 * `dynamicHeight` and `surfaceGeopotential` default to zero, which is the
 * ordinary case: they let a caller with a full profile account for the
 * column's actual density and for a sea surface that is not at the geoid.
 */
export function zFromP(p: number, lat: number, dynamicHeight = 0, surfaceGeopotential = 0): number {
  let x = 0, sin2 = 0, b = 0, c = 0, a = 0;

  x       = Math.sin(lat*DEG2RAD);
  sin2    = x*x;
  b       = 9.780327*(1.0 + (5.2792e-3 + (2.32e-5*sin2))*sin2);
  a       = -0.5*GAMMA*b;
  c       = enthalpySSO0(p)
            - (dynamicHeight + surfaceGeopotential);

  return -2.0*c/(b + Math.sqrt(b*b - 4.0*a*c));
}

/** Depth from sea pressure, m -- positive downwards, which `z` is not. */
export function depthFromPressure(p: number, lat: number): number {
  return -zFromP(p, lat);
}

/** Sea pressure from height, dbar. `z` is negative in the ocean. */
export function pressureFromDepth(z: number, lat: number, dynamicHeight = 0, surfaceGeopotential = 0): number {
      let sinlat = 0, sin2 = 0, gs = 0, c1 = 0, p = 0, df_dp = 0, f = 0, p_old = 0, p_mid = 0;

      if (z > 5) return NaN;

      sinlat = Math.sin(lat*DEG2RAD);
      sin2 = sinlat*sinlat;
      gs = 9.780327*(1.0 + (5.2792e-3 + (2.32e-5*sin2))*sin2);

      /* get the first estimate of p from Saunders (1981) */
      c1 =  5.25e-3*sin2 + 5.92e-3;
      p  = -2.0*z/((1-c1) + Math.sqrt((1-c1)*(1-c1) + 8.84e-6*z)) ;
      /* end of the first estimate from Saunders (1981) */

      df_dp = DB2PA*specvolSSO0(p); /* initial value of the derivative of f */

      f = enthalpySSO0(p) + gs*(z - 0.5*GAMMA*(z*z))
  - (dynamicHeight + surfaceGeopotential);
      p_old = p;
      p = p_old - f/df_dp;
      p_mid = 0.5*(p + p_old);
      df_dp = DB2PA*specvolSSO0(p_mid);
      p = p_old - f/df_dp;

      return p;
}

/** Gravitational acceleration at latitude and pressure, m/s^2. */
export function gravity(lat: number, p: number): number {
  let x = 0, sin2 = 0, gs = 0, z = 0;

  x       = Math.sin(lat*DEG2RAD);  /* convert to radians */
  sin2    = x*x;
  gs      = 9.780327*(1.0 + (5.2792e-3 + (2.32e-5*sin2))*sin2);

  z       = zFromP(p,lat, 0, 0);

  return (gs*(1.0 - GAMMA*z));    /* z is the height corresponding to p.
                                     Note. In the ocean z is negative. */
}
