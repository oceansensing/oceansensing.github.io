#!/usr/bin/env python3
"""Record what the GSW reference implementation says, for test:teos10 to check.

    npm run data:teos10-fixture

Run by hand on a machine with the reference library installed:

    python3 -m pip install gsw

WHY A FIXTURE AND NOT A DEPENDENCY
----------------------------------
`packages/teos10` carries some two thousand transcribed coefficients, and the
only honest way to know they are right is to compare against the reference
implementation. But CI here installs one Python package for one pipeline and
nothing else, and adding a second so a JavaScript test can run is the wrong
shape. So the reference answers are recorded once, committed, and checked on
every build with no network and no Python.

WHAT IS IN IT, AND WHAT IS NOT
------------------------------
Twenty-four sample points, chosen to span the domain and to sit on its edges:
zero salinity, where the saline Gibbs function's `sqrt(SA)` term is singular
and its `log(x)` guard switches; the freezing point; 10,000 dbar; and 42 g/kg.
A mistyped coefficient moves essentially every point, so what this needs is
coverage of the *branches*, not of the space.

It deliberately does not try to cover the space, because `test:teos10` does
that a better way: it checks each derivative branch against a central
difference of the branch below it, across a few thousand points, which needs
no reference at all. The fixture anchors the value; the differencing anchors
everything built on it.
"""

import json
import os
import sys

try:
    import numpy as np
    import gsw
except ImportError:
    sys.exit('needs numpy and gsw: python3 -m pip install gsw')

OUT = 'scripts/fixtures/teos10/reference.json'

# (SA g/kg, t degC, p dbar). Spread over the domain, then its corners.
SAMPLES = [
    (35.16504, 10.0, 0.0),        # Standard Seawater at the surface
    (35.16504, 10.0, 1000.0),
    (34.7, 1.5, 4000.0),          # deep North Atlantic
    (34.0, -1.8, 50.0),           # near-freezing polar surface
    (36.5, 25.0, 0.0),            # subtropical gyre
    (38.5, 14.0, 2000.0),         # Mediterranean outflow
    (33.0, 28.0, 5.0),            # warm, fresh, tropical
    (30.0, 5.0, 100.0),
    (20.0, 15.0, 500.0),          # brackish
    (10.0, 20.0, 10.0),
    (2.0, 4.0, 0.0),              # the bottom of PSS-78's range
    (0.5, 12.0, 200.0),
    (0.0, 0.0, 0.0),              # pure water, the sqrt(SA) singularity
    (0.0, 25.0, 0.0),
    (0.0, 3.98, 0.0),             # pure water's density maximum
    (0.0, 40.0, 10000.0),
    (42.0, 40.0, 10000.0),        # every axis at its far edge
    (42.0, -2.0, 0.0),
    (35.16504, 40.0, 0.0),
    (35.16504, -2.0, 10000.0),
    (35.16504, 25.0, 10000.0),
    (1e-3, 10.0, 1000.0),         # just off zero, where the log term wakes up
    (39.0, 2.0, 6000.0),
    (34.5, 4.0, 3000.0),
]

# (SP, p, lon, lat). The last three sit in the places the lookup has special
# cases: the Panama barrier, the Baltic, and a position with no atlas coverage.
POSITIONS = [
    (35.0, 0.0, 200.0, 30.0),      # North Pacific, the largest anomaly
    (35.0, 2000.0, 200.0, 30.0),
    (34.9, 500.0, -30.0, 45.0),    # North Atlantic
    (34.7, 4000.0, -20.0, -50.0),  # Southern Ocean
    (36.0, 10.0, 15.0, 38.0),      # Mediterranean
    (34.5, 100.0, 120.0, 0.0),     # Indonesian throughflow
    (35.0, 50.0, 277.0, 10.0),     # inside the Panama barrier
    (8.0, 5.0, 20.0, 60.0),        # the Baltic, which has its own rule
    (35.0, 0.0, 0.0, 89.0),        # high Arctic
    (33.0, 20.0, 300.0, -70.0),
]

DERIVATIVES = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 2, 0),
               (1, 0, 1), (0, 1, 1), (1, 1, 0), (2, 0, 0), (0, 0, 2)]

ICE = [(-40.0, 0.0), (-20.0, 500.0), (-5.0, 2000.0), (-1.0, 0.0),
       (0.0, 100.0), (-30.0, 10000.0)]
ICE_DERIVATIVES = [(0, 0), (1, 0), (0, 1), (1, 1), (2, 0), (0, 2)]


def scalar(f, *args):
    """gsw returns 0-d arrays; JSON wants numbers, and NaN wants null."""
    v = float(f(*args))
    return None if not np.isfinite(v) else v


def main():
    sa = np.array([s[0] for s in SAMPLES])
    t = np.array([s[1] for s in SAMPLES])
    p = np.array([s[2] for s in SAMPLES])
    ct = gsw.CT_from_t(sa, t, p)
    pt0 = gsw.pt0_from_t(sa, t, p)

    def over(f, *args):
        return [scalar(f, *a) for a in zip(*args)]

    out = {
        'gsw': gsw.__version__,
        'samples': [list(s) for s in SAMPLES],
        'positions': [list(q) for q in POSITIONS],
        'iceSamples': [list(s) for s in ICE],
        'gibbs': {
            f'{ns}{nt}{np_}': over(lambda a, b, c, ns=ns, nt=nt, np_=np_:
                                   gsw.gibbs(ns, nt, np_, a, b, c), sa, t, p)
            for ns, nt, np_ in DERIVATIVES
        },
        'gibbsIce': {
            f'{nt}{np_}': [scalar(gsw._gsw_ufuncs.gibbs_ice, nt, np_, a, b) for a, b in ICE]
            for nt, np_ in ICE_DERIVATIVES
        },
        'properties': {
            'enthalpyIce': [scalar(gsw.enthalpy_ice, a, b) for a, b in ICE],
            'density': over(gsw.rho_t_exact, sa, t, p),
            'specificVolume': over(gsw.specvol_t_exact, sa, t, p),
            'enthalpy': over(gsw.enthalpy_t_exact, sa, t, p),
            'heatCapacity': over(gsw.cp_t_exact, sa, t, p),
            'thermalExpansion': over(gsw.alpha_wrt_t_exact, sa, t, p),
            'halineContraction': over(gsw.beta_const_t_exact, sa, t, p),
            'isentropicCompressibility': over(gsw.kappa_t_exact, sa, t, p),
            'soundSpeed': over(gsw.sound_speed_t_exact, sa, t, p),
            'chemPotentialWater': over(gsw.chem_potential_water_t_exact, sa, t, p),
            'dilutionCoefficient': over(gsw.dilution_coefficient_t_exact, sa, t, p),
            'freezingTemperature': over(lambda a, c: gsw.t_freezing(a, c, 0.0), sa, p),
            'freezingTemperatureSaturated': over(lambda a, c: gsw.t_freezing(a, c, 1.0), sa, p),
            'latentHeatMelting': over(gsw.latentheat_melting, sa, p),
            'latentHeatEvaporation': over(gsw.latentheat_evap_t, sa, pt0),
            'potentialDensity0': over(lambda a, b, c: gsw.pot_rho_t_exact(a, b, c, 0.0), sa, t, p),
            'potentialDensity2000': over(lambda a, b, c: gsw.pot_rho_t_exact(a, b, c, 2000.0), sa, t, p),
            'spiciness0': over(gsw.spiciness0, sa, ct),
            'spiciness1': over(gsw.spiciness1, sa, ct),
            'spiciness2': over(gsw.spiciness2, sa, ct),
        },
        'temperature': {
            'pt0FromT': over(gsw.pt0_from_t, sa, t, p),
            'ptFromT1000': over(lambda a, b, c: gsw.pt_from_t(a, b, c, 1000.0), sa, t, p),
            'ctFromT': over(gsw.CT_from_t, sa, t, p),
            'ctFromPT': over(gsw.CT_from_pt, sa, t),
            'ptFromCT': over(gsw.pt_from_CT, sa, ct),
            'tFromCT': over(gsw.t_from_CT, sa, ct, p),
            'ctMaxDensity': over(gsw.CT_maxdensity, sa, p),
        },
        'salinity': {
            'spFromC': over(lambda a, b, c: gsw.SP_from_C(a, b, c),
                            np.linspace(1.0, 60.0, len(SAMPLES)), t, p),
            'cFromSP': over(lambda a, b, c: gsw.C_from_SP(a, b, c),
                            np.linspace(0.5, 42.0, len(SAMPLES)), t, p),
            'srFromSP': over(gsw.SR_from_SP, np.linspace(0.0, 42.0, len(SAMPLES))),
        },
        'depth': {
            'zFromP': over(lambda a, b: gsw.z_from_p(a, b),
                           p, np.linspace(-80.0, 80.0, len(SAMPLES))),
            'pressureFromDepth': over(lambda a, b: gsw.p_from_z(a, b),
                                      -p / 1.02, np.linspace(-80.0, 80.0, len(SAMPLES))),
            'gravity': over(gsw.grav, np.linspace(-90.0, 90.0, len(SAMPLES)), p),
        },
        'atlas': {},
    }

    qsp = np.array([q[0] for q in POSITIONS])
    qp = np.array([q[1] for q in POSITIONS])
    qlon = np.array([q[2] for q in POSITIONS])
    qlat = np.array([q[3] for q in POSITIONS])
    qsa = gsw.SA_from_SP(qsp, qp, qlon, qlat)
    out['atlas'] = {
        'saar': over(gsw.SAAR, qp, qlon, qlat),
        'saFromSP': over(gsw.SA_from_SP, qsp, qp, qlon, qlat),
        'spFromSA': over(gsw.SP_from_SA, qsa, qp, qlon, qlat),
        'sstarFromSP': over(gsw.Sstar_from_SP, qsp, qp, qlon, qlat),
        'sstarFromSA': over(gsw.Sstar_from_SA, qsa, qp, qlon, qlat),
        'saFromSstar': over(gsw.SA_from_Sstar,
                            np.array(over(gsw.Sstar_from_SP, qsp, qp, qlon, qlat), dtype=float),
                            qp, qlon, qlat),
        'deltaSA': over(gsw.deltaSA_from_SP, qsp, qp, qlon, qlat),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out, f, indent=0)
        f.write('\n')
    n = sum(len(v) for section in out.values() if isinstance(section, dict)
            for v in section.values() if isinstance(v, list))
    print(f'wrote {OUT}: {n:,} reference values from gsw {gsw.__version__}, '
          f'{os.path.getsize(OUT)/1024:.0f} KB')


if __name__ == '__main__':
    main()
