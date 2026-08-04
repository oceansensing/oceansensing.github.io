# Porting to iOS

A hand-off for a session working only on a native iOS app. You do not need the
website, and you should not change it.

## What you are porting

An interactive map of ocean observing platforms and the water and weather they
work in: storm tracks and forecast cones, gliders, saildrones, ~4,000 Argo
floats, animated currents at two depths, animated 10 m wind, sea-surface
temperature and salinity, isobaths from 20 m to 10,000 m, a coastline and EEZ
boundaries — plus distance and bearing measurement and a point readout of
depth, current, wind, temperature and jurisdiction.

Live: <https://oceansensing.org/observations/hurricanes/>

## The one thing to understand first

**Most of this is not about drawing.** The web version is ~3,600 lines of
Leaflet adapter sitting on top of six data pipelines, a schema, a colour
system, and about forty measured decisions. You reimplement the drawing. You
**reuse** everything else, and reusing it is the difference between a month
and a week.

Read `BOUNDARIES.md` before anything else — the separations it describes are
what make this port possible, and the same rules apply to whatever you add.

## What you can take verbatim

| file | what it gives you | notes |
| --- | --- | --- |
| `schema.ts` | the shape of every published file | mirror as Swift `Codable` |
| `geo.ts` | great-circle bearing, degrees-and-decimal-minutes, spans, timestamps, hours-ahead | pure functions |
| `ramp.ts` | colour-ramp interpolation | pure |
| `tiles.ts` | which tiles a view needs | pure; floored modulo, mind the antimeridian |
| `warp.ts` | the homography behind `gx:LatLonQuad` image overlays | pure; falls back to affine when the quad is a parallelogram |
| `kmz.ts` | KMZ/KML decode — ZIP, geometry, styles, ground overlays | pure; **inject** an XML parser, do not import one |
| `data/map-palette.json` | every colour, 25 colour scales, and every conceded clash | with the reasoning in `_`-prefixed keys |
| `data/basemap-ocean.json` | sampled water colours the palette is gated against | |
| `../../scripts/*.py` | the six data pipelines | run unchanged, or read the same output |

`scripts/test-units.mjs` is the specification for all of those — **106
assertions**, each pinning a case a comment claims to handle. Port the tests
and you will know your Swift matches.

Two conventions in there are worth reading twice, because getting either
backwards produces a plausible wrong answer rather than an error:

- **A current is named for where it goes; a wind for where it comes from.** A
  southwesterly blows towards the northeast. The readout flips the bearing by
  180° for wind and not for current.
- **Particle drift is per field.** The median 10 m wind is ~27× the median
  surface current, so one speed constant makes one of them invisible and the
  other a streak. The web version keeps a `DRIFT` per field and a ceiling on
  the particle count, since the count scales with the map's area.

## The data

The app reads exactly the same JSON the website does. Point at
`https://oceansensing.org/map/` and everything is there — no pipeline needed
unless you want your own region or cadence.

`schema.ts` is authoritative for every shape, and
`../../scripts/test-schema.mjs` shows what a validator checks. Three details
are contract rather than accident:

- Storm `intensityKt` and `pressureMb` are **strings**. The NHC publishes them
  with qualifiers and a blank is a real answer; decoding them as numbers turns
  "no report" into zero.
- Timestamps carry a trailing `Z`. Without it they parse as local time and a
  track lands in the wrong place — with no error.
- `null` in a grid means land or no data, **never** `0`, which is a legitimate
  value.

Grids are row-major from the north-west corner: `index = row * nx + column`,
row 0 at `la1`, column 0 at `lo1`. Longitude wraps; latitude does not. A global
grid spans a full 360°.

Header links (`tileIndex`, `details[].url`) are absolute `/map/…` paths written
by the Python. Resolve them against your base URL — the web version's
`fromData()` exists for exactly this, and it was a live bug until the schema
work forced the question.

## The tiering, which you will want

Every field is served coarse-to-fine and the map picks the finest that fits.
Get this right early; it is most of the perceived quality.

| product | global | region | tiles |
| --- | --- | --- | --- |
| currents (per depth) | 0.96° | 0.24° / 0.48°×0.12° at z≥5 | 0.08° at z≥7 |
| Navy SST / salinity | 0.96° | 0.16° fallback | 0.08° at z≥4 |
| OISST | 1° | 0.25° native at z≥4 | none, by design |
| isobaths | deep only, 0.04° | — | all levels, 0.004° at z≥6 |

Regions are chosen by **containment** (a partly covered view would have data on
one side only); tiles by **overlap**, joined. That difference is measured, not
stylistic: containment for tiles kept dropping the tier while panning.

## Decisions worth inheriting rather than rediscovering

Each of these was measured, and most had an obvious answer that turned out
wrong. Full reasoning is in `../../CLAUDE.md`.

- **Argo needs a 12-day window, not the fleet's 5.** A float cycle is ten days.
  Measured against Ifremer: 1,992 floats in 5 days against 4,027 in 12, with
  nothing on screen to say half were missing.
- **Coastal erosion at three dry neighbours.** One wipes out the Gulf Stream
  and the Kuroshio; two loses the Kuroshio's inshore core; three keeps both and
  cuts land-carrying flow from 7.8% to 2.1%.
- **Isobath speckle filtering is per depth.** 4,000 m is the abyssal mean, so
  that contour shatters — 32,644 lines of median 0.12° across, unfiltered.
  Small rings mean islands at 200–1,000 m and noise below 2,000 m.
- **A contour's smoothness is bound by sampling, not tolerance**, past a point.
  Tightening tolerance alone bottomed out at 6.9 px vertex spacing; sampling at
  0.008° reached 2.0 px.
- **Colour scales:** only five of the 25 keep markers visible at ΔE 22. The
  defaults (`jet`, `cmo.haline`) deliberately are not among them — familiarity
  was chosen over separation, and the markers carry dark outlines instead.
- **Field colour ramps must avoid the warm half of the wheel**, because the
  warm end of an SST ramp is the tropics, which is where the storms are.

## What does not port

Leaflet, `leaflet-velocity`, the DOM chrome, the CSS, and the particle
animation — that last one is a canvas advection loop whose scaling had to
cancel two of the plugin's own factors and measure the projection's Jacobian
with an unrounded API. On iOS you would do it with Metal or `CAEmitterLayer`
and none of that arithmetic transfers.

The **basemaps** are worth planning early: the web version uses GEBCO's WMS by
default. MapKit will not show you that, so either keep a raster tile layer or
accept a different bathymetry — and note the contrast gate assumes GEBCO's
water tones, so a different basemap means re-running
`../../scripts/sample-basemaps.py` and re-checking the palette.

## Suggested order

1. Decode the data. Mirror `schema.ts`, fetch from `oceansensing.org/map/`,
   validate against `test-schema.mjs`'s rules.
2. Port `geo`, `ramp` and `tiles`, with `test-units.mjs` as the spec.
3. Draw the static layers — platforms, tracks, isobaths, coastline.
4. Add the tiering. This is where the map stops looking like a demo.
5. Scalar fields as a raster, with two-step bilinear sampling: nearest cell
   decides water-or-land, then average over whichever neighbours are water.
   Refusing to interpolate beside land was the first attempt and left the whole
   continental shelf a grid of squares.
6. Particles last. They are the most work and the least information.
