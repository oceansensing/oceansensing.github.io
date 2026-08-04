/* The shape of every file the map reads.
 *
 * This contract was implicit: written by four Python scripts, read by a
 * TypeScript module that cast most of it to `any`, and agreed on by nothing.
 * Two of the worst bugs in this project were drift across exactly that gap and
 * neither was caught at the boundary —
 *
 *   - ERDDAP writes a missing value as an empty field where THREDDS writes
 *     `NaN`, so land was dropped rather than marked and rows came back ragged
 *     and shifted west: 81 wide over Antarctica against 360 in open water.
 *   - `time[0:1:128]` went out of range when the FMRC aggregation shortened to
 *     121 steps, every fetch 400'd, the fallback kept the previous file, and
 *     the build reported success while serving a two-day-old model run.
 *
 * Writing it down serves three readers. The module gets types instead of
 * `any`. scripts/test-schema.mjs gets something to check the published files
 * against, so drift fails at the boundary rather than showing up as a blank
 * layer. And a native port gets the definition it needs — these declarations
 * are what a Swift `Codable` mirrors, and they are the reason an iOS app can
 * read this data without reverse-engineering the Python.
 *
 * Nothing here imports Leaflet or the DOM. Keep it that way.
 */

// ---- shared -----------------------------------------------------------

/** ISO 8601, always UTC, always with the trailing Z. */
export type Timestamp = string;

/** A [longitude, latitude] pair, in that order — GeoJSON's, not Leaflet's. */
export type LonLat = [number, number];

// ---- ocean-assets.json ------------------------------------------------

/* Storm intensity and pressure are **strings**, not numbers, and that is not
   an oversight: the NHC publishes them with qualifiers, and a blank is a real
   answer the parser must not turn into 0. */
export interface Storm {
  id: string;
  name: string;
  classification: string;
  intensityKt: string;
  pressureMb: string;
  lat: number;
  lon: number;
  movementDir: number;
  movementSpeedKt: number;
  lastUpdate: Timestamp;
  advisoryUrl: string;
  /** Forecast positions ahead of the last fix. */
  track: LonLat[];
  /** The forecast uncertainty cone, as a ring. */
  cone: LonLat[];
  /** Observed positions over the history window. */
  history: LonLat[];
}

export type AssetKind = 'usv' | 'glider';

export interface Asset {
  id: string;
  kind: AssetKind;
  deployed: Timestamp;
  title: string;
  institution: string;
  /** Link to the source dataset. */
  info: string;
  /** The last fix. */
  time: Timestamp;
  lat: number;
  lon: number;
  track: LonLat[];
  /** Absent for platforms whose source names no operating area. */
  where?: string;
}

export interface OceanAssets {
  updated: Timestamp;
  /** How far back fixes were gathered. Argo overrides this — see ArgoFile. */
  historyDays: number;
  storms: Storm[];
  assets: Asset[];
  /** Attribution, keyed by platform kind. */
  sources: Record<string, string>;
}

// ---- argo.json --------------------------------------------------------

export interface ArgoFloat {
  id: string;
  lat: number;
  lon: number;
  time: Timestamp;
}

/* Its own file, and its own window. A float cycle is ten days, so the fleet's
   history window cannot be the five days a glider reporting hourly wants:
   measured against Ifremer, 1,992 floats surfaced in 5 days against 4,027 in
   12, with nothing on screen to say half the fleet was missing. */
export interface ArgoFile {
  updated: Timestamp;
  historyDays: number;
  source: string;
  floats: ArgoFloat[];
}

// ---- gridded fields ---------------------------------------------------

/** A finer grid covering part of the world, offered above `minZoom`. */
export interface RegionLink {
  /** Resolved against the map's dataBase, not fetched as given. */
  url: string;
  label: string;
  west: number;
  east: number;
  south: number;
  north: number;
  minZoom: number;
  /** Cell size in degrees. */
  deg: number;
}

/** One published frame of a forecast, listed by the base global file.

    The map learns which lead times exist from the data, the way it already
    learns the regions and the tile index — a list restated in the component
    would be a second source of truth for something the pipeline decides.

    Only the base file carries this — the one at the bare filename, whose own
    `lead` is the lowest published. Following a frame's `url` gets a file that
    knows its own `lead` and points at its own regions, and stops there; there
    is no chain to walk and no way to end up a frame off. */
export interface ForecastFrame {
  /** Hours after the **model run**, not after the build — T+36 is the step
      the run itself labels +36, whenever that run happens to have landed.
      Anchoring to the clock instead made a longer lead reach into an older
      run, since the newest is only ingested a day or so out. */
  lead: number;
  /** What that lead resolved to on the model's own time axis. This is the
      only number that answers "when is this field for", and it is what the
      map labels a frame with: a lead is counted from a run the reader knows
      nothing about. */
  valid: Timestamp;
  /** Resolved against the map's dataBase, not fetched as given. */
  url: string;
}

/* Row-major from the north-west corner: index = row * nx + column, with row 0
   at `la1` and column 0 at `lo1`. Longitude wraps and latitude does not — a
   global grid must span a full 360°, which is the exact condition
   the particle field uses to advect across the antimeridian. */
export interface GridHeader {
  nx: number;
  ny: number;
  /** West edge, degrees east. Grids start at 0°E, so half the world is west of it. */
  lo1: number;
  /** North edge, degrees north. */
  la1: number;
  dx: number;
  dy: number;
  /** The time step this field is valid for. */
  refTime: Timestamp;
  /** Which model run produced it. Absent for an analysis, which has none —
      and the distinction matters: a forecast step valid an hour from now is
      worthless if it came from a run three days old. */
  modelRun?: Timestamp;
  source?: string;
  units?: string;
  /** Metres below the surface. */
  depth?: number;
  /** Metres **above** the surface, for an atmospheric field — the wind's
      analogue of `depth`, and deliberately a separate name. One signed
      number for both would make 10 m of air and 10 m of water differ by a
      minus sign nobody would notice reading a header. */
  height?: number;
  /** Hours after the model run this frame is for; absent for an analysis,
      which has no run to count from. Read from here rather than inferred
      from the filename, for the same reason `depth` is: a mislabelled frame
      then shows on screen as the wrong hour rather than as the right hour
      over the wrong water.

      Note this says nothing about how far ahead of *now* the field is —
      `refTime` against the reader's clock is the only thing that does, since
      a run can land a day and a half late. */
  lead?: number;
  /** Link to the tile index for this product, if it has a tile tier. Each
      frame's own — a frame pointing at another lead's tiles would draw a
      different hour at 1/12° and call it this one, which is the failure that
      looks most like success. */
  tileIndex?: string;
  /** Finer regional grids, coarsest first, and each frame's own: a global
      file pointing at another lead's regions would step through time on
      zooming in, with nothing on screen to give it away. */
  details?: RegionLink[];
  /** The forecast frames this product publishes. Base global file only, and
      absent for an analysis, which has no forecast — which is why the lead
      control offers nothing for OISST rather than sitting there dead. */
  forecast?: ForecastFrame[];
}

/** Which component is which. GRIB conventions, kept because the published
    files use them and a native port reads the same numbers. */
export interface VectorHeader extends GridHeader {
  parameterCategory: number;
  parameterNumber: number;
  parameterUnit: string;
}

/** `null` is land or no data — never 0, which is a legitimate value. */
export type GridData = (number | null)[];

export interface ScalarGrid {
  header: GridHeader;
  data: GridData;
}

/** Exactly two components, u then v. */
export type VectorGrid = [{ header: VectorHeader; data: GridData }, { header: VectorHeader; data: GridData }];

// ---- tile indices -----------------------------------------------------

export interface TileIndexFile {
  /** Degrees per tile, square. */
  size: number;
  /** South-west origin of the lattice. */
  west: number;
  south: number;
  north: number;
  /** Below this the tier stands down and the coarser grid serves. */
  minZoom: number;
  /** Cell size within a tile, for gridded products. */
  deg?: number;
  /** Contour depths, for the isobath tiles. */
  levels?: number[];
  refTime?: Timestamp;
  /** Keys that were written. The rest are land or empty ocean, and their
      absence is meaningful rather than an error. */
  available: string[];
}

// ---- vector overlays --------------------------------------------------

/** Natural Earth, RDP-simplified. Rings of [lon, lat]. */
export interface CoastlineFile {
  rings: LonLat[][];
}

export interface BoundariesFile {
  countries: LonLat[][];
  states: LonLat[][];
}

/** Isobaths. One LineString per contour, `d` metres below the surface. */
export interface IsobathFeature {
  type: 'Feature';
  properties: { d: number };
  geometry: { type: 'LineString'; coordinates: LonLat[] };
}

export interface IsobathFile {
  type: 'FeatureCollection';
  features: IsobathFeature[];
}

/** The sea ice edge: one LineString per run of the concentration contour,
    `c` being the fraction it was cut at (0.15, the extent convention every
    ice service reports).

    Shaped like the isobaths deliberately — it is the same kind of thing, a
    threshold through a scalar field — so the map draws it down the same path
    and a native port reuses the same reader.

    It carries a header where the isobaths do not, because unlike the
    seafloor it has a date: an edge with no valid time is a line a reader
    cannot tell from last winter's. */
export interface IceEdgeFile {
  type: 'FeatureCollection';
  header: {
    product: string;
    source: string;
    /** ISO 8601 with a trailing Z, like every other timestamp here. */
    valid: string;
    /** The concentration the line was cut at, as a fraction. */
    threshold: number;
    lead: number;
    /** Absent on an analysis, which has no run — its own date is the
        answer. Present on a forecast, and the only thing that distinguishes
        a current field from a stale one. */
    modelRun?: string;
  };
  features: {
    type: 'Feature';
    properties: { c: number };
    geometry: { type: 'LineString'; coordinates: LonLat[] };
  }[];
}
