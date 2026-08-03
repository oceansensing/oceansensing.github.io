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
Leaflet and `leaflet-velocity` as peer dependencies. Its `exports` point
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
spans, timestamps), `ramp.ts` (colour ramps) and `tiles.ts` (which tiles a view
needs). None imports Leaflet or the DOM — they typecheck standalone — so a
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
  page. The generic map opens on bathymetry, surface flow and a shoreline over
  the whole ocean; the hurricane map opens on the fleet, SST, isobaths and the
  graticule over the Atlantic. Neither knows anything the other does not.

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
- **Still to do**: the chrome markup is the host's, so a second site
  reproduces the legend and controls; the module is one 2,700-line file; and
  the fleet is assumed — the legend names hurricanes, USVs, IOOS gliders and
  Argo, and the layer switcher matches.

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
which holds the 95 aerial photographs the harmful-algal-bloom page shows.

**Same split, weaker reason, and the docs should not pretend otherwise.** The
ocean data had to move: it was rewritten hourly and banked every version
forever. These were committed once and never touched — 27 MB live against
28 MB of history. What the move bought is weight (`dist/` fell from 71 MB to
12) and a clean line between prose and binaries, not an escape from churn.

**`astro:assets` no longer touches them, and that is the substantive cost.**
It was making 361 responsive webp derivatives at build time. It cannot now —
the files are not here — and it should not, because this site rebuilds
*hourly* and re-encoding 95 photographs every hour to emit last hour's bytes
is work nobody sees. `hab-data-repo` runs sharp once per change and publishes
`w800` and `w1400`; `HAB_WIDTHS` here and that workflow **must agree**, since
a `srcset` does not negotiate — a width in one place only is a broken image,
not a smaller one.

The widths stop at 1400 because the largest thing published is the source
file, and it is **not one size**: 57 of the 95 are 2000 px, re-exported from
camera originals with their GPS and capture times restored, and 38 are the
older 1600 px web exports whose originals have not been found. So the
lightbox and the download button take the file itself.

Each served file carries copyright, creator and usage terms in EXIF, IPTC and
XMP, written by that repository on publish rather than into the copies in
git — so a photograph that leaves the site says who made it, and the wording
can change without rewriting 95 binaries. The year comes from the
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

**Never inline a colour in `AssetMap.astro`.** They live in
`packages/ocean-map/data/map-palette.json`, which the component imports and
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

Water palettes are sampled offline into `packages/ocean-map/data/basemap-ocean.json`, so the
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

All three are numeric grids drawn by one canvas layer in the `sst` pane
(z-index 240, under the currents and under every track). They are **mutually
exclusive with each other**, not just the two SSTs: they share that pane, so
the upper one hides the lower and the map would name two fields while showing
one.

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

#### The forecast hour

Each ESPC run carries eight days and the map used to show one hour of it.
**Two frames — now and +24 h — at full resolution**, for currents at both
depths, Navy SST and Navy salinity. `LEADS` in each pipeline is the knob and
`--leads=0,12,24,36,48` brings the rest back.

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

So every lead now carries its own tile set, in its own directory
(`tiles-f24h/`, `tiles-sst-navy-f24h/`), and each frame's header points at
its own index. **This is expensive and it is the reason the data needs to
move.** A second tile set is another 92 MB per depth for currents and ~43 MB
each for the two Navy fields: the published site goes from ~634 MB to ~904
MB against GitHub Pages' **1 GB cap**, or 90% of it. One more layer would
not fit. See the data-repository item in `PLAN.md`.

Verified end to end on the live site rather than argued: reading the same
point (Newfoundland shelf, the largest 48-hour change in the grid) through
the map's own readout gave **12.5 °C at one hour and 8.1 °C at another**.

**The frame shown by default is the one nearest the reader's clock, not lead
0.** Those are the same thing on a healthy day and part on exactly the bad
one this was asked for: when a run lands 40 hours late, lead 0 is a field
for 40 hours ago while +48h is valid about now. Picking by absolute valid
time means a late run degrades into a forecast that is still about the
present rather than into a confidently-labelled past.

**The buttons are labelled by valid time in UTC, not by lead.** A lead is
measured from a *build*, and the run behind that build can be two days old,
so "+24h" is counted from a moment the reader knows nothing about. A clock
time is unambiguous. They are buttons rather than a slider for a mechanical
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
who steps to +24h and comes back after the hourly reload wants
tomorrow-from-now, not the absolute hour that meant an hour ago. Reset
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
