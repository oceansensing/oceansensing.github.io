/**
 * TEOS-10: the salinity variables, and the conversions between them.
 *
 * There are four, and the calculator reports all of them because they answer
 * different questions:
 *
 * - **Practical Salinity SP** is what a CTD measures -- a conductivity ratio
 *   run through PSS-78. It is dimensionless by construction and it is the
 *   variable to archive, because it is the measurement.
 * - **Reference Salinity SR** is SP put on a mass basis, `UPS * SP`. It is
 *   what SA would be if every ocean had Standard Seawater composition.
 * - **Absolute Salinity SA** adds the composition anomaly measured across the
 *   real ocean, and it is the salinity the equation of state wants. The
 *   correction reaches 0.03 g/kg in the North Pacific -- small, and about
 *   thirty times the precision anyone quotes density to.
 * - **Preformed Salinity S\*** removes the part of the anomaly that
 *   biogeochemistry has added since the water left the surface, so it is the
 *   conservative one.
 *
 * The anomaly comes from a global atlas, which is the one thing here that
 * needs the network -- so it is **passed in** rather than imported, and every
 * function that needs it degrades to NaN without it. See `atlas.ts`.
 *
 * Coefficients transcribed from GSW-C; see `gibbs.ts` on why by machine.
 */

import { C3515, SONCL, SSO, UPS } from './constants.ts';

/* PSS-78 coefficients (Practical Salinity Scale 1978), shared by the three
   functions below. Hoisted to module scope rather than repeated, which is
   what the C macro they come from did at each call site. */
const a0 = 0.0080, a1 = -0.1692, a2 = 25.3851, a3 = 14.0941, a4 = -7.0261, a5 = 2.7081;
const b0 = 0.0005, b1 = -0.0056, b2 = -0.0066, b3 = -0.0375, b4 = 0.0636, b5 = -0.0144;
const c0 = 0.6766097, c1 = 2.00564e-2, c2 = 1.104259e-4, c3 = -6.9698e-7, c4 = 1.0031e-9;
const d1 = 3.426e-2, d2 = 4.464e-4, d3 = 4.215e-1, d4 = -3.107e-3;
const e1 = 2.070e-5, e2 = -6.370e-10, e3 = 3.989e-15;
const k = 0.0162;

/**
 * The Absolute Salinity Anomaly Ratio at a position, as `atlas.ts` supplies
 * it. Anything implementing this can stand in -- a native port, a test stub,
 * or nothing at all, in which case SA falls back to SR.
 */
export interface Anomaly {
  /** SAAR at sea pressure `p` (dbar) and position, or NaN outside the atlas. */
  saar(p: number, lon: number, lat: number): number;
}

/* The Baltic Sea has its own SP-to-SA rule, and it is not the atlas's.
   Its salt is river-borne rather than oceanic, so the composition anomaly is
   large and the relationship is linear rather than a small correction -- the
   atlas would be wrong there by far more than it is right anywhere else.
   These four arrays are the polygon that decides where the rule applies. */
const XB_LEFT = [12.6, 7.0, 26.0];
const YB_LEFT = [50.0, 59.0, 69.0];
const XB_RIGHT = [45.0, 26.0];
const YB_RIGHT = [50.0, 69.0];

/** Linear interpolation of `y` against `x` at `x0`, clamped at both ends. */
function xinterp1(x: number[], y: number[], x0: number): number {
  const n = x.length;
  if (x0 <= x[0]) return y[0];
  if (x0 >= x[n - 1]) return y[n - 1];
  let k = 0;
  while (k < n - 2 && x0 > x[k + 1]) k++;
  const r = (x0 - x[k]) / (x[k + 1] - x[k]);
  return y[k] + r * (y[k + 1] - y[k]);
}

/** Whether a position is inside the Baltic polygon. NaN longitude is not. */
function inBaltic(lon: number, lat: number): boolean {
  let x = lon % 360.0;
  if (x < 0.0) x += 360.0;
  if (!(XB_LEFT[1] < x && x < XB_RIGHT[0] && YB_LEFT[0] < lat && lat < YB_LEFT[2])) return false;
  return xinterp1(YB_LEFT, XB_LEFT, lat) <= x && x <= xinterp1(YB_RIGHT, XB_RIGHT, lat);
}

/**
 * Practical Salinity from conductivity, PSS-78.
 *
 * `c` is in mS/cm (equivalently mmho/cm), `t` is ITS-90. PSS-78 is defined
 * over 2 <= SP <= 42; outside that the calculator says so rather than
 * quietly extrapolating.
 */
export function spFromC(c: number, t: number, p: number): number {
  let sp = 0, t68 = 0, ft68 = 0, r = 0, rt_lc = 0, rp = 0, rt = 0, rtx = 0, hill_ratio = 0, x = 0, sqrty = 0, part1 = 0, part2 = 0, sp_hill_raw = 0;

  t68     = t*1.00024e0;
  ft68    = (t68 - 15e0)/(1e0 + k*(t68 - 15e0));
      /*
       ! The dimensionless conductivity ratio, R, is the conductivity input, C,
       ! divided by the present estimate of C(SP=35, t_68=15, p=0) which is
       ! 42.9140 mS/cm (=4.29140 S/m), (Culkin and Smith, 1980).
      */

  r = c/C3515;        /* 0.023302418791070513 = 1./42.9140 */

  /*rt_lc corresponds to rt as defined in the UNESCO 44 (1983) routines.*/
  rt_lc   = c0 + (c1 + (c2 + (c3 + c4*t68)*t68)*t68)*t68;
  rp      = 1e0 + (p*(e1 + e2*p + e3*p*p))/(1e0 + d1*t68 + d2*t68*t68 +
            (d3 + d4*t68)*r);
  rt      = r/(rp*rt_lc);

  if (rt < 0.0) {
      return NaN;
  }

  rtx     = Math.sqrt(rt);

  sp      = a0 + (a1 + (a2 + (a3 + (a4 + a5*rtx)*rtx)*rtx)*rtx)*rtx +
            ft68*(b0 + (b1 + (b2 + (b3 +
                  (b4 + b5*rtx)*rtx)*rtx)*rtx)*rtx);
      /*
       ! The following section of the code is designed for SP < 2 based on the
       ! Hill et al. (1986) algorithm.  This algorithm is adjusted so that it is
       ! exactly equal to the PSS-78 algorithm at SP = 2.
      */

  if (sp < 2) {
      hill_ratio  = hillRatioAtSP2(t);
      x           = 400e0*rt;
      sqrty       = 10e0*rtx;
      part1       = 1e0 + x*(1.5e0 + x);
      part2       = 1e0 + sqrty*(1e0 + sqrty*(1e0 + sqrty));
      sp_hill_raw = sp - a0/part1 - b0*ft68/part2;
      sp          = hill_ratio*sp_hill_raw;
  }

      /* This line ensures that SP is non-negative. */
  if (sp < 0.0) {
      sp  = NaN;
  }

  return sp;
}

/** Conductivity in mS/cm from Practical Salinity, the inverse of PSS-78. */
export function cFromSP(sp: number, t: number, p: number): number {
  let p0 = 4.577801212923119e-3, p1 = 1.924049429136640e-1, p2 = 2.183871685127932e-5, p3 = -7.292156330457999e-3, p4 = 1.568129536470258e-4, p5 = -1.478995271680869e-6, p6 = 9.086442524716395e-4, p7 = -1.949560839540487e-5, p8 = -3.223058111118377e-6, p9 = 1.175871639741131e-7, p10 = -7.522895856600089e-5, p11 = -2.254458513439107e-6, p12 = 6.179992190192848e-7, p13 = 1.005054226996868e-8, p14 = -1.923745566122602e-9, p15 = 2.259550611212616e-6, p16 = 1.631749165091437e-7, p17 = -5.931857989915256e-9, p18 = -4.693392029005252e-9, p19 = 2.571854839274148e-10, p20 = 4.198786822861038e-12, q0 = 5.540896868127855e-5, q1 = 2.015419291097848e-1, q2 = -1.445310045430192e-5, q3 = -1.567047628411722e-2, q4 = 2.464756294660119e-4, q5 = -2.575458304732166e-7, q6 = 5.071449842454419e-3, q7 = -9.081985795339206e-5, q8 = -3.635420818812898e-6, q9 = 2.249490528450555e-8, q10 = -1.143810377431888e-3, q11 = 2.066112484281530e-5, q12 = 7.482907137737503e-7, q13 = 4.019321577844724e-8, q14 = -5.755568141370501e-10, q15 = 1.120748754429459e-4, q16 = -2.420274029674485e-6, q17 = -4.774829347564670e-8, q18 = -4.279037686797859e-9, q19 = -2.045829202713288e-10, q20 = 5.025109163112005e-12, s0 = 3.432285006604888e-3, s1 = 1.672940491817403e-1, s2 = 2.640304401023995e-5, s3 = 1.082267090441036e-1, s4 = -6.296778883666940e-5, s5 = -4.542775152303671e-7, s6 = -1.859711038699727e-1, s7 = 7.659006320303959e-4, s8 = -4.794661268817618e-7, s9 = 8.093368602891911e-9, s10 = 1.001140606840692e-1, s11 = -1.038712945546608e-3, s12 = -6.227915160991074e-6, s13 = 2.798564479737090e-8, s14 = -1.343623657549961e-10, s15 = 1.024345179842964e-2, s16 = 4.981135430579384e-4, s17 = 4.466087528793912e-6, s18 = 1.960872795577774e-8, s19 = -2.723159418888634e-10, s20 = 1.122200786423241e-12, u0 = 5.180529787390576e-3, u1 = 1.052097167201052e-3, u2 = 3.666193708310848e-5, u3 = 7.112223828976632e0, u4 = -3.631366777096209e-4, u5 = -7.336295318742821e-7, u6 = -1.576886793288888e+2, u7 = -1.840239113483083e-3, u8 = 8.624279120240952e-6, u9 = 1.233529799729501e-8, u10 = 1.826482800939545e+3, u11 = 1.633903983457674e-1, u12 = -9.201096427222349e-5, u13 = -9.187900959754842e-8, u14 = -1.442010369809705e-10, u15 = -8.542357182595853e+3, u16 = -1.408635241899082e0, u17 = 1.660164829963661e-4, u18 = 6.797409608973845e-7, u19 = 3.345074990451475e-10, u20 = 8.285687652694768e-13;

  let t68 = 0, ft68 = 0, x = 0, rtx=0.0, dsp_drtx = 0, sqrty = 0, part1 = 0, part2 = 0, hill_ratio = 0, sp_est = 0, rtx_old = 0, rt = 0, aa = 0, bb = 0, cc = 0, dd = 0, ee = 0, ra = 0, r = 0, rt_lc = 0, rtxm = 0, sp_hill_raw = 0;

  t68     = t*1.00024e0;
  ft68    = (t68 - 15e0)/(1e0 + k*(t68 - 15e0));

  x       = Math.sqrt(sp);

      /*
       |--------------------------------------------------------------------------
       ! Finding the starting value of Rtx, the square root of Rt, using four
       ! different polynomials of SP and t68.
       !--------------------------------------------------------------------------
      */

  if (sp >= 9.0) {
      rtx = p0 + x*(p1 + p4*t68 + x*(p3 + p7*t68 + x*(p6
            + p11*t68 + x*(p10 + p16*t68 + x*p15))))
            + t68*(p2+ t68*(p5 + x*x*(p12 + x*p17) + p8*x
            + t68*(p9 + x*(p13 + x*p18)+ t68*(p14 + p19*x + p20*t68))));
  } else if (sp >= 0.25 && sp < 9.0) {
      rtx = q0 + x*(q1 + q4*t68 + x*(q3 + q7*t68 + x*(q6
            + q11*t68 + x*(q10 + q16*t68 + x*q15))))
            + t68*(q2+ t68*(q5 + x*x*(q12 + x*q17) + q8*x
            + t68*(q9 + x*(q13 + x*q18)+ t68*(q14 + q19*x + q20*t68))));
  } else if (sp >= 0.003 && sp < 0.25) {
      rtx =  s0 + x*(s1 + s4*t68 + x*(s3 + s7*t68 + x*(s6
            + s11*t68 + x*(s10 + s16*t68 + x*s15))))
            + t68*(s2+ t68*(s5 + x*x*(s12 + x*s17) + s8*x
            + t68*(s9 + x*(s13 + x*s18)+ t68*(s14 + s19*x + s20*t68))));
  } else if (sp < 0.003) {
      rtx =  u0 + x*(u1 + u4*t68 + x*(u3 + u7*t68 + x*(u6
            + u11*t68 + x*(u10 + u16*t68 + x*u15))))
            + t68*(u2+ t68*(u5 + x*x*(u12 + x*u17) + u8*x
            + t68*(u9 + x*(u13 + x*u18)+ t68*(u14 + u19*x + u20*t68))));
  }

      /*
       !--------------------------------------------------------------------------
       ! Finding the starting value of dSP_dRtx, the derivative of SP with respect
       ! to Rtx.
       !--------------------------------------------------------------------------
      */
  dsp_drtx        =  a1 + (2e0*a2 + (3e0*a3 +
                          (4e0*a4 + 5e0*a5*rtx)*rtx)*rtx)*rtx
                    + ft68*(b1 + (2e0*b2 + (3e0*b3 + (4e0*b4 +
                          5e0*b5*rtx)*rtx)*rtx)*rtx);

  if (sp < 2.0) {
      x           = 400e0*(rtx*rtx);
      sqrty       = 10.0*rtx;
      part1       = 1e0 + x*(1.5e0 + x);
      part2       = 1e0 + sqrty*(1e0 + sqrty*(1e0 + sqrty));
      hill_ratio  = hillRatioAtSP2(t);
      dsp_drtx    = dsp_drtx
                    + a0*800e0*rtx*(1.5e0 + 2e0*x)/(part1*part1)
                    + b0*ft68*(10e0 + sqrty*(20e0 + 30e0*sqrty))/
                          (part2*part2);
      dsp_drtx    = hill_ratio*dsp_drtx;
  }

      /*
       !--------------------------------------------------------------------------
       ! One iteration through the modified Newton-Raphson method (McDougall and
       ! Wotherspoon, 2012) achieves an error in Practical Salinity of about
       ! 10^-12 for all combinations of the inputs.  One and a half iterations of
       ! the modified Newton-Raphson method achevies a maximum error in terms of
       ! Practical Salinity of better than 2x10^-14 everywhere.
       !
       ! We recommend one and a half iterations of the modified Newton-Raphson
       ! method.
       !
       ! Begin the modified Newton-Raphson method.
       !--------------------------------------------------------------------------
      */
  sp_est  = a0 + (a1 + (a2 + (a3 + (a4 + a5*rtx)*rtx)*rtx)*rtx)*rtx
          + ft68*(b0 + (b1 + (b2+ (b3 + (b4 + b5*rtx)*rtx)*rtx)*rtx)*rtx);
  if (sp_est <  2.0) {
      x           = 400e0*(rtx*rtx);
      sqrty       = 10e0*rtx;
      part1       = 1e0 + x*(1.5e0 + x);
      part2       = 1e0 + sqrty*(1e0 + sqrty*(1e0 + sqrty));
      sp_hill_raw = sp_est - a0/part1 - b0*ft68/part2;
      hill_ratio  = hillRatioAtSP2(t);
      sp_est      = hill_ratio*sp_hill_raw;
  }

  rtx_old = rtx;
  rtx     = rtx_old - (sp_est - sp)/dsp_drtx;

  rtxm    = 0.5e0*(rtx + rtx_old); /*This mean value of Rtx, Rtxm, is the
            value of Rtx at which the derivative dSP_dRtx is evaluated.*/

  dsp_drtx=  a1 + (2e0*a2 + (3e0*a3 + (4e0*a4 +
                          5e0*a5*rtxm)*rtxm)*rtxm)*rtxm
             + ft68*(b1 + (2e0*b2 + (3e0*b3 + (4e0*b4 +
                          5e0*b5*rtxm)*rtxm)*rtxm)*rtxm);
  if (sp_est <  2.0) {
      x   = 400e0*(rtxm*rtxm);
      sqrty       = 10e0*rtxm;
      part1       = 1e0 + x*(1.5e0 + x);
      part2       = 1e0 + sqrty*(1e0 + sqrty*(1e0 + sqrty));
      dsp_drtx    = dsp_drtx
                    + a0*800e0*rtxm*(1.5e0 + 2e0*x)/(part1*part1)
                    + b0*ft68*(10e0 + sqrty*(20e0 + 30e0*sqrty))/
                          (part2*part2);
      hill_ratio  = hillRatioAtSP2(t);
      dsp_drtx    = hill_ratio*dsp_drtx;
  }

      /*
       !--------------------------------------------------------------------------
       ! The line below is where Rtx is updated at the end of the one full
       ! iteration of the modified Newton-Raphson technique.
       !--------------------------------------------------------------------------
      */
  rtx     = rtx_old - (sp_est - sp)/dsp_drtx;
      /*
       !--------------------------------------------------------------------------
       ! Now we do another half iteration of the modified Newton-Raphson
       ! technique, making a total of one and a half modified N-R iterations.
       !--------------------------------------------------------------------------
      */
  sp_est  = a0 + (a1 + (a2 + (a3 + (a4 + a5*rtx)*rtx)*rtx)*rtx)*rtx
          + ft68*(b0 + (b1 + (b2+ (b3 + (b4 + b5*rtx)*rtx)*rtx)*rtx)*rtx);
  if (sp_est <  2.0) {
      x           = 400e0*(rtx*rtx);
      sqrty       = 10e0*rtx;
      part1       = 1e0 + x*(1.5e0 + x);
      part2       = 1e0 + sqrty*(1e0 + sqrty*(1e0 + sqrty));
      sp_hill_raw = sp_est - a0/part1 - b0*ft68/part2;
      hill_ratio  = hillRatioAtSP2(t);
      sp_est      = hill_ratio*sp_hill_raw;
  }
  rtx     = rtx - (sp_est - sp)/dsp_drtx;

      /*
       !--------------------------------------------------------------------------
       ! Now go from Rtx to Rt and then to the conductivity ratio R at pressure p.
       !--------------------------------------------------------------------------
      */
  rt      = rtx*rtx;

  aa      = d3 + d4*t68;
  bb      = 1e0 + t68*(d1 + d2*t68);
  cc      = p*(e1 + p*(e2 + e3*p));
      /* rt_lc (i.e. rt_lower_case) corresponds to rt as defined in
         the UNESCO 44 (1983) routines. */
  rt_lc   = c0 + (c1 + (c2 + (c3 + c4*t68)*t68)*t68)*t68;

  dd      = bb - aa*rt_lc*rt;
  ee      = rt_lc*rt*aa*(bb + cc);
  ra      = Math.sqrt(dd*dd + 4e0*ee) - dd;
  r       = 0.5e0*ra/aa;

      /*
       ! The dimensionless conductivity ratio, R, is the conductivity input, C,
       ! divided by the present estimate of C(SP=35, t_68=15, p=0) which is
       ! 42.9140 mS/cm (=4.29140 S/m^).
      */
  return C3515*r;
}

/**
 * The Hill et al. (1986) ratio, which extends PSS-78 below SP = 2.
 *
 * PSS-78 is only defined down to 2; the ratio is what makes an estuary
 * measurement mean anything at all.
 */
function hillRatioAtSP2(t: number): number {
  let g0 = 2.641463563366498e-1, g1 = 2.007883247811176e-4, g2 = -4.107694432853053e-6, g3 = 8.401670882091225e-8, g4 = -1.711392021989210e-9, g5 = 3.374193893377380e-11, g6 = -5.923731174730784e-13, g7 = 8.057771569962299e-15, g8 = -7.054313817447962e-17, g9 = 2.859992717347235e-19, sp2 = 2.0;
  let t68 = 0, ft68 = 0, rtx0 = 0, dsp_drtx = 0, sp_est = 0, rtx = 0, rtxm = 0, x = 0, part1 = 0, part2 = 0;
  let sqrty = 0, sp_hill_raw_at_sp2 = 0;

  t68     = t*1.00024;
  ft68    = (t68 - 15.0)/(1.0 + k*(t68 - 15.0));

      /*!------------------------------------------------------------------------
      **! Find the initial estimates of Rtx (Rtx0) and of the derivative dSP_dRtx
      **! at SP = 2.
      **!------------------------------------------------------------------------
      */
  rtx0    = g0 + t68*(g1 + t68*(g2 + t68*(g3 + t68*(g4 + t68*(g5
          + t68*(g6 + t68*(g7 + t68*(g8 + t68*g9))))))));

  dsp_drtx= a1 + (2*a2 + (3*a3 + (4*a4 + 5*a5*rtx0)*rtx0)*rtx0)*rtx0 +
          ft68*(b1 + (2*b2 + (3*b3 + (4*b4 + 5*b5*rtx0)*rtx0)*rtx0)*rtx0);

      /*!-------------------------------------------------------------------------
      **! Begin a single modified Newton-Raphson iteration to find Rt at SP = 2.
      **!-------------------------------------------------------------------------
      */
  sp_est  = a0 + (a1 + (a2 + (a3 + (a4 + a5*rtx0)*rtx0)*rtx0)*rtx0)*rtx0
          + ft68*(b0 + (b1 + (b2+ (b3 + (b4 + b5*rtx0)*rtx0)*rtx0)*
            rtx0)*rtx0);
  rtx     = rtx0 - (sp_est - sp2)/dsp_drtx;
  rtxm    = 0.5*(rtx + rtx0);
  dsp_drtx= a1 + (2*a2 + (3*a3 + (4*a4 + 5*a5*rtxm)*rtxm)*rtxm)*rtxm
          + ft68*(b1 + (2*b2 + (3*b3 + (4*b4 + 5*b5*rtxm)*
                                          rtxm)*rtxm)*rtxm);
  rtx     = rtx0 - (sp_est - sp2)/dsp_drtx;
      /*
      **! This is the end of one full iteration of the modified Newton-Raphson
      **! iterative equation solver. The error in Rtx at this point is equivalent
      **! to an error in SP of 9e-16 psu.
      */

  x       = 400.0*rtx*rtx;
  sqrty   = 10.0*rtx;
  part1   = 1.0 + x*(1.5 + x);
  part2   = 1.0 + sqrty*(1.0 + sqrty*(1.0 + sqrty));
  sp_hill_raw_at_sp2 = sp2 - a0/part1 - b0*ft68/part2;

  return 2.0/sp_hill_raw_at_sp2;
}

/** Reference Salinity from Practical Salinity, g/kg. */
export function srFromSP(sp: number): number {
  return sp*UPS;
}

/** Practical Salinity from Reference Salinity. */
export function spFromSR(sr: number): number {
  return sr / UPS;
}

/** Practical Salinity from Knudsen Salinity, for pre-1978 archives. */
export function spFromSK(sk: number): number {
  return (sk - 0.03) * (SSO / 1.805);
}

/** Chlorinity from Practical Salinity, g/kg. */
export function chlorinity(sp: number): number {
  return sp / SONCL;
}

/**
 * Absolute Salinity from Practical Salinity, g/kg.
 *
 * Without an atlas, or outside its coverage, this is NaN -- the caller falls
 * back to Reference Salinity and says which it used. Returning SR silently
 * under the name SA is the failure this package will not make: the whole
 * point of the anomaly is that it is invisible on screen.
 */
export function saFromSP(sp: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  if (inBaltic(lon, lat)) return ((SSO - 0.087) / 35.0) * sp + 0.087;
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return UPS * sp * (1.0 + saar);
}

/** Practical Salinity from Absolute Salinity. */
export function spFromSA(sa: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  if (inBaltic(lon, lat)) return (35.0 / (SSO - 0.087)) * (sa - 0.087);
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return (sa / UPS) / (1.0 + saar);
}

/** Preformed Salinity from Practical Salinity, g/kg. In the Baltic, S* = SA. */
export function sstarFromSP(sp: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  if (inBaltic(lon, lat)) return ((SSO - 0.087) / 35.0) * sp + 0.087;
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return UPS * sp * (1 - 0.35 * saar);
}

/** Preformed Salinity from Absolute Salinity, g/kg. */
export function sstarFromSA(sa: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return sa * (1.0 - 0.35 * saar) / (1.0 + saar);
}

/** Absolute Salinity from Preformed Salinity, g/kg. */
export function saFromSstar(sstar: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return sstar * (1.0 + saar) / (1.0 - 0.35 * saar);
}

/** The Absolute Salinity Anomaly itself, SA - SR, g/kg. */
export function deltaSA(sp: number, p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  return saFromSP(sp, p, lon, lat, atlas) - srFromSP(sp);
}

/** The ratio form of the anomaly used for S*, unitless. */
export function fdelta(p: number, lon: number, lat: number, atlas?: Anomaly | null): number {
  const saar = atlas ? atlas.saar(p, lon, lat) : NaN;
  return ((1.0 + 0.35) * saar) / (1.0 - 0.35 * saar);
}
