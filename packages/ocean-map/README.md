# ocean-map

An interactive map of ocean observing platforms and the water and weather they
are working in: storm tracks and forecast cones, gliders, saildrones, Argo
floats, animated currents at two depths, animated 10 m wind, sea-surface
temperature and salinity, isobaths, a coastline and EEZ boundaries — with
distance/bearing measurement, a right-click readout of depth, current, wind,
temperature and jurisdiction, and a reader's own KMZ or KML — vectors and
georeferenced images — drawn over the top and kept between visits.

The map fills whatever container it is given, in both axes, and refits itself
when that container changes size rather than only when the window does.

Built for <https://oceansensing.org/observations/hurricanes/>, and kept free of
that site so it can be dropped somewhere else.

| if you are… | read |
| --- | --- |
| adding a feature to the map | **[BOUNDARIES.md](BOUNDARIES.md) first** |
| putting it in another website | [EMBEDDING.md](EMBEDDING.md) |
| writing the native iOS app | [PORTING-IOS.md](PORTING-IOS.md) |

**Anything added here has to keep both of those last two viable.** The
separations that make them possible are easy to breach by accident and
expensive to restore — `BOUNDARIES.md` lists them, with the test behind each.

## Using it

```js
import { createOceanMap, mountOceanMaps } from '@c4po/ocean-map';

// Explicit:
createOceanMap(document.querySelector('#my-map'), {
  dataBase: 'https://oceansensing.org/map/',
  home: [[7, -100], [45, -20]],
});

// Or let it find every container on the page:
mountOceanMaps();
```

`mountOceanMaps()` builds one map per `[data-ocean-map-canvas]` element. Each
scopes its legend, controls and status line to the nearest `[data-ocean-map]`
ancestor, so **two maps can share a page**.

| option | attribute | default |
| --- | --- | --- |
| `dataBase` | `data-map-data` | `/map/` |
| `home` | `data-map-home` | `[[7, -100], [45, -20]]` |
| `storageKey` | `data-map-storage-key` | `ocean-map:<container id>` |
| `layers` | `data-map-layers` (JSON array) | whatever the map opens with |
| `preload` | `data-map-preload` (JSON array) | nothing — a layer builds when first shown |
| `brand` | `data-map-brand` | none |
| `regions` | — code only | the list in `places.ts` |
| `interests` | — code only | the list in `places.ts` |

Options passed in code beat the attribute; the attribute beats the default.
Attributes exist so a page with no build step can configure the map in markup.

## What it expects around it

The module supplies behaviour only. The host page provides:

- **Markup** — a container, and optionally a legend, colour-scale controls, an
  isobath opacity slider and a status line, found by `data-*` hooks. See
  `src/components/AssetMap.astro` for the full set.
- **Styling** — none. `ocean-map.css` ships with the module and the module
  imports it. Rules key off the `ocean-map` class it puts on each container,
  not an id, so a page can carry several; shared class names carry an `om-`
  prefix, since a plain stylesheet has none of Astro's automatic scoping.
  Colours read CSS variables with fallbacks, so a host defining the site's
  design tokens gets its own palette and one that does not still gets a
  legible map.
- **Data** — the generated grids under `dataBase`. There are a few hundred MB
  of them, most of it isobath and current tiles, so they are not shipped here. Point `dataBase` at a host that already serves
  them, or build your own with the scripts in `scripts/`. `schema.ts` says
  exactly what each file must contain, and `npm run test:schema` checks a
  directory against it — which is also the definition a native port mirrors.

Leaflet is the only peer dependency, and the module brings its CSS. The
animated fields are drawn by this package's own layer — see
`velocity-layer.ts` — which is written in the constructor style so it runs
unmodified on Leaflet 1.9 and 2.0.

## Not done yet

- **The chrome markup is still the host's.** The legend, colour-scale controls,
  isobath slider and status line are found by `data-*` hooks, so a second site
  has to reproduce that markup — see `AssetMap.astro`. The module should build
  it, which would reduce a deployment to one `<div>`.
- **The fleet is assumed**, and the legend is where it shows: the entries name
  hurricanes, NOAA USVs, ocean gliders and Argo floats, and the layer switcher
  matches. Fine for another deployment reading the same `dataBase`; a
  blocker for one with different platforms.
- **`index.ts` is ~3,600 lines.** The renderer-independent parts are out —
  `geo.ts`, `ramp.ts`, `tiles.ts`, `schema.ts`, `warp.ts`, `kmz.ts`,
  `particles.ts`, about a quarter of the package — but what remains is one
  long Leaflet adapter. Splitting it further is tidiness rather than capability
  now, since a native port rewrites that layer anyway. Keep new logic that does
  not touch `L.` out of it regardless: see S1 in `BOUNDARIES.md`.

## Layout

```
packages/ocean-map/
  index.ts            createOceanMap / mountOceanMaps — the Leaflet map
  ocean-map.css       its styling; imported by index.ts
  schema.ts           what every file under dataBase must contain
  geo.ts  ramp.ts  tiles.ts   no Leaflet, no DOM — see below
  particles.ts        u/v sampling and particle advection — no Leaflet, no DOM
  velocity-layer.ts   the Leaflet canvas layer around it; runs on 1.9 and 2.0
  palette.ts          map-palette.json, typed
  storm-status.ts     shared with the host's build-time status line
  kmz.ts              KMZ/KML decode — no Leaflet, no DOM, parser injected
  warp.ts             the projective transform behind gx:LatLonQuad overlays
  store.ts            IndexedDB, for overlays a reader uploads
  data/               the palette, and the sampled basemap water it is gated against
```

`geo.ts`, `ramp.ts`, `tiles.ts`, `schema.ts`, `warp.ts`, `kmz.ts` and
`particles.ts` import
neither Leaflet nor the DOM and typecheck standalone. That is deliberate and worth preserving: they
are what a native port keeps, reimplementing only the drawing. Keep new logic
that does not touch `L.` out of the Leaflet path.
