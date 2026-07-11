# oceansensing.github.io

Website of **C4PO — the Collaboratory for Physical Oceanography** at the
Virginia Institute of Marine Science, live at
[oceansensing.github.io](https://oceansensing.github.io).

Built with [Astro](https://astro.build). Static output, no client-side
JavaScript except the theme toggle. Every push to `main` deploys
automatically via GitHub Actions.

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
| a CV item          | new entry in the matching `src/data/cv/*.yaml` file (grants, advising, service, …) — publications and presentations flow in automatically |

Site title, navigation, contact info, and the list of author names bolded on
the Publications page live in `src/config.ts`. Colors, fonts, and spacing
live in `src/styles/tokens.css`.

Commit and push to `main` — the site rebuilds and deploys in about a minute.

## Developing locally

```sh
npm install
npm run dev      # dev server at localhost:4321
npm run build    # production build into dist/
npm run check    # type-check
```

## Custom domain (when ready)

1. Add a `public/CNAME` file containing `oceansensing.org` and change `site`
   in `astro.config.mjs` to `https://oceansensing.org`.
2. Repo Settings → Pages → Custom domain → `oceansensing.org`, then enable
   "Enforce HTTPS".
3. At the DNS registrar: apex `A` records to `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and a `www`
   CNAME to `oceansensing.github.io`.
