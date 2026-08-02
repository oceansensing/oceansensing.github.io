#!/usr/bin/env python3
"""Build sea-surface temperature grids for the map.

    python3 scripts/fetch-sst.py            # global + regional grids
    python3 scripts/fetch-sst.py --tiles    # the finest tier (large, slow)
    python3 scripts/fetch-sst.py --run      # the model run id, for CI caching

Two products, because they answer different questions and disagree in
interesting places:

  * **OISST** (NOAA/NCEI, 1/4 degree, daily) is an *analysis* — satellite and
    in-situ observations blended onto a grid. It is what actually happened.
    The final product runs about two weeks behind, so this uses the
    preliminary one, which is a few days behind instead, and says so.
  * **Navy ESPC-D-V02** (1/12 degree, hourly) is a *forecast model* — the same
    product the current layers come from, so the temperature and the flow on
    screen are from one ocean rather than two.

Why fetch server-side and ship a grid, rather than pointing Leaflet at a WMS
that would render this for us: there is no WMS to point at. Measured, not
assumed —

  * wms.hycom.org (the Navy WMS) does not answer, from two networks
  * coastwatch.pfeg.noaa.gov (the usual ERDDAP for OISST) does not answer
  * NCEI's ERDDAP is up but refuses: "not accessible via WMS"

The same reasoning that put the storms and gliders behind this pipeline, for
the same kind of reason. It also buys something: the readout can report SST at
a point from the grid already loaded, with no request.

Standard library only, so CI needs no Python dependencies.
"""

from __future__ import annotations

import json
import math
import pathlib
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

MAP_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'

UA = {'User-Agent': 'oceansensing.org sst map (github.com/oceansensing)'}

_resolve = socket.getaddrinfo


def _ipv4_first(host, port, family=0, type=0, proto=0, flags=0):
    """Resolve to IPv4 when there is one, and only then consider IPv6.

    www.ncei.noaa.gov publishes an AAAA record that does not accept
    connections. urllib tries addresses in the order the resolver returns
    them and waits out a full TCP timeout on each, so every request took
    **120 seconds** against 0.9 with curl — curl hides this with Happy
    Eyeballs, which urllib does not implement. Measured, not guessed: the
    IPv6 connect times out at 8 s while IPv4 answers in 0.07.

    Falls through to the normal resolution when a host has no A record, so
    an IPv6-only service would still work.
    """
    if family == 0:
        try:
            return _resolve(host, port, socket.AF_INET, type, proto, flags)
        except socket.gaierror:
            pass
    return _resolve(host, port, family, type, proto, flags)


socket.getaddrinfo = _ipv4_first

# Tier geometry, shared by both products and deliberately the same shape the
# current grids use: a global field with the page, regions when the viewport
# sits inside one, tiles when it is closer still. The strides differ per
# product because they are indices into that product's own grid, and the two
# have different native resolutions — the point of the finest tier is to reach
# native resolution, not some fixed number of degrees.
REGIONS = [
    {
        'name': 'atlantic',
        'label': 'Atlantic & Gulf',
        'wrap': False,
        'west': -100.0, 'east': -10.0, 'south': 5.0, 'north': 55.0,
        # One level lower than the current regions use. Those hand off to a
        # tile tier soon after; this is the finest SST there is, so it should
        # start as early as a viewport can fit inside the region — at zoom 4
        # a degree cell is about 11 px, which reads as squares.
        'minZoom': 4,
    },
    {
        # A band over every longitude, not a box — the same reasoning as the
        # current grids, where adding one box per complaint did not converge.
        'name': 'arctic',
        'label': 'Arctic & subpolar',
        'wrap': True,
        # Overlaps the Atlantic region rather than meeting it: the map needs
        # the whole viewport inside a region to use one, so a band starting
        # where the other stopped drops every straddling view to the globe.
        'south': 50.0, 'north': 85.0,
        'minZoom': 4,
    },
]

TILES = {
    'size': 20.0,
    'west': -180.0,
    'south': -80.0,
    'north': 85.0,
    'minZoom': 7,
    # Politeness: a handful at a time against public research servers.
    'workers': 4,
}

PRODUCTS = [
    {
        'key': 'oisst',
        'label': 'SST (OISST analysis)',
        'source': 'NOAA/NCEI OISST v2.1 preliminary',
        # Preliminary rather than final: final runs about a fortnight behind,
        # which is too stale to sit beside a live storm track. Measured on
        # 2026-08-01 — final was 15 days back, preliminary 4.
        'base': ('https://www.ncei.noaa.gov/erddap/griddap/'
                 'ncdc_oisst_v2_avhrr_prelim_by_time_zlev_lat_lon'),
        'kind': 'erddap',
        'var': 'sst',
        # Its own grid: 1/4 degree, longitude 0-360 like the Navy model's.
        'lat0': -89.875, 'dlat': 0.25, 'nlat': 720,
        'lon0': 0.125, 'dlon': 0.25, 'nlon': 1440,
        # 1 degree globally, and **native 1/4 degree in a region**. There is
        # no tile tier here and that is the point: tiles exist to reach a
        # product's native resolution, and for OISST the region already is
        # it. Tiling below native would only interpolate, at the cost of a
        # second set of files and a daily build over them.
        'strides': {'global': (4, 4), 'region': (1, 1)},
        'tiles': False,
    },
    {
        'key': 'navy',
        'label': 'SST (Navy ESPC forecast)',
        'source': 'US Navy ESPC-D-V02',
        'base': ('https://tds.hycom.org/thredds/dodsC/'
                 'FMRC_ESPC-D-V02_ts3z/FMRC_ESPC-D-V02_ts3z_best.ncd'),
        'kind': 'dods',
        'var': 'water_temp',
        # The same grid the current layers are built on.
        'lat0': -80.0, 'dlat': 0.04, 'nlat': 4251,
        'lon0': 0.0, 'dlon': 0.08, 'nlon': 4500,
        # The Navy grid is 1/12 degree, far finer than any region stride, so
        # this is the product where a tile tier actually buys resolution.
        'strides': {'global': (12, 24), 'region': (3, 6), 'tile': (1, 2)},
        'tiles': True,
    },
]


def encode(query: str) -> str:
    """ERDDAP rejects raw square brackets outright; THREDDS accepts either.

    Percent-encoding is valid for both, so every URL below is built the same
    way. Worth stating because the current pipeline sends raw brackets and
    works, which makes the difference easy to miss when copying from it.
    """
    return query.replace('[', '%5B').replace(']', '%5D')


def get(url: str, timeout: int = 180) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def rows(body: str, width: int) -> list[list[float | None]]:
    """Pull the numbers out of a DODS ASCII response.

    ERDDAP's .asc and THREDDS' .ascii agree on the shape — each data line
    starts with its index tuple, "[0][0][3], 12.1, 12.4, ..." — which is what
    lets both products share one parser.

    They disagree on how a missing value looks, and that difference is worth
    stating because it is silent. THREDDS writes NaN. **ERDDAP writes
    nothing at all**: a row over land reads ", , , , ,". Skipping empty
    fields, which is what the current pipeline's parser does because there an
    empty field only ever meant a trailing comma, therefore *drops* land
    cells instead of marking them — and the grid comes back ragged, 81 wide
    across Antarctica against 360 in open water, with every row silently
    shifted west of where it belongs.

    So the caller passes the width it asked for and a row that does not match
    is an error rather than a shrug.
    """
    out: list[list[float | None]] = []
    for line in body.splitlines():
        if not line.startswith('['):
            continue
        _, _, values = line.partition(',')
        row: list[float | None] = []
        for token in values.split(','):
            token = token.strip()
            if not token:
                row.append(None)          # ERDDAP's way of saying "no data"
                continue
            try:
                v = float(token)
            except ValueError:
                row.append(None)
                continue
            # A tenth of a degree is finer than the colour ramp can show and
            # keeps the payload small. The range check also catches fill
            # values that arrive as large negatives rather than NaN.
            row.append(None if math.isnan(v) or v < -5 or v > 45 else round(v, 1))
        # A trailing comma looks like one extra missing cell; only ever drop
        # one, and only when it is the difference.
        if len(row) == width + 1 and row[-1] is None:
            row.pop()
        if len(row) != width:
            raise RuntimeError(f'expected {width} values per row, got {len(row)}')
        out.append(row)
    return out


def axis_index(value: float, origin: float, step: float, count: int) -> int:
    return max(0, min(count - 1, round((value - origin) / step)))


def frange(start: float, stop: float, step: float) -> list[float]:
    out, x = [], start
    while x < stop:
        out.append(x)
        x += step
    return out


def newest(product: dict) -> list[tuple[str, str]]:
    """Candidate time steps to fetch, nearest to now first.

    A list rather than one step, because HYCOM's aggregation is unreliable
    per step rather than as a whole: measured on 2026-08-02, index 70 served
    a full global field while index 76 answered 500 "Stale file handle" for
    the very same request, minutes apart. Picking the nearest step and giving
    up on failure therefore loses the whole field to one bad member file,
    when the step an hour either side is fine. The caller walks this list.

    ERDDAP understands "last" directly. THREDDS does not, so the Navy product
    is asked for the step nearest now — the forecast runs days ahead, so the
    last step is not the one anybody wants.
    """
    if product['kind'] == 'erddap':
        body = get(encode(f"{product['base']}.asc?time[last]"), timeout=90)
        seconds = None
        for line in body.splitlines():
            token = line.strip().rstrip(',')
            try:
                seconds = float(token)
            except ValueError:
                continue
        if seconds is None:
            raise RuntimeError('no time value returned')
        stamp = datetime.fromtimestamp(seconds, timezone.utc)
        # ERDDAP indexes from the end, so one step back is the only sensible
        # alternative and its stamp is a day earlier for a daily product.
        return [
            ('last', stamp.strftime('%Y-%m-%dT%H:%M:%SZ')),
            ('last-1', (stamp - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')),
        ]

    das = get(f"{product['base']}.das", timeout=60)
    marker = 'hours since '
    at = das.find(marker, das.find('time {'))
    epoch = datetime.strptime(
        das[at + len(marker):at + len(marker) + 19], '%Y-%m-%d %H:%M:%S'
    ).replace(tzinfo=timezone.utc)

    body = get(encode(f"{product['base']}.ascii?time[0:1:128]"), timeout=90)
    tail = [line for line in body.splitlines() if line.strip()][-1]
    hours = [float(t) for t in tail.split(',') if t.strip()]
    if not hours:
        raise RuntimeError('no time axis')
    target = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600
    order = sorted(range(len(hours)), key=lambda i: abs(hours[i] - target))
    return [
        (str(i), (epoch + timedelta(hours=hours[i])).strftime('%Y-%m-%dT%H:%M:%SZ'))
        for i in order[:8]
    ]


def fetch(product: dict, when: str, y0: int, y1: int, x0: int, x1: int,
          stride_lat: int, stride_lon: int) -> list[list[float | None]]:
    """One rectangle of the field, at one stride."""
    var = product['var']
    span = f'[{y0}:{stride_lat}:{y1}][{x0}:{stride_lon}:{x1}]'
    if product['kind'] == 'erddap':
        # ERDDAP wants the surface level named; the dataset carries a single
        # zlev, so index 0 is it.
        url = f"{product['base']}.asc?{var}[{when}][0]{span}"
    else:
        url = f"{product['base']}.ascii?{var}[{when}][0]{span}"
    width = (x1 - x0) // stride_lon + 1
    grid = rows(get(encode(url)), width)
    if not grid:
        raise RuntimeError(f'{product["key"]}: no rows returned')
    return grid


def slabs_for(product: dict, west: float, east: float, stride_lon: int,
              wrap: bool) -> list[tuple[int, int]]:
    """Longitude ranges to ask for, in the product's own 0-360 indexing.

    A region crossing the prime meridian wraps, so it comes back as two
    slabs, and the second must resume the stride where the first stopped or
    the columns either side are unevenly spaced and the grid is no longer
    regular. The same trap the current pipeline fell into, which silently
    produced 45 degrees of longitude instead of 75.
    """
    nlon = product['nlon']
    if wrap:
        return [(0, nlon - 1)]
    x0 = axis_index(west % 360, product['lon0'], product['dlon'], nlon)
    x1 = axis_index(east % 360, product['lon0'], product['dlon'], nlon)
    if x0 <= x1:
        return [(x0, x1)]
    taken = (nlon - 1 - x0) // stride_lon + 1
    return [(x0, nlon - 1), (x0 + taken * stride_lon - nlon, x1)]


def build(product: dict, when: str, valid: str, out: pathlib.Path,
          south: float, north: float, west: float, east: float,
          stride: tuple[int, int], wrap: bool, extra: dict | None = None) -> dict:
    """Fetch one rectangle at one stride and write it as a scalar grid."""
    stride_lon, stride_lat = stride
    y0 = axis_index(south, product['lat0'], product['dlat'], product['nlat'])
    y1 = axis_index(north, product['lat0'], product['dlat'], product['nlat'])
    slabs = slabs_for(product, west, east, stride_lon, wrap)

    parts = [fetch(product, when, y0, y1, a, b, stride_lat, stride_lon) for a, b in slabs]
    grid = parts[0] if len(parts) == 1 else [w + e for w, e in zip(*parts)]

    ny, nx = len(grid), len(grid[0])
    dx, dy = product['dlon'] * stride_lon, product['dlat'] * stride_lat
    # Rows come south-to-north from both servers; the map reads them from the
    # top down, so flip and quote the north edge as la1 — the same convention
    # the current grids use, so one reader handles both.
    la1 = product['lat0'] + (y0 + (ny - 1) * stride_lat) * product['dlat']
    lo1 = product['lon0'] + slabs[0][0] * product['dlon']

    header = {
        'nx': nx, 'ny': ny,
        'lo1': round(lo1, 4), 'la1': round(la1, 4),
        'dx': round(dx, 4), 'dy': round(dy, 4),
        'refTime': valid,
        'source': product['source'],
        'units': 'degC',
        **(extra or {}),
    }
    payload = {'header': header, 'data': [v for row in reversed(grid) for v in row]}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')

    wet = sum(1 for v in payload['data'] if v is not None)
    spans = nx * dx
    extent = 'wraps' if spans >= 360 else f'{spans:.0f} deg of longitude'
    print(f'  {out.name}: {nx}x{ny} at {dx:g}x{dy:g} deg, {extent}, '
          f'{wet} wet points, {out.stat().st_size / 1024:.0f} KB')
    return header


def build_tile(product: dict, when: str, valid: str,
               south: float, west: float) -> tuple[str | None, str]:
    """One native-resolution tile.

    Returns (key, outcome) where outcome is 'written', 'empty' or 'failed'.
    Those last two must not be conflated, and were: a failed fetch was
    reported as an all-land tile, so a run against a flaky server produced an
    index listing half the ocean and said "81 empty" as though that were the
    coastline. The map then quietly falls back to the coarse grid over
    everything missing, with nothing on screen to say so.

    HYCOM fails per request rather than outright, so a tile is retried before
    it is believed — and the retries are spaced. Three back-to-back attempts
    left 24 of 162 tiles missing, because a transient fault is still there a
    millisecond later; the point of waiting is to let it pass.
    """
    north = min(south + TILES['size'], TILES['north'])
    east = west + TILES['size']
    key = f'{south:g}_{west:g}'
    out = MAP_DIR / f"tiles-sst-{product['key']}" / f'{key}.json'

    last = None
    backoff = [0, 3, 8, 20]
    for wait in backoff:
        if wait:
            time.sleep(wait)
        try:
            header = build(product, when, valid, out, south, north, west, east,
                           product['strides']['tile'], wrap=False)
            break
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
            last = exc
    else:
        print(f'  ! tile {key} failed after {len(backoff)} tries: {last}', file=sys.stderr)
        return None, 'failed'

    if header['nx'] < 2 or header['ny'] < 2:
        out.unlink(missing_ok=True)
        return None, 'empty'
    # A tile with no water in it is never written, so the map can skip a
    # request it knows would 404.
    if not any(v is not None for v in json.loads(out.read_text())['data']):
        out.unlink()
        return None, 'empty'
    return key, 'written' 


def build_tiles(product: dict, when: str, valid: str) -> None:
    from concurrent.futures import ThreadPoolExecutor

    corners = [
        (south, west)
        for south in frange(TILES['south'], TILES['north'], TILES['size'])
        for west in frange(TILES['west'], 180.0, TILES['size'])
    ]
    print(f"  {len(corners)} tiles, {product['label']}")
    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        results = list(pool.map(lambda c: build_tile(product, when, valid, *c), corners))

    available = sorted(k for k, _ in results if k)
    failed = sum(1 for _, why in results if why == 'failed')
    empty = sum(1 for _, why in results if why == 'empty')
    tile_dir = MAP_DIR / f"tiles-sst-{product['key']}"
    tile_dir.mkdir(parents=True, exist_ok=True)
    (tile_dir / 'index.json').write_text(json.dumps({
        'size': TILES['size'], 'west': TILES['west'],
        'south': TILES['south'], 'north': TILES['north'],
        'minZoom': TILES['minZoom'],
        'deg': round(min(product['dlon'] * product['strides']['tile'][0],
                         product['dlat'] * product['strides']['tile'][1]), 4),
        'refTime': valid,
        'available': available,
    }, separators=(',', ':')) + '\n')
    total = sum((tile_dir / f'{k}.json').stat().st_size for k in available)
    print(f'  wrote {len(available)} tiles ({empty} all land, {failed} failed), '
          f'{total / 1024 / 1024:.1f} MB')
    if failed:
        # Loud, and non-zero exit, because a short index is invisible on the
        # map: it just quietly reads the coarse grid over the missing water.
        print(f'  ! {failed} tiles missing from the index — the map will fall back '
              f'to the regional grid over that water', file=sys.stderr)
        raise RuntimeError(f'{failed} of {len(corners)} tiles failed')


def usable_step(product: dict) -> tuple[str, str]:
    """The first candidate step that actually serves data.

    Probed with a deliberately tiny read rather than the real one: a step
    that is broken fails on any read, so a few cells are enough to tell, and
    it costs a fraction of a second against a minute for the global grid.
    """
    candidates = newest(product)
    for when, valid in candidates:
        try:
            fetch(product, when, 2000, 2004, 2000, 2004, 2, 2)
            return when, valid
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
            print(f'  step {when} ({valid}) unusable: {exc}', file=sys.stderr)
    raise RuntimeError(f'no usable time step in {len(candidates)} candidates')


def build_product(product: dict, tiles_only: bool) -> None:
    when, valid = usable_step(product)
    print(f"{product['label']} — valid {valid}")

    if tiles_only:
        if not product.get('tiles'):
            print('  no tile tier — the region grid is already native resolution')
            return
        build_tiles(product, when, valid)
        return

    name = f"sst-{product['key']}"
    details = []
    for region in REGIONS:
        details.append({
            'url': f'/map/{name}-{region["name"]}.json',
            'label': region['label'],
            'west': region.get('west', -180.0), 'east': region.get('east', 180.0),
            'south': region['south'], 'north': region['north'],
            'minZoom': region['minZoom'],
            'deg': round(min(product['dlon'] * product['strides']['region'][0],
                             product['dlat'] * product['strides']['region'][1]), 4),
        })

    # The global file advertises the finer tiers, so the map learns them from
    # the data rather than repeating the bounds in the component.
    build(product, when, valid, MAP_DIR / f'{name}.json',
          south=-80.0, north=85.0, west=-180.0, east=180.0,
          stride=product['strides']['global'], wrap=True,
          extra={
              'details': details,
              # Only advertised where a tile tier exists; the map follows this
              # link, so a product without one must not offer it.
              **({'tileIndex': f'/map/tiles-sst-{product["key"]}/index.json'}
                 if product.get('tiles') else {}),
          })

    for region in REGIONS:
        build(product, when, valid, MAP_DIR / f'{name}-{region["name"]}.json',
              south=region['south'], north=region['north'],
              west=region.get('west', -180.0), east=region.get('east', 180.0),
              stride=product['strides']['region'], wrap=region['wrap'])


def main() -> int:
    tiles_only = '--tiles' in sys.argv
    only = next((a.split('=')[1] for a in sys.argv if a.startswith('--only=')), None)

    failed = []
    for product in PRODUCTS:
        if only and product['key'] != only:
            continue
        try:
            build_product(product, tiles_only)
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
            # One source being down must not take the other with it, and a
            # previous file standing is better than an empty map. HYCOM in
            # particular serves metadata while refusing data reads.
            print(f"! {product['key']} unavailable: {exc}", file=sys.stderr)
            failed.append(product['key'])

    if failed and len(failed) == len(PRODUCTS):
        if (MAP_DIR / 'sst-oisst.json').exists():
            print('  keeping the previous fields', file=sys.stderr)
            return 0
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
