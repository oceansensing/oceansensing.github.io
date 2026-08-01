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

MAP_DIR = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'map'
OUT = MAP_DIR / 'ocean-assets.json'
# Argo lands in its own file: there are two thousand of them against forty
# gliders and saildrones, and the page re-fetches ocean-assets.json every
# hour to check for a new build. Keeping them apart keeps that poll cheap.
ARGO_OUT = MAP_DIR / 'argo.json'

NHC_STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json'
PMEL = 'https://data.pmel.noaa.gov/pmel/erddap'
IOOS = 'https://gliders.ioos.us/erddap'
IFREMER = 'https://erddap.ifremer.fr/erddap'

# The trailing window, and the single knob for it. Governs every asset the
# map draws: how much glider and USV track is fetched, how far back a storm's
# observed path is drawn, and how recently a dataset must have reported to
# count as active. Change it here and the whole map follows.
HISTORY_DAYS = 5
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
    return bool(t and NOW - t < timedelta(days=HISTORY_DAYS))


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


def best_track(kmz_url: str) -> list[list[float]]:
    """Where the storm has actually been, over the last HISTORY_DAYS.

    The best-track KMZ carries one placemark per synoptic hour, each with an
    <atcfdtg> stamp (YYYYMMDDHH) alongside its position — so unlike the
    forecast KMZ this one can be trimmed to the window rather than drawn
    whole. Storms run for weeks; the map only shows the recent past.
    """
    try:
        blob = get(kmz_url, timeout=60)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f'  ! {kmz_url}: {exc}', file=sys.stderr)
        return []

    cutoff = NOW - timedelta(days=HISTORY_DAYS)
    points: list[tuple[datetime, list[float]]] = []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if not name.lower().endswith('.kml'):
                continue
            text = z.read(name).decode('utf-8', 'replace')
            for mark in re.findall(r'<Placemark>.*?</Placemark>', text, re.S):
                def tag(name: str) -> str | None:
                    m = re.search(rf'<{name}>([^<]*)</{name}>', mark)
                    return m.group(1) if m else None

                stamp, lat, lon = tag('atcfdtg'), tag('lat'), tag('lon')
                if not (stamp and lat and lon):
                    continue
                try:
                    when = datetime.strptime(stamp, '%Y%m%d%H').replace(tzinfo=timezone.utc)
                    position = [round(float(lon), 3), round(float(lat), 3)]
                except ValueError:
                    continue
                if when >= cutoff:
                    points.append((when, position))

    points.sort(key=lambda p: p[0])
    return [p for _, p in points]


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
        history = (s.get('bestTrackGIS') or {}).get('kmzFile')
        storm['history'] = best_track(history) if history else []
        storms.append(storm)
        print(f'  storm {storm["name"]}: track {len(storm.get("track", []))} pts, '
              f'cone {len(storm.get("cone", []))} pts, '
              f'history {len(storm["history"])} pts')
    return storms


# --------------------------------------------------------------------------
# Uncrewed assets


def latest_position(base: str, dataset_id: str) -> dict | None:
    """Recent track plus the newest fix.

    Asked server-side for one point per hour: a saildrone reports about
    every minute, so five raw days is ~7000 rows per platform, while the
    hourly form is ~120 and draws identically. Gliders report per
    surfacing and are already sparse. Falls back to the last fix alone if
    a dataset rejects the decimation.
    """
    ds = urllib.parse.quote(dataset_id)
    since = (NOW - timedelta(days=HISTORY_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    q = (f'{base}/tabledap/{ds}.json?time,latitude,longitude'
         f'&time%3E={since}&orderByClosest(%22time/1hours%22)')
    rows = []
    try:
        rows = get_json(q, timeout=60)['table']['rows']
    except Exception:  # noqa: BLE001
        try:
            rows = get_json(
                f'{base}/tabledap/{ds}.json?time,latitude,longitude&orderByMax(%22time%22)',
                timeout=45,
            )['table']['rows']
        except Exception:  # noqa: BLE001 - skip datasets that error entirely
            return None

    clean = [r for r in rows if r[1] is not None and r[2] is not None]
    if not clean:
        return None
    clean.sort(key=lambda r: r[0] or '')
    last = clean[-1]
    # ~110 m precision, plenty for a track line and much smaller on the wire
    track = [[round(float(r[2]), 3), round(float(r[1]), 3)] for r in clean]
    # drop consecutive duplicates left by rounding
    thinned = [track[0]]
    for p in track[1:]:
        if p != thinned[-1]:
            thinned.append(p)
    return {
        'time': last[0],
        'lat': round(float(last[1]), 4),
        'lon': round(float(last[2]), 4),
        'track': thinned if len(thinned) > 1 else [],
    }


def collect_erddap(base: str, kind: str, match: re.Pattern | None = None) -> list[dict]:
    fields = 'datasetID,title,institution,minTime,maxTime'
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
            # dataset start = when the platform went in the water
            'deployed': row[idx['minTime']],
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


def collect_argo() -> list[dict]:
    """One position per Argo float that has surfaced inside the window.

    ArgoFloats is a profile-level dataset — every profile ever taken — so
    the work is done server-side: filter to the window, then
    orderByMax("platform_number,time") collapses it to the newest profile
    per float. Roughly two thousand come back, about half the fleet, because
    a float cycles every ten days and the window is shorter than that.

    No tracks: at this cadence most floats have exactly one fix in the
    window, so there is nothing to draw a line through.
    """
    since = (NOW - timedelta(days=HISTORY_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    query = (f'{IFREMER}/tabledap/ArgoFloats.json'
             f'?platform_number,time,latitude,longitude'
             f'&time%3E={since}&orderByMax(%22platform_number,time%22)')
    try:
        table = get_json(query, timeout=300)['table']
    except Exception as exc:  # noqa: BLE001 - a dead source must not fail the run
        print(f'! Argo unavailable: {exc}', file=sys.stderr)
        return []

    cols = table['columnNames']
    idx = {c: cols.index(c) for c in cols}
    floats = []
    for row in table['rows']:
        try:
            lat = float(row[idx['latitude']])
            lon = float(row[idx['longitude']])
        except (TypeError, ValueError):
            continue
        floats.append({
            'id': row[idx['platform_number']],
            'lat': round(lat, 3),
            'lon': round(lon, 3),
            # Minute precision: these are surfacings, not a trajectory.
            'time': (row[idx['time']] or '')[:16] + 'Z',
        })
    floats.sort(key=lambda f: f['id'])
    print(f'  argo: {len(floats)} floats reporting within {HISTORY_DAYS} days')
    return floats


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
    print('argo:')
    argo = collect_argo()
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
        'historyDays': HISTORY_DAYS,
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

    # Keep the previous fleet if Ifremer was unreachable, rather than
    # blanking the layer.
    if argo or not ARGO_OUT.exists():
        ARGO_OUT.write_text(json.dumps({
            'updated': NOW.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'historyDays': HISTORY_DAYS,
            'source': 'Argo GDAC via Ifremer ERDDAP',
            'floats': argo,
        }, separators=(',', ':')) + '\n')
        print(f'wrote {ARGO_OUT} — {len(argo)} floats, '
              f'{ARGO_OUT.stat().st_size / 1024:.0f} KB')
    print(f'wrote {OUT} — {len(storms)} storms, {len(payload["assets"])} assets, '
          f'{OUT.stat().st_size / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
