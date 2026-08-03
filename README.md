# oceansensing.github.io

Website of **C4PO — the Collaboratory for Physical Oceanography** at the
Virginia Institute of Marine Science, live at
[oceansensing.org](https://oceansensing.org).

Built with [Astro](https://astro.build). Static output, and close to zero
client-side JavaScript — the exceptions are the theme toggle, the photo
shuffle and lightbox on observation pages, the asset map, and the UTC clock.
The map is the one heavyweight: gliders from four national data centres,
NOAA saildrones, the Argo array, animated currents at two depths,
sea-surface temperature and salinity, isobaths, a detailed coastline and EEZ
boundaries — with the colour scale, its range, the isobath opacity, the
forecast hour, and every layer under the reader's control.

It carries two pages. [`/visualization/`](https://oceansensing.org/visualization/)
is the general-purpose one and
[`/observations/hurricanes/`](https://oceansensing.org/observations/hurricanes/)
is framed around the storm season. They run the same engine off the same data
and differ only in their **preset** — which layers open, and where. Adding
another such page means one `.astro` file passing `layers` and `home` to
`AssetMap`.

It lives in **[`packages/ocean-map`](packages/ocean-map/)**, an npm workspace
package rather than a page component, so it can be used elsewhere: see its
[README](packages/ocean-map/README.md),
[EMBEDDING.md](packages/ocean-map/EMBEDDING.md) for another website, and
[PORTING-IOS.md](packages/ocean-map/PORTING-IOS.md) for the native app.
Anything added to it has to keep both of those viable —
[BOUNDARIES.md](packages/ocean-map/BOUNDARIES.md) says what that means.
Every push to `main` deploys automatically via GitHub Actions, and a scheduled
run rebuilds hourly to refresh the map data; the hurricane page picks that up
on its own without losing your place on the map.

## Editing content

All content lives in Markdown and data files — you never need to touch
layout code:

| To add…            | Edit…                                                        |
| ------------------ | ------------------------------------------------------------ |
| a publication      | paste its BibTeX entry into `src/data/publications.bib`       |
| a presentation     | new entry in `src/data/presentations.yaml` (type: invited / conference / workshop / outreach) |
| a news post        | new `.md` file in `src/content/news/`                         |
| a person           | new `.md` file in `src/content/people/`                       |
| a research project | new `.md` file in `src/content/projects/`                     |
| a past project     | set `status: completed` in the project's frontmatter — the Research page moves it to a "Past projects" section automatically |
| a dataset          | new entry in `src/data/datasets.yaml`                         |
| a software tool    | new entry in `src/data/software.yaml`                         |
| a significant observation | new `.md` file in `src/content/observations/` — add `map: assets` for the live asset map, or `surveys:` entries for dated photo panels |
| a CV item          | new entry in the matching `src/data/cv/<person>/*.yaml` file (grants, advising, service, …) — publications and presentations flow in automatically |
| a member's CV      | new directory `src/data/cv/<person-id>/` (id matching their file in `src/content/people/`) with any of the section files — their page appears at `/cv/<person-id>/` |

Site title, navigation, contact info, and the list of author names bolded on
the Publications page live in `src/config.ts`. Colors, fonts, and spacing
live in `src/styles/tokens.css`.

## Developing locally

```sh
npm install
npm run dev      # dev server at localhost:4321
npm run build    # production build into dist/
npm run verify   # everything CI checks, in one command
```

`npm run verify` builds, type-checks, checks the docs for drift, and runs the
map and clock test harnesses. **CI runs the same command and refuses to deploy
if it fails**, so running it before you push is the quickest way to find out
whether a change will publish.

The individual pieces, if you want one on its own:

```sh
npm run check         # type-check
npm run check:docs    # docs reference real scripts, real paths, the right URL
npm run test:units      # the map's renderer-independent modules
npm run test:contrast # map colours stay visible on both bathymetries
npm run test:map      # asset map, against the built bundle
npm run test:clock    # UTC clock, against the built bundle
```

The test harnesses read from `dist/`, so build first or they test stale code.

Refreshing map data by hand — CI does all of this on every deploy, so you only
need it locally when working on the map:

```sh
npm run data           # storms, gliders (four regional ERDDAPs), USVs, Argo floats
npm run data:currents  # global + regional current grids, surface and 60 m
npm run data:tiles     # the 1/12° current tiles (~92 MB per depth, a few minutes)
npm run data:fields      # global + regional sea-surface temperature and salinity grids
npm run data:field-tiles # native-resolution Navy field tiles (OISST needs none — its regions already are native)
npm run data:basemaps  # re-sample basemap ocean colours (slow; GEBCO's WMS)
```

The tiles are gitignored, so a fresh clone has none and the map simply uses
the coarser grids until you build them.

## Deployment

Pushing to `main` deploys to GitHub Pages, gated on `npm run verify` — if the
checks fail, nothing is published. The same workflow runs hourly on a schedule
to refresh the map data; that run commits nothing, so the repository does not
grow.

The full-resolution tiles are the exception to "refresh everything hourly":
the current tiles are ~92 MB per depth and the Navy temperature and salinity
tiles another ~43 MB each,
and none of them change until the ocean model runs, once a day at 12Z. CI
caches them keyed on that model run and rebuilds only when it advances.

DNS lives at the registrar: apex `A` records to `185.199.108.153`,
`185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and a `www` CNAME to
`oceansensing.github.io`. The apex is canonical and HTTPS is enforced. The same
zone carries the lab's PrivateEmail MX records — **do not let a registrar "Mail
Settings" default overwrite them**, or lab email stops.

Working on this repo with Claude Code? `CLAUDE.md` has the architecture notes
and `PLAN.md` tracks what is still open.

## Licence

Copyright (c) 2026 Donglai Gong and C4PO. All rights reserved — see
[LICENSE](LICENSE). The repository is public so the site can be served from
GitHub Pages and so the work is open to inspection; that is not a grant of
any licence to reuse it.

Third-party material keeps its own terms: dependencies as declared in
`package.json`, and the scientific data in `public/map/` under the terms of
the bodies that produced it (GEBCO, Natural Earth, NOAA, IOOS, Ifremer, the
US Navy via HYCOM, Marine Regions and others), each credited on the map.
