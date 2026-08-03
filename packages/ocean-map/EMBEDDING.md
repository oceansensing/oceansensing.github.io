# Embedding in another web project

A hand-off for a session putting this map into a different site. You do not
need `oceansensing.org`; you need the package, a container and a data source.

Read `BOUNDARIES.md` too — if you change the map rather than just place it,
those rules are what keep it reusable.

## The short version

```sh
npm install leaflet leaflet-velocity      # peer dependencies
```

```html
<figure data-ocean-map>
  <div id="map" data-ocean-map-canvas
       data-map-data="https://oceansensing.org/map/"></div>
</figure>
```

```js
import { mountOceanMaps } from '@c4po/ocean-map';
mountOceanMaps();
```

That is a working map. The stylesheet comes with the module; there is nothing
to import separately and no design tokens to define.

## Options

Passed in code, or as `data-*` on the container. Code wins over the attribute,
the attribute over the default.

| option | attribute | default |
| --- | --- | --- |
| `dataBase` | `data-map-data` | `/map/` |
| `home` | `data-map-home` | `[[7, -100], [45, -20]]` |
| `storageKey` | `data-map-storage-key` | `ocean-map:<container id>` |

```js
import { createOceanMap } from '@c4po/ocean-map';

createOceanMap(document.querySelector('#map'), {
  dataBase: 'https://oceansensing.org/map/',
  home: [[50, -30], [65, 10]],     // the Norwegian Sea, say
});
```

**Two maps on a page is supported and tested.** Give each its own container;
they keep separate homes, saved views and controls. Set `storageKey`
explicitly if the containers have no ids.

## Where the data comes from

Two honest choices.

**Point at `https://oceansensing.org/map/`.** Works immediately, nothing to
build. You are depending on that host staying up and on its update cadence,
and you should ask before leaning on someone else's bandwidth.

**Run the pipelines.** `../../scripts/*.py` produce everything; `../../README.md`
lists the commands. Standard library only except for the two local tools. Two
things to know before you start: the isobaths need a 7.5 GB GEBCO grid you
download once, and the full data set is ~166 MB, of which 107 MB is isobath
tiles. `TILE_STRIDE` in `fetch-bathymetry.py` halves that for roughly 4 px
vertex spacing instead of 2.

Either way, `schema.ts` says exactly what each file must contain and
`npm run test:schema` checks a directory against it.

## The chrome

The map draws itself into the container. The **legend, colour-scale controls,
isobath opacity slider and status line are the host's markup**, found by
`data-*` hooks — so if you want them, copy them from
`../../src/components/AssetMap.astro`. It is about 50 lines and the hooks are:

| hook | what it is |
| --- | --- |
| `[data-ocean-map]` | the root the map scopes its lookups to |
| `[data-ocean-map-canvas]` | the container the map is built in |
| `[data-map-status]` | the "N assets reporting" line |
| `[data-sst-key]` | the colour bar |
| `[data-field-controls]` | colormap picker, min, max, Auto |
| `[data-bathy-controls]` | isobath opacity slider |
| `[data-storm-status]` | the active-storm line, if you render one |
| `[data-kmz-controls]` | wrapper for the overlay upload |
| `[data-kmz-file]` | `<input type="file">` for a reader's KMZ or KML |
| `[data-kmz-list]` | where loaded overlays are listed, with a remove button each |
| `[data-kmz-note]` | what the last upload drew and skipped |

Every one is optional. Omit a hook and that control simply does not appear.

This is the roughest edge in the package and the obvious next improvement:
having the module build its own chrome would reduce a deployment to one
`<div>`. It has not been done because it is worth nothing to the iOS port and
saves only this copying.

## What you will hit

- **The fleet is assumed.** Layer names, legend entries and popups say
  hurricanes, NOAA USVs, IOOS gliders, Argo floats. Reading the same
  `dataBase` that is simply correct. Showing *different* platforms means
  making the platform layers pluggable, which is a real piece of work and has
  deliberately been left until a second use defines what it needs. If that is
  you, say so — the descriptor half (labels, colours, ids, data keys) is
  bounded; the rendering half is a redesign.
- **Leaflet must be on `globalThis` before `leaflet-velocity` loads.** The
  plugin is UMD and reads Leaflet off the global object, which a bundled ESM
  build never sets. `index.ts` handles this with a dynamic import after
  assigning `globalThis.L`; a static import would hoist above the assignment
  and die in production only. Do not "tidy" it into a static import.
- **A CSS reset that styles bare `svg` will erase vector layers.** The common
  `img, svg, video { max-width: 100% }` collapses an SVG inside a Leaflet pane
  to 0×0 and `overflow: hidden` clips every path away: right geometry, right
  stroke, zero pixels, no error. The package ships the counter-rule, but if
  your reset is more aggressive, that is where to look.
- **Theme.** Colours come from CSS variables with fallbacks, so it works
  unstyled. Define the site's tokens (`--bg`, `--text`, `--accent`,
  `--border`, `--font-mono`, `--space-*`, `--radius`) and it adopts your
  palette. Dark mode keys off `prefers-color-scheme` **plus** a
  `data-theme` attribute; a theme-sensitive rule needs both forms.
- **Attribution is not optional.** GEBCO, EMODnet, Marine Regions, NOAA, the
  US Navy, IOOS, Ifremer and the other sources are credited on the map itself.
  Leave the attribution control in place.
