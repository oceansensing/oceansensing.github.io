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

The hurricane page carries a live map — NHC forecast tracks and cones, NOAA
saildrones, IOOS gliders, 5-day asset tracks, Mercator surface currents — an
active-storm status line, and a server-synchronised UTC clock.

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
- **Payload.** The animated field is two grids: global at ~0.96° loading with
  the page (107 KB gzipped), and 0.24° over the Atlantic fetched only on
  zooming in (136 KB). The Mercator raster's 707 KB of tiles stays opt-in.
  If the detail region should cover somewhere else — the Nordic Seas for
  NORSE, say — it is a bounding box in `scripts/fetch-currents.py`; a second
  detail region would need the map to pick between several rather than one.
- **The Hurricane Florence cover has no visible credit.** The page now opens
  on the map, and the credit line lived under the hero that was removed, so
  the attribution survives only in the Markdown front matter. NASA imagery is
  public domain and needs none, but the lab may want it shown somewhere.

### Needs a human eye

- **Nobody has watched the particles move yet.** They are now verified
  indirectly: the harness records the canvas draw calls and confirms segments
  are stroked, in the checked palette, moving 1.5 px a frame. Colour is
  settled by `npm run test:contrast`. But no one has actually looked at the
  finished animation — the browser here never paints, and Claude in Chrome
  was not connected. Worth a glance. The data, grid geometry,
  land masking, pane order, plugin loading and per-frame drift were all
  verified numerically, but the headless browser here never paints — it
  reports zero animation frames per second — so the animation itself was
  never observed. Worth a look on the live site, along with whether the
  particles now read as prominently as intended.

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
