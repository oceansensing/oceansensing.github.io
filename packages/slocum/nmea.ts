/**
 * Slocum records position as NMEA `±DDDMM.MMMM` — degrees × 100 plus decimal
 * minutes — so `3812.9969` is 38° 12.9969′ N, which is 38.2166° and not
 * 3812.9969 of anything.
 *
 * This is the single most consequential unit in the format. Drawn on a map
 * without conversion, a glider off New Jersey plots nowhere at all; converted
 * with the wrong divisor it plots somewhere plausible and wrong, which is
 * worse. The conversion is therefore applied by name from an explicit list —
 * the same list `dbdreader` and `SlocumIO.jl` carry — rather than guessed
 * from the value, because a waypoint at 0°N 0°E and an unconverted 0 are the
 * same number.
 */

/**
 * The sensors that hold NMEA positions.
 *
 * Named rather than pattern-matched. `m_gps_full_status` ends in nothing
 * useful and `c_wpt_x_lmc` is a position in metres in a local frame — a rule
 * like "contains lat" would convert some of these and a rule like "ends in
 * _lat" would miss `u_lat_goto_l99`. This list is what both reference
 * implementations use, and the fixture is checked against it.
 */
export const LATLON_SENSORS: ReadonlySet<string> = new Set([
  'm_lat', 'm_lon',
  'c_wpt_lat', 'c_wpt_lon',
  'x_last_wpt_lat', 'x_last_wpt_lon',
  'm_gps_lat', 'm_gps_lon',
  'u_lat_goto_l99', 'u_lon_goto_l99',
  'm_last_gps_lat_1', 'm_last_gps_lon_1',
  'm_last_gps_lat_2', 'm_last_gps_lon_2',
  'm_last_gps_lat_3', 'm_last_gps_lon_3',
  'm_last_gps_lat_4', 'm_last_gps_lon_4',
  'm_gps_ignored_lat', 'm_gps_ignored_lon',
  'm_gps_invalid_lat', 'm_gps_invalid_lon',
  'm_gps_toofar_lat', 'm_gps_toofar_lon',
  'xs_lat', 'xs_lon',
  's_ini_lat', 's_ini_lon',
]);

/** Whether this sensor's values are NMEA positions. */
export function isLatLonSensor(name: string): boolean {
  return LATLON_SENSORS.has(name);
}

/** Whether a position sensor is a latitude — it bounds at 90°, not 180°. */
export function isLatitudeSensor(name: string): boolean {
  return name.includes('lat');
}

/** `3812.9969` → `38.216615`. */
export function nmeaToDecimal(x: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = Math.sign(x);
  const abs = Math.abs(x);
  const degrees = Math.floor(abs / 100);
  const minutes = abs - degrees * 100;
  return sign * (degrees + minutes / 60);
}

/**
 * Whether a value is a position at all.
 *
 * Stricter than `dbdreader`, which checks only the degree bound: this also
 * requires **minutes < 60**, because `5360.0` passes a bounds check and
 * converts to a clean 54.0° that nothing downstream can tell from a real
 * fix. The extra check is `SlocumIO.jl`'s, and it costs one subtraction.
 *
 * A glider with no fix writes a sentinel well outside these bounds, so this
 * doubles as the has-it-surfaced test.
 */
export function isValidNmea(x: number, isLatitude: boolean): boolean {
  if (!Number.isFinite(x)) return false;
  const abs = Math.abs(x);
  if (abs > (isLatitude ? 9000 : 18000)) return false;
  return abs - Math.floor(abs / 100) * 100 < 60;
}
