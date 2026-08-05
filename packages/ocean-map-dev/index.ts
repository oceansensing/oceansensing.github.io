import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
/* The map's own styling travels with it. Every rule keys off the `ocean-map`
   class applied below rather than an id, so a page can carry more than one. */
import './ocean-map.css';
/* The renderer-independent half. Nothing imported here touches Leaflet or the
   DOM, which is deliberate: these are the parts a native port keeps. */
import { coordText, elapsed, hoursAhead, hourStamp, initialBearing,
  minZoomForWidth, spanText, stamp } from './geo';
import { rampStops } from './ramp';
import { createGraticule } from './graticule';
import { createMeasureTool } from './measure';
import { createScalarLayer, FIELDS, type FieldDescriptor, type ScalarLayer }
  from './scalar-layer';
import { VelocityLayer } from './velocity-layer';
import { pickRamp, admissible, clearance, NAMED_TINTS, type RampChoice } from './contrast';
import basemapWater from './data/basemap-ocean.json';
import { tileKeysFor } from './tiles';
import { readKmz, summarise, type KmzDocument, type KmzFeature, type KmzOverlay } from './kmz';
import { matrix3d, type Pixel } from './warp';
import { listOverlays, removeOverlay, saveOverlay } from './store';
import type {
  IsobathFile,
  RegionLink,
  ScalarGrid,
  TileIndexFile,
  VectorGrid,
} from './schema';

/* Everything a second site would have to change, in one place.
   
   This began as a bespoke instrument for one basin and one fleet, with
   eleven hardcoded data paths and an Atlantic bounding box written into the
   body of a 2,600-line script. Reading them off a single object instead is
   the seam that makes the rest of it portable; the values below are still
   exactly what this site wants, so nothing here changes behaviour.
   
   Read off the container's data attributes when they are present, so the
   markup can configure the map without a build step — which is what the
   eventual standalone module needs, and costs nothing meanwhile. */
const readJson = <T,>(raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // a malformed attribute must not take the map down
  }
};

type Bounds = [[number, number], [number, number]];

/* What an embedder can change. Every one of these also has a data-map-*
   attribute on the container, so a page with no build step can set it in
   markup; anything passed here wins over the attribute, and the attribute
   wins over the default. */
export interface OceanMapOptions {
  /** Base URL the generated grids are fetched from. `data-map-data`. */
  dataBase?: string;
  /** Bounds the map opens on and that Reset returns to. `data-map-home`. */
  home?: Bounds;
  /** sessionStorage key for the reader's saved view. `data-map-storage-key`. */
  storageKey?: string;
  /** Which overlays to switch on, by the names the layer switcher shows.
      `data-map-layers`, as a JSON array. Absent means "whatever the map turns
      on by itself", which is what every deployment did before presets existed.

      This is what makes one engine serve several pages: a general-purpose map
      and a hurricane map differ in their preset and their home bounds, not in
      their code. Reset returns to the preset, not to the built-in defaults. */
  layers?: string[];
  /** Layers to fetch and build at startup even though they open switched
      off. `data-map-preload`, as a JSON array.

      A layer costs a fetch and a construction, and until this existed every
      one of them paid that on every page load whether or not the reader
      ever looked at it. The default is now to build a layer the first time
      it is shown, so **the preset decides what gets built** — which is the
      right rule for nearly every page, and needs nothing set here.

      This is the escape hatch for the case that rule gets wrong: a layer a
      page expects readers to reach for immediately, where waiting for the
      fetch after the click is worse than paying for it up front. Naming a
      layer here that is already in `layers` is harmless and redundant. */
  preload?: string[];
  /** A short label drawn over the map's bottom-right corner.
      `data-map-brand`.

      **The host's, never the package's.** This map is built to be embedded
      elsewhere and ported to iOS, so a name baked into the module would put
      one lab's branding on somebody else's map. Absent means no label, which
      is what any other deployment gets until it asks for one.

      It is a mark on the canvas rather than a line of chrome, so a
      screenshot of the map carries it. */
  brand?: string;
}


/* Every colour the map draws in lives in one file, which
   scripts/test-contrast.mjs checks against the sampled water colours of
   both bathymetries. Do not inline a colour here — the gate cannot see it.
   Magenta for gliders rather than teal: teal vanishes into GEBCO's
   blue-green, and magenta stays separable from the orange USVs and the red
   storms under the common forms of colour blindness. */
import { palette } from './palette';
import { stormLines, stormLabel, NO_STORMS } from './storm-status';
const {
  storm: STORM, usv: USV, glider: GLIDER,
  argo: ARGO, argoEdge: ARGO_EDGE, measure: MEASURE,
} = palette.features;

/* One map per container, rather than one map per page.

   This was a singleton: it looked itself up by id, read its status line by
   id, and reached across the whole document for its controls. That is fine
   for the single instance a page renders and impossible for anything else —
   two maps on one page would share an id, and getElementById would hand both
   of them the first one. Everything below is scoped to the container's own
   root instead, so a second instance is just a second element. */
export function mountOceanMaps(scope: ParentNode = document): void {
  for (const host of scope.querySelectorAll<HTMLElement>('[data-ocean-map-canvas]')) {
    createOceanMap(host);
  }
}

/* Build a map inside `host`. Options given here win over the container's
   own data-map-* attributes, which win over the defaults. */
export async function createOceanMap(
  host: HTMLElement,
  options: OceanMapOptions = {}
): Promise<void> {
  /* The figure wrapping this map: its legend, controls and status line all
     live here. Falls back to the container itself so a host that renders
     only the map div still works. */
  /* What the stylesheet keys off. Applied here rather than expected of the
     markup, so a host only has to supply a container. */
  host.classList.add('ocean-map');

  const root: ParentNode =
    host.closest('[data-ocean-map]') ?? host.parentElement ?? host;
  const find = <T extends Element>(selector: string): T | null =>
    root.querySelector<T>(selector);

  /* **Every piece of chrome that follows the layers registers here**, so it
     can be re-run when the layers move without going through the control.

     `overlayadd`/`overlayremove` fire only from the layers control — a
     *checkbox*. `map.addLayer` and `map.removeLayer` do not fire them, and
     `restoreView` uses exactly those to put a saved view back. So on a
     reload the chrome was synced once during setup, `restoreView` then
     switched layers on and off underneath it, and nothing told it: the
     platform keys sat there naming layers that were off until the reader
     touched any checkbox, which fired the event and corrected everything at
     once. That is precisely the shape it looked like — right after a toggle,
     wrong on arrival.

     Binding to `layeradd`/`layerremove` instead would catch the programmatic
     case, and is the wrong fix: a LayerGroup already on the map forwards
     every child add to the map, so the four thousand Argo markers would
     each fire it. */
  const chromeSyncs: (() => void)[] = [];
  const syncChrome = () => {
    for (const sync of chromeSyncs) sync();
  };


  const CONFIG = {
    /* Where the generated grids live. Every fetch below is relative to
       this, so another site points it at a URL and is done — the files are
       far too large to ship with a package. */
    dataBase: options.dataBase ?? host.dataset.mapData ?? '/map/',
    /* The view the map opens on, and what Reset returns to. */
    home:
      options.home ??
      readJson<Bounds>(host.dataset.mapHome, [
        [7, -100],
        [45, -20],
      ]),
    /* Keyed per container, so two maps on one page cannot overwrite each
       other's saved view. AssetMap.astro pins its own key in markup,
       because that key predates the option and readers hold saved views
       under it; deriving one here would have quietly invalidated every one
       of them. */
    storageKey:
      options.storageKey ??
      host.dataset.mapStorageKey ??
      `ocean-map:${host.id || 'default'}`,
    /* Which overlays this page opens with. Absent means the map's own
       opening state, which is what every deployment had before presets. */
    layers:
      options.layers ?? readJson<string[] | undefined>(host.dataset.mapLayers, undefined),
    /* Built at startup despite opening off — see `preload` in the options. */
    preload:
      options.preload ?? readJson<string[] | undefined>(host.dataset.mapPreload, undefined),
    brand: options.brand ?? host.dataset.mapBrand ?? '',
  };

  const BASIN = CONFIG.home;
  const DATA = CONFIG.dataBase.endsWith('/') ? CONFIG.dataBase : `${CONFIG.dataBase}/`;

  /* Grid headers carry absolute links — `/map/tiles/index.json`, and a `url`
     per regional grid — baked in by the Python writers, and the map used to
     fetch them exactly as given. On this site that is right by coincidence;
     anywhere else it reaches back into the host's own origin for the tile
     index and every detail grid, and the layer silently stays coarse. Found
     by writing the contract down: schema.ts had to say what those strings
     were relative to, and there was no answer. */
  const fromData = (url: string) => url.replace(/^\/map\//, DATA);
  const status = find<HTMLElement>('[data-map-status]');

  /* The map's current view as a plain box, for the renderer-independent
     helpers in tiles.ts — they take numbers so a native port can share them.
     Unwrapped longitudes are fine and deliberate: tileKeysFor folds them
     itself, and the centre legitimately wanders past ±180. */
  const viewBox = () => {
    const b = map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  };

  /* The storm status line comes from a sibling component, so it may sit
     inside this map's figure or outside it — this site renders it just
     above. Prefer one inside the figure, since that is the arrangement a
     second instance on the same page would need to disambiguate. */
  let claimedBoxes: HTMLElement[] | null = null;
  const stormStatusBoxes = (): HTMLElement[] => {
    const inside = root.querySelectorAll<HTMLElement>('[data-storm-status]');
    if (inside.length) return [...inside];
    /* A status line outside the figure — which is this site's arrangement,
       the line being a sibling rendered just above it — is adopted by the
       first map to ask for it, and then marked so no other map takes it too.

       Refusing to adopt whenever a page has several maps was the first
       attempt and went too far: with two maps *nobody* claimed the line and
       it stopped rebuilding altogether. Claiming is what is wanted, not
       abstaining. Found by putting a second map in the harness, which had the
       two of them wiring the same zoom buttons and fighting over where a
       click sent the view. */
    if (claimedBoxes) return claimedBoxes;
    const free = [...document.querySelectorAll<HTMLElement>('[data-storm-status]')].filter(
      (b) => b.dataset.oceanMapClaimed === undefined
    );
    for (const b of free) b.dataset.oceanMapClaimed = host.id || '';
    claimedBoxes = free;
    return claimedBoxes;
  };

  /* **The world is never allowed to be narrower than the viewport.**

     Vector markers live in exactly one copy of the world — that is what
     `rehome` below is for, and it rests on an assumption this map used to
     satisfy by accident: that no zoom on offer shows a view wider than one
     copy. Uncapping the map's width broke it. Measured on an 1858 px
     container at zoom 2, where the world is 1024 px: **1.81 copies on
     screen, a 653° view, and 4,017 floats spanning 360° of it** — so about
     45% of the width was ocean that could never hold a platform, however
     many were reporting. Reported from a wide window, and visible as a
     fleet that stops dead at both edges.

     The fix is a **fractional** minimum zoom: exactly the zoom at which one
     world fills the container. Rounding up to a whole level was the first
     idea and is worse — between 1025 and 2047 px it would jump to a zoom
     showing half the world, so the reader loses the global view to fix an
     edge artefact. Leaflet snaps a requested zoom before clamping it to
     `minZoom`, so a fractional floor survives the +/- buttons and the
     wheel without `zoomSnap` having to change.

     Duplicating the markers into the neighbouring copies is the other way,
     and it is the one this package already rejected: 4,000 floats become
     8,000 or 12,000 layers, and the whole point of `rehome` was not paying
     that. */
  const FLOOR_ZOOM = 2;

  const map = L.map(host, {
    /* worldCopyJump is deliberately off. It existed to drag the *view*
       back to the copy of the world the markers live in — but it does that
       by snapping the map pane a whole world sideways mid-drag, measured
       at 2,028 px in a single step, and every overlay pane teleports and
       repaints with it. That is the flash you get panning across the date
       line.

       Now that markers are re-homed to the reader's copy instead (see
       rehome below), the view no longer needs dragging anywhere: the fleet
       comes to it. The centre may then wander past ±180, which nothing
       here minds — positions are folded before they are shown, and the
       saved view wraps on the way out. */
    worldCopyJump: false,
    minZoom: FLOOR_ZOOM,
    /* **Fractional zoom has to be declared, not just used.** `minZoom` below
       is the zoom at which one world exactly fills the container, which is
       almost never a whole number — and Leaflet only supports a fractional
       zoom when `zoomSnap` is 0. Left at its default of 1 it rounds every
       requested zoom to an integer while the map actually sits at 2.41, so
       its tile-range arithmetic and its transform disagree and the basemap
       comes up partly tiled: reported as a cross of tiles over empty space.
       `zoomDelta` keeps the +/- buttons stepping by a whole level. */
    zoomSnap: 0,
    zoomDelta: 1,
    /* **Continuous zoom needs its own sensitivity.** With `zoomSnap: 1`
       Leaflet's wheel handler rounds a gesture *up* to a whole level, so any
       tick moved a full zoom however small it was. Declaring the zoom
       fractional removes that ceiling and leaves the raw amount, which
       measured **0.197 levels for a 100 px tick** — about a fifth of what
       the same gesture used to do, and reported as zooming too slowly.

       `wheelPxPerZoomLevel` is how many scroll pixels make one level, so
       lowering it is the direct knob. 20 rather than the default 60 puts a
       100 px tick back near two thirds of a level: responsive enough to
       cross a few levels in one gesture, while keeping the smoothness that
       is the whole point of not snapping. */
    wheelPxPerZoomLevel: 20,
    attributionControl: true,
  });

  /* **The reader gets a view before anything is built**, and this is the
     single change that decides how quickly a map appears.

     Leaflet requests no tiles until the map has a centre and a zoom, and
     everything below this line runs synchronously — measured at 1.7 s on a
     fully cached load. So the first basemap tile was not even *asked for*
     until the last layer had been constructed, and the reader watched an
     empty box for the whole of it. Setting the view here costs nothing and
     lets the tiles travel while the rest is still being built.

     Read straight out of storage rather than through `restoreView`, which
     cannot run yet: it restores which overlays are on, and they do not
     exist at this point. This is only the where-am-I-looking half. */
  const openingView = (() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CONFIG.storageKey) ?? 'null');
      if (saved && typeof saved.zoom === 'number'
          && typeof saved.lat === 'number' && typeof saved.lng === 'number') {
        return { centre: [saved.lat, saved.lng] as [number, number], zoom: saved.zoom,
                 base: typeof saved.base === 'string' ? saved.base : null };
      }
    } catch {
      // Unreadable storage is not a reason to open on nothing.
    }
    return null;
  })();
  if (openingView) map.setView(openingView.centre, openingView.zoom);
  else map.fitBounds(BASIN);

  const holdOneWorld = () => {
    const wanted = minZoomForWidth(map.getSize().x, FLOOR_ZOOM);
    if (Math.abs(wanted - map.getMinZoom()) > 0.01) map.setMinZoom(wanted);
  };
  holdOneWorld();

  map.attributionControl.setPrefix('');

  /* **The credit is moved out of the map, into the caption below it.**

     Leaflet renders attribution as a control, so it floats over the bottom
     edge of the map — directly on top of the graticule's longitude labels,
     which are pinned to that same edge. Two things fighting for one strip,
     and the credit is the one that does not have to be there: nothing about
     it is spatial.

     The control is reparented, not reimplemented. It goes on owning and
     rewriting its own container — including the semicolon override below —
     so nothing here has to know how a credit is assembled. Leaflet's own
     positioning classes come off, since outside the map they would place it
     against a corner that no longer exists.

     A host with no `[data-map-credit]` keeps the floating control, which is
     what a second site embedding this gets until it adds the element. */
  {
    const slot = find<HTMLElement>('[data-map-credit]');
    const box = map.attributionControl.getContainer();
    if (slot && box) {
      box.classList.remove('leaflet-control');
      slot.append(box);
    }
  }

  /* **Credits are separated by semicolons, not commas.**

     Leaflet joins them with ", " and offers no option for it. With one
     product on the map that reads fine; with several overlaid it does not,
     because the credits contain commas of their own — "US Navy ESPC-D-V02 —
     valid 2026-08-05 00Z (+9 h), 2026-08-03 12Z run" is a single product, and
     set beside another credit with the same separator there is nothing to
     say where one ends and the next begins. A reader counting sources gets
     the wrong number.

     `_update` is private, so the override is guarded: if the internals it
     reads are not there — a Leaflet upgrade that renames them — Leaflet's own
     version runs and the line degrades to commas rather than vanishing.
     `test:map` asserts the semicolons survive, so that upgrade shows up as a
     failed check rather than as a quietly ambiguous credit line. */
  {
    const control = map.attributionControl as unknown as {
      _attributions?: Record<string, number>;
      _container?: HTMLElement;
      options: { prefix?: string | false };
      _update: () => void;
    };
    const leafletUpdate = control._update.bind(control);
    control._update = () => {
      const credits = control._attributions;
      const container = control._container;
      if (!credits || !container) return leafletUpdate();
      const shown = Object.keys(credits).filter((text) => credits[text]);
      const parts: string[] = [];
      if (control.options.prefix) parts.push(String(control.options.prefix));
      if (shown.length) parts.push(shown.join('; '));
      container.innerHTML = parts.join(' <span aria-hidden="true">|</span> ');
    };
    control._update();
  }

  /* One credit per source and run, however many layers draw from it.
     Currents and the Navy scalar fields come from the same model at the
     same hour, so with the quantity written into each string the control
     said "US Navy ESPC-D-V02" twice on a line already long enough to wrap.

     Leaflet counts attributions by their exact text and shows each once, so
     the fix is to make the shared credit *be* shared rather than to merge
     two strings afterwards: what a layer contributes is who published the
     data and when, and nothing about the layer. Which quantity, and at what
     depth, is what the switcher names it — the attribution's job is the
     credit and the date.

     It stays two lines when the runs genuinely differ, which is right: the
     fields and the currents are fetched by separate pipelines and can land
     on different runs, and that is exactly the thing the run stamp exists
     to show. */
  /* The valid time leads, because it is the one thing a reader needs and the
     one thing that was missing. The map publishes a single forecast frame,
     so there is no lead control on screen to say the water is ahead of the
     clock — and a field labelled only with its run reads as the present.
     The run stays, after it, because a step valid an hour from now is
     worthless if it came from a run three days old. An analysis has neither
     and shows its own date. */
  const credit = (source: string, run?: string, at?: string, valid?: string) => {
    if (run) {
      const when = valid ? `valid ${hourStamp(valid)} (${hoursAhead(valid)}), ` : '';
      return `${source} — ${when}${hourStamp(run)} run`;
    }
    return source + (at ? ` — ${at}` : '');
  };

  /* Refit whenever the **container** changes size, not just the window.

     Leaflet's own `trackResize` listens on `window.resize`, which covers the
     common case and misses every other one: the map's height is a viewport
     unit but its width comes from whatever the host lays out around it, so a
     sidebar opening, a font finishing loading, or the page's own breakpoint
     switching all resize the map without the window moving at all. The
     symptom is silent and specific — Leaflet keeps drawing at its old size,
     so tiles stop short of the container's edge and the particle canvas
     keeps its old dimensions while the box around it has grown.

     A ResizeObserver is the direct statement of the thing we actually care
     about. It also fires once on observe, which harmlessly re-fits the map
     after first layout — the moment the old code was most likely to have
     measured a container that had not settled.

     Guarded because jsdom has no ResizeObserver; the harness exercises the
     invalidate path by calling it directly instead. */
  if (typeof ResizeObserver === 'function') {
    let last = { w: 0, h: 0 };
    const refit = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      // Whole pixels: a fractional change is sub-pixel layout noise, and
      // invalidateSize fires a moveend that would restart the particle
      // animation on every one of them.
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      if (w === last.w && h === last.h) return;
      last = { w, h };
      map.invalidateSize({ debounceMoveend: true });
      // The container's width decides how far out the map may zoom.
      holdOneWorld();
    });
    refit.observe(host as HTMLElement);
  }

  /* Leaflet keeps no route from the element back to the map, so hang it
     here: the headless harness in scripts/test-map.mjs reads it, and it
     makes the map pokeable from the console. Nothing on the page uses it. */
  (host as HTMLElement & { _map?: L.Map })._map = map;

  /* Bathymetry is the default, since the point of the map is where the
     platforms sit relative to the ocean floor. GEBCO leads; Esri's ocean
     basemap is the lighter alternative.

     "Coastline only (no tracking)" is the fourth, drawn from
     `coastline.json` shipped with the site, and the only basemap that makes
     no third-party request at all. It was briefly removed for being blocky
     — the file was built once by hand with no generator, at a median
     segment of 33.7 screen pixels at zoom 7 — and is back because
     `scripts/fetch-coastline.py` now builds it properly, at 4.6 px.

     **It is fetched only when a reader picks it**, which is what makes 4.2
     MB affordable: it is eleven times the file it replaces, and loading
     that with the page for a basemap almost nobody selects would be a poor
     trade for everybody else. `whenChosen` below is that latch. */
  const bathymetry = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri — GEBCO, NOAA, National Geographic', maxZoom: 13 }
  );
  /* Surface currents from Mercator Ocean's global 1/12° analysis-forecast
     (Copernicus Marine GLOBAL_ANALYSISFORECAST_PHY_001_024), served as
     WMTS in EPSG:3857 — which is Leaflet's own projection, so the tiles
     are ordinary XYZ. Leaving the TIME dimension off makes the server
     fall back to its default, and that default is the current hour, so
     the field stays live with no date handling here.

     It gets its own pane between the basemap and the vectors: whichever
     basemap the reader picks, the currents sit above it and below every
     track and marker, so the platforms are never obscured. */
  /* Switched off. The scaffolding stays — the pane, the tile definition,
     the CSS that blends it — so turning it back on is one flag, but with
     this false nothing is requested from Copernicus and the layer is not
     offered in the switcher. */
  const MERCATOR_RASTER = false;

  const CMEMS = 'https://wmts.marine.copernicus.eu/teroWmts';
  const CURRENTS =
    'GLOBAL_ANALYSISFORECAST_PHY_001_024/' +
    'cmems_mod_glo_phy_anfc_0.083deg_PT1H-m_202406/sea_water_velocity';

  /* Two panes, not one. The Mercator raster is multiplied over the
     basemap (see the CSS), and for a while the particle canvas shared that
     pane and was multiplied too — which all but erased it, because the
     particles are near-white and multiplying by near-white barely changes
     anything. They were drawing the whole time and the blend was undoing
     them. Keep them apart: the raster blends, the particles composite
     normally, which is also what the contrast gate assumes. */
  /* Temperature sits under the currents, which sit under every track and
     marker. It replaces the water rather than tinting it, so it goes
     lowest of the three overlays — a reader with SST and currents both on
     should see flow drawn over temperature, not the other way round. */
  const sstPane = map.createPane('sst');
  sstPane.style.zIndex = '240';
  sstPane.style.pointerEvents = 'none';

  /* **Ice gets its own pane so it can be read over temperature.**

     Every scalar used to share one pane, which forced them all into a single
     exclusivity group: the upper raster simply hid the lower, so the map
     would have named two fields while showing one. That is right for
     temperature against salinity, which cover the whole ocean and would
     completely occlude each other — and wrong for ice, which covers about a
     tenth of it.

     What makes the pair legible is the draw floor. Ice paints nothing below
     15% concentration or 0.1 m, so everywhere there is no ice the pane is
     transparent and the field underneath shows through untouched. Ice over
     SST is then one picture: the pack, and the water at its edge. */
  const icePane = map.createPane('ice');
  icePane.style.zIndex = '242';
  icePane.style.pointerEvents = 'none';

  /* Isobaths sit directly on top of the scalar fields, which is the whole
     point of them: a temperature field with no seafloor under it says
     nothing about why the water is that temperature. Below the currents,
     because the particles are the thing in motion and a static line grid
     over them reads as interference. Its own pane so one opacity applies
     to every contour at once, and so the reader can set it. */
  const bathyPane = map.createPane('bathy');
  bathyPane.style.zIndex = '245';
  bathyPane.style.pointerEvents = 'none';

  /* The shoreline goes just above the isobaths — same job, same reason to
     sit over a scalar field — and in its own pane so the isobath opacity
     slider does not drag it along with the contours. */
  const coastPane = map.createPane('coast');
  coastPane.style.zIndex = '246';
  coastPane.style.pointerEvents = 'none';

  /* Maritime boundaries go above the fields but below every platform: they
     are context for where a glider is working, not something to hide it. */
  /* A reader's own overlays sit above every reference layer — they are the
     thing they came to look at — but still below the platforms, because the
     rule that nothing hides a glider applies to a reader's file as much as to
     a boundary. */
  const userPane = map.createPane('user');
  userPane.style.zIndex = '280';

  const eezPane = map.createPane('eez');
  eezPane.style.zIndex = '270';
  eezPane.style.pointerEvents = 'none';

  const rasterPane = map.createPane('currents-raster');
  rasterPane.style.zIndex = '250';
  rasterPane.style.pointerEvents = 'none';

  const pane = map.createPane('currents');
  pane.style.zIndex = '260';
  pane.style.pointerEvents = 'none';

  const currents = L.tileLayer(
    `${CMEMS}?service=WMTS&request=GetTile&version=1.0.0` +
      `&layer=${encodeURIComponent(CURRENTS)}` +
      `&style=${encodeURIComponent('cmap:speed,vectorStyle:solid')}` +
      '&tilematrixset=EPSG:3857&TileMatrix={z}&TileRow={y}&TileCol={x}&format=image/png',
    {
      pane: 'currents-raster',
      className: 'map-currents',
      /* The speed colourmap paints slow water pale cream, which as a
         straight overlay lays a white film over the whole ocean and
         washes the bathymetry out. Multiplying instead drops that pale
         end away to nothing and keeps only the fast water, so the Gulf
         Stream and the eddy field read as darker streaks over a basemap
         that still looks like itself. Blend mode is set in CSS so each
         theme can pick its own. */
      opacity: 0.55,
      maxNativeZoom: 10,
      attribution: 'Currents: Copernicus Marine — Mercator Ocean',
    }
  );

  /* The animated field. Particles are drawn from a u/v grid rather than
     rendered server-side, so this is the one current layer that can move.
     It comes from the US Navy's global ESPC-D forecast rather than
     Mercator: Copernicus publishes numeric u/v only behind credentials,
     while the Navy model is open at the same 1/12 degree resolution. Both
     layers name their model in the switcher so the difference is visible.

     Cool, desaturated particles: the assets are magenta and orange, and
     the flow has to stay behind them. Same pane as the raster, so it sits
     above the basemap and below every track and marker. */
  /* One group per depth. Two particle fields drawn at once would be
     unreadable — two sets of drifting lines over the same water, with no
     way to tell which is which — so the switcher below keeps them
     mutually exclusive. */
  const flow = L.layerGroup();
  const flowDeep = L.layerGroup();
  /* Wind is a third animated field but is **not** exclusive with the
     currents, because wind over water and the current under it are a pair
     worth reading together — a storm's forcing beside what the ocean is
     doing about it.

     That only works because the two are told apart by colour: wind takes its
     own gated ramp, far enough from the currents' amber that a glance
     separates them (see the palette). The two current *depths* stay
     exclusive with each other, since 0 m and 60 m are the same quantity and
     no colour would say which is which. */
  const wind = L.layerGroup();

  /* One group per temperature field, and the same rule as the two animated
     current fields: only one at a time. Two rasters cannot be stacked —
     the upper one simply hides the lower — so offering both at once would
     show one field while naming two. */
  const sstOisst = L.layerGroup();
  const sstNavy = L.layerGroup();
  const sssNavy = L.layerGroup();
  const iceOisst = L.layerGroup();
  const iceNavy = L.layerGroup();
  const iceThickness = L.layerGroup();
  const ssts: { group: L.LayerGroup; layer: ScalarLayer }[] = [];
  /* Both animated fields, so the point readout can sample whichever one
     the reader has on rather than a fixed depth. */
  const flows: { group: L.LayerGroup; layer: L.Layer | null; kind: FlowKind }[] = [];

  /* ---- particle colours, resolved against what is behind them ----------

     See `contrast.ts` for why these are chosen here rather than offline. The
     short form: a particle owes the background more than anything else on
     the map does, and the background is 27 different things depending on
     which basemap and which colour scale the reader has up. One fixed pair
     had to clear all 27 at once and cleared some of them by ΔE 3.

     Every answer is still held to the palette's `bars`, and
     `scripts/test-contrast.mjs` proves that offline over all 27 — the search
     is deterministic and the backgrounds are all known, so nothing about
     moving the decision to runtime makes it unprovable. */
  let activeBasemap = 'Bathymetry (GEBCO)';

  /** The reader's request per field, as an exemplar hex from `NAMED_TINTS`,
      or null for automatic. */
  const particleTint: Record<'current' | 'wind', string | null> = { current: null, wind: null };

  /** How fast the reader wants each field drawn, as a multiple of its own
      calibrated drift. 1 is the map's own answer.

      **A multiplier, never a replacement.** `DRIFT` cancels the measured
      26.7x between wind and water and `WIND_BOOST` is a stated legibility
      factor over that parity — both are measurements the gates hold, and a
      slider that overwrote them would make those gates check a number
      nothing draws. This scales what they produce and leaves them alone.

      It changes only the *rate*, never the direction or the relative speeds
      within a field, and the point readout still reports m/s straight from
      the grid — so nothing on screen claims a speed the data does not
      support. That is the same argument WIND_BOOST already rests on. */
  const particleSpeed: Record<'current' | 'wind', number> = { current: 1, wind: 1 };
  const speedSliders: Partial<Record<'current' | 'wind', HTMLInputElement>> = {};
  /* Each slider's own redraw, kept so a restore or a Reset can move the
     thumb *and* the number beside it. Dispatching a synthetic event was
     the first attempt and is a no-op — nothing listens for one. */
  const speedShow: Partial<Record<'current' | 'wind', () => void>> = {};
  /* Assigned when the control is built; a host with no slider still needs
     this to exist, because restoreView and Reset both call it. */
  let applyParticleSpeed = () => {};

  /* The colour swatches and the speed slider for a field are only meaningful
     while that field is drawn — the same argument as the platform keys, and
     stronger here: these are *controls*, so one for a layer that is off does
     not merely mislead, it does nothing when used. Registered as the
     controls are built and toggled from the layer events. */
  const flowControls: { field: 'current' | 'wind'; el: HTMLElement }[] = [];
  const showFlowControls = () => {
    for (const { field, el } of flowControls) {
      el.hidden = !flows.some(
        (f) => (f.kind.reads === 'from' ? 'wind' : 'current') === field && map.hasLayer(f.group)
      );
    }
  };

  /** Put the sliders where the numbers are — after a restore or a reset,
      which change the value without touching the input. */
  const syncSpeedSliders = () => {
    for (const field of ['current', 'wind'] as const) {
      const slider = speedSliders[field];
      if (!slider) continue;
      slider.value = String(Math.log2(particleSpeed[field]));
      speedShow[field]?.();
    }
  };
  const particleChoice: Partial<Record<'current' | 'wind', RampChoice>> = {};

  /** What the particles are actually drawn over.

      A scalar field is painted opaque, so when one is on the background is
      **its colour scale**, not the basemap — the water is not visible at
      all. That is what makes this tractable: the answer depends on one ramp
      of ten stops rather than on every basemap and every colormap at once.
      With no field on it is the sampled water of the active basemap, the
      same tones the offline gate has always used. */
  const backgroundColours = (): string[] => {
    const shown = ssts.find((f) => map.hasLayer(f.group));
    if (shown) {
      const stops = (palette.colormaps ?? {})[choiceFor(shown.layer?.options?.field).map];
      if (stops?.length) return stops;
    }
    const water = (basemapWater as { basemaps: Record<string, { ocean: { colour: string }[] }> })
      .basemaps[activeBasemap]?.ocean;
    return water ? water.map((o) => o.colour) : [];
  };

  const MARKER_COLOURS = Object.values(palette.features);

  /* Assigned once the flows exist; called from the basemap, layer and
     colour-scale handlers, which are all built later. */
  let resolveParticleColours = () => {};
  /* The picker re-reads which names are available whenever the background
     moves under it. Set when that control is built; a no-op if the host
     page has no picker in its markup. */
  let refreshTintOptions = () => {};

  /* ---- the forecast hour ------------------------------------------------

     Each ESPC run carries eight days and the map used to show one hour of
     it. Five frames are published — now and +12/24/36/48 — and every layer
     off that model steps together: currents at +24h under temperature for
     now would be two oceans on one map, the same trap the mutually
     exclusive fields exist to avoid.

     **The frame shown by default is the one whose valid time is nearest the
     reader's clock, not lead 0.** Those are the same thing on a healthy day
     and diverge on exactly the bad one this feature was asked for: when a
     run lands 40 hours late, lead 0 is a field for 40 hours ago while +48h
     is valid about now. Picking by absolute time means a late run degrades
     into a forecast that is still about the present, rather than into a
     confidently-labelled past. */
  type Frame = { lead: number; valid: string; url: string };
  const forecast: {
    frames: Frame[];
    lead: number | null;
    /* Keyed by **lead**, never by a frame object. Every ESPC product
       publishes its own frames at the same leads, so a shared frame would
       be one product's URL handed to all of them — which is exactly what
       the first version did: one click and all four layers fetched the
       surface current grid, so the 60 m field would have drawn surface
       water and the temperature layer would have been handed a vector
       file. Each layer resolves the lead against its own list. */
    swap: ((lead: number) => void)[];
    render: (() => void)[];
    /** The run these frames came from, for the labels — see `draw()`. */
    run: string | null;
  } = { frames: [], lead: null, swap: [], render: [], run: null };

  /** Whichever published frame is closest to now, by absolute valid time. */
  const nearestFrame = (frames: Frame[]) => {
    const now = Date.now();
    return frames.reduce((best, f) =>
      Math.abs(Date.parse(f.valid) - now) < Math.abs(Date.parse(best.valid) - now) ? f : best
    );
  };

  /* A layer announces the frames it publishes and how to step to one. The
     first layer to report wins: every ESPC product is built from the same
     aggregation at the same hours, so they agree, and a layer switched on
     later adopts the hour already showing rather than resetting it. */
  const offerFrames = (
    frames: Frame[] | undefined,
    load: (frame: Frame) => void,
    run?: string
  ) => {
    if (!frames?.length) return;
    if (!forecast.frames.length) {
      forecast.frames = frames;
      forecast.run = run ?? null;
      forecast.lead = nearestFrame(frames).lead;
      forecast.render.forEach((r) => r());
    }
    const swap = (lead: number) => {
      const own = frames.find((f) => f.lead === lead);
      // A product that does not publish this lead keeps the hour it has
      // rather than guessing at a neighbour, and the control says which
      // hour is showing, so the mismatch is visible rather than silent.
      if (own) load(own);
    };
    forecast.swap.push(swap);
    /* A layer switched on after the reader has stepped forward has to catch
       up, or it would quietly draw a different hour from everything else on
       the map. Its own file is the lead-0 one it has just loaded, so this
       only fires when the showing lead is something else. */
    if (forecast.lead !== null && forecast.lead !== frames[0].lead) swap(forecast.lead);
  };

  const showLead = (lead: number) => {
    if (!forecast.frames.some((f) => f.lead === lead) || forecast.lead === lead) return;
    forecast.lead = lead;
    forecast.swap.forEach((s) => s(lead));
    forecast.render.forEach((r) => r());
    saveView();
  };

  /* Pixels a 1 m/s flow should carry a particle each frame — **per field,
     because the two quantities are not the same size**. Measured on the
     published grids: the median surface current is 0.22 m/s and the median
     10 m wind is 5.97, so wind runs **26.7x** faster. One constant for both
     would put one of them off screen and the other under a pixel.

     Divided by that ratio, the wind drifts at the same apparent rate as the
     currents do — which is the point. These are alternative depictions of
     the same map, so switching between them should change the field on
     screen and not the speed it appears to move at. */
  /* Wind is drawn **25% faster than speed parity**, deliberately. Parity
     makes the two fields drift at the same apparent rate, which is right for
     comparing them; but the air is a smoother, larger-scale field than the
     ocean, so its structure is circulation rather than eddies, and reading a
     circulation means following a streak far enough to see it turn. A little
     more speed does that. It is a legibility choice, not a measurement,
     which is why it is a named factor over the measured ratio rather than a
     new number that quietly disagrees with it.

     Twice parity, arrived at in three steps of looking at the map rather
     than in one — 1.25, then 1.5625, then here. At this point it is worth
     saying plainly what the number means: the wind is drawn at double the
     speed the measurement would give it, so the field is a depiction of
     circulation rather than a scale model of it. The direction is exact and
     the relative speeds within the field are exact; only the overall rate is
     the reader's, and it is chosen for legibility. */
  const WIND_BOOST = 2;
  const DRIFT = { current: 3.0, wind: 0.11 * WIND_BOOST };

  /* How long a particle lives before it is reborn somewhere random. The
     plugin counts this in frames, which hides what it means, so it is
     written as seconds here and converted below.

     It is what keeps the field evenly covered. Particles are seeded at
     random, but they advect into the fast cores and stay there, so the
     longer they live the more the picture drifts from a fine even texture
     towards a few long bright ropes with bare water between them —
     visible within a minute of opening the page. Respawning more often
     keeps reseeding the slow water.

     Trail length is lifetime x speed, so an over-long life and a runaway
     velocity look identical on screen. Measure the speed first: it is
     currently p90 1.0-1.7 px/frame across zooms 2 to 8, which is right,
     so this is the knob that was actually wrong. */
  /* Per field, because the two fields have different structure to show.

     Four seconds suits the ocean: currents are eddy-scale, so a longer life
     lets particles pile into the fast cores and the picture decays from an
     even texture into a few bright ropes. Six suits the air, which has less
     small-scale structure — a longer streak is what makes a circulation
     legible as a circulation rather than as scattered specks, and there are
     no tight cores for it to collapse into. It also thins the picture without
     touching the count: a particle that lives longer is respawned less often,
     so fewer are being seeded into slow air at any moment. */
  const PARTICLE_SECONDS = { current: 4, wind: 8 };
  const FRAME_RATE = 18;

  /* The field draws `area x particleMultiplier` particles, so with the
     map's size no longer capped the particle count was no longer capped
     either. Measured against the 1152x800 the old CSS maximum allowed: a
     1440p window is 3.5x the area and a 4K one **6.4x**, which is ~52,000
     particles redrawn at 18 fps. The cap had been holding that down by
     accident, and removing it without this would have traded a small map for
     a slow one.

     So the count is held flat above a threshold and the density tapers
     instead. 16,000 is a little over what a 1800x1000 map draws at full
     density, so every ordinary window keeps exactly what it has today and
     only genuinely large screens give up density — which is the right way
     round, since a bigger map has more particles on it at any density.

     Measured against the **viewport**, deliberately, while the field is
     simulated over a box 30% larger on every side (see VIEW_MARGIN). So this
     ceiling counts what a reader can see: on screen it is still 16,000, and
     the margin's particles are extra work rather than a thinning of the same
     ones. Total is 2.56x this, and the advection measures 1.29 ms per step
     at 16,000 — so even at the ceiling on a 4K screen it is a few percent of
     an 18 fps frame. */
  const MAX_PARTICLES = 16000;
  const FULL_DENSITY = 1 / 112;

  const densityForView = () => {
    const size = map.getSize();
    const area = Math.max(size.x * size.y, 1);
    return Math.min(FULL_DENSITY, MAX_PARTICLES / area);
  };

  /* Everything below is per depth: fetch that depth's global grid, build
     its particle layer, then keep swapping in the finest grid covering the
     view. Both depths run this same code. Each global file names its own
     regions and tiles, so the chain of links cannot cross between depths
     and leave 60 m particles drifting over a surface grid. */
  /* What separates one animated field from another. Everything else in
     `buildFlow` is tier plumbing and is genuinely shared — the wind reuses
     the region containment, the frame stepping and the scale measurement
     unchanged, because none of that is about what the vectors mean. */
  type FlowKind = {
    source: string;      // who published it; the credit is theirs, not the layer's
    drift: number;       // see DRIFT — wind and current are 27x apart
    seconds: number;     // how long a particle lives; see PARTICLE_SECONDS
    maxVelocity: number; // the top of the colour ramp, in m/s
    colours: string[];
    /* What the legend calls it. Shorter than the switcher's name, which has
       to carry the product too: "Wind at 10 m" against "Wind at 10m
       (ECMWF)". */
    label: string;
    /* Which convention the readout reports this field in, and it is not a
       detail: **a current is named for where it goes, a wind for where it
       comes from.** A southwesterly blows towards the northeast. Reporting
       wind the ocean way would be exactly 180 degrees wrong and entirely
       plausible on screen, which is the worst kind of error this map can
       make. */
    reads: 'toward' | 'from';
  };

  /* ---- building a layer only once somebody looks at it ----------------

     Every data layer used to fetch its grid and construct itself at startup:
     three velocity fields and six scalar fields, whether or not the page's
     preset showed any of them. On `/visualization/` that is four layers on
     screen and fourteen built for nobody.

     A layer registers its loader here instead, and it runs the first time
     the layer is actually shown. So **the preset decides what gets built**,
     with no list to keep in step — a page that opens on SST pays for SST,
     and a page that does not, does not.

     `group.once('add')` rather than the map's `overlayadd`, and that is the
     load-bearing detail. `overlayadd` is a *checkbox* event: it fires only
     from the layers control, so a layer switched on by the preset or by a
     restored view would never have loaded, and the reader would get an
     empty layer that filled in only if they toggled it off and on again.
     A layer's own `add` fires however it was added.

     The entry in `flows`/`ssts` is still registered eagerly, because the
     point readout and the exclusivity groups index by group and both
     already ask `map.hasLayer` before reading anything. Only the fetch and
     the construction wait. */
  const pendingLoads = new Map<L.Layer, () => void>();

  /** `fetch`, held until the layer is first shown.

      Shaped as a fetch on purpose: every tier chain below is a long promise
      chain, and swapping one call for another leaves all of them untouched.
      Restructuring them into deferred bodies was the alternative and is a
      far larger edit for the same behaviour. */
  const fetchWhenShown = (group: L.LayerGroup, url: string): Promise<Response> =>
    new Promise<Response>((resolve) => {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        pendingLoads.delete(group);
        resolve(fetch(url));
      };
      pendingLoads.set(group, go);
      if (map.hasLayer(group)) go();
      else group.once('add', go);
    });

  const buildFlow = (url: string, group: L.LayerGroup, kind: FlowKind) => {
    const entry: { group: L.LayerGroup; layer: L.Layer | null; kind: FlowKind } =
      { group, layer: null, kind };
    flows.push(entry);
    fetchWhenShown(group, url).then((r) => r.json())
    .then((loadedCoarse) => {
      // Reassignable: stepping to another forecast hour swaps the whole
      // chain — this grid, its regions and its tiles — for that hour's.
      let coarse = loadedCoarse;
      /* Name the run in the attribution: ESPC publishes once a day at 12Z,
         so this is how a reader can tell how fresh the field actually is.

         Source and run, and deliberately nothing else — see `credit()`.
         The depth this layer draws is in its own name in the switcher, and
         repeating it here is what made the control say ESPC twice. */
      const run = coarse?.[0]?.header?.modelRun;
      const flowReady = new VelocityLayer({
        data: coarse,
        attribution: credit(kind.source, run, undefined,
                            coarse?.[0]?.header?.refTime),
        paneName: 'currents',
        /* Pixels per (m/s) per frame, straight through — no velocity scale,
           no viewport area, no Jacobian. See the note at the top of
           `particles.ts`: Mercator is conformal, so the direction needs no
           correction and the magnitude is ours to pick. This is the same
           number the old code arrived at, having multiplied by two factors
           and then divided both back out. */
        /* Scaled by the reader's slider **at construction**, not only when
           the slider moves. A restored view is applied before the flow
           layers exist — they are built after their grid arrives — so
           applying the speed only from `restoreView` left the control
           reading 0.25x while the field drew at 1x: the map disagreeing
           with its own chrome, and nothing on screen to say which was
           right. */
        drift: kind.drift * particleSpeed[kind.reads === 'from' ? 'wind' : 'current'],
        maxVelocity: kind.maxVelocity,
        colorScale: kind.colours,
        /* Denser and thicker than a wind-tuned default: ocean particles move
           slowly, so they need weight to register. The multiplier is one
           particle per this many square pixels of map, and the count is
           linear in it. It pairs with the lifetime: cutting the trails
           shortens what each particle contributes, and more of them puts the
           density back without going back to long ropes. */
        particleSeconds: kind.seconds,
        particleMultiplier: densityForView(),
        lineWidth: 2.2,
        frameRate: FRAME_RATE,
      });
      group.addLayer(flowReady);
      entry.layer = flowReady;

      /* Two grids. The coarse one covers the globe and came with the page;
         the fine one is four times sharper but only over the Atlantic and
         Gulf, and is fetched the first time the reader zooms into it. The
         region and its zoom threshold are read from the coarse file's own
         header, so they are not written down twice.

         Swap only when the answer changes: setOptions restarts the
         animation, and doing that on every pan would make the field
         stutter as you drag. */
      /* Finest first, so a viewport inside two regions gets the sharper
         one. Containment assumes a region does not straddle the
         antimeridian; none does, and one that did would need its own
         wrap-aware test. */
      let details = [...(coarse?.[0]?.header?.details ?? [])].sort(
        (a, b) => a.deg - b.deg
      );
      const grids = new Map<string, unknown>();
      let fetching: string | null = null;
      let showing: string | null = null;

      /* Finest tier: the whole ocean at 1/12 degree, cut into 20 degree
         tiles. Only ever one tile at a time — a tile is used when it
         wholly contains the view, which any viewport at its minimum zoom
         does, so there is nothing to stitch. The index is small and says
         which tiles exist; the ones that are pure land were never written. */
      let tiles: {
        size: number; west: number; south: number; north: number;
        minZoom: number; deg: number; available: string[];
      } | null = null;

      /* Which tiles the view touches. Requiring the view to sit inside a
         single tile does not work: at zoom 7 a viewport is roughly 9
         degrees across against a 20 degree tile, so it straddles a seam
         far too often and the map would keep dropping back to the coarse
         regional grid as you pan. So take every tile the view overlaps —
         at most four — and join them. */
      const tileKeys = () => {
        const keys = tileKeysFor(tiles, map.getZoom(), viewBox());
        return keys.length ? keys : null;
      };

      /* Join tiles into one grid. They share a spacing and sit on a common
         lattice, so this is a copy into the right offsets rather than any
         resampling. Cells no tile covers stay null, which reads as land. */
      const assemble = (loaded: VectorGrid[]) => {
        const h0 = loaded[0][0].header;
        const dx = h0.dx;
        const dy = h0.dy;
        const lons = loaded.map((g) => g[0].header.lo1);
        const base = Math.min(...lons.map((l) => (((l - lons[0]) % 360) + 360) % 360 + lons[0]));
        const north = Math.max(...loaded.map((g) => g[0].header.la1));
        const south = Math.min(...loaded.map((g) => g[0].header.la1 - (g[0].header.ny - 1) * dy));
        const east = Math.max(
          ...loaded.map((g) => {
            const off = (((g[0].header.lo1 - base) % 360) + 360) % 360;
            return off + (g[0].header.nx - 1) * dx;
          })
        );
        const nx = Math.round(east / dx) + 1;
        const ny = Math.round((north - south) / dy) + 1;

        return [0, 1].map((component) => {
          const data: (number | null)[] = new Array(nx * ny).fill(null);
          for (const grid of loaded) {
            const h = grid[component].header;
            const ox = Math.round(((((h.lo1 - base) % 360) + 360) % 360) / dx);
            const oy = Math.round((north - h.la1) / dy);
            for (let j = 0; j < h.ny; j++) {
              for (let i = 0; i < h.nx; i++) {
                const value = grid[component].data[j * h.nx + i];
                if (value === null || value === undefined) continue;
                const x = ox + i;
                const y = oy + j;
                if (x < nx && y < ny) data[y * nx + x] = value;
              }
            }
          }
          return { header: { ...h0, ...loaded[0][component].header, nx, ny, lo1: base, la1: north }, data };
        });
      };

      const indexUrl = coarse?.[0]?.header?.tileIndex
        ? fromData(coarse[0].header.tileIndex)
        : undefined;
      /* Tiles live beside their index, so the directory comes from the
         link this depth's own grid gave us. Hardcoding /map/tiles/ here
         had the 60 m layer quietly drawing surface tiles: the right
         particle count in the right places, all at the wrong depth. */
      const tileBase = (indexUrl ?? '').replace(/index\.json$/, '');
      if (indexUrl) {
        fetch(indexUrl)
          .then((r) => r.json())
          .then((index) => {
            tiles = index;
            applyView(false);
          })
          .catch(() => {
            // No tile run yet, or it failed. The regional grids stand.
          });
      }

      const layer = flowReady as unknown as { setOptions?: (o: object) => void };

      const covers = (d: (typeof details)[number]) => {
        if (map.getZoom() < d.minZoom) return false;
        // The whole viewport must be inside the region, or the parts
        // outside it would simply have no flow.
        const view = map.getBounds();
        return (
          view.getWest() >= d.west &&
          view.getEast() <= d.east &&
          view.getSouth() >= d.south &&
          view.getNorth() <= d.north
        );
      };

      const applyView = (zoomChanged: boolean) => {
        // Finest that fits: tiles, else a region, else the globe.
        const wanted = details.find(covers) ?? null;
        const keys = tileKeys();
        const url = keys ? `tiles:${keys.join(',')}` : (wanted?.url ?? null);

        if (url !== showing) {
          if (url && !grids.has(url)) {
            if (fetching !== url) {
              fetching = url;
              // Resolved here rather than where the key is formed: `url` doubles as
              // the cache key, and rewriting it would churn the cache on every view.
              const sources = keys ? keys.map((k) => `${tileBase}${k}.json`) : [fromData(url)];
              Promise.all(sources.map((u) => fetch(u).then((r) => r.json())))
                .then((loaded) => {
                  grids.set(url, keys ? assemble(loaded) : loaded[0]);
                  fetching = null;
                  // The view may have moved on while that was in flight.
                  applyView(false);
                })
                .catch(() => {
                  /* Coarse everywhere is a fine outcome; do not retry in a
                     loop over a network that is not answering. A tile that
                     will not load is struck off the index, a region is
                     pushed out of reach. */
                  fetching = null;
                  if (keys && tiles) {
                    tiles.available = tiles.available.filter((k) => !keys.includes(k));
                  } else if (wanted) {
                    wanted.minZoom = Infinity;
                  }
                });
            }
            return;
          }
          showing = url;
          layer.setOptions?.({
            data: url ? grids.get(url) : coarse,
            particleMultiplier: densityForView(),
          });
          return;
        }

        /* Density only. There is no scale left to refresh — the drift is a
           constant in pixels per (m/s), so it cannot go stale against the
           viewport, which is what the old measured `velocityScale` did in
           three separate ways: cancelling one of the plugin's two factors
           instead of both, measuring the Jacobian with an API that rounds to
           whole pixels, and measuring it before the page had laid the map
           out. All three shipped, all three were silent, and all three are
           gone with the arithmetic that produced them.

           Density does still follow the view, because the particle count is
           the map's area times a multiplier and a resize changes the area. */
      };

      map.on('zoomend', () => applyView(true));
      map.on('moveend', () => applyView(false));
      applyView(false);
      /* Once more after the view settles. fitBounds runs after this layer is
         built, so the first measurement above is taken against bounds the
         reader never sees. */
      map.whenReady(() => setTimeout(() => applyView(true), 0));

      /* Stepping to another forecast hour replaces this layer's whole tier
         chain: a frame's global file brings its own regions, and above lead
         0 brings no tiles at all. So the coarse grid, the region list and
         the tile index are all reloaded from the frame, and `showing` is
         cleared so applyView cannot keep drawing the previous hour's grid
         because its URL happens to be unchanged. */
      offerFrames(coarse?.[0]?.header?.forecast, (frame) =>
        fetch(fromData(frame.url))
          .then((r) => r.json())
          .then((next) => {
            coarse = next;
            details = [...(next?.[0]?.header?.details ?? [])].sort((a, b) => a.deg - b.deg);
            tiles = null;
            grids.clear();
            showing = null;
            fetching = null;
            const index = next?.[0]?.header?.tileIndex;
            if (!index) {
              applyView(false);
              return;
            }
            fetch(fromData(index))
              .then((r) => r.json())
              .then((loaded) => { tiles = loaded; applyView(false); })
              .catch(() => applyView(false));
          })
        , coarse?.[0]?.header?.modelRun
      );
    })
    .catch(() => {
      // No field: the switcher still lists the layer, it is simply empty,
      // and the Mercator raster is there as the fallback depiction.
    });
  };

  /* One shape, two depths: everything but the legend label is shared, and
     the label cannot be, or both depths would name themselves the same in a
     legend that can now show two entries at once. */
  const espcFlow = (label: string): FlowKind => ({
    label,
    source: 'US Navy ESPC-D-V02',
    drift: DRIFT.current,
    seconds: PARTICLE_SECONDS.current,
    // The ramp tops out well under the fastest water on the map: the Gulf
    // Stream core runs past 2 m/s, and scaling to it would leave every
    // other current in the bottom fifth of the ramp.
    maxVelocity: 1.5,
    colours: palette.currents,
    reads: 'toward',
  });

  buildFlow(`${DATA}currents.json`, flow, espcFlow('Surface current'));
  buildFlow(`${DATA}currents-60m.json`, flowDeep, espcFlow('Current at 60 m'));
  buildFlow(`${DATA}wind.json`, wind, {
    label: 'Wind at 10 m',
    source: 'ECMWF IFS',
    drift: DRIFT.wind,
    seconds: PARTICLE_SECONDS.wind,
    /* 25 m/s is a strong gale, near the top of what the 0.25 degree field
       resolves outside a cyclone core — measured, the global p99 is 17.6
       and the maximum 36.9. Topping the ramp at the maximum would put
       almost every wind on the map in its lowest quarter. */
    maxVelocity: 25,
    /* Its own ramp, because it can now be on screen beside the currents —
       and two sets of drifting lines are told apart by nothing but colour.
       Chosen by search rather than by eye, under the extra constraint that
       it clear the currents' amber as well as every background and marker;
       see `_wind` in the palette for what it measured. */
    colours: palette.wind,
    reads: 'from',
  });

  /* Resolve both ramps against whatever is behind them now.

     Called on a basemap change, a layer going on or off, a colour-scale
     change, and a reader picking a colour — never inside a frame. Scoring
     the candidate set is ~17 ms; doing it 18 times a second would be absurd
     and would make the colour jitter besides.

     **Currents resolve first, wind second, against a background that
     includes the currents' answer.** The order matters and this is the
     honest one: resolved independently the two converge on the same region
     of the wheel, and two sets of drifting lines with no shape to tell them
     apart is the one failure this map cannot absorb.

     **A reader's choice is dropped if it no longer clears.** They pick green
     over one colour scale and then change the scale to something green; the
     choice was admissible when made and is not now. Falling back to
     automatic is the only answer that cannot leave an unreadable layer on
     screen, and the picker snaps back to Auto so it is not a silent
     substitution. This is also what makes the control safe without a live
     ΔE readout beside it. */
  resolveParticleColours = () => {
    const background = backgroundColours();
    // No answer is better than a wrong one: an unrecognised basemap leaves
    // the palette's fixed ramps, which are gated for exactly this case.
    if (!background.length) return;

    const admits = (ramp: string[], apartFrom?: string[]) =>
      admissible(ramp, { background, markers: MARKER_COLOURS, apartFrom }, palette.bars);

    const pick = (
      field: 'current' | 'wind',
      apartFrom: string[]
    ): RampChoice => {
      const wanted = particleTint[field];
      if (wanted) {
        const asked = pickRamp(background, [...MARKER_COLOURS, ...apartFrom], wanted);
        if (admits(asked.ramp, apartFrom)) return asked;
        /* **Remembered, not cleared.** The reader asked for green and the
           background moved under them; forgetting the request would mean
           they had to ask again once it became usable, and the map would
           have silently discarded an instruction rather than deferred it.
           So the tint stays, the picker keeps showing it greyed as
           unavailable, and this resolve falls through to automatic — which
           reverses on its own the moment the background clears it again.

           What says the choice is not in force is the legend, which is
           painted from the ramp actually drawn. */
      }
      return pickRamp(background, [...MARKER_COLOURS, ...apartFrom], null);
    };

    const current = pick('current', []);
    const windChoice = pick('wind', current.ramp);
    particleChoice.current = current;
    particleChoice.wind = windChoice;

    for (const entry of flows) {
      const chosen = entry.kind.reads === 'from' ? windChoice : current;
      entry.kind.colours = chosen.ramp;
      (entry.layer as unknown as { setOptions?: (o: object) => void } | null)
        ?.setOptions?.({ colorScale: chosen.ramp });
    }
    refreshTintOptions();
    host.dispatchEvent(new CustomEvent('particlecolours', { detail: particleChoice }));
  };

  /* ---- the scalar fields ---------------------------------------------

     Drawn here rather than fetched as a picture from a WMS, because there
     is no WMS to fetch them from: the Navy's own does not answer, nor does
     the usual ERDDAP, and NCEI's replies "not accessible via WMS". Every
     field therefore comes through scripts/fetch-ocean-fields.py as numeric
     grids, in the same three tiers as the currents. That also means the
     readout can report a value from the grid already loaded, with no
     request.

     The layer itself is `scalar-layer.ts`, and so is the catalogue of what
     it can paint. What stays here is the reader's own state — which
     colormap and which range they chose — because that is per map, and a
     module-level copy would have two maps on a page sharing one. */

  const COLORMAPS: Record<string, number[][]> = Object.fromEntries(
    Object.entries(palette.colormaps ?? {}).map(([name, hexes]) => [
      name,
      rampStops(hexes as string[]),
    ])
  );

  /* What the reader has chosen, per field rather than per layer: the two
     SST layers are the same quantity from different models, so a colour
     scale set on one should hold when switching to the other. `range: null`
     means auto — bounded by the water in view and recomputed on every move.
     */
  type FieldChoice = { map: string; range: [number, number] | null };
  const choices: Record<string, FieldChoice> = {
    sst: { map: palette.defaultColormap?.sst ?? 'thermal', range: null },
    sss: { map: palette.defaultColormap?.sss ?? 'haline', range: null },
    /* Every field in FIELDS needs an entry here, and the coupling is not
       obvious: `choiceFor` indexes this by the field's key and the legend
       reads `.map` off the result, so a field added to FIELDS alone throws
       on the first repaint rather than falling back to a default. Adding
       `sic` without this is exactly what happened. */
    sic: { map: palette.defaultColormap?.sic ?? 'cmo.ice', range: null },
    sit: { map: palette.defaultColormap?.sit ?? 'cmo.ice', range: null },
  };

  const choiceFor = (field?: FieldDescriptor) => choices[field?.key ?? 'sst']!;
  const stopsFor = (field?: FieldDescriptor) =>
    COLORMAPS[choiceFor(field).map] ?? Object.values(COLORMAPS)[0]!;

  /* The tier chain, per field. Same shape as the currents': the global
     file names its own regions and tiles, the finest that covers the view
     wins, and tiles are chosen by overlap and joined.

     This repeats logic that buildFlow above also has. The two formats
     differ — velocity grids are a pair of components, this is one — and
     unifying them is the obvious next step; noted here rather than left
     for someone to discover. */
  const buildField = (url: string, group: L.LayerGroup, field: FieldDescriptor) => {
    const layer = createScalarLayer({
      field,
      /* Read fresh on every paint rather than captured: the layer is built
         when its grid lands, which is before most readers have touched a
         colour control. */
      choice: () => ({ stops: stopsFor(field), range: choiceFor(field).range }),
    });
    const entry: { group: L.LayerGroup; layer: ScalarLayer } = { group, layer };
    ssts.push(entry);

    fetchWhenShown(group, url)
      .then((r) => r.json())
      .then((loadedCoarse: ScalarGrid) => {
        // Reassignable for the same reason as the flow layer's: a forecast
        // hour brings its own grid, its own regions and no tiles.
        let coarse = loadedCoarse;
        /* Credit the source, and name the run where there is one. A
           forecast step valid an hour from now is worthless if it came
           from a run three days old, and without the run on screen there
           is nothing to tell the two apart — which is how the currents sat
           two days stale while looking current. An analysis has no run;
           its own date is the answer, so that is what it shows. */
        layer.options.attribution = credit(
          coarse.header?.source ?? 'unknown source',
          coarse.header?.modelRun,
          coarse.header?.refTime?.slice(0, 10),
          coarse.header?.refTime
        );

        group.addLayer(layer);
        layer.setGrid(coarse);

        let details = [...(coarse.header?.details ?? [])].sort(
          (a: RegionLink, b: RegionLink) => a.deg - b.deg
        );
        const grids = new Map<string, ScalarGrid>();
        let fetching: string | null = null;
        let showing: string | null = null;
        let tiles: TileIndexFile | null = null;

        const indexUrl = coarse.header?.tileIndex
          ? fromData(coarse.header.tileIndex)
          : undefined;
        const tileBase = (indexUrl ?? '').replace(/index\.json$/, '');
        if (indexUrl) {
          fetch(indexUrl)
            .then((r) => r.json())
            .then((index) => {
              tiles = index;
              applyView();
            })
            .catch(() => {
              // No tile run yet. The regional grids stand.
            });
        }

        const tileKeys = () => {
          const keys = tileKeysFor(tiles, map.getZoom(), viewBox());
          return keys.length ? keys : null;
        };

        /* Join tiles onto one lattice. They share a spacing, so this is a
           copy into offsets rather than a resample; cells no tile covers
           stay null and are simply not painted. */
        const assemble = (loaded: ScalarGrid[]): ScalarGrid => {
          const h0 = loaded[0]!.header;
          const dx = h0.dx;
          const dy = h0.dy;
          const lons = loaded.map((g) => g.header.lo1);
          const base = Math.min(
            ...lons.map((l) => ((((l - lons[0]!) % 360) + 360) % 360) + lons[0]!)
          );
          const north = Math.max(...loaded.map((g) => g.header.la1));
          const south = Math.min(
            ...loaded.map((g) => g.header.la1 - (g.header.ny - 1) * dy)
          );
          const east = Math.max(
            ...loaded.map((g) => {
              const off = ((((g.header.lo1 - base) % 360) + 360) % 360);
              return off + (g.header.nx - 1) * dx;
            })
          );
          const nx = Math.round(east / dx) + 1;
          const ny = Math.round((north - south) / dy) + 1;
          const data: (number | null)[] = new Array(nx * ny).fill(null);
          for (const g of loaded) {
            const gh = g.header;
            const ox = Math.round(((((gh.lo1 - base) % 360) + 360) % 360) / dx);
            const oy = Math.round((north - gh.la1) / dy);
            for (let j = 0; j < gh.ny; j++) {
              for (let i = 0; i < gh.nx; i++) {
                const value = g.data[j * gh.nx + i];
                if (typeof value !== 'number') continue;
                const x = ox + i;
                const y = oy + j;
                if (x < nx && y < ny) data[y * nx + x] = value;
              }
            }
          }
          return { header: { ...h0, nx, ny, lo1: base, la1: north }, data };
        };

        const covers = (d: RegionLink) => {
          if (map.getZoom() < d.minZoom) return false;
          const view = map.getBounds();
          return (
            view.getWest() >= d.west &&
            view.getEast() <= d.east &&
            view.getSouth() >= d.south &&
            view.getNorth() <= d.north
          );
        };

        const applyView = () => {
          const wanted = details.find(covers) ?? null;
          const keys = tileKeys();
          const want = keys ? `tiles:${keys.join(',')}` : (wanted?.url ?? null);
          if (want === showing) return;

          if (want && !grids.has(want)) {
            if (fetching === want) return;
            fetching = want;
            const sources = keys ? keys.map((k) => `${tileBase}${k}.json`) : [fromData(want)];
            Promise.all(sources.map((u) => fetch(u).then((r) => r.json())))
              .then((loaded: ScalarGrid[]) => {
                grids.set(want, keys ? assemble(loaded) : loaded[0]!);
                fetching = null;
                applyView();
              })
              .catch(() => {
                fetching = null;
                if (keys && tiles) {
                  tiles.available = tiles.available.filter((k: string) => !keys.includes(k));
                } else if (wanted) {
                  wanted.minZoom = Infinity;
                }
              });
            return;
          }
          showing = want;
          layer.setGrid(want ? grids.get(want)! : coarse);
        };

        map.on('zoomend moveend', applyView);
        applyView();

        offerFrames(coarse.header?.forecast, (frame) =>
          fetch(fromData(frame.url))
            .then((r) => r.json())
            .then((next: ScalarGrid) => {
              coarse = next;
              details = [...(next.header?.details ?? [])].sort((a, b) => a.deg - b.deg);
              tiles = null;
              grids.clear();
              showing = null;
              fetching = null;
              layer.setGrid(next);
              const index = next.header?.tileIndex;
              if (!index) {
                applyView();
                return;
              }
              fetch(fromData(index))
                .then((r) => r.json())
                .then((loaded: TileIndexFile) => { tiles = loaded; applyView(); })
                .catch(() => applyView());
            })
          , coarse.header?.modelRun
        );
      })
      .catch(() => {
        /* No field. HYCOM in particular serves metadata while refusing
           data reads, so one source being down is routine; the switcher
           still lists the layer and it is simply empty. */
      });
  };

  buildField(`${DATA}sst-oisst.json`, sstOisst, FIELDS.sst);
  buildField(`${DATA}sst-navy.json`, sstNavy, FIELDS.sst);
  buildField(`${DATA}sss-navy.json`, sssNavy, FIELDS.sss);
  buildField(`${DATA}sic-oisst.json`, iceOisst, FIELDS.sic);
  buildField(`${DATA}sic-navy.json`, iceNavy, FIELDS.sic);
  buildField(`${DATA}sit-navy.json`, iceThickness, FIELDS.sit);

  /* The legend key is built from the same palette the renderer reads, so
     the two cannot drift, and it stays hidden until a temperature layer is
     actually on — a colour bar for a layer nobody has switched on is just
     noise. */
  const sstKey = find<HTMLElement>('[data-sst-key]');
  if (sstKey && Object.keys(COLORMAPS).length) {
    /* The bar carries its own numbers because the scale is per view: the
       ramp is stretched over whatever water is on screen, so the colours
       alone do not say what they mean. Read from the layer rather than
       recomputed here, so the label and the pixels cannot disagree. */
    /* **One bar per scalar that is on, not one bar.** Ice draws in its own
       pane over temperature, so two can be up at once — and a single key
       would have to pick one of them, which is the "names two fields while
       showing one" failure inverted. Built the way the particle keys are:
       the container is filled with a key each, so the markup does not have
       to know how many there will be. */
    const showKey = () => {
      const on = ssts.filter((f) => map.hasLayer(f.group));
      sstKey.hidden = !on.length;
      sstKey.textContent = '';
      for (const entry of on) {
        const field = entry.layer?.options?.field;
        const range = entry.layer?.getRange?.();
        const hexes = (palette.colormaps ?? {})[choiceFor(field).map] ?? [];
        const shown = (v: number) =>
          field?.percent ? String(Math.round(v * 100)) : String(v);
        const key = document.createElement('span');
        key.className = 'om-key om-key-scalar';
        key.style.setProperty('--sst-ramp', `linear-gradient(to right, ${hexes.join(', ')})`);
        /* Named as well as numbered once there is more than one: with a
           single field the range alone is unambiguous, with two "15 to 90 %"
           beside "0 to 28 °C" needs saying which is which. */
        const span = range
          ? `${shown(range[0])} to ${shown(range[1])} ${field?.unit ?? ''}`.trim()
          : '';
        key.textContent = on.length > 1
          ? `${field?.label ?? 'field'}${span ? ` ${span}` : ''}`
          : (span || field?.label || 'ocean field');
        sstKey.append(key);
      }
    };
    map.on('overlayadd overlayremove moveend zoomend', showKey);
    for (const entry of ssts) entry.layer.on('rangechange', showKey);
    showKey();
  }

  /* The particle keys, one per animated field that is on.

     Wind and a current can be drawn together now, so this is a list rather
     than a single label — and each swatch carries its own field's ramp,
     since that is the only thing on screen separating two sets of drifting
     lines. The two current depths remain exclusive with each other, so at
     most two of these ever show at once.

     Built from the same FlowKind the layer draws with, so the swatch and the
     particles cannot disagree about what colour the field is. */
  {
    const flowKey = find<HTMLElement>('[data-flow-key]');
    if (flowKey) {
      const showFlowKeys = () => {
        const on = flows.filter((f) => map.hasLayer(f.group));
        flowKey.hidden = !on.length;
        flowKey.textContent = '';
        for (const entry of on) {
          const swatch = document.createElement('span');
          swatch.className = 'om-key om-key-flow';
          /* The swatch is built from the ramp the layer actually draws with,
             not from a copy in CSS. The old rule inlined the currents'
             gradient, which was a second source of truth for a colour the
             contrast gate owns — and with two fields on screen a stale
             swatch would point at the wrong one. */
          swatch.style.setProperty(
            '--om-key-ramp',
            `linear-gradient(90deg, ${entry.kind.colours.join(', ')})`
          );
          swatch.textContent = entry.kind.label;
          flowKey.append(swatch);
        }
      };
      map.on('overlayadd overlayremove', showFlowKeys);
      chromeSyncs.push(showFlowKeys);
      /* And whenever the ramps are re-picked, which a layer event does not
         cover: changing the colour scale changes the background, which
         changes the particle colours, with no layer going on or off. A
         legend still showing the previous colour is worse than no legend —
         it is the one thing on screen claiming what the field is drawn in. */
      host.addEventListener('particlecolours', showFlowKeys);
      showFlowKeys();
    }
  }

  /* Both particle controls follow their field, from the same events. Bound
     here rather than inside either block, so it fires once whichever of them
     the host has chosen to render. */
  map.on('overlayadd overlayremove', showFlowControls);
  chromeSyncs.push(showFlowControls);

  /* ---- the particle colour control ------------------------------------

     A named-colour picker, not a colour picker. A free picker lets a reader
     choose something that hides the layer — the same objection that keeps
     the colormap list curated. Asking for "green" states an intent and
     leaves the exact stop to the search, so the reader gets their green and
     it is always the green that works over whatever is behind it now.

     **Only the names that clear are offered.** Each is re-tested against the
     current background whenever that background moves, and one that does not
     clear the palette's bars is disabled rather than removed, so the list
     does not reshuffle under the pointer. That is what lets this ship with no
     ΔE readout beside it: the reader cannot choose a colour that hides the
     layer, because it is not selectable. Measured across all 27 backgrounds
     the map can present, the thinnest case still offers five named colours
     for the current and three for the wind, plus Auto.

     Wind is judged against the current's chosen ramp as well, so a name that
     would collide with the other field goes unavailable rather than drawing
     two indistinguishable sets of trails. */
  {
    /* The word is still worth having for a screen reader and a tooltip, even
     though the swatch is what a sighted reader goes by. */
  const tintName = (hex: string) =>
    NAMED_TINTS.find(([, value]) => value === hex)?.[0] ?? hex;

  const picker = find<HTMLElement>('[data-particle-colours]');
    if (picker) {
      /* **Swatches, not names.** The list was a `<select>` of colour names,
         and a name is only ever an approximation of what the search returns:
         it filters to ΔE ≤ 18 of an exemplar, so "Blue" over blue water is
         legitimately the nearest admissible blue-ish ramp and can read as
         violet. The name then argues with the pixels, and the pixels win.

         Each swatch is painted in **the colour that will actually be drawn**
         — the mid stop of the ramp `pickRamp` returns for that request
         against the background up right now — so it is not a label for the
         choice, it is the choice. The name survives as the accessible name
         and the tooltip, which is where a word still helps.

         Repainted whenever the background moves, for the same reason the
         availability is: the answer for a given request is not fixed. */
      const swatches: Partial<Record<'current' | 'wind', HTMLButtonElement[]>> = {};
      for (const field of ['current', 'wind'] as const) {
        const group = document.createElement('span');
        group.className = 'om-tints';
        group.setAttribute('role', 'radiogroup');
        const label = field === 'wind' ? 'Wind' : 'Current';
        group.setAttribute('aria-label', `${label} particle colour`);

        const name = document.createElement('span');
        name.className = 'om-tint-name';
        name.textContent = label;
        group.append(name);

        const made: HTMLButtonElement[] = [];
        for (const [tintName, tint] of [['Auto', ''] as const, ...NAMED_TINTS]) {
          const swatch = document.createElement('button');
          swatch.type = 'button';
          swatch.className = 'om-tint';
          swatch.dataset.tint = tint;
          swatch.setAttribute('role', 'radio');
          /* Auto has no fixed colour to show — it is whatever the search
             lands on — so it is marked rather than painted. */
          if (!tint) swatch.classList.add('om-tint-auto');
          swatch.addEventListener('click', () => {
            if (swatch.disabled) return;
            particleTint[field] = tint || null;
            resolveParticleColours();
          });
          group.append(swatch);
          made.push(swatch);
        }
        swatches[field] = made;
        flowControls.push({ field, el: group });
        picker.append(group);
      }

      refreshTintOptions = () => {
        const background = backgroundColours();
        if (!background.length) return;
        const currentRamp = particleChoice.current?.ramp ?? [];
        for (const field of ['current', 'wind'] as const) {
          /* The wind must also stay clear of whatever the current ended up
             with; the current has nothing above it to avoid. */
          const apartFrom = field === 'wind' ? currentRamp : [];
          for (const swatch of swatches[field] ?? []) {
            const tint = swatch.dataset.tint ?? '';
            const chosen = particleTint[field] ?? '';
            swatch.setAttribute('aria-checked', String(tint === chosen));
            swatch.classList.toggle('is-chosen', tint === chosen);

            if (!tint) {
              // Auto always works: it searches the whole gamut.
              swatch.disabled = false;
              const auto = particleChoice[field]?.ramp ?? [];
              swatch.style.setProperty('--om-tint',
                auto.length ? auto[Math.floor(auto.length / 2)]! : 'transparent');
              swatch.title = 'Automatic — the clearest colour over what is behind the particles';
              continue;
            }

            const choice = pickRamp(background, [...MARKER_COLOURS, ...apartFrom], tint);
            const usable = admissible(
              choice.ramp,
              { background, markers: MARKER_COLOURS, apartFrom },
              palette.bars
            );
            swatch.disabled = !usable;
            /* Painted in the resolved ramp either way. A disabled swatch
               still shows what it *would* draw, which is what makes the
               refusal legible: the reader can see it is too close to the
               water rather than being told so. */
            swatch.style.setProperty('--om-tint', choice.ramp[Math.floor(choice.ramp.length / 2)]!);
            swatch.title = usable
              ? String(tintName(tint))
              : `${tintName(tint)} would not stand out from what is behind the particles ` +
                'right now, so it cannot be chosen until the background changes.';
            swatch.setAttribute('aria-label', String(tintName(tint)));
          }
        }
      };
    }
  }

  /* ---- how fast each velocity field is drawn ---------------------------

     One slider per animated field, scaling its own calibrated drift.

     **The rate is the only thing a reader can move**, and that is what makes
     it safe to offer. Direction comes from the grid, relative speeds within
     a field come from the grid, and the point readout quotes m/s from the
     grid — so a field drawn fast is a field drawn fast, not a field claiming
     to be fast. The wind layer already rests on exactly this argument: it is
     drawn at twice parity because circulations are only legible if a streak
     runs far enough to be seen turning.

     Sliders rather than buttons, and unlike the forecast-hour control that
     is safe here: stepping a lead calls `setOptions({data})`, which tears
     the animation down and restarts it, while drift is read fresh on the
     next frame and changes nothing else. Dragging one is continuous and
     costs nothing per frame. */
  {
    const box = find<HTMLElement>('[data-particle-speed]');
    if (box) {
      box.textContent = '';
      const applySpeed = (field: 'current' | 'wind') => {
        for (const entry of flows) {
          if ((entry.kind.reads === 'from' ? 'wind' : 'current') !== field) continue;
          (entry.layer as unknown as { setOptions?: (o: object) => void } | null)
            /* `kind.drift` stays the base — scaling it in place would
               compound every time the slider moved. */
            ?.setOptions?.({ drift: entry.kind.drift * particleSpeed[field] });
        }
      };
      applyParticleSpeed = () => {
        applySpeed('current');
        applySpeed('wind');
      };

      for (const field of ['current', 'wind'] as const) {
        const label = document.createElement('label');
        /* **Visible, not screen-reader-only.** These were `om-vh` and the row
           came out as two anonymous sliders with a multiple beside each —
           nothing said which was the wind. Short here because the row is
           crowded; the full phrase stays on the slider's own aria-label and
           title, so the accessible name is still "Wind speed, multiple of
           the calibrated rate" rather than "Wind". */
        const name = document.createElement('span');
        name.textContent = field === 'wind' ? 'Wind' : 'Current';
        name.className = 'om-speed-name';
        label.append(name);

        const slider = document.createElement('input');
        slider.type = 'range';
        /* A quarter to four times, logarithmic in feel by being linear in
           the exponent: the useful range is multiplicative, so a linear
           slider would spend three quarters of its travel above 1x. */
        slider.min = '-2';
        slider.max = '2';
        slider.step = '0.25';
        slider.value = '0';
        slider.dataset.particleSpeed = field;
        slider.setAttribute('aria-label', `${name.textContent}, multiple of the calibrated rate`);

        const readout = document.createElement('span');
        readout.className = 'om-speed-readout';
        const show = () => {
          /* **Always two decimals**, so every value is the same number of
             characters. It printed "1×" at exactly one and "1.1×" a step
             later, and the width difference pushed the wind slider sideways
             — a control moving under the pointer because a *different*
             control's label got longer. Tabular figures and a fixed width
             on the readout finish the job; this is the half that has to be
             in the string. */
          const at = particleSpeed[field];
          readout.textContent = `${at.toFixed(2)}×`;
          slider.title = `${name.textContent}: ${readout.textContent} the calibrated rate`;
        };
        slider.addEventListener('input', () => {
          particleSpeed[field] = 2 ** Number(slider.value);
          applySpeed(field);
          show();
          saveView();
        });
        show();

        label.append(slider, readout);
        box.append(label);
        speedSliders[field] = slider;
        speedShow[field] = show;
        flowControls.push({ field, el: label });
      }
    }
  }

  /* Now that both particle controls exist, put them in the state the layers
     are actually in — the event above only fires on a change, and a reader
     arriving with the wind off would otherwise see its controls until they
     touched something. */
  showFlowControls();

  /* Reader control over the colour scale. Three things, all per field and
     all live: which colormap, what range it spans, and a way back to
     automatic.

     Only the colormaps in the palette are offered, and that is the point —
     whichever is chosen becomes the water under every marker, so the set is
     the one the contrast gate has checked. A free colour picker would let a
     reader hide the fleet. */
  /* The forecast hour, as buttons rather than a slider.

     Two reasons, and the first is mechanical: stepping a frame calls
     `setOptions({data})` on the particle layer, which tears the animation
     down and restarts it. A slider dragged across five values would do that
     five times, each restart cancelling a redraw still in flight — the same
     shape of fight the two animated fields had over `overlayadd`. Discrete
     buttons make each step deliberate and single.

     The second is honesty. The label on each button is its **valid time in
     UTC**, not "+24h": the leads are relative to a *build*, and the run
     behind that build can be two days old, so "+24h" would be measured from
     a moment the reader knows nothing about. A clock time is unambiguous,
     and the one nearest their own clock is marked and selected by default. */
  const forecastControls = find<HTMLElement>('[data-forecast-controls]');
  if (forecastControls) {
    const draw = () => {
      if (forecast.frames.length < 2) return;
      forecastControls.hidden = false;
      forecastControls.textContent = '';
      const label = document.createElement('span');
      label.className = 'om-vh';
      label.textContent = 'Forecast hour';
      forecastControls.append(label);

      const nearest = nearestFrame(forecast.frames);
      /* Two anchors, named, because "+24h" means different things to
         different readers and the difference is not small here.

         A lead in this map is measured from **now**: +24h is the step
         nearest this time tomorrow. In forecasting it conventionally means
         T+24 from the model's own initialisation — and with a run two days
         late, that would be a field valid *yesterday*. Anchoring to the run
         would put a forecast behind the reader, which is precisely what the
         nearest-to-now default exists to prevent.

         So the button says the valid time, which is unambiguous, and the
         title says how far ahead of now it is *and* the model's own
         forecast hour from the run. Whichever convention the reader has in
         mind, the number they are looking for is there. */
      const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;
      const runAt = forecast.run ? Date.parse(forecast.run) : null;
      for (const frame of forecast.frames) {
        const button = document.createElement('button');
        button.type = 'button';
        const at = new Date(frame.valid);
        const day = at.toUTCString().slice(0, 3);
        const hour = String(at.getUTCHours()).padStart(2, '0');
        button.textContent = frame === nearest ? 'Now' : `${day} ${hour}Z`;
        const ahead = Math.round((at.getTime() - Date.now()) / 3600e3);
        const fromRun = runAt === null
          ? null
          : Math.round((at.getTime() - runAt) / 3600e3);
        button.title = [
          `Valid ${stamp(frame.valid)}`,
          frame === nearest ? 'nearest to now' : `${ahead >= 0 ? '+' : ''}${ahead} h from now`,
          fromRun === null ? null : `T+${fromRun} from the ${stamp(forecast.run!)} run`,
        ].filter(Boolean).join(' · ');
        if (frame.lead === forecast.lead) button.classList.add('active');
        button.setAttribute('aria-pressed', String(frame.lead === forecast.lead));
        /* Above lead 0 there is no tile tier, so the finest grid is the
           regional one. Saying so is the difference between a coarser
           forecast and a map that looks like it broke. */
        if (frame !== nearest) button.dataset.coarser = '';
        button.addEventListener('click', () => showLead(frame.lead));
        forecastControls.append(button);
      }
    };
    forecast.render.push(draw);
  }

  /* ---- colour-scale controls, one set per field ----------------------

     **The module builds these, where it used to find them in the host's
     markup.** Ice draws in its own pane over temperature, so two scalar
     fields can be on at once, and a single set of inputs then had to pick
     one of them — it took whichever was built first, so a reader changed a
     colormap and watched the other field's bar move. Arbitrary and silent.

     One set per field is the fix, and the reason it could not be a loop over
     the host's element is that the markup *was* the host's. Cloning it as a
     template was the cheaper alternative and was measured against building:
     33 nodes a set, 0.063 ms to clone against 0.085 ms to build, so 0.04 ms
     apart for the two fields that can actually be on. Performance decided
     nothing, so it went the way the package has been drifting anyway — the
     particle pickers and forecast buttons are already built here.

     **Built once per field, then shown or hidden.** Rebuilding on every
     layer toggle would destroy an open dropdown mid-gesture, which is the
     same hazard `syncControls` already guards by skipping focused inputs.
     A set costs 33 nodes; keeping four of them parked is nothing. */
  const controls = find<HTMLElement>('[data-field-controls]');
  if (controls && Object.keys(COLORMAPS).length) {
    /* Captured, because `syncControls` below is a function *declaration* —
       hoisted, so it is outside the narrowing this `if` gives and TypeScript
       stops believing `controls` is non-null inside it. It is declared
       rather than assigned because the per-field handlers built above it
       call it. */
    const box = controls;
    box.textContent = '';

    const repaint = () => {
      for (const entry of ssts) if (map.hasLayer(entry.group)) entry.layer._render?.();
    };

    type FieldControls = {
      field: FieldDescriptor;
      root: HTMLElement;
      name: HTMLElement;
      picker: HTMLSelectElement;
      min: HTMLInputElement;
      max: HTMLInputElement;
      auto: HTMLButtonElement;
    };

    const buildFor = (field: FieldDescriptor): FieldControls => {
      const root = document.createElement('span');
      root.className = 'om-field-controls';
      root.dataset.field = field.key;

      /* Named only when more than one set is on screen — with a single
         field the bar above says which it is, and repeating it is noise.
         Same rule the legend follows. */
      const name = document.createElement('span');
      name.className = 'om-field-name';
      name.textContent = field.label;
      name.hidden = true;
      root.append(name);

      const picker = document.createElement('select');
      /* The `data-field-*` hooks stay, even though the module builds these
         now rather than finding them. They were the contract — a host
         styles against them and `test:map` drives them — and only who
         creates the element has changed. */
      picker.dataset.fieldMap = '';
      picker.setAttribute('aria-label', `${field.label} colour scale`);
      /* Two groups, and the split is measured rather than editorial: the
         first clear every marker at every stop, the second are the standard
         oceanographic and matplotlib maps, which cannot — a full-gamut
         colormap passes near a marker colour somewhere along it,
         necessarily. They are offered regardless. They are not the default,
         the markers keep their dark outlines, and which scale to read the
         ocean with is the reader's call, not the gate's. */
      const safe = new Set<string>(palette.markerSafe ?? []);
      for (const [caption, names] of [
        ['High contrast', Object.keys(COLORMAPS).filter((n) => safe.has(n))],
        ['Standard', Object.keys(COLORMAPS).filter((n) => !safe.has(n))],
      ] as [string, string[]][]) {
        if (!names.length) continue;
        const group = document.createElement('optgroup');
        group.label = caption;
        for (const cmap of names) {
          const option = document.createElement('option');
          option.value = cmap;
          option.textContent = cmap;
          group.append(option);
        }
        picker.append(group);
      }
      root.append(picker);

      const number = (label: string) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = String(field.step);
        input.setAttribute('aria-label', `${field.label} scale ${label}`);
        return input;
      };
      const min = number('minimum');
      min.dataset.fieldMin = '';
      const max = number('maximum');
      max.dataset.fieldMax = '';
      const dash = document.createElement('span');
      dash.setAttribute('aria-hidden', 'true');
      dash.textContent = '–';
      const auto = document.createElement('button');
      auto.dataset.fieldAuto = '';
      auto.type = 'button';
      auto.textContent = 'Auto';
      root.append(min, dash, max, auto);

      const set = { field, root, name, picker, min, max, auto };

      picker.addEventListener('change', () => {
        choiceFor(field).map = picker.value;
        repaint();
        syncControls();
        // The colour scale *is* the background when a field is on, so the
        // particles have to be re-picked against it.
        resolveParticleColours();
      });

      const pin = () => {
        const lo = Number(min.value);
        const hi = Number(max.value);
        // An inverted or empty range would paint one flat colour; leave the
        // current scale alone until the pair makes sense.
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
        choiceFor(field).range = [lo, hi];
        repaint();
        syncControls();
      };
      min.addEventListener('change', pin);
      max.addEventListener('change', pin);

      auto.addEventListener('click', () => {
        choiceFor(field).range = null;
        repaint();
        syncControls();
      });

      box.append(root);
      return set;
    };

    /* One set per *field*, not per layer: two layers can paint the same
       quantity — OISST and Navy temperature both use FIELDS.sst — and they
       share a `choices` entry, so they must share the control that edits
       it. Built for every field the map offers, whether or not its layer is
       on, so the first toggle shows a control rather than making one. */
    const sets: FieldControls[] = [];
    for (const key of [...new Set(ssts.map((f) => f.layer?.options?.field?.key))]) {
      const field = ssts.find((f) => f.layer?.options?.field?.key === key)?.layer?.options?.field;
      if (field) sets.push(buildFor(field));
    }

    /* Reflect the live state into the inputs. Skipped while a field is
       focused, or typing "3" on the way to "35" would be read back as 3 and
       the caret would jump. */
    function syncControls() {
      const live = new Map<string, [number, number] | null | undefined>();
      for (const entry of ssts) {
        const key = entry.layer?.options?.field?.key;
        if (key && map.hasLayer(entry.group)) live.set(key, entry.layer?.getRange?.());
      }
      let showing = 0;
      for (const set of sets) {
        const on = live.has(set.field.key);
        set.root.hidden = !on;
        if (on) showing += 1;
      }
      box.hidden = showing === 0;
      for (const set of sets) {
        if (set.root.hidden) continue;
        set.name.hidden = showing < 2;
        const choice = choiceFor(set.field);
        set.picker.value = choice.map;
        set.auto.disabled = choice.range === null;
        set.auto.textContent = choice.range === null ? 'Auto' : 'Reset';
        const range = live.get(set.field.key);
        if (range && document.activeElement !== set.min && document.activeElement !== set.max) {
          set.min.value = String(range[0]);
          set.max.value = String(range[1]);
        }
      }
    }

    map.on('overlayadd overlayremove moveend zoomend', syncControls);
    for (const entry of ssts) entry.layer.on('rangechange', syncControls);
    syncControls();
  }

  /* Exclusive Economic Zones, from Marine Regions (VLIZ) — the maintainers
     of the maritime boundaries database. Boundary lines only rather than
     filled zones: a filled polygon over every coastal ocean would bury the
     field underneath it, and the useful question here is where a line
     falls relative to a glider, not which shade of blue a country's water
     is. Served as WMS images, so no CORS is involved. */
  const eez = L.tileLayer.wms('https://geo.vliz.be/geoserver/MarineRegions/wms?', {
    layers: 'eez_boundaries',
    format: 'image/png',
    transparent: true,
    pane: 'eez',
    className: 'map-eez',
    opacity: 0.85,
    attribution:
      '<a href="https://www.marineregions.org/">Marine Regions</a> (VLIZ) — EEZ boundaries',
  });

  /* Isobaths, contoured from GEBCO 2026 by scripts/fetch-bathymetry.py and
     committed. The seafloor does not change, so this is the one dataset
     here that is computed once by hand rather than fetched on a schedule —
     no workflow, no cache key, no hourly cost.

     Two tiers for the same reason the fields have them, but split by depth
     rather than by region: 200 m and below is 1.2 MB gzipped globally and
     is the basin-scale picture, while 20-100 m is five times that and is
     unreadable until you are zoomed in — a 20 m isobath threads every
     sandbar. So the deep set is one file and the shallow set is tiled on
     the same 20 deg lattice as the current and field tiles.

     Neither is fetched with the page. This layer is off by default, and a
     reader who never switches it on never pays for it. */
  const bathy = L.layerGroup([], {
    attribution:
      '<a href="https://www.gebco.net/">GEBCO</a> 2026 — isobaths',
  });
  // The coarse global set, and the fine per-view set. Only one is ever on.
  const bathyDeep = L.layerGroup().addTo(bathy);
  const bathyShallow = L.layerGroup().addTo(bathy);

  // How see-through the contours are. Part of the reader's view, so it
  // rides in the saved view with the basemap and the colour scales.
  const BATHY_OPACITY = 0.7;
  let bathyOpacity = BATHY_OPACITY;
  const bathyControls = find<HTMLElement>('[data-bathy-controls]');
  const bathySlider = bathyControls?.querySelector<HTMLInputElement>('[data-bathy-opacity]');

  /* Contours at the round hundreds and thousands are drawn heavier, which
     is what a chart does: without an index contour every line reads the
     same and counting them is the only way to know which is which. */
  const BATHY_MAJOR = new Set([100, 1000, 4000, 8000]);

  /* Every contour at one depth becomes a single multi-line polyline rather
     than one layer each. Leaflet renders that as one path element with
     many subpaths, so the global file's 19,707 contours are ten DOM nodes
     instead of nineteen thousand — the difference between this layer being
     free and it being the most expensive thing on the map. It is also what
     lets the contours stay SVG, and so stay themed in CSS like the other
     linework, instead of needing the canvas renderer Argo uses. */
  const drawContours = (geo: IsobathFile | null, target: L.LayerGroup): L.Polyline[] => {
    const byDepth = new Map<number, [number, number][][]>();
    for (const feature of geo?.features ?? []) {
      const depth = feature?.properties?.d;
      const coords = feature?.geometry?.coordinates;
      if (typeof depth !== 'number' || !Array.isArray(coords)) continue;
      let lines = byDepth.get(depth);
      if (!lines) byDepth.set(depth, (lines = []));
      lines.push(coords.map(([x, y]: number[]) => [y!, x!] as [number, number]));
    }
    const drawn: L.Polyline[] = [];
    for (const [depth, lines] of byDepth) {
      const major = BATHY_MAJOR.has(depth);
      // No colour here: CSS owns the stroke, so a theme switch restyles
      // every contour with no redraw.
      drawn.push(
        L.polyline(lines, {
          pane: 'bathy',
          interactive: false,
          weight: major ? 1.1 : 0.7,
          className: major ? 'map-bathy map-bathy-major' : 'map-bathy',
        }).addTo(target)
      );
    }
    // Newly arrived geometry is at its literal longitudes; home it before
    // the reader sees a gap where a tile just landed.
    rehomeBathy();
    return drawn;
  };

  /* Vector layers live in **one copy of the world**, so a contour written
     at -179 is drawn a full 360 deg west of a view panned east past the
     date line, and the seafloor silently disappears down one side of the
     map. Markers already have rehome() for this; it deliberately skips
     lines, because moving a track's vertices independently would tear any
     line that legitimately crosses the seam.

     A contour is safe to move whole, though, and that is the difference:
     each depth is one polyline holding many independent sub-lines, so
     shifting an entire sub-line by 360 deg cannot tear anything — the
     shape is untouched, only which copy it sits in.

     Each sub-line is homed **separately**, and that part is not optional.
     One shared shift for the whole layer was the first attempt and it is
     wrong wherever it matters most: a view sitting on the antimeridian
     needs the contours west of it in one copy and those east of it in the
     next, so whichever way a single shift moves, half the map comes up
     bare. That is exactly what it did.

     Like rehome(), it moves only what needs to come *into* view: anything
     already on screen is left alone, and so is anything off screen in both
     copies. Without that, sub-lines on the far side of the world would
     flip copy on almost every pan, and because a whole depth is one
     polyline, one flip rewrites half a million points. */
  const bathySpans = new WeakMap<any, [number, number][]>();

  const spansOf = (lines: L.LatLng[][]): [number, number][] =>
    lines.map((line) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of line) {
        if (p.lng < lo) lo = p.lng;
        if (p.lng > hi) hi = p.lng;
      }
      return [lo, hi] as [number, number];
    });

  const rehomeBathy = () => {
    const view = map.getBounds();
    const west = view.getWest();
    const east = view.getEast();
    const middle = (west + east) / 2;
    for (const group of [bathyDeep, bathyShallow]) {
      group.eachLayer((layer: L.Layer) => {
        // Only the multi-line polylines this layer draws; a group may hold
        // anything, and a sub-line is what can safely be moved a world over.
        if (!(layer instanceof L.Polyline)) return;
        const lines = layer.getLatLngs() as L.LatLng[][];
        let spans = bathySpans.get(layer);
        if (!spans || spans.length !== lines.length) {
          spans = spansOf(lines);
          bathySpans.set(layer, spans);
        }
        let moved = false;
        for (let i = 0; i < lines.length; i++) {
          const span = spans[i];
          const line = lines[i];
          if (!span || !line) continue;
          const [lo, hi] = span;
          if (hi >= west && lo <= east) continue; // already on screen
          const shift = Math.round((middle - (lo + hi) / 2) / 360) * 360;
          if (!shift) continue;
          if (hi + shift < west || lo + shift > east) continue; // off screen either way
          lines[i] = line.map((p: L.LatLng) => L.latLng(p.lat, p.lng + shift));
          spans[i] = [lo + shift, hi + shift];
          moved = true;
        }
        if (moved) layer.setLatLngs(lines);
      });
    }
  };

  let bathyDeepAsked = false;
  const loadBathyDeep = () => {
    if (bathyDeepAsked) return;
    bathyDeepAsked = true;
    fetch(`${DATA}bathy-deep.json`)
      .then((r) => r.json())
      .then((geo) => drawContours(geo, bathyDeep))
      .catch(() => {
        bathyDeepAsked = false; // let a later switch-on try again
      });
  };

  let bathyTiles: TileIndexFile | null = null;
  let bathyIndexAsked = false;
  const bathyLoaded = new Map<string, L.Polyline[]>();

  const loadBathyIndex = () => {
    if (bathyIndexAsked) return;
    bathyIndexAsked = true;
    fetch(`${DATA}bathy-tiles/index.json`)
      .then((r) => r.json())
      .then((index) => {
        bathyTiles = index;
        syncBathyTiles();
      })
      .catch(() => {
        // No tiles published. The coarse global file stands on its own.
      });
  };

  /* Which tiles the view touches. Overlap rather than containment,
     for the same reason the current tiles use overlap: a viewport narrower
     than a tile still straddles seams, and requiring containment drops the
     whole tier as you pan. */
  const bathyTileKeys = (): string[] =>
    tileKeysFor(bathyTiles, map.getZoom(), viewBox());

  /* Finest that fits, the same rule the current and field grids follow.
     A tile carries *every* level at 0.004 deg — a 2 px vertex spacing at
     zoom 7 — while the global file carries only the deep ones at 0.04, and
     drawing both would put a coarse polygonal line under a fine one, offset
     by a few pixels, on every contour they share.

     The swap waits until the tiles it is waiting on have actually drawn,
     rather than firing when they are merely requested: hiding the global
     set the moment a fetch starts leaves the map briefly bare, which is
     worse than a moment of the coarse line. */
  const bathyTilesDrawn = () => {
    const wanted = bathyTileKeys();
    return wanted.length > 0 && wanted.every((k) => (bathyLoaded.get(k)?.length ?? 0) > 0);
  };

  const settleBathyTiers = () => {
    const fine = bathyTilesDrawn();
    if (fine && bathy.hasLayer(bathyDeep)) bathy.removeLayer(bathyDeep);
    if (!fine && !bathy.hasLayer(bathyDeep)) bathy.addLayer(bathyDeep);
  };

  const syncBathyTiles = () => {
    if (!map.hasLayer(bathy)) return;
    loadBathyIndex();
    const wanted = new Set(bathyTileKeys());
    for (const [key, layers] of [...bathyLoaded]) {
      if (wanted.has(key)) continue;
      for (const layer of layers) bathyShallow.removeLayer(layer);
      bathyLoaded.delete(key);
    }
    for (const key of wanted) {
      if (bathyLoaded.has(key)) continue;
      bathyLoaded.set(key, []); // claim it now, so one pan is one request
      fetch(`${DATA}bathy-tiles/${key}.json`)
        .then((r) => r.json())
        .then((geo) => {
          // Panned off it while the request was in flight; drop the answer.
          if (!bathyLoaded.has(key)) return;
          bathyLoaded.set(key, drawContours(geo, bathyShallow));
          settleBathyTiers();
        })
        .catch(() => {
          bathyLoaded.delete(key);
          settleBathyTiers();
        });
    }
    settleBathyTiers();
  };

  /* A real shoreline, from EMODnet Bathymetry's WMS.

     The one that used to be drawn here was public/map/coastline.json —
     Natural Earth, simplified hard so the offline basemap could stay
     small. Measured, its vertices are 16 px apart at zoom 7 in the
     mid-Atlantic, which is exactly as coarse as the isobaths were before
     they were fixed, and it showed: a blocky line a few pixels off the
     crisp coast the basemap already draws.

     EMODnet renders vector-side at whatever scale is asked for — doubling
     the raster halves the ink share, measured 0.50-0.54 across five
     regions, which an upscaled bitmap would not do. Despite the European
     remit the layer is global: checked at Tokyo Bay, Kodiak, Cook Strait,
     the Gulf of Guinea and the Chesapeake, all with content.

     Chosen over Marine Regions' world_countries_coasts, which is on a host
     already trusted here for the EEZ lines but renders bright green with
     about half the detail. This one comes out neutral grey, so CSS can
     tint it the way it tints the EEZ tiles. */
  const shoreline = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms?', {
    layers: 'coastlines',
    format: 'image/png',
    transparent: true,
    pane: 'coast',
    className: 'map-coast',
    opacity: 0.9,
    attribution:
      '<a href="https://emodnet.ec.europa.eu/en/bathymetry">EMODnet Bathymetry</a> — coastline',
  });

  const gebco = L.tileLayer.wms('https://wms.gebco.net/mapserv?', {
    layers: 'GEBCO_LATEST',
    format: 'image/png',
    attribution: 'GEBCO Compilation Group',
  });

  /* The offline basemap. Empty until someone selects it — see `whenChosen`
     at the bottom of the file, which fills it on first add and never again.
     Attribution is declared here rather than per-polygon: 7,720 rings would
     otherwise register the same credit 7,720 times. */
  const coastline = L.layerGroup([], {
    attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> — land',
  });

  const bases: Record<string, L.Layer> = {
    'Bathymetry (GEBCO)': gebco,
    'Bathymetry (Esri Ocean)': bathymetry,
    OpenStreetMap: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }),
    'Coastline only (no tracking)': coastline,
  };
  /* The reader's own basemap, not the default followed by a swap. Once the
     map has a view — which it does now, several thousand lines earlier than
     it used to — removing one tile layer and adding another is not free: it
     tears down a loaded tile set and requests a new one, measured at 654 ms.
     Opening on the right one costs nothing and skips both. */
  (openingView?.base && bases[openingView.base] ? bases[openingView.base]! : gebco).addTo(map);

  /* **Yield here, so the basemap can actually be painted.** Everything above
     is the map a reader recognises; everything below is layers, chrome and
     controls that can arrive a frame later. Without this the whole of
     `createOceanMap` is one task and the browser cannot paint until it ends,
     which is what made the map appear after ~1.7 s rather than immediately.

     `setTimeout`, not `requestAnimationFrame`: rAF does not fire at all in a
     hidden tab, so a map built in a background tab would never finish
     starting. Timers are throttled there but they do fire. */
  await new Promise((resume) => setTimeout(resume, 0));

  /* Dark mode dims the tile pane, which was written when the light Esri
     basemap was the default. GEBCO is already dark — its deep ocean sits
     near 0.10 luminance against Esri's 0.33 — so dimming it too drops the
     sea to almost black. The active basemap's tone is published on the
     container and the stylesheet dims only the light ones. */
  const LIGHT_BASEMAPS = new Set(['Bathymetry (Esri Ocean)', 'OpenStreetMap']);
  const markBasemapTone = (name: string) => {
    host.dataset.basemapTone = LIGHT_BASEMAPS.has(name) ? 'light' : 'dark';
    // With no scalar field on, the basemap's water *is* the background.
    activeBasemap = name;
    resolveParticleColours();
  };
  markBasemapTone('Bathymetry (GEBCO)');
  map.on('baselayerchange', (e: L.LayersControlEvent) => markBasemapTone(e.name));

  /* Animation is the default, but a continuously moving field is exactly
     what prefers-reduced-motion is about. Those readers used to get the
     static Mercator raster in its place; with that switched off there is
     no still depiction of the current to offer, so they get no current
     layer rather than an animated one they did not ask for. Both animated
     fields remain in the switcher for them to turn on deliberately. */
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) flow.addTo(map);


  /* Lat/lon grid. It wires its own redraws — see `graticule.ts`. */
  const graticule = createGraticule(map);

  /* Every link in a popup leaves the site, so each opens in its own tab:
     a reader following a float to Euro-Argo has usually not finished with
     the map, and coming back would cost them their view and a fresh fetch
     of the whole field. rel is not optional with target=_blank — without
     noopener the opened page gets a handle on this one through
     window.opener and can navigate it somewhere else. The label says so
     out loud for anyone who cannot see a new tab appear. */
  const outbound = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" ` +
    `aria-label="${text} (opens in a new tab)">${text}</a>`;

  /* Vector markers exist in exactly one copy of the world. Basemap tiles
     repeat across copies, so panning east past the antimeridian shows
     ocean with no platforms on it and the fleet looks sliced down the date
     line — measured centred on 180°, where the view spans 82°E to 278°E
     but only the floats numerically inside 82–180 were drawn, because the
     rest sit at negative longitudes one copy west.

     Leaflet's own answer, worldCopyJump, moves the view rather than the
     markers, and does it with a whole-world snap that flashes. This moves
     the markers instead: one marker each, re-homed, rather than three
     copies of every marker — at four thousand floats that is the
     difference between 4,000 layers and 12,000, and a view is never wider
     than a copy at any zoom this map offers.

     Point features only. A track that crosses the meridian would be torn
     in half by re-homing its vertices independently, and there is no
     correct answer for a line that legitimately spans the seam. */
  const rehome = (group: L.LayerGroup) => {
    /* Only markers that need to come *into* view are moved.

       Wrapping every marker to the copy nearest the centre is correct but
       wasteful, and the waste is visible: each setLatLng extends the
       canvas renderer's redraw bounds, and once those bounds span the
       canvas Leaflet clears and repaints all of it. Dragging across the
       date line swept the antipode of the centre through the fleet and
       moved hundreds of off-screen markers nobody was looking at, which
       cost a full repaint — the dots blinked out and back.

       So: leave anything already on screen alone, leave anything that is
       off screen either way alone, and move only the ones whose other copy
       is about to be visible. A marker parked in a stale copy is corrected
       the moment it matters. */
    const view = map.getBounds().pad(0.25);
    const west = view.getWest();
    const east = view.getEast();
    const south = view.getSouth();
    const north = view.getNorth();
    const centre = map.getCenter().lng;

    group.eachLayer((layer) => {
      const marker = layer as L.CircleMarker;
      const at = marker.getLatLng?.();
      if (!at) return;
      if (at.lat < south || at.lat > north) return;
      if (at.lng >= west && at.lng <= east) return;      // already showing
      const lng = centre + L.Util.wrapNum(at.lng - centre, [-180, 180], true);
      if (lng < west || lng > east) return;              // off screen either way
      marker.setLatLng([at.lat, lng]);
    });
  };

  /* The measuring tool, built before its first consumer rather than 700
     lines below it — see `measure.ts`. It used to be declared down beside
     the point readout and reached from the hit-target handler above, which
     worked only because that handler cannot run until a reader clicks. */
  const measure = createMeasureTool(map, host);

  /* ---- hit targets --------------------------------------------------

     How close a tap has to land. The dots are drawn small so a crowded
     basin stays readable, but small is a poor target on a touchscreen,
     where there is no cursor to aim with and a fingertip covers far more
     than a 5 px circle. So the hit area is decoupled from the drawing:
     an invisible circle over each asset, wider where the pointer is
     coarse. Leaflet gives SVG paths `pointer-events: auto`, so a fully
     transparent circle still takes the tap. */
  const TAP_RADIUS = window.matchMedia('(pointer: coarse)').matches ? 22 : 12;

  /* Clicking a feature opens its detail — unless the measurement tool is
     armed, in which case the click is a survey point. Leaflet does not
     pass a click on an interactive layer through to the map, so a tap
     that lands on a glider would otherwise be swallowed mid-measurement,
     and the reader would have to avoid their own assets to measure
     between them. Hence the explicit popup rather than bindPopup: the
     decision has to be made before anything opens. */
  /* Hovering is a mouse idea. On a touchscreen Leaflet opens a tooltip on
     tap, which would fight the popup for the same gesture, so the label is
     not bound there.

     Asked as "is hover absent?" rather than "is hover present?" on
     purpose: the negative form treats an unknown answer as a mouse, so a
     browser that does not support the query keeps the labels instead of
     silently losing them. */
  const CAN_HOVER = !window.matchMedia('(hover: none)').matches;

  type DetailOptions = { ocean?: boolean; label?: string };

  const showDetail = (layer: L.Path, html: string, opts: DetailOptions = {}) => {
    const withOcean = opts.ocean === true;

    /* A name follows the pointer, so a basin full of identical dots can be
       read without clicking each one. Sticky rather than anchored: on a
       track or a wide tap circle an anchored tooltip would sit at the
       shape's centre, which is nowhere near the cursor. */
    if (opts.label && CAN_HOVER) {
      layer.bindTooltip(opts.label, {
        sticky: true,
        direction: 'right',
        offset: [12, 0],
        className: 'map-hover',
        opacity: 1,
      });
    }

    /* Leaflet hands a click on a feature to the map afterwards as well.
       While measuring that lands the same point twice — a zero-length leg
       reported as "0.00 km" — so the feature has to claim the click. */
    layer.options.bubblingMouseEvents = false;
    layer.on('click', (e: L.LeafletMouseEvent) => {
      /* Anchored on the feature, not the click, so a tap on the edge of a
         wide hit circle still refers to the dot it belongs to. That holds
         for the measurement too: a leg drawn to a glider should end where
         the glider is, not 20 px away where the finger landed. Tracks are
         lines with no one position, so those take the click. */
      const at = (layer as L.CircleMarker).getLatLng?.() ?? e.latlng;
      if (measure.active) {
        measure.addPoint(at);
        return;
      }
      /* Assets carry the state of the water they are sitting in, on top
         of their own details. Only the point features: a track or a
         forecast cone has no one position for the ocean to be sampled at,
         and the reader can right-click anywhere along it. */
      const popup = L.popup()
        .setLatLng(at)
        .setContent(withOcean ? html + oceanRows(at) : html)
        .openOn(map);
      if (withOcean) {
        fillDepth(popup, at);
        fillEez(popup, at);
      }
    });
    return layer;
  };

  const tapTarget = (
    at: L.LatLngExpression,
    html: string,
    layer: L.LayerGroup,
    opts: DetailOptions = {}
  ) =>
    showDetail(
      L.circleMarker(at, {
        radius: TAP_RADIUS,
        stroke: false,
        fillOpacity: 0,
        // Added before the visible marker, so it sits underneath and never
        // hides the dot it stands in for.
        className: 'map-tap-target',
      }).addTo(layer),
      html,
      // A tap target only ever stands in for a point asset.
      { ocean: true, ...opts }
    );

  /* Argo floats: two thousand dots, against forty gliders and saildrones.
     Drawn on a canvas rather than as SVG — that many vector elements would
     compete with the particle animation for the same frame budget. The
     cost is that canvas markers carry no class, so unlike the other
     platforms these cannot be restyled by theme; the colour is one the
     contrast gate clears on both bathymetries, which is what makes that
     acceptable. The dark outline earns its cost: gold sits close to the
     amber particles on fill alone, and an outlined dot still reads as a
     discrete object beside a drifting trail. */
  /* Two thousand dots, so how big they are matters more here than for the
     forty gliders. At basin zoom they read as individual floats; zoomed
     out to the globe the same size closes into a sheet of yellow that
     hides the water under it. So they shrink for the wide views.

     The outline shrinks with them. It is what separates a float from a
     drifting current particle, and at 2 px a 0.8 px stroke is most of the
     dot — the fill it is meant to frame all but disappears, and the fleet
     turns muddy rather than gold. */
  const argoStyleFor = (zoom: number) =>
    zoom <= 3 ? { radius: 2, weight: 0.6 } : { radius: 2.8, weight: 0.8 };

  /* Argo dots are a couple of pixels across and there are two thousand of
     them, so invisible hit circles would double the canvas work. The canvas
     renderer hit-tests arithmetically instead, and honours a tolerance —
     same effect, no extra geometry. Note the tolerance is what a tap needs,
     not the dot, so it does not shrink with the drawing. */
  const argoCanvas = L.canvas({ padding: 0.3, tolerance: TAP_RADIUS });
  const argo = L.layerGroup().addTo(map);

  fetch(`${DATA}argo.json`)
    .then((r) => r.json())
    .then((data) => {
      for (const float of data.floats ?? []) {
        showDetail(
          L.circleMarker([float.lat, float.lon], {
            renderer: argoCanvas,
            ...argoStyleFor(map.getZoom()),
            color: ARGO_EDGE,
            opacity: 0.9,
            fillColor: ARGO,
            fillOpacity: 0.95,
          }).addTo(argo),
          `<strong>Argo ${float.id}</strong>` +
            `<dl><dt>Last profile</dt><dd>${stamp(float.time)}</dd>` +
            `<dt>Position</dt><dd>${coordText(float.lat, float.lon)}</dd></dl>` +
            outbound(
              `https://fleetmonitoring.euro-argo.eu/float/${float.id}`,
              'Float details'
            ),
          { ocean: true, label: `Argo ${float.id}` }
        );
      }
      const count = (data.floats ?? []).length;
      if (count) {
        statusParts.argo = `${count} Argo floats`;
        showStatus();
      }
      // The reader may already have panned away from the primary copy
      // before this arrived.
      rehome(argo);

      /* Restyle on zoom. setStyle marks each layer and the canvas renderer
         coalesces the redraws into one frame, so this costs one repaint
         rather than two thousand. Only when the answer changes — at two
         thousand layers, a no-op pass on every wheel notch is not free. */
      let styled = argoStyleFor(map.getZoom());
      map.on('zoomend', () => {
        const wanted = argoStyleFor(map.getZoom());
        if (wanted.radius === styled.radius) return;
        styled = wanted;
        argo.eachLayer((layer) => (layer as L.CircleMarker).setStyle(wanted));
      });
    })
    .catch(() => {
      // No fleet is survivable; the rest of the map is unaffected.
    });

  const borders = L.layerGroup().addTo(map);
  const storms = L.layerGroup().addTo(map);
  const usvs = L.layerGroup().addTo(map);
  const gliders = L.layerGroup().addTo(map);

  /* Keep every point layer in the copy of the world the reader is looking
     at. Runs on move rather than only on the copy changing, because the
     right copy for a marker depends on how far it is from the centre, not
     on which copy the centre is in. */
  const wrapped = [argo, storms, usvs, gliders];
  const rehomeAll = () => wrapped.forEach(rehome);
  map.on('moveend zoomend', rehomeAll);

  /* These strings are the layer's identity, not decoration. A page preset
     names them, `check:docs` fails on a preset naming one that does not
     exist, and a reader's saved view records them — so a rename is a small
     migration, not a caption edit. The one cost that cannot be avoided: a
     saved view holding the old name loses that layer's on/off state and
     falls back to the default, once.

     **The naming rule, because depth is a dimension here.** Every ESPC layer
     is a quantity at a depth, so the name says both:

       quantity at depth   `<Quantity> at <N>m`: Currents at 0m, Currents at 60m
       surface scalars     the standard acronym: SST, SSS

     The currents are spelled out because the surface is not special for
     them — 0m is one sample of a field that exists all the way down, and
     `Currents at 0m` sits beside `Currents at 60m` as an equal. SST and SSS
     keep their acronyms because those are the names an oceanographer
     reaches for; when temperature or salinity at depth arrives it takes the
     spelled-out form, `Salinity at 60m (ESPC)`, and the acronym stays
     reserved for the surface special case.

     `(animated)` is gone from the current layers. It distinguished them
     from a static speed raster that no longer exists — `MERCATOR_RASTER` is
     false — so it was describing a contrast the reader cannot see.

     The **source** goes in parentheses and names the product, not the
     agency: `(ESPC)`, not `(Navy forecast)`. Two ESPC layers were called
     "Navy forecast" while the currents beside them, from the same model,
     said nothing at all.

     Note `FIELDS[...].label` is a different string on purpose — the quantity
     rather than the layer, used by the readout and the colour bar, where
     "Salinity: 34.2 psu" reads better than the acronym would. */
  const overlays: Record<string, L.Layer> = {
    'Currents at 0m (ESPC)': flow,
    'Currents at 60m (ESPC)': flowDeep,
    'Wind at 10m (ECMWF)': wind,
    'SST (OISST analysis)': sstOisst,
    'SST (ESPC)': sstNavy,
    'SSS (ESPC)': sssNavy,
    /* Ice concentration, named for the product like every other scalar.
       `SIC` is the standard acronym, so it takes the same shape as SST and
       SSS rather than being spelled out. */
    'SIC (OISST)': iceOisst,
    'SIC (ESPC)': iceNavy,
    /* Thickness, and it replaced the ice edge. The edge drew the boundary of
       a field already on screen; this is a quantity the concentration does
       not carry — 90% cover of 0.3 m new ice and 90% of 2 m multi-year ice
       are the same picture and very different ocean. */
    'SIT (ESPC)': iceThickness,
    ...(MERCATOR_RASTER ? { 'Current speed (Mercator)': currents } : {}),
    'Hurricanes': storms,
    'NOAA USVs': usvs,
    'Ocean gliders': gliders,
    'Argo floats': argo,
    'Isobaths': bathy,
    'Coastline': shoreline,
    'Country & state borders': borders,
    'EEZ boundaries': eez,
    'Lat/lon grid': graticule,
  };

  /* The platform keys follow their layers.

     **Placed after `overlays` deliberately.** It reads the switcher's own
     map of names to layers, and sitting above that declaration threw a
     temporal-dead-zone error on every load — which `astro check` cannot
     see, being a runtime ordering fault rather than a type one, and which
     `test:map` did not fail on either because an uncaught rejection
     during init is not a failed check. The browser console was the only
     place it showed.

     A legend entry for a layer that is off is a promise the map is not
     keeping — the reader looks for magenta dots that are not there and
     concludes the fleet is missing rather than switched off. The animated
     fields already worked this way; these were static markup and did not.

     Driven off the switcher's own names, so a key naming a layer that does
     not exist simply never shows rather than throwing — and `check:docs`
     already fails on a name that is not in `overlays`, which is what stops
     that being silent. */
  {
    const keys = Array.from(root.querySelectorAll<HTMLElement>('[data-layer-key]'));
    if (keys.length) {
      const showPlatformKeys = () => {
        for (const key of keys) {
          const layer = overlays[key.dataset.layerKey ?? ''];
          key.hidden = !layer || !map.hasLayer(layer);
        }
      };
      map.on('overlayadd overlayremove', showPlatformKeys);
      chromeSyncs.push(showPlatformKeys);
      showPlatformKeys();
    }
  }

  /* A page's preset, applied before the defaults are captured below — so
     "default" still means one thing, and Reset returns here rather than to
     the map's own opening state.

     Animated layers are dropped for a reduced-motion reader even when the
     preset names them. A preset is the page author's wish; this is the
     reader's, and it wins. That was the exact hazard the note below warned
     about when defaults were only ever captured. */
  if (CONFIG.layers) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wanted = new Set(
      CONFIG.layers.filter((name) => !(reduced && /animated/i.test(name)))
    );
    for (const [name, layer] of Object.entries(overlays)) {
      if (wanted.has(name) && !map.hasLayer(layer)) map.addLayer(layer);
      if (!wanted.has(name) && map.hasLayer(layer)) map.removeLayer(layer);
    }
  }

  /* **Warm anything the page asked for beyond its preset.** Applied after
     the preset, because the preset has just decided what is on and those
     have loaded themselves already; this is only for layers that open off
     and are still expected to be reached for.

     Names are the switcher's, the same identities a preset uses, so a
     misspelling here does nothing at all — which is why `check:docs` reads
     the names out of `overlays` and holds both lists to them. */
  for (const name of CONFIG.preload ?? []) {
    pendingLoads.get(overlays[name] as L.Layer)?.();
  }

  /* What "default" means, captured rather than restated. Every layer that
     is on right now is on because startup put it there — or because the
     preset above did — and that is the only place deciding. Writing the list
     out again here would be a second source of truth that drifts, and it
     would be wrong for a reduced-motion reader, who never gets the animated
     field. Taken before restoreView runs, so it is the defaults and not the
     reader's session. */
  const DEFAULT_OVERLAYS = new Set(
    Object.keys(overlays).filter((name) => map.hasLayer(overlays[name]!))
  );

  const layerControl = L.control.layers(bases, overlays).addTo(map);

  /* ---- the reader's own overlays --------------------------------------

     A KMZ or KML the reader hands over, drawn as-is and kept between visits.
     Deliberately inert: it does not join the exclusivity groups, feed the
     point readout or take part in re-homing. It is something to look at
     alongside the data, not another data layer.

     Colours come from the file, which is the one place S5 in BOUNDARIES.md
     does not apply — the contrast gate governs colours *we* choose, and it
     can say nothing about a reader's own. Anything the file leaves unstyled
     falls back to the measured line colour so it is at least legible. */
  const kmzControls = find<HTMLElement>('[data-kmz-controls]');
  const kmzInput = kmzControls?.querySelector<HTMLInputElement>('[data-kmz-file]');
  const kmzList = kmzControls?.querySelector<HTMLElement>('[data-kmz-list]');
  const kmzNote = find<HTMLElement>('[data-kmz-note]');
  const loadedOverlays = new Map<string, L.LayerGroup>();

  const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

  /* Object URLs for the overlay images, revoked when their layer goes. A KMZ
     of scanned charts is easily tens of megabytes, and a blob left unrevoked
     is held until the tab closes. */
  const overlayUrls = new Map<string, string[]>();

  /* An image on four arbitrary corners, which an axis-aligned image overlay
     cannot express: with gx:LatLonQuad opposite edges need not be parallel,
     so the image has to be warped rather than scaled and rotated.

     The element keeps its natural size and is placed by a CSS matrix3d built
     in warp.ts from the four corners projected into layer coordinates —
     recomputed on every view change, because those coordinates move. */
  const QuadImage = L.Layer.extend({
    initialize(this: any, url: string, corners: [number, number][], options: L.LayerOptions) {
      this._url = url;
      this._corners = corners;
      L.setOptions(this, options);
    },
    onAdd(this: any) {
      const image = L.DomUtil.create('img', 'om-kmz-quad');
      image.src = this._url;
      image.alt = (this.options.alt as string) ?? 'overlay image';
      image.style.position = 'absolute';
      image.style.transformOrigin = '0 0';
      if (this.options.opacity != null) image.style.opacity = String(this.options.opacity);
      this._image = image;
      this.getPane()!.appendChild(image);
      // The natural size is not known until it loads, and the matrix needs it.
      image.addEventListener('load', () => this._reset());
      this._map.on('zoomend viewreset moveend', this._reset, this);
      this._reset();
    },
    onRemove(this: any) {
      this._map.off('zoomend viewreset moveend', this._reset, this);
      this._image?.remove();
      this._image = null;
    },
    getBounds(this: any) {
      return L.latLngBounds(this._corners.map(([lon, lat]: number[]) => L.latLng(lat!, lon!)));
    },
    _reset(this: any) {
      const image: HTMLImageElement | null = this._image;
      if (!image || !this._map) return;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) return;
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      /* Layer points, because the element is a child of the pane and Leaflet
         positions the pane itself. KML lists the corners counterclockwise
         from the south-west; the matrix wants them in the unit square's own
         order, which is north-west first and clockwise from there. */
      const at = (i: number): Pixel => {
        const [lon, lat] = this._corners[i];
        const point = this._map.latLngToLayerPoint(L.latLng(lat, lon));
        return [point.x, point.y];
      };
      image.style.transform = matrix3d(width, height, [at(3), at(2), at(1), at(0)]);
    },
  });

  const drawOverlays = (group: L.LayerGroup, id: string, overlays: KmzOverlay[]) => {
    const urls: string[] = [];
    for (const overlay of overlays) {
      const url = URL.createObjectURL(new Blob([overlay.image as BlobPart], { type: overlay.mediaType }));
      urls.push(url);
      if (overlay.corners) {
        group.addLayer(
          new (QuadImage as unknown as new (u: string, c: [number, number][], o: L.LayerOptions) => L.Layer)(
            url,
            overlay.corners,
            { pane: 'user', opacity: overlay.opacity, alt: overlay.name ?? 'overlay image' } as L.LayerOptions
          )
        );
        continue;
      }
      const bounds = overlay.bounds!;
      const image = L.imageOverlay(
        url,
        [
          [bounds.south, bounds.west],
          [bounds.north, bounds.east],
        ],
        { pane: 'user', opacity: overlay.opacity, alt: overlay.name ?? 'overlay image' }
      );
      /* Rotation goes on the CSS `rotate` property rather than into
         `transform`, which Leaflet owns and rewrites on every move — the
         individual property composes with it instead of fighting it. KML
         measures counterclockwise where CSS measures clockwise. */
      if (overlay.rotation) {
        image.on('add', () => {
          const element = image.getElement();
          if (element) element.style.rotate = `${-overlay.rotation}deg`;
        });
      }
      group.addLayer(image);
    }
    if (urls.length) overlayUrls.set(id, urls);
  };

  const drawKmz = (features: KmzFeature[]): L.LayerGroup => {
    const group = L.layerGroup([], { pane: 'user' });
    const flip = (ring: [number, number][]) =>
      ring.map(([x, y]) => [y, x] as [number, number]);
    for (const feature of features) {
      const style = feature.style ?? {};
      const path: L.PathOptions = {
        pane: 'user',
        color: style.stroke ?? MEASURE,
        opacity: style.strokeOpacity ?? 0.9,
        weight: style.strokeWidth ?? 2,
        fill: style.filled !== false && feature.kind === 'polygon',
        fillColor: style.fill ?? style.stroke ?? MEASURE,
        fillOpacity: style.fillOpacity ?? 0.2,
        /* `outline` is a PolyStyle property and governs a polygon's edge only.
           Applied to everything it silently erases lines: the sample plan
           shares one style between its legs and its boxes, with the boxes
           unoutlined, and every leg rendered stroke="none" — drawn, correct
           colour in the options, invisible on screen. */
        stroke: feature.kind !== 'polygon' || style.outlined !== false,
      };
      let layer: L.Layer | null = null;
      if (feature.kind === 'point') {
        const [lon, lat] = (feature.coordinates as [number, number][])[0]!;
        layer = L.circleMarker([lat, lon], { ...path, radius: 5, fill: true, fillOpacity: 0.9 });
      } else if (feature.kind === 'line') {
        layer = L.polyline(flip(feature.coordinates as [number, number][]), path);
      } else {
        layer = L.polygon((feature.coordinates as [number, number][][]).map(flip), path);
      }
      /* Name and description as text nodes, never markup. kmz.ts has already
         flattened the file's HTML; building the popup with textContent means
         a second pair of hands cannot reintroduce it. */
      if (layer && (feature.name || feature.description)) {
        const box = document.createElement('div');
        if (feature.name) {
          const title = document.createElement('strong');
          title.textContent = feature.name;
          box.append(title);
        }
        if (feature.folder) {
          const where = document.createElement('div');
          where.className = 'om-kmz-folder';
          where.textContent = feature.folder;
          box.append(where);
        }
        if (feature.description) {
          const body = document.createElement('p');
          body.textContent = feature.description;
          box.append(body);
        }
        layer.bindPopup(box);
      }
      if (layer) group.addLayer(layer);
    }
    return group;
  };

  const showKmzNote = (message: string) => {
    if (kmzNote) kmzNote.textContent = message;
  };

  const listKmz = () => {
    if (!kmzList) return;
    kmzList.textContent = '';
    for (const [id, group] of loadedOverlays) {
      const row = document.createElement('span');
      row.className = 'om-kmz-item';
      const label = document.createElement('span');
      label.textContent = (group as unknown as { _kmzName?: string })._kmzName ?? id;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.setAttribute('aria-label', `Remove ${label.textContent}`);
      drop.textContent = '×';
      drop.addEventListener('click', async () => {
        map.removeLayer(group);
        layerControl.removeLayer(group);
        loadedOverlays.delete(id);
        for (const url of overlayUrls.get(id) ?? []) URL.revokeObjectURL(url);
        overlayUrls.delete(id);
        await removeOverlay(id);
        listKmz();
        showKmzNote('');
      });
      row.append(label, drop);
      kmzList.append(row);
    }
    kmzList.hidden = loadedOverlays.size === 0;
  };

  const addKmz = async (id: string, name: string, bytes: ArrayBuffer) => {
    const doc: KmzDocument = await readKmz(new Uint8Array(bytes), parseXml);
    if (!doc.features.length && !doc.overlays.length) {
      throw new Error(`${name} has nothing this map can draw — ${summarise(doc)}`);
    }
    const group = drawKmz(doc.features);
    drawOverlays(group, id, doc.overlays);
    (group as unknown as { _kmzName?: string })._kmzName = name;
    loadedOverlays.set(id, group);
    layerControl.addOverlay(group, name);
    group.addTo(map);
    listKmz();
    return summarise(doc);
  };

  /* Restored before anything is uploaded, so a returning reader finds their
     overlays already on the map. Failures here are per file: one unreadable
     record must not cost the others. */
  void listOverlays(CONFIG.storageKey).then(async (saved) => {
    for (const record of saved) {
      try {
        await addKmz(record.id, record.name, record.bytes);
      } catch {
        await removeOverlay(record.id);
      }
    }
  });

  kmzInput?.addEventListener('change', async () => {
    const files = [...(kmzInput.files ?? [])];
    kmzInput.value = '';
    for (const file of files) {
      const id = `kmz:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      try {
        const bytes = await file.arrayBuffer();
        const drew = await addKmz(id, file.name, bytes);
        const stored = await saveOverlay({
          id,
          mapKey: CONFIG.storageKey,
          name: file.name,
          bytes,
          added: Date.now(),
        });
        /* One sentence, not two in sequence. Reporting the storage failure by
           replacing the summary loses what was actually drawn — the file is
           on the map either way, and only keeping it between visits is lost. */
        showKmzNote(
          `${file.name}: ${drew}${stored ? '' : ' · not kept — this browser refused storage'}`
        );
      } catch (error) {
        showKmzNote(error instanceof Error ? error.message : `${file.name} could not be read`);
      }
    }
  });


  /* The two animated fields are exclusive. Both at once is two sets of
     drifting lines over the same water with nothing to tell them apart,
     and turning one on is a clear enough statement that the reader wants
     to look at that depth. Done by listening rather than by a radio
     control, so the choice still survives the saved view, which records
     overlays by name. */
  const EXCLUSIVE: L.Layer[][] = [
    // The same quantity at two depths, so nothing on screen could say which
    // is which. Wind is deliberately not here — see the note on `wind`.
    [flow, flowDeep],
    // Every scalar raster: they share a pane, so the upper one simply
    // hides the lower and the map would name two fields while showing one.
    /* Ice concentration joins them: it is another scalar raster in the same
       pane, so the upper one would simply hide the lower and the map would
       name two fields while showing one. The ice *edge* is deliberately not
       here — it is a line in its own pane, and edge-over-SST is the pair
       worth reading. */
    [sstOisst, sstNavy, sssNavy],
    /* Ice is exclusive with *itself* and nothing else. Concentration and
       thickness share the ice pane and are two readings of the same floe, so
       one would hide the other and the legend would name both; either can be
       read over temperature or salinity. */
    [iceOisst, iceNavy, iceThickness],
  ];

  /* A scalar field going on or off swaps the background wholesale — from the
     basemap's water to that field's colour scale, or back. */
  map.on('overlayadd overlayremove', () => resolveParticleColours());

  map.on('overlayadd', (e: L.LayersControlEvent) => {
    const group = EXCLUSIVE.find((p) => p.includes(e.layer));
    const others = (group ?? []).filter((l) => l !== e.layer && map.hasLayer(l));
    if (!others.length) return;
    /* Deferred by a tick, deliberately. The control applies every ticked
       box in one pass and re-adds anything it finds missing, so removing
       the other field from inside that pass is immediately undone — and
       the two adds then chase each other until one tears down a layer
       whose first redraw is still queued, which throws. Waiting for the
       pass to end also lets the control repaint its boxes, which it skips
       while handling a click, so the switcher agrees with the map. */
    setTimeout(() => {
      if (!map.hasLayer(e.layer)) return;
      for (const other of others) if (map.hasLayer(other)) map.removeLayer(other);
    }, 0);
  });

  /* Neither isobath tier is fetched until the layer is switched on, and
     the shallow tiles follow the view from then on. */
  map.on('overlayadd', (e: L.LayersControlEvent) => {
    if (e.layer !== bathy) return;
    loadBathyDeep();
    syncBathyTiles();
  });
  map.on('moveend zoomend', rehomeBathy);
  map.on('moveend zoomend', syncBathyTiles);

  /* The page reloads itself when the hourly rebuild lands (below), so the
     reader's setup is stashed first and restored here — otherwise every
     refresh would throw away their basemap, their layer choices and
     wherever they had panned to. Per-tab, so a fresh visit still opens on
     the basin rather than in someone's week-old view. */
  const VIEW_KEY = CONFIG.storageKey;

  const saveView = () => {
    try {
      // Fold the centre back into -180..180 first: with worldCopyJump off
      // it can wander to 540 after enough panning, and a stored view is
      // read back much later.
      const centre = map.getCenter().wrap();
      sessionStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          lat: +centre.lat.toFixed(4),
          lng: +centre.lng.toFixed(4),
          zoom: map.getZoom(),
          base: Object.keys(bases).find((name) => map.hasLayer(bases[name]!)),
          overlays: Object.keys(overlays).filter((name) => map.hasLayer(overlays[name]!)),
          /* Every overlay that existed when this was saved. Without it a
             layer added later looks identical to one the reader switched
             off, and restoring would hide it from anyone holding an older
             view — which is exactly what happened when Argo was added. */
          known: Object.keys(overlays),
          /* The colour scale a reader has set is part of their view. The
             page reloads itself when a new build lands, so without this a
             pinned range would quietly revert to automatic mid-session —
             the one thing "fixed until reset" must not do. */
          fields: choices,
          /* Same reason as the colour scales: the page reloads itself when
             a new build lands, and an opacity that silently jumped back to
             default mid-session would read as the slider not holding. */
          bathyOpacity,
          /* The forecast hour, as a **lead** rather than a valid time. A
             reader who steps to +24h and comes back after the hourly
             reload wants tomorrow-from-now, not the absolute hour that
             meant at the time — which by then is a frame nearer the past. */
          lead: forecast.lead,
          /* Same reason again: the page reloads itself hourly, and a colour
             the reader chose deliberately must survive that. Stored as the
             exemplar they asked for, not the ramp it resolved to — the
             background may differ by then, and what they asked for is
             "green", not that particular green. */
          tints: particleTint,
          /* Same reasoning as the tints: the page reloads itself hourly and
             a rate the reader chose has to survive it. */
          speeds: particleSpeed,
        })
      );
    } catch {
      // Private browsing can refuse storage; the map still works.
    }
  };

  const restoreView = () => {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null');
    } catch {
      return false;
    }
    if (!saved || typeof saved.zoom !== 'number') return false;

    const base = saved.base && bases[saved.base];
    /* `!map.hasLayer(base)` because the opening view has usually put this
       very layer on already. Without the guard this removes it and adds it
       back, which discards a loaded tile set to arrive where it started. */
    if (base && !map.hasLayer(base)) {
      for (const layer of Object.values(bases)) if (map.hasLayer(layer)) map.removeLayer(layer);
      map.addLayer(base);
    }
    /* **Outside the swap, not inside it**, and that distinction is now
       load-bearing. Leaflet's layers control turns an addLayer into a
       baselayerchange, so the handler above catches the swap — but the
       opening view has usually put this very basemap on already, so there
       is no swap to catch and the tone would keep the default. Which is
       exactly what happened: opening on the reader's own basemap made
       `test:map`'s tone check fail, because the tile pane was GEBCO while
       the container still said the default was showing. */
    if (base) markBasemapTone(saved.base);
    if (saved.fields) {
      for (const [key, choice] of Object.entries(saved.fields as Record<string, any>)) {
        if (!choices[key] || !choice) continue;
        // Only a colormap that still exists; the set can change between builds.
        if (typeof choice.map === 'string' && COLORMAPS[choice.map]) choices[key]!.map = choice.map;
        const range = choice.range;
        choices[key]!.range =
          Array.isArray(range) && range.length === 2 && range.every((v: unknown) => typeof v === 'number')
            ? [range[0], range[1]]
            : null;
      }
    }

    /* Applied through showLead so it goes through the same guard as a
       click: a lead the current data does not publish is ignored rather
       than leaving the map claiming an hour it has no grid for. Deferred,
       because the layers announce their frames as they load. */
    if (typeof saved.lead === 'number') {
      setTimeout(() => showLead(saved.lead as number), 0);
    }
    if (typeof saved.bathyOpacity === 'number' && Number.isFinite(saved.bathyOpacity)) {
      bathyOpacity = Math.max(0.1, Math.min(1, saved.bathyOpacity));
    }

    /* Only a colour still on offer — the list can change between builds, and
       a stored exemplar nothing recognises would sit in `particleTint`
       forever, failing every admissibility test and quietly costing the
       reader the automatic choice. Whether it clears *this* background is
       not checked here: the resolver does that on every background change
       and hands an inadmissible one back to auto. */
    /* Clamped to the slider's own range: a stored value outside it would
       leave the thumb pinned at an end while the field drew at something
       else. */
    const speeds = saved.speeds as Record<string, unknown> | undefined;
    if (speeds) {
      for (const field of ['current', 'wind'] as const) {
        const at = speeds[field];
        if (typeof at === 'number' && at >= 0.25 && at <= 4) particleSpeed[field] = at;
      }
      syncSpeedSliders();
      applyParticleSpeed();
    }

    const tints = saved.tints as Record<string, unknown> | undefined;
    if (tints) {
      const offered = new Set(NAMED_TINTS.map(([, tint]) => tint));
      for (const field of ['current', 'wind'] as const) {
        const tint = tints[field];
        if (typeof tint === 'string' && offered.has(tint)) particleTint[field] = tint;
      }
    }

    if (Array.isArray(saved.overlays)) {
      /* Anything the saved view never knew about keeps its default.
         When it carries no list at all — every view saved before this was
         added — the only layers it can be assumed to have known about are
         the ones it recorded as on. Falling back to the current set of
         overlays instead would treat a brand new layer as one the reader
         had switched off, which is the exact bug this exists to prevent
         and made the first version of it useless to anyone holding an
         older view. */
      const known = new Set<string>(
        Array.isArray(saved.known) ? saved.known : saved.overlays
      );
      for (const [name, layer] of Object.entries(overlays)) {
        if (!known.has(name)) continue;
        const wanted = saved.overlays.includes(name);
        if (wanted && !map.hasLayer(layer)) map.addLayer(layer);
        else if (!wanted && map.hasLayer(layer)) map.removeLayer(layer);
      }
    }
    map.setView([saved.lat, saved.lng], saved.zoom);
    return true;
  };

  const restored = restoreView();
  /* The view is in place now, and it got there by adding and removing layers
     directly rather than through the control — so nothing has told the
     chrome. */
  syncChrome();
  map.on('moveend zoomend baselayerchange overlayadd overlayremove', saveView);

  /* Isobath opacity, in the legend row beside the colour-scale controls
     rather than as a Leaflet control — the same reason those are there: a
     slider inside the map is awkward on a touchscreen, and this is where
     the reader is already looking.

     Applied to the pane, not to each contour. That is one CSS property for
     the whole layer however many tiles are loaded, and no path is restyled
     — setStyle across every contour on every drag of the slider would be
     the expensive way to do the same thing.

     The floor is 10% rather than 0: a layer that is switched on but
     completely invisible reads as broken, and the layer switcher is
     already the way to turn it off. */
  const applyBathyOpacity = () => {
    bathyPane.style.opacity = String(bathyOpacity);
    if (bathySlider) bathySlider.value = String(Math.round(bathyOpacity * 100));
    if (bathyControls) bathyControls.hidden = !map.hasLayer(bathy);
  };
  bathySlider?.addEventListener('input', () => {
    bathyOpacity = Math.max(0.1, Math.min(1, Number(bathySlider.value) / 100));
    bathyPane.style.opacity = String(bathyOpacity);
    saveView();
  });
  map.on('overlayadd overlayremove', applyBathyOpacity);
  applyBathyOpacity();

  if (!restored) map.fitBounds(BASIN);

  L.control.scale({ imperial: false }).addTo(map);

  /* The viewer's name, over the map rather than beside it — so a screenshot
     of the map carries it and arrives somewhere still saying what it is.
     Bottom-right, which the credit vacated when it moved into the caption,
     and which balances the scale bar opposite.

     `pointer-events: none` in the stylesheet, because a mark that eats a
     click is worse than no mark: this map reads a right-click, a long press
     and a measuring click, and all three land on the canvas underneath. */
  if (CONFIG.brand) {
    const Brand = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const el = L.DomUtil.create('div', 'om-brand');
        el.textContent = CONFIG.brand;
        /* Decoration, not content: the page's own heading already names
           this, so a screen reader meeting it again here learns nothing. */
        el.setAttribute('aria-hidden', 'true');
        return el;
      },
    });
    map.addControl(new Brand());
  }

  /* ---- the point readout -------------------------------------------- */

  /* Right-click, or a long press on a touch screen, reports the position.
     Leaflet raises contextmenu for the mouse; iOS Safari does not raise it
     reliably from a long press, so touch is timed here instead. */
  /* What the ocean is doing at a point, as popup rows. Shared by the
     right-click readout and by every asset popup — a reader who clicks a
     glider wants to know the water it is in, and having that only on
     right-click meant the two halves of the same question were answered by
     two different gestures. Seafloor comes back asynchronously, so it goes
     in as a placeholder and fillDepth patches it. */
  const oceanRows = (ll: L.LatLng) => {
    const moving = flowsAt(ll);
    const fields = scalarsAt(ll);
    return (
      `<dl class="ocean">` +
      /* The label is provisional. Most of what a reader clicks is ocean, so
         "Seafloor" is the right thing to show while the lookup is in
         flight — but the DEM answers for land too, and a point in the
         Alaskan interior came back "Seafloor 947 m above sea level", which
         is a contradiction in terms. It is rewritten with the value. */
      `<dt data-depth-label>Seafloor</dt><dd data-depth>fetching…</dd>` +
      /* Only when the EEZ layer is on, for the same reason the temperature
         row waits for a temperature layer: a reader who has not asked about
         maritime boundaries is not asking about them here either, and the
         row costs a request to fill. */
      (map.hasLayer(eez) ? `<dt>Jurisdiction</dt><dd data-eez>fetching…</dd>` : '') +
      /* Named for the depth actually sampled — the reader may have the
         60 m field on, and calling that "surface current" would be wrong
         in a way nothing on screen would give away. */
      /* A row per animated field that is on — both, when both are. With no
         field on there is no grid to miss, so nothing is claimed: saying
         "no data" would be a statement about the ocean rather than about
         the map. */
      moving.map((f) =>
        `<dt>${f.label}</dt><dd>` +
        (f.speed === null || f.bearing === null
          ? 'no data here'
          : `${f.speed.toFixed(f.reads === 'from' ? 1 : 2)} m/s ` +
            `${f.reads} ${f.bearing.toFixed(0)}°T`) +
        `</dd>`
      ).join('') +
      /* Only when a temperature layer is on. With none loaded there is no
         grid to miss, and "no data" would claim something untrue about the
         ocean rather than about the map. */
      fields.map((f) => `<dt>${f!.label}</dt><dd>${f!.text}</dd>`).join('') +
      `</dl>`
    );
  };

  /* NOAA's DEM mosaic, queried a point at a time. It is the only
     bathymetry service reached from the browser that sends CORS — GEBCO's
     WMS advertises GetFeatureInfo but returns nothing, and neither HYCOM
     nor OpenTopoData allows cross-origin reads. Asynchronous, so a slow or
     failed lookup never delays the rest of the popup. */
  const fillDepth = (popup: L.Popup, ll: L.LatLng) => {
    const cell = () => popup.getElement()?.querySelector('[data-depth]');
    const label = () => popup.getElement()?.querySelector('[data-depth-label]');
    const lon = ((((ll.lng + 180) % 360) + 360) % 360) - 180;
    const query =
      'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/identify' +
      `?geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: ll.lat, spatialReference: { wkid: 4326 } }))}` +
      '&geometryType=esriGeometryPoint&returnGeometry=false&f=json';

    fetch(query)
      .then((r) => r.json())
      .then((info) => {
        const at = cell();
        if (!at) return;
        const value = Number(info?.value);
        if (!Number.isFinite(value)) {
          at.textContent = 'no data';
          return;
        }
        /* Below sea level is a seafloor; above it is ground, and calling
           that a seafloor is wrong rather than merely odd. The map is
           global and the readout answers wherever it is asked, so land is
           an ordinary case, not an edge one. */
        const sea = value < 0;
        at.textContent = sea
          ? `${Math.round(-value).toLocaleString()} m deep`
          : `${Math.round(value).toLocaleString()} m above sea level`;
        const name = label();
        if (name) name.textContent = sea ? 'Seafloor' : 'Elevation';
      })
      .catch(() => {
        const at = cell();
        if (at) at.textContent = 'unavailable';
      });
  };

  /* Whose water this is. Marine Regions' gazetteer answers a point, and
     unlike their WMS GetFeatureInfo — which sends no CORS header and so
     cannot be read from a browser at all — the REST endpoint sends
     `access-control-allow-origin: *`.

     typeID=70 asks for the EEZ record alone: 603 bytes against 20 KB for
     the unfiltered gazetteer, which also returns Longhurst provinces, FAO
     fishing areas and twenty other classifications nobody asked for.

     A point on the high seas has no EEZ, and the service says so with a
     404 carrying an empty list. That is an answer, not a failure, and is
     reported as such — anything else would read as though the lookup
     broke over exactly the water where most of these platforms work. */
  const fillEez = (popup: L.Popup, ll: L.LatLng) => {
    // No row, no request. oceanRows only writes the row when the layer is on.
    if (!map.hasLayer(eez)) return;
    const cell = () => popup.getElement()?.querySelector('[data-eez]');
    const lon = ((((ll.lng + 180) % 360) + 360) % 360) - 180;
    const url =
      `https://marineregions.org/rest/getGazetteerRecordsByLatLong.json/` +
      `${ll.lat.toFixed(4)}/${lon.toFixed(4)}/?typeID=70`;

    fetch(url)
      .then((r) => (r.status === 404 ? [] : r.json()))
      .then((records) => {
        const at = cell();
        if (!at) return;
        const name = Array.isArray(records) && records.length
          ? String(records[0]?.preferredGazetteerName ?? '')
          : '';
        // "United States Exclusive Economic Zone (Puerto Rico)" is a
        // mouthful in a popup that is already five rows deep.
        at.textContent = name ? name.replace(/Exclusive Economic Zone/i, 'EEZ') : 'high seas';
      })
      .catch(() => {
        const at = cell();
        if (at) at.textContent = 'unavailable';
      });
  };

  const describePoint = (ll: L.LatLng) => {
    const popup = L.popup({ className: 'om-point-readout' })
      .setLatLng(ll)
      .setContent(`<strong>${coordText(ll)}</strong>` + oceanRows(ll))
      .openOn(map);
    fillDepth(popup, ll);
    fillEez(popup, ll);
  };

  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    if (measure.active) return;
    describePoint(e.latlng);
  });

  let pressTimer: number | undefined;
  let pressStart: { x: number; y: number } | null = null;
  const container = map.getContainer();
  container.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (measure.active || e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      pressStart = { x: touch.clientX, y: touch.clientY };
      pressTimer = window.setTimeout(() => {
        const point = map.mouseEventToLatLng({
          clientX: touch.clientX,
          clientY: touch.clientY,
        } as MouseEvent);
        describePoint(point);
      }, 550);
    },
    { passive: true }
  );
  const cancelPress = (e?: TouchEvent) => {
    // A drag is a pan, not a press.
    if (e && pressStart && e.touches.length === 1) {
      const touch = e.touches[0]!;
      if (Math.hypot(touch.clientX - pressStart.x, touch.clientY - pressStart.y) < 10) return;
    }
    window.clearTimeout(pressTimer);
    pressStart = null;
  };
  container.addEventListener('touchmove', cancelPress, { passive: true });
  container.addEventListener('touchend', () => cancelPress(), { passive: true });
  container.addEventListener('touchcancel', () => cancelPress(), { passive: true });

  // View toggle: the Atlantic basin vs everything currently reporting.
  const Views = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar om-view-toggle');
      for (const [label, title] of [
        ['Basin', 'Zoom to the Atlantic and Gulf'],
        ['Global', 'Zoom to every reporting asset'],
        ['Reset', 'Put everything back to defaults'],
      ]) {
        const a = L.DomUtil.create('a', '', bar);
        a.textContent = label;
        a.href = '#';
        a.title = title;
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.stop(e);
          if (label === 'Basin') map.fitBounds(BASIN);
          else if (label === 'Global') fitEverything();
          else resetEverything();
        });
      }
      return bar;
    },
  });
  map.addControl(new Views());

  /* Back to how the map arrives for someone who has never touched it:
     default basemap, default layers, default colour scales, automatic
     ranges, and the basin. The saved view is cleared as well — leaving it
     would mean the next reload restored exactly what was just reset, which
     is the sort of thing that reads as the button not working. */
  const resetEverything = () => {
    for (const [key, choice] of Object.entries(choices)) {
      choice.map = palette.defaultColormap?.[key] ?? Object.keys(COLORMAPS)[0]!;
      choice.range = null;
    }

    const wantedBase = 'Bathymetry (GEBCO)';
    for (const [name, layer] of Object.entries(bases)) {
      if (name === wantedBase && !map.hasLayer(layer)) map.addLayer(layer);
      if (name !== wantedBase && map.hasLayer(layer)) map.removeLayer(layer);
    }
    markBasemapTone(wantedBase);

    for (const [name, layer] of Object.entries(overlays)) {
      const wanted = DEFAULT_OVERLAYS.has(name);
      if (wanted && !map.hasLayer(layer)) map.addLayer(layer);
      if (!wanted && map.hasLayer(layer)) map.removeLayer(layer);
    }

    bathyOpacity = BATHY_OPACITY;
    applyBathyOpacity();

    // Back to automatic particle colours. markBasemapTone above already
    // re-resolved them, but against the reader's tints — clear those and
    // resolve again, or Reset would leave a chosen colour in place.
    particleTint.current = null;
    particleTint.wind = null;
    resolveParticleColours();

    particleSpeed.current = 1;
    particleSpeed.wind = 1;
    syncSpeedSliders();
    applyParticleSpeed();

    // Back to the hour nearest the reader's clock, which is where the map
    // opens — not to lead 0, which on a late run is not the same thing.
    if (forecast.frames.length) showLead(nearestFrame(forecast.frames).lead);

    measure.stop();
    map.closePopup();
    try {
      sessionStorage.removeItem(VIEW_KEY);
    } catch {
      // Private browsing refuses storage; nothing was saved to clear.
    }
    map.fitBounds(BASIN);
  };

  let allBounds: L.LatLngBounds | null = null;
  const fitEverything = () => {
    if (allBounds && allBounds.isValid()) map.fitBounds(allBounds.pad(0.1));
  };

  // ---- coastline (the offline basemap) and borders (overlay) ----
  const flip = (line: number[][]) => line.map(([x, y]) => [y, x] as [number, number]);

  /* Fetch a layer's data the first time it is switched on, once.

     `coastline.json` is 4.2 MB — eleven times what it was when it loaded
     with the page, which it can no longer afford to do for a basemap most
     readers never pick. The isobaths hold to the same rule for the same
     reason, and it is the reason the file could be rebuilt at a resolution
     worth having: what a reader pays is only what they asked to see. */
  const whenChosen = (layer: L.Layer, load: () => void) => {
    let asked = false;
    const once = () => {
      if (asked) return;
      asked = true;
      load();
    };
    if (map.hasLayer(layer)) once();
    /* Registered per event rather than as one space-separated string: the
       combined form falls through to Leaflet's generic overload, which types
       the argument as a bare LeafletEvent with no `layer` on it. */
    const chosen = (e: L.LayersControlEvent) => {
      if (e.layer === layer) once();
    };
    map.on('baselayerchange', chosen);
    map.on('overlayadd', chosen);
  };

  whenChosen(coastline, () => {
    fetch(`${DATA}coastline.json`)
      .then((r) => r.json())
      .then(({ rings }) => {
        /* One polygon per ring, as before. 7,720 of them is well inside what
           SVG carries — the isobaths draw 235,000 points across ten paths —
           and they are what the theme restyles, so no canvas here. */
        const style = { weight: 0.8, className: 'map-land' };
        for (const ring of rings as number[][][]) L.polygon(flip(ring), style).addTo(coastline);
      })
      .catch(() => {});
  });

  fetch(`${DATA}boundaries.json`)
    .then((r) => r.json())
    .then(({ countries, states }) => {
      for (const line of states as number[][][]) {
        L.polyline(flip(line), { weight: 0.6, dashArray: '3,3', className: 'map-border-state' }).addTo(borders);
      }
      for (const line of countries as number[][][]) {
        L.polyline(flip(line), { weight: 1, className: 'map-border-country' }).addTo(borders);
      }
    })
    .catch(() => {});

  /* The site rebuilds every hour with new storm positions and asset fixes.
     A reader who leaves the page open would otherwise sit on a stale map,
     and the storm status line above it is baked in at build time, so only
     a real reload refreshes that.

     Reloading on a timer alone would be rude — it would interrupt someone
     mid-pan or mid-read. So the reload waits for a moment when it costs
     nothing: the tab hidden, or a couple of minutes without input. The
     view is saved first, so they come back to the same map. */
  const scheduleRefresh = (loadedStamp?: string) => {
    const CHECK_EVERY = 60 * 60 * 1000;
    const SETTLE_EVERY = 30 * 1000;
    const IDLE_ENOUGH = 2 * 60 * 1000;

    let newerAvailable = false;
    let lastInput = Date.now();
    const touched = () => {
      lastInput = Date.now();
    };
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(event, touched, { passive: true });
    }

    const reloadIfUnobtrusive = () => {
      if (!newerAvailable) return;
      const idle = Date.now() - lastInput > IDLE_ENOUGH;
      if (document.visibilityState !== 'hidden' && !idle) return;
      saveView();
      location.reload();
    };

    const lookForNewer = async () => {
      try {
        const url = `${DATA}ocean-assets.json?_=${Date.now()}`;
        const fresh = await (await fetch(url, { cache: 'no-store' })).json();
        if (fresh?.updated && fresh.updated !== loadedStamp) {
          newerAvailable = true;
          /* Update the storm line now rather than at reload time. It is a
             line of text, so replacing it interrupts nobody, and it is the
             part a reader is most likely to be relying on. The map's own
             markers catch up when the reload happens. */
          renderStormStatus(fresh.storms ?? []);
          rewire?.();
        }
      } catch {
        // Offline or mid-deploy; just try again on the next tick.
      }
      reloadIfUnobtrusive();
    };

    window.setInterval(lookForNewer, CHECK_EVERY);
    // Once something new is waiting, take the first quiet moment rather
    // than sitting on it for another hour.
    window.setInterval(reloadIfUnobtrusive, SETTLE_EVERY);
    document.addEventListener('visibilitychange', reloadIfUnobtrusive);
  };

  /* Rebuilds the storm line in place. Mirrors StormStatus.astro's markup
     exactly — same classes, same order — because the stylesheet is written
     against that structure and this replaces it wholesale. */
  let rewire: (() => void) | null = null;

  const renderStormStatus = (raw: unknown[]) => {
    const box = stormStatusBoxes()[0];
    if (!box) return;
    const lines = stormLines(raw as Parameters<typeof stormLines>[0]);

    box.textContent = '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = stormLabel(lines.length);
    box.append(label);

    if (!lines.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = NO_STORMS;
      box.append(none);
      return;
    }

    const list = document.createElement('ul');
    for (const line of lines) {
      const item = document.createElement('li');

      let name: HTMLElement;
      if (line.url) {
        const link = document.createElement('a');
        link.href = line.url;
        /* Same treatment as the popup links: the advisory is another site,
           and a reader sent there loses the map. Kept in step with the
           build-time markup in StormStatus.astro — this line exists twice
           on purpose, and the two silently diverging is the failure that
           arrangement is meant to avoid. */
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${line.name} advisory (opens in a new tab)`);
        name = link;
      } else {
        name = document.createElement('strong');
      }
      name.textContent = line.name;

      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'zoom';
      if (line.id) zoom.dataset.stormZoom = line.id;
      zoom.title = `Zoom the map to ${line.name}`;
      zoom.setAttribute('aria-label', zoom.title);
      zoom.hidden = true;
      zoom.textContent = '🔍';

      const facts = document.createElement('span');
      facts.className = 'facts';
      facts.textContent = line.facts.join(' · ');

      item.append(name, zoom, facts);
      list.append(item);
    }
    box.append(list);
  };

  /* The asset feed and the Argo fleet arrive separately, so the status
     line is assembled from whichever parts have landed rather than
     written once by whoever finishes last. */
  const statusParts: Record<string, string> = {};

  /* **Each fact is shown only while a layer it describes is on**, the same
     rule the legend keys and the particle controls follow. A count of
     something the reader cannot see is worse than no count: "63 assets
     reporting" beside a map with no platforms on it reads as the map having
     lost them.

     `assets` covers gliders *and* saildrones, so it survives while either is
     on — the number is their sum and dropping it when only one is off would
     understate what is drawn. `updated` has no layer: it is about the fetch
     rather than about anything on the map, so it always shows. */
  const STATUS_LAYERS: Record<string, string[]> = {
    storms: ['Hurricanes'],
    assets: ['Ocean gliders', 'NOAA USVs'],
    argo: ['Argo floats'],
  };

  const showStatus = () => {
    if (!status) return;
    const order = ['storms', 'assets', 'argo', 'updated'];
    const line = order
      .filter((k) => {
        const names = STATUS_LAYERS[k];
        if (!names) return true;                  // `updated` — not about a layer
        /* A layer the host's preset never registered cannot be switched on,
           so its fact stays hidden rather than showing permanently. */
        return names.some((name) => overlays[name] && map.hasLayer(overlays[name]!));
      })
      .map((k) => statusParts[k])
      .filter(Boolean)
      .join(' · ');
    /* Assigned even when empty, unlike before: the parts are filled in
       asynchronously and the old guard existed to avoid blanking the line
       before the data landed. It now also has to be able to *clear* the
       line when every layer behind it goes off, so the guard moved to the
       thing it was actually protecting — whether anything has arrived. */
    if (line || Object.keys(statusParts).length) status.textContent = line;
  };

  /* Redrawn when a layer is toggled, not only when data arrives — the counts
     were written once and never revisited, which is exactly why they went on
     naming platforms that had been switched off. */
  map.on('overlayadd overlayremove', showStatus);
  chromeSyncs.push(showStatus);

  const rad = Math.PI / 180;

  /* Great-circle initial bearing. A rhumb line would be the one to steer,
     but the distance beside it is great-circle, and quoting the two from
     different geometries invites the reader to combine them. */




  /* The surface current under a point, read out of whichever grid is
     loaded — no request, and it is the same field the particles follow. */
  /* Temperature at a point, from the grid already loaded — no request, and
     it is the same field being painted. */
  /** Every scalar under a point, not the first — ice draws over temperature
      so two can be on, and naming one of them would drop the other silently
      and pick which by layer build order. */
  const scalarsAt = (ll: L.LatLng) =>
    ssts.filter((f) => map.hasLayer(f.group)).map((f) => sstAtLayer(ll, f)).filter(Boolean);

  const sstAtLayer = (ll: L.LatLng, shown: { layer: ScalarLayer }) => {
    const grid = shown?.layer?.getGrid?.();
    const h = grid?.header;
    if (!h) return null;
    const field = shown?.layer?.options?.field;
    // Modulo, not a bounds check: a full-globe grid wraps, and rounding at
    // the seam lands on nx, which a bare bounds test would reject.
    const i = Math.round(((((ll.lng - h.lo1) % 360) + 360) % 360) / h.dx) % h.nx;
    const j = Math.round((h.la1 - ll.lat) / h.dy);
    if (i < 0 || j < 0 || j >= h.ny) return null;
    const v = grid.data[j * h.nx + i];
    if (typeof v !== 'number') return null;
    /* **The unit comes from the field, not from a guess at the data.** This
       read `h.units === 'psu' ? 'psu' : '°C'`, which is a two-way guess in a
       place that now has three answers: ice publishes `fraction`, fell into
       the else, and the readout reported a concentration of 0.9 as "0.9 °C".
       `FIELDS` already states the unit and whether to show it as a
       percentage — the same descriptor the colour bar reads — so there is
       nothing to infer.

       Formatted here rather than by the caller, because the caller cannot
       know that a fraction is shown times a hundred without asking the same
       descriptor again. */
    const text = field?.percent
      ? `${Math.round(v * 100)} ${field.unit ?? '%'}`
      : `${v.toFixed(1)} ${field?.unit ?? ''}`.trim();
    return { text, label: field?.label ?? 'Sea surface' };
  };

  /* **Every** animated field that is on, not the first one found.

     Wind and current can now be shown together, so a readout naming one of
     them would silently drop the other — and which one it dropped would
     depend on the order this array happens to be built in. One reading per
     layer, in that array's order. */
  /* Stated rather than inferred: the "no value here" branch carries nulls
     and the real one carries numbers, and left to itself TypeScript widens
     the pair to `unknown` rather than to their union. */
  type FlowReading = {
    label: string;
    reads: FlowKind['reads'];
    speed: number | null;
    bearing: number | null;
  };

  const flowsAt = (ll: L.LatLng): FlowReading[] =>
    flows.flatMap<FlowReading>((entry) => {
      /* A row for every layer that is **on**, whether or not there is a
         value under the pointer — the two are different answers and the
         reader can only tell them apart if the map says so. "Current at
         surface — no data here" means this cell is land or outside the
         grid; no row at all means the layer is off. Collapsing them lost
         that, and the harness did not notice because the one check on it
         was matching the words "no data here" and nothing else. */
      if (!map.hasLayer(entry.group)) return [];
      const reads = entry.kind.reads;
      const grid = (entry.layer as unknown as { options?: { data?: VectorGrid } })
        ?.options?.data;
      const head = grid?.[0]?.header;
      const label = reads === 'from'
        ? `Wind at ${head?.height ?? 10} m`
        : `Current at ${head?.depth ? `${head.depth} m` : 'surface'}`;
      const blank: FlowReading[] = [{ label, reads, speed: null, bearing: null }];
      if (!head) return blank;
      const i = Math.round(((((ll.lng - head.lo1) % 360) + 360) % 360) / head.dx);
      const j = Math.round((head.la1 - ll.lat) / head.dy);
      if (i < 0 || i >= head.nx || j < 0 || j >= head.ny) return blank;
      const k = j * head.nx + i;
      const u = grid[0].data[k];
      const v = grid[1].data[k];
      if (typeof u !== 'number' || typeof v !== 'number') return blank;
      const toward = (Math.atan2(u, v) / rad + 360) % 360;
      return [{
        label,
        reads,
        speed: Math.hypot(u, v),
        // Meteorological convention for wind, oceanographic for current — see
        // FlowKind.reads. The bearing itself is the same measurement; which
        // end of it gets reported is the whole difference.
        bearing: reads === 'from' ? (toward + 180) % 360 : toward,
      }];
    });

  // The current alone, for callers that want one number rather than a list.
  const currentAt = (ll: L.LatLng) =>
    flowsAt(ll).find((r) => r.reads === 'toward' && r.speed !== null) ?? null;


  // ---- storms and assets ----
  try {
    const data = await (await fetch(`${DATA}ocean-assets.json`)).json();
    const pts: [number, number][] = [];
    // Where each storm sits, for the zoom buttons in the status line above.
    const stormAt = new Map<string, [number, number]>();

    for (const s of data.storms ?? []) {
      if (s.cone?.length) {
        showDetail(
          L.polygon(flip(s.cone), {
            color: STORM,
            weight: 1,
            fillColor: STORM,
            fillOpacity: 0.12,
          }).addTo(storms),
          `<strong>${s.name}</strong><br>Forecast cone`
        );
      }
      if (s.track?.length) {
        L.polyline(flip(s.track), {
          color: STORM,
          weight: 2,
          dashArray: '5,4',
        }).addTo(storms);
      }
      /* Observed track, drawn solid against the dashed forecast: solid is
         where it has been, dashed is where it is going. Same casing as the
         glider and USV tracks, so all three read as one kind of thing. */
      if (s.history?.length > 1) {
        const past = flip(s.history);
        L.polyline(past, {
          weight: 4.5,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'map-casing',
        }).addTo(storms);
        const trackLine = L.polyline(past, {
          color: STORM,
          weight: 2.5,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(storms);
        showDetail(
          trackLine,
          `<strong>${s.name}</strong><br>Observed track, last ${data.historyDays} days`
        );
      }
      if (typeof s.lat === 'number' && typeof s.lon === 'number') {
        pts.push([s.lat, s.lon]);
        stormAt.set(s.id, [s.lat, s.lon]);
        const stormPopup =
          `<strong>${s.name}</strong> (${s.classification ?? ''})<br>` +
          `${s.intensityKt ?? '?'} kt · ${s.pressureMb ?? '?'} mb<br>` +
          `Moving ${s.movementDir ?? '?'}° at ${s.movementSpeedKt ?? '?'} kt<br>` +
          (s.advisoryUrl ? outbound(s.advisoryUrl, 'NHC advisory') : '');

        tapTarget([s.lat, s.lon], stormPopup, storms, { label: s.name });
        showDetail(
          L.circleMarker([s.lat, s.lon], {
            radius: 8,
            color: STORM,
            weight: 2,
            fillColor: STORM,
            fillOpacity: 0.55,
          }).addTo(storms),
          stormPopup,
          { ocean: true, label: s.name }
        );
      }
    }

    /* The status line above the map is rendered at build time, so between
       hourly builds it can fall behind the data — and the auto-reload
       waits for the reader to be idle, which an engaged reader never is.
       So it is rebuilt here from whatever was just fetched, through the
       same formatter the build uses. */
    renderStormStatus(data.storms ?? []);

    /* Each storm gets a zoom button. They ship hidden and are revealed
       only here, so one never sits on the page as a dead control when the
       map or the data fails to load. Re-run after every re-render, since
       rebuilding the list throws the old buttons and their handlers away. */
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wireZoomButtons = () => {
      /* Scoped to the status box, not to the map's figure and not to the
         document. The buttons belong to the status line, and the status
         line is rendered by a sibling component that may sit either inside
         or outside the figure — so anchoring to the box is the only place
         that is right in both arrangements. Scoping to the figure looked
         equivalent and was not: it found a stand-in button inside the
         caption and then never reached the real ones the box had just been
         rebuilt with. */
      const zoomButtons = stormStatusBoxes().flatMap((b) => [
        ...b.querySelectorAll<HTMLButtonElement>('[data-storm-zoom]'),
      ]);
      for (const button of zoomButtons) {
        const at = stormAt.get(button.dataset.stormZoom ?? '');
        if (!at) continue;
        button.hidden = false;
        button.addEventListener('click', () => {
          // Never zoom out from wherever the reader has already got to.
          const zoom = Math.max(map.getZoom(), 5);
          if (!map.hasLayer(storms)) map.addLayer(storms);
          host.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
          if (reduce) map.setView(at, zoom);
          else map.flyTo(at, zoom);
        });
      }
    };
    wireZoomButtons();
    rewire = wireZoomButtons;

    for (const a of data.assets ?? []) {
      const isUsv = a.kind === 'usv';
      const layer = isUsv ? usvs : gliders;
      const tint = isUsv ? USV : GLIDER;
      pts.push([a.lat, a.lon]);

      // Where it has been over the active window, then where it is now.
      // The track is drawn twice: a dark casing underneath so the line
      // stays legible over pale Esri Ocean and dark GEBCO alike, then the
      // colour on top.
      if (a.track?.length > 1) {
        const path = flip(a.track);
        L.polyline(path, {
          weight: 4.5,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'map-casing',
        }).addTo(layer);
        showDetail(
          L.polyline(path, {
            color: tint,
            weight: 2.5,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(layer),
          `<strong>${a.id}</strong><br>Track, last ${data.historyDays} days`
        );
      }
      const assetPopup =
        `<strong>${a.id}</strong>` +
        // many DAC datasets title themselves with their own id
        (a.title && a.title !== a.id ? `<br>${a.title}` : '') +
        (a.institution ? `<br><span class="muted">${a.institution}</span>` : '') +
        `<dl>` +
        (a.deployed
          ? `<dt>Deployed</dt><dd>${stamp(a.deployed)}${elapsed(a.deployed, a.time)}</dd>`
          : '') +
        `<dt>Last fix</dt><dd>${stamp(a.time)}</dd>` +
        `<dt>Position</dt><dd>${coordText(a.lat, a.lon)}</dd>` +
        `</dl>` +
        outbound(a.info, 'ERDDAP dataset');

      tapTarget([a.lat, a.lon], assetPopup, layer, { label: a.id });
      showDetail(
        L.circleMarker([a.lat, a.lon], {
          radius: isUsv ? 6 : 4.5,
          weight: 1.2,
          className: 'map-asset',
          fillColor: tint,
          fillOpacity: 0.95,
        }).addTo(layer),
        assetPopup,
        { ocean: true, label: a.id }
      );
    }

    if (pts.length) allBounds = L.latLngBounds(pts);

    const n = (data.assets ?? []).length;
    const s = (data.storms ?? []).length;
    if (status) {
      // Start watching for the next hourly rebuild.
      scheduleRefresh(data.updated);
      const when = (data.updated ?? '').slice(0, 16).replace('T', ' ');
      statusParts.storms = `${s} active storm${s === 1 ? '' : 's'}`;
      statusParts.assets = `${n} assets reporting within ${data.historyDays} days`;
      statusParts.updated = `updated ${when}Z`;
      showStatus();
    }
  } catch {
    if (status) status.textContent = 'Asset data unavailable.';
  }
}
