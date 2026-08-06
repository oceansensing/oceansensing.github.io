# Embedding in another web project

A hand-off for a session putting this map into a different site. You do not
need `oceansensing.org`; you need the package, a container and a data source.

Read `BOUNDARIES.md` too — if you change the map rather than just place it,
those rules are what keep it reusable.

## The short version

```sh
npm install leaflet      # the only peer dependency
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

**It sizes itself to its container.** Width is whatever you give it; height
comes from the package stylesheet — `max(30rem, 77.5svh)` on a desktop
viewport, `max(24rem, 62svh)` below 48rem — with a floor and no ceiling, so it
grows with the window. It also watches the container with a `ResizeObserver`
and refits, which matters because Leaflet's own `trackResize` only listens on
`window.resize`: a sidebar opening or a font finishing loading changes the
map's width with the window perfectly still, and the failure is silent — tiles
simply stop short of the container's edge. If you want a different height,
override it on `.ocean-map`; that is the one rule here a host is expected to
have an opinion about.

## Options

Passed in code, or as `data-*` on the container. Code wins over the attribute,
the attribute over the default.

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

```js
import { createOceanMap } from '@c4po/ocean-map';

createOceanMap(document.querySelector('#map'), {
  dataBase: 'https://oceansensing.org/map/',
  home: [[50, -30], [65, 10]],     // the Norwegian Sea, say
});
```

`regions` and `interests` are the two menus in the control stack, and they
are the options a second deployment is most likely to want its own version
of — a site whose readers work in the Baltic has no use for a jump to the
Chukchi Sea. Both are plain data with no Leaflet and no DOM in them (see
`places.ts`), and the split between them is load-bearing: a region moves the
view and touches nothing else, an interest sets layers and colour scales and
moves nothing, so the two compose. An interest names overlays by their
switcher labels and colormaps by their palette keys, and a name that does
not exist fails silently — this repository's `check:docs` validates both
against their sources, and a fork should do the same.

`layers` names overlays as the switcher shows them, and is how one engine
serves several pages: this site's general-purpose map and its hurricane map
differ only in their preset and their home bounds. Reset returns to the
preset. Animated layers are dropped for a reduced-motion reader even when the
preset names them.

**Two maps on a page is supported and tested.** Give each its own container;
they keep separate homes, saved views and controls. Set `storageKey`
explicitly if the containers have no ids.

## Where the data comes from

Two honest choices.

**Point at `https://oceansensing.org/map/`.** Works immediately, nothing to
build. You are depending on that host staying up and on its update cadence,
and you should ask before leaning on someone else's bandwidth.

**Run the pipelines.** `../../scripts/*.py` produce everything; `../../README.md`
lists the commands. Standard library only except for the two local tools and
the wind, which needs `eccodes` — ECMWF packs its open GRIB2 with CCSDS/AEC
and nothing in Python's standard library decodes that. Two
things to know before you start: the isobaths need a 7.5 GB GEBCO grid you
download once, and the full data set is ~186 MB, of which 123 MB is isobath
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
| `[data-field-controls]` | a **bare container**; the module builds one colormap/min/max/Auto set into it per scalar field that is on |
| `[data-bathy-controls]` | isobath opacity slider |
| `[data-storm-status]` | the active-storm line, if you render one |
| `[data-kmz-controls]` | wrapper for the overlay upload |
| `[data-kmz-file]` | `<input type="file">` for a reader's KMZ or KML |
| `[data-kmz-list]` | where loaded overlays are listed, with a remove button each |
| `[data-kmz-note]` | what the last upload drew and skipped |
| `[data-flow-key]` | a **bare container** the module fills with one key per animated field that is on. Give it no class of its own or it draws a swatch in front of the ones it holds |
| `[data-particle-colours]` | where the per-field particle colour pickers are built |
| `[data-particle-speed]` | where the per-field drift sliders are built |
| `[data-forecast-controls]` | the forecast-hour buttons, when the data publishes more than one frame |
| `[data-layer-key]` | on a legend swatch, naming the layer it stands for, so the module can hide it while that layer is off |
| `[data-share-link]` | a `<button>` that copies a link reproducing the current view |
| `[data-export-png]` | a `<button>` that saves the figure. Its value is the scale — omit it for the screen, `"2"` for print |
| `[data-point-readout]` | not a hook — the readout is a Leaflet popup and needs no markup |
| `[data-map-credit]` | where Leaflet's attribution is **moved to** |

Every one is optional. Omit a hook and that control simply does not appear.

This table has rotted before — `data-share-link` and `data-particle-speed` were
both live for a while without appearing here. It is worth checking against
`grep -o 'data-[a-z-]*' ../../src/components/AssetMap.astro | sort -u` when
adding a control.

**`[data-map-credit]` is the one worth adding deliberately.** Leaflet renders
attribution as a control, so by default it floats over the bottom edge of the
map — on top of the graticule's longitude labels, which are pinned to that
same edge. Give the module an element and it reparents the control there; the
control is otherwise untouched, so it goes on assembling and updating the
credit itself. Omit it and you keep Leaflet's floating box, which is correct
but crowded.

The attribution is **not** optional in the legal sense — the data sources
require credit. What is optional is only where it sits.

This is the roughest edge in the package and the obvious next improvement:
having the module build its own chrome would reduce a deployment to one
`<div>`. It has not been done because it is worth nothing to the iOS port and
saves only this copying.

## What you will hit

- **The fleet is assumed.** Layer names, legend entries and popups say
  hurricanes, NOAA USVs, ocean gliders, Argo floats. Reading the same
  `dataBase` that is simply correct. Showing *different* platforms means
  making the platform layers pluggable, which is a real piece of work and has
  deliberately been left until a second use defines what it needs. If that is
  you, say so — the descriptor half (labels, colours, ids, data keys) is
  bounded; the rendering half is a redesign.
- **The animated fields are this package's own layer**, not a plugin. That
  matters for two reasons if you are porting or upgrading. There is no
  `globalThis.L` to arrange — `leaflet-velocity` was UMD and read Leaflet off
  the global, which a bundled ESM build never sets, so it had to be pulled in
  by dynamic import after assigning the global, and got that wrong in
  production only. And `velocity-layer.ts` is written in the constructor
  style — `new Point(...)`, `Util.setOptions`, a native `class extends
  Layer` — so it runs unmodified on Leaflet 1.9 and 2.0.
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
  US Navy, ECMWF, IOOS, Ifremer and the other sources are credited on the map
  itself. Leave the attribution control in place. Several are also licensed on
  condition of it — ECMWF's open data is CC BY 4.0.
