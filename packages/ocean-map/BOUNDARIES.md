# Boundaries

The map was pulled out of one 3,200-line Astro component so it could be used
somewhere else — a second website, and eventually a native iOS app. Both are
still possible only because of a handful of separations that are easy to
breach by accident and expensive to restore.

**Read this before adding a feature to the map.** Every rule below has a test
behind it, and every one was learned by breaking it.

---

## Structural

### S1. The reading half never imports Leaflet or the DOM

`geo`, `ramp`, `tiles`, `schema`, `warp`, `kmz`, `particles`, and — since the
map learned to open GeoJSON and shapefiles — `zip`, `vector`, `geojson`,
`shapefile` and `open`.

They typecheck standalone:

```sh
npx tsc --noEmit --ignoreConfig --strict --target es2022 \
  --moduleResolution bundler --module esnext --allowImportingTsExtensions \
  packages/ocean-map/{geo,ramp,tiles,schema,warp,kmz,particles,zip,vector,geojson,shapefile,open}.ts
```

That command proves they *compile* alone and not that they are free of the
renderer — Leaflet's types resolve from `node_modules` either way, so a file
importing `L` passes it too. What actually holds the rule is `test:units`,
which imports them with no Leaflet and no jsdom at all. Re-measure the share
below with:

```sh
cd packages/ocean-map && grep -L "from 'leaflet'" *.ts | grep -v store.ts |
  xargs wc -l | tail -1        # store.ts is Leaflet-free but built on IndexedDB
cd packages/ocean-map && cat *.ts | wc -l                    # the denominator
```

**A runtime import between these modules must carry its `.ts` extension.**
Everywhere else in the package the specifier is bare, because Vite resolves it
— but these are the files `test:units` loads *directly* through Node's type
stripping, and Node's resolver requires the extension. Nothing caught this
before `zip.ts`, because until then every intra-module import here was
`import type`, which is erased and never resolved at all. The symptom is
`ERR_MODULE_NOT_FOUND` from a suite that had been passing, and `astro check`
is happy either way.

**Why:** these are what a native port keeps verbatim. Everything that moves
into them is work an iOS app does not repeat; everything left in `index.ts` is
work it rewrites. Measured today: **3,264 lines import neither Leaflet nor the
DOM, of 9,848 in the package — about 33%.** `store.ts` is deliberately not in
that count, being free of Leaflet but built on IndexedDB.

**It went 11% → 24% → 21% → 33%, and the dip is as instructive as the jump.**
The fall to 21% was not something moving back: the renderer-free files grew 60
lines while `index.ts` grew about 1,100, because the share codec, the PNG
export, the place and interest menus and the two particle controls each landed
a renderer-bound half. A share that falls while the package grows is exactly
the signal this measurement exists to give, so re-measure when adding a
feature and not only when moving one.

The jump to 33% is what a feature looks like when it is built on the right
side of the line from the start. Opening GeoJSON and shapefiles added 1,118
lines and **every one of them is portable** — `zip`, `vector`, `geojson`,
`shapefile` and `open` — against 33 lines in `index.ts`, which does nothing
but hand over bytes and draw what comes back. Leaflet has `L.geoJSON` and
using it would have put the validation, the property flattening and the
longitude fold on the wrong side, for a feature a native port would then have
to write from scratch.

`test:units` imports these with no Leaflet and no jsdom at all, which is what
makes any of this checkable rather than argued.

`particles.ts` — the advection maths behind the animated fields — arrived by
*replacing a dependency*, which is still the cheapest way this share has ever
moved: `zip.ts` did the same for jszip, and `shapefile.ts` for shpjs and the
projection library it drags in.

`kmz.ts` is the pattern to copy when something *seems* to need the DOM: it
parses XML, which in a browser means `DOMParser`, so the parser is **injected**
rather than imported. That keeps the file testable in Node and portable to
Swift, and it is why `warp.ts` — the projective transform behind
`gx:LatLonQuad` overlays — could follow it out.

**So:** new logic that does not need `L.` goes in one of these files, not in
`index.ts`. A `Point` is `{lat, lng}` — a plain pair, which `L.LatLng`
satisfies structurally, so no call site needs converting.

*Enforced by* `npm run test:units`, which imports them with no jsdom and no
Leaflet at all. If a Leaflet import creeps in, that suite stops running.

### S2. `index.ts` is the only file that may touch `L.`

It is the Leaflet adapter. Keep it thin where you can.

### S3. Every fetch goes through `dataBase`

No hardcoded `/map/…` anywhere but the default value of the option itself.
Header links (`tileIndex`, `details[].url`) are **absolute paths baked in by
the Python writers** and must be passed through `fromData()`.

**Why:** a deployment reading from another origin otherwise fetches half its
data from its own, and the failure is silent — the layer simply stays coarse.

**One deliberate exception: a URL the reader pastes.** `fetchVector` fetches
what the reader asked for, and routing that through `dataBase` would mean they
could only load from the host the map already reads. The rule is about *the
map's own data*, which is what the check measures — it looks for `/map/`
literals, and a reader's URL contains none.

*Enforced by* the `every data fetch goes through the configured dataBase` check
in `test:map`, which reads the module source with comments stripped.

### S4. The published file shapes are `schema.ts`

Changing what a pipeline writes means changing `schema.ts` and
`scripts/test-schema.mjs` **first**.

**Why:** the two worst data bugs here were drift across this gap and neither
raised an error — ERDDAP's empty field where THREDDS writes `NaN`, and a time
index that went out of range so a two-day-old model run was served while the
build reported success.

*Enforced by* `npm run test:schema`, run twice in CI: inside `verify` against
the committed snapshot, and again after the refresh steps, which is the only
place fresh upstream drift can be caught.

### S5. Colours live in `data/map-palette.json`

Never inline one. A hardcoded colour is invisible to the contrast gate.

Reference linework — contours, borders, graticule, the measuring halo — is the
exception and lives in CSS variables instead, because its legibility comes from
a casing rather than from hue. If you add some, define the variable in **all
three** theme blocks; adding it to only the dark ones leaves light mode
stroking with no colour.

**A colour that cannot clear the bar is named in `concessions`, not waved
through.** Each entry records the pair, its measured ΔE and the reason, and the
gate checks the list **both ways**: an unlisted clash fails, and a concession
for a pair that actually clears fails with "remove it". That second half is
what stops the list becoming a place to hide things — without it a clash that
got fixed would stay listed forever and the record would stop being read.

**The particle ramps are the one exception, and they are still not inlined.**
They are *chosen* at runtime by `contrast.ts`, against whatever the particles
are actually drawn over — see the section in `CLAUDE.md`. What that changes is
when the decision is made, not whether it is checked: every answer is held to
`bars` from the palette, and `test:contrast` runs the same search over all 27
backgrounds the map can present. The rule for a port is the same either way —
**call `admissible()`, never re-derive it**. A second copy of the bar is how a
check ends up proving something the map does not do.

*Enforced by* `npm run test:contrast`, which shares `admissible()` with the
module, and the stroke measurement in `test:map`.

### S6. CSS keys off the `ocean-map` class, never an id

An id matches at most one map per page. Shared class names carry an `om-`
prefix: the stylesheet is plain CSS with none of Astro's automatic scoping, so
an unprefixed `.legend` leaks into whatever page imports it.

### S7. Styling and behaviour live here, never in a host page

A page places the map; it does not restyle it. A rule written into one page
applies to that page's map and no other, so two instances drift and the one
anybody notices is whichever they opened. Everything about how the map looks
is in `ocean-map.css`; everything about how it acts is in `index.ts`. What a
host may vary is the `layers` preset and `home` — which is the entire
difference between this site's two map pages.

*Enforced by* the stray-style scan in `npm run test:map`, which fails on a
`--map-*` declaration or an `.ocean-map` / `data-basemap-tone` / `map-*`
selector anywhere under the host's `src/`.

### S8. Nothing is document-scoped

Every lookup is relative to the container's `[data-ocean-map]` root. No
singletons, no `getElementById`, no shared storage key.

*Enforced by* `npm run test:multimap`, which mounts two maps and checks they
keep their own homes, storage keys and controls.

---

## Functional

### F1. The map must work with `dataBase` on another origin

That is the whole point of the option. See S3.

### F2. Two maps must coexist on one page

See S8. This is not hypothetical — the storm status line is claimed by the
first map to ask for it, precisely because both claiming it had them wiring the
same zoom buttons and fighting over where a click sent the view.

### F3. A host supplies a container, not a configuration

Options come from `OceanMapOptions` or `data-map-*` attributes. The map must
not require the host to define a design token, a utility class, or a global.

### F4. Measured decisions stay measured, and stay written down

The constants in this codebase are not preferences. The 12-day Argo window,
the three-dry-neighbour coastal erosion, the per-depth isobath speckle filters,
the 0.004° contour tolerance, the tier zoom thresholds, the two particle drift
rates 27× apart, the 16,000-particle ceiling — each has a number and a reason
recorded beside it, usually because the obvious choice was tried and measured
as wrong.

Three of them were got wrong *this way*: by searching under a stricter rule
than the gate actually applies, which does not produce a safer answer but no
answer at all, with a confident wrong reason attached. If a search comes back
empty, check what it was scoring against before concluding the space is.

**Do not change one without re-measuring**, and when you do, update the
reasoning rather than just the value. `check:docs` reads several of these
straight out of the source and fails when the prose disagrees.

---

## The quick version

Before adding anything, ask:

1. Does this need Leaflet? If not, it belongs in `geo`/`ramp`/`tiles`/`schema`.
2. Does it fetch? Then it goes through `dataBase`.
3. Does it publish or read a new file shape? Then `schema.ts` first.
4. Does it add a colour? Then the palette, or a themed CSS variable in all
   three blocks.
5. Does it query the document, or assume one map? Then it is wrong.
5a. Does it style or change behaviour? Then it goes here, not in a host page,
    so every instance of the map gets it.
6. Does it change a measured constant? Then re-measure and rewrite the reason.

`npm run verify` is the gate — a build, a type-check, a docs check and eleven
test suites, 1,301 assertions. CI runs exactly it, and the deploy will not run
unless it passes.
