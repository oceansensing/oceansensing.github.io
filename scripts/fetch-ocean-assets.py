#!/usr/bin/env python3
"""Collect active hurricane forecasts and uncrewed ocean assets into one JSON.

Run by .github/workflows/ocean-assets.yml on a schedule. Everything is
fetched server-side because the National Hurricane Center and PMEL ERDDAP
send no CORS headers, so a browser on the site cannot read them directly.

Sources
  NHC    https://www.nhc.noaa.gov/CurrentStorms.json  (+ KMZ track/cone)
  USVs   https://data.pmel.noaa.gov/pmel/erddap       (NOAA saildrones)
  Glider https://gliders.ioos.us/erddap               (US IOOS Glider DAC)

Only the standard library is used, so the workflow needs no dependencies.
"""

from __future__ import annotations

import io
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map' / 'ocean-assets.json'

NHC_STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json'
PMEL = 'https://data.pmel.noaa.gov/pmel/erddap'
IOOS = 'https://gliders.ioos.us/erddap'

# A dataset counts as active if it has reported within this window.
ACTIVE_DAYS = 5
UA = {'User-Agent': 'oceansensing.org asset map (github.com/oceansensing)'}
NOW = datetime.now(timezone.utc)


def get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url: str, timeout: int = 60):
    return json.loads(get(url, timeout))


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def is_active(max_time: str | None) -> bool:
    t = parse_time(max_time)
    return bool(t and NOW - t < timedelta(days=ACTIVE_DAYS))


# --------------------------------------------------------------------------
# Hurricanes


def kml_lines(kmz_url: str) -> list[list[list[float]]]:
    """Return [[ [lon, lat], ... ], ...] for every line/polygon in a KMZ."""
    try:
        blob = get(kmz_url, timeout=60)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f'  ! {kmz_url}: {exc}', file=sys.stderr)
        return []

    shapes: list[list[list[float]]] = []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if not name.lower().endswith('.kml'):
                continue
            root = ElementTree.fromstring(z.read(name))
            for el in root.iter():
                if not el.tag.endswith('coordinates') or not (el.text or '').strip():
                    continue
                pts = []
                for token in el.text.split():
                    parts = token.split(',')
                    if len(parts) >= 2:
                        try:
                            pts.append([round(float(parts[0]), 4), round(float(parts[1]), 4)])
                        except ValueError:
                            pass
                if len(pts) > 1:
                    shapes.append(pts)
    return shapes


def simplify(points: list[list[float]], tol: float = 0.02) -> list[list[float]]:
    """Ramer-Douglas-Peucker. NHC cones arrive with ~1700 vertices; a few
    hundred draw identically at map scales and cut the payload sharply."""
    if len(points) < 3:
        return points

    def perp(p, a, b):
        (px, py), (ax, ay), (bx, by) = p, a, b
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return ((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2) ** 0.5

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, at = 0.0, None
        for i in range(lo + 1, hi):
            d = perp(points[i], points[lo], points[hi])
            if d > worst:
                worst, at = d, i
        if at is not None and worst > tol:
            keep[at] = True
            stack += [(lo, at), (at, hi)]
    return [p for p, k in zip(points, keep) if k]


def collect_storms() -> list[dict]:
    try:
        active = get_json(NHC_STORMS, timeout=45).get('activeStorms', [])
    except Exception as exc:  # noqa: BLE001 - a dead source must not fail the run
        print(f'! NHC unavailable: {exc}', file=sys.stderr)
        return []

    storms = []
    for s in active:
        storm = {
            'id': s.get('id'),
            'name': s.get('name'),
            'classification': s.get('classification'),
            'intensityKt': s.get('intensity'),
            'pressureMb': s.get('pressure'),
            'lat': s.get('latitudeNumeric'),
            'lon': s.get('longitudeNumeric'),
            'movementDir': s.get('movementDir'),
            'movementSpeedKt': s.get('movementSpeed'),
            'lastUpdate': s.get('lastUpdate'),
            'advisoryUrl': (s.get('publicAdvisory') or {}).get('url'),
        }
        track = (s.get('forecastTrack') or {}).get('kmzFile')
        cone = (s.get('trackCone') or {}).get('kmzFile')
        if track:
            lines = kml_lines(track)
            # The longest line is the forecast track itself.
            storm['track'] = max(lines, key=len) if lines else []
        if cone:
            polys = kml_lines(cone)
            storm['cone'] = simplify(max(polys, key=len)) if polys else []
        storms.append(storm)
        print(f'  storm {storm["name"]}: track {len(storm.get("track", []))} pts, '
              f'cone {len(storm.get("cone", []))} pts')
    return storms


# --------------------------------------------------------------------------
# Uncrewed assets


def latest_position(base: str, dataset_id: str) -> dict | None:
    q = f'{base}/tabledap/{urllib.parse.quote(dataset_id)}.json'
    q += '?time,latitude,longitude&orderByMax(%22time%22)'
    try:
        rows = get_json(q, timeout=45)['table']['rows']
    except Exception:  # noqa: BLE001 - skip datasets that error or have no rows
        return None
    if not rows:
        return None
    t, lat, lon = rows[0][0], rows[0][1], rows[0][2]
    if lat is None or lon is None:
        return None
    return {'time': t, 'lat': round(float(lat), 4), 'lon': round(float(lon), 4)}


def collect_erddap(base: str, kind: str, match: re.Pattern | None = None) -> list[dict]:
    fields = 'datasetID,title,institution,maxTime'
    try:
        table = get_json(f'{base}/tabledap/allDatasets.json?{fields}', timeout=120)['table']
    except Exception as exc:  # noqa: BLE001
        print(f'! {base} unavailable: {exc}', file=sys.stderr)
        return []

    cols = table['columnNames']
    idx = {c: cols.index(c) for c in cols}
    candidates = []
    for row in table['rows']:
        ds = row[idx['datasetID']]
        if ds in ('allDatasets',):
            continue
        title = row[idx['title']] or ''
        if match and not match.search(f'{ds} {title}'):
            continue
        if not is_active(row[idx['maxTime']]):
            continue
        candidates.append({
            'id': ds,
            'kind': kind,
            'title': title,
            'institution': row[idx['institution']] or '',
            'info': f'{base}/info/{ds}/index.html',
        })

    print(f'  {kind}: {len(candidates)} active datasets; fetching positions')
    with ThreadPoolExecutor(max_workers=8) as pool:
        positions = list(pool.map(lambda c: latest_position(base, c['id']), candidates))

    assets = []
    for c, pos in zip(candidates, positions):
        if pos:
            assets.append({**c, **pos})
    print(f'  {kind}: {len(assets)} with a position')
    return assets


def main() -> int:
    # Keep whatever we had if a source is unreachable, so a NOAA outage
    # degrades to slightly stale data rather than an empty map.
    previous = {}
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
        except json.JSONDecodeError:
            pass

    print('hurricanes:')
    storms = collect_storms()
    print('assets:')
    usvs = collect_erddap(PMEL, 'usv', re.compile(r'saildrone|usv|uncrewed|unmanned', re.I))
    gliders = collect_erddap(IOOS, 'glider')

    if not storms and not usvs and not gliders and previous.get('assets'):
        print('! every source failed; keeping the previous file', file=sys.stderr)
        return 0
    if not usvs and not gliders and previous.get('assets'):
        print('! both ERDDAPs failed; keeping previous asset positions', file=sys.stderr)
        kept = previous['assets']
        usvs = [a for a in kept if a['kind'] == 'usv']
        gliders = [a for a in kept if a['kind'] == 'glider']

    payload = {
        'updated': NOW.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'activeWindowDays': ACTIVE_DAYS,
        'storms': storms,
        'assets': sorted(usvs + gliders, key=lambda a: (a['kind'], a['id'])),
        'sources': {
            'storms': 'National Hurricane Center',
            'usv': 'NOAA PMEL ERDDAP',
            'glider': 'US IOOS Glider DAC',
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    print(f'wrote {OUT} — {len(storms)} storms, {len(payload["assets"])} assets, '
          f'{OUT.stat().st_size / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
