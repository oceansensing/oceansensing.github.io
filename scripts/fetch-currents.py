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

DETAIL = {
    'name': 'currents-detail.json',
    'wrap': False,
    'west': -100.0, 'east': -10.0, 'south': 5.0, 'north': 55.0,
    'stride': (3, 6),
    # Below this the coarse grid looks the same, so do not make anyone pay
    # for the download.
    'minZoom': 5,
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

    if spec['wrap']:
        x0, x1 = 0, NLON - 1
    else:
        x0 = axis_index(spec['west'] + 360, LON0, DLON, NLON)
        x1 = axis_index(spec['east'] + 360, LON0, DLON, NLON)
    y0 = axis_index(spec['south'], LAT0, DLAT, NLAT)
    y1 = axis_index(spec['north'], LAT0, DLAT, NLAT)

    u = component('water_u', t, y0, y1, x0, x1, stride_lat, stride_lon)
    v = component('water_v', t, y0, y1, x0, x1, stride_lat, stride_lon)
    if len(u) != len(v) or len(u[0]) != len(v[0]):
        raise RuntimeError(f'{spec["name"]}: u and v grids disagree in shape')

    ny, nx = len(u), len(u[0])
    dx, dy = DLON * stride_lon, DLAT * stride_lat
    # The model counts latitude northward; leaflet-velocity reads its rows
    # from the top down, so the grid is flipped and la1 is the north edge.
    la1 = LAT0 + (y0 + (ny - 1) * stride_lat) * DLAT
    # The model counts longitude from 0 east; leaflet-velocity wraps with a
    # floored modulo, so it reads -74 as 286 without help.
    lo1 = LON0 + x0 * DLON

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

    wet = sum(1 for x in payload[0]['data'] if x is not None)
    spans = nx * dx
    extent = 'wraps' if spans >= 360 else f'{spans:.0f} deg of longitude'
    print(f'  {spec["name"]}: {nx}x{ny} at {dx:.2f} deg, {extent}, '
          f'{wet} wet points, {out.stat().st_size / 1024:.0f} KB')


def main() -> int:
    try:
        t, valid, run = pick_time()
        print(f'model step {t} — valid {valid}, from the {run} run')

        # The global file advertises the detail grid, so the map learns the
        # region and its zoom threshold from the data rather than repeating
        # them in the component where the two could drift apart.
        build(GLOBAL, t, valid, run, extra={
            'detail': {
                'url': f'/map/{DETAIL["name"]}',
                'west': DETAIL['west'], 'east': DETAIL['east'],
                'south': DETAIL['south'], 'north': DETAIL['north'],
                'minZoom': DETAIL['minZoom'],
            },
        })
        build(DETAIL, t, valid, run)
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'! currents unavailable: {exc}', file=sys.stderr)
        if (MAP_DIR / GLOBAL['name']).exists():
            print('  keeping the previous fields', file=sys.stderr)
            return 0
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
