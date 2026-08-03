#!/usr/bin/env python3
"""Build public/map/coastline.json — the offline, no-tracking basemap.

    python3 scripts/fetch-coastline.py

A local one-off, like fetch-bathymetry.py: coastlines do not move, so this
has no workflow, no cache key and no hourly cost. Re-run it only to change
the source or the simplification.

Output: ~7,700 rings, 223,000 vertices, 4.2 MB raw and 1.4 MB gzipped. The
map fetches it only when a reader selects that basemap, which is what makes
that size affordable — see the lazy load in index.ts.

**Why it exists.** The file it replaces was built once by hand and committed
with no generator, and it showed: 1,012 rings, 20,086 vertices, coordinates
rounded to two decimals — 1.1 km, so the rounding alone was coarser than the
zoom the map is read at. Measured, its segments ran to a **median of 33.7
screen pixels at zoom 7 and 94.8 at p90**, which is what "poorly resolved"
looked like: a blocky line that made the basemap not worth choosing, and the
reason the option was pulled.

**Source.** Natural Earth 10m physical land, from Natural Earth's own S3
rather than a GeoJSON mirror — this is the authoritative copy, and the
shapefile is 3.3 MB against 18.3 MB for the same data as GeoJSON.

Standard library only, including the shapefile reader. A .shp is a flat
sequence of records of little-endian doubles; the polygon record is a box, a
part count, a point count, the part offsets and then the points. That is
about forty lines, which is less than a dependency costs, and it is the same
call the KMZ decoder made about a ZIP library.

Only the .shp is read. The .dbf holds attributes and there are none here
worth having: every record in ne_10m_land is land.
"""

import argparse
import io
import json
import math
import pathlib
import struct
import urllib.request
import zipfile

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map' / 'coastline.json'

SOURCES = [
    # The mainlands and the islands big enough for Natural Earth's land layer.
    'https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_land.zip',
    # Everything below that: reefs, atolls, the small stuff a coastline is
    # partly read for. 2 MB of source for ~1,100 more rings.
    'https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_minor_islands.zip',
]

# Douglas-Peucker tolerance, in degrees, and the one number that decides both
# how this looks and what it weighs.
#
# The isobaths settled this question already and the answer is the same here:
# a tolerance argued from the source's own fidelity says nothing about how the
# line *looks*, because Douglas-Peucker keeps a vertex only where the chord
# strays past the tolerance — so a loose tolerance leaves long straight runs
# with corners between them, however fine the data underneath.
#
# So it is set from the screen instead, and measured rather than argued.
# Median and p90 segment length at zoom 7, against what the file costs:
#
#     tolerance   vertices   median   p90     raw      gzipped
#     0.010 deg    163,777   6.35 px  18.8    3.08 MB   1.02 MB
#     0.006 deg    223,005   4.63 px  13.9    4.19 MB   1.36 MB
#     0.003 deg    309,015   3.24 px   9.8    5.80 MB   1.83 MB
#
# and the file this replaces measured 33.7 px median, 94.8 px at p90.
#
# 0.006 is the knee. Below it the return falls off — a third more bytes for
# 1.4 px, which at zoom 7 is not something an eye picks out of filled land —
# and above it the p90 climbs into the range the old file was rejected for.
# 4.6 px is about where the isobath tiles sit, and those read as curves.
EPSILON = 0.006

# Smallest bounding-box side a ring must span to be drawn, in degrees.
#
# Deliberately low — 0.002 deg is ~220 m. The isobaths filter small rings hard
# because at 4000 m a small ring is sampling speckle; here it is an island,
# and a coastline layer that drops islands is not a coastline layer. This bar
# only removes rings that have collapsed to a point under simplification.
MIN_EXTENT = 0.002

# Coordinate precision. 4 decimals is ~11 m, comfortably under the tolerance
# above, and it is what stops the file being twice the size for digits no
# projection can show. The old file used 2 — ~1.1 km, coarser than the zoom
# it was read at, so the rounding was itself a source of the blockiness.
PLACES = 4


def fetch(url: str) -> bytes:
    print(f'  {url}')
    request = urllib.request.Request(url, headers={'User-Agent': 'c4po-map/1.0'})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def shp_polygons(shp: bytes) -> list[list[tuple[float, float]]]:
    """Every ring in a polygon shapefile, as lists of (lon, lat).

    The 100-byte header is followed by records: an 8-byte big-endian header
    (number, content length in 16-bit words) and then the content, which for
    shape type 5 is the type, a bounding box, the part and point counts, the
    part offsets, and finally the points as pairs of little-endian doubles.

    Rings are returned individually and not grouped into outer/hole sets. The
    map draws them as separate polygons at a low fill opacity, which is what
    it already did; a lake inside an island is drawn over rather than punched
    out, and at this scale nothing about that is visible.
    """
    rings: list[list[tuple[float, float]]] = []
    at = 100
    end = len(shp)
    while at + 8 <= end:
        _, words = struct.unpack('>ii', shp[at:at + 8])
        content = at + 8
        at = content + words * 2
        (kind,) = struct.unpack('<i', shp[content:content + 4])
        if kind != 5:            # 0 is a null shape; nothing else is expected
            continue
        parts, points = struct.unpack('<ii', shp[content + 36:content + 44])
        offsets = struct.unpack(f'<{parts}i', shp[content + 44:content + 44 + parts * 4])
        first = content + 44 + parts * 4
        flat = struct.unpack(f'<{points * 2}d', shp[first:first + points * 16])
        bounds = list(offsets) + [points]
        for start, stop in zip(bounds, bounds[1:]):
            rings.append([(flat[i * 2], flat[i * 2 + 1]) for i in range(start, stop)])
    return rings


def simplify(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative so a long ring cannot blow the stack.

    The same routine as fetch-bathymetry.py's, without numpy: this script has
    no other need for it and stays runnable with nothing installed.
    """
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        far = -1.0
        pick = a
        for i in range(a + 1, b):
            px, py = points[i]
            if length:
                away = abs(dx * (py - ay) - dy * (px - ax)) / length
            else:
                away = math.hypot(px - ax, py - ay)
            if away > far:
                far, pick = away, i
        if far > eps:
            keep[pick] = True
            stack += [(a, pick), (pick, b)]
    return [p for p, k in zip(points, keep) if k]


def extent(ring: list[tuple[float, float]]) -> float:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--epsilon', type=float, default=EPSILON,
                        help=f'simplification tolerance in degrees (default {EPSILON})')
    args = parser.parse_args()

    print('Natural Earth 10m physical land:')
    raw: list[list[tuple[float, float]]] = []
    for url in SOURCES:
        archive = zipfile.ZipFile(io.BytesIO(fetch(url)))
        name = next(n for n in archive.namelist() if n.lower().endswith('.shp'))
        found = shp_polygons(archive.read(name))
        print(f'    {len(found)} rings, {sum(len(r) for r in found)} vertices')
        raw += found

    rings = []
    dropped = 0
    for ring in raw:
        thin = simplify(ring, args.epsilon)
        if len(thin) < 4 or extent(thin) < MIN_EXTENT:
            dropped += 1
            continue
        rings.append([[round(x, PLACES), round(y, PLACES)] for x, y in thin])

    rings.sort(key=extent, reverse=True)
    OUT.write_text(json.dumps({'rings': rings}, separators=(',', ':')))

    before = sum(len(r) for r in raw)
    after = sum(len(r) for r in rings)
    print(f'\n  {len(rings)} rings, {after} vertices '
          f'({after / before:.1%} of {before}), {dropped} rings dropped as sub-{MIN_EXTENT} deg')
    print(f'  {OUT.stat().st_size / 1e6:.1f} MB -> {OUT}')


if __name__ == '__main__':
    main()
