# PLAN.md

Running record of where the site stands and what is still open. Update as
things land; delete items once they are done rather than marking them.

## Where it stands

Live at <https://oceansensing.org> (GitHub Pages, HTTPS enforced, apex not
`www`). Every push to `main` deploys; a scheduled run also rebuilds hourly to
refresh the map data.

Built and deployed: home, research (with per-project pages and a past-projects
split), people, publications from BibTeX, presentations, news + RSS, data &
tools, per-person CVs at `/cv/<person-id>/`, Significant Observations
(harmful algal blooms, hurricanes), and two calculators under Data & Tools —
`/data/seawater/` and `/data/glider-ballast/`.

`/visualization/` opens on sea-surface temperature under the surface flow,
with the shorelines, borders and grid, over the whole ocean — 232 KB on a
first load, the isobaths having been measured at 2,916 KB gzipped and left
one click away in the switcher rather than in the preset.

The hurricane page carries a live map: NHC forecast tracks and cones with
10-day observed storm history, NOAA saildrones, ~50 gliders from four national
data centres (US, UK, Canada, Sweden), ~4,000 Argo floats, animated global
currents at the surface and 60 m that sharpen to 1/12° as you zoom in,
ECMWF 10 m wind and 2 m air temperature at the model's own 0.25 degrees, sea-surface temperature from both an observed analysis
(OISST) and the Navy forecast, Navy sea-surface salinity, isobaths from 20 m
to 10,000 m with an opacity the reader sets, a detailed coastline, and EEZ
boundaries. The map fills the window in both axes and the page's text aligns
to its edges. The ESPC layers show the step nearest the reader's own clock
rather than a fixed offset from the model run — the currents publish the
two steps spanning a six-hour window and the map opens on whichever is
nearest the reader's own clock, so the field is at worst about 1.5 hours
from them — and the attribution says which hour is drawn and how far from
now that is. The buttons that stepped between the two frames are gone: the
answer was "now" almost every time, and the module still builds them
wherever a page supplies the hook. Twenty-five colour
scales, with the range either following the view or pinned by hand, and a
reset that puts everything back. Hovering an asset names it; clicking one
reports its details plus the depth, current, wind, temperature and — when the
EEZ layer is on — the jurisdiction of the water it is in; right-click or
long-press does the same anywhere. There is a distance and bearing tool. Two menus under it — `Region` jumps to
one of a dozen places without touching the layers, `Layers` checkboxes sets of layers and
colour scales without moving the map — several at once give the union — and
Reset is the first entry of the second.
The address bar carries the whole view — where you are looking and everything
you have set — so the URL is a link to exactly what is on screen, with a
`Copy link` button beside the map for a phone. Opening one restores it and
outranks whatever view you last left behind; pasting one into a map you
already have open works too. One button beside it saves the figure as a PNG,
doubled for print, with the colour bar, the particle keys and the credit line
in a band underneath, so a figure that ends up in a talk or a paper carries
its own provenance. One button takes a reader's own data over the top — KML,
KMZ, GeoJSON or a shapefile, zipped or as loose `.shp`/`.dbf`/`.prj` parts —
with the format decided from the bytes rather than the file name, 0–360
longitudes folded (and the fold reported), and a projected shapefile refused
by name rather than drawn in the wrong ocean. A pasted link works the same
way where the host sends CORS — measured, IOOS's ERDDAP does and PMEL's does
not, which is per-deployment configuration rather than a property of ERDDAP.
Above the map, an active-storm status line that updates without a reload;
beside that, a server-synchronised UTC clock. The page refreshes itself when
a new build lands, keeping your basemap, layers and position.

**Sea ice** is on both maps: concentration from an observed analysis (OISST)
and from the Navy forecast, plus Navy ice thickness, at the model's native
0.08° through a tile tier. Concentration draws in its own pane *over*
temperature — it paints nothing below 15%, so the water at the pack's edge
shows through — while the two ice quantities stay exclusive with each other.

**The reader controls the velocity fields.** Particle colour is chosen at
runtime against whatever is behind the particles, and the picker offers
swatches painted in the colour that will actually be drawn, only for choices
that clear the contrast bars. A speed slider per field scales its calibrated
drift from a quarter to four times; direction, relative speeds and the m/s in
the readout are untouched.

**Chrome follows the layers.** Legend keys, both particle controls, each
field's colour-scale set and every fact in the status line appear only while
something they describe is on. The data credit sits below the map rather than
floating over it, and the lat/lon grid is labelled with spacing that follows
the zoom.

The same map now carries two pages. `/visualization/` is the general-purpose
one — bathymetry, surface flow and a shoreline over the whole ocean, with
everything else a switch away — and it replaced News in the navigation. The
news pages and their feed are untouched at `/news/`, still linked from the
home page and the footer; only the nav entry moved. A page differs from
another by its preset and its home bounds, nothing else.

The map is no longer part of the page. It is `packages/ocean-map`, an npm
workspace package — configurable, multiple-instances-per-page, self-styling,
fully typed against a published data contract, with the renderer-independent
half split out so a native port can keep it. `AssetMap.astro` is 86 lines of
placement. The package carries its own hand-offs: `EMBEDDING.md` for another
website, `PORTING-IOS.md` for the iOS app, and `BOUNDARIES.md` for anyone
adding to it — those separations are what keep the other two possible, and
they are easy to breach by accident.

`npm run verify` stands at **1,301 printed `ok` lines** across fourteen
steps: build, type-check, docs, then eleven test suites — the
renderer-independent units, TEOS-10 against GSW, the ballast arithmetic, the
published data contract, colour contrast, the rendered map, two maps on a
page, each calculator against its built bundle, the built pages' whitespace,
and the clock. Counted as `npm run verify | grep -c '^ok'`, which is the only
figure here anyone can reproduce — note one of those lines covers all 34
published files at once, so it undercounts what the contract step actually
checks.

Re-count with that command rather than trusting this number; it has now gone
stale three times. The last figure here was 951 across nine steps, from
before either calculator existed — which is the useful lesson about this
number rather than the number itself: it goes stale by a *suite* at a time,
not by an assertion, so a step list that no longer matches `package.json` is
the tell.

### Splitting `index.ts`

It reached 4,542 lines in one closure. The problem is **ordering, not
size**: three bugs in a single session were use-before-declaration inside
it, and `astro check` cannot see any of them because each sat in a callback
that could not run until later. A module boundary turns that into a
signature.

Done, one at a time with `verify` and a browser check between each:

- `graticule.ts` — the lat/lon grid. Captured nothing but the map.
- `measure.ts` — distance and bearing. Had been declared *700 lines below*
  one of its callers.
- `scalar-layer.ts` — the field raster, `FIELDS` and `FieldDescriptor`.

That was ~500 lines out, leaving ~4,030 at the time.

**It is 4,704 today**, which is the number that matters and the one this
entry kept getting wrong. The split's gain has been more than repaid by what
landed after it — the share codec, the PNG export, the place and interest
menus, the particle colour pickers and the speed sliders each left a
renderer-bound half in `index.ts` — and the file is now past the 4,542 that
started this. Nothing moved back; the seams below simply have not been taken
as fast as features arrived. The argument for the next one is stronger than
when the first was taken, not weaker.

**The bug class is gated now, ahead of the refactor.**
`scripts/lib/forward-refs.mjs` parses the file with TypeScript's own parser
and `test:map` fails on a binding read at statement level but declared
further down — the ReferenceError-on-load shape. It reads 182 declarations
and 632 setup-time references today and flags none. References inside
function bodies are deliberately exempt, which is the line between a crash
and the ordering smell the split is actually for.

The rule that has held: **behaviour moves, the reader's state stays.**
`choices` and `particleTint` are per map; a module-level copy would put two
maps on a page back to sharing one, which is the singleton bug this package
already paid to remove.

Still to lift, roughly in order of independence: the isobath tiers, the KMZ
drawing side (`kmz.ts` and `warp.ts` already hold the parsing), the point
readout, and the chrome/controls block.

## Done: the two ESPC steps nearest now, six-hourly

Shipped 2026-08-05. `LEADS = [36]` is gone from both pipelines; they choose
their step by valid time, snapping the clock back to a six-hour boundary.
The currents publish the two steps spanning that window and the fields
publish the last of it. Measured on the live aggregation the same evening:
the newest run was 57 hours old, so the old T+36 was valid 08-05 00Z — 21
hours behind — and the new selection returned 18Z and 21Z, the second of
them the reader's own hour.

Three things went differently from the spec above, and each is worth
knowing before touching this again.

**The cron did not change, and could not.** The spec called for currents on
`0 */6 * * *`. The pipelines do not run in this repository — `ocean-data-repo`
checks this one out and runs them hourly, in one job that publishes the whole
tree, so there is no way to run currents on a different schedule without
splitting the publish in two. It is also unnecessary: what six-hourly means
here is that the *selection* is stable for six hours, so five hourly builds in
six restore their tiles from cache. The rate is set by `REFRESH_HOURS`, not by
a schedule.

**Each pipeline keys its own tile cache.** The spec said `--run` should print
the steps too; that would have moved the *field* tile key with the currents'
step, since the workflow used the currents' run for both. `--run` still prints
the run, and both pipelines gained `--tile-key`, which names what their own
tiles contain.

**The fields publish the window's last step, not the anchor.** The map opens
each layer on the frame nearest the reader, which for four and a half hours
of every six is the currents' later frame — so a field pinned to the anchor
would disagree with the current beside it most of the time, and the credit
line names an hour but not a quantity, so two ESPC lines cannot be told
apart. This also puts the field at worst three hours from the reader instead
of six.

### Three bugs it exposed, all silent, none of them new

- **The ESPC ice aggregation is hourly**, where `uv3z` and `ts3z` are
  3-hourly. Selecting "the next two consecutive steps" put the ice an hour
  past the anchor while everything else was three. Caught by the new
  schema check on the first build after it existed; the fix is to state the
  window in hours.
- **A stepped flow layer went on drawing the hour it was built with.**
  `applyView` pushes a grid into the layer only when the wanted tier differs
  from the drawn one, and `null` is a legitimate tier — the globe. Clearing
  the drawn tier to `null` to force a redraw was indistinguishable from
  "already showing the globe". Measured: the flow at 48.6S 63.8W read
  0.14 m/s toward 231°T on both frames, where the grids differ in 93% of
  their wet cells and reverse at that point.
- **A stepped layer went on crediting that hour too.** Leaflet reads
  `options.attribution` once, when a layer is added. Neither the flow layer
  nor the scalar layer restated it, so this was never right — it was just
  never visible with one frame.

### What it actually cost

Measured on the first deploy, not estimated: the assembled tree is **678 MB**
against a prediction of 684. The two current frames are 367 MB of that across
both depths, the four field tile sets 138 MB. Both tile caches missed and
rebuilt, as intended by the new keys, and both saved.

### What holds it

- `check:docs` — both pipelines' `REFRESH_HOURS` and window widths must
  agree, before anything is asked of HYCOM.
- `test:schema` — every ESPC hour must be one the currents publish *from
  the same run*; and a grid and its tiles must be the same hour. A run
  mismatch is a note: the aggregations ingest a new run minutes apart, and
  failing on that once blocked four hourly publishes.
- `test:map` — a stepped hour must reach the layer and its credit.

### If HYCOM starts refusing

Look at the read count first. One frame per run was ~1,270 reads a day;
this is roughly **7,600** — the currents rebuild two frames four times a
day, and the fields are dragged to the same cadence by the shared anchor.
`REFRESH_HOURS` is the lever, and it cannot go above six without aliasing
the tide.

## Queued: ECCOFS

ECMWF 2 m air temperature landed on 2026-08-05 and has been removed from
here. What is left is specified and not started, and it is large enough to
want a fresh context of its own.

### 2. ECCOFS, from NOAA's open-data bucket

New data repository, as asked: **`oceansensing/eccofs-data-repo`**, on the
model of `ocean-data-repo` — pipelines stay in this repo, that one checks
this one out and runs them, `schema.ts` stays the contract, and its own
Pages site gets its own gigabyte.

**Source: `s3://noaa-nos-eccofs-pds`** (us-east-1, public, no credentials),
via NOAA NODD. The East Coast Community Ocean Forecast System — Rutgers,
UC Santa Cruz, Fathom Science and NOS, ROMS 4D-Var, **3 km horizontal and
50 vertical levels**, a new 5-day forecast each day off an analysis
assimilating three days of observations. Grand Banks to the Orinoco.

**It carries exactly the ESPC set minus the ice**: `temp`, `salt`, `u`, `v`,
`ubar`, `vbar`, `zeta`. So the request is answerable as asked — but the cost
is not in the fetching, it is in the grid.

Probed 2026-08-05. Everything below is measured, not assumed.

**What makes this the largest data task yet.** The output is on the model's
own **curvilinear, terrain-following, staggered** grid, and every reader in
this repo assumes a regular lat/lon lattice. Three transformations stand
between the bucket and anything the map can draw, and each has a silent
failure mode:

1. **Regrid curvilinear to regular lat/lon.** `lat_rho`/`lon_rho` are 2-D
   arrays of **1443 x 1667** — 2.4 million points a level. There is no axis
   to index; a nearest-neighbour or bilinear resample onto our lattice has
   to be built.
2. **Interpolate s-levels to fixed depths.** "60 m" is not a level here.
   Getting it needs `h`, `zeta`, `Cs_r`, `hc`, `theta_s`, `theta_b` and the
   `Vtransform`/`Vstretching` cases — all present in the file, all easy to
   apply to the wrong one of the two transforms and get a plausible answer.
3. **Rotate the velocities.** `u` is on 1443x1666 and `v` on 1442x1667 — an
   Arakawa-C stagger — so both must be averaged to rho points and then
   rotated by `angle` to get true east/north. **Get this wrong and the
   currents look entirely plausible and flow the wrong way**, which is the
   failure class the "four ways particle rendering went wrong" section is a
   catalogue of. Measure it against a known feature — the Gulf Stream is
   right there — rather than eyeballing the field.

**And it needs dependencies, which is the part to decide first.** The files
are **NetCDF-4/HDF5** (magic `\x89HDF`), `avg` at **7.6 GB** each and eight
a day, `qck` at 1.6-12 GB. **There is no OPeNDAP anywhere**: the Rutgers
THREDDS carries only a 2024 demo week, and `eccofs.fathomscience.com` has no
THREDDS path. So there is no server-side subsetting and no possibility of
downloading whole files in CI — the only way in is HTTP range reads into
chunked, probably compressed HDF5, which in pure standard library is writing
a small kerchunk against a format we do not control, where a mis-decode
looks like plausible ocean.

That is the same argument that bought `eccodes` for the wind, and it should
be settled the same way: **this pipeline takes `h5py` and `numpy`** (and
whatever the resampler needs), and it lives in `eccofs-data-repo` so the
blast radius is one repository. `h5py` reads S3 directly through its `ros3`
driver. Every other pipeline stays standard-library only.

**The four-day lag is systematic, and it decides what this layer is.**
Checked against the upload timestamps rather than assumed: data for
2026-06-08 landed 06-12, 06-09 landed 06-13, 06-10 landed 06-14, and
2026-08-01 landed 08-05. **Four days, consistently, across two months.**

So this is not a nowcast and must not be labelled as one. It is a 3 km
*recent analysis* — which is still worth having, and is arguably the more
honest thing for an assimilating model to publish, but it is a different
proposition from the ESPC layers beside it. The attribution machinery
already prints how far from now a field is valid, so a reader would see it;
what matters is going in knowing, rather than discovering it after the
resampler is written.

**What it buys** is worth the work: 3 km over the lab's own waters against
ESPC's 1/12°, roughly 27 times the resolution by area, with data
assimilation behind it.

**Optional companion, and much cheaper.** `ECCOFS_INSITU_OBS` on the Rutgers
ERDDAP is the observation set this model assimilates — tabledap, long
format, `type` 6 and 7 being the ROMS codes for temperature and salinity,
~178,000 obs a day of which ~17,000 are shallower than 5 m, live to
yesterday. Drawn as points on the same ramp and range as the field beneath
them, a reader could see model and observations disagree. It needs no new
dependency and shares the repository. Argo is the precedent for the
renderer; the thinning rule needs measuring rather than guessing.

## The two calculators

Both are new and both carry an under-test notice; the language on them is
factual rather than instructional.

`/data/seawater/` evaluates the TEOS-10 Gibbs function directly — IAPWS-09,
IAPWS-08, and IAPWS-06 for the freezing point — rather than the 75-term
polynomial GSW uses by default, so every property is thermodynamically
consistent with every other one. Fifty-one properties, filterable, with the
Absolute Salinity anomaly applied from a position via a 188 KB atlas fetched
only when one is entered. The physics is `packages/teos10`, checked against
GSW at twenty-four points, against a central difference of each derivative
branch over a few thousand states, and against physical anchors.

`/data/glider-ballast/` uses that engine for glider ballasting: tank
properties, vehicle properties, three water points, and the operator's choice
of which to be neutral at. It reports the ballast change, the resulting tank
reading, the neutral density, the ballasted mass, a row per point, and whether
the buoyancy engine can surface and dive. The arithmetic is
`packages/glider-ballast`.

### Open on the calculators

- **No vehicle carries manufacturer data.** All four families ship
  illustrative values — masses are round figures, volumes are the mass over
  1025 kg/m³, and both hull coefficients are order-of-magnitude. Replacing any
  one of them with a real ballast sheet is a data change: an entry in
  `packages/glider-ballast/vehicles.ts` with `illustrative: false`, which
  turns off the page's caution for that vehicle. This is the single most
  valuable thing anyone could contribute to the ballast page.
- **The ballast arithmetic has no reference implementation to check against.**
  TEOS-10 has GSW; ballasting has per-vehicle spreadsheets. The gate is
  identities, TEOS-10's own compressibility, and hand calculations, which is
  the best available but is weaker than what `test:teos10` gets. A comparison
  against a real operator's spreadsheet would close the gap.
- **The hull model is first order in pressure and temperature.** It does not
  account for oil volume changing with temperature, air trapped in the
  fairing, water absorption by foam, or vehicle attitude. Adding any of those
  needs a vehicle to calibrate against.
- **Neither calculator has been used in anger.** The under-test notice comes
  off when someone has run a real ballast against a real tank test, or checked
  a cast's densities against their own processing.

## Open items

### Content the lab needs to supply

- **Two publications are unverified.** `src/data/publications.bib` lines 189
  and 210 are marked `% UNVERIFIED — reconstructed from website citation`
  (Wiese 2018, Panetta 2017). Every other entry came from DOI content
  negotiation. Either confirm the details or drop them.
- **Two people have no photo:** James Guymon and Jonathan Williams. Add a
  headshot to `src/content/people/` and a `photo:` line to their Markdown.
- **Jonathan Williams' bio is a placeholder** — one sentence, the thinnest on
  the page. Worth a real one alongside the photo.
- **Three 2017-08-24 frames of DG with the drone** were left out of the HAB
  survey set as portraits rather than observations. They may suit the People
  page instead; they are in the source drone directory, not the repo.

### Prose to check

- **The HAB page makes process claims that Claude drafted, not the lab.** The
  opening paragraph asserts blooms "form, drift, and dissipate over hours to
  days, at spatial scales of tens to hundreds of meters — too fine for
  satellites to resolve through clouds and too fast for ship surveys to
  chase." That is plausible and conventional, but it is not sourced and it is
  the kind of claim a PI should sign off on. Same for "where blooms
  concentrate and where conventional platforms struggle to sample."

### Next, and who it needs

- **The site's own content is now the gap, not the map.** Two people have no
  photograph (`james-guymon`, `jonathan-williams`), Jonathan Williams' bio is
  a placeholder, two BibTeX entries are `% UNVERIFIED` — reconstructed from
  the old site rather than DOI-negotiated — and the HAB page carries unsourced
  process claims. The citations can be chased without anyone's help; the
  photographs cannot.
- **Two map improvements are deliberately not done**, and both are recorded in
  `packages/ocean-map/README.md`. The module could build its own chrome, which
  would reduce a second deployment to one `<div>` — worth nothing to the iOS
  port, which is why it is last. And the platform layers assume this fleet;
  making them pluggable is blocked on a second use defining what it needs
  rather than on effort.

### Two gaps in `test:map`, both known and both unclosed

Recorded because a gate nobody knows the limits of is worse than one with
them written down.

- **The chrome-on-arrival check does not exercise the restore path.**
  `test:map` now asserts that every legend key agrees with its layer *before
  anything is touched* — the invariant that broke twice in one session. It
  passes, and mutation-testing shows it would also pass with the fix removed:
  `SEEDED_VIEW` has no `known` list, so `restoreView` treats its `overlays`
  list as the whole known set, wants every entry, and only ever adds. Nothing
  changes after the first sync, so there is no disagreement to catch. Making
  it bite needs a seed that turns a platform layer *off*, which needs a
  `known` list — and the absence of one is deliberate, being what tests the
  pre-`known` older-view fallback. One map per run cannot seed both. The fix
  is a second map instance in the harness, or a second harness.

- ~~An uncaught error during map setup does not fail anything.~~ **Closed.**
  `test:map` listens on `window.onerror`, the window's `unhandledrejection`
  and Node's own, and fails the run on any of them. Mutation-tested by
  reinstating the original temporal-dead-zone fault: the run used to pass 230
  checks with the map half-built. One rough edge left — for that fault the
  harness dies during import rather than reaching the check, so `verify` sees
  a crash rather than a named failure. It fails either way, which was the
  missing property; a tidier report would be nice and is not urgent.

### The exclusivity checkbox desync

When one layer displaces another the displaced layer's checkbox stays ticked,
so the control shows a layer that is not drawn. Confirmed to predate the ice
work — SST and SSS, exclusive from the beginning, do it too — and it is the
same Leaflet-re-adds-during-its-pass quirk the deferred-by-a-tick note in
`CLAUDE.md` describes. A ticked box for an undrawn layer is exactly the
"wrong and says nothing" shape this project keeps chasing.

### Polar stereographic, as a selectable map mode

**Not started, deliberately.** Recorded here so the shape of it is known
before anyone commits: this is the largest change proposed to the map so far,
and it is not a setting. Web Mercator is assumed in more places than the
projection layer.

The ask is a mode selector — Mercator by default, north polar and south polar
as alternatives — applying to every product rather than to ice alone. It is
the right way to look at ice: Mercator puts the pole at infinity, so a polar
band is drawn at the one aspect ratio that makes it unreadable, which is
exactly what the ice layers now show.

**What carries over.** Leaflet takes a custom `L.CRS`, and polar stereographic
is closed form — roughly forty lines, no proj4, the same bargain
`fetch-coastline.py` struck with the shapefile reader. It is also
**conformal**, like Mercator, so the particle layer's central claim survives:
a vector still maps to the screen scaled by one local factor, and
`x += u * drift` is still the whole of the advection.

**What does not, worst first:**

- **Basemaps. Probed 2026-08-05, and the answer is yes — but not the way
  this entry used to claim.** It said GEBCO's WMS serves EPSG:3413/3031.
  **It does not**: `wms.gebco.net` advertises exactly `EPSG:3395`,
  `EPSG:3857` and `EPSG:4326`. No polar projection at all. That was the one
  thing this whole idea was said to hinge on, and it was wrong.

  What does work, in order of what it costs:

  - **The vector layers reproject for free.** `coastline.json` and the
    isobaths are lat/lon geometry drawn through Leaflet's CRS, so a polar
    CRS draws them correctly with no new data and no rebuild. The repo
    already ships a vector basemap, which is very likely the right
    basemap for an ice map anyway.
  - **IBCAO for the Arctic bathymetry, IBCSO for the Southern Ocean**, and
    the natural shape is *contours, not tiles*: neither is served as polar
    tiles by anything found so far, but both are published as grids, and
    `fetch-bathymetry.py` already contours a local GEBCO grid by hand into
    the isobath layer. The same treatment gives polar isobaths at the
    resolution those products exist for — and being vector, it sidesteps
    the reprojection problem entirely rather than working around it.
  - **NASA GIBS serves real EPSG:3413 tiles** if a raster is wanted: 895
    layers, including `BlueMarble_ShadedRelief`, and — worth noting on its
    own — polar-native sea ice concentration at **12 km** against the
    25 km analysis this map draws today.
  - **NCEI has `arctic_ps` and `antarctic` folders in EPSG:3995**, but
    reference lines and graticules only, no bathymetry raster.

  So this is no longer the blocking question. What it becomes is a
  *choice*: vector-only (cheapest, and honest for ice), or vector plus a
  GIBS raster.
- **Particle direction.** Conformality preserves the scale factor and *not*
  the rotation: north is only up along one meridian. Every velocity needs
  rotating by the grid convergence angle before it is advected. Get it wrong
  and the field looks entirely plausible while flowing the wrong way — the
  failure shape the whole "four ways it went wrong" section of `CLAUDE.md` is
  a catalogue of, and the reason this must be measured rather than eyeballed.
- **The antimeridian machinery stops meaning anything.** `rehome()`,
  `rehomeBathy()`, the 360-degree folding and `worldCopyJump` all exist
  because Mercator repeats east-west. A polar view has no such seam, and has
  instead a pole singularity Mercator never has.
- **`tiles.ts`** picks tiles from a lat/lon lattice by viewport bounds, and a
  polar viewport's bounds are not a lat/lon rectangle.

**Suggested staging**, so the question gets answered before the cost is paid:
do it in `packages/ocean-map-dev`, and scope the first pass to **ice only,
over GEBCO's WMS, with no particles**. That answers what the mode exists to
answer — is the ice legible this way — without touching any of the four above
bar the basemap. Everything else follows only if the answer is yes.

**Two decisions needed before starting:**

1. Whether "all products" really means all. SST and ice in a polar view are
   legitimate and cheap; currents and wind drag in the rotation work.
2. Whether north and south are two modes or one mode with a hemisphere
   toggle. Two CRSs either way, but it changes the control and what a saved
   view has to record.

### Decisions to make

- **Vessel density has no source that covers this basin.** EMODnet Human
  Activities publishes it, and measured against the water that matters here
  it is empty: the same request returns 82 KB over the North Sea and an
  identical 3,665-byte transparent tile over the Gulf of Mexico, the
  Caribbean and the US East Coast. It is a European programme and an annual
  composite besides. The options are Global Fishing Watch, which is genuinely
  global but needs a free API token stored as a GitHub secret; NOAA's
  MarineCadastre AIS transit counts, which cover the US EEZ and would need
  the current service URL tracking down; or shipping EMODnet anyway, clearly
  labelled, if North Sea and Mediterranean work matters.
- **Two glider regions are still missing, and one is a judgement call.**
  Coriolis has a machine endpoint after all — OceanGlidersGDACTrajectories on
  the same Ifremer ERDDAP as Argo — but it is delayed mode: on 2026-08-02 its
  newest fix anywhere was 2026-06-23, with 3 gliders in the previous 45 days.
  Right for finished missions, wrong for a live map. Australia's IMOS routes
  through the AODN portal with no open endpoint. The lead worth following for
  both is the OceanOPS platform API, which knows all 3,949 OceanGliders
  platforms; this map needs only an id, a position and a time, which is what
  it holds. Its field names for last-known position were not obvious on a
  first pass.

- **A second ocean model, because ESPC stalls.** Probed 2026-08-03, and the
  question splits in two.

  *What is actually wrong.* ESPC is flaky in two unrelated ways, and only one
  of them is already handled. Per-request failures — index 70 fine, index 76
  a 500 "Stale file handle" minutes apart — are covered by `usable_step()`
  and the tile retries. The other is that the **run itself goes late**: on
  2026-08-03 the HYCOM aggregation held nine runs, daily from 07-24 12Z to
  08-01 12Z, then nothing for ~40 hours. No amount of retrying fixes that.
  Only a different model does.

  *Mercator: yes, and it is the only like-for-like option.* Same 1/12°,
  currents, temperature and salinity together. Re-checked today and the
  access story has not changed: the product's STAC record advertises a
  thumbnail and no data asset, and the ARCO S3 bucket answers **403**
  unsigned. So it needs a Copernicus account, two GitHub secrets, and the
  `copernicusmarine` toolbox — which would be the first Python dependency in
  CI, where today there are none. That is the whole cost, and it buys the
  only real answer to a stalled run.

  Two things about that access, both of which look otherwise from a search.
  **There is no API key.** The toolbox takes a username and password and
  nothing else — `--username`/`--password`, the environment pair
  `COPERNICUSMARINE_SERVICE_USERNAME`/`_PASSWORD`, or a credentials file;
  every one of those is the same secret in a different wrapper. (The API key
  belongs to the *other* Copernicus service: CDS, which is ERA5.) And the
  **OPeNDAP and ERDDAP endpoints are gone** — Copernicus announced them in
  2022 and retired them, with MOTU, FTP and WMS, in April 2024. The article
  is still the first search result, which is how it wastes an afternoon.
  There is therefore no route that the existing stdlib `urllib` code could
  take, which is what makes the dependency unavoidable rather than a
  preference.

  *The open alternatives have thinned, which is worth knowing before
  reaching for one.* NOAA retired NOMADS' OPeNDAP in 2025 (SCN 25-81), so
  RTOFS is no longer reachable the way HYCOM is. OSCAR on CoastWatch ERDDAP
  is stale since **2014-10-06**. Neither is a fallback.

  *ERA5: no, and not for effort reasons.* It is a **reanalysis, not a
  forecast** — ERA5T runs about five days behind, and CDS requests are
  queued rather than answered, which does not fit an hourly build. It is
  also atmosphere, not ocean, so it is not a fallback for anything on this
  map; it would be a new quantity. **That new quantity has since been
  built** — ECMWF open data, 10 m wind, `scripts/fetch-wind.py` — and it was
  argued on its own rather than as resilience, which is what this paragraph
  asked for. ERA5 remains a no for the reasons above.

  *How it would work, if it goes ahead.* The pipelines already have the
  shape: `PRODUCTS` in `fetch-ocean-fields.py` and `BASE`/`LEVELS` in
  `fetch-currents.py` are descriptors, so a source becomes a list tried in
  order rather than a constant. Three things decide whether it is honest:

  - **The published contract already carries `source` and `modelRun`**, and
    the map already shows both. So a fallback is visible on screen the
    moment it happens, with no new mechanism — which is the difference
    between resilience and a map that quietly shows another model.
  - **Fall back as a set, or not at all.** Currents from ESPC beside SST
    from Mercator at a different hour is two oceans on one map. Either both
    switch or neither does.
  - `check:docs` currently *fails* if the page credits Copernicus while
    `MERCATOR_RASTER` is false. That guard is the right way round and would
    then require the page to name it — leave it alone.

  The old Mercator raster scaffolding is still there (`MERCATOR_RASTER =
  false`, the `currents-raster` pane, the tile definition, the blend CSS), so
  a picture-only Mercator layer remains one flag. It is not a fallback,
  though: it is WMTS imagery, and the particles need numeric u/v.
- **The data moved out, and so did the photographs.** Done 2026-08-03.

  `oceansensing/ocean-data-repo` fetches the real-time data hourly at :05 and
  publishes it without committing any of it; the static half — isobaths,
  coastline, borders — is committed there because the seafloor does not churn
  and cannot be rebuilt in CI anyway. `oceansensing/hab-data-repo` holds the
  95 bloom photographs and makes their derivatives.

  What it bought, measured: `.git` 129 MB → 36 MB after the history rewrite,
  `dist/` 71 MB → 12 MB, the published site ~904 MB → ~12 MB against a 1 GB
  Pages cap, and a site build of about three minutes with no Python in it.

  Two things worth carrying forward. **Pages limits are per site, not per
  account** — an earlier note here claimed a separate account bought separate
  quotas and it did not; the second *repository* is what bought the room.
  And **project pages inherit their organisation's custom domain**, so both
  repositories serve from `oceansensing.org/<repo>/` rather than github.io,
  which is why `robots.txt` disallows both paths: they are not offerings.

- **Payload.** Currents come in three tiers per depth: a 0.96° global grid
  with the page, 0.24°/0.12° regional grids on zooming in, and 1/12° tiles
  per view at zoom 7+ (79–144 KB each). SST is two tiers — OISST has no tile
  tier because its regional grids are already at its native 1/4°. Argo is
  61 KB gzipped. What the *site* carries, built by CI and never committed:
  ~92 MB of current tiles per depth (two depths) and ~39 MB of Navy SST
  tiles. That is a deploy cost, not a reader's — someone working one region
  fetches a handful of tiles.
- **The Hurricane Florence cover has no visible credit.** The page now opens
  on the map, and the credit line lived under the hero that was removed, so
  the attribution survives only in the Markdown front matter. NASA imagery is
  public domain and needs none, but the lab may want it shown somewhere.

### Known limits

- **The isobaths are a reference layer, not a chart.** They are contoured
  from GEBCO 2026 at 15" but sampled at 0.008° (~925 m) for the tiles and
  0.033° for the global overview, so neither is survey resolution and
  neither should be navigated on. At 123 MB raw they are also the largest
  thing in the repo; halving the sampling would halve that and roughly
  double the vertex spacing, from 2.0 screen pixels at zoom 7 to about 4. Contours smaller than 0.1° (200-1000 m) or 0.3° (2000 m
  and below) are dropped as sampling speckle, so small seamounts and abyssal
  hills are absent by design. The 8000 and 10,000 m levels exist only in the
  trenches — 26 and 3 lines globally — so most of the map shows none.

- **Seventeen of the twenty-five colour scales cannot keep the markers
  visible**, and that is accepted rather than fixed. Every stop of every map
  is measured against every feature colour; the five under *High contrast*
  clear ΔE 22 everywhere, and none of the standard maps does — a full-gamut
  colormap sweeps the whole wheel, so somewhere along it it passes close to a
  marker. Worst clearances run from `cmo.haline` at 11.2 down to `inferno` at
  3.0. They are offered because the choice belongs to the reader, they are
  not defaults, and the markers keep their dark outlines. What is still
  guaranteed is that the labelling is honest in both directions.

- **Full-resolution tiles are cached in CI, not committed.** If the Actions
  cache is evicted (7 days unused) the next build rebuilds them — 159 of 162
  current tiles per depth, plus a Navy temperature set and a Navy salinity
  set at ~43 MB each. Nothing breaks; it is just slower that once.
- **The Navy field tile runs depend on HYCOM behaving.** It fails per request
  rather than outright. With retries and backoff a healthy run now completes
  clean — the last one wrote 159 of 162, 3 all land, 0 failed — but a bad
  spell left 145 of 162 earlier the same day. Where a tile is missing the map
  falls back to the coarser grid silently; the run itself counts the failures
  and exits non-zero. CI retries on the next model run.
- **Currents can still bleed slightly over land**, though much less than
  they did — and far less again at 1/12°, which is what any view at zoom 7+
  now gets. Coastal erosion plus the finer regional grids cut it hard — over
  Greenland–Svalbard from 3.1% of land to 0.6%, peak 0.91 to 0.34 m/s — but
  an island smaller than a grid cell (Bjørnøya) sits in open model water
  whatever the resolution. Since zoom 7+ now serves 1/12° everywhere, this
  mostly bites at zoom 5–6, between the regional grids and the tiles.

### Needs a human eye

- **Rendering is now observed, not only measured.** A real browser is
  attached, so the animation, the SST raster, the hover labels and the popups
  have all been watched running at ~120 fps rather than inferred from draw
  calls. Two things still came from a reader rather than any check, and both
  were invisible to a green suite: the currents vanishing at globe zoom, and
  the Argo fleet sliced at the date line. Both now have regression checks.
  Screenshots from a real device remain the fastest way to catch a rendering
  fault — every visual bug this project has had was reported that way.

### Depends on someone else's service

- **HYCOM is flaky per request, not up or down.** It serves some time steps
  and not others, and metadata keeps working throughout so it looks healthy.
  `fetch-ocean-fields.py` probes a step before using it and retries tiles with
  backoff; `fetch-currents.py` has neither guard and degrades to the previous
  file instead, which is why an outage there shows as stale rather than
  wrong. Worth giving the current pipeline the same treatment.
- **Glider coverage is four countries, not the world.** IOOS (US), NOC/BODC
  (UK), OTN (Canada) and VOTO (Sweden) are the regional OceanGliders
  endpoints that expose an ERDDAP. Coriolis publishes through a selection
  portal with no machine endpoint, and `erddap.aodn.org.au` does not resolve,
  so Europe-wide and Australian gliders are missing. Both would need a
  different access route rather than another entry in `GLIDER_SOURCES`.
- **Seafloor depth in the point readout** comes from NOAA's ArcGIS
  ImageServer DEM mosaic, live, per click. It is the only bathymetry service
  reachable from a browser that sends CORS. If it goes away the readout says
  "unavailable" and everything else still works; the fallback would be
  pre-generating ETOPO tiles, about 35 MB, which is why it was worth checking
  for a live source first.

## Conventions worth keeping

- Content is data. Adding a paper, person, project, dataset, or CV line should
  never require editing layout code. If it does, the schema is wrong.
- Photo captions on observation pages state facts only — no interpretation of
  process. This was an explicit instruction and it is easy to drift from.
- Claims about what the lab uses should match what the lab actually uses. An
  early draft claimed multispectral and hyperspectral imaging; it does not.
- Where a component's correctness is not visible in the built HTML, write a
  harness that runs the built bundle (`scripts/test-map.mjs`,
  `scripts/test-clock.mjs`) rather than a test that reimplements the logic.
- **Measure across a range, not at a point.** Several bugs here survived a
  green suite because a check sampled one zoom, one basemap, or one colour:
  particle drift that was fine at the tested zoom and 100× off elsewhere, a
  contrast gate that passed a colour the blend mode then erased. A single
  sample cannot tell "correct" from "correct here".
- **Put the check where the bug can show.** A date-line regression test was
  placed at 20°N, where the prime meridian crosses the Sahara and the column
  is blank either way — it passed against the bug it was written for. Moved to
  open water it still passed, because it looked for a single empty column
  while the gap was a whole grid cell wide. Two wrong versions before a
  working one, both green.
- **A test written to match code just written proves little.** Seeding a
  fixture from the same assumption as the implementation makes them agree by
  construction — a saved-view test that used the new format never exercised
  the old-format path that every real browser had. Break the code
  deliberately and confirm the test goes red before trusting it.
