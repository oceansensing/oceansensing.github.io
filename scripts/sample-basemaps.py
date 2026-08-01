#!/usr/bin/env python3
"""Sample the ocean colours of each basemap the map offers.

    python3 scripts/sample-basemaps.py

Writes src/data/basemap-ocean.json, which scripts/test-contrast.mjs then
checks every map feature colour against. Committed rather than fetched, so
the contrast gate needs no network in CI.

Only ocean pixels are kept: the map's vector features and current particles
sit over water, and land contrast is irrelevant to them. Water is picked out
by being blue-dominant, which holds for both basemaps.

Needs Pillow. Run it by hand when a basemap is added or swapped — not part
of the build.
"""

from __future__ import annotations

import collections
import io
import json
import pathlib
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'data' / 'basemap-ocean.json'
UA = {'User-Agent': 'oceansensing.org basemap sampler (github.com/oceansensing)'}

ESRI = ('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/'
        'World_Ocean_Base/MapServer/tile/{z}/{y}/{x}')
GEBCO = 'https://wms.gebco.net/mapserv?'

# Tiles spanning open ocean, shelf and the Gulf Stream, where the features
# actually get drawn.
ESRI_TILES = [(4, 5, 4), (4, 6, 4), (4, 6, 5), (5, 11, 9), (5, 12, 9), (3, 3, 2)]
# Same regions, as WMS bounding boxes (south, west, north, east).
GEBCO_BOXES = [(20, -90, 50, -50), (5, -80, 35, -40), (10, -60, 40, -20)]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def gebco_url(south: float, west: float, north: float, east: float) -> str:
    query = urllib.parse.urlencode({
        'service': 'WMS', 'version': '1.3.0', 'request': 'GetMap',
        'layers': 'GEBCO_LATEST', 'styles': '', 'crs': 'EPSG:4326',
        'bbox': f'{south},{west},{north},{east}',
        # 256 rather than 512: GEBCO renders these on demand and is slow,
        # and a colour histogram needs no more resolution than this.
        'width': 256, 'height': 256, 'format': 'image/png',
    })
    return GEBCO + query


def ocean_colours(images: list[bytes], keep: int = 12) -> list[dict]:
    """The most common water colours, each with the share of water it covers.

    Water is blue-dominant in both basemaps, which separates it from land
    cleanly enough — Esri's land is beige and green, GEBCO's is grey.

    The shares matter: GEBCO paints shallow banks a pale mint that is only
    about a twelfth of its water but sits far from its deep navy. Without
    weights a gate cannot tell "invisible over most of the ocean" from
    "invisible over one uncommon tone".
    """
    from PIL import Image  # imported late so the module docstring can be read without Pillow

    counts: collections.Counter = collections.Counter()
    for blob in images:
        im = Image.open(io.BytesIO(blob)).convert('RGB')
        im.thumbnail((160, 160))
        for r, g, b in im.getdata():
            if b > r + 10:
                # Round to 8 levels per channel so near-identical shades pool
                # into one entry instead of splitting the histogram.
                counts[(r // 32 * 32 + 16, g // 32 * 32 + 16, b // 32 * 32 + 16)] += 1

    total = sum(counts.values()) or 1
    out = []
    for (r, g, b), n in counts.most_common(keep):
        if n / total < 0.01:      # ignore slivers
            break
        out.append({'colour': f'#{r:02x}{g:02x}{b:02x}', 'share': round(n / total, 4)})
    return out


def main() -> int:
    print('Esri Ocean…')
    esri = [fetch(ESRI.format(z=z, y=y, x=x)) for z, y, x in ESRI_TILES]
    print('GEBCO…')
    gebco = [fetch(gebco_url(*box)) for box in GEBCO_BOXES]

    payload = {
        '_comment': ('Representative ocean colours per basemap with the share of water each covers, checked against by scripts/test-contrast.mjs. Regenerate with: npm run data:basemaps (GEBCO renders its WMS on demand and can take several minutes). Only blue-dominant water pixels are counted — features are drawn over water, so land contrast is moot.'),
        'basemaps': {
            'Bathymetry (Esri Ocean)': {'tone': 'light', 'ocean': ocean_colours(esri)},
            'Bathymetry (GEBCO)': {'tone': 'dark', 'ocean': ocean_colours(gebco)},
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + '\n')
    for name, info in payload['basemaps'].items():
        top = ' '.join(f'{o["colour"]}({o["share"]:.0%})' for o in info['ocean'][:5])
        print(f'  {name}: {len(info["ocean"])} colours — {top}')
    print(f'wrote {OUT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
