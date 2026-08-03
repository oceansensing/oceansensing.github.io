import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
/* The map's own styling travels with it. Every rule keys off the `ocean-map`
   class applied below rather than an id, so a page can carry more than one. */
import './ocean-map.css';
/* The renderer-independent half. Nothing imported here touches Leaflet or the
   DOM, which is deliberate: these are the parts a native port keeps. */
import { coordText, elapsed, initialBearing, spanText, stamp } from './geo';
import { rampColour, rampStops } from './ramp';
import { tileKeysFor } from './tiles';
import { readKmz, summarise, type KmzDocument, type KmzFeature, type KmzOverlay } from './kmz';
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
    minZoom: 2,
    attributionControl: true,
  });

  map.attributionControl.setPrefix('');

  /* Leaflet keeps no route from the element back to the map, so hang it
     here: the headless harness in scripts/test-map.mjs reads it, and it
     makes the map pokeable from the console. Nothing on the page uses it. */
  (host as HTMLElement & { _map?: L.Map })._map = map;

  /* Bathymetry is the default, since the point of the map is where the
     platforms sit relative to the ocean floor. GEBCO leads; Esri's ocean
     basemap is the lighter alternative. Either means tile requests off
     site — the coastline layer below is the offline, no-tracking option,
     drawn from a file shipped with the site. */
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

  /* One group per temperature field, and the same rule as the two animated
     current fields: only one at a time. Two rasters cannot be stacked —
     the upper one simply hides the lower — so offering both at once would
     show one field while naming two. */
  const sstOisst = L.layerGroup();
  const sstNavy = L.layerGroup();
  const sssNavy = L.layerGroup();
  const ssts: { group: L.LayerGroup; layer: ScalarLayer }[] = [];
  /* Both animated fields, so the point readout can sample whichever one
     the reader has on rather than a fixed depth. */
  const flows: { group: L.LayerGroup; layer: L.Layer | null }[] = [];

  /* leaflet-velocity is a UMD plugin: it reaches for Leaflet on the
     global object, which the bundled ESM build never sets. A static
     import is hoisted above any assignment, so the global has to be put
     in place first and the plugin pulled in dynamically after. Without
     this the built bundle dies on "L is not defined" — the dev server
     hides it by serving Leaflet's UMD build, which does set the global. */
  /* Pixels a 1 m/s current should carry a particle each frame. Currents run
     an order of magnitude slower than wind, so the plugin's wind-tuned
     default leaves them at a fifth of a pixel — invisible. */
  const DRIFT = 3.0;

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
  const PARTICLE_SECONDS = 4;
  const FRAME_RATE = 18;

  /* The plugin turns a velocity into a screen displacement by multiplying
     it by the reader's velocityScale, then by mapArea^0.4, then by the
     projection's own Jacobian — pixels per degree, which doubles with
     every zoom level. Both of the last two have to be divided back out to
     get a drift that depends on the current rather than the viewport.

     Cancelling only mapArea^0.4 is worse than cancelling nothing: that
     term is the plugin's own rough compensation for zoom, so removing it
     leaves the Jacobian bare and particles accelerate as you zoom in —
     measured at 0.08 px/frame at zoom 3 against 10.7 at zoom 9, which is
     most of the way across the map every second. The Jacobian is measured
     off the map rather than assumed, so this holds for any projection.

     Measured with project(), and that part is not incidental.
     latLngToContainerPoint() rounds to whole pixels, and below zoom 7 a
     tenth of a degree of longitude is a fraction of one — 0.28 px at zoom
     2 — so the difference between the two probes collapsed to zero, the
     Jacobian fell to its floor, and velocityScale came out around 200x
     too high. Particles then crossed the whole map between frames and the
     field rendered as nothing at all: the globe view had no currents on
     it. project() returns fractional pixel coordinates, which is the
     quantity the plugin actually distorts by. */
  const scaleForView = () => {
    const rad = Math.PI / 180;
    const bounds = map.getBounds();
    const area = Math.abs(
      (bounds.getSouth() - bounds.getNorth()) * rad * (bounds.getWest() - bounds.getEast()) * rad
    );

    const centre = map.getCenter();
    const step = 0.1;
    const zoom = map.getZoom();
    const here = map.project(centre, zoom);
    const east = map.project(L.latLng(centre.lat, centre.lng + step), zoom);
    const pxPerDegree = Math.hypot(east.x - here.x, east.y - here.y) / step;
    // The plugin divides the eastward derivative by cos(lat); match it.
    const jacobian = Math.max(pxPerDegree / Math.cos(centre.lat * rad), 1e-6);

    return DRIFT / (Math.pow(Math.max(area, 1e-6), 0.4) * jacobian);
  };

  const loadPlugin = async () => {
    // globalThis rather than window: it is window in a browser and works
    // in the headless harness too, where the two are different objects.
    (globalThis as unknown as { L: typeof L }).L = L;
    await import('leaflet-velocity');
  };

  /* Everything below is per depth: fetch that depth's global grid, build
     its particle layer, then keep swapping in the finest grid covering the
     view. Both depths run this same code. Each global file names its own
     regions and tiles, so the chain of links cannot cross between depths
     and leave 60 m particles drifting over a surface grid. */
  const buildFlow = (url: string, group: L.LayerGroup) => {
    const entry: { group: L.LayerGroup; layer: L.Layer | null } = { group, layer: null };
    flows.push(entry);
    Promise.all([fetch(url).then((r) => r.json()), loadPlugin()])
    .then(([coarse]) => {
      // Name the run in the attribution: ESPC publishes once a day at 12Z,
      // so this is how a reader can tell how fresh the field actually is.
      const run = coarse?.[0]?.header?.modelRun?.slice(0, 16).replace('T', ' ');
      // Depth comes from the data, not the filename this happened to fetch.
      const metres = coarse?.[0]?.header?.depth ?? 0;
      const flowReady = L.velocityLayer({
        data: coarse,
        attribution:
          `Currents: US Navy ESPC-D-V02 at ${metres ? `${metres} m` : 'the surface'}` +
          (run ? ` — ${run}Z run` : ''),
        paneName: 'currents',
        displayValues: false,
        velocityScale: scaleForView(),
        minVelocity: 0,
        maxVelocity: 1.5,
        colorScale: palette.currents,
        /* Denser and thicker than the plugin's wind defaults: ocean
           particles move slowly, so they need weight to register.

           The multiplier is one particle per this many square pixels of
           map, and the count is linear in it — so 1/112 is a quarter more
           than the 1/140 it replaced. It pairs with the shorter lifetime
           above: cutting the trails shortens what each particle
           contributes, and more of them puts the density back without
           going back to long ropes. */
        particleAge: Math.round(PARTICLE_SECONDS * FRAME_RATE),
        particleMultiplier: 1 / 112,
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
      const details = [...(coarse?.[0]?.header?.details ?? [])].sort(
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
            velocityScale: scaleForView(),
          });
          return;
        }

        // Rescale on zoom so the drift stays put as the viewport changes.
        if (zoomChanged) layer.setOptions?.({ velocityScale: scaleForView() });
      };

      map.on('zoomend', () => applyView(true));
      map.on('moveend', () => applyView(false));
      applyView(false);
    })
    .catch(() => {
      // No field: the switcher still lists the layer, it is simply empty,
      // and the Mercator raster is there as the fallback depiction.
    });
  };

  buildFlow(`${DATA}currents.json`, flow);
  buildFlow(`${DATA}currents-60m.json`, flowDeep);

  /* ---- sea-surface temperature ---------------------------------------

     Drawn here rather than fetched as a picture from a WMS, because there
     is no WMS to fetch it from: the Navy's own does not answer, nor does
     the usual ERDDAP, and NCEI's replies "not accessible via WMS". Both
     fields therefore come through scripts/fetch-sst.py as numeric grids,
     in the same three tiers as the currents, and are painted below. That
     also means the readout can report a temperature from the grid already
     loaded, with no request. */

  const COLORMAPS: Record<string, number[][]> = Object.fromEntries(
    Object.entries(palette.colormaps ?? {}).map(([name, hexes]) => [
      name,
      rampStops(hexes as string[]),
    ])
  );

  /* One entry per scalar field the map can paint. Temperature and salinity
     are the same kind of thing — a value per cell, drawn as a raster — so
     they share the layer, the tier machinery and the readout, and differ
     only in what is listed here. */
  const FIELDS: Record<string, FieldDescriptor> = {
    // "Sea surface" alone stopped being unambiguous the moment a second
    // surface field existed.
    sst: { key: 'sst', unit: '°C', step: 1, label: 'Sea surface temp' },
    /* Salinity gets a half-unit step where temperature gets a whole one.
       Both round outward to bound the water in view, but open ocean spans
       maybe 34–37 psu against 10 °C or more of temperature — rounding
       salinity to whole units would leave a typical view occupying a
       quarter of the ramp and looking flat. */
    /* And its automatic range is held to oceanic values. Salinity is the
       one field here whose extremes are not ocean at all: river plumes and
       estuaries run to single figures — this model reaches 3 psu in
       Chesapeake Bay — so one bay in the corner of a view stretched the
       ramp across water nobody was looking at and flattened the 34-37 psu
       where the fronts actually are. Clamping the *automatic* bounds to
       29-39 spends the ramp on seawater; fresher water simply pins to the
       bottom stop, which is the honest thing for it to do on a scale
       labelled in psu. A range the reader pins by hand is untouched — this
       bounds what "Auto" chooses, not what they are allowed to ask for. */
    sss: { key: 'sss', unit: 'psu', step: 0.5, label: 'Salinity', autoClamp: [29, 39] },
  };

  /* What the reader has chosen, per field rather than per layer: the two
     SST layers are the same quantity from different models, so a colour
     scale set on one should hold when switching to the other. `range: null`
     means auto — bounded by the water in view and recomputed on every move.
     */
  type FieldChoice = { map: string; range: [number, number] | null };
  const choices: Record<string, FieldChoice> = {
    sst: { map: palette.defaultColormap?.sst ?? 'thermal', range: null },
    sss: { map: palette.defaultColormap?.sss ?? 'haline', range: null },
  };
  /* What a scalar layer needs to know about the quantity it is painting.
     `FIELDS` below is the whole set; a new scalar is an entry there and one in
     the pipeline's PRODUCTS, not another layer. */
  interface FieldDescriptor {
    key: string;
    unit: string;
    /** The colour bar rounds outward to this. */
    step: number;
    label: string;
    /** Bounds the *automatic* range, where the extremes are not ocean — see
        the salinity note in FIELDS. A pinned range ignores it. */
    autoClamp?: [number, number];
  }

  const choiceFor = (field?: FieldDescriptor) => choices[field?.key ?? 'sst']!;
  const stopsFor = (field?: FieldDescriptor) =>
    COLORMAPS[choiceFor(field).map] ?? Object.values(COLORMAPS)[0]!;

  /* Interpolated between stops rather than stepped: a field of flat bands
     reads as contours the data does not have. */

  /* The published shape, from schema.ts — the same declaration
     scripts/test-schema.mjs holds the files to. */
  type Scalar = ScalarGrid;

  /* What L.Layer.extend gives back. Leaflet's typings stop at the base class,
     so the members added below have to be declared for callers to see them —
     without this every use site reached for `any` and the layer's own API was
     invisible. */
  interface ScalarLayer extends L.Layer {
    options: L.LayerOptions & { field: FieldDescriptor };
    _grid: Scalar | null;
    _canvas: HTMLCanvasElement | null;
    _range: [number, number] | null;
    setGrid(grid: Scalar): ScalarLayer;
    getGrid(): Scalar | null;
    getRange(): [number, number] | null;
    _rangeFor(sampled: number[]): [number, number] | null;
    _render(): void;
  }

  const SstLayer = L.Layer.extend({
    /* Leaflet's Class only passes constructor arguments through when the
       class defines initialize — without this the field descriptor is
       silently dropped and the layer paints with no ramp. */
    initialize(this: ScalarLayer, options: { field: FieldDescriptor }) {
      L.setOptions(this, options);
    },
    onAdd(this: ScalarLayer, map: L.Map) {
      this._canvas = L.DomUtil.create('canvas', 'leaflet-layer map-sst');
      map.getPane('sst')!.appendChild(this._canvas);
      map.on('moveend zoomend resize viewreset', this._render, this);
      this._render();
    },
    onRemove(this: ScalarLayer, map: L.Map) {
      map.off('moveend zoomend resize viewreset', this._render, this);
      this._canvas?.remove();
      this._canvas = null;
    },
    setGrid(this: ScalarLayer, grid: Scalar) {
      this._grid = grid;
      this._render();
      return this;
    },
    getGrid(this: ScalarLayer) {
      return this._grid ?? null;
    },
    getRange(this: ScalarLayer) {
      return this._range ?? null;
    },
    /* The range the ramp is stretched over: the whole-degree bounds of the
       water actually in view, not a fixed global scale.

       A fixed scale wastes almost all of the ramp — a basin spans maybe
       ten degrees out of the thirty-odd the ocean covers, so everything on
       screen came out within a couple of shades of itself. Rescaling per
       view spends the entire ramp on the water you are looking at, which
       is what makes a front visible. The cost is that colour no longer
       means the same temperature between two views, which is why the
       legend prints the bounds rather than a fixed key. */
    _rangeFor(this: ScalarLayer, sampled: number[]) {
      if (!sampled.length) return null;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of sampled) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const step = this.options.field?.step ?? 1;
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
      /* Some fields have automatic bounds worth holding to a sensible
         window — see the salinity note in FIELDS. Applied after rounding
         so the clamp lands exactly on the stated numbers. */
      const clamp = this.options.field?.autoClamp;
      if (clamp) {
        lo = Math.max(lo, clamp[0]);
        hi = Math.min(hi, clamp[1]);
        // A view entirely outside the window (an estuary, say) would leave
        // an inverted range; collapse it to the nearest edge instead.
        if (hi <= lo) {
          lo = Math.min(Math.max(lo, clamp[0]), clamp[1] - step);
          hi = lo + step;
        }
      }
      // A view of uniform water would otherwise divide by zero and paint
      // one flat colour; one step of headroom keeps it a gradient.
      if (hi <= lo) hi = lo + step;
      return [lo, hi] as [number, number];
    },
    _render(this: ScalarLayer) {
      const map: L.Map = this._map;
      const cv: HTMLCanvasElement | null = this._canvas;
      if (!map || !cv) return;

      const size = map.getSize();
      if (cv.width !== size.x || cv.height !== size.y) {
        cv.width = size.x;
        cv.height = size.y;
      }
      // Pin the canvas to the map pane's origin so it travels with a drag.
      L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));

      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const grid: Scalar | null = this._grid;
      if (!grid?.header) return;

      const h = grid.header;
      const w = cv.width;
      const ht = cv.height;

      /* Web Mercator is separable — longitude depends only on the column,
         latitude only on the row — so the projection is inverted once per
         column and once per row rather than once per pixel: about 1,700
         calls instead of 650,000. containerPointToLatLng is used rather
         than any assumed formula, and unlike latLngToContainerPoint it
         does not round, which is what made the particle scaling wrong. */
      /* Cell coordinates, kept fractional: the coarsest tier is a degree
         across, which at low zoom is tens of pixels, and nearest-neighbour
         there paints the ocean as a chessboard of squares that look like
         structure in the data rather than the sampling. */
      /* A grid whose columns span the full globe has no edge: the cell
         after the last one is the first. Clamping there instead leaves a
         one-cell column at the seam that nothing paints, and the dark
         basemap shows through it as a line down the map — visible at the
         prime meridian, because that is where these grids start. The
         Arctic band wraps too (720 x 0.5°). */
      const wraps = Math.abs(h.nx * h.dx - 360) < h.dx;
      const cols = new Float64Array(w);
      for (let x = 0; x < w; x++) {
        const lng = map.containerPointToLatLng([x + 0.5, 0]).lng;
        const u = ((((lng - h.lo1) % 360) + 360) % 360) / h.dx;
        if (wraps) cols[x] = u % h.nx;
        else cols[x] = u >= 0 && u <= h.nx - 1 ? u : -1;
      }

      /* Bilinear, in two steps, because the coast needs both things at
         once: land must not be painted, and the water beside it must not
         go blocky.

         First the nearest cell decides whether this pixel is water at all,
         which keeps the shoreline exactly where the data puts it and stops
         a sea temperature bleeding inland. Then the value is averaged over
         whichever of the four neighbours are water, with their bilinear
         weights renormalised. Simply refusing to interpolate next to land
         was the first attempt and it showed: the open ocean came out
         smooth while the entire continental shelf — where a storm is
         actually read — stayed a grid of squares. */
      const sample = (u: number, v: number) => {
        const i0 = Math.floor(u) % h.nx;
        const j0 = Math.floor(v);
        const fi = u - Math.floor(u);
        const fj = v - j0;
        // Round the world rather than stopping at the last column.
        const i1 = wraps ? (i0 + 1) % h.nx : Math.min(i0 + 1, h.nx - 1);
        const j1 = Math.min(j0 + 1, h.ny - 1);

        const near = (fj < 0.5 ? j0 : j1) * h.nx + (fi < 0.5 ? i0 : i1);
        if (typeof grid.data[near] !== 'number') return null;

        let sum = 0;
        let weight = 0;
        const corners: [number, number, number][] = [
          [i0, j0, (1 - fi) * (1 - fj)],
          [i1, j0, fi * (1 - fj)],
          [i0, j1, (1 - fi) * fj],
          [i1, j1, fi * fj],
        ];
        for (const [i, j, wgt] of corners) {
          const value = grid.data[j * h.nx + i];
          if (typeof value === 'number') {
            sum += value * wgt;
            weight += wgt;
          }
        }
        return weight > 0 ? sum / weight : null;
      };

      /* Latitudes are wanted twice — once to find the range, once to
         paint — so invert the projection for them once and keep them. */
      const rowV = new Float64Array(ht);
      for (let y = 0; y < ht; y++) {
        rowV[y] = (h.la1 - map.containerPointToLatLng([0, y + 0.5]).lat) / h.dy;
      }

      /* First pass, on a coarse stride: the range only needs the extremes,
         and sampling every sixteenth pixel finds them just as well as
         sampling all 650,000 while costing a fraction of the work. */
      const seen: number[] = [];
      for (let y = 0; y < ht; y += 4) {
        if (rowV[y]! < 0 || rowV[y]! > h.ny - 1) continue;
        for (let x = 0; x < w; x += 4) {
          const u = cols[x]!;
          if (u < 0) continue;
          const v = sample(u, rowV[y]!);
          if (v !== null) seen.push(v);
        }
      }
      // A range the reader has pinned wins over the view.
      const range = choiceFor(this.options.field).range ?? this._rangeFor(seen);
      this._range = range;
      this.fire('rangechange');
      if (!range) return;
      const [lo, hi] = range;

      const img = ctx.createImageData(w, ht);
      const out = img.data;
      for (let y = 0; y < ht; y++) {
        const vRow = rowV[y]!;
        if (vRow < 0 || vRow > h.ny - 1) continue;
        for (let x = 0; x < w; x++) {
          const u = cols[x]!;
          if (u < 0) continue;
          const v = sample(u, vRow);
          if (v === null) continue;              // land, ice, or no data
          const rgb = rampColour(stopsFor(this.options.field), v, lo, hi);
          const k = (y * w + x) * 4;
          out[k] = rgb[0]!;
          out[k + 1] = rgb[1]!;
          out[k + 2] = rgb[2]!;
          /* Fully opaque, and that is load-bearing: the contrast gate
             checks the markers against these exact ramp colours. Blending
             the ramp with the bathymetry underneath would put a different
             colour on screen than the one that was gated. */
          out[k + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });

  /* The tier chain, per field. Same shape as the currents': the global
     file names its own regions and tiles, the finest that covers the view
     wins, and tiles are chosen by overlap and joined.

     This repeats logic that buildFlow above also has. The two formats
     differ — velocity grids are a pair of components, this is one — and
     unifying them is the obvious next step; noted here rather than left
     for someone to discover. */
  const buildField = (url: string, group: L.LayerGroup, field: FieldDescriptor) => {
    const layer = new (SstLayer as unknown as new (o: { field: FieldDescriptor }) => ScalarLayer)({ field });
    const entry: { group: L.LayerGroup; layer: ScalarLayer } = { group, layer };
    ssts.push(entry);

    fetch(url)
      .then((r) => r.json())
      .then((coarse: Scalar) => {
        /* Credit the source, and name the run where there is one. A
           forecast step valid an hour from now is worthless if it came
           from a run three days old, and without the run on screen there
           is nothing to tell the two apart — which is how the currents sat
           two days stale while looking current. An analysis has no run;
           its own date is the answer, so that is what it shows. */
        const run = coarse.header?.modelRun?.slice(0, 16).replace('T', ' ');
        const at = coarse.header?.refTime?.slice(0, 10);
        layer.options.attribution =
          `${field.label}: ${coarse.header?.source ?? 'unknown source'}` +
          (run ? ` — ${run}Z run` : at ? ` — ${at}` : '');

        group.addLayer(layer);
        layer.setGrid(coarse);

        const details = [...(coarse.header?.details ?? [])].sort(
          (a: RegionLink, b: RegionLink) => a.deg - b.deg
        );
        const grids = new Map<string, Scalar>();
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
        const assemble = (loaded: Scalar[]): Scalar => {
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
              .then((loaded: Scalar[]) => {
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
    const showKey = () => {
      const on = ssts.find((f) => map.hasLayer(f.group));
      const field = on?.layer?.options?.field;
      const range = on?.layer?.getRange?.();
      sstKey.hidden = !on;
      if (!on) return;
      // The bar shows the ramp of whichever field is on, and its own unit —
      // two scalars sharing one key would otherwise mislabel one of them.
      const hexes = (palette.colormaps ?? {})[choiceFor(field).map] ?? [];
      sstKey.style.setProperty('--sst-ramp', `linear-gradient(to right, ${hexes.join(', ')})`);
      sstKey.textContent = range
        ? `${range[0]} to ${range[1]} ${field?.unit ?? ''}`.trim()
        : (field?.label ?? 'ocean field');
    };
    map.on('overlayadd overlayremove moveend zoomend', showKey);
    for (const entry of ssts) entry.layer.on('rangechange', showKey);
    showKey();
  }

  /* Reader control over the colour scale. Three things, all per field and
     all live: which colormap, what range it spans, and a way back to
     automatic.

     Only the colormaps in the palette are offered, and that is the point —
     whichever is chosen becomes the water under every marker, so the set is
     the one the contrast gate has checked. A free colour picker would let a
     reader hide the fleet. */
  const controls = find<HTMLElement>('[data-field-controls]');
  const mapPicker = controls?.querySelector<HTMLSelectElement>('[data-field-map]');
  const minInput = controls?.querySelector<HTMLInputElement>('[data-field-min]');
  const maxInput = controls?.querySelector<HTMLInputElement>('[data-field-max]');
  const autoButton = controls?.querySelector<HTMLButtonElement>('[data-field-auto]');

  if (controls && mapPicker && minInput && maxInput && autoButton) {
    /* Two groups, and the split is measured rather than editorial: the
       first are the scales whose every stop clears the markers by ΔE 22,
       the second are the standard oceanographic and matplotlib maps, which
       do not — a full-gamut colormap passes near a marker colour somewhere
       along it, necessarily. They are offered regardless. They are not the
       default, the markers keep their dark outlines, and which scale to
       read the ocean with is the reader's call, not the gate's. */
    const safe = new Set<string>(palette.markerSafe ?? []);
    const groups: [string, string[]][] = [
      ['High contrast', Object.keys(COLORMAPS).filter((n) => safe.has(n))],
      ['Standard', Object.keys(COLORMAPS).filter((n) => !safe.has(n))],
    ];
    for (const [caption, names] of groups) {
      if (!names.length) continue;
      const group = document.createElement('optgroup');
      group.label = caption;
      for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        group.append(option);
      }
      mapPicker.append(group);
    }

    const shownField = () => ssts.find((f) => map.hasLayer(f.group))?.layer?.options?.field ?? null;

    const repaint = () => {
      for (const entry of ssts) if (map.hasLayer(entry.group)) entry.layer._render?.();
    };

    /* Reflect the live state into the inputs. Skipped while a field is
       focused, or typing "3" on the way to "35" would be read back as 3 and
       the caret would jump. */
    const syncControls = () => {
      const field = shownField();
      controls.hidden = !field;
      if (!field) return;
      const choice = choiceFor(field);
      mapPicker.value = choice.map;
      minInput.step = String(field.step);
      maxInput.step = String(field.step);
      autoButton.disabled = choice.range === null;
      autoButton.textContent = choice.range === null ? 'Auto' : 'Reset';
      const live = ssts.find((f) => map.hasLayer(f.group))?.layer?.getRange?.();
      if (live && document.activeElement !== minInput && document.activeElement !== maxInput) {
        minInput.value = String(live[0]);
        maxInput.value = String(live[1]);
      }
    };

    mapPicker.addEventListener('change', () => {
      const field = shownField();
      if (!field) return;
      choiceFor(field).map = mapPicker.value;
      repaint();
      syncControls();
    });

    const pin = () => {
      const field = shownField();
      if (!field) return;
      const lo = Number(minInput.value);
      const hi = Number(maxInput.value);
      // An inverted or empty range would paint one flat colour; leave the
      // current scale alone until the pair makes sense.
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
      choiceFor(field).range = [lo, hi];
      repaint();
      syncControls();
    };
    minInput.addEventListener('change', pin);
    maxInput.addEventListener('change', pin);

    autoButton.addEventListener('click', () => {
      const field = shownField();
      if (!field) return;
      choiceFor(field).range = null;
      repaint();
      syncControls();
    });

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

  const coastline = L.layerGroup();
  const gebco = L.tileLayer.wms('https://wms.gebco.net/mapserv?', {
    layers: 'GEBCO_LATEST',
    format: 'image/png',
    attribution: 'GEBCO Compilation Group',
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
  gebco.addTo(map);

  /* Dark mode dims the tile pane, which was written when the light Esri
     basemap was the default. GEBCO is already dark — its deep ocean sits
     near 0.10 luminance against Esri's 0.33 — so dimming it too drops the
     sea to almost black. The active basemap's tone is published on the
     container and the stylesheet dims only the light ones. */
  const LIGHT_BASEMAPS = new Set(['Bathymetry (Esri Ocean)', 'OpenStreetMap']);
  const markBasemapTone = (name: string) => {
    host.dataset.basemapTone = LIGHT_BASEMAPS.has(name) ? 'light' : 'dark';
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


  // Lat/lon grid, every 10°.
  const graticule = L.layerGroup();
  for (let lon = -180; lon <= 180; lon += 10) {
    L.polyline([[-85, lon], [85, lon]], { weight: 0.5, className: 'map-grid' }).addTo(graticule);
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    L.polyline([[lat, -180], [lat, 180]], { weight: 0.5, className: 'map-grid' }).addTo(graticule);
  }

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
      if (measuring) {
        addMeasurePoint(at);
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

  const overlays: Record<string, L.Layer> = {
    'Surface currents (animated)': flow,
    'Currents at 60 m (animated)': flowDeep,
    'SST (OISST analysis)': sstOisst,
    'SST (Navy forecast)': sstNavy,
    'Salinity (Navy forecast)': sssNavy,
    ...(MERCATOR_RASTER ? { 'Current speed (Mercator)': currents } : {}),
    'Hurricanes': storms,
    'NOAA USVs': usvs,
    'IOOS gliders': gliders,
    'Argo floats': argo,
    'Isobaths': bathy,
    'Coastline': shoreline,
    'Country & state borders': borders,
    'EEZ boundaries': eez,
    'Lat/lon grid': graticule,
  };
  /* What "default" means, captured rather than restated. Every layer that
     is on right now is on because startup put it there, and startup is the
     only place that decides — writing the list out again here would be a
     second source of truth that drifts, and it would be wrong for a
     reduced-motion reader, who never gets the animated field. Taken before
     restoreView runs, so it is the defaults and not the reader's session. */
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

  const drawOverlays = (group: L.LayerGroup, id: string, overlays: KmzOverlay[]) => {
    const urls: string[] = [];
    for (const overlay of overlays) {
      const url = URL.createObjectURL(new Blob([overlay.image as BlobPart], { type: overlay.mediaType }));
      urls.push(url);
      const image = L.imageOverlay(
        url,
        [
          [overlay.bounds.south, overlay.bounds.west],
          [overlay.bounds.north, overlay.bounds.east],
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
    [flow, flowDeep],                    // two particle fields cannot be told apart
    // Every scalar raster: they share a pane, so the upper one simply
    // hides the lower and the map would name two fields while showing one.
    [sstOisst, sstNavy, sssNavy],
  ];

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
    if (base) {
      for (const layer of Object.values(bases)) if (map.hasLayer(layer)) map.removeLayer(layer);
      map.addLayer(base);
      /* Leaflet's layers control turns this addLayer into a
         baselayerchange, so the handler above already catches it — but
         only because the control is built before this runs. Setting it
         here too makes the tone independent of that ordering. */
      markBasemapTone(saved.base);
    }
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

    if (typeof saved.bathyOpacity === 'number' && Number.isFinite(saved.bathyOpacity)) {
      bathyOpacity = Math.max(0.1, Math.min(1, saved.bathyOpacity));
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

  /* ---- measuring, and the point readout ----------------------------- */

  const measured = L.layerGroup().addTo(map);
  let measuring = false;
  let points: L.LatLng[] = [];
  let readout: HTMLElement | null = null;

  const drawMeasurement = () => {
    measured.clearLayers();
    if (!points.length) return;

    if (points.length > 1) {
      /* A light halo under a dark line, so the measurement reads on the
         pale Esri basemap and the dark GEBCO one alike. The halo is an
         outline, themed in CSS like the track casings rather than gated
         as a feature colour. */
      L.polyline(points, { className: 'map-measure-halo', weight: 6, lineCap: 'round' }).addTo(measured);
      L.polyline(points, {
        color: MEASURE,
        weight: 2.5,
        dashArray: '7,5',
        lineCap: 'round',
      }).addTo(measured);
    }

    points.forEach((point, i) => {
      L.circleMarker(point, {
        radius: 4,
        color: MEASURE,
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
      })
        .addTo(measured)
        .bindTooltip(
          i === 0
            ? `Start · ${coordText(point)}`
            : `Leg ${i}: ${spanText(points[i - 1]!.distanceTo(point))} · ` +
              `${initialBearing(points[i - 1]!, point).toFixed(0)}°T<br>${coordText(point)}`,
          { direction: 'top' }
        );
    });

    if (readout) {
      const total = points.reduce(
        (sum, point, i) => (i ? sum + points[i - 1]!.distanceTo(point) : 0),
        0
      );
      const legs = points.length - 1;
      readout.textContent =
        legs < 1
          ? 'Click a second point'
          : `${spanText(total)}${legs > 1 ? ` over ${legs} legs` : ''} · ` +
            `${initialBearing(points[0]!, points[points.length - 1]!).toFixed(0)}°T direct`;
    }
  };

  const setMeasuring = (on: boolean) => {
    measuring = on;
    host.style.cursor = on ? 'crosshair' : '';
    if (!on) {
      points = [];
      measured.clearLayers();
    }
    if (readout) readout.textContent = on ? 'Click a point to start' : '';
    if (button) {
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('active', on);
    }
  };

  let button: HTMLAnchorElement | null = null;
  const Measure = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar measure-control');
      button = L.DomUtil.create('a', '', bar) as HTMLAnchorElement;
      button.href = '#';
      button.textContent = '📏';
      button.title = 'Measure distance and bearing';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Measure distance and bearing');
      button.setAttribute('aria-pressed', 'false');
      readout = L.DomUtil.create('span', 'measure-readout', bar);
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.stop(e);
        setMeasuring(!measuring);
      });
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    },
  });
  map.addControl(new Measure());

  const addMeasurePoint = (at: L.LatLng) => {
    points.push(at);
    drawMeasurement();
  };

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (!measuring) return;
    addMeasurePoint(e.latlng);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && measuring) setMeasuring(false);
  });

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
    const water = currentAt(ll);
    const temp = sstAt(ll);
    return (
      `<dl class="ocean">` +
      `<dt>Seafloor</dt><dd data-depth>fetching…</dd>` +
      /* Only when the EEZ layer is on, for the same reason the temperature
         row waits for a temperature layer: a reader who has not asked about
         maritime boundaries is not asking about them here either, and the
         row costs a request to fill. */
      (map.hasLayer(eez) ? `<dt>Jurisdiction</dt><dd data-eez>fetching…</dd>` : '') +
      /* Named for the depth actually sampled — the reader may have the
         60 m field on, and calling that "surface current" would be wrong
         in a way nothing on screen would give away. */
      (water
        ? `<dt>Current at ${water.depth ? `${water.depth} m` : 'surface'}</dt>` +
          `<dd>${water.speed.toFixed(2)} m/s toward ${water.toward.toFixed(0)}°T</dd>`
        : `<dt>Current</dt><dd>no data here</dd>`) +
      /* Only when a temperature layer is on. With none loaded there is no
         grid to miss, and "no data" would claim something untrue about the
         ocean rather than about the map. */
      (temp ? `<dt>${temp.label}</dt><dd>${temp.value.toFixed(1)} ${temp.unit}</dd>` : '') +
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
        at.textContent =
          value < 0
            ? `${Math.round(-value).toLocaleString()} m deep`
            : `${Math.round(value).toLocaleString()} m above sea level`;
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
    if (measuring) return;
    describePoint(e.latlng);
  });

  let pressTimer: number | undefined;
  let pressStart: { x: number; y: number } | null = null;
  const container = map.getContainer();
  container.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (measuring || e.touches.length !== 1) return;
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

    setMeasuring(false);
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

  fetch(`${DATA}coastline.json`)
    .then((r) => r.json())
    .then(({ rings }) => {
      const style = { weight: 0.8, className: 'map-land' };
      for (const ring of rings as number[][][]) L.polygon(flip(ring), style).addTo(coastline);
    })
    .catch(() => {});

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
  const showStatus = () => {
    if (!status) return;
    const order = ['storms', 'assets', 'argo', 'updated'];
    const line = order.map((k) => statusParts[k]).filter(Boolean).join(' · ');
    if (line) status.textContent = line;
  };

  const rad = Math.PI / 180;

  /* Great-circle initial bearing. A rhumb line would be the one to steer,
     but the distance beside it is great-circle, and quoting the two from
     different geometries invites the reader to combine them. */




  /* The surface current under a point, read out of whichever grid is
     loaded — no request, and it is the same field the particles follow. */
  /* Temperature at a point, from the grid already loaded — no request, and
     it is the same field being painted. */
  const sstAt = (ll: L.LatLng) => {
    const shown = ssts.find((f) => map.hasLayer(f.group));
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
    return typeof v === 'number'
      ? { value: v, unit: h.units === 'psu' ? 'psu' : '°C', label: field?.label ?? 'Sea surface' }
      : null;
  };

  const currentAt = (ll: L.LatLng) => {
    const shown = flows.find((f) => map.hasLayer(f.group))?.layer;
    const grid = (shown as unknown as { options?: { data?: VectorGrid } })?.options?.data;
    const head = grid?.[0]?.header;
    if (!head) return null;
    const i = Math.round(((((ll.lng - head.lo1) % 360) + 360) % 360) / head.dx);
    const j = Math.round((head.la1 - ll.lat) / head.dy);
    if (i < 0 || i >= head.nx || j < 0 || j >= head.ny) return null;
    const k = j * head.nx + i;
    const u = grid[0].data[k];
    const v = grid[1].data[k];
    if (typeof u !== 'number' || typeof v !== 'number') return null;
    return {
      speed: Math.hypot(u, v),
      toward: (Math.atan2(u, v) / rad + 360) % 360,
      deg: head.dx,
      depth: head.depth ?? 0,
    };
  };


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
