#!/usr/bin/env python3
"""Contour the world's bathymetry once, for the map's isobath layer.

    GEBCO_GRID=/path/to/GEBCO_2026.nc python3 scripts/fetch-bathymetry.py
    python3 scripts/fetch-bathymetry.py --grid /path/to/GEBCO_2026.nc --deep
    python3 scripts/fetch-bathymetry.py --grid /path/to/GEBCO_2026.nc --tiles

Writes public/map/bathy-deep.json and public/map/bathy-tiles/, and both are
**committed**. The seafloor does not change, so unlike every other grid here
this runs once by hand and never in CI — no workflow, no cache key, no
hourly cost. Re-run it only to change the levels or the simplification.

Reads GEBCO 2026 (15 arc-second, ~460 m) from a local file rather than over
the network. The grid is 7.5 GB, so it is not in the repo and not fetched:
pass the path. ETOPO 2022 at 60" is servable over OPeNDAP from NGDC and was
the fallback plan, but GEBCO is four times finer per axis and the difference
lands exactly where this layer is read — the shelf.

Needs numpy, matplotlib and h5py. Like scripts/sample-basemaps.py it is a
local tool, not part of the build, so the dependencies cost CI nothing.
GEBCO's netCDF is HDF5 underneath and its elevation array is contiguous and
uncompressed — 7,464,960,000 bytes of data in a 7,466,018,396-byte file — so
a windowed read is a seek, and no tile needs the whole grid in memory.

Two tiers, because the shallow contours are almost all of the bytes and none
of the use at basin scale. Measured over five contrasting regions and
projected across the world ocean: 200 m and below comes to ~1.2 MB gzipped,
while 20-100 m comes to ~4.6 MB — a 20 m isobath threads every sandbar, and
at zoom 4 that is a smear. So the deep set is one global file fetched when
the layer is switched on, and the shallow set is tiled on the same 20 deg
lattice the current and field tiles already use, fetched per view at zoom 6
and in. Per tile that is well under what one current tile costs.

The 0 m line is deliberately absent: public/map/coastline.json is already
committed, already simplified, and cartographically cleaner than anything
thresholding a DEM produces. The component draws it as part of the same
layer.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import sys

import h5py
import numpy as np
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402  (backend must be set first)

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'
DEEP_FILE = OUT / 'bathy-deep.json'
TILE_DIR = OUT / 'bathy-tiles'

# The levels the map offers. Shallow ones go in the tiles, the rest in the
# global file.
SHALLOW = [20, 40, 60, 80, 100]
DEEP = [200, 400, 600, 800, 1000, 2000, 4000, 6000, 8000, 10000]

# 8000 and 10000 exist only in the trenches — the Mariana, Tonga, Kuril,
# Philippine and a few others. Almost every tile and most of the globe has
# none, which is correct rather than a bug.


def epsilon(depth: int) -> float:
    """Douglas-Peucker tolerance in degrees.

    Detail should match the scale the contour is read at: a 4000 m isobath
    is a smooth basin-scale feature, a 20 m one hugs every bar and channel.
    0.01 deg is ~1.1 km, about two cells of the shallow grid, and half a
    pixel at the zoom the tiles start at.

    The deep tolerances look coarse and are not: the deep tier is sampled at
    stride 8, so its grid is already 0.033 deg and 0.08 removes about two
    cells of wiggle. Measured, dropping from 0.05/0.02 to 0.08/0.04 takes
    the global file from 1.9 MB gzipped to 1.25 with nothing visible to show
    for it, because the line's real resolution is the sampling either way.
    """
    if depth <= 100:
        return 0.01
    if depth <= 1000:
        return 0.04
    return 0.08


def min_extent(depth: int) -> float:
    """Smallest bounding-box side a contour must span to be worth drawing.

    Contour a nearly flat plain at exactly its own depth and it shatters:
    the 4000 m level is the abyssal mean, and unfiltered it came out as
    32,644 separate lines, median 0.12 deg across — sampling speckle, not
    seafloor, and noise on screen at every zoom.

    The threshold is per depth rather than flat, because a small closed ring
    means different things at different levels. At 200-1000 m it is an
    island or a bank and belongs on the map, so the bar there is 0.1 deg —
    ~11 km, three cells of this grid, the smallest thing the sampling can
    honestly resolve. At 2000 m and below it is an abyssal hill, so the bar
    is 0.3. Measured, that keeps 2,648 lines at 200 m against 1,480 under a
    flat 0.2 filter, while cutting 4000 m to 6,000.

    Shallow contours are not filtered at all: a small ring at 20 m is a
    shoal or a reef, which is exactly what someone reads this layer for.
    """
    if depth <= 100:
        return 0.0
    if depth <= 1000:
        return 0.1
    return 0.3


# Sampling strides into the 15" grid, per tier.
#
# Shallow uses stride 2 (~925 m) rather than every cell. Measured on the US
# East Coast and Gulf, the worst shelf in the Atlantic: every cell gives 113
# KB gzipped against 91 at stride 2, for detail that sits below the 1.1 km
# simplification tolerance either way. Deep uses stride 8 (~3.7 km), which is
# still finer than its own coarsest tolerance.
SHALLOW_STRIDE = 2
DEEP_STRIDE = 8

# Same lattice as the current and field tiles, so a reader who has one has
# the other in the same places.
TILES = {'size': 20, 'west': -180, 'south': -80, 'north': 85, 'minZoom': 6}

# Rows of output per read when striding the whole grid, to bound memory.
BAND = 512


class Grid:
    """GEBCO's elevation grid, read in windows."""

    def __init__(self, path: pathlib.Path):
        self.file = h5py.File(path, 'r')
        self.z = self.file['elevation']
        self.lat = self.file['lat'][:]
        self.lon = self.file['lon'][:]
        if self.z.shape != (self.lat.size, self.lon.size):
            raise SystemExit(f'{path}: elevation is {self.z.shape}, but the axes '
                             f'are {self.lat.size} x {self.lon.size}')

    def close(self) -> None:
        self.file.close()

    def window(self, la0: int, la1: int, lo0: int, lo1: int,
               stride: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """A sub-grid, read contiguously then strided.

        Reading the block and striding in numpy rather than asking HDF5 for
        a strided hyperslab: the rows are contiguous on disk, so the block
        read is the cheap shape.
        """
        block = self.z[la0:la1, lo0:lo1]
        return (block[::stride, ::stride].astype('f4'),
                self.lat[la0:la1][::stride],
                self.lon[lo0:lo1][::stride])

    def strided(self, stride: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """The whole grid at a stride, in bands so it never lands in memory whole."""
        rows = range(0, self.z.shape[0], stride)
        out = np.empty((len(rows), len(range(0, self.z.shape[1], stride))), dtype='f4')
        for start in range(0, len(rows), BAND):
            end = min(start + BAND, len(rows))
            block = self.z[rows[start] : rows[end - 1] + 1 : stride, :]
            out[start:end] = block[:, ::stride]
        return out, self.lat[::stride], self.lon[::stride]


def simplify(points: np.ndarray, eps: float) -> np.ndarray:
    """Douglas-Peucker, iterative so a long contour cannot blow the stack."""
    keep = np.zeros(len(points), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        span = points[b] - points[a]
        length = math.hypot(*span)
        rest = points[a + 1:b] - points[a]
        if length:
            far = np.abs(span[0] * rest[:, 1] - span[1] * rest[:, 0]) / length
        else:
            far = np.hypot(rest[:, 0], rest[:, 1])
        i = int(np.argmax(far))
        if far[i] > eps:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    return points[keep]


def contours(z: np.ndarray, lat: np.ndarray, lon: np.ndarray,
             levels: list[int]) -> list[dict]:
    """Contour a grid of elevations into simplified GeoJSON LineStrings."""
    fig = plt.figure()
    try:
        cs = plt.contour(lon, lat, -z, levels=levels)
        features = []
        for level, segments in zip(cs.levels, cs.allsegs):
            depth = int(round(float(level)))
            eps = epsilon(depth)
            floor = min_extent(depth)
            for seg in segments:
                if len(seg) < 4:
                    continue
                seg = np.asarray(seg, dtype='f8')
                if floor and max(np.ptp(seg[:, 0]), np.ptp(seg[:, 1])) < floor:
                    continue
                points = simplify(seg, eps)
                if len(points) < 3:
                    continue
                features.append({
                    'type': 'Feature',
                    'properties': {'d': depth},
                    'geometry': {
                        'type': 'LineString',
                        'coordinates': [[round(float(x), 3), round(float(y), 3)]
                                        for x, y in points],
                    },
                })
        return features
    finally:
        plt.close(fig)


def write(path: pathlib.Path, features: list[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps({'type': 'FeatureCollection', 'features': features},
                      separators=(',', ':'))
    path.write_text(body)
    return len(body.encode())


def build_deep(grid: Grid) -> None:
    print(f'deep contours {DEEP} at stride {DEEP_STRIDE} '
          f'({(grid.lat[1] - grid.lat[0]) * DEEP_STRIDE:.4f} deg)')
    z, lat, lon = grid.strided(DEEP_STRIDE)

    # The grid stops just short of 180 E, so a contour crossing the
    # antimeridian is cut there and leaves a hairline gap. Repeating the
    # first column at +360 closes it; coordinates a shade past 180 are what
    # Leaflet already expects of a feature spanning the seam.
    z = np.concatenate([z, z[:, :1]], axis=1)
    lon = np.append(lon, lon[0] + 360)

    features = contours(z, lat, lon, DEEP)
    size = write(DEEP_FILE, features)
    points = sum(len(f['geometry']['coordinates']) for f in features)
    counts = {d: sum(1 for f in features if f['properties']['d'] == d) for d in DEEP}
    print(f'  {DEEP_FILE.name}: {len(features)} lines, {points} points, '
          f'{size / 1024:.0f} KB')
    print('  lines per level: ' + ', '.join(f'{d}:{n}' for d, n in counts.items()))


def tile_cells() -> list[tuple[int, int]]:
    out = []
    south = TILES['south']
    while south < TILES['north']:
        west = TILES['west']
        while west < 180:
            out.append((south, west))
            west += TILES['size']
        south += TILES['size']
    return out


def build_tile(grid: Grid, south: int, west: int) -> tuple[int, int, int]:
    """One shallow tile. Returns (lines, points, bytes); zeros if there is none."""
    size = TILES['size']
    lat, lon = grid.lat, grid.lon
    # A margin, so a contour does not stop dead at the tile edge and leave a
    # gap against its neighbour. Four cells is under two simplified points.
    margin = 4 * SHALLOW_STRIDE
    la0 = max(0, int(np.searchsorted(lat, south)) - margin)
    la1 = min(lat.size, int(np.searchsorted(lat, south + size)) + margin)
    lo0 = max(0, int(np.searchsorted(lon, west)) - margin)
    lo1 = min(lon.size, int(np.searchsorted(lon, west + size)) + margin)

    z, sub_lat, sub_lon = grid.window(la0, la1, lo0, lo1, SHALLOW_STRIDE)

    depth = -z
    if not np.any((depth >= SHALLOW[0]) & (depth <= SHALLOW[-1])):
        return 0, 0, 0  # no shelf water — nothing to draw, and no file

    features = contours(z, sub_lat, sub_lon, SHALLOW)
    if not features:
        return 0, 0, 0
    written = write(TILE_DIR / f'{south}_{west}.json', features)
    points = sum(len(f['geometry']['coordinates']) for f in features)
    return len(features), points, written


def build_tiles(grid: Grid) -> None:
    cells = tile_cells()
    print(f'shallow contours {SHALLOW} over {len(cells)} tiles at stride '
          f'{SHALLOW_STRIDE} ({(grid.lat[1] - grid.lat[0]) * SHALLOW_STRIDE:.4f} deg)')
    written: list[str] = []
    empty = 0
    total = 0

    for south, west in cells:
        lines, points, size = build_tile(grid, south, west)
        if not lines:
            empty += 1
            continue
        written.append(f'{south}_{west}')
        total += size
        print(f'  {south}_{west}.json: {lines} lines, {points} points, '
              f'{size / 1024:.0f} KB')

    index = dict(TILES, levels=SHALLOW, available=sorted(written))
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    (TILE_DIR / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    print(f'wrote {len(written)} tiles ({empty} with no shelf water), '
          f'{total / 1024 / 1024:.1f} MB')


def main() -> None:
    ap = argparse.ArgumentParser(description='Contour GEBCO into the map isobath layer.')
    ap.add_argument('--grid', default=os.environ.get('GEBCO_GRID'),
                    help='path to GEBCO_2026.nc (or $GEBCO_GRID)')
    ap.add_argument('--deep', action='store_true', help='the global 200 m+ file only')
    ap.add_argument('--tiles', action='store_true', help='the 20-100 m tiles only')
    args = ap.parse_args()
    if not args.grid:
        raise SystemExit('pass --grid /path/to/GEBCO_2026.nc, or set $GEBCO_GRID')
    both = not (args.deep or args.tiles)

    grid = Grid(pathlib.Path(args.grid))
    step = grid.lat[1] - grid.lat[0]
    print(f'GEBCO grid {grid.z.shape[0]} x {grid.z.shape[1]} at {step:.6f} deg '
          f'({step * 3600:.0f}")')
    try:
        if args.deep or both:
            build_deep(grid)
        if args.tiles or both:
            build_tiles(grid)
    finally:
        grid.close()


if __name__ == '__main__':
    sys.exit(main())
