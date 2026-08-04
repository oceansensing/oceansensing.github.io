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

**Sea ice.** Two concentration layers — the OISST analysis and the ESPC
forecast — plus the 15% edge as linework in its own pane. The data comes from
the shared pipelines like everything else; what is being tried here is how to
draw a field that covers a tenth of the ocean rather than all of it, which is
the first scalar on this map that is mostly absent.

Two things in it may or may not deserve promotion, and that is the question:
`drawAbove`, a floor below which a scalar paints nothing, and a range pinned
to the whole scale rather than to the view. Both are right for ice and both
would be wrong for temperature, so the interesting part is whether they
generalise or are ice-shaped.

The previous experiment, runtime particle colours, **graduated** — it is in
`packages/ocean-map/contrast.ts` now, gated by `test:contrast` over every
background the map can present.

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
