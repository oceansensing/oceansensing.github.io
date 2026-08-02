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
- **Styling** — `src/components/AssetMap.astro`'s `<style>` block. Not yet part
  of this module; see below.
- **Data** — the generated grids under `dataBase`. There are ~150 MB of them,
  so they are not shipped here. Point `dataBase` at a host that already serves
  them, or build your own with the scripts in `scripts/`.

Leaflet and `leaflet-velocity` are imported directly; the module brings
Leaflet's own CSS with it.

## Not done yet

- **The CSS still lives in the Astro component.** Moving it here means losing
  Astro's automatic scoping, and the block has bare class selectors
  (`.legend`, `.status`, `.field-controls`) that would then be global. They
  need prefixing first.
- **It is one 2,700-line file.** The Leaflet-independent parts — colour ramps,
  coordinate formatting, grid sampling, tile selection — are worth pulling out
  as their own modules, and not only for tidiness: an iOS port would reuse
  every one of them and reimplement only the drawing. Keep new logic that does
  not touch `L.` out of the Leaflet path.
- **The fleet is assumed.** Layer names, popups and the status line know about
  storms, gliders, saildrones and Argo. Another deployment with different
  platforms needs those made pluggable, which is a larger job than
  configuration.
