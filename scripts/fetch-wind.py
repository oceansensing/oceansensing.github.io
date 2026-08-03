#!/usr/bin/env python3
"""Build 10 m wind grids for the map, from ECMWF's open IFS forecast.

    python3 scripts/fetch-wind.py

**This is the one pipeline here that is not standard library only**, and the
reason is the format rather than the effort. ECMWF packs its open GRIB2 with
data representation template **5.42, CCSDS/AEC** — an adaptive entropy coder,
not something forty lines of `struct` can unpick the way simple packing would
be. So it needs `eccodes`, which ships binary wheels with the library bundled
(`pip install eccodes`, no system packages).

Everything else here stays in the house style: urllib, no client library, and
a fallback to the previous file so an outage degrades to stale rather than
blank.

Three things about the source are worth knowing before changing anything.

**The fetch is a byte range, not a file.** Each step publishes a ~300 MB
GRIB2 alongside a `.index` sidecar — one JSON object per message, carrying
`_offset` and `_length`. Reading the sidecar and asking for just the two
messages wanted takes this from 300 MB to about **1.5 MB**. Downloading the
whole file and discarding 99.5% of it would work and would be rude.

**The grid starts at 180 degrees east**, where every other grid this project
publishes starts at 0. It is rolled to 0 on the way out rather than passed
through with its own `lo1`: leaflet-velocity and the map's own sampling both
work off `lo1` and would in principle cope, but every other grid here shares
one convention and a second one is a bug waiting for whoever next writes a
sampling loop. One `roll`, and the question never comes up.

**Wind is not masked to the ocean, and that is deliberate.** The currents are
eroded back from the coastline because a current over land is a lie; a wind
over land is a fact, and a hurricane crossing a coast is exactly when someone
wants to see it. So there is no mask here and no erosion — the field is
global and complete.
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

MAP_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'

UA = {'User-Agent': 'oceansensing.org wind map (github.com/oceansensing)'}

BASE = 'https://data.ecmwf.int/forecasts'

# The operational high-resolution forecast at a quarter degree. `oper` is the
# deterministic run; `enfo` would be the ensemble, which is a different
# question and a great deal more data.
STREAM = 'ifs/0p25/oper'

# IFS runs four times a day. 00z and 12z carry the long forecast; 06z and 18z
# are shorter but are published just the same, and for a nowcast a short run
# is worth as much as a long one — what matters is which is freshest.
RUN_HOURS = [0, 6, 12, 18]

# How many runs back to try before giving up. ECMWF keeps a rolling window of
# a few days, so this is about an outage rather than about retention: four
# runs is a full day, which is far longer than the publication lag has ever
# been.
RUNS_BACK = 4

# The two messages wanted, and the leaflet-velocity numbers that identify
# them. Category 2 is momentum; 2 and 3 are the u and v components. The map
# reads these rather than the names, so they are contract, not decoration.
COMPONENTS = [
    {'param': '10u', 'category': 2, 'number': 2},
    {'param': '10v', 'category': 2, 'number': 3},
]

# Native resolution, from the grid itself rather than assumed — `read_grid`
# checks these against what the message says and raises on a mismatch, since
# a silently changed grid would publish plausible wind in the wrong places.
NATIVE = {'nx': 1440, 'ny': 721, 'd': 0.25}

# The same tier shape every other field here uses: a coarse global grid with
# the page, a native regional grid when the viewport sits inside one.
#
# **There is no tile tier, by design** — the same reasoning that gives OISST
# none. Tiles exist to reach a product's native resolution, and the regions
# below already are native at 0.25 degrees. Tiling under that would only
# interpolate, for a second set of files and a build over them.
GLOBAL_STRIDE = 4          # 1 degree; 360 x 181, about what currents.json weighs

REGIONS = [
    {
        'name': 'atlantic',
        'label': 'Atlantic & Gulf',
        'west': -100.0, 'east': -10.0, 'south': 5.0, 'north': 55.0,
        'wrap': False,
        'minZoom': 4,
    },
    {
        # A band over every longitude rather than a box, and it overlaps the
        # Atlantic region rather than meeting it — both for the reasons the
        # current grids record: a region is used only when it contains the
        # whole viewport, so a band starting where the other stopped drops
        # every straddling view back to the coarse grid.
        'name': 'arctic',
        'label': 'Arctic & subpolar',
        'south': 50.0, 'north': 85.0,
        'wrap': True,
        'minZoom': 4,
    },
]

GLOBAL_NAME = 'wind.json'


def get(url: str, timeout: int = 120, rng: tuple[int, int] | None = None) -> bytes:
    req = urllib.request.Request(url, headers=dict(UA))
    if rng:
        # HTTP ranges are inclusive at both ends, and the index gives an
        # offset and a length — so the last byte is offset + length - 1. Off
        # by one here truncates the final GRIB section rather than failing,
        # which eccodes reports as a corrupt message well away from the cause.
        req.add_header('Range', f'bytes={rng[0]}-{rng[0] + rng[1] - 1}')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def runs_newest_first() -> list[datetime]:
    """Candidate model runs, freshest first."""
    now = datetime.now(timezone.utc)
    out = []
    probe = now.replace(minute=0, second=0, microsecond=0)
    while len(out) < RUNS_BACK * 2:
        if probe.hour in RUN_HOURS:
            out.append(probe)
        probe -= timedelta(hours=1)
    return out[:RUNS_BACK * 2]


def step_url(run: datetime, step: int, ext: str) -> str:
    day = run.strftime('%Y%m%d')
    hh = run.strftime('%H')
    stamp = run.strftime('%Y%m%d%H0000')
    return f'{BASE}/{day}/{hh}z/{STREAM}/{stamp}-{step}h-oper-fc.{ext}'


def nearest_step(run: datetime, now: datetime) -> int:
    """The published step whose valid time is closest to `now`.

    A nowcast, which is what this layer is for — unlike the ESPC fields,
    whose lead is counted from their run because that run lands a day and a
    half late. IFS lands within hours, so its own early steps really are
    about the present and there is nothing to compensate for.

    Steps are three-hourly out to 144, so this rounds to the nearest three
    and clamps at zero: a run published before its own start hour has no
    step for "now" and its step 0 is the closest thing there is.
    """
    ahead = (now - run).total_seconds() / 3600
    return max(0, min(144, int(round(ahead / 3)) * 3))


def pick_step() -> tuple[datetime, int, datetime]:
    """(run, step, valid) — the freshest run that has published the step
    nearest now.

    Freshest *run* first and then its own nearest step, rather than the step
    nearest now across all runs: the two differ exactly when a run is still
    publishing, and then the older run's answer is a complete field while
    the newer one's is a 404. Asking in this order degrades to a three or
    six hour older analysis rather than to nothing.
    """
    now = datetime.now(timezone.utc)
    for run in runs_newest_first():
        step = nearest_step(run, now)
        try:
            index = get(step_url(run, step, 'index'), timeout=60)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f'  {run:%Y-%m-%d %H}z +{step}h not published ({exc.__class__.__name__})',
                  file=sys.stderr)
            continue
        if b'"param": "10u"' not in index and b'"param":"10u"' not in index:
            print(f'  {run:%Y-%m-%d %H}z +{step}h has no 10u', file=sys.stderr)
            continue
        valid = run + timedelta(hours=step)
        return run, step, valid
    raise RuntimeError('no ECMWF run has published a usable step')


def read_component(run: datetime, step: int, comp: dict):
    """One wind component as a (ny, nx) array of floats, north row first.

    The index is read per component rather than once, because it is 30 KB and
    reading it twice is cheaper than threading a parsed copy through — and it
    keeps this function answerable on its own.
    """
    import numpy as np
    import eccodes as ec

    body = get(step_url(run, step, 'index'), timeout=60).decode()
    rows = [json.loads(line) for line in body.splitlines() if line.strip()]
    hit = next((r for r in rows if r.get('param') == comp['param']), None)
    if hit is None:
        raise RuntimeError(f'{comp["param"]} is not in the index')

    raw = get(step_url(run, step, 'grib2'), rng=(int(hit['_offset']), int(hit['_length'])))
    if raw[:4] != b'GRIB':
        raise RuntimeError(f'{comp["param"]}: range did not start at a GRIB message')

    handle = ec.codes_new_from_message(raw)
    try:
        name = ec.codes_get(handle, 'shortName')
        if name != comp['param']:
            raise RuntimeError(f'asked for {comp["param"]}, got {name}')
        nx = ec.codes_get(handle, 'Ni')
        ny = ec.codes_get(handle, 'Nj')
        d = ec.codes_get(handle, 'iDirectionIncrementInDegrees')
        la1 = ec.codes_get(handle, 'latitudeOfFirstGridPointInDegrees')
        lo1 = ec.codes_get(handle, 'longitudeOfFirstGridPointInDegrees')
        # Checked rather than trusted, and each of these would be silent: a
        # changed resolution publishes the right numbers at the wrong
        # spacing, and a flipped scan order publishes the world upside down.
        if (nx, ny) != (NATIVE['nx'], NATIVE['ny']) or abs(d - NATIVE['d']) > 1e-9:
            raise RuntimeError(f'grid is {nx}x{ny} at {d} deg, expected '
                               f'{NATIVE["nx"]}x{NATIVE["ny"]} at {NATIVE["d"]}')
        if abs(la1 - 90.0) > 1e-6:
            raise RuntimeError(f'first row is at {la1}, expected the north pole')
        values = ec.codes_get_values(handle).reshape(ny, nx)
    finally:
        ec.codes_release(handle)

    # Roll from ECMWF's 180-first ordering to the 0-first one every other
    # grid here uses. `lo1` is read rather than assumed so a change upstream
    # moves the roll instead of silently shifting the world sideways.
    shift = int(round(lo1 / d)) % nx
    if shift:
        values = np.roll(values, -shift, axis=1)
    return values


def subsample(values, stride: int, south: float, north: float,
              west: float, east: float, wrap: bool):
    """A tier's slice of the native grid, with its header geometry.

    Returns (array, lo1, la1, dx, dy, nx, ny). Latitudes run north to south,
    which is the order the message arrives in and the order the map reads.
    """
    import numpy as np
    d = NATIVE['d']
    ny, nx = values.shape

    rows = [i for i in range(0, ny, stride) if south <= 90.0 - i * d <= north]
    if not rows:
        raise RuntimeError(f'no rows between {south} and {north}')

    if wrap:
        cols = list(range(0, nx, stride))
    else:
        # Longitudes are stored 0-360 from the prime meridian; the regions
        # are written in signed degrees, so fold before comparing.
        cols = [j for j in range(0, nx, stride)
                if west <= ((j * d + 180.0) % 360.0) - 180.0 <= east]
        if not cols:
            raise RuntimeError(f'no columns between {west} and {east}')

    out = values[np.ix_(rows, cols)]
    lo1 = cols[0] * d
    if not wrap:
        lo1 = ((lo1 + 180.0) % 360.0) - 180.0
    return out, lo1, 90.0 - rows[0] * d, stride * d, stride * d, len(cols), len(rows)


def write(values, path: pathlib.Path, run: datetime, valid: datetime,
          step: int, stride: int, south: float, north: float,
          west: float, east: float, wrap: bool, extra: dict | None = None) -> None:
    parts = []
    for comp, field in zip(COMPONENTS, values):
        grid, lo1, la1, dx, dy, nx, ny = subsample(
            field, stride, south, north, west, east, wrap)
        header = {
            'parameterCategory': comp['category'],
            'parameterNumber': comp['number'],
            'parameterUnit': 'm.s-1',
            'nx': nx, 'ny': ny,
            'lo1': round(lo1, 4), 'la1': round(la1, 4),
            'dx': round(dx, 4), 'dy': round(dy, 4),
            'refTime': valid.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'modelRun': run.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'source': 'ECMWF IFS',
            # Height above ground, the wind analogue of the currents' depth.
            # Named rather than implied, because 10 m is a convention and a
            # 100 m layer off the same run is one entry away.
            'height': 10,
            'lead': step,
            **(extra or {}),
        }
        # One decimal is 0.1 m/s, which is under a tenth of the smallest
        # difference a particle field can show and a third of the file size
        # of two.
        parts.append({'header': header,
                      'data': [round(float(v), 1) for v in grid.reshape(-1)]})

    path.write_text(json.dumps(parts, separators=(',', ':')))
    h = parts[0]['header']
    print(f"  {path.name}: {h['nx']}x{h['ny']} at {h['dx']} deg"
          f"{', wraps' if wrap else f', {round(east - west)} deg of longitude'}"
          f", {path.stat().st_size / 1024:.0f} KB")


def region_links() -> list[dict]:
    return [
        {
            'url': f'/map/wind-{r["name"]}.json',
            'label': r['label'],
            'west': r.get('west', -180.0), 'east': r.get('east', 180.0),
            'south': r['south'], 'north': r['north'],
            'minZoom': r['minZoom'],
            'deg': NATIVE['d'],
        }
        for r in REGIONS
    ]


def main() -> int:
    try:
        run, step, valid = pick_step()
        age = (datetime.now(timezone.utc) - run).total_seconds() / 3600
        ahead = (valid - datetime.now(timezone.utc)).total_seconds() / 3600
        print(f'ECMWF IFS 10 m wind — valid {valid:%Y-%m-%dT%H:%M:%SZ} '
              f'({ahead:+.0f} h), from the {run:%Y-%m-%dT%H:%M:%SZ} run '
              f'({age:.0f} h old), step +{step}h')

        fields = [read_component(run, step, c) for c in COMPONENTS]

        MAP_DIR.mkdir(parents=True, exist_ok=True)
        write(fields, MAP_DIR / GLOBAL_NAME, run, valid, step,
              GLOBAL_STRIDE, -90.0, 90.0, -180.0, 180.0, True,
              extra={'details': region_links()})
        for r in REGIONS:
            write(fields, MAP_DIR / f'wind-{r["name"]}.json', run, valid, step,
                  1, r['south'], r['north'],
                  r.get('west', -180.0), r.get('east', 180.0), r['wrap'])
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'! wind unavailable: {exc}', file=sys.stderr)
        existing = MAP_DIR / GLOBAL_NAME
        if existing.exists():
            try:
                was = json.loads(existing.read_text())[0]['header']['refTime']
                print(f'  keeping the previous wind field, valid {was}', file=sys.stderr)
            except (ValueError, KeyError, IndexError):
                print('  keeping the previous wind field', file=sys.stderr)
            return 0
        print('  and there is no previous file to keep', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
