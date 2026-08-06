/**
 * Where a reader can jump to, and what they might want to look at.
 *
 * Two lists, and **the split is the whole design**. A region moves the view
 * and touches nothing else; an interest sets layers and colour scales and
 * moves nothing. They are orthogonal, so they compose — pick the Chukchi
 * Sea, then pick Sea ice — and neither can surprise you by doing the
 * other's job. That is why they are two controls rather than one menu with
 * headings: a heading is a promise the reader has to read, and a separate
 * button is one they cannot miss.
 *
 * It replaced a fixed Basin/Global/Reset bar, which had two problems beyond
 * being short. "Global" did not mean the globe — it fitted the bounds of
 * whatever was reporting, which is a different thing and was mislabelled
 * from the start. And there was nowhere to put an eleventh idea.
 *
 * **No Leaflet and no DOM here**, so this is data an iOS port keeps: bounds
 * are `[[south, west], [north, east]]` in plain degrees, and the layer and
 * colormap names are the strings the switcher and the palette already use.
 * `check:docs` reads both against their sources, because a misspelt layer
 * name does nothing at all — no error, just a menu entry that appears to
 * work and changes nothing.
 */

/** `[[south, west], [north, east]]`, the shape Leaflet's fitBounds takes. */
export type PlaceBounds = [[number, number], [number, number]];

export interface Region {
  label: string;
  /** Absent means "computed" — see `dynamic`. */
  bounds?: PlaceBounds;
  /** A view the map works out at runtime rather than a fixed box.
      `home` is the page's own preset; `fleet` fits whatever is reporting. */
  dynamic?: 'home' | 'fleet';
  title: string;
}

export interface Interest {
  label: string;
  /** Overlay names, exactly as the layer switcher shows them. An empty
      list is meaningful: it is what "Reset" uses to mean the defaults. */
  layers?: string[];
  /** Colormap per field key, e.g. `{ sic: 'cmo.ice' }`. */
  colours?: Record<string, string>;
  /** Put everything back instead — basemap, layers, scales, tints, view. */
  reset?: boolean;
  title: string;
}

/* Bounds are deliberately generous. A reader picking "Mid-Atlantic Bight"
   wants the shelf and its edge, not a box cropped to a coastline, and a
   map that lands slightly wide reads as deliberate where one that clips a
   feature reads as broken. */
export const REGIONS: Region[] = [
  { label: 'Home', dynamic: 'home', title: "Back to this page's own view" },
  { label: 'All platforms', dynamic: 'fleet',
    title: 'Fit everything currently reporting' },

  // The lab's own water, north to south.
  { label: 'Chukchi Sea', bounds: [[65, -180], [76, -155]],
    title: 'Bering Strait to the Chukchi shelf break' },
  { label: 'Beaufort Sea', bounds: [[68, -160], [78, -120]],
    title: 'The Beaufort Gyre and the Alaskan and Canadian shelves' },
  { label: 'Nordic Seas & Fram Strait', bounds: [[62, -20], [82, 20]],
    title: 'Greenland Sea, Norwegian Sea and Fram Strait' },
  { label: 'Mid-Atlantic Bight', bounds: [[35, -76], [41.5, -69]],
    title: 'Cape Hatteras to Nantucket, shelf and shelf break' },

  { label: 'Gulf of Mexico', bounds: [[18, -98], [31, -80]],
    title: 'The Gulf, the Loop Current and the Florida Straits' },
  { label: 'Caribbean', bounds: [[8, -90], [23, -58]],
    title: 'The Caribbean basin and the Antilles' },
  { label: 'Mediterranean', bounds: [[30, -6], [46, 37]],
    title: 'Gibraltar to the Levantine basin' },
  { label: 'South China Sea', bounds: [[0, 105], [25, 122]],
    title: 'The South China Sea and the Luzon Strait' },
  { label: 'Philippines', bounds: [[4, 116], [21, 128]],
    title: 'The archipelago, the Sulu Sea and the Philippine Sea' },
  { label: 'W Antarctic Peninsula', bounds: [[-70, -75], [-60, -55]],
    title: 'Bransfield Strait, the shelf and the Bellingshausen Sea' },
];

/* An interest is a way of dressing the map, not a place to stand. None of
   these moves the view — that is the regions' job, and keeping them apart
   is what lets a reader combine any interest with any region. */
export const INTERESTS: Interest[] = [
  { label: 'Reset', reset: true,
    title: 'Put the basemap, layers, colour scales and view back to defaults' },

  /* **One layer per exclusivity group, and this list got it wrong twice.**
     Concentration and thickness share the ice pane and are exclusive, as
     are the two current depths — so an interest naming both of a pair has
     one of them switched straight off again by the exclusivity handler,
     and which one survives depends on the order they were added in. The
     menu entry then does something subtly different from what it says.
     `test:map` applies every interest and requires each to end up with
     exactly the layers it named. */
  { label: 'Sea ice',
    layers: ['SIC (ESPC)', 'Coastline', 'Lat/lon grid'],
    colours: { sic: 'cmo.ice', sit: 'cmo.ice' },
    title: 'Ice concentration over the coastline' },
  { label: 'Hurricanes',
    layers: ['Hurricanes', 'SST (ESPC)', 'Currents at 0m (ESPC)', 'Isobaths',
             'Lat/lon grid'],
    colours: { sst: 'jet' },
    title: 'Storm tracks over sea-surface temperature and surface flow' },
  { label: 'Circulation',
    layers: ['Currents at 0m (ESPC)', 'Isobaths', 'Coastline'],
    title: 'Surface flow over the seafloor' },
  { label: 'Air & sea',
    layers: ['Wind at 10m (ECMWF)', 'Air temp at 2m (ECMWF)', 'Coastline'],
    title: '10 m wind over 2 m air temperature' },
  { label: 'Water masses',
    layers: ['SST (ESPC)', 'Isobaths', 'Coastline'],
    colours: { sst: 'jet', sss: 'cmo.haline' },
    title: 'Temperature and salinity over the seafloor' },
  { label: 'The fleet',
    layers: ['Hurricanes', 'NOAA USVs', 'Ocean gliders', 'Argo floats',
             'Coastline'],
    title: 'Every reporting platform, over a plain background' },
];
