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

**Nothing**, and that is the resting state. `diff -r packages/ocean-map
packages/ocean-map-dev` shows only this README and `package.json`.

Two experiments have graduated from here, which is what success looks like:

- **Runtime particle colours** — now `packages/ocean-map/contrast.ts`, gated
  by `test:contrast` over every background the map can present.
- **Sea ice** — concentration from both sources and thickness, together with
  `drawAbove`, the floor below which a scalar paints nothing. That floor was
  the open question while it sat here: right for ice and wrong for
  temperature, so whether it generalised or was ice-shaped had to be seen. It
  generalises as an opt-in per field, which is how it shipped.

One thing was tried here and **thrown away rather than promoted**: the 15%
ice edge, drawn as linework. It earned its place only while the concentration
raster was coarse; once that reached native resolution the edge was drawing
the boundary of a field already on screen, and a contour can never be finer
than the grid it is cut from. Not every experiment graduates, and this is the
shape of one that should not have.

The next candidate is polar stereographic, scoped in the repo's `PLAN.md` and
deliberately not started.

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
