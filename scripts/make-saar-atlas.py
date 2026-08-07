#!/usr/bin/env python3
"""Build the Absolute Salinity Anomaly atlas the seawater calculator reads.

    npm run data:saar

Run once, by hand, on a machine with the GSW reference library installed:

    python3 -m pip install gsw

The output is committed. Like the isobaths, this is static data — the atlas
is a published table that has not changed since TEOS-10 was adopted in 2010 —
so there is nothing to refresh and no workflow to run it. It is here so the
file can be rebuilt and, more to the point, so its provenance is a script
rather than a memory.

WHY THIS EXISTS AT ALL
----------------------
TEOS-10's headline change over EOS-80 is that density depends on the
*composition* of the salt, not only on how much conductivity it carries. The
correction is the Absolute Salinity Anomaly, and it is not computable — it was
measured, and it lives in a global lookup table. SA_from_SP is the first line
of nearly every GSW session, so a TEOS-10 calculator without it would be
missing the point of TEOS-10.

Its size is why it is fetched rather than bundled: 185 KB gzipped, and only a
reader who enters a position pays for it.

WHERE THE NUMBERS COME FROM
---------------------------
The reference table is not distributed as data — GSW compiles it into its
extension module — so it is read back out of that binary. Three arrays are
located by searching for the exact bytes of the longitude axis, which is an
unmistakable run of 91 doubles from 0 to 360 in steps of 4; the latitude axis
and the seafloor-level counts follow it contiguously, and the anomaly table
follows those.

**That is a guess until it is checked, and the check is the point.** This
script reimplements the GSW lookup on the extracted arrays and compares it
against gsw.SAAR itself at 30,000 random positions. A wrong offset does not
produce plausible numbers; it produces garbage, and the comparison refuses to
write. Measured on gsw 3.6.20: agreement to 2e-19, which is summation order.
"""

import gzip
import math
import os
import struct
import sys

try:
    import numpy as np
    import gsw
except ImportError:
    sys.exit('needs numpy and gsw: python3 -m pip install gsw')

OUT = 'public/teos10/saar.bin.gz'

# The lattice GSW publishes the anomaly on: 4 degrees square, 45 levels.
NX, NY, NZ = 91, 45, 45

# Quantisation of the stored anomaly ratio. 1e-7 in SAAR is 3.5e-6 g/kg in
# Absolute Salinity — four orders of magnitude below the last digit the
# calculator prints, and it halves the file against float32.
QUANTUM = 1e-7
NO_DATA = -32768

# GSW writes "no value" as 9e90 rather than NaN, and tests for it at 1e10.
SENTINEL = 1e10

MAGIC = b'SAAR'
VERSION = 1


def find_arrays():
    """Locate and read the three reference arrays inside the GSW extension."""
    directory = os.path.dirname(gsw.__file__)
    candidates = [
        os.path.join(directory, f)
        for f in os.listdir(directory)
        if f.startswith('_gsw_ufuncs') and (f.endswith('.so') or f.endswith('.pyd'))
    ]
    if not candidates:
        sys.exit(f'no compiled gsw extension found in {directory}')

    longs = np.arange(0, 361, 4.0)
    lats = np.arange(-86, 91, 4.0)

    for path in candidates:
        raw = np.fromfile(path, dtype=np.uint8).tobytes()
        at = raw.find(longs.tobytes())
        if at < 0:
            continue
        # lats_ref, then ndepth_ref, then saar_ref, each immediately after the
        # last. The layout is checked by the comparison at the end, not here.
        lat_at = at + NX * 8
        if raw[lat_at:lat_at + NY * 8] != lats.tobytes():
            continue
        ndepth_at = lat_at + NY * 8
        saar_at = ndepth_at + NY * NX * 8
        ndepth = np.frombuffer(raw, np.float64, NY * NX, ndepth_at).copy()
        saar = np.frombuffer(raw, np.float64, NZ * NY * NX, saar_at).copy()
        # p_ref sits in a different section; find it as the only ascending run
        # of 45 doubles that starts at 0 and ends in the thousands.
        doubles = np.frombuffer(raw, np.float64, len(raw) // 8)
        p_ref = None
        for i in np.flatnonzero(doubles[:-NZ] == 0.0):
            w = doubles[i:i + NZ]
            if np.all(np.isfinite(w)) and np.all(np.diff(w) > 0) and 4000 < w[-1] < 9000:
                p_ref = w.copy()
                break
        if p_ref is None:
            continue
        return path, longs, lats, p_ref, ndepth, saar

    sys.exit('could not locate the reference arrays; gsw may have been rebuilt')


# ---- the GSW lookup, on the extracted arrays ------------------------------
# Reimplemented here only so the extraction can be checked. The shipped copy
# is packages/teos10/atlas.ts, and the two must agree — which is what the
# comparison below establishes for this one, and what test:teos10 establishes
# for that one.

LONGS_PAN = [260.00, 272.59, 276.50, 278.65, 280.73, 292.0]
LATS_PAN = [19.55, 13.97, 9.60, 8.10, 9.33, 3.4]
DELI = (0, 1, 1, 0)
DELJ = (0, 0, 1, 1)


def _indx(x, z):
    n = len(x)
    if z <= x[0]:
        return 0
    if z >= x[n - 1]:
        return n - 2
    return min(max(int(np.searchsorted(x, z, side='right')) - 1, 0), n - 2)


def _pan_lat(lon):
    k = _indx(LONGS_PAN, lon)
    r = (lon - LONGS_PAN[k]) / (LONGS_PAN[k + 1] - LONGS_PAN[k])
    return LATS_PAN[k] + r * (LATS_PAN[k + 1] - LATS_PAN[k])


def saar_at(longs, lats, p_ref, ndepth, saar, p, lon, lat):
    if lat < -86.0 or lat > 90.0:
        return math.nan
    lon = lon % 360.0

    dlong = longs[1] - longs[0]
    dlat = lats[1] - lats[0]

    ix = min(int(math.floor((NX - 1) * (lon - longs[0]) / (longs[NX - 1] - longs[0]))), NX - 2)
    iy = min(int(math.floor((NY - 1) * (lat - lats[0]) / (lats[NY - 1] - lats[0]))), NY - 2)

    deepest = -9e99
    for k in range(4):
        nd = ndepth[iy + DELJ[k] + (ix + DELI[k]) * NY]
        if 0.0 < nd < SENTINEL:
            deepest = max(deepest, nd)
    if deepest == -9e99:
        return 0.0

    p = min(p, p_ref[int(deepest) - 1])
    iz = _indx(p_ref, p)

    r1 = (lon - longs[ix]) / (longs[ix + 1] - longs[ix])
    s1 = (lat - lats[iy]) / (lats[iy + 1] - lats[iy])
    t1 = (p - p_ref[iz]) / (p_ref[iz + 1] - p_ref[iz])

    in_pan = (LONGS_PAN[0] <= lon <= LONGS_PAN[-1] and LATS_PAN[-1] <= lat <= LATS_PAN[0])

    def corners(dz):
        v = [saar[iz + dz + NZ * (iy + DELJ[k] + (ix + DELI[k]) * NY)] for k in range(4)]
        if in_pan:
            above0 = _pan_lat(lon) <= lat
            a, b = _pan_lat(longs[ix]), _pan_lat(longs[ix] + dlong)
            above = [a <= lats[iy], b <= lats[iy], b <= lats[iy] + dlat, a <= lats[iy] + dlat]
            keep = [x for k, x in enumerate(v) if abs(x) <= 100.0 and above0 == above[k]]
            mean = sum(keep) / len(keep) if keep else 0.0
            v = [mean if (abs(x) >= SENTINEL or above0 != above[k]) else x
                 for k, x in enumerate(v)]
        elif abs(sum(v)) >= SENTINEL:
            keep = [x for x in v if abs(x) <= 100.0]
            mean = sum(keep) / len(keep) if keep else 0.0
            v = [mean if abs(x) >= SENTINEL else x for x in v]
        return (1.0 - s1) * (v[0] + r1 * (v[1] - v[0])) + s1 * (v[3] + r1 * (v[2] - v[3]))

    upper = corners(0)
    lower = corners(1)
    if abs(lower) >= SENTINEL:
        lower = upper
    out = upper + t1 * (lower - upper)
    return math.nan if abs(out) >= SENTINEL else out


def main():
    path, longs, lats, p_ref, ndepth, saar = find_arrays()
    print(f'read the reference arrays from {os.path.basename(path)}')
    valid = saar < SENTINEL
    print(f'  {valid.sum():,} of {saar.size:,} lattice points carry an anomaly; '
          f'max {saar[valid].max():.6g}')

    rng = np.random.default_rng(11)
    n = 30000
    qlon = rng.uniform(-180, 360, n)
    qlat = rng.uniform(-86, 90, n)
    qp = rng.uniform(0, 7000, n)
    want = gsw.SAAR(qp, qlon, qlat)
    got = np.array([saar_at(longs, lats, p_ref, ndepth, saar, a, b, c)
                    for a, b, c in zip(qp, qlon, qlat)])

    disagree = np.flatnonzero(np.isfinite(want) != np.isfinite(got))
    if len(disagree):
        sys.exit(f'extraction is wrong: {len(disagree)} points differ on whether '
                 f'an anomaly exists at all')
    both = np.isfinite(want)
    worst = np.abs(got[both] - want[both]).max()
    print(f'  checked against gsw.SAAR at {n:,} random positions: worst {worst:.3e}')
    if worst > 1e-15:
        sys.exit('extraction is wrong: the lookup does not reproduce gsw.SAAR')

    quantised = np.where(valid, np.round(saar / QUANTUM), NO_DATA).astype('<i2')
    if quantised[valid].max() > 32767:
        sys.exit('QUANTUM is too fine for int16')
    depths = np.where(ndepth < SENTINEL, ndepth, 255).astype(np.uint8)

    header = struct.pack('<4sHHHHI d', MAGIC, VERSION, NX, NY, NZ, 0, QUANTUM)
    assert len(header) == 24, len(header)
    body = (header
            + longs.astype('<f8').tobytes()
            + lats.astype('<f8').tobytes()
            + p_ref.astype('<f8').tobytes()
            + depths.tobytes())
    body += b'\0' * (len(body) % 2)          # int16 needs an even offset
    body += quantised.tobytes()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    blob = gzip.compress(body, 9)
    with open(OUT, 'wb') as f:
        f.write(blob)
    print(f'wrote {OUT}: {len(body)/1024:.0f} KB raw, {len(blob)/1024:.0f} KB gzipped')


if __name__ == '__main__':
    main()
