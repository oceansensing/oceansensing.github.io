# ocean-map-dev

A **sandbox fork** of [`@c4po/ocean-map`](../ocean-map/). It draws
`/dev/visualization/` and nothing else. Production — `/visualization/` and
`/observations/hurricanes/` — is unaffected by anything in here.

## Why it exists

Some ideas cannot be tried in the production map, because the production map
is held to gates that the idea itself is questioning. A reader-facing colour
picker, for instance, deliberately breaks the rule that every colour on the
map has been checked against every background; there is nowhere in
`packages/ocean-map` for that to live even temporarily.

So this is the place to be wrong in. It is **not** held to `test:contrast` or
to the map assertions in `test:map` — see the exemption in each, which names
this directory rather than pattern-matching, so a second fork does not
silently inherit the licence.

It **is** built and type-checked, because a page that does not compile is not
an experiment, it is a broken deploy.

## What is being tried right now

**Particle colours chosen at runtime** — `contrast.ts` and the picker in the
legend row. Production proves two ramps offline against every background they
can meet; this measures the background it *actually* has and picks against
that, which matters most where the fixed choice is weakest: a ramp checked
against water was never checked against a colormap the reader turned on
afterwards, and over `cmo.matter` production's currents sit ΔE 3.1 from the
field they are drawn on.

The picker offers named colours rather than a wheel — a free picker lets a
reader choose one that hides the layer. The readout beside it prints the
measured clearance, so a poor choice says so instead of just looking wrong.

`contrast.ts` imports neither Leaflet nor the DOM, so it is testable in Node
like production's renderer-independent half, and `test:units` holds it to the
one claim the sandbox is *not* exempt from: asking for a colour returns that
colour. That check exists because the labels lied twice — see the comments in
`pickRamp`.

## How to read it

It started byte-identical to production apart from `package.json`. That is
deliberate and worth preserving:

```sh
diff -r packages/ocean-map packages/ocean-map-dev
```

is the experiment log. Keep it readable — if that diff stops being the answer
to "what are we trying?", the fork has stopped being useful.

## Getting a change back into production

Copy the change, not the file. Anything promoted has to satisfy the gates it
was exempt from here, and usually has to be argued for in `CLAUDE.md` as
well, because the production map's constants are measured decisions rather
than preferences.

## Re-syncing from production

```sh
rm -rf packages/ocean-map-dev
cp -R packages/ocean-map packages/ocean-map-dev
# then re-apply: package.json name, this README, and drop the hand-off docs
```

Cheap on purpose. A fork nobody dares refresh becomes a second codebase, and
this is meant to be a scratchpad.
