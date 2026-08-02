# ocean-map

An interactive map of ocean observing platforms and the water they are working
in: storm tracks and forecast cones, gliders, saildrones, Argo floats, animated
currents at two depths, sea-surface temperature and salinity, isobaths, a
coastline and EEZ boundaries — with distance/bearing measurement and a
right-click readout of depth, current, temperature and jurisdiction.

Built for <https://oceansensing.org/observations/hurricanes/>, and kept free of
that site so it can be dropped somewhere else.

## Using it

```js
import { createOceanMap, mountOceanMaps } from './lib/ocean-map';

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
- **Data** — the generated grids under `dataBase`. There are ~150 MB of them,
  so they are not shipped here. Point `dataBase` at a host that already serves
  them, or build your own with the scripts in `scripts/`. `schema.ts` says
  exactly what each file must contain, and `npm run test:schema` checks a
  directory against it — which is also the definition a native port mirrors.

Leaflet and `leaflet-velocity` are imported directly; the module brings
Leaflet's own CSS with it.

## Not done yet

- **The chrome markup is still the host's.** The legend, colour-scale controls,
  isobath slider and status line are found by `data-*` hooks, so a second site
  has to reproduce that markup — see `AssetMap.astro`. The module should build
  it, which would reduce a deployment to one `<div>`.
- **The fleet is assumed**, and the legend is where it shows: the entries name
  hurricanes, NOAA USVs, IOOS gliders and Argo floats, and the layer switcher
  matches. Fine for another deployment reading the same `dataBase`; a
  blocker for one with different platforms.
- **It is one 2,700-line file.** The Leaflet-independent parts — colour ramps,
  coordinate formatting, grid sampling, tile selection — are worth pulling out
  as their own modules, and not only for tidiness: an iOS port would reuse
  every one of them and reimplement only the drawing. Keep new logic that does
  not touch `L.` out of the Leaflet path.
