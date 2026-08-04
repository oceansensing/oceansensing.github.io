#!/usr/bin/env python3
"""Build surface scalar-field grids for the map — temperature and salinity.

    python3 scripts/fetch-ocean-fields.py           # global + regional grids
    python3 scripts/fetch-ocean-fields.py --tiles   # the finest tier (slow)
    python3 scripts/fetch-ocean-fields.py --only=sss-navy

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
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'lib'))
from contour import contour  # noqa: E402  (after the path insert above)

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
    {
        # **Sea ice is bipolar and the regions were not.** Everything above
        # was built for the Atlantic hurricane fleet, so the Southern Ocean
        # had no region at all — which does not show on a temperature map,
        # where the globe grid is a fair depiction of a smooth field, and
        # shows badly on ice: in August the southern pack is the *larger* of
        # the two, measured at 0.88-0.93 concentration off Queen Maud Land,
        # and it would have been drawn at 0.96 degrees beside an Arctic
        # rendered at 0.16.
        #
        # A band over every longitude for the same reason the Arctic is one:
        # the ice goes all the way round, and adding a box per complaint does
        # not converge. It overlaps nothing, since nothing else reaches -50.
        'name': 'antarctic',
        'label': 'Southern Ocean',
        'wrap': True,
        'south': -78.0, 'north': -50.0,
        'minZoom': 4,
    },
]


def regions_for(product: dict) -> list[dict]:
    """The regions this product publishes.

    Per product rather than global, because a region is a promise to serve
    that box at a finer stride and not every field wants every box. Ice needs
    both poles and does not care about the Gulf of Mexico; temperature and
    salinity are the reverse, and giving them a Southern Ocean grid they were
    never asked for would add a file per field per lead for a part of the
    world their readers are not looking at.

    Defaults to all of them, so a product that says nothing behaves as every
    product did before this existed.
    """
    wanted = product.get('regions')
    return [r for r in REGIONS if wanted is None or r['name'] in wanted]

TILES = {
    'size': 20.0,
    'west': -180.0,
    'south': -80.0,
    'north': 85.0,
    # Native resolution everywhere, from the zoom where it can first be seen.
    #
    # 7 was inherited from the current tiles, where a tile carries u *and* v.
    # An SST tile is one variable at one decimal and gzips to ~26 KB, so the
    # arithmetic is different: a zoom-4 viewport touches ~18 tiles, which is
    # ~470 KB on the wire — less than the single Arctic regional grid it
    # displaces, and it buys 0.08° over the whole globe rather than 0.16°
    # over two regions. Below 4 the tile count runs away (~44 at zoom 3, all
    # 162 at zoom 2) and a degree cell is under three pixels anyway, so the
    # coarse global grid serves there.
    'minZoom': 4,
    # Politeness: a handful at a time against public research servers.
    'workers': 4,
}

PRODUCTS = [
    {
        'key': 'oisst',
        'prefix': 'sst',
        # What counts as a plausible value. Per product because these are
        # different quantities: a salinity of 40 is the Red Sea, a
        # temperature of 40 is a fill value.
        'valid': (-5.0, 45.0),
        'label': 'SST (OISST analysis)',
        # The two this field was built for; see regions_for().
        'regions': ['atlantic', 'arctic'],
        'source': 'NOAA PSL OISST v2.1',
        # NOAA PSL rather than NCEI's ERDDAP, and the reason is freshness
        # measured rather than assumed: on 2026-08-03 PSL's newest day was
        # 2026-08-01 against NCEI preliminary's 2026-07-28. Four days, on a
        # product whose whole job is to say what the ocean is doing now.
        #
        # Three incidental gains. It is THREDDS, the dialect the current
        # pipeline already speaks, so it shares this file's slab logic
        # instead of ERDDAP's. Its longitudes run 0-360 like the model
        # grids. And it avoids www.ncei.noaa.gov altogether — the host
        # advertising an AAAA record that refuses connections, which cost
        # 120 s a request against 0.9 until _ipv4_first went in.
        #
        # **The file is per year**, hence the placeholder: PSL publishes
        # sst.day.mean.2026.nc and starts a new one each January. See
        # base_url(), which falls back to last year's file when this year's
        # is missing or empty — for the first days of January it is.
        'base': ('https://psl.noaa.gov/thredds/dodsC/Datasets/'
                 'noaa.oisst.v2.highres/sst.day.mean.{year}.nc'),
        # Its own dialect: THREDDS like the Navy products, but the time axis
        # counts days from 1800 rather than hours from the run, and there is
        # no zlev dimension to index past.
        'kind': 'psl',
        # **An analysis, so it has no forecast to publish.** Stated rather
        # than inferred, and that is the point: this used to be read off the
        # transport — 'erddap' meant OISST meant analysis — which was a
        # proxy that held only by coincidence. Moving this product from
        # NCEI's ERDDAP to PSL's THREDDS broke it instantly, and the way it
        # broke is the reason to be explicit: the pipeline started asking a
        # daily analysis for forecast hours, failed on its time axis, and
        # fell back to the previous file, so the map went on showing the old
        # source while the log said the new one was fine.
        'analysis': True,
        'var': 'sst',
        # sst[time][lat][lon]: no level axis. Indexing one past the end
        # would not error — it would read the latitude axis as the level
        # and hand back a grid of the wrong shape.
        'levelled': False,
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
        'prefix': 'sst',
        'valid': (-5.0, 45.0),
        'label': 'SST (Navy ESPC forecast)',
        # The two this field was built for; see regions_for().
        'regions': ['atlantic', 'arctic'],
        'source': 'US Navy ESPC-D-V02',
        'base': ('https://tds.hycom.org/thredds/dodsC/'
                 'FMRC_ESPC-D-V02_ts3z/FMRC_ESPC-D-V02_ts3z_best.ncd'),
        'kind': 'dods',
        'var': 'water_temp',
        # water_temp[time][depth][lat][lon]; index 0 is the surface.
        'levelled': True,
        # The same grid the current layers are built on.
        'lat0': -80.0, 'dlat': 0.04, 'nlat': 4251,
        'lon0': 0.0, 'dlon': 0.08, 'nlon': 4500,
        # The Navy grid is 1/12 degree, far finer than any region stride, so
        # this is the product where a tile tier actually buys resolution.
        #
        # The region stride is (2, 4) — 0.16° — and not the (3, 6) the current
        # grids use, even though both come off the same model. The currents
        # carry u *and* v, so the same payload buys half the cells; SST is one
        # variable. Copying their stride made a 1/12° model render at 0.24°,
        # indistinguishable from OISST's native 0.25° at every zoom below the
        # tile tier — a finer model that looked no finer. Native 0.08° here
        # would be 3.4 MB for the Atlantic and 9.2 MB for the Arctic band,
        # which is what the tiles are for.
        'strides': {'global': (12, 24), 'region': (2, 4), 'tile': (1, 2)},
        'tiles': True,
    },
    {
        # Salinity off the same model and the same variable file as the Navy
        # temperature, so the two are the same ocean at the same hour.
        'key': 'navy',
        'prefix': 'sss',
        # Measured globally at the surface on 2026-08-02: p1 26.9, median
        # 34.3, p99 37.3, with 3 in river plumes and 43.5 in the Red Sea.
        # The floor is 0 rather than negative — fresh water is a real
        # reading, a negative salinity is a fill value.
        'valid': (0.0, 45.0),
        'label': 'SSS (Navy ESPC forecast)',
        # The two this field was built for; see regions_for().
        'regions': ['atlantic', 'arctic'],
        'source': 'US Navy ESPC-D-V02',
        'base': ('https://tds.hycom.org/thredds/dodsC/'
                 'FMRC_ESPC-D-V02_ts3z/FMRC_ESPC-D-V02_ts3z_best.ncd'),
        'kind': 'dods',
        'var': 'salinity',
        'levelled': True,
        'unit': 'psu',
        'lat0': -80.0, 'dlat': 0.04, 'nlat': 4251,
        'lon0': 0.0, 'dlon': 0.08, 'nlon': 4500,
        'strides': {'global': (12, 24), 'region': (2, 4), 'tile': (1, 2)},
        'tiles': True,
    },
    {
        # ---- sea ice concentration ------------------------------------
        #
        # The analysis, and it comes out of the *same dataset* the OISST
        # temperature does: PSL publishes icec.day.mean.<year>.nc beside
        # sst.day.mean.<year>.nc, on the same quarter-degree grid, the same
        # daily cadence and the same days-since-1800 axis. So every quirk
        # already solved for OISST — the per-year file, the January
        # fallback, the IPv4 preference — is solved for this too.
        'key': 'oisst',
        'prefix': 'sic',
        # **A fraction, despite what the file says.** `icec` declares
        # units "percent" and contains 0-1: valid_range is 0,1 and the
        # southern pack measures 0.88-0.93. Believing the units string would
        # put every value in the bottom hundredth of the ramp, which draws an
        # ice-free ocean rather than an error — the failure shape this
        # project keeps meeting. The range here is what makes that a
        # decision rather than an accident.
        #
        # It also guards a third missing-value convention. ERDDAP writes an
        # empty field and THREDDS writes NaN; this file writes
        # -9.96921E36, which *parses as a number*, so nothing upstream of
        # the range check would reject it.
        'valid': (0.0, 1.0),
        'label': 'Ice concentration (OISST analysis)',
        # **The ice edge**, contoured from the region grids this product
        # publishes. 15% is the convention every ice service reports extent
        # at, so the line means the same thing here as on an NSIDC chart.
        'edge': 0.15,
        # Set from the screen, not from the grid — the same lesson the
        # isobaths learned. See the measurement in CLAUDE.md.
        'edgeTolerance': 0.02,
        'source': 'NOAA PSL OISST v2.1',
        'base': ('https://psl.noaa.gov/thredds/dodsC/Datasets/'
                 'noaa.oisst.v2.highres/icec.day.mean.{year}.nc'),
        'kind': 'psl',
        'analysis': True,
        'var': 'icec',
        'levelled': False,
        'unit': 'fraction',
        'lat0': -89.875, 'dlat': 0.25, 'nlat': 720,
        'lon0': 0.125, 'dlon': 0.25, 'nlon': 1440,
        'regions': ['arctic', 'antarctic'],
        # Native in a region, as OISST is, so no tile tier could add
        # anything — see the note on the temperature entry. 0.25 deg is the
        # ceiling for this product: it is what passive microwave resolves,
        # and the forecast beside it is the finer of the two by design.
        'strides': {'global': (4, 4), 'region': (1, 1)},
        'tiles': False,
        'edgeStride': (1, 1),
    },
    {
        # The forecast, off ESPC's own ice aggregation — a different file
        # from ts3z but the same model, the same run and the same grid, so
        # the ice and the water below it are one ocean at one hour, exactly
        # as temperature and salinity are.
        #
        # It publishes hourly where ts3z is 3-hourly. Nothing here needs to
        # know: lead_steps picks a step by its offset from its own run, so a
        # finer axis simply means the offset lands exactly.
        'key': 'navy',
        'prefix': 'sic',
        # sea_ice_area_fraction, units "1" — genuinely a fraction here, and
        # the same scale as the analysis above, so the two are comparable.
        'valid': (0.0, 1.0),
        'label': 'Ice concentration (Navy ESPC forecast)',
        # **The ice edge**, contoured from the region grids this product
        # publishes. 15% is the convention every ice service reports extent
        # at, so the line means the same thing here as on an NSIDC chart.
        'edge': 0.15,
        # Set from the screen, not from the grid — the same lesson the
        # isobaths learned. See the measurement in CLAUDE.md.
        'edgeTolerance': 0.02,
        'source': 'US Navy ESPC-D-V02',
        'base': ('https://tds.hycom.org/thredds/dodsC/'
                 'FMRC_ESPC-D-V02_ice/FMRC_ESPC-D-V02_ice_best.ncd'),
        'kind': 'dods',
        'var': 'sic',
        # sic[time][lat][lon] — the ice aggregation carries no depth axis,
        # unlike ts3z on the same host. This is why `levelled` is stated.
        'levelled': False,
        'unit': 'fraction',
        'lat0': -80.0, 'dlat': 0.04, 'nlat': 4251,
        'lon0': 0.0, 'dlon': 0.08, 'nlon': 4500,
        'regions': ['arctic', 'antarctic'],
        # Region grids are the **fallback tier only**, exactly as the Navy
        # temperature's are: the tiles win whenever the index loads. Left at
        # 0.16 deg because that is all a fallback has to be.
        'strides': {'global': (12, 24), 'region': (2, 4), 'tile': (1, 2)},
        # **Tiles after all, and the first argument against them was wrong.**
        # It counted files rather than resolution: "150 of 162 tiles would be
        # open water" is true and beside the point, since an all-zero tile
        # gzips to nothing. What it cost was the whole reason to prefer this
        # product — ESPC is 0.08 x 0.04 deg, which at 80N is 1.5 x 4.4 km,
        # finer than any passive-microwave analysis and comparable to AMSR2.
        # Serving it at the 0.16 deg region stride threw away 16 cells in
        # every 1, and rendered a 1/12 deg model at a resolution
        # indistinguishable from the 25 km analysis beside it. The Navy
        # temperature entry above has the same note about the same mistake.
        'tiles': True,
        # The edge is contoured at the tile lattice's own spacing rather
        # than at the fallback region stride, so the line and the raster a
        # reader actually sees are the same resolution.
        'edgeStride': (1, 2),
    },
]


def base_url(product: dict) -> str:
    """The dataset URL, with the year filled in for products published yearly.

    PSL starts a new file each January, so on the 1st the current year's file
    may not exist yet or may hold nothing usable. Rather than let one day a
    year fail, fall back to the previous year — its last days are the ones
    anybody wants at that point anyway.
    """
    base = product['base']
    if '{year}' not in base:
        return base
    year = datetime.now(timezone.utc).year
    this_year = base.replace('{year}', str(year))
    try:
        if time_axis(this_year) > 0:
            return this_year
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError):
        pass
    print(f'  {year} file not usable yet — falling back to {year - 1}', file=sys.stderr)
    return base.replace('{year}', str(year - 1))


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


def rows(body: str, width: int, low: float = -5.0, high: float = 45.0) -> list[list[float | None]]:
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
            row.append(None if math.isnan(v) or v < low or v > high else round(v, 1))
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


def newest(product: dict) -> list[tuple[str, str, str]]:
    """Candidate time steps: (index, valid time, model run), nearest first.

    The run matters as much as the valid time. A forecast step an hour from
    now is worthless if it came from a run three days old, and without the
    run on the file there is no way to tell the two apart — which is exactly
    how the current grids sat two days stale while looking current.

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
        body = get(encode(f'{base_url(product)}.asc?time[last]'), timeout=90)
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
        # An analysis has no model run; its date is its date.
        return [
            ('last', stamp.strftime('%Y-%m-%dT%H:%M:%SZ'), ''),
            ('last-1', (stamp - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'), ''),
        ]

    das = get(f'{base_url(product)}.das', timeout=60)
    unit = 'days' if product['kind'] == 'psl' else 'hours'
    marker = f'{unit} since '
    at = das.find(marker, das.find('time {'))
    epoch = datetime.strptime(
        das[at + len(marker):at + len(marker) + 19].strip(), '%Y-%m-%d %H:%M:%S'
    ).replace(tzinfo=timezone.utc)
    # PSL counts days from 1800; the Navy products count hours from the run.
    # Read the unit rather than assume it: getting this wrong would place the
    # field centuries away and still parse cleanly.
    scale = 24.0 if unit == 'days' else 1.0

    last = time_axis(base_url(product)) - 1
    body = get(encode(f'{base_url(product)}.ascii?time[0:1:{last}]'), timeout=90)
    tail = [line for line in body.splitlines() if line.strip()][-1]
    hours = [float(t) * scale for t in tail.split(',') if t.strip()]
    if not hours:
        raise RuntimeError('no time axis')
    # Which daily run each step came from. Optional: a dataset without a
    # time_run axis still works, it just cannot say.
    runs: list[float] = []
    try:
        body = get(encode(f'{base_url(product)}.ascii?time_run[0:1:{last}]'), timeout=90)
        tail = [line for line in body.splitlines() if line.strip()][-1]
        runs = [float(t) for t in tail.split(',') if t.strip()]
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        pass

    def stamp(h: float) -> str:
        return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')

    target = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600
    order = sorted(range(len(hours)), key=lambda i: abs(hours[i] - target))
    return [
        (str(i), stamp(hours[i]), stamp(runs[i]) if i < len(runs) else '')
        for i in order[:8]
    ]


def fetch(product: dict, when: str, y0: int, y1: int, x0: int, x1: int,
          stride_lat: int, stride_lon: int) -> list[list[float | None]]:
    """One rectangle of the field, at one stride."""
    var = product['var']
    span = f'[{y0}:{stride_lat}:{y1}][{x0}:{stride_lon}:{x1}]'
    # **Whether there is a level axis to index past is the dataset's
    # property, not the transport's**, and conflating the two is a mistake
    # this file has already made once — see the note on `analysis`. It was
    # made again here: the depth index was attached to "not psl", which held
    # only while every DODS product was a 3-D water column. ESPC's ice
    # aggregation is on the same host, in the same dialect, off the same
    # model, and is sic[time][lat][lon] with no depth at all — so every
    # request for it was a 400, and the pipeline reported the product
    # unavailable rather than mis-shaped.
    level = '[0]' if product['levelled'] else ''
    suffix = '.asc' if product['kind'] == 'erddap' else '.ascii'
    url = f'{base_url(product)}{suffix}?{var}[{when}]{level}{span}'
    width = (x1 - x0) // stride_lon + 1
    low, high = product.get('valid', (-5.0, 45.0))
    grid = rows(get(encode(url)), width, low, high)
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
          stride: tuple[int, int], wrap: bool, extra: dict | None = None,
          run: str = '', quiet: bool = False) -> dict:
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
        # Only a forecast has one. Written when present so the map can say how
        # fresh the field is rather than leaving a reader to assume.
        **({'modelRun': run} if run else {}),
        'source': product['source'],
        'units': product.get('unit', 'degC'),
        **(extra or {}),
    }
    payload = {'header': header, 'data': [v for row in reversed(grid) for v in row]}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')

    wet = sum(1 for v in payload['data'] if v is not None)
    spans = nx * dx
    extent = 'wraps' if spans >= 360 else f'{spans:.0f} deg of longitude'
    # The edge's scratch grids are fetched, contoured and deleted; announcing
    # them would put files in the log that no reader can ever ask for.
    if not quiet:
        print(f'  {out.name}: {nx}x{ny} at {dx:g}x{dy:g} deg, {extent}, '
              f'{wet} wet points, {out.stat().st_size / 1024:.0f} KB')
    return header


def tile_dir_name(product: dict, lead: int = 0) -> str:
    """tiles-sst-navy, tiles-sst-navy-f24h. One directory per product and
    lead, so a frame's tileIndex cannot lead the map into another hour's.

    The base lead keeps the bare directory for the same reason its grid keeps
    the bare filename — see `at_lead`.
    """
    stem = f"tiles-{product['prefix']}-{product['key']}"
    return f'{stem}-f{lead}h' if lead != min(leads_wanted()) else stem


def build_tile(product: dict, when: str, valid: str, run: str,
               south: float, west: float, lead: int = 0) -> tuple[str | None, str]:
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
    out = MAP_DIR / tile_dir_name(product, lead) / f'{key}.json'

    last = None
    backoff = [0, 3, 8, 20]
    for wait in backoff:
        if wait:
            time.sleep(wait)
        try:
            header = build(product, when, valid, out, south, north, west, east,
                           product['strides']['tile'], wrap=False, run=run)
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


def build_tiles(product: dict, when: str, valid: str, run: str = '', lead: int = 0) -> None:
    from concurrent.futures import ThreadPoolExecutor

    corners = [
        (south, west)
        for south in frange(TILES['south'], TILES['north'], TILES['size'])
        for west in frange(TILES['west'], 180.0, TILES['size'])
    ]
    ahead = f' +{lead}h' if lead else ''
    print(f"  {len(corners)} tiles, {product['label']}{ahead}")
    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        results = list(pool.map(lambda c: build_tile(product, when, valid, run, *c, lead=lead), corners))

    available = sorted(k for k, _ in results if k)
    failed = sum(1 for _, why in results if why == 'failed')
    empty = sum(1 for _, why in results if why == 'empty')
    tile_dir = MAP_DIR / tile_dir_name(product, lead)
    tile_dir.mkdir(parents=True, exist_ok=True)
    (tile_dir / 'index.json').write_text(json.dumps({
        'size': TILES['size'], 'west': TILES['west'],
        'south': TILES['south'], 'north': TILES['north'],
        'minZoom': TILES['minZoom'],
        'deg': round(min(product['dlon'] * product['strides']['tile'][0],
                         product['dlat'] * product['strides']['tile'][1]), 4),
        'refTime': valid, 'lead': lead,
        **({'modelRun': run} if run else {}),
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


def usable_step(product: dict) -> tuple[str, str, str]:
    """The first candidate step that actually serves data.

    Probed with a deliberately tiny read rather than the real one: a step
    that is broken fails on any read, so a few cells are enough to tell, and
    it costs a fraction of a second against a minute for the global grid.

    The probe indexes off the middle of *this product's* grid. Fixed indices
    do not work: 2000 sits inside the Navy model's 4251 latitudes and outside
    OISST's 720, so a hardcoded probe rejected every OISST step as broken
    when the data was fine.
    """
    y = product['nlat'] // 2
    x = product['nlon'] // 2
    candidates = newest(product)
    for when, valid, run in candidates:
        try:
            fetch(product, when, y, y + 4, x, x + 4, 2, 2)
            return when, valid, run
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
            print(f'  step {when} ({valid}) unusable: {exc}', file=sys.stderr)
    raise RuntimeError(f'no usable time step in {len(candidates)} candidates')


# How far ahead to publish, as **T+N from the model run** — the forecasting
# convention, not hours from the reader's clock. One frame by default.
#
# T+36 rather than T+0, and the reason is what ESPC actually does. It runs
# daily at 12Z and the aggregation ingests it 24-33 hours later, so its T+0
# is a field for yesterday lunchtime: measured on 2026-08-03, the newest run
# was 08-02 12Z and its analysis hour was already 33 hours old. Asking that
# same run for T+36 gets 08-04 00Z — a few hours ahead of now — from the
# freshest run there is. The lateness that makes T+0 stale is exactly what
# brings T+36 to the present.
#
# It also removes a trap the now-anchored version had. Anchored to the clock,
# a longer lead reached into an *older* run, because the newest was only
# ingested out to its own T+36: lead 0 came from 08-02 while lead 36 fell
# back to 08-01. Stepping forward in time stepped backward in run freshness.
#
# The consequence to keep in mind: the valid time now moves with the ingest
# delay rather than with the clock. If a run ever lands promptly, this same
# T+36 sits a day and a half out instead of a few hours. That is the
# convention behaving as asked — and it is why the map labels every frame
# with its valid time in UTC and not with the lead.
#
# Override with --leads=0,36 or --leads=0,12,24,36,48; the lowest lead takes
# the bare filenames. Every frame the rest of this file can build is still
# one flag away, and nothing downstream needed changing to turn them off.
#
# The extra frames were measured and then dropped, and both halves matter.
# Over 48 hours the median Navy SST change is 0.1 degC on a ramp spanning 20
# and the median salinity change is 0.00 psu, so at the tier a reader
# actually sees, most of the ocean did not move. Serving them at full
# resolution to fix that doubled the tile sets — the published site went to
# ~700 MB — which is a great deal of storage for a difference that is mostly
# below one step of an 8-bit channel.
#
# So the scaffolding stays and the extra frames go, which leaves room for
# products that will show a reader something new. Set LEADS back and it all
# returns: the map builds its control from whatever the data advertises, and
# with one frame it advertises nothing and the control does not appear.
LEADS = [36]


def lead_steps(product: dict, leads: list[int]) -> list[tuple[int, str, str, str]]:
    """(lead, step token, valid time, model run) for each lead, as **T+N from
    the model run** — see the long note on `pick_leads` in fetch-currents.py
    for why that is anchored to the run rather than to the clock.

    Keeps the per-step probing that `usable_step` exists for: HYCOM fails per
    member file rather than as a whole. The walk goes **backwards through
    runs** rather than outwards through hours, though, since a neighbouring
    hour is a different lead: if the newest run cannot serve its T+36, the
    honest substitute is the run before it at *its* T+36, not this run at
    T+33 relabelled.

    An analysis has no run and no leads at all; that case never reaches here.
    """
    das = get(f'{base_url(product)}.das', timeout=60)
    marker = 'hours since '
    at = das.find(marker, das.find('time {'))
    epoch = datetime.strptime(
        das[at + len(marker):at + len(marker) + 19], '%Y-%m-%d %H:%M:%S'
    ).replace(tzinfo=timezone.utc)

    last = time_axis(base_url(product)) - 1
    body = get(encode(f'{base_url(product)}.ascii?time[0:1:{last}]'), timeout=90)
    hours = [float(t) for t in [l for l in body.splitlines() if l.strip()][-1].split(',') if t.strip()]
    runs: list[float] = []
    try:
        body = get(encode(f'{base_url(product)}.ascii?time_run[0:1:{last}]'), timeout=90)
        runs = [float(t) for t in [l for l in body.splitlines() if l.strip()][-1].split(',') if t.strip()]
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        pass

    def stamp(h: float) -> str:
        return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')

    now = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600
    y, x = product['nlat'] // 2, product['nlon'] // 2
    out = []
    for lead in leads:
        # Exactly this far past its own run, newest run first. Exact rather
        # than nearest: T+36 is a step the model either published or did not.
        order = sorted(
            (i for i in range(min(len(hours), len(runs)))
             if abs((hours[i] - runs[i]) - lead) < 0.5),
            key=lambda i: runs[i], reverse=True,
        )
        for i in order[:4]:
            try:
                fetch(product, str(i), y, y + 4, x, x + 4, 2, 2)
            except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
                print(f'  T+{lead} step {i} unusable: {exc}', file=sys.stderr)
                continue
            print(f'  T+{lead}: valid {stamp(hours[i])} from the '
                  f'{stamp(runs[i])} run ({now - runs[i]:.0f} h old)')
            out.append((lead, str(i), stamp(hours[i]), stamp(runs[i])))
            break
        else:
            print(f'  ! no run carries T+{lead} usably — skipped', file=sys.stderr)
    if not out:
        raise RuntimeError('no usable time step at any lead')
    return out


def leads_wanted() -> list[int]:
    """LEADS, or whatever --leads=0,12,24 asked for. Mirrors fetch-currents."""
    for arg in sys.argv[1:]:
        if arg.startswith('--leads='):
            return sorted({int(v) for v in arg.split('=', 1)[1].split(',') if v.strip()})
    return LEADS


def build_product(product: dict, tiles_only: bool) -> None:
    # An analysis has no run and no leads: its own newest day is the answer,
    # so `usable_step` is the whole story for it. A forecast resolves its
    # frames from the run instead, and asking for the step nearest *now*
    # would cost a probe and print an hour nothing is published at — which
    # is exactly what it did for a while, logging "valid 21:00Z" above three
    # files all valid at 00:00Z.
    if product.get('analysis'):
        when, valid, run = usable_step(product)
        print(f"{product['label']} — valid {valid}")
        frames = [(0, when, valid, run)]
    else:
        print(f"{product['label']}:")
        frames = lead_steps(product, leads_wanted())

    if tiles_only:
        if not product.get('tiles'):
            print('  no tile tier — the region grid is already native resolution')
            return
        for lead, step, lead_valid, lead_run in frames:
            build_tiles(product, step, lead_valid, lead_run, lead=lead)
        return

    name = f"{product['prefix']}-{product['key']}"

    # An analysis has no lead — its own date is the answer — so its single
    # file keeps the bare name whatever the forecast leads are set to. Read
    # from LEADS instead, OISST would be published as sst-oisst-f0h.json the
    # moment the base lead stopped being 0, and the map would find nothing
    # at the name it asks for.
    base = 0 if product.get('analysis') else min(leads_wanted())

    def at_lead(stem: str, lead: int) -> str:
        """sst-navy-atlantic -> sst-navy-atlantic-f24h, bar the base lead.

        The lowest lead being built keeps the bare name, so something is
        always published where an older build of the map looks — see the
        same note in fetch-currents.py.
        """
        return f'{stem}-f{lead}h' if lead != base else stem

    def region_links(lead: int) -> list[dict]:
        return [
            {
                'url': '/map/' + at_lead(name + '-' + region['name'], lead) + '.json',
                'label': region['label'],
                'west': region.get('west', -180.0), 'east': region.get('east', 180.0),
                'south': region['south'], 'north': region['north'],
                'minZoom': region['minZoom'],
                'deg': round(min(product['dlon'] * product['strides']['region'][0],
                                 product['dlat'] * product['strides']['region'][1]), 4),
            }
            for region in regions_for(product)
        ]

    # `frames` was resolved above: one step for an analysis, which is why the
    # lead control offers nothing when OISST is the field showing — the
    # absence is in the data, not a special case in the map.

    for lead, step, lead_valid, lead_run in frames:
        extra: dict = {'details': region_links(lead)}
        # Only advertised where a tile tier exists; the map follows this
        # link, so a product without one must not offer it. Every lead has
        # its own set now — one forecast hour at the model's own resolution
        # beats four at a resolution that hides what changed.
        if product.get('tiles'):
            extra['tileIndex'] = f'/map/{tile_dir_name(product, lead)}/index.json'
        if lead == base:
            if len(frames) > 1:
                extra['forecast'] = [
                    {'lead': l, 'valid': v, 'url': f'/map/{at_lead(name, l)}.json'}
                    for l, _, v, _ in frames
                ]
        # The global file advertises the finer tiers, so the map learns them
        # from the data rather than repeating the bounds in the component.
        build(product, step, lead_valid, MAP_DIR / f'{at_lead(name, lead)}.json',
              south=-80.0, north=85.0, west=-180.0, east=180.0,
              stride=product['strides']['global'], wrap=True, run=lead_run,
              extra={**extra, 'lead': lead})

        for region in regions_for(product):
            build(product, step, lead_valid,
                  MAP_DIR / (at_lead(name + '-' + region['name'], lead) + '.json'),
                  south=region['south'], north=region['north'],
                  west=region.get('west', -180.0), east=region.get('east', 180.0),
                  stride=product['strides']['region'], wrap=region['wrap'],
                  run=lead_run, extra={'lead': lead})

        if product.get('edge'):
            build_edge(product, name, at_lead, lead, step, lead_valid, lead_run)


def build_edge(product: dict, name: str, at_lead, lead: int,
               step: str, valid: str, run: str) -> None:
    """The ice edge, contoured from the region grids just published.

    **Cut from its own grid at `edgeStride`, not from the published region
    file.** Reading the published one back was the first design and it tied
    the line's resolution to the coarsest tier: the regions are a *fallback*
    for this product now, at 0.16 degrees, while what a reader actually sees
    is the 0.08-degree tile set. The edge was therefore drawn four times
    coarser than the raster it bounds, which is the blockiness that got
    reported.

    Contouring costs almost nothing in output — a line's byte count is set by
    its own length, not by the grid it came from — so the fine grid is
    fetched, contoured and thrown away. Same step, same valid time and the
    same threshold as the field, so the two still cannot disagree about
    *where* the ice is; they only differ in how finely each is sampled, and
    the edge is now the finer of the two.

    The polar bands and not the globe, because ice is only there, which is
    the one thing about this field that makes a native-resolution contour
    affordable at all.
    """
    threshold = product['edge']
    stride = product.get('edgeStride', product['strides']['region'])
    paths = []
    for region in regions_for(product):
        scratch = MAP_DIR / f'.edge-{name}-{region["name"]}.tmp.json'
        try:
            build(product, step, valid, scratch,
                  south=region['south'], north=region['north'],
                  west=region.get('west', -180.0), east=region.get('east', 180.0),
                  stride=stride, wrap=region['wrap'], run=run, quiet=True)
            grid = json.loads(scratch.read_text())
        finally:
            scratch.unlink(missing_ok=True)

        head = grid['header']
        nx, ny = head['nx'], head['ny']
        flat = grid['data']
        rows_of = [flat[y * nx:(y + 1) * nx] for y in range(ny)]
        # `la1` is the **north** edge and the rows run southward — the GRIB
        # convention these files follow — so the latitude step is negative
        # walking down the array. Passing +dy would contour a grid mirrored
        # about its own middle latitude: the same shape, in the wrong
        # hemisphere, which over a polar band is a line that looks entirely
        # plausible until you notice it is upside down.
        for line in contour(
            rows_of, threshold,
            lat0=head['la1'], dlat=-head['dy'],
            lon0=head['lo1'], dlon=head['dx'],
            tolerance=product.get('edgeTolerance', 0.0),
            # None is "no ice" on both products: the analysis masks open
            # water as missing and the forecast writes a real 0 there. See
            # the note in contour.segments.
            absent=0.0,
        ):
            paths.append([[round(x, 4), round(y, 4)] for x, y in line])

    out = {
        'type': 'FeatureCollection',
        'header': {
            'product': product['label'], 'source': product['source'],
            'valid': valid, 'threshold': threshold, 'lead': lead,
            **({'modelRun': run} if run else {}),
        },
        'features': [
            {'type': 'Feature', 'properties': {'c': threshold},
             'geometry': {'type': 'LineString', 'coordinates': line}}
            for line in paths
        ],
    }
    dest = MAP_DIR / (at_lead(name + '-edge', lead) + '.json')
    dest.write_text(json.dumps(out, separators=(',', ':')))
    vertices = sum(len(line) for line in paths)
    print(f'  {dest.name}: {len(paths)} lines, {vertices} vertices, '
          f'{dest.stat().st_size // 1024} KB')


def main() -> int:
    tiles_only = '--tiles' in sys.argv
    only = next((a.split('=')[1] for a in sys.argv if a.startswith('--only=')), None)

    failed = []
    for product in PRODUCTS:
        if only and f"{product['prefix']}-{product['key']}" != only and product['key'] != only:
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
