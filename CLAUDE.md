# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run verify       # build + check + check:docs + test:contrast + test:map + test:clock
npm run dev          # dev server at localhost:4321
npm run build        # production build into dist/
npm run check        # astro check — type-checks .astro and .ts; must be 0 errors
npm run check:docs   # docs reference real scripts, real paths, the right URL
npm run data         # storms, gliders (4 regional ERDDAPs), USVs, Argo floats
npm run data:currents # the global + regional current grids, both depths
npm run data:tiles   # the 1/12° current tiles (~92 MB per depth, several minutes)
npm run data:fields  # global + regional SST and salinity grids, all products
npm run data:field-tiles # the Navy field tiles (OISST needs none — see below)
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

It also checks **numbers the docs quote from the code** — the tile zoom
threshold, the coastal erosion threshold, the particle lifetime, the Argo
cycle window and how many glider sources there are — by reading each from its
own source file. Every one of those has gone stale at least once. The
document is whitespace-normalised before matching, because these files are
hard-wrapped and a claim can straddle a line break; without that the check
reports drift that is only a newline.

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

Colour maths shared between the contrast gate and the ramp search lives in
`scripts/lib/colour.mjs` — Node-side only, never shipped to a reader.

Astro inlines small component scripts into the page HTML and bundles larger ones
into `dist/_astro/*.js`. `AssetMap` is large enough to be bundled; `UtcClock` is
inlined. The two test harnesses locate their code accordingly — if a component
crosses that threshold, its harness needs updating.

### The map (`src/components/AssetMap.astro`)

Leaflet, self-hosted from npm. Reads, from `public/map/`: `ocean-assets.json`
(storms, gliders, USVs), `argo.json`, the current grids (`currents.json`,
`currents-atlantic.json`, `currents-arctic.json`, `tiles/`), and
`coastline.json` + `boundaries.json` (Natural Earth, RDP-simplified). All are
committed except the tiles.

Vector layers carry a **`className`, never a colour** — CSS owns their stroke and
fill so a theme switch restyles every path with no redraw. Adding a hardcoded
`color:` to a Leaflet path breaks dark mode; `npm run test:map` asserts against
this.

Layer stacking is deliberate, and there are two current panes rather than one:

| pane | z-index | holds |
| --- | --- | --- |
| `tilePane` | 200 | the basemap |
| `currents-raster` | 250 | Mercator speed raster — **multiplied** over the basemap |
| `currents` | 260 | particle canvas — **composites normally** |
| `overlayPane` | 400 | tracks, markers, and the Argo canvas |

Whichever basemap is selected, both current layers sit under every track and
marker, so the platforms are never obscured. The raster and the particles are
kept apart because the blend mode belongs to only one of them — see below.

The Leaflet map instance is hung on the container element as `_map`. Nothing on
the page reads it; the test harness does, and it makes the map pokeable from the
console.

### The date line, and why markers vanish past it

Vector markers exist in **one copy of the world**. Basemap tiles repeat
across copies, so panning east past the antimeridian shows ocean with no
platforms on it and the fleet looks sliced down the meridian. Measured
centred on 180°: the view spanned 82°E to 278°E, but only the floats
numerically inside 82–180 were drawn, because the rest sit at negative
longitudes one copy west — 983 of them against 1,694 once fixed.

`worldCopyJump` is **off**, and that is the fix for the flash rather than a
side effect. Its answer to this problem is to drag the *view* back to the
copy the markers live in, which it does by snapping the map pane a whole
world sideways mid-drag — measured at **2,028 px in one step**, with every
overlay pane teleporting and repainting. Panning across the date line
flashed the whole map. With markers re-homed instead, the view never needs
moving: the fleet comes to it. Turning the option off leaves no pane jumps
over 200 px across the same drag.

`rehome()` moves each point layer to the copy nearest the centre — one
marker each rather than three copies of every marker, which at four thousand
floats is 4,000 layers against 12,000, and no zoom this map offers shows a
view wider than one copy.

It moves **only markers that need to come into view**: anything already on
screen is left alone, and so is anything off screen in both copies. Wrapping
every marker was correct but visible — each `setLatLng` extends the canvas
renderer's redraw bounds, and once those span the canvas Leaflet clears and
repaints all of it. Dragging across the seam now moves ~200–280 markers on
the way out and **none** on the way back, since they are already home.

Point features only. Re-homing a track's vertices independently would tear
any line that legitimately crosses the seam.

The centre may now wander past ±180 after enough panning. Nothing minds —
positions are folded before they are shown — but `saveView()` wraps it,
because a stored view is read back much later.

### Argo floats

About four thousand dots, against sixty gliders and saildrones — which drives
three decisions:

- **Own file** (`public/map/argo.json`, ~61 KB gzipped). `ocean-assets.json`
  is re-fetched every hour by the auto-refresh poll; Argo does not belong in
  that.
- **Canvas renderer**, not SVG. That many vector elements would compete with
  the particle animation for the same frame budget. The cost is that canvas
  markers carry no class, so unlike the other platforms they **cannot be
  restyled by theme** — which is only acceptable because the colour clears
  both bathymetries in `test:contrast`.
- **Its own window, and this is the one thing here that is not a taste
  call.** `ARGO_DAYS = max(HISTORY_DAYS, 12)` — a float cycle plus slack. The
  shared five-day window suits a glider reporting hourly; applied to Argo it
  silently meant "half the fleet is mid-dive, so leave it off the map".
  Measured against Ifremer on 2026-08-02: **1,992 floats in 5 days, 3,881 in
  10, 4,138 in 15, 4,293 in 30**. The fleet is about 4,200 and five days was
  showing half of it, with no sign on screen that anything was missing.
  Twelve rather than the nominal ten because floats run late — ice
  avoidance, a missed satellite pass — and a window set exactly to the cycle
  clips whichever tail of the fleet is behind: 3,881 at 10 days against
  **4,027 at 12**. The window still follows `HISTORY_DAYS` upward; it just
  cannot be dragged below a cycle. Costs 61 KB gzipped against 30, and no
  measurable frame or hit-test time.
- **No tracks.** Even over a cycle most floats have one or two fixes, so
  there is nothing to draw a line through.

Note the canvas renderer culls to the viewport, so a test that counts draw
calls counts what is on screen, not the fleet.

### Data pipeline (`scripts/fetch-ocean-assets.py`)

Standard library only, so CI needs no Python dependencies. Aggregates NHC
storms (via KMZ), NOAA PMEL saildrones, and gliders from **four** regional
ERDDAPs into one JSON.

Gliders are national, so one server does not see the fleet: `GLIDER_SOURCES`
lists IOOS (US), NOC/BODC (UK), OTN (Canada) and VOTO (Sweden), taken from
the OceanGliders regional endpoints the European Glider Community publishes
and each verified to serve a working `allDatasets` listing and a fetchable
position. 38 → 52 gliders. The match pattern is **per server**, because they
name things differently: IOOS is glider-only so everything counts, OTN and
BODC say "glider"/"slocum" in the title, and VOTO titles datasets with the
glider's own name so its near-real-time naming convention is the tell. A dead
server costs only its own gliders. Coriolis has no machine endpoint and
`erddap.aodn.org.au` does not resolve, so Europe-wide and Australia are not
in yet. It runs
**server-side because NHC and PMEL send no CORS headers** — a browser cannot read
them directly. It also decimates ERDDAP queries server-side
(`orderByClosest("time/1hours")`) to keep the payload small, and falls back to
the previous file when a source is unreachable so an outage degrades to stale
data rather than an empty map.

`.github/workflows/deploy.yml` runs it hourly before the Astro build. **Nothing
is committed by CI** — the data is fetched into the build, so the repo does not
grow. A snapshot of `ocean-assets.json` is committed so local and offline builds
work; the 1/12° current tiles are the one input that is neither committed nor
fetched hourly (see below).

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
`test:map` catches it too, by comparing what actually reaches the canvas
against the palette file.

Where a colour genuinely cannot clear the bar, the exception is **named in
the palette with its reasoning** (`separationExempt`) and reported by the
gate, rather than the threshold being lowered — which would quietly cover
every future clash as well. Argo is the one such case: gold sits ~ΔE 18 from
the current particles, no yellow clears them, and paling the particle ramp
enough to make room drops its own water contrast to 79%. The dots carry a
dark outline instead, which separates a discrete dot from a drifting trail
whatever the fill does.

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

### Currents

Three depictions, from two different models, all named in the layer switcher
because they are not the same data:

- **Animated surface particles** (default) — `leaflet-velocity` over u/v
  grids built by `scripts/fetch-currents.py` from the **US Navy ESPC-D-V02**
  global forecast via HYCOM's OPeNDAP. Chosen because it is open; Copernicus
  publishes Mercator at the same resolution but its **numeric** access needs
  credentials, and its WMTS serves only pictures.
- **Animated 60 m particles** (off by default) — the same product one depth
  down, below the wind-driven layer and about where a glider flies.
- **Mercator speed raster** — **switched off**. `MERCATOR_RASTER = false` in
  `AssetMap.astro`: nothing is requested from Copernicus and the layer is not
  offered. The scaffolding stays — the `currents-raster` pane, the tile
  definition, the blend-mode CSS — so it is one flag to restore.

  It was also what `prefers-reduced-motion` readers got instead of the
  animation. With no still depiction left to offer, those readers now get
  **no** current layer rather than an animated one they did not ask for;
  both animated fields stay in the switcher to be turned on deliberately.

#### Depth is a dimension, not a second copy

`LEVELS` in `scripts/fetch-currents.py` is the only knob: every product below
is built once per entry, so adding `{'metres': 200, 'index': 22, ...}` builds
a 200 m global grid, regions and tiles with nothing else to change. Files are
suffixed (`currents-60m.json`, `tiles-60m/`); the surface keeps the bare
names. `check_depths()` verifies each level's index against the model's own
depth axis at run time — a shifted axis would otherwise publish the wrong
water under the right filename, which nothing downstream could detect.

**Each depth's global file links only to that depth's regions and tiles**, so
one chain of links is followed per layer and the tiers cannot cross. The tile
directory is derived from that file's `tileIndex`, not hardcoded: hardcoding
`/map/tiles/` had the 60 m layer drawing surface tiles — the right particle
count in the right places, all at the wrong depth, and nothing on screen said
so. `test:map` reads a synthetic tile whose velocity differs per depth, which
is what makes that detectable.

The two animated fields are **mutually exclusive** — two sets of drifting
lines over the same water cannot be told apart. That is enforced on
`overlayadd`, **deferred by a tick**: the layers control applies every ticked
box in one pass and re-adds anything it finds missing, so removing the other
field from inside that pass is undone, and the two adds then chase each other
until one tears down a layer whose first redraw is still queued. Waiting also
lets the control repaint its boxes, which it skips while handling a click.

#### Three tiers, finest that fits

| tier | spacing | used at | fetched |
| --- | --- | --- | --- |
| `tiles[-60m]/<south>_<west>.json` | 0.08° (1/12°) | zoom ≥ 7 | on demand, per view |
| `currents-atlantic[-60m].json`, `currents-arctic[-60m].json` | 0.24°, 0.48°×0.12° | zoom ≥ 5 inside the region | on demand, once |
| `currents[-60m].json` | 0.96°, global | everywhere else | with the page |

**The two upper tiers are chosen differently, and the difference matters.**
A *region* is used only when it contains the **whole** viewport — a partly
covered view would have flow on one side and nothing on the other. *Tiles*
are chosen by **overlap and joined**: containment was tried first and fails,
because a zoom-7 viewport is ~9° across against a 20° tile and straddles a
seam often enough that the map kept dropping back to the coarse grid as you
panned. Tiles share a spacing and a lattice, so joining is a copy into
offsets, not a resample.

Because regions use containment, **they must overlap rather than merely
touch**: an Arctic band starting at 60°N above an Atlantic region ending at
55°N left every view straddling 60°N — most of the Norwegian coast — back on
the coarse grid. `test:map` checks the overlap.

The map learns all of this from the **global file's header** (`details` and
`tileIndex`) rather than repeating bounds in the component, and swaps with
`setOptions({data})` only when the answer changes, since that restarts the
animation.

Region resolution is per region, because a degree is not a fixed distance. At
35°N a 0.24° cell is ~22 km across; at 66°N a 0.48° cell is 22 km wide but
0.12° of latitude is 13 km — **latitude binds at high latitude**, so the
Arctic grid spends its samples there. That grid is a **band over every
longitude, not a box**: adding one box per complaint does not converge, as
fixing Greenland while the Bering Strait stayed broken showed.

#### What the tiles cost

Built by `npm run data:tiles`; 159 of 162 exist per depth, the other three
being pure land. **They are gitignored** — 92 MB has no business in the repo
— so CI builds them and deploys them with the site, keyed on the model run so
hourly builds restore from cache instead of pulling from HYCOM twenty-four
times a day. `scripts/fetch-currents.py --run` prints that key.

Two depths means **two tile sets**, so the artifact and the daily tile run
both roughly double. The request *rate* on HYCOM's public server does not:
the depths are built one after another under the same four workers, so only
the wall clock doubles. Both sets share one cache entry, so a partial run is
never half-restored.

Two numbers that are easy to confuse, and I did confuse them when first
estimating this:

- **92 MB per depth is what the site weighs** — raw JSON in the deploy
  artifact, which Pages gzips on delivery. A build-and-deploy cost.
- **79–144 KB is what a visitor pays**, per tile, one to four at a time.
  Someone working a single region never fetches the other 150.

They are 0.08° × 0.08° rather than the model's 0.08° × 0.04°: true 1/12°,
isotropic, and half the size for a refinement that would apply to one axis
only. `TILES['stride']` is the one constant to change.

#### Grid geometry

- The global grid **must span a full 360° of longitude** — that is the exact
  condition leaflet-velocity uses to wrap across the antimeridian, and
  without it particles pile up against the edge.
- Longitude is therefore indexed with a **floored modulo**: grids start at
  0°E and half the world is west of that.
- A region straddling the **prime meridian** wraps in the model's 0–360
  longitudes and is fetched as **two slabs**, the second resuming the stride
  where the first stopped, or the columns either side are unevenly spaced and
  the grid is no longer regular. The first attempt silently produced 45° of
  longitude instead of 75, because the end index clamped at the array bound.
- A region straddling the **antimeridian** would additionally need a
  wrap-aware containment test in the component. None does today.

#### Land, and why particles used to stream across it

**leaflet-velocity does not treat a null as missing.** Its grid hands back
`[u, v]` — an array, so always truthy, so `isValue()` passes — and its
bilinear interpolation multiplies straight through, where `null` becomes
zero. A cell that is partly land therefore yields a reduced but *non-zero*
velocity defined over the land, and particles advect onto it and keep going.
Subsampling compounds it: taking every twelfth model node discards the
model's own mask, so at high latitude one sample decides a cell tens of km
across.

The pipeline erodes cells wedged into the coastline
(`COASTAL_DRY_NEIGHBOURS`). The threshold is **measured, not chosen**:
requiring one dry neighbour wipes out the Gulf Stream *and* the Kuroshio, two
still loses the Kuroshio's inshore core, three keeps both and cuts land
carrying flow from 7.8% to 2.1%. `test:map` brackets it from both sides —
continental interiors must be dry, and those two currents must survive.

A mitigation, not a cure: a coarse grid cannot represent a fjord coastline,
and an island smaller than a cell (Bjørnøya) sits in open model water
whatever the threshold. Zoom 7+ gets 1/12°, where this is far smaller.

**On currents looking perpendicular to a coast** — checked, and it is a
resolution artefact rather than a data error. The published grids match the
raw model point-for-point in direction (no u/v swap, no north–south flip),
and the field carries no net flow into land: mean onshore component +0.03,
where 0 is neutral, with near-symmetric tails. What changes with resolution
is how *parallel* the flow reads against a blocky mask — 0.65 at 0.96°,
barely above the 0.64 random directions would give, 0.71 at 0.24°, 0.73 on
the Arctic band. GEBCO also draws a far finer coastline than the model masks,
so flow parallel to the model's coast reads as oblique to the one on screen.

#### Particle rendering, four ways to get it wrong

All four were shipped and all four were silent:

- **They must composite normally.** The Mercator raster is multiplied over
  the basemap; while the particles shared that pane they were multiplied too,
  which all but deleted them — they are near-white, and multiplying by
  near-white changes almost nothing. Hence the two panes above.
  `test:contrast` reads the particle pane's name out of the component and
  fails if a blend mode reappears on it, because the whole gate assumes
  normal compositing.
- **Speed must cancel _two_ of the plugin's factors, not one.** It turns a
  velocity into a screen displacement by multiplying by the `velocityScale`
  you pass, then `mapArea^0.4`, then the projection's Jacobian — pixels per
  degree, which doubles every zoom level. Cancelling only `mapArea^0.4` is
  **worse than cancelling nothing**: that term is the plugin's own rough zoom
  compensation, so removing it leaves the Jacobian bare and particles
  accelerate as you zoom in. Shipped that way it ran 0.08 px/frame at zoom 3
  against 10.7 at zoom 9 — most of the map every second, reading as long
  dendritic streamlines rather than a flowing field. `scaleForView()` now
  divides out both, **measuring** the Jacobian off the map rather than
  assuming a projection.
- **The Jacobian must be measured with an unrounded API.**
  `latLngToContainerPoint()` rounds to whole pixels. The probe spans 0.1° of
  longitude, which is 0.28 px at zoom 2 — so the difference between the two
  probes rounded to **zero**, the Jacobian fell to its `1e-6` floor and
  `velocityScale` came out ~200× too high. Particles then crossed the map
  between frames, landed off-grid, and were respawned in place: 123k strokes
  of exactly zero length, a globe view with no currents on it, and no error
  anywhere. `map.project()` returns fractional pixel coordinates and is what
  the plugin distorts by. `test:map` samples **zoom 2** for this — z5 and z8
  both looked healthy throughout.
- **It is UMD and reads Leaflet off the global object**, which the bundled
  ESM build never sets. So it is loaded by dynamic import *after*
  `globalThis.L` is assigned — a static import would hoist above the
  assignment and the built bundle would die on `L is not defined`. The dev
  server hides this by serving Leaflet's UMD build, so **it breaks only in
  `dist/`**.

`npm run test:map` catches all four by recording the canvas draw calls: it
prints the per-frame displacement distribution, fails if particles go
sub-pixel, and **samples three zoom levels — 8, 5 and 2 — and compares**. A
single zoom could not tell a field that holds still from one that runs away,
which is how the acceleration shipped; two in the middle of the range could
not see the globe view collapse, which is how the rounded Jacobian shipped.
The recorder is **emptied per window** rather than sliced from a mark: it
stops recording at 400k segments, two windows reach that, and a third then
reads an empty tail that looks exactly like a field which stopped drawing.
Trail length is lifetime
× speed, so a runaway speed and an over-long lifetime look identical on
screen; measure the speed before touching the lifetime. `test:map` prints
both together for that reason.

**Lifetime is `PARTICLE_SECONDS`, in seconds**, converted to the plugin's
frame count on the way in — 4 s at 18 fps. It is what keeps the field evenly
covered rather than a cosmetic knob: particles are seeded at random but
advect into the fast cores and stay there, so a long life lets the picture
decay from a fine even texture into a few long bright ropes with bare water
between them, within a minute of opening the page. Respawning reseeds the
slow water. It was 5 s, which showed that decay clearly on a phone.

### Sea-surface temperature and salinity

Three fields, `npm run data:fields`, built by `scripts/fetch-ocean-fields.py`:

- **OISST** (NOAA/NCEI, 1/4°, daily) — an *analysis*: observations blended
  onto a grid, so it is what happened. Uses the **preliminary** product, not
  the final: final was 15 days behind on 2026-08-01 against 4 for
  preliminary, and a fortnight-old field has no business beside a live storm.
- **Navy ESPC-D-V02** (1/12°, hourly) — a *forecast*, and the same model the
  currents come from, so temperature and flow are one ocean rather than two.
- **Navy ESPC-D-V02 salinity** — the same variable file, so temperature and
  salinity are the same ocean at the same hour.

A field is just an entry in `PRODUCTS`: a variable name, a grid, strides per
tier, a plausible-value range and a file prefix. `FIELDS` in the component is
the matching half — a ramp, a unit and a rounding step. Adding another scalar
means one entry in each, not another layer.

#### The reader sets the colour scale

Colormap, range and a way back to automatic, per field, in the legend row
under the map rather than as a Leaflet control — number inputs and a select
inside the map are awkward on a touchscreen, and this is where the colour bar
they act on already is.

**Only the colormaps in `palette.colormaps` are offered, and that is the
point.** Whichever is chosen becomes the water under every marker, so the set
is exactly what `test:contrast` has checked — every stop of every map against
every feature. A free colour picker would let a reader hide the fleet. All
five were found by the search in `scripts/lib/colour.mjs`, scored on travel,
distance from the other maps, and clearance from the markers. Margins are not
equal: `mono` clears by 24.4 and `thermal` by 22.8, while `plasma` and
`terrain` sit at 22.1–22.2 — over the bar with nothing spare, and the first
things that will fail if a feature colour changes.

A pinned range **wins over the view and holds for the session**, including
across the hourly self-reload — the choices ride in the saved view alongside
the basemap and layers. Without that a pinned scale would silently revert
when a new build landed, which is the one thing "fixed until reset" must not
do. `Auto` hands it back to the view.

The **Reset** control beside Basin/Global puts everything back: basemap,
layers, colormaps, ranges, the measuring tool, and the basin view. It also
clears the saved view, because leaving it would mean the next reload restored
exactly what was just reset.

`DEFAULT_OVERLAYS` is **captured, not restated** — the set of layers on the
map immediately after startup and before `restoreView()`. Writing the list
out again would be a second source of truth, and it would be wrong for a
reduced-motion reader, who never gets the animated field.

**Salinity rounds the colour bar to half a unit where temperature rounds to
whole ones.** Both bound the water in view, but open ocean spans a few psu
against ten degrees or more, so whole-unit rounding would leave a typical
salinity view sitting in a corner of its ramp. Its ramp is green through cyan
to blue, chosen by the same search under one extra constraint — maximise
distance from the SST ramp, so two ocean scalars never read alike. ΔE 66 per
stop apart, clearing the markers by 28.6.

Every raster is mutually exclusive with every other, not just the two SSTs:
they share a pane, so the upper one hides the lower and the map would name
two fields while showing one.

Both are numeric grids drawn by a canvas layer in the `sst` pane (z-index
240, under the currents and under every track). Only one at a time —
stacking two rasters shows one field while naming two.

**The tiers differ per product, and OISST has no tile tier on purpose.**
Tiles exist to reach a product's native resolution; OISST *is* 1/4° natively,
so its region grids are that already and tiling below it would only
interpolate, for a second set of files and a daily build over them. Its
regions therefore start at zoom 4 rather than 5 — there is nothing finer to
hand off to, and at zoom 4 a 1° cell is ~11 px and reads as squares. The
Navy model is 1/12°, far finer than any region stride, so that is the
product where a tile tier actually buys resolution.

| product | native | global | region (zoom ≥ 4) | tiles (zoom ≥ 4) |
| --- | --- | --- | --- | --- |
| OISST | 0.25° | 1° | **0.25°, native** | none, by design |
| Navy | 0.08° | 0.96° | 0.16°, fallback only | **0.08°, native** |

**Navy SST is served at native resolution over the whole globe from zoom 4**,
not just over two regions. The tile threshold is 4 rather than the 7 the
current tiles use, and the arithmetic is different because the payload is:
a current tile carries u *and* v, while an SST tile is one variable at one
decimal and gzips to **26 KB**. A zoom-4 viewport touches ~18 tiles, so ~470
KB on the wire — less than the single Arctic regional grid it displaces, for
0.08° everywhere instead of 0.16° in two boxes. Below zoom 4 the count runs
away (~44 tiles at zoom 3, all 162 at zoom 2) and a degree cell is under
three pixels anyway, so the coarse global grid serves there.

The regional grids stay as a **fallback**: tiles win whenever the index
loads, so the regions are only consulted if it does not. Changing
`TILES['minZoom']` does not change a tile, but it does change the index, so
the CI cache key carries a version — a cache hit would otherwise keep
publishing the old threshold.

**The finer model must look finer.** The Navy region stride is 0.16°, not the
0.24° the current grids use off the same model — the currents carry u *and*
v, so the same payload buys half the cells, and copying their stride rendered
a 1/12° model at 0.24°, indistinguishable from OISST's native 0.25° at every
zoom below the tile tier. Native 0.08° at region scale would be 3.4 MB for
the Atlantic and 9.2 MB for the Arctic band; the tiles exist for that.

The global grids stay coarse deliberately: 0.25° globally would be four
times the payload with the page, and at globe zoom a 1° cell is already
about three pixels.

**There is no WMS to point at, and that was measured rather than assumed:**
`wms.hycom.org` does not answer from two separate networks, nor does
`coastwatch.pfeg.noaa.gov`, and NCEI's ERDDAP is up but replies "not
accessible via WMS". GEBCO's WMS loads fine from the same probe, so the
probe is sound. Shipping grids instead also lets the readout report a
temperature with no request.

Three things about this cost real time, all silent:

- **ERDDAP writes a missing value as an empty field**, where THREDDS writes
  `NaN`. The currents parser skips empty fields — there they only ever mean a
  trailing comma — so land was dropped rather than marked and rows came back
  ragged and shifted west, 81 wide over Antarctica against 360 in open water.
  The parser now takes the width it asked for and raises on a mismatch.
- **`www.ncei.noaa.gov` advertises an AAAA record that refuses connections.**
  urllib has no Happy Eyeballs, so every request waited out the full TCP
  timeout: 120 s each against 0.9 with curl. `fetch-sst.py` prefers IPv4.
- **The ramp stays out of the warm half of the wheel**, and that is forced.
  `test:contrast` treats every ramp stop as another water colour the markers
  must clear, and a conventional blue-to-red end fails it: orange USVs sat
  ΔE 9.3 from a warm-amber stop, the storm red 16.3 from a brick one, against
  a bar of 22. The warm end of an SST ramp is the tropics, which is where the
  storms are. The cold end stays off black because the charcoal measuring
  line lives there, and the warm end short of pale because the particles are
  near-white cream.

  Within what is left, the ramp is **chosen by search, not by eye**:
  `scripts/lib/colour.mjs` scores a candidate on how far it travels
  perceptually end to end, and the winner is the most-travelled ramp still
  clearing every feature by ΔE 22. The current magenta-violet-blue-cyan-green
  covers ΔE 122 against 44 for the muted band it replaced.

**The Navy field records its model run; OISST does not, and should not.** A
forecast step valid an hour from now is worthless if it came from a run three
days old, and without the run written on the file there is nothing to tell
the two apart — which is exactly how the currents sat two days stale while
looking current. An analysis has no run; its own date is the answer. The
layer's attribution says whichever it has, so staleness is visible on screen
rather than only in a header.

The raster is painted **fully opaque**, and that is load-bearing: the gate
checks the markers against these exact ramp colours, so blending with the
bathymetry underneath would put a different colour on screen than the one
that was checked.

**The range is per view, not fixed**: the whole-degree bounds of the water on
screen, recomputed on every move, with the legend printing them. A fixed
global scale wastes almost all of the ramp, since a basin spans maybe ten
degrees of the thirty-odd the ocean covers, and everything came out within a
couple of shades of itself. The cost is that a colour no longer means the
same temperature between two views — which is exactly why the bar carries
numbers rather than being a fixed key. The extremes are found on a coarse
stride; sampling every sixteenth pixel finds them as well as sampling all
650,000.

**Longitude wraps, and forgetting it leaves a stripe.** These grids start at
the prime meridian and span exactly 360°, so the column after the last is the
first. Clamping there instead left a one-cell band nothing painted, with the
dark basemap showing through as a line down the map at 0°E. `test:map` checks
it over the **South Atlantic** — at 20°N the meridian crosses the Sahara,
where that column is unpainted either way, and the first version of the check
passed against the very bug it was written for. It counts *runs* of empty
columns for the same reason: the gap is a whole cell wide, so a
single-column test finds nothing.

Sampling is bilinear in two steps. The nearest cell decides whether a pixel
is water at all, which keeps the shoreline where the data's mask puts it;
the value is then averaged over whichever neighbours are water, weights
renormalised. Refusing to interpolate beside land was the first attempt and
it left the open ocean smooth while the whole continental shelf stayed a grid
of squares.

#### Never hardcode an index into the aggregation

Both pipelines asked for `time[0:1:128]`, which worked until the FMRC "best"
aggregation got shorter. On 2026-08-02 it was **121 steps**, so index 128 was
out of range and every fetch returned 400. The fallback then kept the
previous file and the build reported success, so the map served the
2026-07-31 run for two days while looking healthy. The only visible symptom
was the run date in the map's own attribution, which is how it was noticed —
by a reader, not by CI.

`time_axis()` reads the length from the `.dds` now, and the fallback prints
how old the data it kept is rather than a neutral "keeping the previous
fields". Neither change makes a stale map fail the build, deliberately: an
outage should degrade to stale rather than block a deploy. What changed is
that the log says so.

#### HYCOM fails per request, not outright

Worth knowing before debugging anything against it. Its aggregation serves
some time steps and not others: measured on 2026-08-02, index 70 returned a
full global field while index 76 answered 500 "Stale file handle" for the
identical request, minutes apart, and a small read that had just succeeded
failed on the next try. Metadata (`.das`, the time axis) keeps working
throughout, so the server looks healthy.

Two things follow, both in `fetch-sst.py`:

- **The time step is probed before it is used.** `usable_step()` walks the
  eight steps nearest now, testing each with a handful of cells, and takes
  the first that answers. Picking the nearest and giving up loses the whole
  field to one bad member file when the step an hour either side is fine.
- **A failed tile is not an empty tile.** Those were conflated, and a run
  against a flaky server wrote 81 of 162 tiles and reported "81 empty" as
  though that were the coastline. Tiles are retried three times, failures
  are counted separately, and any failure fails the run — a short index is
  otherwise invisible, because the map just reads the coarse grid over the
  missing water and says nothing.

The current pipeline has neither guard yet; it degrades to the previous file
instead, which is why an outage there shows up as stale rather than wrong.

### Measuring, and the point readout

Two tools on the hurricane map, both in `AssetMap.astro`.

**Measure** (📏 in the top-left bar) takes clicks and reports great-circle
distance per leg and overall, in **km and nautical miles**, with the initial
bearing in degrees true. Escape clears it. Distance and bearing are both
great-circle: a rhumb line is what you would steer, but quoting the two from
different geometries invites the reader to combine them.

**Hovering a point asset names it beside the pointer** — a sticky Leaflet
tooltip, so it tracks the cursor rather than anchoring to the shape's centre,
which on a wide tap circle or a track is nowhere near where you are pointing.
Bound only where a mouse exists, and the test is `!matches('(hover: none)')`
rather than `matches('(hover: hover)')`: the negative form treats an unknown
answer as a mouse, so a browser that does not support the query keeps the
labels instead of quietly losing them. On a touchscreen Leaflet opens a
tooltip on tap, which would fight the popup for the same gesture.

Positions everywhere — popups, readout, measure tooltips — are **degrees and
decimal minutes**, which is what a chart, a GPS and a float's own position
report speak, so a reader can compare without arithmetic in between. One
`coordText()` formats them all. Two details in it are easy to get wrong and
look almost right: the minutes carry into the degrees, or 59.999′ prints as
`45° 60.00′`; and longitude is padded to three digits, since `067°` and `67°`
scan differently down a column.

**Every point asset's popup carries the same ocean block** — seafloor,
current at whichever depth is showing, and SST when a temperature layer is
on — under its own details, separated by a rule. One `oceanRows()` builds it
for both the popups and the readout, so the two cannot drift. Point features
only: a track or a forecast cone has no single position to sample, and the
reader can right-click anywhere along one.

**Right-click, or long-press on touch**, reports position, seafloor depth and
the current **at the depth of whichever animated field is on** — the readout
names it, because calling 60 m water "surface current" would be wrong with
nothing on screen to give it away. Leaflet raises `contextmenu` for the mouse; **iOS Safari
does not raise it reliably from a long press**, so touch is timed manually
(550 ms, cancelled by a drag of more than 10 px so a pan is not a press).

The current comes out of whichever grid is already loaded — no request, and
it is the same field the particles follow. **Depth is the only part that
needs the network**, and the source was not free to choose: GEBCO's WMS
advertises `GetFeatureInfo` on a queryable layer but returns "no results" in
every geometry; OpenTopoData answers correctly but sends no
`Access-Control-Allow-Origin`; HYCOM's THREDDS sends none either. NOAA's
**ArcGIS ImageServer DEM mosaic** does, and answers a point in under a
second, which removed a planned 35 MB of pre-generated bathymetry tiles.
Depth fills in asynchronously, so a slow or failed lookup never delays the
position.

The measuring line is **dark with a light halo**. Charcoal was the only
candidate clearing both bathymetries while staying clear of every feature
colour. The halo is an outline, so like the track casings it is themed in CSS
rather than gated — and note it needs its variable in **all three** theme
blocks; it was first added to only the dark ones, which left light mode
drawing a stroke with no colour.

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
