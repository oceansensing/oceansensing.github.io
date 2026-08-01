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
5-day observed storm history, NOAA saildrones, IOOS gliders, ~2,000 Argo
floats, and animated global surface currents that sharpen to 1/12° as you
zoom in. Above it, an active-storm status line that updates without a reload;
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

- **The animated current layer is not Mercator.** Mercator was the original
  ask, and the static speed raster still is — but that layer is rendered
  tiles, and particles need numeric u/v. Copernicus publishes those only
  behind credentials; their old open OPeNDAP hosts are dead. So the animation
  runs on the US Navy ESPC-D-V02 global forecast (via HYCOM), which is open
  and the same 1/12 degree resolution. Both layers name their model in the
  switcher. If Mercator specifically matters for the animation, it is doable:
  add Copernicus Marine credentials as GitHub secrets and the pipeline can
  pull u/v from the toolbox instead. That needs a Copernicus account.
- **Payload.** Three tiers: a 0.96° global grid loading with the page
  (~118 KB), 0.24°/0.12° regional grids fetched on zooming into them, and
  1/12° tiles covering all ocean fetched per view at zoom 7+ (79–144 KB
  each). The Mercator raster's 707 KB stays opt-in. The site itself carries
  92 MB of tiles, built by CI and never committed — that is a deploy cost,
  not a reader's.
- **The Hurricane Florence cover has no visible credit.** The page now opens
  on the map, and the credit line lived under the hero that was removed, so
  the attribution survives only in the Markdown front matter. NASA imagery is
  public domain and needs none, but the lab may want it shown somewhere.

### Known limits

- **Full-resolution tiles are cached in CI, not committed.** If the Actions
  cache is evicted (7 days unused) the next build rebuilds all 159 tiles,
  which adds about a minute. Nothing breaks; it is just slower that once.
- **Currents can still bleed slightly over land**, though much less than
  they did — and far less again at 1/12°, which is what any view at zoom 7+
  now gets. Coastal erosion plus the finer regional grids cut it hard — over
  Greenland–Svalbard from 3.1% of land to 0.6%, peak 0.91 to 0.34 m/s — but
  an island smaller than a grid cell (Bjørnøya) sits in open model water
  whatever the resolution. Since zoom 7+ now serves 1/12° everywhere, this
  mostly bites at zoom 5–6, between the regional grids and the tiles.

### Needs a human eye

- **Nobody working on this has watched the particles move.** They are
  verified only indirectly — the harness records canvas draw calls and
  confirms segments are stroked, in the checked palette, at ~1.6 px a frame,
  and holding steady across zoom levels. That indirection has a track record:
  the runaway-speed bug reached the live site and was found by a reader
  looking at it, not by any check here. The browser in this environment never
  paints, so screenshots from a real device remain the fastest way to catch a
  rendering fault. The data, grid geometry,
  land masking, pane order, plugin loading and per-frame drift were all
  verified numerically, but the headless browser here never paints — it
  reports zero animation frames per second — so the animation itself was
  never observed. Worth a look on the live site, along with whether the
  particles now read as prominently as intended.

### Depends on someone else's service

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
- **A test written to match code just written proves little.** Seeding a
  fixture from the same assumption as the implementation makes them agree by
  construction — a saved-view test that used the new format never exercised
  the old-format path that every real browser had. Break the code
  deliberately and confirm the test goes red before trusting it.
