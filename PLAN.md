# PLAN.md

Running record of where the site stands and what is still open. Update as
things land; delete items once they are done rather than marking them.

## Where it stands

Live at <https://oceansensing.org> (GitHub Pages, HTTPS enforced, apex not
`www`). Every push to `main` deploys; a scheduled run also rebuilds hourly to
refresh the map data.

Built and deployed: home, research (with per-project pages and a past-projects
split), people, publications from BibTeX, presentations, news + RSS, data &
tools, per-person CVs at `/cv/<person-id>/`, and Significant Observations
(harmful algal blooms, hurricanes).

The hurricane page carries a live map: NHC forecast tracks and cones with
5-day observed storm history, NOAA saildrones, ~50 gliders from four national
data centres (US, UK, Canada, Sweden), ~4,000 Argo floats, animated global
currents at the surface and 60 m that sharpen to 1/12° as you zoom in,
sea-surface temperature from both an observed analysis (OISST) and the Navy
forecast, Navy sea-surface salinity, isobaths from 20 m to 10,000 m with the
coastline and an opacity the reader sets, and EEZ boundaries. Twenty-five colour
scales, with the range either following the view or pinned by hand, and a
reset that puts everything back. Hovering an asset names it; clicking one
reports its details plus the depth, current, temperature and — when the EEZ
layer is on — the jurisdiction of the water it is in; right-click or
long-press does the same anywhere. There is a distance and bearing tool.
Above the map, an active-storm status line that updates without a reload;
beside that, a server-synchronised UTC clock. The page refreshes itself when
a new build lands, keeping your basemap, layers and position.

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

- **No layer on the map is Mercator any more.** Mercator was the original ask.
  The animation never could be — particles need numeric u/v and Copernicus
  publishes those only behind credentials — so it runs on the US Navy
  ESPC-D-V02 forecast via HYCOM, open and the same 1/12°. The static Mercator
  speed raster was the one genuinely Mercator layer, and it is now switched
  off at your request (`MERCATOR_RASTER = false`), scaffolding left in place.
  If Mercator matters again, either flip that flag back, or add Copernicus
  Marine credentials as GitHub secrets and the pipeline can pull numeric u/v
  from the toolbox for the animation too. Both need a Copernicus account.
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
  from GEBCO 2026 at 15", but the deep tier is sampled at 0.033° and the
  shallow tier at 0.008°, so neither is survey resolution and neither should
  be navigated on. Contours smaller than 0.1° (200-1000 m) or 0.3° (2000 m
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
