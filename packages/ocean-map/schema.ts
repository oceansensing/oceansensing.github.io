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

/** One published frame of a forecast, listed by the lead-0 global file.

    The map learns which lead times exist from the data, the way it already
    learns the regions and the tile index — a list restated in the component
    would be a second source of truth for something the pipeline decides.

    Only the lead-0 file carries this. Following a frame's `url` gets a file
    that knows its own `lead` and points at its own regions, and stops there;
    there is no chain to walk and no way to end up a frame off. */
export interface ForecastFrame {
  /** Hours ahead of the build. 0 is the field for now. */
  lead: number;
  /** What that lead resolved to on the model's own time axis. */
  valid: Timestamp;
  /** Resolved against the map's dataBase, not fetched as given. */
  url: string;
}

/* Row-major from the north-west corner: index = row * nx + column, with row 0
   at `la1` and column 0 at `lo1`. Longitude wraps and latitude does not — a
   global grid must span a full 360°, which is the exact condition
   leaflet-velocity uses to advect particles across the antimeridian. */
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
  /** Hours ahead of the build this frame is for; 0 or absent is the field for
      now. Read from here rather than inferred from the filename, for the same
      reason `depth` is: a mislabelled frame then shows on screen as the wrong
      hour rather than as the right hour over the wrong water. */
  lead?: number;
  /** Link to the tile index for this product, if it has a tile tier.
      **Lead 0 only.** Five frames of the 1/12° tiles would be 460 MB per
      depth, so above lead 0 the regional grids are the finest tier there is
      and the map has to say so. */
  tileIndex?: string;
  /** Finer regional grids, coarsest first. At lead > 0 these are that lead's
      own regions — a +24h global file pointing at the regions for now would
      step back in time on zooming in, with nothing on screen to give it
      away. */
  details?: RegionLink[];
  /** The forecast frames this product publishes. Lead-0 global file only, and
      absent for an analysis, which has no forecast — which is why the lead
      control offers nothing for OISST rather than sitting there dead. */
  forecast?: ForecastFrame[];
}

/** leaflet-velocity identifies the u and v components by these. */
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
