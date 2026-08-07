/**
 * The TEOS-10 constants, as IOC, SCOR and IAPSO (2010) define them.
 *
 * These are exact by definition rather than measured, which is why they are
 * written out in full rather than derived from each other at run time: SFAC
 * is 1/(40 * UPS) to the last digit the standard publishes, and computing it
 * would give a different final bit.
 *
 * `npm run test:teos10` checks each of them against the reference
 * implementation, because a constant is the one kind of number that looks
 * right at a glance and is silent when it is not.
 */

/** Pascals per decibar. */
export const DB2PA = 1.0e4;

/** Decibars per pascal. */
export const REC_DB2PA = 1.0e-4;

export const DEG2RAD = Math.PI / 180.0;

/** The fractional decrease in gravity per metre of height, for z <-> p. */
export const GAMMA = 2.26e-7;

/**
 * The "specific heat" that defines Conservative Temperature, J/(kg K).
 *
 * Not a heat capacity of any real seawater -- it is the fixed constant that
 * turns potential enthalpy into a temperature-like variable, which is the
 * whole point of CT. The actual heat capacity is `heatCapacity`, and the two
 * differ by up to about half a percent.
 */
export const CP0 = 3991.86795711963;

/** The Celsius zero point, K. */
export const T0 = 273.15;

/** One standard atmosphere, Pa -- the reference for absolute pressure. */
export const P0 = 101325.0;

/** Standard Ocean Reference Salinity, g/kg. */
export const SSO = 35.16504;

export const SQRTSSO = 5.930011804372737;

/** g/kg per unit of Practical Salinity: SR = UPS * SP. */
export const UPS = SSO / 35.0;

/** 1/(40 * UPS), the scaling inside the Gibbs function's salinity variable. */
export const SFAC = 0.0248826675584615;

/**
 * `24 * SFAC`, the shift inside the salinity variable of the polynomial
 * fits -- spiciness and the 75-term specific volume.
 *
 * It exists so those fits are in `sqrt(SFAC * SA + OFFSET)` rather than
 * `sqrt(SFAC * SA)`, which keeps the derivative finite at zero salinity.
 * The Gibbs function itself has no such offset; it is genuinely singular
 * there, which is a property of the physics rather than of the fit.
 */
export const OFFSET = 5.971840214030754e-1;

/** Conductivity at SP = 35, t_68 = 15 degC, p = 0, mS/cm. */
export const C3515 = 42.9140;

/** Practical Salinity to Chlorinity ratio, (g/kg)^-1. */
export const SONCL = 1.80655;
