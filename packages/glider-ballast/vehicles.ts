/**
 * Starting points for the four glider families, and a warning about them.
 *
 * **None of these numbers is manufacturer data, and the page says so on every
 * one of them.** They are round figures chosen to be obviously round: each
 * mass is a whole or half kilogram in the range these vehicles occupy, and
 * each volume is simply that mass divided by 1025 kg/m^3 — so the vehicle
 * starts out neutral in round-number water and the page computes something
 * sensible on arrival. Read the volumes as "whatever makes this neutral at
 * 1025", not as a displacement anybody measured.
 *
 * The two hull coefficients are worse than approximate, because they are not
 * published for any of these vehicles in a form that could be quoted. They
 * are the *shape* of the answer: a compressibility a few times smaller than
 * seawater's own 4.3e-6 per dbar, and a thermal expansion around that of an
 * aluminium pressure hull. Both are properties of a particular vehicle with a
 * particular fairing, foam and oil volume, and both come off a ballast sheet
 * or out of a tank test.
 *
 * Why ship them at all: a page that opens with every field blank computes
 * nothing, and an operator cannot tell a tool that works from one that is
 * broken until they have typed six numbers into it. These make it work on
 * arrival and are labelled, in the interface and not only here, as numbers to
 * replace. `test:ballast` checks that the label is on the page.
 *
 * A real preset — mass, volume and both coefficients from an actual ballast
 * sheet, with the vehicle's serial number against it — is worth adding the
 * moment one is to hand. That is a data question, not a code one: add an
 * entry here with `illustrative: false` and the warning stops.
 */

import type { Hull } from './index.ts';

export interface Vehicle {
  id: string;
  /** What operators call it. */
  name: string;
  /** Who makes it, for the reader deciding which row is theirs. */
  maker: string;
  hull: Hull;
  /**
   * Whether these numbers are stand-ins. True for everything shipped today —
   * see the note at the top of this file. A vehicle with this false has been
   * taken from a real ballast sheet, and the page stops warning about it.
   */
  illustrative: boolean;
  /** Typical working depth, m — context for the pressure fields, not a spec. */
  typicalDepth: number;
}

/** The density the illustrative volumes are neutral in, kg/m^3. */
export const ROUND_WATER = 1025;

/**
 * Seawater's own compressibility near 10 degC, per dbar, to about one figure.
 *
 * Here so the interface can put the hull's number next to it: whether a
 * glider gains or loses buoyancy going down is decided by which of the two is
 * larger, and that comparison is the single thing operators most often have
 * the wrong way round. The page computes the actual water value from TEOS-10
 * for the reader's own water; this is only for the field's help text.
 */
export const SEAWATER_COMPRESSIBILITY = 4.3e-6;

const round = (mass: number, extras: {
  compressibility: number;
  thermalExpansion: number;
  pumpRange: number;
}): Hull => ({
  mass,
  /* Rounded to the millilitre, which is about a gram of buoyancy on a hull
     this size — the resolution the figure is worth, and the resolution the
     page displays it at.
 
     That last part is not cosmetic. An unrounded volume is shown rounded, so
     reading the box back gives a different number from the one stored, the
     state can never equal the defaults again, and Reset stops being able to
     tell that it has reset: it went on remembering a setup identical to the
     defaults and the address bar went on carrying one. Store what you show. */
  volume: Math.round((mass / ROUND_WATER) * 1000 * 1000) / 1000,
  referenceTemperature: 15,
  ...extras,
});

export const VEHICLES: Vehicle[] = [
  {
    id: 'slocum',
    name: 'Slocum G3',
    maker: 'Teledyne Webb Research',
    illustrative: true,
    typicalDepth: 1000,
    hull: round(54, { compressibility: 1.0e-6, thermalExpansion: 7.0e-5, pumpRange: 250 }),
  },
  {
    id: 'seaglider',
    name: 'Seaglider',
    maker: 'Huntington Ingalls / originally APL-UW',
    illustrative: true,
    typicalDepth: 1000,
    hull: round(52, { compressibility: 1.0e-6, thermalExpansion: 7.0e-5, pumpRange: 420 }),
  },
  {
    id: 'seaexplorer',
    name: 'SeaExplorer',
    maker: 'Alseamar',
    illustrative: true,
    typicalDepth: 700,
    hull: round(59, { compressibility: 1.0e-6, thermalExpansion: 7.0e-5, pumpRange: 500 }),
  },
  {
    id: 'spray',
    name: 'Spray',
    maker: 'Scripps / MRV Systems',
    illustrative: true,
    typicalDepth: 1500,
    hull: round(51, { compressibility: 1.0e-6, thermalExpansion: 7.0e-5, pumpRange: 450 }),
  },
];

export const vehicleById = (id: string): Vehicle | undefined =>
  VEHICLES.find((v) => v.id === id);
