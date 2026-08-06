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
npm run data:wind    # ECMWF 10 m wind (needs eccodes — see below)
npm run data:field-tiles # the Navy field tiles (OISST needs none — see below)
npm run data:basemaps # re-sample basemap ocean colours (needs Pillow; slow, GEBCO's WMS)
npm run data:bathymetry # contour GEBCO into the isobath layer (needs a local grid; once)
npm run data:bathy-tiles # just the 20-100 m tiles of that
npm run data:coastline # rebuild the offline coastline basemap (Natural Earth; once)
npm run test:units   # the map's renderer-independent modules, directly
npm run test:schema  # every published file against the contract in schema.ts
npm run test:multimap # two maps on one page stay out of each other's way
npm run test:contrast # map colours stay visible on both bathymetries
npm run test:map     # headless test of the built map bundle
npm run test:clock   # headless test of the built UTC clock
```

`test:units` is the odd one out: it needs no build, no jsdom and no fixtures,
because `geo.ts`, `ramp.ts` and `tiles.ts` import neither Leaflet nor the DOM.
It imports the TypeScript through Node's own type stripping and calls the
functions. Every case in it is one a source comment claims to handle — a
comment saying "minutes carry into the degrees" is a promise, and that file is
where it is kept.

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

It covers the package's own docs too — `packages/ocean-map/README.md`,
`BOUNDARIES.md`, `EMBEDDING.md` and `PORTING-IOS.md`. Those are hand-offs for
work nobody has started, so they are the documents most likely to rot
unnoticed: no one reads them week to week to catch a path that moved.

Paths are checked **with and without their directory**. Prose names scripts
both ways, and a rename leaves the bare mentions dangling while every full
path still resolves — which is how three references to a since-renamed
`scripts/fetch-ocean-fields.py` survived a doc sweep.

It also checks that **every source the map can credit is described on the page
carrying it**. The hurricane page went two whole layers out of date before
this existed — the isobaths and the EMODnet shoreline were both in the map's
attribution control while the prose still credited GEBCO only as a basemap,
and nothing noticed, because the page and the map are edited at different
times for different reasons. Credits are read from both places they live: the
attribution strings in the module, and the `source` fields the pipelines write
into the data. Adding a feed to either fails this until the page says where it
came from, and crediting something the map does *not* show fails too — which
is what keeps Copernicus off the page while `MERCATOR_RASTER` is false.

Where the page words a name differently — `US IOOS Glider DAC` against
"US IOOS Glider Data Assembly Center" — the difference is **named** in
`WORDED_AS` rather than matched loosely. A fuzzy match on "NOAA" would pass
for any of five separate feeds.

It guarantees that every crediting *organisation* is named, not that every
layer's role is described: GEBCO supplies both a basemap and the isobaths, so
dropping the isobath paragraph leaves the name on the page and passes.
Matching the role would mean holding prose to strings like "isobaths" when the
page reasonably says "depth contours", and a check that cries wolf gets
switched off.

It also checks **numbers the docs quote from the code** — the tile zoom
threshold, the coastal erosion threshold, the particle lifetime, the Argo
cycle window, the refresh window, how many frames the currents publish and
how many glider sources there are — by reading each from its own source
file. Every one of those has gone stale at least once. The document is
whitespace-normalised before matching, because these files are hard-wrapped
and a claim can straddle a line break; without that the check reports drift
that is only a newline.

**A claim has to be specific enough to be falsifiable.** The refresh window
was first matched as "six-hour", which passed for `REFRESH_HOURS = 3`
because the prose already described the model's own 3-hourly steps — a
different quantity that happens to share a word. It matches "six-hour
boundary" now. Mutation-test a doc claim by changing the constant, not by
reading the regex.

**It also holds two constants against each other**, which is not a docs
check at all but lives here because this is where numbers are read out of
source. The two ESPC pipelines must snap to the same `REFRESH_HOURS` and
resolve the same window width: they select their step independently — same
rule, two copies, because each is a standalone standard-library script —
and a mismatch puts one hour of temperature under another hour of current.
`test:schema` catches it in the published data, which is stronger; this
catches it before anything has been asked of HYCOM.

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

### The map (`packages/ocean-map/`, placed by `src/components/AssetMap.astro`)

> **Before changing the map, read `packages/ocean-map/BOUNDARIES.md`.** The
> package exists to be used twice more — in another website, and as a native
> iOS app — and both depend on separations that are easy to breach by accident
> and expensive to restore. Every rule there has a test behind it and every one
> was learned by breaking it. `packages/ocean-map/EMBEDDING.md` and
> `packages/ocean-map/PORTING-IOS.md` are the hand-offs for those two jobs.
>
> The short form: renderer-independent logic goes in `geo.ts`, `ramp.ts`,
> `tiles.ts` or `schema.ts` and never imports Leaflet or the DOM; every fetch
> goes through `dataBase`; file shapes change in `schema.ts` first; colours live
> in the palette; nothing is document-scoped or assumes a single map.

**The map is an npm workspace package now; the component is its placement on
this site.** `packages/ocean-map` is `@c4po/ocean-map`, imported by name, with
Leaflet as its only peer dependency — the animated fields are drawn by the
package's own layer now. Its `exports` point
straight at the TypeScript — there is no build step for the package, because
the only consumers are in this repo and Vite compiles it as source.

What lives inside it is everything the map cannot do without: the module, its
stylesheet, the schema, the palette and the sampled basemap colours, and
`storm-status.ts`. That last one moved because a package cannot reach back
into the app consuming it — `StormStatus.astro` imports it from the package
now, which is the right direction anyway, the formatting being the map's and
the component being a consumer.

**`check:docs` had to learn about `packages/`.** Its path check only matched
`src|public|scripts|.github`, so every doc reference under the new directory
would have gone unvalidated — the guard would have kept saying `ok` while
pointing at nothing.

**The module is a plain module; the component is its placement.** `packages/ocean-map/index.ts` exports `createOceanMap(host, options)`
and `mountOceanMaps(scope)`, with no Astro in it, so another project imports
it directly — see `packages/ocean-map/README.md`. `AssetMap.astro` is down to
markup, styling and a two-line call.

That split moved two gates. `check:docs` reads the particle lifetime from the
module now, and `test:contrast` reads **both** files — the module names the
particle pane, the component styles it, and a blend mode reappearing in
either place is what the check exists to catch.

**Watch the closing tags when slicing this file.** Lifting the script out by
line range left a stray `</script>` before `<style>`, which Astro swallowed
along with the entire stylesheet — the map came up unstyled and the only thing
that noticed was `test:map`'s guard on the pane-SVG rule. The build did not
complain.

**The renderer-independent half is now its own set of modules**, which is the
seam an iOS port turns on: `geo.ts` (bearings, degrees-and-decimal-minutes,
spans, timestamps, the graticule's step ladder and labels), `ramp.ts` (colour
ramps) and `tiles.ts` (which tiles a view needs). None imports Leaflet or the
DOM — they typecheck standalone — so a
native port reimplements only the drawing. `Point` is a plain `{lat, lng}`,
which `L.LatLng` satisfies structurally, so callers needed no conversion.

`tiles.ts` also collapsed **three copies** of the tile-selection arithmetic —
one each for currents, fields and isobaths — that were identical but for
whether they returned `null` or `[]`, and only one of which deduplicated its
keys.

Those modules are **mutation-tested**, and it was worth it: of nine deliberate
faults, three survived the first pass. Two were the harness miscounting a
thrown exception as a pass. The third was real — the antimeridian test only
panned *east*, where a bare remainder agrees with a floored modulo, so
replacing the fold with `%` broke nothing. Panning west is what distinguishes
them, and there is now a case for it. A fourth gap turned up the same way: the
latitude loop's `<=` could become `<` unnoticed, because no view in the suite
ended exactly on a lattice line.

The remaining seams, in order of what they unlock:

- **One engine, several pages.** `/visualization/` and
  `/observations/hurricanes/` are the same map. What separates them is a
  **preset** — the `layers` option, a list of overlay names as the switcher
  shows them, plus `home` bounds — passed as props to `AssetMap.astro` by each
  page. The generic map opens on sea-surface temperature under the surface flow,
  with the shorelines, borders and grid, across the whole ocean; the
  hurricane map opens on the fleet, SST, isobaths and the graticule over the
  Atlantic.

  **A preset is a bandwidth decision as much as a visual one**, and the
  generic page is the case in point. Every layer named in a preset is
  *shown*, and a shown layer fetches — the lazy-loading rule that keeps
  unused layers free does not apply to the ones the page asks for. Measured
  against the live host: SST 47 KB gzipped, the currents 117, the borders 68
  — and **2,916 for the deep isobath tier**.

  So the isobaths were in this preset briefly and came straight back out.
  With them a first load was **3.07 MB with 95% of it in contours** that, at
  globe zoom, are faint lines under a saturated colour scale; without them
  it is **232 KB** and the picture is very nearly the same. They are one
  click away in the switcher, which is where a 3 MB layer belongs. The
  hurricane page keeps them because it opens on the Atlantic at a zoom where
  the shelf break is the point. Neither knows anything the other does not.

  `DEFAULT_OVERLAYS` is still *captured* rather than restated — the preset is
  applied first, then the defaults are read off the map, so Reset returns to
  the page's preset and there is still only one place deciding what "default"
  means. Animated layers are dropped from a preset for a reduced-motion
  reader: a preset is the page author's wish, and the reader's wins.

  A misspelt layer name would do nothing at all — no error, just a layer that
  never comes on — so `check:docs` reads the names out of the module's
  `overlays` object and fails on any preset naming one that does not exist.

- **Configuration** comes off one `CONFIG` object — data base URL, home
  bounds, storage key — read from `data-map-*` attributes on the container
  when present, so markup can configure it with no build step. Eleven
  hardcoded `/map/...` paths now hang off `DATA`.
- **Styling** no longer assumes the site. All 87 `var()` uses in the style
  block carry fallbacks lifted from `src/styles/tokens.css`; before, exactly
  one did, and the map dropped into a foreign host came up with an unstyled
  control row and invisible text.
- **It is no longer a singleton.** It used to find itself by id, read its
  status line by id and reach across the document for its controls — fine for
  one instance, impossible for two, since both would share an id and
  `getElementById` would hand each of them the first. Every container matching
  `[data-ocean-map-canvas]` is now initialised separately and scopes its
  lookups to the nearest `[data-ocean-map]` ancestor.
  `test:multimap` is what makes that claim real rather than argued — two
  containers, their own homes, their own storage keys, their own controls. It
  found a bug the moment it existed: **both maps adopted the page-level storm
  status line**, wired the same zoom buttons and fought over where a click
  sent the view. Refusing to adopt whenever a page has several maps was the
  first fix and was worse — with two maps *nobody* claimed the line and it
  stopped updating at all. The line is now claimed by the first map to ask and
  marked with its id, which is also the only thing that distinguishes one
  claimant from two: with a single box on the page, counting marked boxes
  gives 1 either way, and the check caught nothing until it asserted *which*
  map holds it.

  It has its own harness rather than a case in `test:map`, for a measured
  reason: a second map animates too, and both particle fields land in the same
  recorded canvas, which skewed that file's per-frame displacement statistics.

- **Styling travels with it.** `packages/ocean-map/ocean-map.css` is imported
  by the module. Two changes made that possible and both matter: every rule
  keyed off `#asset-map`, an id, which matches at most one map per page — they
  key off an `ocean-map` class the module applies instead; and Astro's
  automatic scoping is gone, so the six shared class names (`legend`, `key`,
  `status`, `field-controls`, `bathy-controls`, `fallback`) carry an `om-`
  prefix rather than leaking into the host page. `.om-vh` is duplicated from
  the site's own utility deliberately — leaning on a host to define it is the
  kind of invisible dependency whose failure is silent.
- **`index.ts` is being split, one seam at a time.** It reached 4,542 lines in
  a single closure, which is a problem of *ordering* rather than size: three
  bugs in one session were use-before-declaration inside it, invisible to
  `astro check` because each sat in a callback that could not run until later.
  A module boundary turns that into a signature.

  Out so far: `graticule.ts` (the lat/lon grid), `measure.ts` (distance and
  bearing) and `scalar-layer.ts` (the field raster, `FIELDS` and
  `FieldDescriptor`) — about 500 lines, taking it to ~4,030. Each one was
  taken alone, with `npm run verify` and a browser check between, because the
  failure mode of a half-finished move is a tree the next session has to
  finish rather than a clean start.

  The rule that has held: **behaviour moves, the reader's state stays.**
  `choices` and `particleTint` are per map, and a module-level copy of either
  would put two maps on a page back to sharing one — the singleton bug this
  package already paid to remove.

  Remaining seams, roughly in order of independence: the isobath tiers, the
  KMZ drawing side (`kmz.ts` and `warp.ts` already hold the parsing), the
  point readout, and the chrome/controls block.
- **Still to do**: the chrome markup is the host's, so a second site
  reproduces the legend and controls; and
  the fleet is assumed — the legend names hurricanes, USVs, ocean gliders and
  Argo, and the layer switcher matches. Against that, the renderer-independent
  half has kept growing — `geo`, `ramp`, `tiles`, `schema`, `warp`, `kmz`, now
  about a fifth of the package by line count.

Moving the stylesheet turned up **two fetches that ignored `dataBase`** — the
isobath tiles and the hourly refresh poll. Both are template literals, and the
sweep that rewrote the quoted paths never matched them, so a deployment
pointing `dataBase` at another host would have fetched those two from its own
origin. `test:map` now reads the module source and fails on any `/map/`
outside the option's own default.

**Keep logic that does not touch `L.` out of the Leaflet path.** An iOS port
would reuse the pipelines, the JSON schemas and tile lattice, the palette and
its gate, and every measured decision here — and reimplement only the drawing.
Colour ramps, coordinate formatting, grid sampling and tile selection are all
renderer-independent and are the natural next things to lift out.

Two things that bit while doing it, both worth not repeating. The storage key
was briefly derived from the container id, which silently changed the key
this site's readers already hold saved views under — the component pins its
own key in markup and only the *generic* default is derived. And the
zoom-to-storm buttons must be scoped to `[data-storm-status]`, not to the
map's figure: the status line is a sibling component that may sit either side
of the figure boundary, and scoping to the figure found a stand-in in the
caption and then never reached the real buttons the box had just been rebuilt
with.

Leaflet, self-hosted from npm. **The data is not in this repository.** It is
served from `MAP_DATA` (`src/config.ts`), which points at the ocean-data
repository — see "Where the data lives" below. The map reads
`ocean-assets.json` (storms, gliders, USVs), `argo.json`, the current grids
(`currents.json`, `currents-atlantic.json`, `currents-arctic.json`,
`tiles/`), the isobaths, and the Natural Earth coastline and borders.
`coastline.json` is fetched only when its basemap is chosen — see Basemaps.

The pipelines still write into `public/map/` when run locally, so a developer
can point `dataBase` at their own machine; the directory is gitignored.

Vector layers carry a **`className`, never a colour** — CSS owns their stroke and
fill so a theme switch restyles every path with no redraw. Adding a hardcoded
`color:` to a Leaflet path breaks dark mode; `npm run test:map` asserts against
this.

Layer stacking is deliberate, and there are two current panes rather than one:

| pane | z-index | holds |
| --- | --- | --- |
| `tilePane` | 200 | the basemap |
| `sst` | 240 | the scalar field raster (SST or salinity) |
| `bathy` | 245 | isobaths + coastline — above the field, under the flow |
| `currents-raster` | 250 | Mercator speed raster — **multiplied** over the basemap |
| `currents` | 260 | particle canvas — **composites normally** |
| `eez` | 270 | EEZ boundary WMS images |
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
floats is 4,000 layers against 12,000.

**That rests on one copy of the world always covering the viewport, and for
a while it silently stopped being true.** It had been true by accident,
because the map's width was capped; uncapping it (see "How big the map is")
let a wide window outrun the world at the minimum zoom. Measured on an
1858 px container at zoom 2, where the world is 1024 px across: **1.81
copies on screen, a 653° view, and 4,017 floats spanning 360° of it** — so
about 45% of the width was ocean no platform could ever occupy. Reported
from a wide window as a fleet that stops dead at both edges.

**The minimum zoom is now the zoom at which one world fills the container**,
not the constant 2 it used to be — `minZoomForWidth` in `geo.ts`, applied at
startup and on every resize by the same ResizeObserver that refits the map.

**A fractional zoom has to be declared, not merely used**, and skipping that
shipped a visibly broken basemap. Leaflet supports a fractional zoom only
when `zoomSnap` is 0; left at its default of 1 it rounds every requested
zoom to a whole number while the map actually sits at 2.41, so its
tile-range arithmetic and its transform disagree and the basemap comes up
partly tiled — reported as a cross of tiles over empty space. `zoomSnap: 0`
with `zoomDelta: 1` keeps the +/- buttons stepping a whole level. Measured
after, on a 1758 px container at minZoom 2.78: **100% tile coverage** on
arrival, at the minimum, and after a zoom round trip, with 40 tiles where
the broken configuration left 12.

**Continuous zoom then needed its own sensitivity, and that is a second
consequence of the same option.** `zoomSnap: 1` had Leaflet round a wheel
gesture *up* to a whole level, so any tick moved a full zoom however small
it was. Removing the snap leaves the raw amount: measured, a 100 px tick
gave **0.197 levels**, about a fifth of what the same gesture used to do,
and it was reported as zooming too slowly.

`wheelPxPerZoomLevel` is how many scroll pixels make a level, so it is the
direct knob — 20 rather than the default 60. Measured after: a 100 px tick
gives **0.57 levels**, a 53 px tick 0.31, a small 20 px nudge 0.119, zoom
out is symmetric at −0.57, and the +/− buttons still step exactly 1 because
`zoomDelta` is untouched. Responsive enough to cross a few levels in a
gesture while keeping the smoothness that not snapping is for.

Nothing in `verify` caught it: jsdom loads no tile images, so the harness
cannot see which part of a container a basemap covers. It was found by
looking at the map.

It is **fractional**, and that is the part worth keeping. Rounding up to a
whole level was the first idea and is worse: between 1025 and 2047 px it
jumps to a zoom showing half the world, so the reader loses the global view
to fix an edge artefact. Leaflet snaps a requested zoom *before* clamping it
to `minZoom`, so a fractional floor survives the +/− buttons and the wheel
with no change to `zoomSnap`. Measured after: 1858 px gives minZoom 2.86,
the world exactly 1858 px wide, **1.000 copies**, a view spanning exactly
−180 to 180, and floats reaching both edges with no empty tenth of the
width.

Narrow screens are untouched — at 1024 px and below one world already covers
the viewport at zoom 2, so the floor wins and a phone keeps its zoom-out.

Duplicating markers into the neighbouring copies is the other fix and is the
one this package already rejected, for the reason in the paragraph above.
`test:units` holds the invariant across nine widths, mutation-tested against
both the shipped bug (a constant floor, which fails six of them) and the
whole-level rounding (which fails the two that say it must be fractional).

It moves **only markers that need to come into view**: anything already on
screen is left alone, and so is anything off screen in both copies. Wrapping
every marker was correct but visible — each `setLatLng` extends the canvas
renderer's redraw bounds, and once those span the canvas Leaflet clears and
repaints all of it. Dragging across the seam now moves ~200–280 markers on
the way out and **none** on the way back, since they are already home.

Point features only. Re-homing a track's vertices independently would tear
any line that legitimately crosses the seam.

**The isobaths needed their own version of this, and went out without it.**
Contours are lines, so `rehome()` skips them — which meant a contour written
at −179 was drawn a full 360° west of a view panned east past the date line,
and the seafloor vanished down one side of the map while the floats beside it
stayed put. Reported from a North Pacific view where everything west of the
meridian was bare.

A contour is safe to move **whole**, though, and that is the difference: each
depth is one polyline holding many independent sub-lines, so shifting an
entire sub-line by 360° cannot tear anything — the shape is untouched, only
which copy it sits in.

**Each sub-line is homed separately, and that part is not optional.** One
shared shift for the whole layer was the first fix and it is wrong exactly
where it matters: a view sitting *on* the antimeridian needs the contours
west of it in one copy and those east of it in the next, so whichever way a
single shift moves, half the map comes up bare — which is what it did, and
what was reported the second time.

`rehomeBathy()` therefore mirrors `rehome()` rather than approximating it,
including the part that makes it cheap: it moves only what needs to come
*into* view, leaving alone anything already on screen and anything off screen
in both copies. Without that, sub-lines on the far side of the world flip
copy on nearly every pan — and because a whole depth is one polyline, a
single flip rewrites half a million points. Longitude spans are cached per
sub-line so the common case is a comparison, not a rebuild.

The centre may now wander past ±180 after enough panning. Nothing minds —
positions are folded before they are shown — but `saveView()` wraps it,
because a stored view is read back much later.

### Argo floats

About four thousand dots, against sixty gliders and saildrones — which drives
three decisions:

- **Own file** (`argo.json`, ~61 KB gzipped). `ocean-assets.json`
  is re-fetched every hour by the auto-refresh poll; Argo does not belong in
  that.
- **Canvas renderer**, not SVG. That many vector elements would compete with
  the particle animation for the same frame budget. The cost is that canvas
  markers carry no class, so unlike the other platforms they **cannot be
  restyled by theme** — which is only acceptable because the colour clears
  both bathymetries in `test:contrast`.
- **Its own window, and this is the one thing here that is not a taste
  call.** `ARGO_DAYS = max(HISTORY_DAYS, 12)` — a float cycle plus slack. The
  shared window suits a glider reporting hourly; applied to Argo it
  silently meant "half the fleet is mid-dive, so leave it off the map".
  Measured against Ifremer on 2026-08-02: **1,992 floats in 5 days, 3,881 in
  10, 4,138 in 15, 4,293 in 30**. The fleet is about 4,200 and five days was
  showing half of it, with no sign on screen that anything was missing.

  `HISTORY_DAYS` has since gone to 10, which narrows the gap but does not
  close it — 3,881 floats against 4,027 at twelve — so the floor still
  earns its place. The `max()` is what makes that safe: raise the shared
  window past twelve and Argo simply follows it up.
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

### Where the data lives

**Not here.** `MAP_DATA` in `src/config.ts` points at
`https://oceansensing.org/ocean-data-repo/map/`, and
[that repository](https://github.com/oceansensing/ocean-data-repo) fetches
on its own hourly schedule at :05 and publishes to its own Pages site.

Two reasons, and both were measured before the move.

**History.** A repository that commits what it fetches keeps every superseded
version forever. This one had banked **356 MB of dead model grids for 130 MB
of live data** — 88% of all blob history — and none of it is reclaimable
without rewriting history. Over there the real-time data is fetched into the
Pages artifact and never committed, so the previous run is simply gone.

**The Pages cap.** A published site is capped at 1 GB. With a tile set per
forecast hour this one reached **~904 MB, 90% of it**, and one more layer
would not have fitted. The data repository is on a *separate account*, so it
has its own gigabyte and its own bandwidth allowance.

**Where that stands now** (measured 2026-08-04, six tiled products including
the two ice sets): the Pages deploy artifact is **57 MB compressed**, the
committed static half is **134 MB** — 118 of it `bathy-tiles` — and the
uncompressed published tree was roughly **500 MB**, about half the cap. The
estimate is the committed half plus the grids plus the tile sets at their
documented raw sizes; nobody has summed the deployed tree exactly.

**The currents' second frame spends about 184 MB of that**, and the tree is
now **678 MB** — measured on the deploy rather than estimated, `du -sh` on
the assembled artifact, against a prediction of 684. See "Which hour is
published" below for why it is worth it. What is left is the headroom, and
it is about a third of the cap rather than half.

The two current frames account for **367 MB** of it across both depths
(92.0, 92.0, 91.3 and 91.4 MB), and the four field tile sets for 138 MB —
the ice thickness set being the cheap one at 14.5 MB over 65 tiles, most of
the ocean having none.

**What holds the rest down is one frame per field.** The 904 MB was five
forecast hours with a tile set each, across every product. The fields stay
at one, so their sets do not multiply and the ice layers cost almost
nothing: all four field tile sets together cache to **6 MB compressed**,
because most of the ocean is a field of zeros and ice tiles compress about
200:1. Adding frames to the *fields* is the change that takes this over the
cap — six tiled products now rather than four, so it is a steeper
multiplier than when that decision was last weighed.

The split is not clean down the middle, and the seam is worth knowing:

- **Real-time data** — currents, fields, storms, platforms — is fetched
  there, committed nowhere.
- **Static data** — the GEBCO isobaths, the Natural Earth coastline and
  borders — is *committed* there. The seafloor does not change, so there is
  nothing to churn, and it cannot be rebuilt in CI at all: contouring GEBCO
  needs a 7.5 GB grid run by hand on a workstation.
- **The pipelines** stay here, in `scripts/`. The data repository checks this
  one out and runs them, so there is one copy of the code and one contract.
  A vendored copy would drift, and the failure when it did would be a
  published file the map no longer reads correctly.
- **`schema.ts` stays here too**, and is the contract between them. The data
  repository runs `test-schema.mjs` against what it has just fetched, before
  publishing.

What it costs: the map now depends on a second origin. A reader sees that as
a map with no data rather than a broken page, and the data repository's
`access-control-allow-origin: *` means there is no proxy in between.

**`npm run verify` no longer sees real data.** It checks the frozen fixtures
in `scripts/fixtures/map/` — enough to catch the module's expectations
drifting from the contract, which is what that gate was ever for. Fresh
upstream drift is caught by the data repository's own run, which is the only
place it can be.

### The bloom photographs

Also not here. `HAB_DATA` in `src/config.ts` points at
[`oceansensing/hab-data-repo`](https://github.com/oceansensing/hab-data-repo),
which holds the 125 aerial photographs the harmful-algal-bloom page shows.

**Same split, weaker reason, and the docs should not pretend otherwise.** The
ocean data had to move: it was rewritten hourly and banked every version
forever. These were committed once and never touched — 27 MB live against
28 MB of history. What the move bought is weight (`dist/` fell from 71 MB to
12) and a clean line between prose and binaries, not an escape from churn.

**`astro:assets` no longer touches them, and that is the substantive cost.**
It was making 361 responsive webp derivatives at build time. It cannot now —
the files are not here — and it should not, because this site rebuilds
*hourly* and re-encoding 125 photographs every hour to emit last hour's bytes
is work nobody sees. `hab-data-repo` runs sharp once per change and publishes
`w800` and `w1400`; `HAB_WIDTHS` here and that workflow **must agree**, since
a `srcset` does not negotiate — a width in one place only is a broken image,
not a smaller one.

The widths stop at 1400 because the largest thing published is the source
file, and it is **not one size**: 87 of the 125 are 2000 px and 38 are the
older 1600 px web exports whose originals have not been found. So the
lightbox and the download button take the file itself.

The 2000 px files come by two routes, and the difference is worth keeping.
The 57 oldest were **re-exported from camera originals** and had to be
*matched* to them by image content and confirmed against the camera position
in this page's frontmatter — adjacent frames in a drone pass are near
identical, so neither test alone would do. The 30 from 2026-08-04 were
resized straight from the camera JPEGs, so their EXIF is native rather than
restored and there was nothing to match: verified after resizing at GPS
within 1 m of the source and `DateTimeOriginal` intact on all 30. That is
the cheaper path, and it is the one available whenever the originals have
not been through a web export first.

Each served file carries copyright, creator and usage terms in EXIF, IPTC and
XMP, written by that repository on publish rather than into the copies in
git — so a photograph that leaves the site says who made it, and the wording
can change without rewriting 125 binaries. The year comes from the
photograph's own filename: a 2017 bloom is not a 2026 work.

The **cover** is the one photograph still here, so the observation card's
hero is optimised locally and the hurricane page's own cover is untouched.

### The published data contract

`packages/ocean-map/schema.ts` is what every file under `public/map/` is
supposed to look like, and `npm run test:schema` checks that it does.

The contract used to be agreed on by nothing: four Python writers, a
TypeScript reader that cast most of it to `any` — 29 casts against one
interface — and no statement anywhere of which was right. **Both of the worst
data bugs in this project lived in that gap**, and neither raised an error:
ERDDAP's empty field where THREDDS writes `NaN`, which made rows ragged and
shifted Antarctica 81 cells wide against 360 in open water; and
`time[0:1:128]` going out of range when the FMRC aggregation shortened, so the
fallback served a two-day-old run while the build reported success.

The checks bite. Mutation-tested: a truncated grid, a timestamp missing its
`Z`, a string where a number belongs, storm intensity turned into a number, an
unknown platform kind, a latitude of 200, a missing required field — all
caught.

**Two of them are about agreement between files rather than the shape of
one**, and both exist because the step is chosen by valid time now:

- **A grid and its tiles must be the same hour.** They are built by separate
  invocations, the tiles behind a cache, so nothing structural makes them
  agree — a stale cache, a slightly wrong key or a build straddling a
  refresh boundary all land the same way, as sharp plausible tiles of some
  other hour under this hour's header.
- **Every ESPC hour on the map must be one the currents publish**, from one
  run. Not equality: the currents publish two frames and legitimately draw
  either. A credit line names a source, a run and an hour and deliberately
  *not* a quantity — that is what lets six ESPC layers contribute one line —
  so a field landing on a third hour is a credit nothing else can be
  brought into agreement with. This caught a real one the first time it
  ran: the ESPC **ice aggregation is hourly** where `uv3z` and `ts3z` are
  3-hourly, so selecting "the next two consecutive steps" put the ice an
  hour past the anchor and everything else three.

  **A different *run* is a note, not a failure**, and that qualifier was
  learned by taking the publish down for four hours. The aggregations are
  separate datasets on one server and a new model run does not land in all
  of them at once — measured 2026-08-06, `uv3z` had the 08-04 run while the
  ice still only had 08-03.

  **And the ice aggregation runs a whole run behind, not minutes.** Measured
  the same night, the newest run in each: `uv3z` 08-04 12Z, `ts3z` 08-04
  12Z, `ice` 08-03 12Z. So **two ESPC credit lines is the ordinary state
  whenever an ice layer is on beside a current or a temperature** — one line
  for the 08-04 run and one for the 08-03 — rather than the brief transient
  an earlier version of this note claimed. It is honest, and it is what the
  run stamp is for; it is also the first thing a reader asks about, so it is
  worth knowing that the answer is "the ice model is published later" and
  not "something is broken". Treating that as fatal blocked four consecutive
  hourly publishes, so the storms, the platforms and the wind all went
  stale to avoid a duplicated credit line about the ice. It resolves itself
  within the hour, and it is precisely what the run stamp is published for.
  Hours are not comparable across runs either, so that half of the check is
  skipped rather than piling on a second, derived failure.

  The teeth stay where they belong: same run, different hour is this
  repository's own two selections disagreeing, and no amount of waiting
  fixes that. **A gate that blocks a deploy for something upstream and
  transient is the wrong trade** — the rule everywhere else here is that an
  outage degrades to stale rather than blocking, and this check had quietly
  broken it.

**It runs twice in CI, and that is not redundancy.** `npm run verify` runs
*before* the data-refresh steps, so inside `verify` it only ever sees the
committed snapshot. A second invocation after the refresh is the only place
fresh upstream drift can be caught. Both matter: the first catches the
module's expectations drifting from the data, the second catches the data
drifting from everything.

Three details in it are contract, not accident. Storm `intensityKt` and
`pressureMb` are **strings** — the NHC publishes them with qualifiers and a
blank is a real answer, so parsing them to numbers would turn "no report" into
zero. Timestamps must carry a trailing `Z`, since one without parses as local
time and shows up as a track drawn in the wrong place rather than as an error.
And `null` in a grid means land or no data, never `0`, which is a legitimate
value.

Writing it down is also what an iOS port needs: these declarations are what a
Swift `Codable` mirrors, and they are why a native app can read this data
without reverse-engineering the Python.

**The module consumes those types — there are no `any` casts left in it**,
down from 29. The palette is typed once in `packages/ocean-map/palette.ts`
rather than cast at six use sites, the scalar layer's own API is declared
(`ScalarLayer`) because Leaflet's typings stop at the base class, and
`FieldDescriptor` says what a paintable quantity is.

`FIELDS` needs its type annotation and not just its values: without it
`autoClamp: [29, 39]` widens to `number[]` and the tuple is lost. Checked
that the types earn their place rather than merely satisfying the compiler —
passing a grid's `data` where the grid belongs, reading `.header` off a range
tuple, `field.units` for `field.unit`, `h.nX` for `h.nx`, and `geo.contours`
for `geo.features` are all now compile errors, and every one of them passed
silently before.

**It immediately found a portability bug.** Grid headers carry *absolute*
links — `/map/tiles/index.json`, and a `url` per regional grid — baked in by
the writers, and the map fetched them exactly as given. On this site that is
right by coincidence; anywhere else the tile index and every detail grid
resolve against the host's own origin and the layer silently stays coarse.
`fromData()` resolves them against the configured base now. The question that
surfaced it was simply having to write down what those strings were relative
to, and finding there was no answer.

### Data pipeline (`scripts/fetch-ocean-assets.py`)

Standard library only — as every pipeline here is bar the wind, which needs
`eccodes` for ECMWF's CCSDS-packed GRIB2 and is the sole reason CI installs
anything. Aggregates NHC storms (via KMZ), NOAA PMEL saildrones, and gliders
from **four** regional ERDDAPs into one JSON.

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

**That one was briefly removed for being blocky, and the fix was to build it
properly.** It had no generator — it was made once by hand and committed at
1,012 rings, 20,086 vertices, coordinates rounded to *two decimals*, so the
rounding alone was coarser than the zoom it was read at. Measured, its
segments ran to a median of **33.7 screen pixels at zoom 7** and 94.8 at p90.

`scripts/fetch-coastline.py` (`npm run data:coastline`) now builds it from
Natural Earth 10m physical land and minor islands, taken from Natural Earth's
own S3 rather than a GeoJSON mirror — the authoritative copy, and 3.3 MB of
shapefile against 18.3 MB of the same data as GeoJSON. **Standard library
only, including the shapefile reader**: a `.shp` polygon record is a box, a
part count, a point count, the offsets and then pairs of little-endian
doubles, which is forty lines and less than a dependency costs.

The tolerance is set from the screen, not from the source's fidelity — the
same lesson the isobaths learned, and for the same reason:

| tolerance | vertices | median @z7 | p90 | raw | gzipped |
| --- | --- | --- | --- | --- | --- |
| 0.010° | 163,777 | 6.35 px | 18.8 | 3.08 MB | 1.02 MB |
| **0.006°** | **223,005** | **4.63 px** | **13.9** | **4.19 MB** | **1.36 MB** |
| 0.003° | 309,015 | 3.24 px | 9.8 | 5.80 MB | 1.83 MB |

0.006 is the knee: a third more bytes below it buys 1.4 px, which is not
something an eye picks out of filled land, and above it the p90 climbs back
towards what was rejected.

**It is fetched only when a reader selects that basemap**, and that is what
makes 4.2 MB affordable — it is eleven times the file it replaces, and it
used to load with every page. `whenChosen()` in the module is the latch, and
it fires once: switching away and back does not refetch. `test:map` holds all
three of those — nothing requested before selection, one request and land
drawn after it, still one after toggling.

Tone matters, because dark mode dims the tile pane and that was written when
the light Esri basemap was the default — GEBCO's deep ocean sits near 0.10
luminance against Esri's 0.33, so dimming it too drops the sea to nearly
black. The active basemap's tone is published as `data-basemap-tone` on the
map container and **only light basemaps are dimmed**. Add a basemap and it
counts as dark unless you list it in `LIGHT_BASEMAPS`.

### How quickly the map appears

Reported as a 2–3 second delay before the map showed up at all. Measured on
the live site, fully cached: **one synchronous task of 1,669 ms**, and the
first basemap tile was not *requested* until 1,681 ms.

**Caching could not have helped, and that is worth stating because it is the
obvious first guess.** The profiled load was already fully cached —
`responseEnd` 4 ms, every resource served from cache — and still took
1,669 ms. The cost is parse plus execute, which a warm cache pays in full.

Decomposed with `performance.mark` against a local production build, which
is the only way to see inside one long task:

| segment | ms |
| --- | --- |
| module start → map object | 41 |
| building the field layers and chrome | 350 |
| the basemap swap inside `restoreView` | 322 |
| **`map.setView()`** | **973** |

`setView` dominated because it was the moment the map first *had* a view, so
every already-attached layer rendered at once — graticule, isobaths, the
scalar canvas, the particle field, four thousand Argo markers — with the
browser unable to paint until all of it finished.

Two changes, and between them they moved everything:

- **The reader gets a view before anything is built.** Leaflet requests no
  tiles until the map has a centre and a zoom, so the opening view is read
  straight out of storage — not through `restoreView`, which cannot run yet
  because it restores *which overlays are on* and they do not exist at that
  point. This is only the where-am-I-looking half.
- **One `await` after the basemap is attached**, so the browser can paint it
  before the remaining layers are built. `setTimeout`, **not**
  `requestAnimationFrame`: rAF does not fire at all in a hidden tab, so a
  map built in a background tab would never finish starting — the same trap
  the particle loop has a note about, reached from the other side.

| | before | after |
| --- | --- | --- |
| first tile requested | 1,681 ms | **41 ms** |
| `domContentLoaded` | 1,734 ms | **41 ms** |
| longest blocking task | 1,669 ms | 350–690 ms, and now *after* first paint |

**Opening on the reader's own basemap rather than the default.** Once the map
has a view several thousand lines earlier than it used to, swapping tile
layers stops being free — it discards a loaded set and requests another,
measured at 654 ms. `restoreView` now skips the swap when the right basemap
is already on.

**That guard immediately broke the basemap tone, and `test:map` caught it.**
`markBasemapTone` was called *inside* the swap, and with no swap to make it
never ran, so the tile pane was GEBCO while the container still advertised
the default. It is called outside the swap now. Exactly the failure shape
this project keeps meeting — right pixels, wrong label — and the only reason
it did not ship is that a check already asserted the tone follows the
basemap actually showing.

Still on the table: the ~350 ms of layer and chrome construction that now
runs after first paint. It no longer delays the map appearing, so it is a
smoothness problem rather than a blank-box one.

#### A layer nobody is looking at costs nothing

Every data layer used to fetch its grid at startup — three velocity fields
and six scalar fields — whether or not the page ever showed one. On
`/visualization/` that is four layers on screen and fourteen built for
nobody. Measured: **nine grid fetches on open, now one.**

**The preset decides what gets built, and there is no second list.** A layer
registers its loader and it runs the first time the layer is actually shown,
so a page that opens on SST pays for SST and a page that does not, does not.
Nothing has to be kept in step with the preset because the preset *is* the
input — which is what makes this adjustable per page rather than a fixed
idea of "unused".

`preload` is the escape hatch, for a layer that opens off but the page
expects readers to reach for immediately, where waiting for the fetch after
the click is worse than paying up front. `check:docs` holds it to the same
rule as `layers` — both name layers out of the module's `overlays`, and a
misspelling in either does nothing at all, silently.

**`group.once('add')`, never the map's `overlayadd`**, and that is the whole
correctness of it. `overlayadd` is a *checkbox* event: it fires only from
the layers control, so a layer switched on by the preset or by a restored
view would never have loaded and the reader would get an empty layer that
filled in only if they toggled it off and on again. A layer's own `add`
fires however it was added. Same trap the chrome sync already has a note
about, met from the other side.

The registry entry in `flows`/`ssts` is still made eagerly. The point
readout and the exclusivity groups index by group and both already ask
`map.hasLayer` before reading anything, so only the fetch and the
construction wait.

**It is shaped as a `fetch`** — `fetchWhenShown(group, url)` returning a
promise of a `Response` — because every tier chain is a long promise chain
and swapping one call for another leaves all of them untouched.
Restructuring them into deferred bodies was tried first and is a far larger
edit for identical behaviour.

**What this does not fix is the blocking task**, and that is worth stating
plainly: it is still ~700 ms, because that is synchronous construction and
`setView`, not fetching. What it buys is nine requests down to one, less
work after load, and a data host that is not asked for eight grids nobody
opened. Mutation-tested by making the loaders fire immediately again.

### How big the map is

**It scales with the window in both axes, and neither is capped.** That took
three changes, in three different places, and the split follows the same rule
as everything else here: how the map *looks* is the package's, where it *sits*
is the host's.

- **Height** is in `ocean-map.css` — `max(30rem, 77.5svh)` on desktop,
  `max(24rem, 62svh)` below 48rem. It used to be a `clamp()` topping out at
  50rem, so past a roughly 1030px-tall window the map stopped growing and sat
  in more and more empty page. The floor stays: a short window still needs
  enough map to be worth drawing. `svh` rather than `vh` so a phone's
  collapsing address bar does not resize the map mid-scroll.
- **Width** is a page decision, and it is one class. `.container` is capped
  at 72rem for prose — a sensible measure for a paragraph and an arbitrary one
  for the one element on these pages that gets better with room. A page built
  around the map adds `wide`, which drops that cap and re-applies it to every
  child *except* the figure. So the map fills the viewport and the text keeps
  its measure at the map's left edge.

  **The chrome has to go with it.** `BaseLayout` takes a `wide` prop and hands
  it to the header and footer, because with only the article widened the
  header was the single thing left centred while everything else started hard
  left. It is off by default, so every page without a map is untouched — and
  that half matters: the same template renders the photo-panel observations,
  which would otherwise stretch their prose across a 2000px screen. The
  hurricane page opts in with `wide={map === 'assets'}`, so it follows the
  map rather than the template.

  An earlier pass had the figure break *out* of a narrow container with a
  negative margin — `max(0px, (100vw - 100%) / 2 - gutter)`, collapsing to
  exactly zero on a phone. It worked, and it was the wrong shape: it left the
  page's own text stranded in the middle of a wide screen while the map ran
  past it on both sides. Widening the container moves both to the same edge
  and needs no arithmetic.
- **Refitting** is in `index.ts`, and it is the part Leaflet does not do for
  you. Its own `trackResize` listens on `window.resize`, which covers the
  common case and misses every other one — the height is a viewport unit but
  the width comes from whatever the host lays out, so a sidebar, a font
  finishing loading or a breakpoint switching all resize the map with the
  window perfectly still. The failure is silent and specific: Leaflet keeps
  drawing at its old size, so tiles stop short of the container's edge. A
  `ResizeObserver` on the container states the actual dependency, and it fires
  once on observe, which harmlessly re-fits after first layout — the moment
  the old code was most likely to have measured a container that had not
  settled.

**Removing the size cap uncapped the particle count too**, which is the part
worth not repeating. The field draws `area × particleMultiplier`
particles, so measured against the 1152×800 the old maximum allowed, a 1440p
window is 3.5× the area and a 4K one **6.4×** — about 52,000 particles
redrawn at 18 fps. The cap had been holding that down by accident. So the
count is held flat above `MAX_PARTICLES = 16000` and the density tapers
instead: a little over what an 1800×1000 map draws at full density, so every
ordinary window keeps exactly what it has and only genuinely large screens
trade density for frames — the right way round, since a bigger map has more
particles on it at any density. Verified in a browser at 2400×1500: 24,443
particles uncapped, held to 16,000.

**None of this is testable in the browser pane**, and that is worth knowing
before trying. ResizeObserver callbacks are delivered during rendering steps,
and a hidden tab runs none — measured, in a hidden pane even a fresh observer
on `document.body` never fires, and neither does `requestAnimationFrame`,
which is what Leaflet's own resize handler runs inside. So the refit is
tested in `test:map` against a stub observer, which is also the only way to
assert *which element* is observed.

### The development visualizer

`/dev/visualization/`, drawn by `packages/ocean-map-dev` — a **sandbox fork**
of the map package. It exists because some ideas cannot be tried in
production: a reader-facing colour picker, for instance, deliberately breaks
the rule that every colour has been checked against every background, and
there is nowhere in `packages/ocean-map` for that to live even temporarily.

**It shares the data and nothing else.** Same `MAP_DATA`, same hourly refresh,
same files. Nothing under `/dev/` has its own pipeline and nothing should
ever acquire one — the point is to vary the *map* with the ocean held
constant.

**It started byte-identical to production** apart from `package.json`, which
is worth preserving: `diff -r packages/ocean-map packages/ocean-map-dev` is
the experiment log. When that diff stops answering "what are we trying?", the
fork has stopped being useful.

**Unlisted is not private.** Out of the nav, out of the sitemap (filtered in
`astro.config.mjs`), disallowed in `robots.txt`, and `noindex` via a
`BaseLayout` prop for crawlers that ignore robots — but GitHub Pages serves
what is deployed and this repository is public, so anyone with the URL can
open it. Hence the banner: someone arriving sideways must not mistake it for
the published map.

**The gates read their inputs by explicit path under `packages/ocean-map`**,
so the fork is exempt from all of them, which is the point. But "exempt because nobody
listed it" is an oversight rather than a decision, so `test:map` carries a
named list of map packages and fails on a third one until somebody says which
side of the line it is on. Mutation-tested.

Its saved view has its own storage key, so a reader's dev session does not
overwrite where they were on the real map.

**Promoting something back** means copying the change, not the file: anything
that graduates has to satisfy the gates it was exempt from, and usually has
to be argued for here as well, because this map's constants are measured
decisions rather than preferences.

#### Two experiments have graduated

**Sea ice** — concentration from both sources and thickness — was built here
and is in production now, along with `drawAbove`, the floor below which a
scalar paints nothing. That floor was the open question when it was a
sandbox: it is right for ice and would be wrong for temperature, so whether
it generalised or was ice-shaped had to be seen. It generalises as an opt-in
per field, which is why it graduated as one.

Runtime particle colours were built here and are **in production now** — see
"Particle colours are chosen against what is behind them". The fork is back
in sync with `packages/ocean-map`, which is the resting state: `diff -r`
shows only the README and `package.json`.

That is what promotion is supposed to look like. The idea needed somewhere to
be wrong in — its first two attempts returned the complement of every colour
asked for — and then had to satisfy the gates it had been exempt from before
it could ship. Both halves matter; a sandbox nothing ever leaves is just a
second codebase.

### One map, however many pages carry it

**A change to how the map looks or behaves has to reach every instance of it,
uniformly.** Two pages carry it today and more will; a rule or a behaviour
written into one page applies to that page's map and no other, the two drift,
and the one anybody notices is whichever they happened to open. So all of it
lives in the package — `ocean-map.css` for the styling, `index.ts` for the
behaviour — and a host page contributes **placement only**. `AssetMap.astro`'s
whole style block is one `margin`.

What a page *may* vary is its preset: which layers open, and where. That is
the entire intended difference between `/visualization/` and the hurricane
page, and it goes through the `layers` and `home` options rather than through
CSS.

`test:map` scans every stylesheet and every component style block under `src/`
for a `--map-*` declaration or a selector reaching for `.ocean-map`,
`data-basemap-tone` or a `map-*` layer class, and fails on any hit. Mutation-
tested: planting one rule in `visualization.astro` fails it.

### Map colour, and the contrast gate

**The credit sits below the map, not on it.** Leaflet renders attribution as
a control, so by default it floats over the bottom edge — which is where the
graticule's longitude labels are pinned, and the two fought for one strip.
The credit is the one that does not have to be there: nothing about it is
spatial. The control is **reparented rather than reimplemented** — it goes on
owning and rewriting its own container, so the semicolon override below still
applies and nothing here has to know how a credit is assembled. A host page
with no `[data-map-credit]` keeps Leaflet's floating control, which is what a
second site embedding this gets until it adds the element.

**Credits are separated by semicolons.** Leaflet joins attributions with
`", "` and offers no option for it, which is fine for one product and
ambiguous for several: the credits contain commas of their own — `US Navy
ESPC-D-V02 — valid 2026-08-05 00Z (+8 h), 2026-08-03 12Z run` is *one*
source — so a reader counting them gets the wrong number. `_update` is
private, so the override is guarded and falls back to Leaflet's own version
if the internals it reads are ever renamed; `test:map` asserts the semicolons
survive, so a Leaflet upgrade that moves them fails a check rather than
quietly restoring an ambiguous line.

**Caption chrome takes bare `om-` selectors, never `.ocean-map …`.** The
`ocean-map` class is applied to the *canvas container*; the legend and every
control in it live in the figure's caption, which is the canvas's **sibling**.
So a rule written `.ocean-map .om-tint` matches nothing — and the symptom is a
control that merely looks unstyled rather than an error, which is how a whole
set of them stayed dead through several rounds of "verified in the browser".
`.om-legend` and `.om-key-flow` have always been bare; the `om-` prefix is the
namespace on its own.

**A class that sets `display` defeats the `hidden` attribute**, and this is
the trap that caught the controls twice in one change. The UA rule is
`[hidden] { display: none }` at one-selector specificity, and so is
`.om-tints { display: inline-flex }` — equal, so author order wins and the
element stays on screen. Everything the module hides by setting `.hidden`
needs an explicit `…[hidden] { display: none }`.

What makes it nasty is the interaction with the bug above: these controls hid
*correctly* while their stylesheet was dead, and stopped the moment the
selectors were fixed. Fixing one bug switched on another that had been
masked by it, so the browser check that passed before the CSS fix proved
nothing about after it.

**`appearance: none` on any button in that chrome.** iOS Safari applies its
own button styling — a grey rounded-rect with a system background — which
overrides `background` and `border-radius` both. The particle swatches came
out as grey squares on a phone while being correct on a desktop, which is the
whole point of that control gone. It only shows on a real phone: the browser
pane does not reproduce it.

**A colour-scale set uses the acronym on a phone.** The full name, a
colormap select, two number inputs and a button do not fit a phone's
content column, and what wrapping did instead was worse than either: the
break landed *inside the range*, so "20 –" ended one line and "30" began
the next, which reads as two controls rather than one. `FieldDescriptor`
carries a `short` — SST, SSS, SIC, SIT — which is the layer switcher's own
vocabulary rather than an abbreviation invented for the row, and the colour
bar directly above still carries the full name. Both are rendered and CSS
picks between them, so there is no resize listener to keep in step and no
frame where the DOM and the viewport disagree. The select is the piece that
gives: left at its natural width it sizes for `cmo.balance` and takes half
the row.

**On a phone, one field per row.** Both particle controls put Current and
Wind side by side, which wants about 41rem for the swatches and 30rem for
the sliders against roughly 21.6rem of phone content column. Reported from
a phone, where the wind's swatches ran past the right edge of the map and
the whole page scrolled sideways — the caption is ordinary page content, so
it has no scroller of its own to contain an overflowing row.

**Stacked rather than shrunk**, and that is the point: the fixed widths on
the name and the readout are what stop one field's label shoving the other's
slider along the row when a number grows a digit, and that reasoning does
not stop applying on a small screen. Each field takes its own line below the
map's own 48rem breakpoint, and the fixed footprints then line the two up
under each other. The colour-scale sets wrap for the same reason.

`test:map` decides it over the **built** stylesheet, because jsdom does no
layout and cannot see a row running off the side — and the check has to
survive minification, which rewrites `(max-width: 47.999rem)` to
`(width<=47.999rem)`. It anchors on the breakpoint value and the
declaration rather than on either spelling.

**A fixed box that its own text overflows eats the flex `gap`.** The speed
readout was `inline-size: 3.5rem` and "1.19×" filled it exactly, so the number
touched the next field's name. Fixed widths are right here — they are what
stops one control moving when another's label grows — but they have to be
wide enough for the longest string plus its own padding.

**`overlayadd`/`overlayremove` fire only from the layers control**, and that
caught every piece of this at once. They are a *checkbox* event:
`map.addLayer` and `map.removeLayer` do not fire them, and `restoreView` uses
exactly those to put a saved view back. So on a reload the chrome synced once
during setup, `restoreView` then moved layers underneath it, and nothing said
so — the platform keys named layers that were off until the reader touched
any checkbox, which fired the event and corrected everything at once. Right
after a toggle, wrong on arrival, which is what it looked like.

Every sync registers in `chromeSyncs` and is re-run after `restoreView`.
Binding to `layeradd`/`layerremove` instead would catch the programmatic case
and is the wrong fix: a `LayerGroup` already on the map forwards every child
add to the map, so four thousand Argo markers would each fire it.

**A colour bar always names its field.** It used to print the name only
once two scalars were on, on the reasoning that a single range needs no
disambiguating. That is true *between the fields on screen* and false for
the question a reader is actually asking: with one field up the legend read
`-2 to 35 °C` beside a rainbow, and nothing anywhere said the map was
showing temperature — while the particle key beside it named itself
happily, which made the omission look like a bug rather than a rule.
Reported as "sometimes I see the label and sometimes I don't", which is
precisely what a count-dependent label produces. The colour-scale controls
had the same rule and lost it for the same reason: a bare `jet` select
beside two numbers says nothing about what is being coloured.

This is the **label written once, describing a value that arrives later or
varies** shape from the list at the end of this file, in a form the list did
not yet cover — a label suppressed by a *count* rather than derived from a
constant. Ask what makes a label appear, not only what it says.

**Chrome describing a layer is hidden while that layer is off**, and that
now covers the legend keys, both particle controls, and every fact in the
status line. A count of something the reader cannot see is worse than no
count: "63 assets reporting" beside a map with no platforms on it reads as
the map having lost them, not as the layer being off. `assets` survives
while *either* gliders or saildrones are on, since the number is their sum;
`updated` has no layer at all — it is about the fetch — so it always shows.

**`test:map` now holds the three CSS faults jsdom cannot render its way to**,
all of which shipped in one session and none of which any check caught. They
are decided over the *built stylesheet*, which is the same tactic the
basemap-cascade check already uses, because jsdom does no layout and does not
cascade like a browser: no caption rule is scoped under `.ocean-map`, `hidden`
outranks our own `display` rules, and chrome buttons reset the UA appearance.
Mutation-tested — and mutation-testing them surfaced a trap of its own, since
`builtCss` concatenates *every* stylesheet in `dist`, so a fault planted in
`packages/ocean-map` alone is masked by the sandbox's copy still being
correct. Both packages have to be mutated together.

**Never inline a colour in `AssetMap.astro`.** They live in
`packages/ocean-map/data/map-palette.json`, which the component imports and
`npm run test:contrast` checks — a hardcoded colour is invisible to the gate.
`test:map` catches it too, by measuring what actually reaches the canvas
against the same admissibility rule.

**The particle ramps are the exception, and they are chosen at runtime.**
Everything else on the map is one fixed colour; a velocity field is not, for
a reason specific to it — see "Particle colours are chosen against what is
behind them" below. It is still gated, over every background the map can
present.

**What a velocity field owes, in order: the background, then the other
field, then the markers — and the gate is built that way now.**

A particle is a thin moving line covering the whole map, and the only thing
behind it is the water: the bathymetry in whichever of its tones, or whichever
colour scale has replaced it. There is no casing and no shape to fall back on,
so a particle that does not clear the background is simply invisible. Both
velocity fields are held to the palette's `bars.background` against every
water tone and every marker-safe colormap.

**The three bars live in `map-palette.json` now, not in the gate.** The map
applies them itself at runtime, and two copies of a threshold is how a gate
ends up checking a bar the map does not enforce.

The two fields also owe *each other*, for the same reason: two sets of
drifting lines have nothing but hue to tell them apart. Coral against deep
green is ΔE 69.

Markers owe far less. A marker is a small filled dot with a dark outline,
sitting still, in a place the reader is looking at deliberately — shape, size
and stillness separate it from a drifting trail long before hue does, which is
the argument Argo's old exemption always rested on. So particle-vs-marker is
held to `bars.marker`, 15 rather than 22.

Getting that order wrong is what produced the two bugs above: the gate spent
its strictness on the markers, where it was not needed, and let the current
ramp sit ΔE 21.8 from the shelf, where it was.

**Particle ramps are held to every water tone; markers are held to 90% of it
by area.** That difference was learned from a bug report. Coverage is
prevalence-weighted so one uncommon tone cannot veto a colour that is clear
over the rest of the ocean — but the tone that kept getting outvoted was not
an oddity. It is GEBCO's pale mint **continental shelf**: 4.9% of ocean
pixels, and the water this map is most used to look at, because that is where
the gliders work. Weighting by pixel area makes the abyssal plain important
and the shelf noise, which is exactly backwards here.

The old amber current ramp sat ΔE **21.8** from that shelf and **18.7** from
Esri's palest tone, passed the gate at 94.3% weighted coverage, and was
reported as invisible on the shelf. The ramp is a vivid coral now — near the
complement of that mint — and the shelf goes to **41.8**. It has since been
saturated further, toward red: that costs marker separation and buys
background separation, which is the right way round for a velocity field, and
the worst water tone went 24.2 to 30.1 while the storm red went 24.0 to 20.9. Markers keep the
weighted rule: a marker is a filled dot with a dark casing, and a particle is
a thin line with neither.

Where a colour genuinely cannot clear the bar, the pair is **named in the
palette with its measured distance and its reasoning** (`concessions`) and
reported by the gate on every run, rather than the threshold being lowered —
which would quietly cover every future clash as well.

**The list is checked both ways, and the second half is what keeps it
honest.** A pair under the bar with no concession fails; a concession for a
pair that actually clears fails too, with "remove it". Without that second
check the list only ever grows: a clash that gets fixed stays listed, and a
record that cannot be wrong stops being read. Same bargain `markerSafe`
strikes with the colormaps. Mutation-tested in both directions.

There are five concessions today and four of them are the wind's, which is
the honest cost of the colour it was given — see the wind section. The fifth
is the oldest: Argo's gold sits ΔE 17.8 from the current particles, no yellow
clears them, and paling the amber enough to make room drops its own water
contrast to 79%. The dots carry a dark outline instead, which separates a
discrete dot from a drifting trail whatever the fill does. That argument —
form and motion carrying what colour does not — is what every concession here
leans on, and its limits are visible in the list getting longer.

#### The reader sets how fast each field is drawn

One slider per animated field, in the legend row, scaling that field's own
calibrated drift from a quarter to four times.

**A multiplier, never a replacement.** `DRIFT` cancels the measured 26.7×
between wind and water, and `WIND_BOOST` is a stated legibility factor over
that parity. Both are measurements the gates hold — `check:docs` compares the
base ratio numerically and requires the boost to be stated here — and a
slider that overwrote them would leave those gates checking a number nothing
draws. This scales what they produce and leaves them alone.

**What makes it safe to offer is that the rate is the only thing it
moves.** Direction comes from the grid, relative speeds within a field come
from the grid, and the point readout quotes m/s from the grid — so a field
drawn fast is drawn fast, not claiming to be fast. That is the same argument
the wind layer already rests on at twice parity.

Linear in the *exponent* — the slider runs −2 to 2 and the multiple is
`2**value` — because the useful range is multiplicative and a linear slider
would spend three quarters of its travel above 1×.

**Every part of the row has a fixed width**, which is a correctness matter
rather than tidiness: the readout printed "1×" at exactly one and "1.1×" a
step later, and the extra character pushed the *wind* slider sideways — a
control moving under the pointer because a different control's label grew.
Two decimals always, tabular figures, and a fixed size on the readout and the
field name. Measured: the wind slider's left edge holds at 252.7 px across
1.00×, 0.25× and back.

Sliders rather than the buttons the forecast-hour control uses, and the
difference is mechanical: stepping a lead calls `setOptions({data})`, which
tears the animation down and restarts it, so a dragged slider would do that
once per value. Drift is read fresh on the next frame and changes nothing
else, so dragging costs nothing.

**The scale is applied where the layer is built, not only where the slider
moves**, and that was a bug before it was a note. A restored view is applied
before the flow layers exist — they are built when their grid arrives — so
applying it only from `restoreView` left the control reading 0.25× while the
field drew at 1×: the map disagreeing with its own chrome, with nothing on
screen to say which was right. `kind.drift` also stays the base and is never
scaled in place, or every slider move would compound the last.

It rides in the saved view like the colour choices, so the hourly self-reload
does not silently revert it, and Reset returns both fields to 1×.

`test:map` seeds a **non-default** rate into the saved view, which is the
only way to exercise the construction path at all, and holds seven claims:
the sliders exist, each says which field it drives, a restored rate reaches
the layer *and* the control agrees with it, moving one scales that field,
two moves do not compound, and the other field is untouched. Mutation-tested
against all three failure shapes — applying the rate only on input, scaling
`kind.drift` in place, and hiding the label.

Three things about writing that gate are worth not repeating. The first
version derived the base as `restoredDrift * 4`, which made the restore
check **circular** — it asserted a number against itself and passed against
a layer ignoring the restored rate entirely; the base is read out of
`index.ts` now. The restored rate has to be captured **before** the harness
clicks Reset, or it measures 1× and looks like the restore failing. And the
seed is 2× rather than a quarter, because it stays live for the whole run
and a quarter-speed field drops the per-frame displacement below the
sub-pixel floor another check measures — a fixture starving a test that had
nothing to do with it.

#### Particle colours are chosen against what is behind them

`packages/ocean-map/contrast.ts`. Every other colour on this map is fixed and
proved offline. The two particle ramps are not, and the reason is specific to
what a velocity field is: a thin moving line with nothing behind it but the
background, where the background is **27 different things** — the sampled
water of each basemap, or any of the 25 colour scales, painted opaque — and a
reader swaps between them without touching the particles.

One fixed pair had to clear all 27 at once, and the arithmetic of that is
unforgiving. Measured, the coral ramp sat ΔE **3.1** from `cmo.matter` and 7.9
from `cmo.algae`: it was chosen against water, and a colormap the reader turns
on afterwards was never part of the problem it solved. Solving one background
at a time is a far easier problem, and the search now runs in the browser
whenever the background changes — a basemap switch, a layer going on or off, a
colour scale change. Never in a frame: it costs ~17 ms.

**Moving the decision to runtime did not move it out of the gate's reach**,
and that is the whole reason it was allowed to ship. The 27 backgrounds are
all in this repository, so `test:contrast` runs the same search over every one
of them and holds the answers to the same bars. Measured worst case across all
27: background **30.7**, markers **23.0**, and the two fields **22.7** apart —
against a fixed pair whose worst was 3.1. It is a stronger guarantee than the
one it replaced, not a weaker one.

**The gate calls the map's own `admissible()`.** A gate with its own copy of
the rule proves something adjacent to what ships; the bars live in
`map-palette.json` for the same reason. Mutation-tested three ways — raising
the bar past what the search can reach, offering a colour that clears nothing,
and resolving the wind independently of the currents, which is the one that
matters most: it reports the two fields at ΔE **0.0** apart, i.e. identical.
So the resolve order — currents first, wind against a background that already
includes the currents' answer — is load-bearing rather than tidy.

**The reader can ask for a colour, and only the ones that work are offered.**
Ten choices per field, each re-tested against the current background; one that
would not clear is disabled rather than removed, so the list does not
reshuffle under the pointer.

**Swatches, not names, and the name was actively misleading.** The control was
a `<select>` of colour names, and a name is only ever an approximation of what
the search returns: it filters to ΔE ≤ 18 of an exemplar, so "Blue" over blue
water is legitimately the nearest admissible blue-ish ramp and reads as
violet. The name then argues with the pixels and the pixels win. Each swatch
is painted in **the ramp that will actually be drawn** for that request
against the background up right now, so it is not a label for the choice, it
*is* the choice. The word survives as the accessible name and the tooltip.

A disabled swatch still shows its colour. That is what makes the refusal
legible — the reader can see it sits too close to the water rather than being
told so — and it is why the greying is not simply hiding. Auto has no fixed
colour to show, so it is marked with a diagonal and tinted with whatever it
currently resolves to. That is what lets the control ship with no ΔE
readout beside it — the sandbox had one, and it is not needed when an
unusable choice is simply not selectable. Measured across all 27 backgrounds,
the thinnest case still offers **five** named colours for the current and
three for the wind, plus Auto.

A choice can stop being admissible after it is made: pick green, then switch
to a green colour scale. **The request is kept, not cleared** — it stays
selected and goes grey, the particles fall through to the best available
colour, and the choice comes back into force on its own once the background
clears it again. Clearing it was the first behaviour and is worse: it
discards an instruction the reader then has to repeat, and it makes a
temporary clash look like a permanent refusal. What says the choice is not
in force meanwhile is the legend, which is painted from the ramp actually
drawn, and a tooltip on the greyed selection — a greyed option does not
explain itself.

`test:map` drives the whole cycle: `Green` clears `jet` and fails over
`cmo.algae`, so switching the scale under it is a real change of background.
**The check that matters is "what is drawn clears the new background", not
"the drawn ramp changed"** — the first version asserted the latter and passed
even when the inadmissible request was still being honoured, because a ramp
for a given colour legitimately differs between backgrounds. Mutation-tested
both ways: reverting to clearing fails it, and honouring the stale choice
fails it.

The choice rides in the saved view like the colour scales, so the hourly
self-reload does not silently revert it, and Reset clears it.

**Black is not offered, on measurement rather than taste**: across all 27
backgrounds it clears none, since a dark ramp can separate from neither dark
water nor a pale colour scale. `test:contrast` fails on any name in the list
that is usable nowhere, so that stays true.

**The palette's `currents` and `wind` ramps are still there and still gated.**
They are what is drawn before the first resolve and whenever the background
cannot be identified — an unrecognised basemap — which is exactly the case a
fixed, fully-checked pair still serves.

**A name is an exemplar colour, not a hue angle**, and that took two wrong
turns worth recording. The hue band was tested inverted first, so every name
returned its complement — blue gave olive, violet gave green — a palette
plausible enough to survive a browser check. Fixing that exposed that the
angles had been guessed: Lab compresses the blues into 300–345° and spreads
the yellow-greens over 90–180°, so "Blue 260" was cyan's angle and "Red 25"
was orange's. And measuring them still was not enough, because **hue does not
name a colour on its own** — deep blue and pale pink sit twelve degrees apart,
lightness being what separates them, so a hue-banded search asked for blue
over blue water quite reasonably returned `#ffb0ff`. Filtering on ΔE ≤ 18 to
an exemplar constrains both axes at once, in the metric everything else here
already speaks.

The candidate set covers lightness at every chroma for that reason — 30
profiles × 60 hues. Pairing pale with low chroma and dark with high left the
tight balls around named colours empty, since deep blue is high chroma at
*low* lightness.

`test:units` carries the claim the contrast gate cannot see: **asking for a
colour must return that colour.** A picker that ignored its argument entirely
would still return an admissible ramp and pass `test:contrast`, which is
precisely how the inverted-hue bug survived. Mutation-tested against all three
failure shapes.

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

Water palettes are sampled offline into `packages/ocean-map/data/basemap-ocean.json`, so the
gate needs no network. Re-run `npm run data:basemaps` if a basemap changes.

### Currents

Three depictions, from two different models, all named in the layer switcher
because they are not the same data:

- **Animated surface particles** (default) — the package's own particle
  layer over u/v grids built by `scripts/fetch-currents.py` from the **US Navy ESPC-D-V02**
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
— so CI builds them and deploys them with the site, keyed on what they
contain so hourly builds restore from cache instead of pulling from HYCOM
twenty-four times a day. `scripts/fetch-currents.py --tile-key` prints that
key: the model run **and every valid time built from it**, because the step
moves within a run now. `--run` still prints just the run, which is the
answer to "which run is the map showing" and no longer enough to key a
cache on.

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
  condition `sampleVector` uses to wrap across the antimeridian, and
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

**This was `leaflet-velocity`'s behaviour, and it is the reason the coastal
erosion in the pipeline exists.** The layer is ours now and treats a null
nearest cell as no water (see `sampleVector`), so the bleed cannot recur —
but the erosion stays, because a coarse grid still cannot represent a fjord
and an island smaller than a cell still sits in open model water.

**The plugin did not treat a null as missing.** Its grid handed back
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

#### The particle layer is ours

`packages/ocean-map/particles.ts` (no Leaflet, no DOM) and
`velocity-layer.ts` (the Leaflet adapter) replaced `leaflet-velocity`, which
was last released in **March 2023**, ships UMD only, and reaches for
`L.latLng`, `L.point` and `L.setOptions` — **all three removed in Leaflet 2**.
It was the map's centrepiece resting on an unmaintained dependency that
blocked the next Leaflet.

**Written to run unmodified on 1.9 and 2.0.** Leaflet 2 drops every lowercase
factory but keeps the classes, so the layer is a native `class ... extends
Layer` using `new Point(...)` and `Util.setOptions`. Probed against both
versions before writing a line: every construct it uses exists in each. The
57 factory calls left in `index.ts` are a separate, mechanical migration that
fails loudly at the type-check rather than silently on a canvas.

**The velocity arithmetic is gone, and that is the point.** The plugin turned
a velocity into a screen displacement by multiplying by a `velocityScale`,
then `mapArea^0.4`, then the projection's Jacobian — and *three of the four
particle bugs below* were about cancelling those correctly. None of it was
ever needed: Web Mercator is **conformal**, so a vector (u east, v north) maps
to the screen direction (u, −v) scaled by one local factor, and dropping that
factor is exactly what makes the drift a constant number of pixels per m/s.
The whole of it is now `x += u * drift`. `scaleForView()`, the Jacobian probe
and the note about measuring it with `project()` are all deleted. Measured
before and after: **p90 1.50 px/frame either way**, zoom ratio 1.6 either way
— the new code lands on the same numbers because the old one's two factors
cancelled to this all along.

**Land is respected now.** The plugin handed its interpolator `[u, v]` — an
array, so always truthy, so its `isValue()` passed — then multiplied a `null`
through a bilinear blend as zero, defining a reduced but non-zero velocity
over land. `sampleVector` treats a null *nearest* cell as no water and
renormalises the blend over whichever corners are wet. The coastal erosion in
the pipeline is still worth having, but it is no longer the only thing
standing between particles and the land.

**Two things bit while doing it, both silent.** `start()` called `stop()` to
clear any existing timer, and `stop()` set the flag `frame()` bails on —
nothing cleared it again, so the layer ran a timer that drew nothing. And
batching the strokes into a `Path2D` took `moveTo`/`lineTo` off the context,
where `test:map`'s recorder watches: it read **51,115 strokes and zero
segments**, which is indistinguishable from a field that has stopped moving.
The batching is identical built on the context, so it is built there.

**The loop is `requestAnimationFrame`, and that is the one place the
rewrite was briefly *worse*.** It shipped on `setInterval`, which looks
identical on screen and is not: a hidden tab pauses rAF outright but only
throttles a timer to about 1 Hz, so the layer went on advecting up to 16,000
particles once a second on a page nobody was looking at — and this page is
one people leave open, since it refreshes itself hourly by design. The plugin
had used rAF, so the behaviour was already right and the regression would
have been silent. Measured in a hidden pane: on the timer the canvas held
18.9% coverage and kept changing; on rAF it is 0% and static. The frame rate
is a gate on top, because rAF runs at the display's rate and particle drift
is per *frame* — ungated it would animate three to six times too fast.

**What it costs, measured.** The advection is **1.29 ms per step at 16,000
particles** — 2.3% of an 18 fps frame budget — so the work is the canvas's,
not the maths. The structural win is elsewhere: the old plugin rebuilt an
interpolated velocity field across the whole screen after every zoom, in
slices, and `test:map` had to wait **3 seconds** before it could sample.
There is no rebuild now — a particle is unprojected and sampled where it
stands — and the same measurements are stable at **600 ms**.

**The field is simulated past the visible edge**, by `VIEW_MARGIN` — 30% of
the viewport on every side, so the canvas is 1.6× the viewport in each
dimension. Two things come from that, both about edges: a short drag reveals
water that has already been advecting, with trails behind it, rather than a
blank strip that fills in over the next second; and the visible border stops
being a place where particles retire and respawn, which is what made it read
as a seam with flow appearing out of nothing.

It costs 2.56× the area and so 2.56× the particles. The ceiling is measured
against the **viewport**, deliberately, so what a reader sees is still capped
at 16,000 and the margin is genuinely extra rather than the same particles
thinned across more area. At 1.29 ms per step per 16,000, even the ceiling on
a 4K screen is a few percent of an 18 fps frame.

**A pan carries the field; it does not reseed it.** The first version blanked
the canvas at `movestart` and dropped every particle at `moveend`, so the
field vanished for the whole drag and then rebuilt from nothing — reported as
"a flash when I stop", and as the map appearing to slide back, which is what
a field rebuilding under a still map looks like. Measured across a 220 px
pan: canvas coverage **58.3% → 4.5%**.

It now **freezes** during the gesture rather than clearing — the canvas is
placed at a *layer point*, so the pane carries it and the trails stay over the
water they were drawn for — and at `moveend` the canvas is repositioned, the
particles slid by the same offset (`ParticleField.shift`), and the existing
trails slid with them by copying the canvas onto itself. Same pan: **65.9% →
54.5%**, the dip being only the newly exposed strip that has no trails yet.

Two details in that are load-bearing. The canvas is resized **only when the
size actually changed**, because assigning `width` clears it and doing that on
every pan is the flash by another route. And a **zoom still resets**, because
screen distance stops meaning the same thing and a trail drawn at the old
scale is the wrong length.

**Trail length is the fade, not the lifetime.** A particle lives
`particleSeconds`; what a reader sees behind it is however many frames of
stroke have not yet faded, which is the `destination-out` alpha alone. The
first value shipped at 0.10 and gave ~33 px tails — the map read as long
bright ropes rather than a fine even texture, the exact decay the lifetime
note above was written about. At 0.18 the tail is ~18 px and canvas coverage
fell from 38.5% to 18.9%. Shorten the fade before the lifetime; the lifetime
is what keeps the slow water seeded.

#### Particle rendering, four ways it went wrong before

All four were shipped and all four were silent. Three of them cannot recur —
they lived in the velocity arithmetic that no longer exists — but the shape
of the failure is the thing to remember, not the arithmetic:

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

**A fifth, found by opening a page at globe zoom.** The scale is measured off
the map, and the particle layer is built *before* the page has finished laying
the map out — so on the new `/visualization/` page it was measured against
bounds the reader never sees: **259 against a settled 0.436**, six hundred
times too fast. Particles crossed the whole map between frames, landed off the
grid and were respawned where they started — 120,000 strokes of exactly zero
length, a globe covered in long straight streaks, and no error anywhere. It
survived until the reader happened to zoom, because a zoom was the only thing
that refreshed it. The scale is now recomputed on every settled view rather
than only on a zoom change, and once more after `whenReady`. Same failure as
the rounded-Jacobian bug below, reached by a different route: there the
measurement was wrong, here it was taken too early.

jsdom does no layout, so the harness cannot reproduce that race — at
construction its bounds are already the settled ones. It tests the *cause*
instead: a pan across latitude with no zoom change must still rescale, which
is the exact line that was wrong.

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

### Isobaths

`scripts/fetch-bathymetry.py`, and it is the one dataset here that is
**computed once by hand and committed**. The seafloor does not change, so
there is no workflow, no cache key and no hourly cost — re-run it only to
change the levels or the simplification.

It reads **GEBCO 2026 at 15 arc-seconds from a local file** rather than over
the network: the grid is 7.5 GB, so it is neither in the repo nor fetched.
Pass `--grid` or set `$GEBCO_GRID`. ETOPO 2022 at 60" is servable over
OPeNDAP from NGDC and was the fallback; GEBCO is four times finer per axis
and the difference lands exactly where this layer is read, on the shelf.
Needs numpy, matplotlib and h5py — a local tool like `sample-basemaps.py`,
so CI pays nothing. GEBCO's netCDF is HDF5 underneath with the elevation
array **contiguous and uncompressed** (7,464,960,000 bytes of data in a
7,466,018,396-byte file), so a windowed read is a seek and no tile needs the
whole grid in memory.

**Seventeen levels**: 20, 40, 60, 80 and 100 m on the shelf, then 200, 400,
600, 800, 1000, 2000, 3000, 4000, 5000, 6000, 8000 and 10000. 3000 and 5000
were added late and are not free — they are abyssal levels, so they shatter
the way 4000 does and survive the speckle filter in numbers: 3,653 and 4,711
lines against 6,021 at 4000 m. They took the global file from 19,707 contours
to 28,138 and 2.07 MB gzipped to 2.95, and the tile set from 107 MB to 123.
8000 and 10000 stay cheap because they exist only in the trenches — 26 lines
and 3.

**Two tiers, and the split is by detail rather than by depth** — finest that
fits, the same rule the current and field grids follow:

| tier | levels | sampling | tolerance | size | fetched |
| --- | --- | --- | --- | --- | --- |
| `bathy-tiles/<s>_<w>.json` | **all 17** | stride 2 (0.008°) | 0.004° | 127 KB gz median, 793 KB max | per view, zoom ≥ 6 |
| the deep file | 200–10000 m | stride 8 (0.033°) | 0.04° | 3.0 MB gz | on switch-on |

161 tiles of 162; the one missing is pure land. Whole layer **123 MB raw,
26.9 MB gzipped** — the single largest thing in the repo, and the price of
contours that read as curves. A reader pays the global file plus the one to
four tiles in view, never the set, and nothing at all unless they switch the
layer on: it is **off by default**.

**The two tiers are mutually exclusive, and the swap waits for pixels.**
A tile carries every level, so drawing the global file underneath would put
a coarse polygonal line a few pixels off a fine one on every contour they
share. `settleBathyTiers()` drops the global set once the tiles in view have
actually *drawn* — not when they are merely requested, since hiding it at
request time leaves the map briefly bare, which is worse than a moment of
the coarse line.

**Contours of a nearly flat plain shatter, and that had to be filtered.**
4000 m is the abyssal mean, so unfiltered that one level came out as 32,644
separate lines, median 0.12° across — sampling speckle, noise at every zoom,
and most of the file. `min_extent()` is per depth rather than flat, because a
small closed ring means different things at different levels: at 200–1000 m
it is an island or a bank and belongs on the map (bar 0.1°, ~11 km, three
cells of the sampled grid), at 2000 m and below it is an abyssal hill (bar
0.3°). Shallow contours are not filtered at all — a small ring at 20 m is a
shoal or a reef, which is what someone reads this layer for. Measured, that
keeps 2,648 lines at 200 m against 1,480 under a flat 0.2° filter while
cutting 4000 m to 6,000.

**A tolerance argued from grid fidelity is not an argument about how the
line looks, and that mistake shipped.** The deep tolerances were first set
to 0.04/0.08 on the reasoning that the tier is sampled at stride 8, so its
grid is already 0.033° and 0.08° only discards about two cells of wiggle.
True, and irrelevant: Douglas-Peucker keeps a vertex only where the chord
strays past the tolerance, so a tolerance well above the sampling leaves
long straight runs with corners between them. Measured on the published
file, deep contours had a **median segment of 16 screen pixels at zoom 7 and
a p90 over 25** — visibly polygonal, which is how it looked and how it was
reported.

0.015/0.018 gives a 6.9 px median and a 16 px p90, for 2.9 MB gzipped
against 1.25. Sampling finer does *not* help and was measured: stride 4 at
the same tolerance moves the median only from 8.2 px to 7.6, because the
tolerance and not the grid is binding. Note the deep levels ended up needing
a **tighter** tolerance than the 200–1000 m ones despite being the smoother
features — they are drawn over abyssal plain, where a chord can run a long
way before it strays far enough to force a vertex.

**The shoreline is its own layer, from EMODnet, and is not drawn here.**
The first version stroked `coastline.json` into the isobath group on the
reasoning that Natural Earth's line was already committed and cartographically
cleaner than thresholding a DEM. It is neither, at this scale: measured, its
vertices sit **16 px apart at zoom 7** in the mid-Atlantic — as coarse as the
isobaths were before they were fixed — so it drew a blocky line a few pixels
off the crisp coast the basemap already renders.

`coastlines` from **EMODnet Bathymetry's WMS** replaces it, in its own `coast`
pane at z-index 246 and its own switch, so the isobath opacity slider does not
drag it along. It renders vector-side at whatever scale is asked for —
doubling the raster halves the ink share, measured 0.50–0.54 across five
regions, which an upscaled bitmap would not do. **Global despite the European
remit**: checked at Tokyo Bay, Kodiak, Cook Strait, the Gulf of Guinea and the
Chesapeake, all with content. Marine Regions' `world_countries_coasts` was the
alternative and is on a host already trusted here for the EEZ lines, but it
renders **bright green with about half the ink**; EMODnet comes out neutral
grey, so CSS tints it the way it tints the EEZ tiles.

`coastline.json` stays exactly where it was — it is still the offline
no-tracking basemap, and it has since been rebuilt at eleven times the detail
(see Basemaps). It is not drawn *here*, though: this is the shoreline overlay,
which is EMODnet's, and the two are different layers for different jobs.

**Its tint follows the basemap, not the theme, and it shipped following the
theme.** EMODnet serves a neutral `#808080` line, so CSS decides which way it
goes — and it was darkened to near-black in light mode, over GEBCO's navy.
Measured against GEBCO's sampled water tones that is a prevalence-weighted
contrast of **2.34, and 1.02 against the commonest one**: identical
luminance, invisible. At globe zoom it also lands exactly where GEBCO draws
its own coast edge, which is where it was noticed and reported as a missing
layer. Lightening it over dark basemaps takes that to 4.80; Esri is untouched
at 4.48. It carries a halo as well, by the same drop-shadow-on-the-pane means
the isobaths use, because tinting alone cannot serve GEBCO — deep water near
black, shallow banks pale mint, so whichever way the line goes it vanishes
against one of them. The light line's worst case is 1.15 and that tone *is*
the pale shelf.

The shoreline takes **no value from the theme at all** — it is keyed to the
basemap alone, so there are only two cases: dark line over a light basemap,
light line over a dark one. Dark mode used to lighten it over the light
basemaps too, on the reasoning that those get dimmed. Measured, that buys a
weighted 3.13 against 2.06 over dimmed Esri water and reads as a glaring
white thread on a dark page, which is how it was reported. The dark line
carries its light halo there instead and looks the same by day or by night.

**The rule that keys these to the basemap did not apply in dark mode at all,
and had not since it was written.** `:root[data-theme='dark'] .ocean-map` is
three compound selectors; `.ocean-map[data-basemap-tone='dark']` is two, so
the theme block out-specified the basemap block and won. Over GEBCO in dark
mode the isobath halo therefore resolved to the dark casing its own comment
says must never happen. Light mode — the case anyone checks by eye — was
right throughout, which is why it survived. A leading `:root` brings the
basemap rule level, and sitting after both theme blocks is what makes it win,
so **it must stay below them**. `test:map` resolves that cascade over the
built CSS and asserts the basemap rule wins for both variables; jsdom cannot
see it, because it does not cascade custom properties.

#### Why they are SVG, and one path per depth

Every contour at one depth becomes a **single multi-line polyline** rather
than one layer each. Leaflet renders that as one path element with many
subpaths, so the global file's 28,138 contours are **twelve DOM nodes instead
of twenty-eight thousand**. That is what lets this stay SVG — and so stay themed in
CSS like the rest of the linework — instead of needing the canvas renderer
Argo uses. Measured after: 21 paths, 2,243 rendered points and eight pans in
33 ms at zoom 8.

Colour is **not** in `map-palette.json`, and that is deliberate. It is
reference linework like the borders, the graticule, the track casings and the
measure halo, all of which live in CSS. Gating it as a feature colour would
be wrong and would fail: measured, no light grey clears ΔE 22 over more than
half of Esri's water against the gate's 90% bar, and against a *grey*
colormap nothing can. Legibility comes from the halo instead — a
`drop-shadow` on the pane rather than a second polyline under every contour,
one filter against doubling 235,000 points of geometry.

**The halo follows the basemap, not the theme**, keyed off the
`data-basemap-tone` attribute already published for the tile dimming. At the
original near-white stroke a dark casing cost nothing on a dark basemap, so
one value served both. Two steps darker it does cost something: a dark line
inside a dark casing over GEBCO's navy is a single muddy smudge. Dark
basemaps therefore get a light halo, and the pair keeps its contrast
whichever way the water goes — measured, the stroke sits 1.42 against
GEBCO's commonest water tones and 2.21 against its own casing there.

**A custom pane holding vectors needs one CSS rule or it renders nothing.**
The site's reset gives every `svg` `max-width: 100%`, and a Leaflet pane is a
0×0 absolutely positioned box, so an SVG inside one is clamped to 0×0 and
`overflow: hidden` clips every path away: right geometry, right transform,
right stroke, zero pixels, no error. Leaflet ships exactly this counter-rule
itself but scoped to `.leaflet-overlay-pane`, which is why tracks and markers
were never affected and why this only appeared on the first custom pane to
hold vectors. `.leaflet-pane > svg { max-width: none; max-height: none }`
covers every pane so the next one does not rediscover it. `test:map` asserts
the rule survives in the built CSS — jsdom does no layout, so nothing else in
that harness can see it.

Opacity is the reader's, in the legend row beside the colour-scale controls
and for the same reason. Applied **to the pane, not to each contour** — one
CSS property for the whole layer however many tiles are loaded, against a
`setStyle` across every contour on every drag of the slider. It rides in the
saved view like the colour scales, and resets with everything else. The floor
is 10% rather than 0: a layer switched on but completely invisible reads as
broken, and the layer switcher is already the way to turn it off.

### A reader's own KMZ or KML overlay

`packages/ocean-map/kmz.ts` decodes, `store.ts` keeps, and `index.ts` draws.
It is deliberately **inert**: it joins no exclusivity group, feeds no readout
and takes no part in re-homing. It is something to look at alongside the data,
not another data layer.

**No dependency.** A KMZ is a ZIP holding a KML. The central directory is a
few `DataView` reads and `DecompressionStream('deflate-raw')` inflates
natively, so jszip or fflate would buy about forty lines. The XML parser is
**injected**, which is what keeps `kmz.ts` free of the DOM — it is testable in
Node against real fixtures, and a native port keeps the ZIP reading, the
geometry extraction and the colour conversion.

**KML colours are `aabbggrr`** — alpha first, channels reversed from CSS. Read
naively, the fixture's opaque red `ff0000ff` comes out blue, which is plausible
enough to ship.

**`outline` belongs to `PolyStyle` and governs a polygon's edge only.** Applied
to everything it silently erases lines, and that shipped for one browser
check: the sample plan shares a style between its legs and its unoutlined
boxes, so every leg rendered `stroke="none"` — drawn, right colour in the
options, invisible on screen. `test:map` holds the line and the polygon to
their separate halves of that rule.

**Descriptions are flattened to text, never markup.** A KML description
carries arbitrary HTML, and a file from a colleague or a data portal is
untrusted input even when the reader chose to open it. Stripped rather than
filtered — a subset allow-list is a thing to get subtly wrong — and the popup
is then built with `textContent`, so a second pair of hands cannot reintroduce
it. A hostile fixture is in `scripts/fixtures/`.

**IndexedDB, not localStorage**, and not a close call: localStorage holds
strings, so a KMZ would have to be base64'd — a third larger — inside about
5 MB. Records are scoped by the map's `storageKey`, so two maps keep separate
overlays for the same reason they keep separate saved views. Every call
resolves rather than rejects: a reader in private browsing gets a map that
draws and forgets, not one that fails to start, and the note says so rather
than replacing what was drawn.

**GroundOverlay images are drawn**, lifted out of the archive as blobs. Four
details in that:

- **Only images inside the KMZ.** An absolute `href` is refused for the same
  reason `NetworkLink` is — it would have a document the reader opened fetch
  from a host it names, leaking where they are and when. Counted and reported,
  not silently dropped.
- **Opacity lives in the overlay's `color` alpha**, not in an opacity tag.
- **Rotation goes on the CSS `rotate` property, not into `transform`.** Leaflet
  owns `transform` and rewrites it on every move; the individual property
  composes with it instead of fighting it. KML measures counterclockwise where
  CSS measures clockwise, so the value is negated.
- **`drawOrder` is applied by sorting** before the layers are added, since
  Leaflet stacks within a pane by insertion.

Object URLs are revoked when a layer is removed. A KMZ of scanned charts runs
to tens of megabytes and an unrevoked blob is held until the tab closes.

**`gx:LatLonQuad` is drawn too**, on its four corners. Opposite edges need not
be parallel, so this is a projective transform and not a scale-and-rotate —
the one thing an axis-aligned image overlay cannot express.
`packages/ocean-map/warp.ts` computes the homography taking the unit square to
the four corners, folds in the image's own size, and emits a CSS `matrix3d`; a
small custom layer recomputes it on every view change, since layer coordinates
move. It falls back to the affine form when the quad is a parallelogram, which
is not a shortcut but a necessity — the projective denominator vanishes there.

`warp.ts` imports neither Leaflet nor the DOM. A native port needs the same
homography and can keep it.

**The tag is namespaced, and that mattered.** `getElementsByTagName('LatLonQuad')`
matches nothing — it must be `getElementsByTagNameNS('*', 'LatLonQuad')`. The
branch that used to *count* these as skipped therefore never fired once, and
every quad overlay was reported as an unreadable `GroundOverlay` instead.

Verified in a browser rather than only in the harness: the drawn image's four
corners land within **0 px** of their georeferenced positions, and stay there
across zoom 6, 8 and 9 and a pan. jsdom loads no images, so `naturalWidth`
stays 0 and the matrix is never computed there — the harness checks the layer
is built and placed, and the geometry is checked for real.

**What is skipped is counted, not dropped.** NetworkLink is refused on
purpose as well as for effort — it fetches a URL chosen by the file. The map
reports "5 features · skipped 1 NetworkLink", because a partial render that
says nothing is the failure this project keeps meeting.

Colours come from the reader's file, which is the one place the palette rule
in `packages/ocean-map/BOUNDARIES.md` does not apply: the gate governs colours
*we* choose and can say nothing about theirs. Unstyled features fall back to
the measured line colour.

### Maritime boundaries

EEZ lines from Marine Regions (VLIZ), as WMS images in their own pane at
z-index **270** — above the scalar fields and the currents, below every track
and marker, because a boundary that hides a platform is the one thing this
layer must not do. Off by default, `pointer-events: none`, so it never
intercepts a click wherever it sits.

Lines rather than filled zones: a filled polygon over every coastal ocean
would bury the field underneath it. Transparency is not a concern —
measured, the tiles are RGBA and **97.7% fully transparent** across the Gulf,
100% where no boundary falls.

### The lat/lon grid

`packages/ocean-map/graticule.ts` draws it; `geo.ts` owns the step ladder and
the label wording. It was the **first thing lifted out of `index.ts`**, and
it was chosen for that because it captured nothing from the closure but the
map itself — the seam was already there and only the file boundary was
missing. `createGraticule(map)` wires its own redraws and hands back a layer
group, so the caller owes it nothing.

Splitting it turned up one piece of dead state: a `gridDrawn` guard that was
written on every draw and **never read**. It could not have worked — the
labels are pinned to the viewport, so they have to be rebuilt whether or not
the step changed, which is exactly what the code below it says.

Reported as hard to see and unlabelled, and both were true.

**The line.** A grey hairline at `weight: 0.5` over GEBCO's navy measures a
contrast of about 1.2 — present in the DOM and not on screen. It is 0.7 now
with a halo, the same treatment the isobaths and the shoreline needed, and
for the same reason: a thin reference line's legibility comes from its casing
rather than its hue. The casing is per line rather than a filter on the pane,
because the graticule shares the overlay pane with the tracks and a filter
there would fringe those too.

**The spacing follows the zoom**, which it did not before. A fixed 10° is
unreadable at both ends — eighteen meridians crowding the globe view, and at
zoom 8 often not one line on screen. A grid that is either noise or absent is
not a grid. The steps run 30/10/5/2/1° and stop there, because below a degree
the scale bar is the better instrument. Lines are **redrawn** on zoom rather
than all drawn and filtered: a 1° graticule over the whole world is 540
polylines and Leaflet keeps every one in the DOM.

**Labels ride the edge of the view, not the geometry.** A label anchored to
its line's midpoint is off screen the moment the line is only partly visible,
which for a graticule is nearly always. They are `divIcon` markers placed
against the viewport's west and south edges and rebuilt on every settled
view.

They are in the short form — `060°W`, `40°N` — not the degrees-and-decimal-
minutes the readout uses. A graticule label is read at a glance and sits over
the map; the readout is where a position is read exactly.

**Neither end of an axis takes a hemisphere.** 0 is the equator or the prime
meridian, and 180 is the antimeridian — `180°W` is both wrong and, one line
further east, contradicted by `180°E` for the same meridian. Verified across
the date line in a browser: `170°E · 180° · 170°W`, continuous and with no
label drawn twice.

Both rules are now in `test:units`, which needs no build and no jsdom because
they are pure functions in `geo.ts`. Mutation-tested three ways — dropping
180 from the no-hemisphere rule, moving the ladder's `<=` to `<`, and
removing the longitude fold — and each fails at least one case.

Their colour is **keyed to the basemap, not the theme**, which is the third
time that lesson has been paid for here after the shoreline and the isobath
halo: what a label is seen against is the water under it, not the page around
it.

### Naming a layer

The switcher's strings are identities: presets name them, `check:docs` fails
on a preset naming one that does not exist, and a saved view records them. A
rename is a small migration — and it costs every reader holding a saved view
the on/off state of that layer, once.

**Depth is a dimension, so the name carries it.** Every ESPC layer is a
quantity at a depth:

| | |
| --- | --- |
| quantity at depth | `<Quantity> at <N>m` — `Currents at 0m (ESPC)`, `Currents at 60m (ESPC)` |
| surface scalars | the standard acronym — `SST (ESPC)`, `SSS (ESPC)` |

The currents are spelled out because the surface is not special for them:
0m is one sample of a field that runs all the way down, and `Currents at 0m`
belongs beside `Currents at 60m` as an equal rather than as `Surface
currents`. SST and SSS keep their acronyms because those are the names an
oceanographer reaches for — and when temperature or salinity at depth
arrives it takes the spelled-out form, `Salinity at 60m (ESPC)`, leaving the
acronym to mean the surface case it already means.

`(animated)` came off the current layers with this. It separated them from a
static speed raster that no longer exists (`MERCATOR_RASTER` is false), so it
was drawing a contrast the reader cannot see.

**The source in parentheses names the product, not the agency** — `(ESPC)`,
not `(Navy forecast)`. Those two layers said "Navy forecast" while the
currents beside them, off the same model, said nothing.

`FIELDS[...].label` is deliberately a different string: the quantity, for the
readout and the colour bar, where "Salinity: 34.2 psu" beats the acronym.

**A platform layer is named for what it holds, not for one of its sources.**
`IOOS gliders` became `Ocean gliders` because the layer was never only
IOOS's: `GLIDER_SOURCES` has held four national networks — IOOS, NOC/BODC,
OTN and VOTO — since the fleet went from 38 to 52, and they all land in the
same layer. The name outlived the thing it described, which is the ordinary
way a label goes wrong: nothing broke, the map just quietly credited one of
four. Add a fifth network and nothing here has to change.

The legend key follows it (`Ocean glider`, singular, as the other keys are),
and so does the hurricane page's preset — a preset naming a layer that no
longer exists silently switches nothing on, which is why `check:docs` reads
the names out of `overlays` and fails on a mismatch.

### Wind and air temperature, and the one Python dependency

`scripts/fetch-wind.py`, `npm run data:wind`, from **ECMWF's open IFS
forecast** at 0.25°. It is the only atmospheric field on the map and the only
pipeline here that is not standard library only.

**The dependency is the format, not the effort.** ECMWF packs its open GRIB2
with data representation template **5.42, CCSDS/AEC** — an adaptive entropy
coder. Simple packing would have been forty lines of `struct`, the way the
shapefile reader in `fetch-coastline.py` was; AEC is a few hundred lines of
bit-level decoding against a format nobody here controls, where a silent
mis-decode looks exactly like plausible wind. So `eccodes`, pinned in
`scripts/requirements-wind.txt`, which ships binary wheels with the library
bundled — a `pip install`, not an `apt` one. Every other pipeline still needs
nothing, and should stay that way.

**The fetch is a byte range, not a file.** Each step publishes a ~300 MB
GRIB2 next to a `.index` sidecar giving `_offset` and `_length` per message.
Reading the sidecar and asking for just `10u` and `10v` takes this from
300 MB to about **1.5 MB**.

**It is a nowcast, and it always was — the ESPC pipelines have since come
round to the same idea.** IFS runs four times a day and lands within hours,
so its own early steps really are about the present; ESPC runs once and
lands a day and a half or more later, which is why its step used to be
counted from its run. That drifted (see "Which hour is published"), and
both pipelines now select by valid time the way this one always has.
Measured on 2026-08-03 23:10Z, the 18z run had not published and the 12z run
was 11 hours old, so the step nearest now was its +12h, valid 00Z — an hour
ahead. `pick_step()` walks runs freshest-first and takes each one's own
nearest step, so a run still publishing degrades to a three-hour-older
complete field rather than to a 404.

What still separates them is the refresh: this one is rebuilt hourly and
publishes a single step, because IFS lands promptly and there is nothing to
gain from bracketing. The ESPC currents publish a pair, because their steps
are 3-hourly and carry a tide.

**2 m air temperature rides the same fetch**, and it is the cheapest layer
this map has gained. `2t` is in the index the pipeline already reads, on the
same step of the same run — measured on the 2026-08-05 12z +12h step,
**657,778 bytes**, right beside the `10u` and `10v`. So it costs one more
range read: no new source, no new dependency, no new failure mode, and one
credit line for both because they share a source, a run and a valid time.

Three things about it are worth keeping:

- **It comes off the wire in kelvin** and is published in °C. Believing a
  units attribute is how the ice concentration got drawn in the bottom
  hundredth of its ramp; the conversion is one line, and what catches
  getting it wrong is a **plausible-range check on the values**, not a
  string. Measured on the published grids: -66 to 43 °C globally, 4 to 39
  over the Atlantic region.
- **It is published at the model's own 0.25° globally**, where the wind
  beside it stays at 1°, and the split is the same one the currents and the
  scalars already have. Wind carries u *and* v, so the same payload buys
  half the cells — and it is drawn as *particles*, which interpolate
  between cells and hide a coarse grid. A scalar is a raster: every cell
  edge is a visible square. Reported as looking very low resolution, and it
  was. At 1° a cell is about five screen pixels on a wide map, so they are
  countable, and a reader jumping to the Philippines or the Chukchi Sea got
  1° all the way in, because the wind's regional grids only cover the
  Atlantic and the Arctic. Measured at one decimal: 1° is 316 KB raw and
  **74 KB gzipped**, 0.5° is 1,261/264, native 0.25° is **5,037/919**. It
  is paid only by a reader who switches the layer on, and it is well inside
  what this map already asks on demand — `coastline.json` is 4.2 MB and the
  deep isobaths 3.0 MB gzipped, both defended on exactly this reasoning.
  "Use the resolution the product has" is the rule the ice and the Navy SST
  entries each already have a paragraph about; at 1° this discarded fifteen
  cells in every sixteen. **It needs no regional grids as a result**: a
  region exists to serve a box finer, and there is nothing finer than
  native to promise.
- **It stripes at the pole, and that is the projection rather than a
  fault.** A 0.25° lat/lon grid drawn in Mercator keeps every longitude
  column the same width on screen while the meridians they represent
  converge, so genuine cell-to-cell variation above about 75°N stretches
  into vertical bands. It was there at 1° too, four times wider and so less
  obviously banded.
- **It is the first scalar on the map that is not the ocean**, so it paints
  over land and hides the basemap entirely while it is on. That is the
  same call the wind makes and for the same reason — an air temperature
  over land is a fact, and the cases worth looking at straddle a coast. The
  shoreline and the isobaths sit in panes above it, which is what keeps the
  picture readable, and the point readout already labels its depth row
  "Elevation" rather than "Seafloor" over land.
- **It is exclusive with the ocean scalars, not with the ice.** It is a
  full-coverage raster in the `sst` pane, so SST underneath it would simply
  be hidden. Ice earns its own pane only because it paints nothing below a
  floor.

It opens on `thermal`, which is **marker-safe** — so unlike SST, SSS and
ice it needs no entry in `defaultExempt` and the gate has nothing to report
about it. That was free rather than forced: `thermal` is the scale the
colour search built for a temperature field, and it separates this from
SST's `jet` so the bar says which is showing. It reads unlike a
conventional temperature scale because it is required to stay out of the
warm half of the wheel — the same constraint the SST ramp has a paragraph
about, since orange USVs and red storms live there.

The same index also carries `2d`, `msl`, `skt`, `tcc`, `tp` and `sithick`.
Each is one more entry in this file.

**The grid starts at 180°E**, where every other grid here starts at 0. It is
rolled on the way out rather than passed through with its own `lo1`: one
convention for every published grid means the next person to write a sampling
loop cannot get it wrong. `test:schema` fails any published grid whose `lo1`
is not 0, which is what makes the roll checked rather than assumed — mutation
-tested by stamping 180 back on.

**Wind is not masked to the ocean, deliberately.** The currents are eroded
back from the coastline because a current over land is a lie. A wind over
land is a fact, and a hurricane crossing a coast is exactly when someone
wants to see it.

Two things on the map side are easy to get wrong and both are silent:

- **A current is named for where it goes; a wind for where it comes from.**
  A southwesterly blows towards the northeast. `FlowKind.reads` carries which
  convention a field is reported in, and the readout flips the bearing by 180°
  for wind. Getting it backwards would be exactly wrong and entirely
  plausible on screen. `test:map` blows the fixture due east and requires the
  readout to say **from 270°T**.
- **Lifetime is per field: 4 s suits the ocean, 8 s suits the air.** Currents
  are eddy-scale, and a longer life lets particles pile into the fast cores
  until an even texture decays into a few bright ropes. The air has less
  small-scale structure and no tight cores to collapse into, and its features
  are *circulations* — which are only legible if a streak runs far enough to
  be seen turning. The longer life also thins the picture without touching the
  count, since a particle that lives longer is reseeded less often.
- **The wind is drawn 100% faster than parity** — twice the speed the
  measurement would give it — reached in three steps of looking at the map.
  `WIND_BOOST` is a named factor over the measured ratio rather than a second
  number that quietly disagrees with it: parity is the measurement, and this
  is the legibility choice made against it.

  At double, it is worth stating what the layer now is. The wind field is a
  **depiction** of circulation rather than a scale model of it. Direction is
  exact and relative speeds within the field are exact; only the overall rate
  is chosen, and it is chosen to be read. The readout is where a reader gets
  the actual number — it reports m/s from the same grid the particles follow,
  so nothing on screen is claiming a speed the data does not support. `check:docs` holds the two apart: the
  base drift must still match the measured ratio, and the boost must be
  stated here.
- **Speed needs its own calibration.** Measured on the published grids, the
  median 10 m wind is 5.97 m/s against the median surface current's 0.22, so
  wind runs **26.7× faster**. Sharing one `DRIFT` would streak it across the
  map, the same runaway the zoom scaling already has a note about. `DRIFT` is
  per field, and `test:map` measures both at one view and fails if they
  diverge by more than 4×; it currently reads p90 1.41 px/frame against 1.59.

  That ratio is what the *base* constant cancels; `WIND_BOOST` is applied
  after it. `check:docs` holds the two together, and **not** by matching the
  number:
  the ratio above is a measurement and `DRIFT` is a pair of constants chosen
  to cancel it, so they are different quantities that happen to agree. It
  compares them numerically and fails if they drift more than a tenth apart —
  requiring the measurement to be rounded to the constant would be backwards.

**Wind and a current can be drawn together, and that is what its colour is
for.** It is deliberately *not* in the currents' exclusivity group: wind over
water beside the current under it is a pair worth reading — a storm's forcing
against what the ocean is doing about it. The two current *depths* stay
exclusive with each other, since 0 m and 60 m are the same quantity and no
colour could say which is which.

**The wind ramp is deep forest green**, dark where the currents' coral is
pale, ΔE **69.0** from it — the largest separation available — clearing every
water tone at worst 38.1 and every marker-safe colormap at 24.6. It concedes
nothing. Its closest approach to anything is 19.8, to the Argo dots' dark
hairline outline, which is a marker and judged by the marker bar.

It replaced a lemon yellow, and the reason is worth keeping. That yellow was
chosen when coverage was still weighted by area, so the pale shelf could be
outvoted; measured tone by tone it sat 20.8 from GEBCO's mint shelf and 17.9
from the haline scale, and carried **four** background concessions. No yellow
fixes that — searched, and the yellows that clear the shelf fail the colour
scales instead, because the two constraints pull opposite ways. The palette
now has no concessions at all, for the first time.

**On the yellow, and why it is worth recording rather than quietly deleting:** Every other colour here is
where the search put it. This one was asked for, costed, and taken with the
cost recorded — which is a legitimate way to decide, provided the cost is
written down where it cannot be forgotten. It is, in `concessions`.

Yellow is the crowded corner of this palette: the Argo floats are gold, the
saildrones orange, the current particles pale amber. A yellow has warm
neighbours on three sides. Of every true yellow searched, this is the one
whose worst clash is furthest from zero:

| against | ΔE | |
| --- | --- | --- |
| the measuring line | 86.0 | clears |
| the gliders | 76.6 | clears |
| the storms | 66.0 | clears |
| the Argo outline | 68.6 | clears |
| the saildrones | 38.5 | clears |
| Esri / GEBCO water | 100% / 93% cover | clears |
| **the thermal colormap** | **19.6** | conceded |
| **the Argo gold** | **18.0** | conceded |
| **the currents' amber** | **17.9** | conceded |
| **the haline colormap** | **17.9** | conceded |

**The expensive one is the amber**, because that pair is the only one on the
map with no form to fall back on: both are thin drifting trails, and they
are meant to be on screen together. Yellow over pale amber is separable but
not at a glance — which is precisely what the legend naming both fields and
the readout reporting both are carrying. Everywhere else the concession is
against a filled dot with a dark outline, or a whole-field raster, where
motion and shape do the work colour is not doing.

**A brighter, more saturated yellow is far worse and was measured first**:
ΔE 2.9 from the Argo gold, which is to say the same colour, with about four
thousand floats on the map. The lemon's four concessions all sit in the 17.9
to 19.6 band — the same order as the amber's own long-standing 17.8 — which
is what makes them the same kind of trade rather than a new one.

**Three earlier passes got this wrong, each by searching under the wrong
constraint, and the pattern is worth naming.** The first had wind reusing the
amber, which held only while the fields were exclusive. The second rejected
dark green outright, because the search demanded clearance from *every*
colormap where the gate holds a colour to the five **marker-safe** ones —
measured against the real bar the live amber ramp fails 56 of 250 colormap
stops and that green failed 13, so it was the better colour by the very
number used to reject it. The third rejected yellow on a bright sample and
called the whole hue impossible, when a paler one concedes a fifth as much.
Searching a stricter rule than the gate applies does not produce a safer
answer; it produces no answer, and a confident wrong reason for it.

**`test:contrast` had to learn about the plural.** It iterated a bare
`palette.currents`, so a second ramp could be added to the palette and drawn
on the map with the gate never looking at it — it would have gone on saying
`ok` about a colour it had never seen. It now runs every particle ramp
against every background and marker, and adds a **particle separation** pass
of wind against currents, which only became a question when they stopped
being exclusive. Its exemption notes are also reported only where the
exemption is actually being *used*: Argo's gold needs it against the amber at
ΔE 17.8 and clears the orchid by 57.9, and announcing a concession that is
not being made is how a note stops being read.

**The legend is a list, not a label.** `[data-flow-key]` is a bare container
— it carries no `om-key` class of its own, or it draws a swatch in front of
the ones it holds — and the module fills it with one key per field that is
on, each painted from that field's own ramp via `--om-key-ramp`. The ramp
used to be inlined in CSS, which was a second copy of a colour the gate owns
and would have pointed at the wrong field the moment two were on. The harness
seeds the container with the wrong text so a key that merely happens to be
right proves nothing.

**The readout reports every field that is on, each in its own convention** —
`Current at surface 0.17 m/s toward 62°T` above `Wind at 10 m 6.0 m/s from
85°T`. Naming only the first would drop the other silently, and which one it
dropped would depend on the order the layers happen to be built in. A layer
that is on but has no value under the pointer says `no data here`, which is a
different answer from a layer that is off and says nothing; those two were
briefly collapsed, and the only check on it had been matching the words "no
data here" — which the *absent* row had been supplying all along.

### Sea-surface temperature and salinity

Three fields, `npm run data:fields`, built by `scripts/fetch-ocean-fields.py`:

- **OISST** (NOAA PSL, 1/4°, daily) — an *analysis*: observations blended
  onto a grid, so it is what happened.

  **From NOAA PSL rather than NCEI's ERDDAP**, and the reason is measured:
  on 2026-08-03 PSL's newest day was 2026-08-01 against NCEI preliminary's
  2026-07-28. Four days, on the one product whose job is to say what the
  ocean is doing now. Three incidental gains — it is THREDDS, the dialect
  this file already speaks, so it shares the slab logic instead of ERDDAP's;
  its longitudes run 0–360 like the model grids; and it avoids
  `www.ncei.noaa.gov`, the host whose AAAA record refuses connections and
  cost 120 s a request against 0.9 until `_ipv4_first` went in.

  Two things it needs that the Navy products do not. Its time axis counts
  **days from 1800**, not hours from a run, so the unit is read from the
  `.das` rather than assumed — getting that wrong would place the field
  centuries away and still parse. And the file is **per year**, so
  `base_url()` fills in the year and falls back to the previous one when
  January's is not there yet.

  **Its "no forecast" is now a stated property, not an inferred one, and
  this is where the switch drew blood.** The pipeline used to decide an
  analysis had no frames by looking at its transport — `kind == 'erddap'`
  meant OISST meant analysis — which held only by coincidence. Moving the
  product to THREDDS broke it the same minute: the pipeline started asking a
  daily analysis for forecast hours, failed on its time axis, and fell back
  to the previous file, so the map went on serving the *old NCEI data* while
  the log reported the new source. `'analysis': True` says it outright.
- **Navy ESPC-D-V02** (1/12°, hourly) — a *forecast*, and the same model the
  currents come from, so temperature and flow are one ocean rather than two.
- **Navy ESPC-D-V02 salinity** — the same variable file, so temperature and
  salinity are the same ocean at the same hour.

A field is just an entry in `PRODUCTS`: a variable name, a grid, strides per
tier, a plausible-value range and a file prefix. `FIELDS` in the component is
the matching half — a ramp, a unit and a rounding step. Adding another scalar
means one entry in each, not another layer.

#### One control set per field, built by the module

Ice draws over temperature, so two scalars can be on, and a single set of
inputs had to pick one — it took whichever field was built first, so a reader
changed a colormap and watched the other field's bar move. Arbitrary and
silent.

The markup was the host's, so this could not be a loop. Cloning the host's
element as a template was the cheaper route and was measured against building
from scratch: 33 nodes a set, **0.063 ms to clone against 0.085 ms to
build** — 0.04 ms apart for the two fields that can actually be on.
Performance decided nothing, which is what made this a design choice rather
than a trade-off, and it went the way the package has been drifting: the
particle pickers and the forecast buttons were already built here.

Built **once per field and then shown or hidden**, not rebuilt on toggle —
rebuilding a `<select>` destroys an open dropdown mid-gesture, the same hazard
`syncControls` guards by skipping focused inputs. One set per *field* rather
than per layer, because OISST and Navy temperature share `FIELDS.sst` and so
share the `choices` entry the control edits. The `data-field-*` hooks stay:
they were the contract with the host and with `test:map`, and only who creates
the element changed — which is also what `test:map` had to learn, since
`document.querySelector('[data-field-map]')` now finds whichever field was
built first rather than the one showing.

#### The reader sets the colour scale

Colormap, range and a way back to automatic, per field, in the legend row
under the map rather than as a Leaflet control — number inputs and a select
inside the map are awkward on a touchscreen, and this is where the colour bar
they act on already is.

**Twenty-five colormaps in two groups, and the split is measured, not
editorial.** The five under *High contrast* clear ΔE 22 from every marker at
every stop; they were built by the search in `scripts/lib/colour.mjs` to dodge
the feature gamut, which is why they look unlike the standard maps. The
twenty under *Standard* — matplotlib's viridis, plasma, inferno, magma,
cividis, turbo; the classics jet, hsv, grey; and ten cmocean scales — do not,
and **none of them can**: a full-gamut colormap sweeps the whole wheel, so
somewhere along it it passes close to a marker. Measured worst clearance:
`cmo.haline` 11.2, `hsv` 7.5, `jet` 6.4, `viridis` 6.2, `grey` 5.5,
`inferno` 3.0.

They are offered anyway. They are not defaults, the markers keep their dark
outlines, and which scale to read the ocean with is the reader's call. What
the gate still guarantees is that the **classification is honest**: every map
called marker-safe really clears the bar, every map not called marker-safe
really does not, and both defaults come from the safe set. Without the second
half the warning would rot — a map that quietly became safe would still be
flagged, and the flag would stop meaning anything.

The `cmo.*` and matplotlib entries are ten-stop samples of the published
maps: recognisable, not the exact tables.

A pinned range **wins over the view and holds for the session**, including
across the hourly self-reload — the choices ride in the saved view alongside
the basemap and layers. Without that a pinned scale would silently revert
when a new build landed, which is the one thing "fixed until reset" must not
do. `Auto` hands it back to the view.

**Reset**, the first entry of the Layers menu, puts everything back: basemap,
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

All three are numeric grids drawn by one canvas layer in the `sst` pane
(z-index 240, under the currents and under every track). They are **mutually
exclusive with each other**, not just the two SSTs: they share that pane, so
the upper one hides the lower and the map would name two fields while showing
one.

**The raster is painted 30% past every visible edge**, the same
`VIEW_MARGIN` the particle field uses and for the same reason: the canvas is
positioned in *layer* coordinates, so a drag carries it and what was painted
stays over the water it was painted for. A pan up to that margin reveals
field that is already there instead of a blank strip that fills in on
`moveend`.

**The automatic range is bounded to the viewport, not the canvas**, and that
is not tidiness. The margin is 2.56x the area, so letting it into the range
pass would let water the reader cannot see stretch the ramp and flatten what
they can — a margin reaching into much colder water would do it silently,
with the legend printing bounds that do not describe the picture. Paint
wide, measure narrow.

It costs a repaint: measured on a 1358x696 viewport, `_render` went from
~55 ms to **98 ms**. Bounding the range pass is what keeps that from being
the full 2.56x. The repaint happens on `moveend`, after the drag, and what
the reader sees during the drag is the pre-painted margin.

**The margin is only as good as the grid under it.** Over the global grid it
is fully painted; on a regional grid the margin can reach past the region's
own bounds and stay blank — measured, a view of -90 to -30 against an 80
degree region left the left margin 2/9 painted. That ground was blank before
too, so nothing regressed; it is simply not a promise the margin can keep
everywhere.

**That layer is `packages/ocean-map/scalar-layer.ts`**, along with `FIELDS`
— the catalogue of what it can paint — and the `FieldDescriptor` that says
what a paintable quantity is.

What kept it in the closure was two pieces of the **reader's own state**: the
colormap they picked and any range they pinned. Those arrive as one
`choice()` accessor now, and the accessor is the load-bearing part. A
snapshot taken at construction would freeze the scale at whatever it was when
the grid first arrived — and a layer is built *when its data lands*, which is
before most readers have touched anything. Mutation-tested by replacing the
accessor with exactly that snapshot: **four checks fail**, including the
pinned range surviving a pan.

The state itself stayed in `index.ts` on purpose. `choices` is per map, and a
module-level copy would have two maps on a page silently sharing one set of
colour scales — the singleton bug this package spent a whole pass removing,
reintroduced by a refactor.

Verified in a browser as well: `jet` paints `[0, 0, 171]` where `cmo.haline`
paints `[39, 34, 120]` at the same pixel, and a field's own `pane` still
routes ice to `ice` and temperature to `sst` — which is the descriptor
travelling across the new module boundary intact.

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
| OISST | 0.25° | **0.25°, native** | none needed | none, by design |
| Navy | 0.08° | 0.96° | 0.16°, fallback only | **0.08°, native** |

OISST's global grid *is* its native resolution now, so it publishes no
regions at all — a region exists to serve a box finer and there is nothing
finer to promise. It was 1° globally with two native regions, which left a
reader anywhere outside the Atlantic and the Arctic on 1° at every zoom.

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

**A native global grid does not fit in one OPeNDAP response**, and finding
that out is the reason `build` bands its request by latitude as well as
slabbing it by longitude. OISST at its own 0.25° is 1440 × 661, and the ice
concentration off that grid failed every time with `IncompleteRead` — three
attempts, truncating at 10.9, 11.2 and 11.4 MB, so not transient.

**The temperature off the same grid succeeded, and that is the part worth
keeping.** It is a *byte* limit rather than a cell one: ice writes its fill
value as the twelve characters `-9.96921E+36` where a sea-surface
temperature is four, so the same number of cells is three times the
response. The temperature was therefore already near the limit and getting
away with it — which would have surfaced later as an intermittent CI failure
rather than an honest one, on whichever run happened to compress badly.

`CELLS_PER_REQUEST` is 300k, which keeps the worst case near 4 MB. The bands
start on the stride lattice the way the longitude slabs do — a band resuming
anywhere else would shift its rows against the ones above and the grid would
stop being regular — and the split is verified lattice-identical to the
single-request form. The Navy grids need no split and get none.

Three things about this cost real time, all silent:

- **ERDDAP writes a missing value as an empty field**, where THREDDS writes
  `NaN`. The currents parser skips empty fields — there they only ever mean a
  trailing comma — so land was dropped rather than marked and rows came back
  ragged and shifted west, 81 wide over Antarctica against 360 in open water.
  The parser now takes the width it asked for and raises on a mismatch.
- **`www.ncei.noaa.gov` advertises an AAAA record that refuses connections.**
  urllib has no Happy Eyeballs, so every request waited out the full TCP
  timeout: 120 s each against 0.9 with curl. `fetch-ocean-fields.py` prefers IPv4.
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

**One credit per source and run, however many layers draw from it.** The
currents and the Navy fields come off the same model at the same hour, so
with the quantity written into each string the attribution control said "US
Navy ESPC-D-V02" twice on a line already long enough to wrap. Leaflet counts
attributions by their exact text and shows each once, so the fix is to make
the shared credit *be* shared rather than to merge two strings afterwards: a
layer contributes who published the data and when, and nothing about itself.
Which quantity, and at what depth, is what the switcher names it. It goes
back to two lines when the runs genuinely differ — separate pipelines can
land on different runs — which is the thing the run stamp exists to show.

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

#### Sea ice

Two products, both already-trusted hosts, added as `PRODUCTS` entries like any
other scalar — `npm run data:fields` builds them.

- **Ice concentration (OISST analysis)** — NOAA PSL, and it is the *same
  dataset* the OISST temperature comes from: `icec.day.mean.<year>.nc` sits
  beside `sst.day.mean.<year>.nc`, same quarter degree, same daily cadence,
  same days-from-1800 axis. Every quirk already solved for temperature — the
  per-year file, the January fallback, the IPv4 preference — was solved for
  this too.
- **Ice concentration (Navy ESPC forecast)** — ESPC's own ice aggregation
  (`FMRC_ESPC-D-V02_ice`), a different file from `ts3z` but the same model,
  run and grid, so the ice and the water under it are one ocean at one hour.
  It also carries `sih` (thickness) and `siu`/`siv` (drift), which are the
  obvious next layers off the same fetch.

**Three things about it were traps, and all three are silent.**

`icec` declares `units "percent"` and contains a **0–1 fraction** —
`valid_range` is 0,1 and the southern pack measures 0.88–0.93. Believing the
units string puts every value in the bottom hundredth of the ramp, which
draws an ice-free ocean rather than an error.

Its missing value is **`-9.96921E36`, not `NaN`** — a third convention after
ERDDAP's empty field and THREDDS's `NaN`, and the only one that *parses as a
number*. Nothing upstream of the `valid` range check would reject it, which
is what that field is for.

And **the level index was attached to the transport rather than to the
dataset**, which is the same mistake the `analysis` flag was introduced to
undo. `ts3z` is `water_temp[time][depth][lat][lon]` so the DODS branch always
indexed a depth; the ice aggregation is `sic[time][lat][lon]` on the same
host in the same dialect off the same model, so every request 400'd and the
pipeline reported the product unavailable rather than mis-shaped. `levelled`
is now stated per product.

**The regions were not bipolar and the ice is.** Everything before this was
built for the Atlantic hurricane fleet, so the Southern Ocean had no region —
which does not show on a temperature map and shows badly on ice: measured on
2026-08-04, the southern band holds **55,342 wet points against the Arctic's
41,869**, so the larger pack would have been drawn at 0.96° beside an Arctic
at 0.16°. There is a Southern Ocean band now, and `regions_for()` makes the
set **per product** — a region is a promise to serve that box finer, and
giving temperature a Southern grid it never asked for is a file per field per
lead for water its readers are not looking at.

**The two sources agree on the ice and disagree on the sea.** Above 15%
concentration they are within 1.7% of each other by cell count — 6,235 for
the analysis against 6,342 for the forecast, which is a genuine cross-check of
two independent products. But PSL masks open water as *missing* while ESPC
writes a legitimate **0**, so 37,530 cells that the analysis omits the
forecast reports as ice-free ocean. Drawn naively that paints the whole ocean
in the ramp's bottom colour and hides the basemap.

The fix belongs on the map, not in the pipeline: 0 concentration is true, and
the ice edge is contoured from exactly that 0-to-non-0 boundary, so
discarding it upstream would cost the layer that needs it most. The scalar
layer takes a floor below which it draws nothing.

**Use the resolution the product has.** The forecast was shipped at the
0.16° region stride and it looked it — reported as blocky, and rightly. ESPC
is **0.08° × 0.04°**, which at 80°N is 1.5 × 4.4 km: finer than any
passive-microwave analysis and comparable to AMSR2. Serving it at 0.16°
discarded 16 cells in every 1 and rendered a 1/12° model at a resolution
indistinguishable from the 25 km analysis beside it — which is the *same*
mistake the Navy SST entry already has a paragraph about, made again in the
same file.

**The argument against tiles counted files instead of bytes.** "About 150 of
the 162 tiles would be open water" is true and beside the point: an all-zero
tile compresses to nothing. Measured — 159 tiles, **37.6 MB raw and 0.2 MB
gzipped**, a 200:1 ratio, median 252 KB raw against roughly 1.3 KB on the
wire. The whole ice tile set costs less delivered than one regional grid. So
the forecast has a tile tier like the Navy temperature, the region grids drop
to being a fallback, and a reader at zoom ≥ 4 gets 0.08° everywhere.

The analysis stays at 0.25° because that is its ceiling: it is what passive
microwave resolves, and no stride recovers what the instrument did not
measure. Higher-resolution analyses exist — NOAA PolarWatch serves AMSR2 at
6.25 km and VIIRS finer still — but every one of them is on a **polar
stereographic** grid, and every pipeline and grid reader here assumes regular
lat/lon. That is a reprojection and a resampler, not a `PRODUCTS` entry.

#### Ice thickness, and why the edge went

The edge was the 15% concentration contour, drawn as linework. **It was
removed, and the reason is worth keeping**: it earned its place only while
the concentration raster was coarse. Once that reached native 0.08°, the
edge was drawing the boundary of a field already on screen — and a contour
can never be finer than the grid it is cut from, so it stayed visibly
polygonal beside the raster it bounded. It offered nothing the concentration
did not already say, more coarsely.

`sih` from the same ESPC ice aggregation replaced it, and does carry
something new: **90% cover of 0.3 m new ice and 90% of 2 m multi-year ice
are the same picture and very different ocean.** Same grid, same run, same
step as the concentration, so it is one ice field seen two ways rather than
a second source to reconcile.

The marching-squares module under `scripts/lib/` went with it — standard
library, correct and tested, and used by nothing once the edge was gone.
Deleted rather than kept: it is in git history, and a single-threshold
contour is a hundred lines to write again if a use ever appears. (`check:docs`
would fail this paragraph for naming a file that no longer exists, which is
why it does not.)

**Thickness is not pinned to a fixed scale, where concentration is.** 0–15 m
spans ridged multi-year ice almost no view contains, so a fixed bar would
leave a typical Arctic summer view in the bottom fifth of the ramp. It
bounds the automatic range instead — `autoClamp: [0, 8]` — the way salinity
does. Concentration is the opposite case: 15–100% *is* the scale, and
rescaling per view would make one colour mean a different concentration in
every view.

#### The ice layers on the map

Three entries in the switcher: `SIC (OISST)`, `SIC (ESPC)` and `SIT (ESPC)`.

**Ice draws in its own pane, so it reads over temperature.** Every scalar
used to share one pane, which forced them all into a single exclusivity
group. That is right for temperature against salinity — both cover the whole
ocean and would completely occlude each other — and wrong for ice, which
covers about a tenth of it. `icePane` sits at z-index 242, just above the
scalar pane.

**The draw floor is what makes the pair legible**, and is the reason this
could not have been done before it existed: ice paints nothing below 15% or
0.1 m, so everywhere there is no ice the pane is transparent and the field
beneath shows through untouched. Ice over SST is one picture — the pack, and
the water at its edge.

Ice is still exclusive with *itself*: concentration and thickness share the
ice pane and are two readings of the same floe, so one would hide the other.

Two things had to stop assuming a single scalar. The colour bar builds **one
key per field that is on**, the way the particle keys do, and names them once
there is more than one — with a single field the range alone is unambiguous,
with two "15 to 90 %" beside "0 to 28 °C" needs saying which is which. And
the point readout reports every field under the pointer rather than the first
found, which would otherwise have dropped one silently and picked which by
layer build order.

**`drawAbove` is new and is what makes the two products draw the same
thing.** A scalar field with a floor below which nothing is painted has no
analogue in temperature or salinity — every reading there is the ocean, and
covering all of it is the point. Ice is the opposite: most of the sea has
none, and drawn literally the forecast would paint the entire ocean in the
ramp's bottom colour while the analysis of the same hour painted only the
pack. The floor is 0.15, the same number the edge is cut at.

**The range is pinned by `autoClamp` to the whole scale rather than bounded
to the view.** Per-view is right for temperature, where a basin spans ten of
the ocean's thirty degrees and a fixed scale wastes the ramp. It is wrong
here: 15–100% *is* the scale, and rescaling to whatever pack is on screen
would make one colour mean a different concentration in every view. Ice is
read as "how packed", not "how packed relative to here".

It opens on `cmo.ice` — near-black through blue to white, the scale ice is
conventionally read with, and white at the top is what makes a full pack look
like one. Not marker-safe (worst ΔE 6.6), so it is named in `defaultExempt`
beside `jet` and `cmo.haline` and the gate reports the cost on every run.

**Displayed in percent, stored as a fraction.** Every ice service reports the
edge as "the 15% contour" and a full floe as "90% ice"; a legend reading
"0.15 to 1" is the number the file holds and not the number anybody says. The
conversion is display-only — data, pinned range and contour threshold stay
fractions — so a unit label can never come to disagree with the values, which
is precisely the trap `icec` itself fell into.

Two bugs found by opening the page rather than by any gate, both worth
recording:

- **Every field in `FIELDS` needs a matching entry in `choices`.** The
  coupling is invisible: `choiceFor` indexes `choices` by the field's key and
  the legend reads `.map` off the result, so a field added to one and not the
  other throws on the first repaint rather than falling back to a default.
- **The point readout guessed its unit from the data.** It read
  `h.units === 'psu' ? 'psu' : '°C'` — a two-way guess in a place that now
  has three answers — so ice fell into the else and a concentration of 0.9
  was reported as "0.9 °C". `FIELDS` already states the unit and whether to
  show it as a percentage, and it is the same descriptor the colour bar
  reads, so there was never anything to infer. The value is formatted there
  too: a caller cannot know a fraction is shown times a hundred without
  asking the same descriptor again.
- **A step that is not a binary fraction did not survive the range
  rounding.** `Math.floor(0.15 / 0.05) * 0.05` is 0.1, and the ceiling of the
  same pair overshoots to 0.15000000000000002 — which the legend then printed
  verbatim. Temperature steps by 1 and salinity by 0.5, both exact, so this
  was latent from the beginning and ice is simply the first field with a
  fractional step.

#### Every grid must reach the bound it claims

Reported as gappy bands near the pole, and that is what they were: not
missing data but **three different edges stacked**. Measured before the fix,
one request for "north 85" produced 84.16 from the 0.96° global grid, 84.88
from the 0.16° Arctic one and 85.125 from OISST's quarter degree — and the
currents, a separate pipeline, gave 84.16 and 84.92 against wind's 90. Between
any two of those latitudes one field was drawn over another that had ended.

**Nothing set those numbers.** `fetch` walks `y0:stride:y1`, so the last row
sampled is `y0 + floor((y1-y0)/stride)*stride` — up to `stride-1` cells below
the requested north, which on the global grid is 0.92° silently dropped. Each
grid landed wherever its own lattice happened to reach, so the files were
individually consistent and disagreed only with each other, which is why
nothing caught it.

`MAX_LAT = 85.0` is now stated once per pipeline and the top index rounds
**outward** to the stride, so every grid covers at least that far and usually
a little past. The overshoot is not waste: the map's bilinear sampling
degenerates on the last row, so a row beyond the visible limit is what lets
the topmost visible row interpolate. 85 because Web Mercator cannot draw past
about 85.05 anyway. Costs one row per grid.

**Two checks now hold it**, and the second is the general form of the first:

- Every grid claiming the pole — the globals, the polar regions, the
  currents, the wind — must have `la1 ≥ 85`. Run against the pre-fix files it
  reports all six failures.
- **Every region must cover the box its own global file advertises.** The
  global header lists each region's bounds in `details`, and the map switches
  to a region only when the viewport is *inside* them, so a region that stops
  short leaves a strip where the map has handed over to a grid with no data
  there. Both numbers are published, so they are simply compared — no
  constant to keep in step.

Two things that bit while writing the second check. A region grid keeps the
model's **0–360 longitudes** while `details` is in −180..180, so the Atlantic
region reads 260..350 against an advertised −100..−10 — the same span,
reported as a 360° discrepancy until both sides were folded. And an advertised
region that is simply *absent* is not a failure when the check runs against
`scripts/fixtures/map`, which is a deliberate subset; it has teeth against the
real directory, which is where the data repository runs it.

**Refreshing the fixtures is not a copy.** They are one coherent snapshot: the
shared-source check asserts that the currents and the Navy fields, which come
off one aggregation at one step, credit ESPC once. Refreshing some files and
not others split that line — and so did the synthetic `sst-navy` stub in
`test:map`, which carries hardcoded timestamps whose own comment says they
must match the currents fixture. Both had to move together.

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

#### ESPC carries tides, and that constrains everything below

**Measured, because the metadata never says so.** Sampled at 48.6°S 63.8°W
on the Patagonian shelf across 17 consecutive steps of one run: the eastward
component reverses sign **8 times in 48 hours**, against the 7.7 a semidiurnal
M2 tide (12.42 h) would give. Both components oscillate with a phase offset —
a rotary tidal ellipse — and speeds run 0.33 to 1.22 m/s about a mean of
0.78. Nothing in the `.das` mentions tide, tidal or TPXO; the data is where
this is visible.

Three consequences, and they are the reason the sections below are written
as they are:

- **The steps are 3-hourly** (65 of them, T+0 to T+192), and that is the
  floor for any refresh cadence. Sampling a 12.42 h oscillation every 6 h is
  2.07 samples per cycle — barely above Nyquist, and in practice consecutive
  updates land half a tidal cycle apart, so the shelves would visibly reverse
  on most refreshes with nothing on screen to say why. 3-hourly gives 4.1.
- **A snapshot is a tidal phase**, not a mean. Whatever step is published,
  the shelf currents on it are at some point in the cycle. That is honest —
  it is what the model says — but it means two builds a few hours apart can
  legitimately disagree about which way the water is going.
- **Aliasing is a worse failure than lag.** Lag is visible: the attribution
  prints the valid time and the offset from now. A current pointing the wrong
  way is not. Where the two trade off, prefer the stale field.

#### Which hour is published, and how often it moves

Each ESPC run carries eight days and the map shows one hour of it. **The
step is chosen by valid time, not by a fixed lead**: both pipelines snap
the clock back to a six-hour boundary and take the step nearest that
anchor. The currents take two consecutive steps from there; the fields take
one.

**A fixed lead was the first answer and the ingest delay killed it.** A
lead is anchored to the model run, so where it lands relative to the reader
is the run's lateness and nothing else. That was fine while the documented
24–33 hours held — it is exactly what put T+36 a few hours ahead of now —
and it broke as soon as the delay grew. Measured 2026-08-05 19Z: the newest
run was **55 hours old**, so T+36 was valid 08-05 00Z, **19 hours behind
the reader**, while that same run carried a step valid 08-05 18Z. Measured
again two hours later at 57 hours old, the nearest-now selection picked
T+54 and T+57 — valid 18Z and 21Z, the second of them the reader's own
hour. A run holds 65 steps out to T+192, so a step near the present is
essentially always there; the lead was simply not pointing at it.

So the lead is an **output** now, not an input. That has one consequence
worth knowing before touching any of this: **the filenames move.** A
non-base frame is named for its lead, so the second frame was published as
`-f57h` on 2026-08-05 and takes a different suffix as soon as a newer run
lands; its tile directory moves with it. Nothing downstream minds, because
every URL the map follows is advertised in the data — but it is why the
tile cache key has to name the steps and not just the run, and why the
workflow's cache paths are globs.

**`REFRESH_HOURS = 6` is what stops the answer moving every three hours.**
The model's steps are 3-hourly, so an unsnapped question changes eight
times a day and each change rebuilds a tile set. Snapping makes the answer
stable within the window, so five hourly builds in six restore their tiles
from cache. It cannot go the other way: a refresh *slower* than the
model's own steps aliases the tide — see the section above — so six hours
is the ceiling, not a preference.

The currents publish **two frames per window**, which is what covers the
3-hourly grid at that cadence. The pair is the step at the anchor and the
next one forward, so the reader is a mean 1.1 hours from the nearer of them
and at worst 3 — against the 19 the fixed lead had drifted to. Three frames
would bracket the window properly, worst case 1.5 hours, and cost a third
tile set: 552 MB of currents against 368, taking the published tree to
about 868 MB of the 1 GB cap. Too close to spend on halving an error the
valid time already states on screen.

Anchor *floored*, never rounded, so the published pair is never entirely
ahead of the reader. It is the same call the tide note makes — prefer the
stale field to the aliased one — and the map then opens on whichever of the
two is nearest the reader's own clock.

**The run is chosen first and the steps come out of it.** Picking each step
independently by valid time could straddle two runs, since the same hour
exists in every run that reaches it, and a reader stepping between those
two frames would cross from one model state into another and see a
discontinuity that is not the ocean. A run that cannot serve its step is
walked past — and note what that degrades now: the *valid time* is
unchanged, because the 3-hourly grid is absolute and an older run carries
the same hours, so only the run stamp moves. The fixed-lead selection
degraded the other way, a whole day of valid time per run.

**The fields follow the hours the currents published; they do not
recompute them.** Both used to work the offset out independently — the
currents taking the step at the anchor and the one three hours on, the
fields taking the later of the two — and that holds only while the newest
run reaches three hours past the anchor. For the few hours after a run
lands it does not: measured 2026-08-06 03:11, the 08-04 run was ingested
only to T+36, so the currents published a single frame at 00Z while the
fields went to 03Z off the same run. Same run, different hour, which
`test:schema` correctly calls a code bug — because it was one — and the
publish stopped.

`currents_hours()` reads what was actually written, which makes the
invariant *structural* rather than hoped-for. The workflow already runs the
currents first, so the file is there; if it is not, the fields fall back to
computing the offset, which is no worse than the old behaviour.

**A "best" aggregation does not keep an older run's near-present steps**,
and that matters for any idea of falling back a run to get a fresher hour.
Measured the same night: the 08-04 run held 37 steps out to 08-09 while the
08-03 run held 28 out to 08-11 — but *not* the hours around now, which the
newer run had taken over. So walking back a run does not buy the present;
it loses it. The note on `pick_nearest` about an older run carrying the
same hours is true of an absolute step grid and **not** of this
aggregation.

**The two pipelines must snap identically, and that is checked twice.**
They select independently — same rule, two copies, because each is a
standalone standard-library script — and the currents and the Navy fields
come off one model. A different anchor in each puts one hour of temperature
under another hour of current and makes the map credit ESPC twice for a
single product. `check:docs` compares the two `REFRESH_HOURS` before
anything is asked of HYCOM; `test:schema` compares the published headers,
which is the stronger check because it catches the selections diverging
rather than the constants.

**`--leads=0,12,24,36,48` is still there** and is the only way back to the
run-anchored behaviour. Kept rather than deleted: a deployment with more
room than a 1 GB Pages site may well want the whole eight days, and the
difference between the two selections is one function.

**The base lead takes the bare filenames**, `currents.json` and the rest —
not lead 0, which was hardcoded and would have published nothing at the name
every existing reader asks for the moment the nowcast went away. It is the
lowest lead of the frames *actually resolved*, which is what selecting by
valid time forced: read from the constant instead, the pipeline would
suffix every file with its lead and publish nothing at `currents.json`,
the one name every existing reader asks for. An analysis is
exempt and keeps its bare name unconditionally: OISST has no run to count
leads from.

**The map has to say the field is ahead of the reader**, and with one frame
there is no lead control to say it. The attribution carries the valid time
and the offset — `US Navy ESPC-D-V02 — valid 2026-08-04 00Z (+2 h),
2026-08-02 12Z run` — because a field labelled only with its run reads as
the present, which is this project's oldest failure shape: a render that is
wrong and says nothing. `hoursAhead()` and `hourStamp()` live in `geo.ts`
with the rest of the renderer-independent formatting, and `test:map` fails
if the valid time leaves that line.

**The frames came back for the currents and stayed away from the fields**,
and the split is the measurement rather than a compromise. Over 48 hours
the median Navy SST change is **0.1 °C on a ramp spanning 20** and the
median salinity change is **0.00 psu**, so at the tier a reader sees, most
of the ocean did not move; a second field frame costs about 86 MB of tiles
to show nobody anything. A velocity field is the opposite case — it carries
a semidiurnal tide, so one sample of it is one arbitrary phase, and the
second frame is the difference between depicting the flow and depicting a
moment of it.

**It started as five coarse frames and the measurement killed them.** With
tiles at lead 0 only, the forecast hours came from the 0.96°/0.24° grids —
and over 48 hours the *median* Navy SST change is **0.1 °C on a ramp
spanning 20**, the median salinity change **0.00 psu**. Half the ocean moved
by a two-hundredth of the colour range, which is under one step of an 8-bit
channel: the control looked broken because there was nothing to see. Worse,
the places that *did* move — p99 1.7 °C, max 6.9 °C, all of them fronts and
shelves — are exactly the fine structure the coarse grid smooths away. Four
extra hours at a resolution that hides the change is a worse deal than one
hour at the resolution that shows it.

The machinery is the same one the currents' pair uses now: every lead
builds its own tile set in a directory suffixed with that lead, each
frame's header points at its own index, and
`test-schema` checks that a frame's `tileIndex` carries its own lead rather
than reaching into the present. Adding a field frame is one constant, and
what it costs is a second tile set per product — ~43 MB each for the Navy
fields — which is the reason the default is one.

Verified end to end on the live site rather than argued: reading the same
point (Newfoundland shelf, the largest 48-hour change in the grid) through
the map's own readout gave **12.5 °C at one hour and 8.1 °C at another**.

**Publishing more frames costs HYCOM reads in proportion, and batching does
not change that.** Each frame is a full tile sweep — 159 tiles x 2 components
x 2 depths is about **636 reads**. So the load is set by *frames published per
day*, not by how often the job runs: two frames every six hours and one frame
every three are both eight frame-sweeps a day and about 5,100 reads. Batching
moves when the reads happen, halves the CI runs, and makes the burst twice as
large; it buys nothing from the server. The only lever on load is publishing
fewer frames, which against a tidal field means aliasing.

**And that is the bill the current pair actually presents.** Before, one
frame per run meant one tile sweep a day for the currents and one for the
fields: about 1,270 reads. Now the currents rebuild two frames four times a
day (~5,100) and the fields rebuild one four times a day rather than once
(~2,500), so the hourly build asks HYCOM for roughly **7,600 reads a day
against 1,270**. The fields are dragged along not by their own cadence but
by the shared anchor — their step has to move with the currents' or the two
publish different hours — and their tiles have to move with their step.
It is well inside what this project has run at before (five frames was
higher still), and it is the number to look at first if HYCOM ever starts
refusing.

**The frame shown by default is the one nearest the reader's clock**, not
the lowest lead. Those are the same thing on a healthy day and part on
exactly the bad one this was asked for: when a run lands 40 hours late, its
T+0 is a field for 40 hours ago while its T+48 is valid about now. Picking
by absolute valid time means a late run degrades into a forecast that is
still about the present rather than into a confidently-labelled past.

The map and the pipeline now make the same choice for the same reason,
which is how it should have been from the start: the pipeline picks the
step nearest a six-hour anchor, and the map picks whichever of the two it
published is nearest the reader.

**Only the currents step.** The fields publish one frame, so they advertise
no `forecast` list and register no swap — a reader stepping the hour moves
the flow and leaves the temperature where it is. That is deliberate and it
is what the measured 0.1 °C per 48 hours buys: at three hours the field has
not moved enough to draw.

**Which hour that one frame is, though, is decided by the map's default.**
The fields publish the **last** step of the window rather than the first,
and the reason is the credit line. A credit names a source, a run and an
hour and deliberately *not* a quantity — that is what lets six ESPC layers
contribute one line — so two ESPC lines differing only in the hour cannot be
told apart on screen. The map opens each layer on whichever frame is nearest
the reader, which across a six-hour window is the currents' later frame for
four and a half of those hours. A field pinned to the anchor would therefore
disagree with the current beside it *most* of the time. Pinning it to the
last step inverts that, and costs nothing: it also puts the field at worst
three hours from the reader instead of six.

They still separate when the reader steps the currents back deliberately,
and then two lines with two hours on them is the right answer — it is
exactly what those stamps are for.

**The window is stated in hours, not in steps, and that is a bug this
already shipped.** "The next two consecutive steps" assumes every ESPC
aggregation is spaced alike, and they are not: `uv3z` and `ts3z` carry
3-hourly steps while **the ice aggregation carries hourly ones**, off the
same run. Counting steps put the ice at the anchor plus one hour while
everything else was at plus three — an hour no other layer could be stepped
to, so the map carried an ESPC credit nothing could be brought into
agreement with. `test:schema` caught it on the first build after the check
existed, which is the whole argument for that check: the invariant is not
"every ESPC file agrees" but "every ESPC hour is one the currents publish".

**A layer that steps has to restate its credit, and it did not.** Assigning
`options.attribution` does nothing on its own: Leaflet reads it once, when
the layer is added, and the attribution control keeps its own counted set of
strings from then on. So a layer stepping to another forecast hour went on
advertising the hour it was *built* with. That was invisible while one frame
was published and became wrong **on arrival** with two, since the map opens
on whichever is nearest the reader and that is usually not the file it
loaded first — measured in a browser, the map drew 21Z and the credit said
18Z. `recredit()` sets the option *and* swaps the control's entry, and both
halves are needed: the option so a later re-add reads the right string, the
control so the line changes now. It removes exactly one and adds exactly
one, which is what preserves the counting that lets two depths contribute a
single credit.

Neither the flow layer nor the scalar layer did this, so it was not a
regression in one of them — it is a thing the frames feature never had.

**The buttons are labelled by valid time in UTC, not by lead.** A lead is
measured from the *model run*, and that run can be a day and a half old, so
"T+36" is counted from a moment the reader knows nothing about. A clock time
is unambiguous. Same reasoning as the attribution above, and the same
formatter. They are buttons rather than a slider for a mechanical
reason too: stepping calls `setOptions({data})` on the particle layer, which
tears the animation down and restarts it, and a dragged slider would do that
five times with each restart cancelling a redraw still in flight.

**Every layer steps by lead, resolving its own frame — never by sharing a
frame object.** The first version registered one frame per step and handed
it to all four layers, so a single click had the 60 m field, the temperature
and the salinity all fetch the *surface current* grid. Nothing about that is
visible: a vector file read as a scalar draws nothing, and 60 m drawing
surface water still looks like a current. `test:map` asserts each product
asks for its own file, exactly once, and mutation-testing that check against
the shared-frame version fails it.

The lead rides in the saved view as a **lead, not a valid time** — a reader
who steps a day ahead and comes back after the hourly reload wants a day
ahead of the new run, not the absolute hour that used to mean that. Reset
returns to the frame nearest now, which is where the map opens.

OISST publishes no frames because an analysis has no forecast, and that
absence is the mechanism rather than a special case in the map: the control
simply has nothing to offer for it.

#### An old run can serve a current hour, and only `modelRun` says so

The two are independent and it is easy to read one for the other. The FMRC
"best" aggregation keeps serving forecast steps from the newest run it has,
so `refTime` marches forward on its own — the fields stay valid for *now*
whether or not a new run has landed. `modelRun` is the only thing that says
which run they came from.

Measured on 2026-08-03 04:16 UTC: the aggregation held nine distinct runs,
daily from 2026-07-24 12Z to **2026-08-01 12Z**, and nothing since. The 08-02
run was about 40 hours late against a daily cadence. The site's own field was
valid 2026-08-03 03:00Z, from that 08-01 12Z run, and every hourly build
since had been green — CI was working, the model was not. Nothing downstream
can distinguish this from a healthy day except the run stamp, which is
exactly why it is published and shown in the map's attribution.

So before suspecting the pipeline, check the aggregation's own `time_run`
axis. If its newest run is what the map reports, there is nothing to fix
here. OISST is the same shape of question with no run at all: its own date
*is* the answer, and on the same day its newest published step was
2026-07-28 — the preliminary product running about six days behind rather
than its usual four.

Cadence, for reference: the deploy workflow runs at **:17 past every hour**
and both pipelines run in it, before the build. A new run is picked up within
the hour of landing; nothing here waits on a schedule of its own.

#### HYCOM fails per request, not outright

Worth knowing before debugging anything against it. Its aggregation serves
some time steps and not others: measured on 2026-08-02, index 70 returned a
full global field while index 76 answered 500 "Stale file handle" for the
identical request, minutes apart, and a small read that had just succeeded
failed on the next try. Metadata (`.das`, the time axis) keeps working
throughout, so the server looks healthy.

Two things follow, both in `fetch-ocean-fields.py`:

- **The time step is probed before it is used.** `serves()` tests a
  candidate with a handful of cells, and the selection walks past one that
  does not answer: an analysis walks the days nearest now (`usable_step()`),
  a forecast walks back through model runs. Picking one step and giving up
  loses the whole field to a single bad member file when a neighbour is
  fine.
- **A failed tile is not an empty tile.** Those were conflated, and a run
  against a flaky server wrote 81 of 162 tiles and reported "81 empty" as
  though that were the coastline. Tiles are retried three times, failures
  are counted separately, and any failure fails the run — a short index is
  otherwise invisible, because the map just reads the coarse grid over the
  missing water and says nothing.

**That second guard was half-built for a long time, and the missing half was
the ordering.** `build_tiles` wrote its tile index and raised *afterwards*, so
the short list reached disk either way — and `main` only keeps the previous
data when **every** product fails, so one product's tile failure published a
short index while the build exited 0 and reported success. Found while
hardening the currents pipeline, and confirmed by injecting a total tile
failure: the index went to disk with **zero** entries.

It raises before writing now. Leaving the file alone is what makes the
failure legible — a restored cache keeps the previous complete index, and
with no cache the map gets a 404 and falls back to the regional grid. That
is the same picture a short index gives, arrived at by something a person
can see rather than by a file that looks correct and is not.

**The exit code was not the bug and did not change.** It still exits 0 when
some products fail, deliberately: an outage should degrade to stale rather
than block a deploy. What was wrong was the comment claiming a non-zero
exit, and a "degraded" state that meant a plausible-looking file. `main`
also names which products failed now, since the per-product lines scroll
away in a six-product run.

Both pipelines **stop at the first confirmed failure**. A confirmed failure
has already had its spaced attempts, so it is not transient, and since any
failure abandons the index there is nothing to learn from the rest: 162
tiles × 31 s of backoff over four workers is ~21 minutes per product to
reach a conclusion known after the first tile, and there are six products on
an hourly build. Measured on the fixed code, a total outage costs **4 tile
reads instead of 648**.

**`fetch-currents.py` has all of this now, plus one thing the fields
pipeline still lacks.** It had none of it: ~318 tile fetches per run across
two depths with **no retry at all**, and any single failure aborted the lot.
A healthy model went unpublished over one bad read.

- **The retry sits in `component()`**, not around each tile — the fields
  pipeline puts it around the tile. `component` is the one choke point every
  OPeNDAP read goes through, so the regional and global grids get the same
  protection for free.
- **The candidates are successively older runs**, not neighbouring hours,
  and both selections walk them that way. Under `--leads=` a lead is
  anchored to the run, so stepping an hour either side would relabel T+33
  as T+36. Under the default the reasoning is stronger still: the step grid
  is absolute, so an older run carries the *same hours* — walking back a
  run costs nothing but the run stamp, which is published in every header
  and shown in the attribution.
- **The sweep stops at the first confirmed failure**, and this is the part
  the fields pipeline does *not* do. Without it the retry costs more than it
  buys: a confirmed failure has already had four spaced attempts, and since
  any failure fails the run, grinding the rest is pure waiting — 159 tiles ×
  2 depths × 31 s of backoff over four workers is **41 minutes** to reach a
  conclusion known after the first tile, on a build that runs hourly. The
  step probe does not cover this; it catches a server that is *down*, and
  this is the case HYCOM actually presents — up, answering metadata, failing
  a fraction of reads.

Verified against live HYCOM rather than only against mocks: `--tile-key`
probes both frames and returns in 1.5 s, a full currents build of both
depths and both frames takes 22 s, all six field grids take 30 s, and both
pass `test-schema`. Fifteen injected-failure cases cover the rest, each
written so the unfixed behaviour differs.

### Measuring, and the point readout

Two tools on the map. Measuring is `packages/ocean-map/measure.ts`; the point
readout is still in `index.ts`.

**Measure** (📏 in the top-left bar) takes clicks and reports great-circle
distance per leg and overall, in **km and nautical miles**, with the initial
bearing in degrees true. Escape clears it. Distance and bearing are both
great-circle: a rhumb line is what you would steer, but quoting the two from
different geometries invites the reader to combine them.

**It was the second thing lifted out of `index.ts`, and it is the clearest
example of why.** It was declared *700 lines below* one of its callers — the
hit-target handler, which reads whether the tool is armed to decide if a
click is a survey point or a popup. That only worked because a click handler
cannot run during setup, so the reference was resolved long after the line
that made it. Nothing said so, and nothing would have caught it changing.

`createMeasureTool(map, host)` returns the three things a caller needs —
`active`, `addPoint`, `stop` — and is built above its first consumer, so the
dependency is now a parameter rather than a line number. `active` is a
getter, not a snapshot: a boolean copied at wiring time would read false
forever, which is exactly what the mutation test plants.

Escape is the one handler here bound on the `document` rather than the
container. A reader pressing it has usually not clicked into the map first,
so a container-scoped listener would never see it; with two maps on a page
it cancels both, which is what a global cancel key should do.

Verified in a browser as well as the harness, because moving where the
control is added moves where it lands in the top-left stack: it is still
zoom → 📏 → Region → Layers, and Norfolk to Halifax still reads
`1367 km · 738 nm · 47°T direct`.

### Going somewhere, and putting something on

Two menu buttons under the ruler, `Region` and `Layers`, and **the split is
the whole design**: a region moves the view and touches nothing else; an
interest sets layers and colour scales and moves nothing. They are
orthogonal, so they compose — pick the Chukchi Sea, then pick Sea ice — and
neither can surprise you by doing the other's job.

Two controls rather than one menu with headings, because a heading is a
promise the reader has to read and a separate button is one they cannot
miss.

**Interests union rather than replace, and they are checkboxes.** Ice over
air temperature is a pair worth reading and so is wind over circulation, so
checking a second one adds its layers to what is showing rather than
sweeping the first away. Unchecking drops that interest's layers *except*
any another checked interest also names — otherwise turning off Sea ice
would strip the coastline out from under Circulation, which shares it.

**Whether one is checked is derived, never stored.** An interest is on
exactly when every layer it names is on. There is therefore no second copy
of the truth to drift: turn a layer off in the switcher and the interest
that needed it unchecks itself; check two whose union the exclusivity rules
cannot satisfy and whichever lost simply reads as off, which beats a tick
beside a layer that is not drawn. The menu registers in `chromeSyncs` like
every other piece of chrome, so a restored view and Reset move it too.

Colours are **not** undone on unchecking, deliberately: a colour scale is
not owned by the interest that set it, and putting one back would overwrite
whatever the reader has since chosen by hand. Reset is what returns them.

It replaced a fixed `Basin` / `Global` / `Reset` bar, which had two problems
beyond being short. **"Global" did not mean the globe** — it fitted the
bounds of whatever was reporting, which is a different thing and was
mislabelled from the day it was written. It became `All platforms` and then
went altogether: with about four thousand Argo floats spread over every
ocean, "fit everything reporting" is essentially always the whole world, so
it duplicated a globe view while its name promised something more specific.
And there was nowhere to put an eleventh idea. Reset survives as the first entry
of the Layers menu, which is where it belongs: it is the null interest.

The entries are data in `packages/ocean-map/places.ts` — **no Leaflet and no
DOM**, so a native port keeps the whole list — and both are options on
`createOceanMap`, so a second site's readers can have their own water.

Three things this cost, and all three are the kind of thing that would
otherwise have shipped:

- **An interest must not name two layers of an exclusivity group.**
  Concentration and thickness share the ice pane; so do the two current
  depths. Naming both has the exclusivity handler switch one straight off
  again, so the entry quietly does something other than what it says — and
  *which* one survives depends on the order they were added in. Two of the
  seven interests had this. `test:map` now applies **every** interest and
  requires each to keep every layer it named; checking one would not have
  found it. That loop starts from an **empty** map and toggles each
  interest back off after it — several of them name layers the page already
  opens with, so pressing one straight away found it *already* fully on and
  toggled it off, and the check then read the emptied state and blamed the
  interest. That is the derived tick being honest, not a bug in it.
- **`syncControls` was never registered in `chromeSyncs`**, which is a
  pre-existing bug this surfaced rather than caused. `overlayadd` fires only
  from the layers control, so a layer set programmatically — by
  `restoreView` on arrival, or now by an interest — left the colour-scale
  box describing a map that no longer existed. It corrected itself on the
  reader's next pan, because `moveend` is also in its list, which is exactly
  the "wrong on arrival, right after you touch it" shape that whole note is
  about.
- **A viewport-relative cap is only as good as the viewport.** The panel's
  `max-block-size` was `min(70svh, 26rem)`; measured in a pane reporting
  `innerHeight` 0 that resolves to **zero**, and the menu collapsed to its
  own padding — ten pixels, scrolling, every entry present and none
  reachable. It carries a `max(12rem, …)` floor now. Whatever the viewport
  claims, the menu shows something.

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

**Whose water it is** comes from Marine Regions' REST gazetteer, one point at
a time, alongside the depth lookup — and **only while the EEZ layer is on**,
for the same reason the temperature row waits for a temperature layer. No
row, and no request either: a reader who has not asked about maritime
boundaries is not asking here. Their WMS `GetFeatureInfo` would be the
obvious route and is unusable: it sends no `access-control-allow-origin`, so
a browser cannot read it — the same wall GEBCO's put up. The REST endpoint
sends `*`. `typeID=70` narrows the answer to the EEZ record alone: **603
bytes against 20 KB** for the full gazetteer, which otherwise returns
Longhurst provinces, FAO fishing areas and twenty other classifications.

A point on the high seas has no EEZ and the service says so with a **404
carrying an empty list**. That is an answer, not a failure. Reporting it as
an error would be wrong over most of the ocean these platforms work in, so
404 is handled separately from the catch.

**The depth row is labelled by its answer, not by assumption.** The `<dt>`
said "Seafloor" always, written before the asynchronous lookup returns — so a
point in the Alaskan interior read "Seafloor 947 m above sea level", which is
a contradiction in terms. Below sea level is a seafloor and above it is
ground; the map is global and the readout answers wherever it is asked, so
land is an ordinary case rather than an edge one. "Seafloor" is still what
shows while the request is in flight, because most of what a reader clicks is
ocean, and it is rewritten to "Elevation" with the value.

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

### A link to the view you are looking at

The address bar carries the whole view as a URL fragment, kept current as the
map moves, so the URL *is* the shareable thing and there is nothing to press
before copying it. `packages/ocean-map/share.ts` is the codec — no Leaflet and
no DOM, so `test:units` exercises the round trip with no build and no jsdom,
and a native port that wants to open a shared link keeps the parsing.

**It encodes the object `saveView` already writes, rather than re-modelling
it.** That function had worked out what "the view" is — centre, zoom, basemap,
overlays, each field's colour scale and pinned range, the particle tints and
speeds, the isobath opacity, the forecast hour — and a second definition would
drift from the first the day a tenth thing joined the list. `viewNow()` is the
one definition; storage, the address bar and the copy button are three readers
of it.

**A fragment, not a query.** It never reaches the server, so it cannot split a
CDN cache entry or turn one page into a thousand cached URLs; it can be
rewritten with no navigation; and on a static host there is no server to
interpret a query anyway. Written with `replaceState`, never `pushState` — a
pan is not a navigation, and a hundred of them would bury whatever page the
reader came from under a hundred back-button steps.

**A link outranks the reader's own stored view**, which is the one thing this
must not get backwards: `restoreView` takes `fromHash() ?? fromStorage()`. The
hash is decoded with the *current* overlay list as its `known` set, so a link
is authoritative about layers by construction — anything it does not name is
off. That is why the stored view carries a `known` list and the link does not.

**Precision follows the zoom.** Web Mercator puts `256 · 2^zoom / 360` pixels
in a degree, so one decimal past that lands inside a pixel — the most a reader
could tell apart. Measured: 2 decimals at the globe, 4 at zoom 10. A first
pass used one decimal per two zoom levels and gave **6** at zoom 10, two
digits describing sub-millimetre positions of a map whose finest data is 3 km.
A real link measures 213 characters.

**Pasting a link into a map that is already open needed its own handling, and
without it the feature is half a feature.** Changing only the fragment is a
*same-document* navigation: the browser fires `hashchange` and nothing else,
so the map never restarts, never reads the new hash — and `syncHash` then
overwrites it with wherever the map already was, destroying the link so that
pressing Enter a second time does nothing either. Silently. It is an ordinary
way to arrive: someone with the map open is sent a view by a colleague.

It **reloads**, deliberately rather than lazily. Everything a shared view sets
is applied across `restoreView` *and the startup that follows it* — opacity
onto the pane, the speed sliders, a tint re-resolve, the chrome sync — so
applying a hash in place would mean a second restore path to keep in step with
the first. A reload re-enters the one path that is already gated, and it is
what the reader asked for by pressing Enter. It cannot loop, because
`replaceState` fires no `hashchange` at all.

**A fragment that is not a view is not reloaded — and the view is put back over
it.** This page has a skip link, so `#skip-to-content` is reachable by pressing
Tab, and without that second half the address bar quietly stops being a
shareable link until the reader next moves the map. The anchor's scroll has
already happened by the time `hashchange` fires, so restoring the view costs
nothing.

**Two maps on a page cannot share one fragment**, so the first to ask claims it
(`data-ocean-map-hash` on the root element) and the second leaves it alone —
otherwise both open on the first's shared view and then overwrite each other's
centre on every pan. `test:multimap` caught exactly that; it is the singleton
assumption this package has now paid to remove three times. A link from a
two-map page therefore restores the first map and leaves the second at its own
home: a real limitation, but an explicable one, where keying the fragment by
storage key would double its length for a case this site does not have.

**The `Copy link` button is an affordance for a phone**, where selecting a URL
out of the address bar is an awkward gesture. The clipboard API needs a secure
context and can be refused outright, so a failure falls back to putting the
URL in a selectable read-only field rather than a button that silently does
nothing. Only the fallback is verifiable in the browser pane — the clipboard
needs `document.hasFocus()`, and a hidden pane never has it.

Everything arriving in a hash has been through a chat client, an email, and
whatever truncated it on the way, so `decode` **drops what it cannot read
rather than refusing the link**: a mangled colour scale still lands you in the
right ocean. Only the centre and zoom are required, and an impossible latitude
refuses the whole thing. `test:units` covers the round trip and the hostile
inputs; `test:map` seeds a link that differs from the stored view in exactly
one value, so a link that was merely ignored fails one check and a stored view
that was ignored fails the other.

### Saving the figure as a PNG

A link reproduces a live map for anyone who will click one. This is for the
reader who never will — a slide, a paper, a report — and what earns it over a
screenshot is that it takes its **provenance** with it: the colour bar and its
range, a key per animated field, and the credit naming every source with the
run and valid hour it came from. The brand mark is already positioned over the
map for exactly this reason; this finishes that thought.

**The usual blocker was measured, not assumed.** Drawing a cross-origin image
into a canvas taints it, and a tainted canvas refuses `toBlob` outright — so
one tile fetched without CORS makes the whole figure unexportable, with a
SecurityError rather than a missing layer to show for it. Checked the way that
matters, by loading a real tile with `crossOrigin` set and calling
`toDataURL`: GEBCO, Esri Ocean, OpenStreetMap, EMODnet's shoreline and Marine
Regions' EEZ lines all send `access-control-allow-origin: *` and all five come
back clean. `CORS_TILES` is on every raster layer, including the dormant
Mercator one — a layer switched back on later would otherwise be the one thing
that taints the export, a long way from where it is set.

**Setting it also removed the need to refetch anything.** The prototype
reloaded every tile with CORS before compositing, at 1,101 ms sequential
against 95 ms in parallel; with the attribute on the layers the *live* elements
draw straight in.

**Four kinds of thing, and a canvas accepts only two.**

| in a pane | how |
| --- | --- |
| `<img>` — tiles, shoreline, EEZ | drawn directly |
| `<canvas>` — scalar raster, particles, Argo | drawn directly |
| `<svg>` — isobaths, graticule, tracks | serialised, with every computed style inlined |
| HTML — graticule labels, scale bar, brand | **redrawn** with `fillText` |

The SVG case is the price of the `className`-never-a-colour rule: styling does
not travel with a serialised clone, so the computed style of every path is read
off the live element and written onto it. Read, never re-derived — the palette
is gated by `test:contrast`, and a second opinion about a stroke here would be
a colour no gate had ever seen.

The HTML case is redrawn from the live element's own **text and position**,
never recomputed. Recomputing would be a second source of truth for the
wording, which is the thing most likely to drift. Four details in it are not
optional, and each was reported before it was fixed:

- A graticule label is a `divIcon` of size 0×0 with the text in an
  absolutely-positioned span that a transform lifts clear, so measuring the
  outer div puts every label a line-height out.
- `text-shadow` has no canvas equivalent, so the halo is redrawn as a stroke
  behind the fill — without it the labels vanish over exactly the pale shelf
  water this map is most used to look at.
- **`fillText` applies neither `text-transform`, `letter-spacing` nor
  `font-variant-caps`**, and the brand mark uses all three. Drawing
  `textContent` in the plain face rendered it about 20% narrower than the
  plate drawn behind it — reported as the mark being too large, which is what
  dead space to the right of a name looks like. Applied generally rather than
  as a brand special case: any redrawn chrome can carry them, and the failure
  is silent every time.
- **Labels are clamped inside the figure by their own ink**, not by their line
  box. The longitude labels ride the bottom edge of the *viewport* and measure
  0.6 px past the map, so the clip took their descenders. A line box carries
  leading the glyphs do not fill, so clamping by half of it leaves a label
  technically inside and visibly touching the band; `actualBoundingBoxAscent`
  and a 3 px margin are what turn flush into legible.

**The scale bar is redrawn as a cartographic one, not the interface's.**
Leaflet draws a three-sided box with the distance inside it, which is right
for a control and reads in a figure as a stray rectangle with text trapped in
it. The figure gets a hairline with a tick at each end and the distance set
above it, in black — with a light halo, because it sits bottom-left over
whatever water is there and a bare black rule is invisible over the dark
Chukchi. The ink is still black; the casing is what makes it survive. This is
the one place the figure deliberately differs from the live map.

**The mark was also too big on the map, not only in the figure.** Measured at
its old size the plate ran 181 px — 45% of a phone-width map. A mark says
whose map this is; it does not compete with the map. Down a step and tracked
tighter it is about 14% of a desktop map, and the change is in the package
stylesheet so the live map and the figure agree.

**Pane order is the correctness condition**, read off the live z-indices rather
than restated. The first prototype iterated in DOM order, which is *nearly*
right and is not: Leaflet appends panes in creation order, so `user` (z 280)
comes before `currents` (z 260) in the DOM and after it by z.

**`ctx.filter` and `globalCompositeOperation` carry the pane's own
compositing** — the two drop-shadow halos, the isobath opacity the reader set,
and the multiply blend the Mercator raster would use. An unsupported
`ctx.filter` silently stays `none`, which is the right degradation: a contour
without its halo beats no figure at all.

**`rasterise` has a timeout, and it is not a test accommodation.** A browser
that refuses the data URL without firing either handler would leave the export
awaiting it forever, with the button stuck on "Saving…". A layer missing from
the figure is a far better failure than a figure that never arrives.

#### One button, and what its 2× actually resamples

**One button rather than a size to choose.** Offering both put two buttons in
a caption row that already carries four controls, for a decision nobody has to
make: a doubled figure downscales perfectly to anything the screen-size one
served, and the reverse is not true. It costs bytes — measured, 207 KB against
368 — and the scale is still the attribute's value, so a host that wants the
smaller one drops the `"2"`.

Doubling is not an upscale everywhere, and the honest split is worth stating
because half of it is free and half of it is not:

- **Resampled** — every piece of type (the credit, the colour-bar labels, the
  graticule labels, the scale bar, the brand) and every SVG vector layer.
  Measured against the same figure merely enlarged: the band's type is **67%
  crisper**, and **2.40%** of the map area's pixels differ, which is the
  linework being redrawn rather than stretched.
- **Enlarged** — the basemap tiles and the data rasters. The rasters cannot be
  sharper: SST is a 0.08° grid and that is the resolution the data has. The
  basemap could be, by requesting zoom+1 tiles, and is the one piece left.

The SVG half only works because the clone is rasterised at the **figure's**
size rather than the screen's. Rasterising at CSS size and letting `drawImage`
stretch it throws away the whole point, and produces linework exactly as soft
as a tile.

`@2x` goes in the filename only when it is one, which says what the file is
without anyone having to open it — and would stop a screen export and a print
export made in the same minute from colliding, if a host offered both.

#### The layout is renderer-independent

`packages/ocean-map/figure.ts` decides the whole geometry — canvas size, the
map rect, the band, a row per key and per wrapped credit line — and imports
neither Leaflet nor the DOM, so `test:units` exercises it with no build and no
jsdom. Text measurement is the one browser capability it needs, so `measure`
is **injected**, the same escape hatch `kmz.ts` uses for `DOMParser`.

**The band's height is derived from its contents**, never assumed. A fixed
height is wrong in both directions: it clips a six-source credit on a phone and
leaves a stripe of empty paper under a one-source credit on a desktop. With
nothing to say — no keys, no credit — there is no band at all.

Credits split on the **semicolon**, not the comma, for the same reason the
attribution joins them that way: a single source contains commas of its own.

**Band colours live in the stylesheet, in all three theme blocks**
(`--map-figure-paper`, `--map-figure-ink`), and the exporter takes them as
arguments. A colour written into the module would be invisible to the contrast
gate, which is BOUNDARIES S5's whole point; `test:map` scans `export.ts` and
fails on any literal in it. Measured 15.8:1 in light and 15.7:1 in dark — the
pair is judged against each other and nothing else, the band being below the
map rather than over it.

#### What the harness had to learn first

`test:map`'s recording context handled neither `drawImage` nor `getImageData`,
and `toDataURL`/`toBlob` were not stubbed at all — so **a `drawImage`-based
composite was completely invisible to it**, and a check written against it
would have passed with the whole feature deleted. That is the "check that
cannot fail" shape this project has already paid for twice, so the recorder
learned about them before any of those checks were written. It records the
compositing *state* per call rather than reading it afterwards, because
`properties` is flat and save/restore do not stack.

Four more gaps surfaced the same way, each silent:

- **`XMLSerializer` was not among the constructors copied into the bundle's
  realm**, so `rasterise` threw a ReferenceError that the exporter's own
  one-item-does-not-lose-the-figure catch swallowed. Every SVG pane was missing
  from the figure while every check still passed.
- **`createLinearGradient` returned nothing**, so the colour bar threw on
  `undefined.addColorStop` and the figure was lost. Recording the stops is the
  useful part: it is the only way to see that a key carries the ramp the layer
  actually draws with.
- **Node's `URL.createObjectURL` exists and rejects jsdom's `Blob`** — "must be
  an instance of Blob. Received an instance of Blob" — so defaulting it with
  `??=` does nothing and it has to be overwritten.
- **jsdom never fires `load` on an image**, so `Image` is stubbed to succeed on
  the next tick and the SVG path really runs.

The pane-order check was **vacuous on its first attempt** and only mutation
testing found it: it read the live map's z-indices, which are ascending
whatever the exporter does. It reads the recorded draw order now.

### Known upstream quirks

Both were found the hard way; do not re-derive them.

- **The CDN in front of GitHub Pages regenerates the `Date` header on every
  response while still counting `Age` up.** Adding the two double-counts. This
  is why `UtcClock` uses `Date` alone. Covered by `test:clock`.
- **A cache-busting query string does not force a fresh response** from GitHub
  Pages — it answers `x-cache: HIT` regardless.

## What keeps going wrong here

Four shapes, each paid for more than once. They are listed together because
recognising the shape is faster than rediscovering the instance.

**A label written once, describing a value that arrives later or varies.**
The readout guessed `°C` from the data and called ice concentration a
temperature. The particle picker named colours the search only approximates,
so "Blue" drew violet. The depth row said "Seafloor" over Alaska, 947 m above
sea level. Every one computed the right number and said the wrong thing about
it — so every one passed a check asserting the number, and a check asserting
the *word* existed. Ask what the label is derived from; if it is a constant
and the thing it names is not, it is already wrong.

**Chrome that is right in the state a check reaches and wrong in the state a
reader arrives in.** `overlayadd` fires only from the layers control, so a
saved view restored programmatically left the legend describing a map that
no longer existed — and the reader's first click repaired it, which is why it
read as "it fixes itself when I touch it". The harness builds a map once and
never arrives at it twice.

**A fix that unmasks a second bug the first was hiding.** Correcting the
`.ocean-map` selectors switched the stylesheet on, and switching it on
defeated the `hidden` attribute, because a class that sets `display` beats
`[hidden]` at equal specificity. The browser check that passed before the CSS
fix proved nothing about after it. **Re-verify after a fix, not before it.**

**A check that cannot fail.** `test:map` prints `ok` for any *truthy* value,
so the tidy-looking `condition || 'why it failed'` idiom passes whenever the
condition is false — the reason string is truthy. Two checks written this
session had it, including the setup-error gate, which had been reported as
mutation-tested: the fault it was tried against killed the harness during
import, so the run went red without the check ever being reached, and its
own failure path had never once executed. Put the detail in the check's
*name* and give the value as a strict boolean.
A restore assertion derived its expected value
from the measurement it was checking. A label check ran `every()` over an
empty list. A mutation planted in one package was masked by the sandbox copy,
because `builtCss` concatenates all of `dist`. Every one of these was green
and worthless. **Mutation-test, and confirm the mutation actually reached
what you think it did** — if a check passes with the feature deleted, it was
never testing the feature.

The through-line: `npm run verify` proves the module's *logic*. It does not
prove the thing renders, that a word is true, or that a reader arriving cold
sees what a reader mid-session sees. Those need a browser, and on a phone for
anything touching a UA-styled control.

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
