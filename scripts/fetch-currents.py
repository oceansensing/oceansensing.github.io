#!/usr/bin/env python3
"""Build surface-current vector fields for the animated map layer.

Run by .github/workflows/deploy.yml alongside fetch-ocean-assets.py. Writes
public/map/currents.json and currents-detail.json in the format
leaflet-velocity expects: two objects, eastward then northward, each a header
describing a regular grid plus a flat row-major array of values.

Two grids, because one cannot be both global and sharp at a sane size. The
global grid loads with the page and is deliberately coarse — 0.96 degrees is
all anyone can resolve zoomed out, and finer would cost megabytes. The detail
grid is four times finer over the Atlantic and Gulf, where the lab's own work
is, and the map fetches it only once the reader zooms in far enough to see
the difference. Being lazy is what lets it be that fine.

The map is not told the detail region twice: it reads it from the global
file's header.

Source
  US Navy ESPC-D-V02 global ocean forecast (the operational successor to
  HYCOM GOFS), 1/12 degree, via HYCOM's THREDDS OPeNDAP server. Chosen
  because it is open — no account, no token. Copernicus publishes Mercator
  at the same resolution but its numeric access needs credentials, so the
  static Mercator raster on the map and this animated field come from
  different models; both are labelled.

Only the standard library is used, so the workflow needs no dependencies.
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

MAP_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'

BASE = ('https://tds.hycom.org/thredds/dodsC/'
        'FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd')

# The model's own grid: longitude 0-360 at 0.08 deg, latitude -80..90 at 0.04.
LON0, DLON, NLON = 0.0, 0.08, 4500
LAT0, DLAT, NLAT = -80.0, 0.04, 4251

# The northern edge every grid must reach; see the long note on MAX_LAT in
# fetch-ocean-fields.py. Both pipelines had the same defect and it showed as
# one banding against the other.
MAX_LAT = 85.0


GLOBAL = {
    'name': 'currents.json',
    # Longitude wraps the whole way round, which leaflet-velocity handles
    # natively — given a grid spanning 360 deg it duplicates the first column
    # onto the end so particles cross the antimeridian instead of piling up
    # against it. Latitude stops at 85, past which Web Mercator cannot draw.
    'wrap': True,
    'south': -80.0, 'north': MAX_LAT,
    'stride': (12, 24),
}

# Finer grids over the places worth resolving. Each is fetched only when the
# reader zooms inside it, so adding one costs nothing to anybody else — the
# list is the knob for coverage.
#
# Resolution is set per region because a degree is not a fixed distance. At
# 35N a 0.24 deg cell is about 22 km across; at 75N it is 7 km wide but still
# 27 km tall, and latitude becomes the binding constraint. The Nordic grid
# therefore halves the latitude step again, which is what makes a fjord
# coastline representable at all.
DETAILS = [
    {
        'name': 'currents-atlantic.json',
        'label': 'Atlantic & Gulf',
        'wrap': False,
        'west': -100.0, 'east': -10.0, 'south': 5.0, 'north': 55.0,
        'stride': (3, 6),          # 0.24 x 0.24 deg
        'minZoom': 5,
    },
    {
        # A band rather than a box. Adding one region per complaint does not
        # converge — Greenland was fixed and the Bering Strait, a third of
        # the way round the world, was not. Every Arctic coast has the same
        # problem, so cover them all at once.
        'name': 'currents-arctic.json',
        'label': 'Arctic & subpolar',
        'wrap': True,              # all longitudes, so it closes on itself
        # Reaches down to 50N so it overlaps the Atlantic region rather than
        # leaving a gap above it. The map needs the whole viewport inside a
        # region to use it, so a band starting at 60 dropped any view
        # straddling that line — including most of the Norwegian coast —
        # back onto the coarse grid.
        'south': 50.0, 'north': MAX_LAT,
        # Longitude is cheap up here and latitude is what binds: at 66N a
        # 0.48 deg cell is 22 km wide, while 0.12 deg of latitude is 13 km.
        # Spending the samples on latitude is what resolves a coastline.
        'stride': (6, 3),          # 0.48 x 0.12 deg
        'minZoom': 5,
    },
]

# Full model resolution, tiled, for close-in views. 20 degrees square is
# chosen so any viewport at zoom 6 or beyond fits inside one tile — the map
# uses a tile only when it wholly contains the view, and stitching several
# would be a lot more code for no visible gain. Measured at 173 KB gzipped
# for an open-ocean tile, so a reader downloads less than today's regional
# grid and gets 9 x 4.4 km instead of 27 km.
TILES = {
    'dir': 'tiles',
    'size': 20.0,
    'west': -180.0,
    'south': -80.0,
    'north': MAX_LAT,
    # 7 was too high, and an enclosed sea is where it showed. Reported from
    # the Black Sea at a 200 km scale bar — about zoom 5.8 — where the flow
    # was patchy with straight edges, and full only once zoomed to 50 km.
    #
    # Nothing was wrong with the particles. Below this threshold the map
    # falls back to the coarse grids, and the Black Sea is in no region, so
    # it was drawn from the **global 0.96 degree** field: roughly 6 x 15
    # cells for the whole sea, most of them removed by the coastal erosion
    # that keeps flow off the land. A basin needs cells to have currents in.
    #
    # 5 rather than 6 because the reported view sits between them — zoom is
    # fractional here (zoomSnap is 0), so a threshold of 6 would still have
    # left that exact complaint unfixed.
    #
    # Measured cost, gzipped on the wire, sampling 14 tiles: 97 KB mean,
    # 138 KB worst. A phone at zoom 5 touches 1-4 tiles (~100-390 KB); a
    # desktop viewport at worst about 12 (~1.2 MB), on demand, and only for
    # a reader who has the layer on. That is well inside what this map
    # already fetches on request — the deep isobaths are 3.0 MB and the
    # offline coastline 4.2 MB.
    #
    # Below 5 it runs away: zoom 4 is ~92 degrees across, so 12-21 tiles,
    # and a 0.08 degree cell is under two pixels there anyway. Same shape of
    # argument as the fields' floor of 4, at the resolution a vector tile
    # costs rather than a scalar one.
    'minZoom': 5,
    # 0.08 x 0.08 — true 1/12 degree, and isotropic. The model carries 0.04
    # in latitude, but taking it doubles the deployed site to 205 MB for a
    # refinement from 9 km to 4.4 km in one axis only. Change to (1, 1) here
    # if that is ever worth it.
    'stride': (1, 2),
    # Politeness: two requests per tile to a public research server, a few
    # tiles at a time.
    'workers': 4,
}

# Depths published. ESPC-D carries forty standard levels; these are the two
# the map offers. 60 m is chosen to sit below the wind-driven surface layer —
# where the flow is the ocean's own rather than this morning's weather — and
# close to where a glider spends most of a dive. Every product below is built
# once per entry, so this list is the only knob: adding 200 m here builds a
# 200 m global grid, regions and tiles with no other change.
#
# 'index' is checked against the model's depth axis at run time rather than
# trusted. A silent shift in the axis would publish the wrong water at the
# right filename, which nothing downstream could detect.
LEVELS = [
    {'metres': 0, 'index': 0, 'suffix': '', 'label': 'Surface'},
    {'metres': 60, 'index': 15, 'suffix': '-60m', 'label': '60 m'},
]

UA = {'User-Agent': 'oceansensing.org current map (github.com/oceansensing)'}


# Which steps to publish, chosen by **valid time** rather than by a fixed
# offset from the model run.
#
# This was T+36 for a while, and the reason it stopped working is the ingest
# delay. A lead is anchored to the run, so where it lands relative to the
# reader's clock is the run's lateness and nothing else. ESPC is documented
# as landing 24-33 hours after its 12Z run, which is what made T+36 fall a
# few hours ahead of now; measured on 2026-08-05 19Z the newest run was **55
# hours old**, so the same T+36 was valid 08-05 00Z — 19 hours *behind* the
# reader — while that very run carried a step valid 08-05 18Z. The run holds
# 65 steps out to T+192, so a step near the present is essentially always
# there. The lead was simply not pointing at it.
#
# So the question asked of the aggregation is now "which step is nearest
# now", and the lead becomes an output rather than an input. What that costs
# is a stable filename: a non-base frame is named for its lead, so it takes
# a different suffix as soon as a newer run lands. Nothing downstream minds,
# because every URL the map follows is advertised in the data — but it is
# why the tile cache key has to name the steps and not just the run.
#
# **REFRESH_HOURS is what keeps that from moving every three hours.** The
# model's steps are 3-hourly, so left alone the answer would change eight
# times a day and each change rebuilds a tile set. Snapping the question to
# a six-hour boundary makes the answer stable within the window, so the
# hourly build restores its tiles from cache five times in six.
#
# It cannot go the other way — a *slower* refresh than the model's own steps
# aliases the tide. See the tide note in CLAUDE.md: ESPC carries a
# semidiurnal signal, measured at 8 sign reversals in 48 hours against M2's
# 7.7, so sampling at 6 hours is 2.07 points per cycle and consecutive
# updates land half a cycle apart. Two frames per window is what covers the
# 3-hourly grid at that cadence.
#
# **fetch-ocean-fields.py must carry the same number.** The currents and the
# Navy fields come off one model, and the map credits a source once per run
# and valid time, so two anchors would split one product into two
# attribution lines and put one hour of temperature under another hour of
# current. `check:docs` compares the two constants; `test:schema` compares
# the published headers.
REFRESH_HOURS = 6

# How far a chosen frame may sit from the hour it was asked for.
#
# **This exists because "the nearest step in this run" is not the same claim
# as "a step about now", and the difference is a day and a half.** When the
# newest run's probe failed, `pick_nearest` walked back to the previous run —
# and a "best" aggregation gives the newer run precedence for every hour it
# covers, so the older one owns only the hours *before* the newer run starts.
# Its nearest step to the anchor was therefore its own last hour, 43 hours in
# the past, and it was published: internally consistent, same run throughout,
# grid matching its tiles, and useless. Nothing in the contract objected,
# because the contract checks consistency and had nothing to say about
# currency.
#
# Six hours because the steps are 3-hourly and the window is six: a genuine
# nearest-step answer lands within 1.5 h of its target, and the second frame
# falls back to the first when a run stops short, which is 3 h. Anything
# beyond that is a different day rather than a near miss.
#
# A run with nothing near the anchor is skipped, and when no run has one the
# caller keeps the previous file — stale, and saying so, rather than stale
# and claiming to be current.
MAX_FROM_ANCHOR = 6.0

# How many consecutive steps to publish, starting at the one nearest the
# anchor. Two, so the pair spans the refresh window: a reader is a mean 1.1
# hours from the nearer of them and at worst 3, against the 19 the fixed
# lead had drifted to.
#
# It is also what puts the forecast-hour control back on the map, which is
# the substantive half. A field with tidal structure sampled once is one
# arbitrary phase of it; with two frames the reader can step the phase.
#
# Three frames would bracket the window properly — worst case 1.5 hours
# rather than 3 — and costs a third tile set: 552 MB of currents against
# 368, taking the published tree to about 868 MB of the 1 GB Pages cap.
# That is too close to spend on halving an error the valid time already
# states on screen.
FRAMES = 2

# Fixed leads instead, as **T+N from the model run** — the old behaviour,
# and still what `--leads=0,12,24,36,48` selects. `None` means choose by
# valid time. Kept rather than deleted: a deployment with more room than a
# 1 GB Pages site may well want the whole eight days, and the difference
# between the two selections is one function.
LEADS: list[int] | None = None


def at_depth(name: str, suffix: str) -> str:
    """currents-atlantic.json -> currents-atlantic-60m.json"""
    return name[:-len('.json')] + suffix + '.json' if suffix else name


def at_lead(name: str, lead: int) -> str:
    """currents-60m.json -> currents-60m-f12h.json, except for the base lead.

    `currents.json` is the file every existing reader already fetches, so
    something must always be published under it: a deployment pinned to an
    older build of the map asks for the bare name and has to keep getting a
    field. The **lowest** lead being built takes it — which was lead 0 while
    the map was a nowcast and is T+36 now, and is still 0 whenever 0 is one
    of the leads asked for.
    """
    return name[:-len('.json')] + f'-f{lead}h' + '.json' if lead != base_lead() else name


def base_lead() -> int:
    """The lead published under the bare filenames. See `at_lead`.

    Read off the frames actually selected rather than off `LEADS`, because
    the leads are an *output* now — which step is nearest the anchor
    depends on how late the run is. Reading it from the constant would
    suffix every file with its lead and publish nothing at `currents.json`,
    which is the one name every existing reader asks for.
    """
    return min(lead for lead, *_ in frames())


def check_depths() -> None:
    """Confirm each level's index really is the depth it claims."""
    body = get(f'{BASE}.ascii?depth', timeout=60)
    tail = [line for line in body.splitlines() if line.strip()][-1]
    axis = [float(t) for t in tail.split(',') if t.strip()]
    for level in LEVELS:
        i = level['index']
        if i >= len(axis) or axis[i] != level['metres']:
            got = axis[i] if i < len(axis) else 'past the end of the axis'
            raise RuntimeError(
                f'depth index {i} is {got}, not {level["metres"]} m — '
                'the model axis moved; fix LEVELS'
            )


def get(url: str, timeout: int = 180) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def rows(body: str) -> list[list[float | None]]:
    """Pull the numbers out of a DODS ASCII response.

    Every data line starts with its index tuple — "[0][0][3], 0.1, 0.2, ..."
    — so the tuple is dropped and the rest parsed. Land is NaN, which becomes
    None: leaflet-velocity treats null as "no vector here" and draws nothing.
    """
    out = []
    for line in body.splitlines():
        if not line.startswith('['):
            continue
        _, _, values = line.partition(',')
        row: list[float | None] = []
        for token in values.split(','):
            token = token.strip()
            if not token:
                continue
            try:
                v = float(token)
            except ValueError:
                row.append(None)
                continue
            # Two decimals: a centimetre per second is far finer than
            # anything the particles express, and shorter numbers compress
            # better over the wire.
            row.append(None if math.isnan(v) else round(v, 2))
        if row:
            out.append(row)
    return out


# How many of a cell's eight neighbours must be dry before it is dropped.
# Measured, not guessed. Requiring only one wipes out the Gulf Stream and the
# Kuroshio, which hug their coasts; requiring two still loses the Kuroshio's
# strongest inshore stretch. Three keeps both and still cuts the share of land
# carrying flow from 7.8% to 2.1%.
COASTAL_DRY_NEIGHBOURS = 3


def erode_land(u: list[list[float | None]], v: list[list[float | None]], wrap: bool) -> int:
    """Null wet cells wedged into the coastline, and report what is left.

    leaflet-velocity does not treat a null as missing. Its grid hands back
    [u, v] — an array, so always truthy — and its bilinear interpolation
    multiplies straight through, where null becomes zero. A cell that is
    partly land therefore yields a reduced but non-zero velocity that is
    defined over the land, and particles get advected onto it and keep
    going. That is why they streamed across Greenland.

    Subsampling makes it worse: taking every twelfth model node throws away
    the model's own 1/12 degree mask, so at high latitude a single sample
    decides a cell tens of kilometres across.

    Dropping cells that sit in a nook of the coastline — fjords, straits,
    channels — leaves points over land surrounded by nulls, which interpolate
    to zero, so particles stop instead of streaking inland. Cells that merely
    graze a straight coast are kept, because that is where the western
    boundary currents live.

    It is a mitigation, not a cure. A grid this coarse cannot represent a
    fjord coastline, and an island smaller than a cell — Bjornoya, say — sits
    in open model water whatever we do here. The real fix at high latitude is
    a finer grid covering it.
    """
    ny, nx = len(u), len(u[0])
    wet = [[u[j][i] is not None and v[j][i] is not None for i in range(nx)] for j in range(ny)]

    drop = []
    for j in range(ny):
        for i in range(nx):
            if not wet[j][i]:
                continue
            dry = 0
            for dj in (-1, 0, 1):
                jj = j + dj
                if not 0 <= jj < ny:
                    continue
                for di in (-1, 0, 1):
                    if dj == 0 and di == 0:
                        continue
                    ii = i + di
                    if wrap:
                        ii %= nx
                    elif not 0 <= ii < nx:
                        continue
                    if not wet[jj][ii]:
                        dry += 1
            if dry >= COASTAL_DRY_NEIGHBOURS:
                drop.append((j, i))

    for j, i in drop:
        u[j][i] = None
        v[j][i] = None
    return sum(1 for row in u for value in row if value is not None)


def axis_index(value: float, origin: float, step: float, count: int) -> int:
    return max(0, min(count - 1, round((value - origin) / step)))


def time_axis(base: str) -> int:
    """How many steps the aggregation currently has.

    Asked rather than assumed. Both pipelines used to request time[0:1:128],
    which worked until the FMRC aggregation got shorter — on 2026-08-02 it
    was 121 steps, so index 128 was out of range and every fetch failed with
    a 400. The fallback then kept the previous file, so the map went two days
    stale while reporting success: the only visible symptom was the run date
    in the attribution, which is how it was caught.
    """
    dds = get(f'{base}.dds', timeout=60)
    found = re.search(r'time\[time = (\d+)\]', dds)
    if not found:
        raise RuntimeError('cannot read the time axis length')
    return int(found.group(1))


def pick_time() -> tuple[int, str, str]:
    """The base frame: its step index, valid time and model run.

    Reads `frames()` rather than answering separately, and that is the
    point — CI keys its tile cache on what this reports and the tiles are
    built from the frames, so two independent answers could serve one
    selection's tiles under another's key.
    """
    base = base_lead()
    _, index, valid, run = next(f for f in frames() if f[0] == base)
    return index, valid, run


def time_axes() -> tuple[datetime, list[float], list[float], float]:
    """The aggregation's epoch, valid times, run times, and now.

    Read once and handed to whichever selection is in force: both need all
    four, and asking twice costs two more OPeNDAP round trips for an answer
    that cannot have changed in between.
    """
    das = get(f'{BASE}.das', timeout=60)
    marker = 'hours since '
    at = das.find(marker, das.find('time {'))
    epoch = datetime.strptime(
        das[at + len(marker):at + len(marker) + 19], '%Y-%m-%d %H:%M:%S'
    ).replace(tzinfo=timezone.utc)

    def axis(name: str) -> list[float]:
        body = get(f'{BASE}.ascii?{name}[0:1:{time_axis(BASE) - 1}]', timeout=90)
        tail = [line for line in body.splitlines() if line.strip()][-1]
        return [float(t) for t in tail.split(',') if t.strip()]

    hours = axis('time')
    if not hours:
        raise RuntimeError('no time axis')
    runs = axis('time_run')
    now = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600
    return epoch, hours, runs, now


def stamp(epoch: datetime, h: float) -> str:
    return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')


def serves(index: int) -> bool:
    """Whether this step answers a read at all.

    **HYCOM fails per member file, not outright**, so a step is a thing to
    test rather than assume. Probed with a deliberately tiny slab rather
    than the real fetch: a broken step fails on any read, so 3x3 cells at
    the middle of the grid settle it in about a second against a minute for
    the global grid.

    **It retries, and the reasoning it used not to was wrong.** This asked
    once, on the argument that "a dead step should be rejected quickly, and
    the retry inside `component` is for transient faults, which is a
    different question from whether this step exists". The probe cannot
    tell those apart — that is the whole difficulty — so with one attempt
    it read every transient 500 as a dead step.

    Measured 2026-08-08, three identical runs minutes apart: step 77 failed
    and 76 answered; then 76 failed; then both answered. **The same step
    gave opposite answers within minutes.** The cost of believing the first
    reading is not a slower run — it is `pick_nearest` walking back to an
    older run, which in a "best" aggregation holds no hours near the
    present, and publishing a field **43 hours stale** in place of one four
    hours old.

    Three spaced tries rather than the full `BACKOFF`: a genuinely dead step
    should still be rejected in seconds, and this runs once per candidate
    frame rather than per tile.

    Surface only. The levels share a time axis, so a step that serves 0 m
    serves 60 m; probing each depth would multiply the cost of answering
    the same question.
    """
    y = NLAT // 2
    x = NLON // 2
    try:
        component('water_u', index, LEVELS[0]['index'],
                  y, y + 4, x, x + 4, 2, 2, backoff=PROBE_BACKOFF)
        return True
    except (urllib.error.URLError, TimeoutError, RuntimeError,
            ValueError, OSError) as exc:
        print(f'  step {index} unusable — {exc}', file=sys.stderr)
        return False


def anchor_hour(now: float) -> float:
    """`now`, snapped back to a REFRESH_HOURS boundary.

    Snapped rather than used raw so the answer is stable for the whole
    window: the selection feeds the tile cache key, and an answer that
    moves with the clock would rebuild a tile set on every hourly run.

    Floor rather than round, so the anchor is never ahead of the reader —
    the same call the tide note makes, preferring the stale field to the
    aliased one. Which frame they are shown is then the map's business: it
    opens on whichever published valid time is nearest their own clock.
    """
    return math.floor(now / REFRESH_HOURS) * REFRESH_HOURS


def step_offsets(count: int) -> list[float]:
    """Hours past the anchor to publish, spread evenly across the window.

    **In hours, not in step indices**, and that distinction is a bug this
    project already shipped. "The next `count` consecutive steps" assumes
    every ESPC aggregation is spaced the same, and they are not: `uv3z` and
    `ts3z` carry 3-hourly steps while the ice aggregation carries hourly
    ones off the same run. Counting steps there put the ice an hour past
    the anchor while the currents were three — an hour no other layer could
    be stepped to, and a credit line nothing could be brought into
    agreement with. `test-schema.mjs` caught it; the fix is to ask for a
    time rather than for a position in a list.

    Shared, in the sense that fetch-ocean-fields.py computes the same
    ladder and takes the last of it. `check:docs` holds the two widths
    together.
    """
    return [k * REFRESH_HOURS / count for k in range(count)]


def pick_nearest(offsets: list[float]) -> list[tuple[int, int, str, str]]:
    """The steps nearest `anchor + each offset`, all from one run.

    **The run is chosen first and the steps come out of it**, which is the
    whole shape of this. Picking each step independently by valid time
    could straddle two runs — the same hour exists in every run that
    reaches it — and a reader stepping between those two frames would cross
    from one model state into another and see a discontinuity that is not
    the ocean.

    The newest run wins, and a run that cannot serve its own step is walked
    past.

    **What that degrades was stated wrongly here, and the wrong version was
    the one the code followed.** It said the valid time is unchanged because
    "the step grid is absolute and an older run carries the same hours".
    That is true of the model and false of this aggregation: `best` gives the
    newest run precedence for every hour it covers, so an older run owns only
    the hours before the newer one begins — a fact recorded elsewhere in
    CLAUDE.md and contradicted here. Walking back a run does not buy the
    present; it loses it. Measured 2026-08-08: the fallback published a field
    43 hours old in place of one four hours old.

    So a candidate frame is now held to `MAX_FROM_ANCHOR` as well as to the
    probe, and a run with nothing near the anchor is skipped rather than
    mined for its least-bad step.

    Two offsets landing on one step publish one frame rather than the same
    hour twice, which is the honest answer for a model whose steps are
    coarser than the window it is being asked to cover.
    """
    epoch, hours, runs, now = time_axes()
    anchor = anchor_hour(now)
    n = min(len(hours), len(runs))
    if not n:
        raise RuntimeError('no time axis')

    for run in sorted({runs[i] for i in range(n)}, reverse=True):
        own = sorted((i for i in range(n) if abs(runs[i] - run) < 0.5),
                     key=lambda i: hours[i])
        if not own:
            continue
        chosen: list[int] = []
        for offset in offsets:
            i = min(own, key=lambda k: abs(hours[k] - (anchor + offset)))
            drift = abs(hours[i] - (anchor + offset))
            if drift > MAX_FROM_ANCHOR:
                print(f'  ! {stamp(epoch, run)} run: nearest step to '
                      f'{stamp(epoch, anchor + offset)} is '
                      f'{stamp(epoch, hours[i])}, {drift:.0f} h away — '
                      f'that is a different day, not a near miss',
                      file=sys.stderr)
                continue
            if i not in chosen:
                chosen.append(i)
        if not chosen:
            continue
        # Probed in order, and a broken tail is kept rather than rejecting
        # the run: one frame publishes cleanly — the map builds its control
        # from what the data advertises, so a single frame simply offers no
        # control — where none at all costs the layer.
        usable = []
        for i in chosen:
            if not serves(i):
                break
            usable.append(i)
        if not usable:
            print(f'  ! {stamp(epoch, run)} run serves nothing at the anchor '
                  f'— trying an older run', file=sys.stderr)
            continue
        if len(usable) < len(chosen):
            print(f'  ! only {len(usable)} of {len(chosen)} frames usable from '
                  f'the {stamp(epoch, run)} run', file=sys.stderr)
        out = []
        for i in usable:
            lead = round(hours[i] - runs[i])
            # stderr, because `--run` and `--tile-key` go through this and CI
            # captures their stdout straight into a cache key — a progress
            # line on the same stream would become part of the key.
            print(f'  T+{lead}: valid {stamp(epoch, hours[i])} from the '
                  f'{stamp(epoch, runs[i])} run ({now - runs[i]:.0f} h old, '
                  f'{hours[i] - now:+.0f} h from now)', file=sys.stderr)
            out.append((lead, i, stamp(epoch, hours[i]), stamp(epoch, runs[i])))
        return out
    raise RuntimeError('no usable time step at the anchor in any run')


def pick_leads(leads: list[int]) -> list[tuple[int, int, str, str]]:
    """(lead, index, valid time, model run) for each lead, as **T+N from the
    model run** — the forecasting convention, not hours from the clock.

    The `--leads=` selection, and no longer the default: see the note on
    `LEADS`. A lead is anchored to the run, so where it falls relative to
    the reader is the run's lateness and nothing else — which is what
    eventually drifted T+36 to 19 hours behind the present.

    What it still gets right, and what `pick_nearest` had to reproduce: a
    lead means one thing and comes from one run, chosen as the newest that
    actually carries the step. Anchored to *now* instead, a longer lead
    reached into an *older* run — measured on 2026-08-03, lead 0 came from
    the 08-02 run while every longer lead fell back to 08-01, because the
    newest was only ingested out to T+36. Stepping forward in time stepped
    backward in run freshness.

    A lead no run carries is dropped with a note rather than clamped, since
    clamping would publish some other hour under the right filename and
    nothing downstream could tell.
    """
    epoch, hours, runs, now = time_axes()

    out = []
    for lead in leads:
        # Every step that is exactly this far past its own run, newest run
        # first. Exact rather than nearest: T+36 is a step the model either
        # published or did not, and rounding to a neighbour would quietly
        # relabel T+33 as T+36.
        matches = sorted(
            (i for i in range(min(len(hours), len(runs)))
             if abs((hours[i] - runs[i]) - lead) < 0.5),
            key=lambda i: runs[i], reverse=True,
        )
        if not matches:
            print(f'  ! no run carries T+{lead} — skipped', file=sys.stderr)
            continue
        index = next((i for i in matches if serves(i)), None)
        if index is None:
            print(f'  ! no usable step for T+{lead} in {len(matches)} '
                  f'candidate run(s) — skipped', file=sys.stderr)
            continue
        age = now - runs[index]
        print(f'  T+{lead}: valid {stamp(epoch, hours[index])} from the '
              f'{stamp(epoch, runs[index])} run ({age:.0f} h old)',
              file=sys.stderr)
        out.append((lead, index, stamp(epoch, hours[index]),
                    stamp(epoch, runs[index])))
    if not out:
        raise RuntimeError('no usable time step')
    return out


# How long to wait before believing a failed read, in seconds. The first
# attempt is immediate.
#
# **Spaced, not back-to-back**, and that is measured rather than chosen: the
# fields pipeline tried three immediate retries and still lost 24 of 162
# tiles, because a transient fault is still there a millisecond later. The
# waiting is the point.
BACKOFF = (0, 3, 8, 20)

# What `serves()` uses. Shorter than BACKOFF because it runs per candidate
# frame rather than per tile, and long enough that one transient 500 does not
# condemn a step — see the note there for what believing a single reading
# actually cost.
PROBE_BACKOFF = (0, 2, 5)


def component(name: str, t: int, z: int, y0: int, y1: int, x0: int, x1: int,
              stride_lat: int, stride_lon: int,
              backoff: tuple[int, ...] | None = None) -> list[list[float | None]]:
    """One slab of one velocity component, retried before it is believed.

    **HYCOM fails per request, not outright.** Measured on 2026-08-02, index
    70 returned a full global field while index 76 answered 500 "Stale file
    handle" for the identical request minutes apart, and a small read that
    had just succeeded failed on the next try. Metadata keeps working
    throughout, so the server looks healthy the whole time.

    The retry sits here rather than around each tile — where the fields
    pipeline puts it — because this is the one choke point every OPeNDAP
    read goes through, so the regional and global grids get the same
    protection as the tiles for free. A currents run makes about 318 tile
    fetches across two depths and had **no** retry at all, and one failure
    aborted the lot.

    Callers that are probing rather than fetching pass `backoff=(0,)`: a
    dead step should be rejected in a second, not in half a minute.
    """
    url = (f'{BASE}.ascii?{name}[{t}][{z}]'
           f'[{y0}:{stride_lat}:{y1}][{x0}:{stride_lon}:{x1}]')
    # Resolved here rather than as a default argument, which Python binds
    # once at definition and would make the constant unpatchable.
    backoff = BACKOFF if backoff is None else backoff
    last: Exception | None = None
    for wait in backoff:
        if wait:
            time.sleep(wait)
        try:
            grid = rows(get(url))
            if not grid:
                raise RuntimeError(f'{name}: no rows returned')
            return grid
        except (urllib.error.URLError, TimeoutError, RuntimeError,
                ValueError, OSError) as exc:
            last = exc
    raise RuntimeError(f'{name}[{t}][{z}] failed after {len(backoff)} tries: {last}')


def build(spec: dict, t: int, level: dict, valid: str, run: str,
          extra: dict | None = None, lead: int = 0) -> None:
    """Fetch one grid at one depth and lead, in leaflet-velocity's format."""
    stride_lon, stride_lat = spec['stride']
    out = MAP_DIR / at_lead(at_depth(spec['name'], level['suffix']), lead)

    y0 = axis_index(spec['south'], LAT0, DLAT, NLAT)
    y1 = axis_index(spec['north'], LAT0, DLAT, NLAT)

    # **Round the top outward to the stride.** See the same note in
    # fetch-ocean-fields.py: the fetch walks y0:stride:y1, so the last row
    # sampled is up to stride-1 cells below y1 — 0.92 deg on the global grid
    # — and each grid therefore stopped somewhere different. Measured before
    # the fix: currents 84.16, currents-arctic 84.92, the scalar fields 84.16
    # and 84.88, wind 90. Every one of those boundaries was a band where one
    # layer was drawn over another that had ended.
    span = y1 - y0
    if span % stride_lat:
        y1 = min(y0 + (span // stride_lat + 1) * stride_lat, NLAT - 1)

    if spec['wrap']:
        slabs = [(0, NLON - 1)]
    else:
        x0 = axis_index(spec['west'] % 360, LON0, DLON, NLON)
        x1 = axis_index(spec['east'] % 360, LON0, DLON, NLON)
        if x0 <= x1:
            slabs = [(x0, x1)]
        else:
            # A region straddling the prime meridian wraps in the model's
            # 0-360 longitudes, so it comes back as two slabs. The second
            # must resume the stride where the first left off, or the columns
            # either side of the meridian would be unevenly spaced and the
            # grid would no longer be regular.
            taken = (NLON - 1 - x0) // stride_lon + 1
            slabs = [(x0, NLON - 1), (x0 + taken * stride_lon - NLON, x1)]

    def fetch_component(name: str) -> list[list[float | None]]:
        parts = [
            component(name, t, level['index'], y0, y1, a, b, stride_lat, stride_lon)
            for a, b in slabs
        ]
        if len(parts) == 1:
            return parts[0]
        return [west + east for west, east in zip(*parts)]

    u = fetch_component('water_u')
    v = fetch_component('water_v')
    if len(u) != len(v) or len(u[0]) != len(v[0]):
        raise RuntimeError(f'{out.name}: u and v grids disagree in shape')

    before = sum(1 for row in u for value in row if value is not None)
    after = erode_land(u, v, spec['wrap'])

    ny, nx = len(u), len(u[0])
    dx, dy = DLON * stride_lon, DLAT * stride_lat
    # The model counts latitude northward; leaflet-velocity reads its rows
    # from the top down, so the grid is flipped and la1 is the north edge.
    la1 = LAT0 + (y0 + (ny - 1) * stride_lat) * DLAT
    # The model counts longitude from 0 east; leaflet-velocity wraps with a
    # floored modulo, so it reads -74 as 286 without help.
    lo1 = LON0 + slabs[0][0] * DLON

    def flatten(grid: list[list[float | None]]) -> list[float | None]:
        return [value for row in reversed(grid) for value in row]

    def header(number: int) -> dict:
        return {
            'parameterCategory': 2,       # momentum
            'parameterNumber': number,    # 2 = eastward, 3 = northward
            'parameterUnit': 'm.s-1',
            'nx': nx, 'ny': ny,
            'lo1': round(lo1, 4), 'la1': round(la1, 4),
            'dx': round(dx, 4), 'dy': round(dy, 4),
            'refTime': valid,
            # Which daily run produced this, so the page can say how fresh
            # the field is rather than leaving the reader to assume.
            'modelRun': run,
            # The depth this field is for. The map labels its layer from
            # this rather than from the filename it happened to fetch.
            'depth': level['metres'],
            # Hours ahead of the build. Read from the data rather than the
            # filename for the same reason depth is: the map says "valid
            # 2026-08-04 06Z, +24h" from the file it actually got, so a
            # mislabelled frame shows up as the wrong hour on screen instead
            # of as the right hour over the wrong water.
            'lead': lead,
            **(extra or {}),
        }

    payload = [
        {'header': header(2), 'data': flatten(u)},
        {'header': header(3), 'data': flatten(v)},
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')

    spans = nx * dx
    extent = 'wraps' if spans >= 360 else f'{spans:.0f} deg of longitude'
    print(f'  {out.name}: {nx}x{ny} at {dx:.2f}x{dy:.2f} deg, {extent}, '
          f'{after} wet points after coastal erosion (from {before}), '
          f'{out.stat().st_size / 1024:.0f} KB')


def build_tile(t: int, level: dict, valid: str, run: str,
               south: float, west: float, lead: int = 0) -> tuple[str | None, str]:
    """One full-resolution tile, as (key, outcome).

    Outcome is 'written', 'empty' or 'failed', and **the last two must never
    be conflated.** The fields pipeline conflated them and a run against a
    flaky server wrote 81 of 162 tiles while reporting "81 empty" as though
    that were the coastline — the map then falls back to the coarse grid
    over everything missing, with nothing on screen to say so.

    This pipeline could not produce that exact file, because a raised
    exception used to abort the whole run. But it aborted it for *any*
    failure, including a single transient one out of 318 reads, so a healthy
    model went unpublished over one bad tile. The retry in `component` fixes
    that half; naming the outcome is what stops the fix from turning a real
    failure into a silently short index.
    """
    north = min(south + TILES['size'], TILES['north'])
    east = west + TILES['size']

    y0 = axis_index(south, LAT0, DLAT, NLAT)
    y1 = axis_index(north, LAT0, DLAT, NLAT)
    stride_lon, stride_lat = TILES['stride']
    span = y1 - y0
    if span % stride_lat:                       # see the note in region_grid
        y1 = min(y0 + (span // stride_lat + 1) * stride_lat, NLAT - 1)
    x0 = axis_index(west % 360, LON0, DLON, NLON)
    x1 = axis_index(east % 360, LON0, DLON, NLON)
    if x0 <= x1:
        slabs = [(x0, x1)]
    else:
        taken = (NLON - 1 - x0) // TILES['stride'][0] + 1
        slabs = [(x0, NLON - 1), (x0 + taken * TILES['stride'][0] - NLON, x1)]

    def grab(name: str) -> list[list[float | None]]:
        parts = [
            component(name, t, level['index'], y0, y1, a, b, stride_lat, stride_lon)
            for a, b in slabs
        ]
        return parts[0] if len(parts) == 1 else [w + e for w, e in zip(*parts)]

    key = f'{south:g}_{west:g}'
    try:
        u = grab('water_u')
        v = grab('water_v')
    except (urllib.error.URLError, TimeoutError, RuntimeError,
            ValueError, OSError) as exc:
        # Reported here rather than raised, so one bad tile does not cost the
        # other 317. `build_tiles` fails the run on the count.
        print(f'  ! tile {key} failed: {exc}', file=sys.stderr)
        return None, 'failed'

    if len(u) != len(v) or len(u[0]) != len(v[0]):
        raise RuntimeError(f'tile {south}/{west}: u and v disagree in shape')

    if not erode_land(u, v, False):
        return None, 'empty'             # nothing but land; do not write a file

    ny, nx = len(u), len(u[0])
    la1 = LAT0 + (y0 + (ny - 1) * stride_lat) * DLAT
    lo1 = LON0 + slabs[0][0] * DLON

    def header(number: int) -> dict:
        return {
            'parameterCategory': 2, 'parameterNumber': number, 'parameterUnit': 'm.s-1',
            'nx': nx, 'ny': ny,
            'lo1': round(lo1, 4), 'la1': round(la1, 4),
            'dx': round(DLON * stride_lon, 4), 'dy': round(DLAT * stride_lat, 4),
            'refTime': valid, 'modelRun': run, 'depth': level['metres'],
        }

    payload = [
        {'header': header(2), 'data': [x for row in reversed(u) for x in row]},
        {'header': header(3), 'data': [x for row in reversed(v) for x in row]},
    ]
    key = f'{south:g}_{west:g}'
    out = MAP_DIR / tile_dir_name(level, lead) / f'{key}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    return key, 'written'


def tile_dir_name(level: dict, lead: int) -> str:
    """tiles, tiles-60m, tiles-f24h, tiles-60m-f24h.

    Each lead keeps its own directory rather than suffixing the tiles inside
    one, so the map follows a single `tileIndex` link per frame and cannot
    mix an hour's tiles with another's — the same reason each depth has its
    own directory.
    """
    return at_lead(TILES['dir'] + level['suffix'] + '.json', lead)[:-len('.json')]


def build_tiles(t: int, level: dict, valid: str, run: str, lead: int = 0) -> None:
    """Every tile covering ocean at one depth and lead, plus its index."""
    from concurrent.futures import ThreadPoolExecutor

    corners = [
        (south, west)
        for south in frange(TILES['south'], TILES['north'], TILES['size'])
        for west in frange(TILES['west'], 180.0, TILES['size'])
    ]
    dx, dy = DLON * TILES['stride'][0], DLAT * TILES['stride'][1]
    tile_dir = MAP_DIR / tile_dir_name(level, lead)
    ahead = f' +{lead}h' if lead else ''
    print(f"  {len(corners)} tiles at {dx:g} x {dy:g} deg, {level['label']}{ahead}")

    # **Stop at the first confirmed failure**, and this is what keeps the
    # retry from costing more than it buys. A confirmed failure has already
    # had its four spaced attempts, so it is not transient — and since any
    # failure fails the whole run below, grinding the remaining tiles only
    # to fail anyway is pure waiting. Measured on the arithmetic: 159 tiles
    # at two depths, 31 s of backoff each, four workers, is **41 minutes**
    # to reach a conclusion that is already known. The hourly build would
    # have overlapped itself.
    #
    # Note the step probe does not cover this case. It catches a server that
    # is *down*; this is the one HYCOM actually does — up, answering
    # metadata, and failing a fraction of reads.
    stop = threading.Event()

    def one(corner: tuple[float, float]) -> tuple[str | None, str]:
        if stop.is_set():
            return None, 'skipped'
        got = build_tile(t, level, valid, run, *corner, lead=lead)
        if got[1] == 'failed':
            stop.set()
        return got

    # The worker count is per depth, not shared across them: the levels are
    # built one after another, so the request rate this puts on a public
    # research server is the same as it was with one depth. Only the wall
    # clock doubles.
    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        results = list(pool.map(one, corners))

    failed = [k for k, outcome in zip(corners, results) if outcome[1] == 'failed']
    if failed:
        # **A short index is worse than no index**, and this is the only
        # place that can tell the difference. Every tile in `available` is
        # real, so publishing anyway would produce a set the map reads
        # happily while silently falling back to the coarse grid over
        # whatever is missing — the failure this project keeps meeting, a
        # render that is wrong and says nothing. Raising instead lands in
        # main's fallback, which keeps the previous complete set and prints
        # how stale it is.
        skipped = sum(1 for _, outcome in results if outcome == 'skipped')
        raise RuntimeError(
            f"{len(failed)} of {len(corners)} tiles failed at {level['label']}"
            f"{ahead} after {len(BACKOFF)} tries each"
            + (f' ({skipped} not attempted)' if skipped else '')
        )

    available = sorted(k for k, _ in results if k)
    index = tile_dir / 'index.json'
    index.write_text(json.dumps({
        'size': TILES['size'], 'west': TILES['west'],
        'south': TILES['south'], 'north': TILES['north'],
        'minZoom': TILES['minZoom'],
        'deg': round(min(DLON * TILES['stride'][0], DLAT * TILES['stride'][1]), 4),
        'modelRun': run, 'refTime': valid, 'depth': level['metres'], 'lead': lead,
        # Tiles that are entirely land are never written, so the map can skip
        # a request it knows would 404.
        'available': available,
    }, separators=(',', ':')) + '\n')

    total = sum((tile_dir / f'{k}.json').stat().st_size for k in available)
    # "all land" is now a counted outcome rather than everything that is not
    # a tile — subtracting from the total was what let a failure read as
    # coastline in the first place.
    empty = sum(1 for _, outcome in results if outcome == 'empty')
    print(f'  wrote {len(available)} tiles ({empty} all land), '
          f'{total / 1024 / 1024:.1f} MB')


def frange(start: float, stop: float, step: float) -> list[float]:
    out, x = [], start
    while x < stop:
        out.append(x)
        x += step
    return out


def detail_links(level: dict, lead: int) -> list[dict]:
    """The regional grids a global file advertises, for one depth and lead.

    The lead is threaded through the URLs, not just the filenames: a +24h
    global file has to point at the +24h regions or zooming in would step
    back to now, which is the sort of thing nothing on screen would give
    away.
    """
    return [
        {
            'url': f'/map/{at_lead(at_depth(d["name"], level["suffix"]), lead)}',
            'label': d['label'],
            # A band spanning every longitude advertises the full range, so
            # the containment test always passes on longitude and turns on
            # latitude alone.
            'west': d.get('west', -180.0), 'east': d.get('east', 180.0),
            'south': d['south'], 'north': d['north'],
            'minZoom': d['minZoom'],
            # So the map can prefer the finest region when two overlap.
            'deg': round(min(DLON * d['stride'][0], DLAT * d['stride'][1]), 4),
        }
        for d in DETAILS
    ]


def leads_wanted() -> list[int] | None:
    """Fixed leads to publish, or None to choose by valid time.

    `--leads=0,12,24,36,48` is how a deployment with more room than a 1 GB
    Pages site asks for the whole eight days, and it is the only way back to
    the run-anchored behaviour this pipeline shipped with.
    """
    for arg in sys.argv[1:]:
        if arg.startswith('--leads='):
            return sorted({int(v) for v in arg.split('=', 1)[1].split(',') if v.strip()})
    return LEADS


_frames: list[tuple[int, int, str, str]] | None = None


def frames() -> list[tuple[int, int, str, str]]:
    """The steps to publish, resolved once and reused.

    Memoised because it costs OPeNDAP round trips and a probe per candidate
    step, and because two calls could disagree: `pick_nearest` reads the
    clock, so a run straddling an anchor boundary would answer differently
    the second time and publish grids from one window under the other's
    filenames.
    """
    global _frames
    if _frames is None:
        leads = leads_wanted()
        _frames = (pick_leads(leads) if leads is not None
                   else pick_nearest(step_offsets(FRAMES)))
    return _frames


def main() -> int:
    tiles_only = '--tiles' in sys.argv
    try:
        if '--run' in sys.argv:
            # Just the model run id. Not enough to key a tile cache on any
            # more — see `--tile-key` — but still the answer to "which run
            # is the map showing", which is the question worth asking before
            # suspecting this pipeline.
            print(pick_time()[2])
            return 0
        if '--tile-key' in sys.argv:
            # What CI keys its tile cache on: the run **and every valid time
            # built from it**.
            #
            # The run alone was enough while the lead was fixed, because
            # then one run meant one hour. It does not survive selection by
            # valid time: the step moves every REFRESH_HOURS within a single
            # run, so a run-only key hits, the build is skipped, and the
            # previous window's tiles are published under the new header —
            # the right run, the wrong hour, and nothing on screen to say
            # so. The cache is an input to what gets served, not a time
            # saver, so anything that changes what the tiles *contain* has
            # to move the key.
            #
            # Hyphen-separated compact stamps rather than the ISO strings:
            # a cache key is matched literally and by prefix, and colons in
            # one have burnt enough people to be worth avoiding.
            def key_stamp(t: str) -> str:
                return t[:13].replace('-', '').replace(':', '')

            print('-'.join(
                # sorted, not a bare set: set iteration order is not stable
                # across processes, and an unstable key never hits.
                [f'r{key_stamp(run)}' for run in sorted({f[3] for f in frames()})]
                + [f'f{key_stamp(valid)}' for _, _, valid, _ in frames()]
            ))
            return 0
        check_depths()

        # Each depth gets the same three tiers, under its own filenames. The
        # global file for a depth advertises that depth's regions and tiles,
        # so the map follows one chain of links per layer and cannot end up
        # drawing 60 m particles over a surface grid.
        built = frames()
        for level in LEVELS:
            print(f"{level['label']}:")
            if tiles_only:
                # Every lead, so a forecast hour is drawn at the same 1/12°
                # as the present rather than falling back to the regional
                # grid — which was what made the small changes invisible.
                for lead, ti, lead_valid, lead_run in built:
                    build_tiles(ti, level, lead_valid, lead_run, lead=lead)
                continue
            # The global file advertises the finer grids, so the map learns
            # the regions and their zoom thresholds from the data rather than
            # repeating them in the component where the two could drift apart.
            for lead, ti, lead_valid, lead_run in built:
                extra: dict = {
                    'details': detail_links(level, lead),
                }
                # Where this frame's full-resolution tiles live. Every lead
                # has its own set now: one forecast hour at native detail is
                # worth more than four at a resolution that hides the change.
                extra['tileIndex'] = f'/map/{tile_dir_name(level, lead)}/index.json'
                # What frames exist, so the map learns the lead times from
                # the data the way it already learns the regions and the tile
                # index — not from a list repeated in the component, where
                # the two would drift.
                #
                # Only when there is more than one, matching the fields
                # pipeline: a single-frame list would have the map advertise
                # a control with nothing to choose between.
                if lead == base_lead() and len(built) > 1:
                    extra['forecast'] = [
                        {
                            'lead': l,
                            'valid': v,
                            'url': f'/map/{at_lead(at_depth(GLOBAL["name"], level["suffix"]), l)}',
                        }
                        for l, _, v, _ in built
                    ]
                build(GLOBAL, ti, level, lead_valid, lead_run, extra=extra, lead=lead)
                for detail in DETAILS:
                    build(detail, ti, level, lead_valid, lead_run, lead=lead)
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'! currents unavailable: {exc}', file=sys.stderr)
        kept = MAP_DIR / GLOBAL['name']
        if kept.exists():
            # Say how stale, not just that it is stale. A neutral "keeping the
            # previous fields" is what let a hard failure — a 400 from a
            # hardcoded time index — sit in the logs for two days looking like
            # a passing build.
            try:
                run = json.loads(kept.read_text())[0]['header'].get('modelRun', '')
                age = (datetime.now(timezone.utc)
                       - datetime.strptime(run, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc))
                print(f'  keeping the previous fields — {run} run, '
                      f'{age.days}d {age.seconds // 3600}h old', file=sys.stderr)
            except (ValueError, KeyError, IndexError, TypeError):
                print('  keeping the previous fields', file=sys.stderr)
            return 0
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
