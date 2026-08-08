#!/usr/bin/env python3
"""Record what dbdreader says about the fixture files, for test:slocum to check.

    npm run data:slocum-fixture

Run by hand on a machine with the reference libraries installed:

    python3 -m pip install -r scripts/requirements-slocum.txt

WHY A FIXTURE AND NOT A DEPENDENCY
----------------------------------
Same bargain `make-teos10-fixture.py` strikes. The Slocum binary format is
undocumented by its vendor and every reader of it is a reimplementation of
`dbd2asc`; the only honest way to know ours is right is to compare against one
that is already trusted. But CI here installs one Python package for one
pipeline, and adding numpy and scipy so a JavaScript test can run is the wrong
shape. So the reference answers are recorded once, committed, and checked on
every build with no network and no Python.

`dbdreader` is the reference because `SlocumIO.jl` — the Julia decoder this
package is ported from — was itself validated against it, byte for byte over
the float64 result arrays. Checking against dbdreader therefore checks against
both.

WHAT IS RECORDED, AND WHY THAT SHAPE
------------------------------------
Everything, for every parameter in both files: the ASCII header, the active
sensor list in cycle order with units and byte sizes, and for each sensor a
SHA-256 over the raw IEEE-754 bytes of its time and value arrays.

A fingerprint rather than the values themselves because there are 78 sensors
over some 3,700 cycles and the values are the point: a summary that rounded
would pass for a decoder that was slightly wrong, which is the one failure
this format invites. A handful of values are recorded alongside in full
precision anyway — not to check, but so a failure says *what* differs rather
than only that something does.

NaN is canonicalised to one bit pattern before hashing. A NaN payload is not
specified by IEEE-754 and there is no reason for Python's and V8's to agree;
without this the fingerprints would differ over data that matched.

LAT/LON IS RECORDED TWICE
-------------------------
Slocum encodes position as NMEA `DDDMM.MMMM` and dbdreader converts it to
decimal degrees on the way out. Both forms are recorded — raw with
`decimalLatLon=False`, converted with it on — so the conversion is gated as a
separate step from the decode rather than folded into it. A decoder that got
the decode right and the conversion wrong would otherwise pass.

THE COMPRESSED CACHE
--------------------
`.ccc` cache files are LZ4 blocks and dbdreader does not read them, so the
reference for that path is the `lz4` package instead: the decompressed bytes
are fingerprinted directly. Two independent implementations of a published
block format, which is all that check needs to be.
"""

import hashlib
import json
import os
import struct
import sys

try:
    import numpy as np
    import dbdreader
except ImportError:
    sys.exit('needs dbdreader and numpy: '
             'python3 -m pip install -r scripts/requirements-slocum.txt')

try:
    import lz4.block
except ImportError:
    sys.exit('needs lz4 for the compressed-cache reference: '
             'python3 -m pip install -r scripts/requirements-slocum.txt')

DIR = 'scripts/fixtures/slocum'
OUT = os.path.join(DIR, 'reference.json')

# One matched flight/science segment from the electa MARACOOS deployment
# (VIMS/C4PO, May 2025). Segment 169 rather than any other because it is a
# genuine dive — 853 CTD samples reaching 125 dbar — so the recorded values
# span a real profile instead of a surface interval where nothing moves.
DATA = ['electa-2025-120-1-169.sbd', 'electa-2025-120-1-169.tbd']

# Not referenced by either data file: this deployment's compressed caches are
# left over from an earlier one. It is here to exercise the LZ4 path, which
# has no other fixture, and a cache file is self-describing enough to check.
COMPRESSED = '63231de3.ccc'

# The canonical quiet NaN. See the module docstring.
CANONICAL_NAN = struct.pack('<d', float('nan'))


def fingerprint(values):
    """SHA-256 over float64 little-endian bytes, with NaN canonicalised."""
    h = hashlib.sha256()
    for v in values:
        h.update(CANONICAL_NAN if v != v else struct.pack('<d', float(v)))
    return h.hexdigest()


def sample(values, n=3):
    """First and last few, in full precision, for diagnosing a mismatch."""
    vals = [None if v != v else float(v) for v in values]
    if len(vals) <= 2 * n:
        return {'all': vals}
    return {'first': vals[:n], 'last': vals[-n:]}


def read_file(path, cachedir):
    dbd = dbdreader.DBD(path, cacheDir=cachedir)

    # The sensor list as the reference implementation sees it: cycle order,
    # which is what the state bytes index into.
    sensors = [
        {'name': name,
         'unit': dbd.parameterUnits.get(name, ''),
         'bytes': int(size)}
        for name, size in zip(dbd.parameterNames, dbd.byteSizes)
    ]

    header = {k: v for k, v in dbd.headerInfo.items() if k != 'parameter_list'}

    params = {}
    for name in dbd.parameterNames:
        # Raw: no NMEA conversion, no dropping of out-of-range positions. This
        # is the decode alone, which is what the decoder is being checked on.
        t, v = dbd.get(name, decimalLatLon=False, discardBadLatLon=False)
        params[name] = {
            'n': int(len(t)),
            'time': fingerprint(t),
            'value': fingerprint(v),
            'sampleTime': sample(t),
            'sampleValue': sample(v),
        }

    # And again for the position sensors, converted, so the NMEA step is
    # gated on its own.
    latlon = {}
    for name in dbd.parameterNames:
        if not dbd._is_latlon_parameter(name):
            continue
        t, v = dbd.get(name, decimalLatLon=True, discardBadLatLon=False)
        latlon[name] = {
            'n': int(len(t)),
            'value': fingerprint(v),
            'sampleValue': sample(v),
        }

    return {
        'header': header,
        'sensors': sensors,
        'params': params,
        'latlon': latlon,
    }


def read_compressed(path):
    """Decompress a stream of (2-byte big-endian length, LZ4 block) pairs."""
    raw = open(path, 'rb').read()
    out = bytearray()
    i = 0
    while i + 2 <= len(raw):
        size = (raw[i] << 8) | raw[i + 1]
        i += 2
        if size == 0:
            break
        block = raw[i:i + size]
        if len(block) != size:
            sys.exit('%s: truncated block at %d' % (path, i))
        i += size
        # Each block decompresses to at most 32 KiB.
        out += lz4.block.decompress(block, uncompressed_size=32 * 1024)
    return bytes(out)


def main():
    if not os.path.isdir(DIR):
        sys.exit('run from the repository root: %s not found' % DIR)

    out = {
        'dbdreader': dbdreader.__version__,
        'files': {},
    }

    for name in DATA:
        path = os.path.join(DIR, name)
        if not os.path.exists(path):
            sys.exit('missing fixture: %s' % path)
        out['files'][name] = read_file(path, DIR)
        n = len(out['files'][name]['sensors'])
        print('%-28s %3d sensors' % (name, n))

    blob = read_compressed(os.path.join(DIR, COMPRESSED))
    out['compressed'] = {
        name_: value for name_, value in (
            ('file', COMPRESSED),
            ('bytes', len(blob)),
            ('sha256', hashlib.sha256(blob).hexdigest()),
            # So a failure can say how the text differs, not just that it does.
            ('head', blob[:120].decode('ascii', 'replace')),
            ('lines', blob.decode('ascii', 'replace').count('\n')),
        )
    }
    print('%-28s %d bytes decompressed' % (COMPRESSED, len(blob)))

    with open(OUT, 'w') as fp:
        json.dump(out, fp, indent=1, sort_keys=True)
        fp.write('\n')
    print('wrote %s (%.1f KB)' % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    main()
