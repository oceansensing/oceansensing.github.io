"""Marching squares at one threshold, and Douglas-Peucker, in the standard
library.

**Why not matplotlib, which this repo already contours with.**
`fetch-bathymetry.py` uses it, and can: the seafloor is computed once by hand
on a workstation, so its dependencies cost CI nothing. The ice edge moves
daily and has to run in the hourly build, where the only non-stdlib
dependency anybody has been willing to add is `eccodes`, and that one is
paid for by a format nobody can decode in forty lines. A single-threshold
contour is not that format. Seventeen levels with per-depth speckle filtering
would have been; one is about a hundred lines.

Nothing here imports numpy either, for the same reason.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

# A cell corner is either a number or None. None is "no data" — land in the
# forecast, and land-or-open-water in the analysis, which is why the caller
# says what to read it as rather than this deciding.
#
# `Optional[float]` rather than `float | None`, and the difference is not
# style: this is an assignment, so it is evaluated, and the shorthand is a
# syntax the interpreter only understands from 3.10. Every other annotation
# in these scripts is deferred by the __future__ import above and never
# evaluated at all, which is why they can use it and this cannot. macOS
# ships 3.9.
Cell = Optional[float]
Point = Tuple[float, float]


def _interp(v0: float, v1: float, t: float) -> float:
    """Where between two corners the threshold falls, 0..1.

    Linear, and the guard matters: two corners that are equal and both on the
    threshold would divide by zero, which happens over a uniform field far
    more often than it sounds — a fully packed basin is a plateau of 1.0.
    """
    span = v1 - v0
    return 0.5 if span == 0 else (t - v0) / span


def segments(
    grid: list[list[Cell]],
    threshold: float,
    lat0: float,
    dlat: float,
    lon0: float,
    dlon: float,
    absent: float = 0.0,
) -> list[tuple[Point, Point]]:
    """Every threshold-crossing segment in the grid, in lon/lat.

    `absent` is what a None corner counts as. The default of 0 is what makes
    the two ice products contour to the same line: the analysis masks open
    water as missing and the forecast writes a real 0 there, and reading None
    as "no ice" collapses that difference exactly where it does not matter.

    A consequence worth stating rather than discovering: it also puts an edge
    where ice meets *land*, since land is None too. That is not noise — it is
    where the pack is landfast, and it is true — but it means the line runs
    along the coast in places, and the coastline layer draws there as well.
    """
    out: list[tuple[Point, Point]] = []
    ny = len(grid)
    if ny < 2:
        return out

    def value(cell: Cell) -> float:
        return absent if cell is None else cell

    for y in range(ny - 1):
        row, nxt = grid[y], grid[y + 1]
        nx = min(len(row), len(nxt))
        for x in range(nx - 1):
            # Corners, counter-clockwise from the bottom-left of the cell.
            bl, br = value(row[x]), value(row[x + 1])
            tl, tr = value(nxt[x]), value(nxt[x + 1])
            code = (
                (1 if bl >= threshold else 0)
                | (2 if br >= threshold else 0)
                | (4 if tr >= threshold else 0)
                | (8 if tl >= threshold else 0)
            )
            if code == 0 or code == 15:
                continue

            west, east = lon0 + x * dlon, lon0 + (x + 1) * dlon
            south, north = lat0 + y * dlat, lat0 + (y + 1) * dlat

            def bottom() -> Point:
                return (west + dlon * _interp(bl, br, threshold), south)

            def top() -> Point:
                return (west + dlon * _interp(tl, tr, threshold), north)

            def left() -> Point:
                return (west, south + dlat * _interp(bl, tl, threshold))

            def right() -> Point:
                return (east, south + dlat * _interp(br, tr, threshold))

            # The two saddles (5 and 10) are genuinely ambiguous — the cell
            # can be joined either way and the data does not say which. Both
            # segments are emitted, which keeps the line closed; resolving it
            # by the centre average would be defensible and is not worth the
            # code at this scale, where a cell is tens of kilometres.
            if code in (1, 14):
                out.append((left(), bottom()))
            elif code in (2, 13):
                out.append((bottom(), right()))
            elif code in (3, 12):
                out.append((left(), right()))
            elif code in (4, 11):
                out.append((right(), top()))
            elif code in (6, 9):
                out.append((bottom(), top()))
            elif code in (7, 8):
                out.append((left(), top()))
            elif code == 5:
                out.append((left(), bottom()))
                out.append((right(), top()))
            elif code == 10:
                out.append((left(), top()))
                out.append((bottom(), right()))
    return out


def _key(p: Point) -> tuple[int, int]:
    """Endpoints are compared at a rounded precision, not exactly.

    Two cells sharing an edge compute the same crossing from the same two
    corners, so in principle the floats match — but the two sides reach it by
    different arithmetic (one adds `dlon * t` to the cell's west, the other to
    its neighbour's), and at 1e-16 they sometimes do not. Joining on exact
    equality left a line in several hundred pieces instead of a few dozen.
    """
    return (round(p[0] * 1e6), round(p[1] * 1e6))


def join(segs: list[tuple[Point, Point]]) -> list[list[Point]]:
    """Chain segments end-to-end into polylines.

    One path per connected run, walked from an endpoint rather than from an
    arbitrary segment so an open line is emitted whole rather than as two
    halves meeting in the middle.
    """
    from collections import defaultdict

    ends: Dict[Tuple[int, int], List[int]] = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        ends[_key(a)].append(i)
        ends[_key(b)].append(i)

    used = [False] * len(segs)
    paths: list[list[Point]] = []

    def walk(start: int, forward: Point, tail: Point) -> list[Point]:
        path = [tail, forward]
        used[start] = True
        while True:
            here = _key(path[-1])
            nxt = None
            for i in ends[here]:
                if not used[i]:
                    nxt = i
                    break
            if nxt is None:
                return path
            used[nxt] = True
            a, b = segs[nxt]
            path.append(b if _key(a) == here else a)

    # Open ends first: a vertex touched by one segment can only be the start
    # of a line, and starting there keeps that line in one piece.
    order = sorted(range(len(segs)), key=lambda i: len(ends[_key(segs[i][0])]))
    for i in order:
        if used[i]:
            continue
        a, b = segs[i]
        paths.append(walk(i, b, a))
    return [p for p in paths if len(p) > 1]


def simplify(points: list[Point], tolerance: float) -> list[Point]:
    """Douglas-Peucker, iterative so a long polar contour cannot blow the
    stack — the Antarctic edge runs to tens of thousands of vertices in one
    piece."""
    if len(points) < 3 or tolerance <= 0:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        worst, at = -1.0, first
        for i in range(first + 1, last):
            px, py = points[i]
            if span == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > worst:
                worst, at = d, i
        if worst > tolerance * tolerance:
            keep[at] = True
            stack.append((first, at))
            stack.append((at, last))
    return [p for p, k in zip(points, keep) if k]


def contour(
    grid: list[list[Cell]],
    threshold: float,
    lat0: float,
    dlat: float,
    lon0: float,
    dlon: float,
    tolerance: float = 0.0,
    absent: float = 0.0,
    min_points: int = 4,
) -> list[list[Point]]:
    """The whole pipeline: cross, chain, thin, drop the specks.

    `min_points` discards the two- and three-vertex fragments a noisy field
    throws off — a single cell of 16% concentration in open water is a
    triangle nobody can see and it is most of the vertex count.
    """
    paths = join(segments(grid, threshold, lat0, dlat, lon0, dlon, absent))
    out = []
    for path in paths:
        thinned = simplify(path, tolerance) if tolerance else path
        if len(thinned) >= min_points:
            out.append(thinned)
    return out
