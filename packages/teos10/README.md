# @c4po/teos10

TEOS-10 seawater thermodynamics, evaluated from the Gibbs function.

Written for the seawater calculator at
[oceansensing.org/data/seawater/](https://oceansensing.org/data/seawater/),
and kept as a package for the same reason `@c4po/ocean-map` is one: it imports
no DOM, no framework and no renderer, so it runs in a browser, in Node, and in
a native port with only the drawing reimplemented.

```ts
import { evaluate } from '@c4po/teos10';

const r = evaluate({
  salinityKind: 'SP', salinity: 35,
  temperatureKind: 't', temperature: 10,
  pressureKind: 'p', pressure: 1000,
});
r.sa;      // 35.16504 g/kg
r.groups;  // every property, grouped, labelled and with units
r.notes;   // "No position, so Absolute Salinity is Reference Salinity…"
```

Or reach for one property directly:

```ts
import { density, soundSpeed, freezingTemperature } from '@c4po/teos10';

density(35.16504, 10, 1000);            // 1031.4328 kg/m^3
soundSpeed(35.16504, 10, 1000);         // 1506.1361 m/s
freezingTemperature(35.16504, 0, 0);    // -1.9191 degC
```

## Why the Gibbs function and not the polynomial

The GSW toolbox evaluates most properties from a 75-term polynomial fitted to
specific volume. It is fast and accurate to about a part in 10^6, and it is
the right default for a model.

This evaluates the Gibbs function itself — IAPWS-09 for pure water, IAPWS-08
for the salt — and takes the analytic derivatives. Density is `1 / g_P`; sound
speed, heat capacity, entropy and the expansion coefficients are two or three
symbols of the same function. So every property is thermodynamically
consistent with every other one *by construction* rather than to within a
fit's residual, which is what a calculator is for.

Two things have no exact form, and each says so on its own row: spiciness,
which *is* defined as a polynomial, and the reference column the depth
conversion is built on, which TEOS-10 itself defines that way.

## Modules

| file | what is in it |
| --- | --- |
| `constants.ts` | the defined constants, written out rather than derived |
| `gibbs.ts` | `gibbs(ns, nt, np, SA, t, p)` — IAPWS-09 + IAPWS-08 |
| `gibbs-ice.ts` | the same for ice Ih (IAPWS-06), complex-valued |
| `properties.ts` | everything that follows from those two |
| `temperature.ts` | in-situ, potential and Conservative temperature |
| `salinity.ts` | PSS-78, and SP ↔ SA ↔ SR ↔ S\* |
| `depth.ts` | height, pressure and gravity |
| `atlas.ts` | the Absolute Salinity Anomaly lookup — the one impure module |
| `contour.ts` | marching squares, for a T–S diagram's density contours |
| `index.ts` | `evaluate()`, and the labels and units a caller renders |

## The coefficients are transcribed by machine

There are some two thousand numeric literals in `gibbs.ts` alone. A single
mistyped digit changes an answer by an amount no reviewer can see and no
reader would question, so none of them was typed: they are converted by rule
from GSW-C's `gsw_oceanographic_toolbox.c`, and **must not be edited by
hand**.

What guards them is `npm run test:teos10`, which has three kinds of check:

1. **Against the reference.** Every function at twenty-four points spanning
   the domain and sitting on its edges, compared with GSW to 1e-11.
2. **Against calculus.** Every derivative branch against a central difference
   of the branch below it, over a few thousand states. `g_TT` has to be the
   temperature derivative of `g_T`, and `g_T` of `g` — so a wrong digit
   anywhere breaks the chain at the point it sits in, which the fixture's
   twenty-four points could not reach.
3. **Against physics.** Pure water densest at 3.98 °C; Standard Seawater
   freezing at −1.919 °C; sound at 1534 m/s.

Mutation-tested: a transposed pair of digits, a dropped digit, a flipped
sign, a disabled `log` guard and a sign error in the ice arithmetic are all
caught. A change in a coefficient's *last* digit is not, and no threshold
could see it — 1e-15 of a coefficient multiplied by a normalised pressure
moves the answer less than the order the terms are summed in does.

## The Absolute Salinity Anomaly needs a position, and a file

TEOS-10's headline change over EOS-80 is that density depends on what the salt
is made of. That correction was measured, not derived, and lives in a global
lookup table — so `saFromSP` needs a longitude and a latitude, and an atlas.

The atlas is **passed in**, never imported, which is what keeps `salinity.ts`
free of the network. Without one, every function that needs it returns NaN
rather than quietly handing back Reference Salinity under Absolute Salinity's
name; `evaluate` turns that into a note the page shows.

```ts
import { loadAtlas, saFromSP } from '@c4po/teos10';

const atlas = await loadAtlas('/teos10/saar.bin.gz');
saFromSP(35, 2000, 200, 30, atlas);   // 35.1863 g/kg, +0.021 on SR
```

`scripts/make-saar-atlas.py` builds that file and verifies its own extraction
against the reference implementation before writing — 188 KB gzipped, and
fetched only when a reader supplies a position.

## Not a map

`scripts/test-map.mjs` carries a named list of everything under `packages/`,
so that a new one is a decision rather than an oversight. This is listed there
as *not a map*: it draws nothing, imports no renderer, and is gated by
`npm run test:teos10` instead.

## Credits

TEOS-10 is the work of SCOR/IAPSO Working Group 127, published by IOC, SCOR
and IAPSO (2010) — [teos-10.org](https://www.teos-10.org/). The reference
implementation is the Gibbs SeaWater (GSW) Oceanographic Toolbox
([GSW-C](https://github.com/TEOS-10/GSW-C)). The Gibbs functions are IAPWS-09,
IAPWS-08 and IAPWS-06, released by the International Association for the
Properties of Water and Steam. None of them publishes this package; the errors
are ours.
