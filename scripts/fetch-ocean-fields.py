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
import threading
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
# The northern edge every grid must reach.
#
# **Stated once, because it used to be three different numbers by accident.**
# Each grid ended wherever its own stride happened to land walking up from
# `lat0`, so the same request for "north 85" produced 84.16 from the 0.96 deg
# global grid, 84.88 from the 0.16 deg Arctic one and 85.125 from OISST's
# quarter degree — and between those latitudes one product was drawn and
# another was not. Reported as gappy bands near the pole, and that is exactly
# what they were: not missing data but three different edges stacked.
#
# 85 because Web Mercator cannot draw past about 85.05 anyway. Grids round
# *outward* to it (see `build`), so each one covers at least this far and
# usually a little past — which is not waste: the map's bilinear sampling
# degenerates on the last row, so a row beyond the visible limit is what lets
# the topmost visible row interpolate properly.
MAX_LAT = 85.0

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
        'south': 50.0, 'north': MAX_LAT,
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
    'north': MAX_LAT,
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
        # **Native 1/4 degree everywhere**, so neither a region nor a tile
        # tier can add anything: both exist to reach a product's native
        # resolution over a box, and this is already at it over the globe.
        #
        # It was 1 degree globally with two native regions, which meant a
        # reader anywhere outside the Atlantic and the Arctic got 1 degree
        # at every zoom — the same defect the air temperature had, and it
        # became conspicuous once the Region menu started sending people to
        # the Philippines and the Chukchi Sea. Measured: the coarse pair
        # cost 41 KB gzipped and native costs about half a megabyte, paid
        # only by a reader who switches the layer on.
        'strides': {'global': (1, 1)},
        'regions': [],
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
        # Native everywhere, like the temperature off the same dataset —
        # see the note there. 0.25 deg is the ceiling for this product: it
        # is what passive microwave resolves, and the forecast beside it is
        # the finer of the two by design.
        'regions': [],
        'strides': {'global': (1, 1)},
        'tiles': False,
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
    },
    {
        # Sea ice thickness, from the same ESPC ice aggregation as the
        # concentration above — same grid, same run, same step, so the two
        # are one ice field seen two ways.
        #
        # **This replaced the ice edge**, which was the 15% concentration
        # contour. That line earned its place only while the concentration
        # raster was coarse; once that reached native 0.08 degrees the edge
        # was drawing the boundary of a field already on screen, and it could
        # never be finer than the grid it was cut from. Thickness is a
        # quantity the concentration genuinely does not carry: 90% cover of
        # 0.3 m new ice and 90% of 2 m multi-year ice are the same picture
        # and very different ocean.
        'key': 'navy',
        'prefix': 'sit',
        # Metres. Sampled at 80N on 2026-08-04: 0.06 to 1.86, and ridged
        # multi-year ice runs past 5. The ceiling is generous rather than
        # tight because a fill value here would be enormous rather than
        # merely large; the floor is 0, since open water is a real reading
        # and a negative thickness is not.
        'valid': (0.0, 15.0),
        'label': 'Ice thickness (Navy ESPC forecast)',
        'source': 'US Navy ESPC-D-V02',
        'base': ('https://tds.hycom.org/thredds/dodsC/'
                 'FMRC_ESPC-D-V02_ice/FMRC_ESPC-D-V02_ice_best.ncd'),
        'kind': 'dods',
        'var': 'sih',
        'levelled': False,
        'unit': 'm',
        'lat0': -80.0, 'dlat': 0.04, 'nlat': 4251,
        'lon0': 0.0, 'dlon': 0.08, 'nlon': 4500,
        'regions': ['arctic', 'antarctic'],
        'strides': {'global': (12, 24), 'region': (2, 4), 'tile': (1, 2)},
        'tiles': True,
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


# How many cells to ask for in one request.
#
# **Measured, after a native global grid stopped fitting in one.** OISST at
# its own 0.25 degrees is 1440 x 661, and the ice concentration off that
# grid failed every time with `IncompleteRead` at about 11 MB — three
# attempts, three truncations at 10.9, 11.2 and 11.4 MB, so not transient.
#
# The temperature off the *same* grid succeeded, which is the part worth
# knowing: it is a byte limit rather than a cell one, and ice writes its
# fill value as the twelve characters `-9.96921E+36` where a sea-surface
# temperature is four. Same number of cells, three times the response. So
# the temperature was already near whatever the limit is and got away with
# it — which would have shown up later as an intermittent CI failure rather
# than an honest one.
#
# 300k cells keeps the worst case (13 characters a cell) near 4 MB. The
# Navy regional grids are split by this too even though they worked, since
# a limit nobody is near is not a limit anybody has tested.
CELLS_PER_REQUEST = 300_000


def bands_for(y0: int, y1: int, stride_lat: int, width: int) -> list[tuple[int, int]]:
    """Latitude ranges to ask for, so no one response is too large.

    Each band starts on the stride lattice `y0` established — the same care
    `slabs_for` takes across longitude, and for the same reason: a band that
    resumed anywhere else would shift its rows against the ones above it and
    the grid would stop being regular.
    """
    rows_total = (y1 - y0) // stride_lat + 1
    per = max(1, CELLS_PER_REQUEST // max(1, width))
    if rows_total <= per:
        return [(y0, y1)]
    out = []
    for start in range(0, rows_total, per):
        a = y0 + start * stride_lat
        b = min(y1, y0 + (start + per - 1) * stride_lat)
        out.append((a, b))
    return out


def build(product: dict, when: str, valid: str, out: pathlib.Path,
          south: float, north: float, west: float, east: float,
          stride: tuple[int, int], wrap: bool, extra: dict | None = None,
          run: str = '', quiet: bool = False) -> dict:
    """Fetch one rectangle at one stride and write it as a scalar grid."""
    stride_lon, stride_lat = stride
    y0 = axis_index(south, product['lat0'], product['dlat'], product['nlat'])
    y1 = axis_index(north, product['lat0'], product['dlat'], product['nlat'])
# **Round the top outward to the stride, or the grid stops short of what
    # was asked for.** `fetch` walks y0:stride:y1, so the last row sampled is
    # y0 + floor((y1-y0)/stride)*stride — up to stride-1 cells *below* y1,
    # which on the 0.96 deg global grid is 0.92 deg of latitude silently
    # dropped. Three grids each dropping a different amount is what put bands
    # of one-product-only coverage under the pole. Extending instead of
    # truncating costs one row and guarantees every grid reaches MAX_LAT.
    span = y1 - y0
    if span % stride_lat:
        y1 = min(y0 + (span // stride_lat + 1) * stride_lat, product['nlat'] - 1)
    slabs = slabs_for(product, west, east, stride_lon, wrap)

    # Longitude slabs across, latitude bands down. The slabs are joined
    # row by row and the bands stacked, so a grid too large for one response
    # still comes back as one regular lattice.
    width = sum((b - a) // stride_lon + 1 for a, b in slabs)
    grid: list[list[float | None]] = []
    for ya, yb in bands_for(y0, y1, stride_lat, width):
        parts = [fetch(product, when, ya, yb, a, b, stride_lat, stride_lon)
                 for a, b in slabs]
        grid += parts[0] if len(parts) == 1 else [w + e for w, e in zip(*parts)]

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
    # Kept for callers that build a grid nobody will ask for by name. The
    # ice edge used one; nothing does today.
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
    return f'{stem}-f{lead}h' if lead != base_lead(product) else stem


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

    # **Stop at the first confirmed failure.** A confirmed failure has already
    # had its four spaced attempts, so it is not transient — and since any
    # failure abandons the index below, working through the rest only to
    # abandon it anyway is pure waiting. Measured on the arithmetic: 162 tiles
    # at 31 s of backoff each over four workers is about 21 minutes per
    # product to reach a conclusion known after the first tile, and there are
    # six products on an hourly build.
    stop = threading.Event()

    def one(corner: tuple[float, float]) -> tuple[str | None, str]:
        if stop.is_set():
            return None, 'skipped'
        got = build_tile(product, when, valid, run, *corner, lead=lead)
        if got[1] == 'failed':
            stop.set()
        return got

    with ThreadPoolExecutor(max_workers=TILES['workers']) as pool:
        results = list(pool.map(one, corners))

    available = sorted(k for k, _ in results if k)
    failed = sum(1 for _, why in results if why == 'failed')
    empty = sum(1 for _, why in results if why == 'empty')
    skipped = sum(1 for _, why in results if why == 'skipped')

    if failed:
        # **Raise before writing anything**, and that ordering is the whole
        # point. This used to write the index and raise afterwards, so the
        # short list reached disk either way — and `main` only keeps the
        # previous data when *every* product fails, so one product's tile
        # failure published a short index while the build reported success.
        # Measured by injecting a total tile failure: the index went to disk
        # with zero entries.
        #
        # Leaving it unwritten is what makes the failure legible. A restored
        # cache keeps the previous complete index; with no cache the map gets
        # a 404 and falls back to the regional grid — the same picture as a
        # short index, but arrived at by something a person can see, rather
        # than by a file that looks correct and is not.
        print(f'  ! {failed} of {len(corners)} tiles failed'
              + (f', {skipped} not attempted' if skipped else '')
              + ' — leaving the index alone rather than publishing a short one',
              file=sys.stderr)
        raise RuntimeError(f'{failed} of {len(corners)} tiles failed')

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
    print(f'  wrote {len(available)} tiles ({empty} all land), '
          f'{total / 1024 / 1024:.1f} MB')


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


# Which step to publish, chosen by **valid time** rather than by a fixed
# offset from the model run. The full argument is on REFRESH_HOURS in
# fetch-currents.py; the short form is that a lead is anchored to the run,
# so where it lands relative to the reader is the run's lateness and nothing
# else — measured on 2026-08-05, a 57-hour-old run put T+36 nineteen hours
# *behind* the present while that same run carried a step valid now.
#
# **These two must agree, and it is not a style preference.** The currents
# and the Navy fields come off one model, and the map credits a source once
# per run and valid time: two pipelines landing on different steps split
# that into two attribution lines describing one model, and put a
# temperature from one hour under a current from another. Both files
# therefore snap the same way, `check:docs` compares the two constants, and
# `test-schema.mjs` compares the published headers.
REFRESH_HOURS = 6

# The window the currents publish, mirrored. `FRAMES` in fetch-currents.py
# takes this many consecutive steps from the anchor and publishes all of
# them; this file resolves the same window and publishes **only the last
# step of it**.
#
# **One frame, and the difference from the currents is measured.** Over 48
# hours the median Navy SST change is 0.1 degC on a ramp spanning 20 and the
# median salinity change is 0.00 psu, so at the tier a reader sees, most of
# the ocean did not move. A second frame here costs about 86 MB of tiles to
# show nobody anything. The currents earn theirs because ESPC carries a
# semidiurnal tide — see the tide note in CLAUDE.md — so a single sample of
# a velocity field is one arbitrary phase of it.
#
# **The last step rather than the first, and that is not arbitrary.** The
# map opens each layer on whichever published frame is nearest the reader's
# clock, so across a six-hour window it shows the currents' *later* frame
# for four and a half of those hours. A field pinned to the anchor would
# therefore disagree with the current beside it most of the time — and the
# credit line names a source, a run and an hour but deliberately not a
# quantity, so two ESPC lines differing only in the hour cannot be told
# apart. Publishing the last step inverts that: the two agree for the same
# four and a half hours, and the field is at worst three hours from the
# reader instead of six.
WINDOW = 2

# Fixed leads instead, as **T+N from the model run** — the old behaviour,
# and still what `--leads=0,12,24,36,48` selects. `None` means choose by
# valid time. Mirrors fetch-currents.py.
LEADS: list[int] | None = None


def time_axes(product: dict) -> tuple[datetime, list[float], list[float], float]:
    """This product's epoch, valid times, run times, and now.

    Read once and handed to whichever selection is in force. `time_run` is
    optional: an aggregation without it leaves the list empty and both
    selections then find no candidates, which is the honest answer for a
    file that cannot say which run a step came from.
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

    now = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600
    return epoch, hours, runs, now


def hour_stamp(epoch: datetime, h: float) -> str:
    return (epoch + timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%SZ')


def serves(product: dict, index: int) -> bool:
    """Whether this step answers a read at all.

    HYCOM fails per member file rather than as a whole, so a step is a thing
    to test. Probed off the middle of *this product's* grid: fixed indices do
    not work, since 2000 sits inside the Navy model's 4251 latitudes and
    outside OISST's 720.
    """
    y, x = product['nlat'] // 2, product['nlon'] // 2
    try:
        fetch(product, str(index), y, y + 4, x, x + 4, 2, 2)
        return True
    except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as exc:
        print(f'  step {index} unusable: {exc}', file=sys.stderr)
        return False


def step_offsets(count: int) -> list[float]:
    """Hours past the anchor, spread evenly across the window. Mirrors
    fetch-currents.py — see the long note there for why this is stated in
    hours rather than as a number of consecutive steps.

    That distinction was a shipped bug and this file is where it bit: the
    ESPC ice aggregation carries **hourly** steps where `uv3z` and `ts3z`
    carry 3-hourly ones, off the same run. Counting steps put the ice an
    hour past the anchor while everything else was three.
    """
    return [k * REFRESH_HOURS / count for k in range(count)]


def currents_hours() -> list[datetime]:
    """The valid times `fetch-currents.py` just published, newest last.

    **The fields follow the currents rather than recomputing the same
    answer**, and that is a correction to a design that broke a publish.

    Both used to work the offset out independently — the currents took the
    step at the anchor and the one three hours on, the fields took the
    later of the two. That holds only while the newest run reaches three
    hours past the anchor, and for the few hours after a run lands it does
    not: measured 2026-08-06 03:11, the 08-04 run was ingested only to
    T+36, so the currents published a single frame at 00Z while the fields
    went to 03Z off the same run. Same run, different hour — which
    `test-schema.mjs` correctly calls a code bug, because it is one, and it
    blocked the publish.

    Reading what the currents published makes the invariant *structural*
    rather than hoped-for. The workflow already runs them first, so the file
    is there; if it is not — a first run, or the currents failing — the
    caller falls back to computing the offset, which is the old behaviour
    and no worse than it was.

    The last frame rather than the first, for the reason WINDOW records: the
    map opens each layer on the frame nearest the reader, which across a
    window is the currents' later one more often than not.
    """
    p = MAP_DIR / 'currents.json'
    if not p.exists():
        return []
    try:
        head = json.loads(p.read_text())[0]['header']
    except (ValueError, KeyError, IndexError, TypeError, OSError):
        return []
    stamps = [f['valid'] for f in head.get('forecast') or []] or (
        [head['refTime']] if head.get('refTime') else [])
    out = []
    for t in stamps:
        try:
            out.append(datetime.strptime(t, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc))
        except ValueError:
            pass
    return sorted(out)


def nearest_steps(product: dict, offsets: list[float],
                  want: list[datetime] | None = None) -> list[tuple[int, str, str, str]]:
    """The steps nearest `anchor + each offset`, all from one run.

    `want` overrides the offsets with absolute times — the hours the
    currents published, so the two pipelines cannot land on different ones.

    The mirror of `pick_nearest` in fetch-currents.py, and the two must stay
    in step — see the note on REFRESH_HOURS above. The reasoning is there;
    the short form is that the run is chosen first and the steps come out of
    it, so a pair can never straddle two model states, and that the anchor is
    floored to a REFRESH_HOURS boundary so the answer is stable for the whole
    window and the tile cache can hit.
    """
    epoch, hours, runs, now = time_axes(product)
    anchor = math.floor(now / REFRESH_HOURS) * REFRESH_HOURS
    if want:
        # Absolute hours for the times the currents actually published, in
        # this product's own epoch. See `currents_hours`.
        offsets = [(w - epoch).total_seconds() / 3600 - anchor for w in want]
    n = min(len(hours), len(runs))
    if not n:
        raise RuntimeError('no run axis — cannot anchor a step to a model run')

    for run in sorted({runs[i] for i in range(n)}, reverse=True):
        own = sorted((i for i in range(n) if abs(runs[i] - run) < 0.5),
                     key=lambda i: hours[i])
        chosen: list[int] = []
        for offset in offsets:
            i = min(own, key=lambda k: abs(hours[k] - (anchor + offset)))
            if i not in chosen:
                chosen.append(i)
        usable = []
        for i in chosen:
            if not serves(product, i):
                break
            usable.append(i)
        if not usable:
            print(f'  ! {hour_stamp(epoch, run)} run serves nothing at the '
                  f'anchor — trying an older run', file=sys.stderr)
            continue
        out = []
        for i in usable:
            lead = round(hours[i] - runs[i])
            # stderr, because `--tile-key` goes through this and CI captures
            # its stdout straight into a cache key — a progress line on the
            # same stream would become part of the key.
            print(f'  T+{lead}: valid {hour_stamp(epoch, hours[i])} from the '
                  f'{hour_stamp(epoch, runs[i])} run ({now - runs[i]:.0f} h old, '
                  f'{hours[i] - now:+.0f} h from now)', file=sys.stderr)
            out.append((lead, str(i), hour_stamp(epoch, hours[i]),
                        hour_stamp(epoch, runs[i])))
        return out
    raise RuntimeError('no usable time step at the anchor in any run')


def lead_steps(product: dict, leads: list[int]) -> list[tuple[int, str, str, str]]:
    """(lead, step token, valid time, model run) for each lead, as **T+N from
    the model run** — see the long note on `pick_leads` in fetch-currents.py
    for why that is anchored to the run rather than to the clock.

    The `--leads=` selection, and no longer the default: see the note on
    `LEADS`.

    Keeps the per-step probing that `usable_step` exists for: HYCOM fails per
    member file rather than as a whole. The walk goes **backwards through
    runs** rather than outwards through hours, though, since a neighbouring
    hour is a different lead: if the newest run cannot serve its T+36, the
    honest substitute is the run before it at *its* T+36, not this run at
    T+33 relabelled.

    An analysis has no run and no leads at all; that case never reaches here.
    """
    epoch, hours, runs, now = time_axes(product)

    def stamp(h: float) -> str:
        return hour_stamp(epoch, h)

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
            if not serves(product, i):
                continue
            print(f'  T+{lead}: valid {stamp(hours[i])} from the '
                  f'{stamp(runs[i])} run ({now - runs[i]:.0f} h old)',
                  file=sys.stderr)
            out.append((lead, str(i), stamp(hours[i]), stamp(runs[i])))
            break
        else:
            print(f'  ! no run carries T+{lead} usably — skipped', file=sys.stderr)
    if not out:
        raise RuntimeError('no usable time step at any lead')
    return out


def leads_wanted() -> list[int] | None:
    """Fixed leads to publish, or None to choose by valid time. Mirrors
    fetch-currents."""
    for arg in sys.argv[1:]:
        if arg.startswith('--leads='):
            return sorted({int(v) for v in arg.split('=', 1)[1].split(',') if v.strip()})
    return LEADS


_frames: dict[str, list[tuple[int, str, str, str]]] = {}


def forecast_frames(product: dict) -> list[tuple[int, str, str, str]]:
    """The steps this forecast product publishes, resolved once per product.

    Memoised because it costs OPeNDAP round trips and a probe, and because
    two calls could disagree: `nearest_steps` reads the clock, so a build
    running across an anchor boundary would answer differently the second
    time and name a tile directory for an hour the grids are not.
    """
    name = f"{product['prefix']}-{product['key']}"
    if name not in _frames:
        leads = leads_wanted()
        # The last offset of the same ladder the currents publish — one
        # frame, at the hour the map most often opens on. See WINDOW.
        # Only that offset is asked for, so only the step actually
        # published is probed.
        _frames[name] = (lead_steps(product, leads) if leads is not None
                         else nearest_steps(product, step_offsets(WINDOW)[-1:],
                                           want=currents_hours()[-1:] or None))
    return _frames[name]


def base_lead(product: dict) -> int:
    """The lead published under this product's bare filenames.

    An analysis has no lead — its own date is the answer — so its single
    file keeps the bare name whatever the forecast leads are set to. Read
    from LEADS instead, OISST would be published as sst-oisst-f0h.json the
    moment the base lead stopped being 0, and the map would find nothing at
    the name it asks for.

    A forecast reads it off the frames actually resolved, never off the
    constant: selecting by valid time makes the lead an *output*, so which
    one is lowest depends on how late the run is.
    """
    if product.get('analysis'):
        return 0
    return min(lead for lead, *_ in forecast_frames(product))


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
        frames = forecast_frames(product)

    if tiles_only:
        if not product.get('tiles'):
            print('  no tile tier — the region grid is already native resolution')
            return
        for lead, step, lead_valid, lead_run in frames:
            build_tiles(product, step, lead_valid, lead_run, lead=lead)
        return

    name = f"{product['prefix']}-{product['key']}"

    base = base_lead(product)

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
              south=-80.0, north=MAX_LAT, west=-180.0, east=180.0,
              stride=product['strides']['global'], wrap=True, run=lead_run,
              extra={**extra, 'lead': lead})

        for region in regions_for(product):
            build(product, step, lead_valid,
                  MAP_DIR / (at_lead(name + '-' + region['name'], lead) + '.json'),
                  south=region['south'], north=region['north'],
                  west=region.get('west', -180.0), east=region.get('east', 180.0),
                  stride=product['strides']['region'], wrap=region['wrap'],
                  run=lead_run, extra={'lead': lead})



def tile_key() -> str:
    """What CI keys the field tile cache on: every tiled product's run and
    valid time.

    Its own answer rather than the currents pipeline's, which is what the
    workflow used to borrow. That held while both were pinned to T+36 and
    one run meant one hour; selecting by valid time gives each pipeline a
    step that can in principle move independently, and a cache key that
    describes some *other* build's contents is the "right run, wrong hour"
    failure with an extra layer of indirection.

    Only the tiled products, since only their tiles are cached. The rest of
    the run is a few hundred kilobytes and is rebuilt hourly anyway.
    """
    parts = []
    for product in PRODUCTS:
        if not product.get('tiles') or product.get('analysis'):
            continue
        # Named per product rather than deduplicated. They agree today and
        # are meant to; a key that collapses them could not move when one
        # of them stopped agreeing, which is the case worth catching.
        name = f"{product['prefix']}{product['key']}"
        for _, _, valid, run in forecast_frames(product):
            stem = f'{name}{run[:13]}v{valid[:13]}'
            parts.append(stem.replace('-', '').replace(':', ''))
    if not parts:
        raise RuntimeError('no tiled forecast products to key on')
    return '-'.join(parts)


def main() -> int:
    tiles_only = '--tiles' in sys.argv
    only = next((a.split('=')[1] for a in sys.argv if a.startswith('--only=')), None)

    if '--tile-key' in sys.argv:
        print(tile_key())
        return 0

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
            #
            # **This deliberately still exits 0 when some products fail**, and
            # the exit code is the part that is right. An outage should
            # degrade to stale rather than block a deploy — the same bargain
            # the currents pipeline strikes. What was wrong was `build_tiles`
            # writing a short tile index on its way out, so "degraded" meant a
            # file that looked complete. It leaves the index alone now, and
            # this line is the only place that says so.
            print(f"! {product['key']} unavailable: {exc}", file=sys.stderr)
            failed.append(product['key'])

    if failed:
        print(f"! {len(failed)} of {len(PRODUCTS)} products unavailable: "
              f"{', '.join(failed)}", file=sys.stderr)

    if failed and len(failed) == len(PRODUCTS):
        if (MAP_DIR / 'sst-oisst.json').exists():
            print('  keeping the previous fields', file=sys.stderr)
            return 0
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
