#!/usr/bin/env python3
"""Build a surface-current vector field for the animated map layer.

Run by .github/workflows/deploy.yml alongside fetch-ocean-assets.py. Writes
public/map/currents.json in the format leaflet-velocity expects: two objects,
eastward then northward, each a header describing a regular grid plus a flat
row-major array of values.

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

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map' / 'currents.json'

BASE = ('https://tds.hycom.org/thredds/dodsC/'
        'FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd')

# The model's own grid: longitude 0-360 at 0.08 deg, latitude -80..90 at 0.04.
LON0, DLON, NLON = 0.0, 0.08, 4500
LAT0, DLAT, NLAT = -80.0, 0.04, 4251

# The hurricane basin the page is about — the Gulf, Caribbean and North
# Atlantic. A global field at a resolution that resolves the Gulf Stream
# would be several megabytes.
WEST, EAST, SOUTH, NORTH = -100.0, -10.0, 5.0, 55.0

# Subsample to ~0.48 deg. Coarser than the model, but the animation
# interpolates between grid points and the payload stays a fifth the size.
STRIDE_LON, STRIDE_LAT = 6, 12

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
            row.append(None if math.isnan(v) else round(v, 3))
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
    stamp = lambda h: (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')
    run = stamp(runs[index]) if index < len(runs) else ''
    return index, stamp(hours[index]), run


def component(name: str, t: int, y0: int, y1: int, x0: int, x1: int) -> list[list[float | None]]:
    url = (f'{BASE}.ascii?{name}[{t}][0]'
           f'[{y0}:{STRIDE_LAT}:{y1}][{x0}:{STRIDE_LON}:{x1}]')
    grid = rows(get(url))
    if not grid:
        raise RuntimeError(f'{name}: no rows returned')
    return grid


def main() -> int:
    try:
        t, valid, run = pick_time()
        print(f'model step {t} — valid {valid}, from the {run} run')

        # 0-360 longitudes in the model; the region is west of the meridian.
        x0 = axis_index(WEST + 360, LON0, DLON, NLON)
        x1 = axis_index(EAST + 360, LON0, DLON, NLON)
        y0 = axis_index(SOUTH, LAT0, DLAT, NLAT)
        y1 = axis_index(NORTH, LAT0, DLAT, NLAT)

        u = component('water_u', t, y0, y1, x0, x1)
        v = component('water_v', t, y0, y1, x0, x1)
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'! currents unavailable: {exc}', file=sys.stderr)
        if OUT.exists():
            print('  keeping the previous field', file=sys.stderr)
            return 0
        return 1

    if len(u) != len(v) or len(u[0]) != len(v[0]):
        print('! u and v grids disagree in shape', file=sys.stderr)
        return 1

    ny, nx = len(u), len(u[0])
    dx, dy = DLON * STRIDE_LON, DLAT * STRIDE_LAT
    # The model counts latitude northward; leaflet-velocity reads its rows
    # from the top down, so the grid is flipped and la1 is the north edge.
    la1 = LAT0 + (y0 + (ny - 1) * STRIDE_LAT) * DLAT
    lo1 = LON0 + x0 * DLON - 360

    def flatten(grid):
        return [value for row in reversed(grid) for value in row]

    def header(number):
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
        }

    payload = [
        {'header': header(2), 'data': flatten(u)},
        {'header': header(3), 'data': flatten(v)},
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(',', ':')) + '\n')

    wet = sum(1 for x in payload[0]['data'] if x is not None)
    print(f'wrote {OUT} — {nx}x{ny} at {dx:.2f} deg, {wet} wet points, '
          f'{OUT.stat().st_size / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
