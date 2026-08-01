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
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

MAP_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'

BASE = ('https://tds.hycom.org/thredds/dodsC/'
        'FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd')

# The model's own grid: longitude 0-360 at 0.08 deg, latitude -80..90 at 0.04.
LON0, DLON, NLON = 0.0, 0.08, 4500
LAT0, DLAT, NLAT = -80.0, 0.04, 4251

GLOBAL = {
    'name': 'currents.json',
    # Longitude wraps the whole way round, which leaflet-velocity handles
    # natively — given a grid spanning 360 deg it duplicates the first column
    # onto the end so particles cross the antimeridian instead of piling up
    # against it. Latitude stops at 85, past which Web Mercator cannot draw.
    'wrap': True,
    'south': -80.0, 'north': 85.0,
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
        'south': 50.0, 'north': 85.0,
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
    'north': 85.0,
    'minZoom': 7,
    # 0.08 x 0.08 — true 1/12 degree, and isotropic. The model carries 0.04
    # in latitude, but taking it doubles the deployed site to 205 MB for a
    # refinement from 9 km to 4.4 km in one axis only. Change to (1, 1) here
    # if that is ever worth it.
    'stride': (1, 2),
    # Politeness: two requests per tile to a public research server, a few
    # tiles at a time.
    'workers': 4,
}

UA = {'User-Agent': 'oceansensing.org current map (github.com/oceansensing)'}


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


def pick_time() -> tuple[int, str, str]:
    """Index of the model step nearest now, its valid time, and its model run.

    The forecast covers several days, so "nearest" rather than "latest" — the
    last step is days ahead.

    ESPC-D-V02 runs once a day at 12Z and lands on THREDDS a few hours after
    that, so the deploy does not need its own schedule: the hourly build
    picks a new run up within the hour. Reporting which run the field came
    from is what makes that verifiable rather than assumed.
    """
    das = get(f'{BASE}.das', timeout=60)
    marker = 'hours since '
    at = das.find(marker, das.find('time {'))
    stamp = das[at + len(marker):at + len(marker) + 19]
    epoch = datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)

    # The values sit on the last non-blank line, after a "time[129]" label
    # and a rule of dashes.
    def axis(name: str) -> list[float]:
        body = get(f'{BASE}.ascii?{name}[0:1:128]', timeout=90)
        tail = [line for line in body.splitlines() if line.strip()][-1]
        return [float(t) for t in tail.split(',') if t.strip()]

    hours = axis('time')
    if not hours:
        raise RuntimeError('no time axis')
    runs = axis('time_run')

    now = datetime.now(timezone.utc)
    target = (now - epoch).total_seconds() / 3600
    index = min(range(len(hours)), key=lambda i: abs(hours[i] - target))

    def when(h: float) -> str:
        return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')

    run = when(runs[index]) if index < len(runs) else ''
    return index, when(hours[index]), run


def component(name: str, t: int, y0: int, y1: int, x0: int, x1: int,
              stride_lat: int, stride_lon: int) -> list[list[float | None]]:
    url = (f'{BASE}.ascii?{name}[{t}][0]'
           f'[{y0}:{stride_lat}:{y1}][{x0}:{stride_lon}:{x1}]')
    grid = rows(get(url))
    if not grid:
        raise RuntimeError(f'{name}: no rows returned')
    return grid


def build(spec: dict, t: int, valid: str, run: str, extra: dict | None = None) -> None:
    """Fetch one grid and write it in leaflet-velocity's format."""
    stride_lon, stride_lat = spec['stride']
    out = MAP_DIR / spec['name']

    y0 = axis_index(spec['south'], LAT0, DLAT, NLAT)
    y1 = axis_index(spec['north'], LAT0, DLAT, NLAT)

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
        parts = [component(name, t, y0, y1, a, b, stride_lat, stride_lon) for a, b in slabs]
        if len(parts) == 1:
            return parts[0]
        return [west + east for west, east in zip(*parts)]

    u = fetch_component('water_u')
    v = fetch_component('water_v')
    if len(u) != len(v) or len(u[0]) != len(v[0]):
        raise RuntimeError(f'{spec["name"]}: u and v grids disagree in shape')

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
    print(f'  {spec["name"]}: {nx}x{ny} at {dx:.2f}x{dy:.2f} deg, {extent}, '
          f'{after} wet points after coastal erosion (from {before}), '
          f'{out.stat().st_size / 1024:.0f} KB')


def build_tile(t: int, valid: str, run: str, south: float, west: float) -> str | None:
    """One full-resolution tile. Returns its key, or None if it is all land."""
    north = min(south + TILES['size'], TILES['north'])
    east = west + TILES['size']

    y0 = axis_index(south, LAT0, DLAT, NLAT)
    y1 = axis_index(north, LAT0, DLAT, NLAT)
    x0 = axis_index(west % 360, LON0, DLON, NLON)
    x1 = axis_index(east % 360, LON0, DLON, NLON)
    if x0 <= x1:
        slabs = [(x0, x1)]
    else:
        taken = (NLON - 1 - x0) // TILES['stride'][0] + 1
        slabs = [(x0, NLON - 1), (x0 + taken * TILES['stride'][0] - NLON, x1)]

    stride_lon, stride_lat = TILES['stride']

    def grab(name: str) -> list[list[float | None]]:
        parts = [component(name, t, y0, y1, a, b, stride_lat, stride_lon) for a, b in slabs]
        return parts[0] if len(parts) == 1 else [w + e for w, e in zip(*parts)]

    u = grab('water_u')
    v = grab('water_v')
    if len(u) != len(v) or len(u[0]) != len(v[0]):
        raise RuntimeError(f'tile {south}/{west}: u and v disagree in shape')

    if not erode_land(u, v, False):
        return None                      # nothing but land; do not write a file

    ny, nx = len(u), len(u[0])
    la1 = LAT0 + (y0 + (ny - 1) * stride_lat) * DLAT
    lo1 = LON0 + slabs[0][0] * DLON

    def header(number: int) -> dict:
        return {
            'parameterCategory': 2, 'parameterNumber': number, 'parameterUnit': 'm.s-1',
            'nx': nx, 'ny': ny,
            'lo1': round(lo1, 4), 'la1': round(la1, 4),
            'dx': round(DLON * stride_lon, 4), 'dy': round(DLAT * stride_lat, 4),
            'refTime': valid, 'modelRun': run,
        }

    payload = [
        {'header': header(2), 'data': [x for row in reversed(u) for x in row]},
        {'header': header(3), 'data': [x for row in reversed(v) for x in row]},
    ]
    key = f'{south:g}_{west:g}'
    out = MAP_DIR / TILES['dir'] / f'{key}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    return key


def build_tiles(t: int, valid: str, run: str) -> None:
    """Every tile covering ocean, plus an index the map reads."""
    from concurrent.futures import ThreadPoolExecutor

    corners = [
        (south, west)
        for south in frange(TILES['south'], TILES['north'], TILES['size'])
        for west in frange(TILES['west'], 180.0, TILES['size'])
    ]
    dx, dy = DLON * TILES['stride'][0], DLAT * TILES['stride'][1]
    print(f'  {len(corners)} tiles at {dx:g} x {dy:g} deg')

    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        keys = list(pool.map(lambda c: build_tile(t, valid, run, *c), corners))

    available = sorted(k for k in keys if k)
    index = MAP_DIR / TILES['dir'] / 'index.json'
    index.write_text(json.dumps({
        'size': TILES['size'], 'west': TILES['west'],
        'south': TILES['south'], 'north': TILES['north'],
        'minZoom': TILES['minZoom'],
        'deg': round(min(DLON * TILES['stride'][0], DLAT * TILES['stride'][1]), 4),
        'modelRun': run, 'refTime': valid,
        # Tiles that are entirely land are never written, so the map can skip
        # a request it knows would 404.
        'available': available,
    }, separators=(',', ':')) + '\n')

    total = sum((MAP_DIR / TILES['dir'] / f'{k}.json').stat().st_size for k in available)
    print(f'  wrote {len(available)} tiles ({len(corners) - len(available)} all land), '
          f'{total / 1024 / 1024:.1f} MB')


def frange(start: float, stop: float, step: float) -> list[float]:
    out, x = [], start
    while x < stop:
        out.append(x)
        x += step
    return out


def main() -> int:
    tiles_only = '--tiles' in sys.argv
    try:
        t, valid, run = pick_time()
        if '--run' in sys.argv:
            # Just the model run id, for CI to key its tile cache on. The
            # tiles only change when the model does, so an hourly build can
            # restore them instead of pulling 92 MB from HYCOM again.
            print(run)
            return 0
        print(f'model step {t} — valid {valid}, from the {run} run')

        # The global file advertises the finer grids, so the map learns the
        # regions and their zoom thresholds from the data rather than
        # repeating them in the component where the two could drift apart.
        build(GLOBAL, t, valid, run, extra={
            # Where the full-resolution tiles live, if a tile run has
            # happened. They are rebuilt only when the model does, so the
            # hourly build leaves them alone.
            'tileIndex': f'/map/{TILES["dir"]}/index.json',
            'details': [
                {
                    'url': f'/map/{d["name"]}',
                    'label': d['label'],
                    # A band spanning every longitude advertises the full
                    # range, so the containment test below always passes on
                    # longitude and turns on latitude alone.
                    'west': d.get('west', -180.0), 'east': d.get('east', 180.0),
                    'south': d['south'], 'north': d['north'],
                    'minZoom': d['minZoom'],
                    # So the map can prefer the finest region when two overlap.
                    'deg': round(min(DLON * d['stride'][0], DLAT * d['stride'][1]), 4),
                }
                for d in DETAILS
            ],
        })
        if tiles_only:
            build_tiles(t, valid, run)
            return 0
        for detail in DETAILS:
            build(detail, t, valid, run)
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'! currents unavailable: {exc}', file=sys.stderr)
        if (MAP_DIR / GLOBAL['name']).exists():
            print('  keeping the previous fields', file=sys.stderr)
            return 0
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
