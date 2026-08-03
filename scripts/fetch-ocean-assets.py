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

# Gliders are national, so one server does not see the fleet. These are the
# regional OceanGliders data endpoints that expose an ERDDAP — taken from the
# European Glider Community's data-management page, then checked one by one
# for a working allDatasets listing and a fetchable position.
#
# The match pattern is per server because they name things differently. IOOS
# is a glider-only assembly centre, so everything on it counts. OTN and BODC
# carry other kinds of data and say "glider"/"slocum"/"seaglider" in the
# title. VOTO is glider-only in practice but titles its datasets with the
# glider's *name* — "CarsonSHW003-20260731T0901" — so the naming convention
# for a near-real-time mission is what identifies one there.
#
# Not included, and why. Coriolis *does* have a machine endpoint — the
# OceanGliders GDAC, dataset OceanGlidersGDACTrajectories on the same Ifremer
# ERDDAP the Argo positions come from — but it is delayed mode: measured on
# 2026-08-02 its newest fix anywhere was 2026-06-23, six weeks back, with 3
# gliders in the previous 45 days against 37 in 180. Right source for
# finished missions, wrong one for a live map. Australia's IMOS routes through
# the AODN portal and erddap.aodn.org.au does not resolve.
#
# If those two matter, the lead worth following is the OceanOPS platform API
# (ocean-ops.org/api/1/data/platform), which knows all 3,949 OceanGliders
# platforms and is the network's own metadata hub — this map needs only an
# id, a position and a time, which is exactly what it holds. Its field names
# for last-known position were not obvious from a first pass.
GLIDERISH = re.compile(r'glider|slocum|seaglider|seaexplorer|spray', re.I)
GLIDER_SOURCES = [
    {'base': IOOS, 'where': 'US IOOS Glider DAC', 'match': None},
    {'base': 'https://linkedsystems.uk/erddap',
     'where': 'NOC / BODC, UK', 'match': GLIDERISH},
    {'base': 'https://erddap.oceantrack.org/erddap',
     'where': 'Ocean Tracking Network, Canada', 'match': GLIDERISH},
    {'base': 'https://erddap.observations.voiceoftheocean.org/erddap',
     'where': 'Voice of the Ocean, Sweden', 'match': re.compile(r'^nrt_')},
]

# The trailing window, and the single knob for it. Governs every asset the
# map draws: how much glider and USV track is fetched, how far back a storm's
# observed path is drawn, and how recently a dataset must have reported to
# count as active. Change it here and the whole map follows.
#
# Ten rather than five since 2026-08-03. Five days of a glider flying at
# half a knot is a short line — long enough to say where it is, too short to
# show where it has been working — and a mission runs for weeks. Ten gives a
# track with shape to it without reaching back into water the reader is no
# longer looking at.
#
# It moves storms as well, and that is the point of the knob being single:
# the NHC best track carries weeks and is trimmed to this window, so a storm
# now draws ten days of observed path instead of five. Nothing else had to
# change for that, which is the property worth keeping.
HISTORY_DAYS = 10

# Argo is the one platform this window does not suit, and the reason is the
# platform rather than the window. A glider reports hourly and a storm every
# six, so five days asks "where has it been lately" and gets an answer. A
# float surfaces once per **ten-day cycle**, so the same five days silently
# means "half the fleet is mid-dive, so leave it off the map" — measured
# against Ifremer on 2026-08-02: 1,992 floats in 5 days, 3,881 in 10, 4,138
# in 15, 4,293 in 30. The fleet is about 4,200; five days showed half of it.
#
# So Argo gets a full cycle plus slack, and follows HISTORY_DAYS whenever
# that is longer — the one-variable-moves-everything property still holds
# upward, it just cannot be dragged below a cycle without hiding floats that
# are perfectly active.
#
# Twelve rather than ten: a cycle is nominally ten days but floats drift late
# — ice avoidance, a missed satellite pass, a park depth that took longer to
# leave — and a window set exactly to the nominal cycle clips whichever tail
# of the fleet happens to be running behind. The measured curve pays for the
# extra two days: 3,881 floats at 10 days against 4,138 at 15, so most of
# what a longer window recovers arrives soon after the cycle, not much later.
ARGO_CYCLE_DAYS = 12
ARGO_DAYS = max(HISTORY_DAYS, ARGO_CYCLE_DAYS)
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
    """One position per Argo float that has surfaced inside ARGO_DAYS.

    ArgoFloats is a profile-level dataset — every profile ever taken — so
    the work is done server-side: filter to the window, then
    orderByMax("platform_number,time") collapses it to the newest profile
    per float.

    The window is a full cycle rather than HISTORY_DAYS; see ARGO_DAYS. At
    ten days about four thousand come back, which is the fleet. At five it
    was two thousand, and the missing half were not inactive — they were
    underwater, which is where a working float spends nine days in ten.

    No tracks: even over a cycle most floats have one or two fixes, so there
    is nothing to draw a line through.
    """
    since = (NOW - timedelta(days=ARGO_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
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
    print(f'  argo: {len(floats)} floats reporting within {ARGO_DAYS} days')
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

    # One server per region, and a dead one costs only its own gliders:
    # collect_erddap already returns [] rather than raising.
    gliders = []
    seen: set[str] = set()
    for source in GLIDER_SOURCES:
        found = collect_erddap(source['base'], 'glider', source['match'])
        for g in found:
            # Dataset ids are unique per server, not across them.
            key = f"{source['base']}|{g['id']}"
            if key in seen:
                continue
            seen.add(key)
            gliders.append({**g, 'where': source['where']})
        print(f"    via {source['where']}: {len(found)}")

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
            'historyDays': ARGO_DAYS,
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
