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


# How far ahead to publish, in hours from now. **Nowcast only by default.**
# Override with --leads=0,24 or --leads=0,12,24,36,48 — every frame the rest
# of this file can build is still one flag away, and nothing downstream
# needed changing to turn them off.
#
# The forecast frames were measured and then dropped, and both halves matter.
# Over 48 hours the median Navy SST change is 0.1 degC on a ramp spanning 20
# and the median salinity change is 0.00 psu, so at the tier a reader
# actually sees, most of the ocean did not move. Serving them at full
# resolution to fix that doubled the tile sets — the published site went to
# ~700 MB — which is a great deal of storage for a difference that is mostly
# below one step of an 8-bit channel.
#
# So the scaffolding stays and the frames go, which leaves room for products
# that will show a reader something new. Set LEADS back and it all returns:
# the map builds its control from whatever the data advertises, and with one
# frame it advertises nothing and the control does not appear.
LEADS = [0]


def at_depth(name: str, suffix: str) -> str:
    """currents-atlantic.json -> currents-atlantic-60m.json"""
    return name[:-len('.json')] + suffix + '.json' if suffix else name


def at_lead(name: str, lead: int) -> str:
    """currents-60m.json -> currents-60m-f12h.json. Lead 0 keeps the bare name.

    Lead 0 is the file every existing reader already fetches, so it must not
    move: a deployment pinned to an older build of the map still asks for
    currents.json and has to keep getting the field for now.
    """
    return name[:-len('.json')] + f'-f{lead}h' + '.json' if lead else name


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
        body = get(f'{BASE}.ascii?{name}[0:1:{time_axis(BASE) - 1}]', timeout=90)
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


def pick_leads(leads: list[int]) -> list[tuple[int, int, str, str]]:
    """(lead, index, valid time, model run) for each lead that exists.

    The step nearest `now + lead`, found on the axis rather than by adding
    `lead / 3` to the index: the spacing is 3 hours today and nothing says it
    has to stay that way, and a wrong index here would publish the wrong hour
    under the right filename — the exact failure that made `time_axis()`
    necessary in the first place.

    A lead past the end of the aggregation is dropped with a note rather than
    clamped to the last step. Clamping would publish a +48h file holding some
    other hour, and nothing downstream could tell.
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

    def when(h: float) -> str:
        return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')

    out = []
    for lead in leads:
        target = now + lead
        index = min(range(len(hours)), key=lambda i: abs(hours[i] - target))
        # Half a step of slack: nearest-match silently returns the last step
        # for anything past the end, so the gap is what catches it.
        if abs(hours[index] - target) > 2:
            print(f'  ! +{lead}h is past the end of the aggregation — skipped',
                  file=sys.stderr)
            continue
        out.append((lead, index, when(hours[index]), when(runs[index]) if index < len(runs) else ''))
    if not out:
        raise RuntimeError('no usable time step')
    return out


def component(name: str, t: int, z: int, y0: int, y1: int, x0: int, x1: int,
              stride_lat: int, stride_lon: int) -> list[list[float | None]]:
    url = (f'{BASE}.ascii?{name}[{t}][{z}]'
           f'[{y0}:{stride_lat}:{y1}][{x0}:{stride_lon}:{x1}]')
    grid = rows(get(url))
    if not grid:
        raise RuntimeError(f'{name}: no rows returned')
    return grid


def build(spec: dict, t: int, level: dict, valid: str, run: str,
          extra: dict | None = None, lead: int = 0) -> None:
    """Fetch one grid at one depth and lead, in leaflet-velocity's format."""
    stride_lon, stride_lat = spec['stride']
    out = MAP_DIR / at_lead(at_depth(spec['name'], level['suffix']), lead)

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
               south: float, west: float, lead: int = 0) -> str | None:
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
        parts = [
            component(name, t, level['index'], y0, y1, a, b, stride_lat, stride_lon)
            for a, b in slabs
        ]
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
    return key


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

    # The worker count is per depth, not shared across them: the levels are
    # built one after another, so the request rate this puts on a public
    # research server is the same as it was with one depth. Only the wall
    # clock doubles.
    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        keys = list(pool.map(lambda c: build_tile(t, level, valid, run, *c, lead=lead), corners))

    available = sorted(k for k in keys if k)
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
    print(f'  wrote {len(available)} tiles ({len(corners) - len(available)} all land), '
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


def leads_wanted() -> list[int]:
    """LEADS, or whatever --leads=0,12,24 asked for.

    The extra hours are optional rather than gone: five frames are still one
    flag away if the fields ever move enough to be worth them, and the same
    flag is how a deployment with more room than a 1 GB Pages site can have
    the whole set.
    """
    for arg in sys.argv[1:]:
        if arg.startswith('--leads='):
            return sorted({int(v) for v in arg.split('=', 1)[1].split(',') if v.strip()})
    return LEADS


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
        check_depths()

        # Each depth gets the same three tiers, under its own filenames. The
        # global file for a depth advertises that depth's regions and tiles,
        # so the map follows one chain of links per layer and cannot end up
        # drawing 60 m particles over a surface grid.
        frames = pick_leads(leads_wanted())
        for level in LEVELS:
            print(f"{level['label']}:")
            if tiles_only:
                # Every lead, so a forecast hour is drawn at the same 1/12°
                # as the present rather than falling back to the regional
                # grid — which was what made the small changes invisible.
                for lead, ti, lead_valid, lead_run in frames:
                    build_tiles(ti, level, lead_valid, lead_run, lead=lead)
                continue
            # The global file advertises the finer grids, so the map learns
            # the regions and their zoom thresholds from the data rather than
            # repeating them in the component where the two could drift apart.
            for lead, ti, lead_valid, lead_run in frames:
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
                if lead == 0 and len(frames) > 1:
                    extra['forecast'] = [
                        {
                            'lead': l,
                            'valid': v,
                            'url': f'/map/{at_lead(at_depth(GLOBAL["name"], level["suffix"]), l)}',
                        }
                        for l, _, v, _ in frames
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
