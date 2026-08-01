# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run verify       # build + check + check:docs + test:contrast + test:map + test:clock
npm run dev          # dev server at localhost:4321
npm run build        # production build into dist/
npm run check        # astro check — type-checks .astro and .ts; must be 0 errors
npm run check:docs   # docs reference real scripts, real paths, the right URL
npm run data         # regenerate public/map/ocean-assets.json from NOAA/IOOS live
npm run data:currents # regenerate public/map/currents.json from HYCOM/Navy ESPC
npm run data:basemaps # re-sample basemap ocean colours (needs Pillow; slow, GEBCO's WMS)
npm run test:contrast # map colours stay visible on both bathymetries
npm run test:map     # headless test of the built map bundle
npm run test:clock   # headless test of the built UTC clock
```

**`npm run verify` is the gate.** CI runs exactly this and the deploy job will
not run unless it passes, so a change that fails it does not reach the site.
Run it before pushing.

Both test scripts run against `dist/`, so **build first** or they test stale
code — `verify` does that for you. There is no watch mode and no per-test
filter; each script is a single file that prints one `ok`/`FAIL` line per check
and exits non-zero on any failure.

`check:docs` exists because `README.md` went stale on three counts at once
after the domain cutover — wrong live URL, a "when ready" section for work
already done, and a claim about client-side JS that four features had since
broken. It verifies that every `npm run …` and every backticked repo path in
`README.md`, `CLAUDE.md` and `PLAN.md` is real, that the canonical URL agrees
across `astro.config.mjs`, `src/config.ts` and the README, and that the deploy
workflow still contains the gate the README promises.

`npm run check` truncates long diagnostics when piped through `tail`; read the
whole output or grep for `^- [0-9]+ error`.

## Architecture

Astro static site, deployed to GitHub Pages at oceansensing.org. Content is
data-driven throughout: adding a paper, person, project, dataset, or CV line
means editing a Markdown/YAML/BibTeX file, never layout code. `README.md` has
the content-editing table for that.

### Content layer

`src/content.config.ts` defines ~20 collections through four loader kinds:

- `glob()` — Markdown collections (`projects`, `people`, `news`, `observations`)
- `file()` — YAML data (`presentations`, `datasets`, `software`, `interns`).
  **The `file()` loader does not preserve YAML document order**, so pages that
  care about order sort explicitly.
- `bibtexLoader` (`src/lib/bibtexLoader.ts`) — parses `src/data/publications.bib`
  with `@retorquere/bibtex-parser`. Must be called with `sentenceCase: false`
  or the parser lowercases every title.
- `cvSectionLoader(section)` (`src/lib/cvLoader.ts`) — one collection per CV
  section, reading `src/data/cv/<person-id>/<section>.yaml` across every person
  directory. `<person-id>` matches that person's file in `src/content/people/`,
  which is what makes `/cv/<person-id>/` appear.

### Styling

Vanilla CSS with semantic tokens in `src/styles/tokens.css`. Light/dark comes
from `prefers-color-scheme` **plus** a `data-theme` attribute override applied
before first paint. Any theme-sensitive rule therefore needs both forms:

```css
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) … }
:root[data-theme='dark'] … 
```

Site metadata, navigation, and the author names bolded in citations live in
`src/config.ts`.

### JavaScript

The site is near-zero-JS by intent. The exceptions are the theme toggle, the
observation photo shuffle and lightbox, `AssetMap.astro`, and `UtcClock.astro`.
Prefer no JS, but do not contort a design to avoid it.

Astro inlines small component scripts into the page HTML and bundles larger ones
into `dist/_astro/*.js`. `AssetMap` is large enough to be bundled; `UtcClock` is
inlined. The two test harnesses locate their code accordingly — if a component
crosses that threshold, its harness needs updating.

### The map (`src/components/AssetMap.astro`)

Leaflet, self-hosted from npm. Reads `public/map/ocean-assets.json`, plus
`coastline.json` and `boundaries.json` (Natural Earth, RDP-simplified, committed).

Vector layers carry a **`className`, never a colour** — CSS owns their stroke and
fill so a theme switch restyles every path with no redraw. Adding a hardcoded
`color:` to a Leaflet path breaks dark mode; `npm run test:map` asserts against
this.

Layer stacking is deliberate: currents render in a custom pane at z-index 250,
between the basemap tiles (200) and the vectors (400), so platforms are never
obscured whichever basemap is selected.

The Leaflet map instance is hung on the container element as `_map`. Nothing on
the page reads it; the test harness does, and it makes the map pokeable from the
console.

### Argo floats

About two thousand dots, against forty gliders and saildrones — which drives
three decisions:

- **Own file** (`public/map/argo.json`, ~30 KB gzipped). `ocean-assets.json`
  is re-fetched every hour by the auto-refresh poll; Argo does not belong in
  that.
- **Canvas renderer**, not SVG. That many vector elements would compete with
  the particle animation for the same frame budget. The cost is that canvas
  markers carry no class, so unlike the other platforms they **cannot be
  restyled by theme** — which is only acceptable because the colour clears
  both bathymetries in `test:contrast`.
- **No tracks.** A float cycles every ten days and the window is five, so
  most have exactly one fix in it. Roughly half the fleet shows at any time,
  for the same reason.

Note the canvas renderer culls to the viewport, so a test that counts draw
calls counts what is on screen, not the fleet.

### Data pipeline (`scripts/fetch-ocean-assets.py`)

Standard library only, so CI needs no Python dependencies. Aggregates NHC storms
(via KMZ), NOAA PMEL saildrones, and IOOS gliders into one JSON. It runs
**server-side because NHC and PMEL send no CORS headers** — a browser cannot read
them directly. It also decimates ERDDAP queries server-side
(`orderByClosest("time/1hours")`) to keep the payload small, and falls back to
the previous file when a source is unreachable so an outage degrades to stale
data rather than an empty map.

`.github/workflows/deploy.yml` runs it hourly before the Astro build. **Nothing
is committed by CI** — the data is fetched into the build, so the repo does not
grow. A snapshot of `ocean-assets.json` is committed so local and offline builds
work.

### Basemaps

GEBCO is the default. Esri Ocean, OpenStreetMap and an offline coastline-only
layer are the alternatives; the coastline one is the no-tracking option and
ships with the site.

Tone matters, because dark mode dims the tile pane and that was written when
the light Esri basemap was the default — GEBCO's deep ocean sits near 0.10
luminance against Esri's 0.33, so dimming it too drops the sea to nearly
black. The active basemap's tone is published as `data-basemap-tone` on the
map container and **only light basemaps are dimmed**. Add a basemap and it
counts as dark unless you list it in `LIGHT_BASEMAPS`.

### Map colour, and the contrast gate

**Never inline a colour in `AssetMap.astro`.** They live in
`src/data/map-palette.json`, which the component imports and
`npm run test:contrast` checks — a hardcoded colour is invisible to the gate.

The map offers two bathymetries of opposite tone: Esri Ocean is light (ocean
luminance ~0.33) and GEBCO is dark (~0.10, though it paints shallow banks a
pale mint). A colour that reads on one can vanish on the other, which is what
happened to the first pass at the current particles.

The gate uses **CIEDE2000 distance, not WCAG contrast ratio**. WCAG compares
luminance only and would fail the storm red and glider magenta on both maps
despite both being obvious — their separation is hue. CIE76 is the easy
substitute but understates differences in exactly the blue region these
backgrounds occupy. It also judges by **prevalence-weighted coverage** rather
than worst case, so one uncommon water tone cannot veto a colour that is
clear over the rest of the ocean.

Water palettes are sampled offline into `src/data/basemap-ocean.json`, so the
gate needs no network. Re-run `npm run data:basemaps` if a basemap changes.

### Surface currents

Two layers, two models, both labelled in the switcher because they are not
the same data:

- **Animated particles** (default) — `leaflet-velocity` over a u/v grid in
  `public/map/currents.json`, built by `scripts/fetch-currents.py` from the
  US Navy ESPC-D-V02 global forecast via HYCOM's OPeNDAP. Chosen because it
  is open; **Copernicus publishes Mercator at the same resolution but its
  numeric access needs credentials**, and the WMTS only serves pictures.

  **A coarse global grid plus finer regional ones, chosen by zoom.**
  `currents.json` is global at ~0.96° and loads with the page. Each entry in
  `DETAILS` (in `scripts/fetch-currents.py`) becomes another file, fetched
  only when the reader zooms inside it — laziness is what pays for the
  resolution, so **adding a region costs nothing to anyone outside it**.

  Resolution is per region, because a degree is not a fixed distance. At 35°N
  a 0.24° cell is ~22 km across; at 75°N it is 7 km wide but still 27 km
  tall, so **latitude is the binding constraint at high latitude** and the
  Nordic grid halves the latitude step again. That is what makes a fjord
  coastline representable, and it cut land carrying flow over
  Greenland–Svalbard from 3.1% to 0.6%.

  A region straddling the prime meridian wraps in the model's 0–360
  longitudes and so is **fetched as two slabs**, the second resuming the
  stride where the first stopped — otherwise the columns either side of the
  meridian are unevenly spaced and the grid is no longer regular. A region
  straddling the *antimeridian* would additionally need a wrap-aware
  containment test in the component; none does today.

  The map learns the regions from the **global file's header**
  (`header.details`) rather than repeating them in the component, takes the
  finest whose bounds contain the whole viewport — a partly-covered view
  would have flow on one side and nothing on the other — and swaps with
  `setOptions({data})` only when the answer changes, since that restarts the
  animation.

  The global grid **must span a full 360° of longitude**: that is the exact
  condition leaflet-velocity uses to wrap across the antimeridian, and
  without it particles pile up against the edge. It also means longitude is
  indexed with a floored modulo, since the grid starts at 0°E and half the
  world is west of that.
- **Mercator speed raster** (off by default) — the Copernicus WMTS tiles.
  Also what `prefers-reduced-motion` readers get instead of the animation.

**leaflet-velocity does not treat a null as missing.** Its grid hands back
`[u, v]` — an array, so always truthy, so `isValue()` passes — and its
bilinear interpolation multiplies straight through, where `null` becomes
zero. A cell that is partly land therefore yields a reduced but *non-zero*
velocity defined over the land, and particles advect onto it and keep going.
Subsampling compounds it: taking every twelfth model node discards the
model's own 1/12° mask, so at high latitude one sample decides a cell tens of
km across.

The pipeline compensates by eroding cells wedged into the coastline
(`COASTAL_DRY_NEIGHBOURS`). The threshold is measured, not chosen: requiring
one dry neighbour wipes out the Gulf Stream and Kuroshio, two still loses the
Kuroshio's inshore core, three keeps both and cuts land carrying flow from
7.8% to 2.1%. `test:map` brackets it from both sides — continental interiors
must be dry, and those two currents must survive.

It is a mitigation, not a cure: a 0.96° grid cannot represent a fjord
coastline, and an island smaller than a cell sits in open model water
whatever the threshold.

Two more things about the particles are easy to get wrong and were, both
silently:

- **They must composite normally.** The Mercator raster is multiplied over
  the basemap; when the particles shared that pane they were multiplied too,
  which all but deleted them — they are near-white, and multiplying by
  near-white changes almost nothing. Hence two panes. `test:contrast` reads
  the particle pane's name out of the component and fails if a blend mode
  reappears on it, because the whole gate assumes normal compositing.
- **Their speed must be divided by the plugin's `mapArea^0.4`.** That factor
  makes particles slower the further you zoom *in* — the same current drifted
  1.4 px/frame at zoom 3 and 0.23 at zoom 6, so zooming to a storm stopped
  the flow. `scaleForView()` cancels it and rescales on `zoomend`.

`npm run test:map` records the canvas draw calls and prints the per-frame
displacement distribution — that is how both bugs were found, and it fails if
the particles go sub-pixel again. Re-measure rather than guess when tuning.

**leaflet-velocity is UMD and reads Leaflet off the global object**, which
the bundled ESM build never sets. It is therefore loaded by dynamic import
*after* `globalThis.L` is assigned — a static import would be hoisted above
the assignment and the built bundle would die on `L is not defined`. The
dev server hides this by serving Leaflet's UMD build, so **this breaks only
in `dist/`**; `npm run test:map` covers it.

### Hourly self-refresh

The map page reloads itself when a newer build lands, because the storm
status line is rendered at build time and only a real reload updates it.

Two constraints shape it. It **waits for a quiet moment** — tab hidden, or
two minutes without input — so it never yanks the page away mid-read; once
it knows something is waiting it re-checks every 30 s rather than sitting on
it for another hour. And it **saves the reader's view first**
(`sessionStorage`, key `asset-map-view`: centre, zoom, basemap, overlays)
and restores it on load, so a refresh does not dump them back at the basin.
`fitBounds(BASIN)` therefore runs only when nothing was restored.

The saved view also records **every overlay that existed when it was
written**, not just the ones switched on. Without that, a layer added later
is indistinguishable from one the reader turned off, and restoring would
hide it from anyone holding an older view — which is what happened the
moment Argo was added. Unknown layers keep their default.

`npm run test:map` seeds a saved view and asserts the map comes back to it.

### Known upstream quirks

Both were found the hard way; do not re-derive them.

- **The CDN in front of GitHub Pages regenerates the `Date` header on every
  response while still counting `Age` up.** Adding the two double-counts. This
  is why `UtcClock` uses `Date` alone. Covered by `test:clock`.
- **A cache-busting query string does not force a fresh response** from GitHub
  Pages — it answers `x-cache: HIT` regardless.

## Verifying work

Browser preview is often unavailable. When it is, verify by inspecting built
HTML in `dist/`, or with a Node/jsdom harness — see `scripts/test-map.mjs` and
`scripts/test-clock.mjs`, which execute the actual built bundles against real
data rather than reimplementing the logic.

A test that stubs away the condition it is meant to catch proves nothing: the
clock's original harness passed while the clock was wrong, because it stubbed
`Age: 0`. When adding a regression test, confirm it **fails** against the
unfixed code.

After deploying, GitHub Pages serves stale HTML for a while — poll with a
cache-busting query parameter, and check for a string that survives
minification (comments do not).
