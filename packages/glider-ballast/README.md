# @c4po/glider-ballast

Ballasting an underwater glider against TEOS-10 in-situ density.

Built for the calculator at
[oceansensing.org/data/glider-ballast/](https://oceansensing.org/data/glider-ballast/),
and kept as a package for the same reason `@c4po/teos10` is one: it imports no
DOM and no framework, so it runs in a browser, in Node, and in a native port.

```ts
import { ballast, VEHICLES } from '@c4po/glider-ballast';

const report = ballast({
  hull: VEHICLES[0].hull,
  tank: { name: 'Tank', sa: 0.5, t: 20, p: 0 },
  water: [
    { name: 'Surface', sa: 35.5, t: 24, p: 0 },
    { name: 'Mixed layer', sa: 35.6, t: 19, p: 40 },
    { name: 'Bottom inflection', sa: 35.1, t: 6, p: 1000 },
  ],
  neutralAt: 1,
});

report.ballastChange;   // grams of lead to add; negative takes it out
report.tankBuoyancy;    // what it should then read in the tank
report.neutralDensity;  // the in-situ density it ends up neutral at
report.surfaceMargin;   // grams in hand with the pump fully out, at the top
report.diveMargin;      // and fully in, at the bottom — wants to be negative
```

## One equation

`B = rho(SA, t, p) * V(t, p) - m`: buoyancy is the weight of the water
displaced less the weight of the vehicle. Density comes from `@c4po/teos10`;
volume comes from the hull's own compressibility and thermal expansion.

**Nothing here asks which way buoyancy moves with depth.** That depends on
whether the hull compresses more or less per dbar than seawater does, which is
a property of the vehicle and not a fact about gliders — so rho and V are
evaluated separately at each point and subtracted. The report *states* the
answer for the caller's own numbers, in grams per 100 dbar, rather than
leaving it to a rule of thumb.

## The Absolute Salinity is the caller's problem

Each `Water` point arrives already resolved to `(SA, t, p)`. That keeps the
network — the salinity anomaly atlas — out of this package. The web page
routes its inputs through `@c4po/teos10`'s own `evaluate()`, which is what
lets an operator enter a conductivity and a depth instead.

## The shipped vehicles are stand-ins

Four families are offered and **not one carries manufacturer data**. Each mass
is a round figure in the range these vehicles occupy, each volume is that mass
over 1025 kg/m^3, and both hull coefficients are order-of-magnitude. A ballast
figure computed from a stand-in compressibility is wrong by an amount nothing
can show, so every one is flagged `illustrative: true` and the page carries a
caution that `test:ballast-page` checks is visible for all of them.

Adding a real one — mass, volume and both coefficients off an actual ballast
sheet — is a data change: a new entry with `illustrative: false`, and the
caution stops.

## Checked

`npm run test:ballast` holds the arithmetic to identities (ballasting for a
point makes it neutral there; a tank reading round-trips to a mass and back),
to TEOS-10's own compressibility for the depth slope, and to sums anybody can
redo on paper. There is no reference implementation for this the way there is
for the equation of state, and the gate is shaped by that.

## Not a map

`scripts/test-map.mjs` carries a named list of everything under `packages/`,
so a new one is a decision rather than an oversight. This is listed there as
*not a map*.
