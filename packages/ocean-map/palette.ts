/* The map's colours, typed.
 *
 * map-palette.json is the single source of truth — the component reads it and
 * scripts/test-contrast.mjs measures every entry against the sampled water of
 * every basemap. Importing raw JSON gives TypeScript a structural type that is
 * either too narrow (literal unions for every hex) or, once indexed
 * dynamically, no type at all, which is why every use site had grown an
 * `as any`. Declaring the shape once here removes six of them and puts the
 * meaning somewhere a reader can find it.
 *
 * Never inline a colour anywhere else: a hardcoded one is invisible to the
 * contrast gate.
 */
import raw from './data/map-palette.json';

export interface Palette {
  /** Marker and line colours, keyed by feature. */
  features: Record<string, string>;
  /** The current-particle ramp, slow to fast. */
  currents: string[];
  /** The wind-particle ramp, slow to fast. Its own ramp rather than the
      currents', because the two fields can be drawn at the same time and
      drifting lines are told apart by nothing else — see `_wind` in
      map-palette.json for what that constraint measured out to. */
  wind: string[];
  /** Every colour scale a reader may choose, as "#rrggbb" stops. */
  colormaps: Record<string, string[]>;
  /** Scales whose every stop clears ΔE 22 from every marker. */
  markerSafe: string[];
  /** Which scale each field opens on, keyed by field. */
  defaultColormap: Record<string, string>;
  /** Fields whose default is knowingly not marker-safe, with the reasoning
      recorded in the `_defaultExempt` note beside it. */
  defaultExempt?: string[];
  /** Features exempt from the particle-separation check, likewise. */
  /** Every place a colour knowingly sits under the gate's ΔE bar, with the
      measured distance and the reason. Checked both ways by
      scripts/test-contrast.mjs: an unlisted clash fails, and a listing for a
      pair that actually clears fails too, so the record cannot rot into a
      warning nobody reads. See `_concessions` in map-palette.json. */
  concessions?: { pair: string; deltaE: number; why: string }[];
}

/* The `_`-prefixed keys in the file are prose explaining each decision — the
   reasoning lives with the data rather than in a commit message. They are
   deliberately not part of this type. */
export const palette = raw as unknown as Palette;
