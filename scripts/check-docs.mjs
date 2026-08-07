#!/usr/bin/env node
/**
 * Guards the docs against drifting away from the repo.
 *
 *   npm run check:docs
 *
 * README.md, CLAUDE.md and PLAN.md all make claims that quietly stop being
 * true: they name npm scripts, point at files, and advertise the live URL.
 * The README went stale on all three at once after the domain cutover, which
 * is what this exists to catch. Needs no build.
 */
import fs from 'node:fs';

/* The package's own docs are checked too. They are hand-offs for work nobody
   has started yet — a second website, and the iOS app — so they are exactly
   the documents most likely to rot unnoticed: no one is reading them week to
   week to catch a path that moved. */
const DOCS = [
  'README.md',
  'CLAUDE.md',
  'PLAN.md',
  'packages/ocean-map/README.md',
  'packages/ocean-map/BOUNDARIES.md',
  'packages/ocean-map/EMBEDDING.md',
  'packages/ocean-map/PORTING-IOS.md',
  /* The sandbox is exempt from the map gates, not from having docs that are
     true. Its README is the one place saying what is currently being tried
     in there, so a stale one is worse than none. */
  'packages/ocean-map-dev/README.md',
  /* Not a map, but the same argument: it is written to be used somewhere
     else, so its README is the hand-off and nobody reads it week to week. */
  'packages/teos10/README.md',
  'packages/glider-ballast/README.md',
];
const WORKFLOW = '.github/workflows/deploy.yml';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const problems = [];
const note = (doc, msg) => problems.push(`${doc}: ${msg}`);

/* Where a path appears in prose it is always in backticks, so that is the
   only place worth looking — prose sentences are full of slashes that are
   not paths. Placeholders (<person-id>) and globs are skipped: they are
   patterns, not files. dist/ is build output and may not exist. */
const REPO_PATH = /^(src|public|scripts|packages|\.github)\/[A-Za-z0-9._/-]+$/;

/* The docs also name files without their directory — `fetch-currents.py`,
   `AssetMap.astro` — and renaming a script leaves those pointing at nothing
   while every full path in the doc still resolves. That is exactly what
   happened when fetch-sst.py became fetch-ocean-fields.py: three mentions
   rotted silently. So index every filename in the repo and check bare ones
   too, restricted to extensions we actually author. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro']);
const FILENAMES = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(`${dir}/${e.name}`);
    } else FILENAMES.add(e.name);
  }
})('.');
const BARE_FILE = /^[A-Za-z0-9._-]+\.(py|mjs|js|ts|astro|json|ya?ml|bib|css|md)$/;

for (const doc of DOCS) {
  if (!fs.existsSync(doc)) {
    problems.push(`${doc} is missing`);
    continue;
  }
  const text = fs.readFileSync(doc, 'utf8');
  const ticked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

  // 1. npm scripts the docs tell people to run must exist.
  /* Digits are part of a script name -- `test:teos10` -- and leaving them out
     truncated it to `test:teos`, which package.json rightly does not define.
     A checker that reports a name nobody wrote is worse than one that misses:
     it sends you looking for a typo in the doc. */
  for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    if (!pkg.scripts[m[1]]) note(doc, `refers to \`npm run ${m[1]}\`, which package.json does not define`);
  }

  // 2. Files and directories the docs point at must exist.
  for (const token of ticked) {
    const path = token.replace(/\/$/, '');
    if (!REPO_PATH.test(path)) continue;
    if (!fs.existsSync(path)) note(doc, `points at \`${token}\`, which does not exist`);
  }

  // 2b. …including the ones named without their directory.
  for (const token of ticked) {
    if (!BARE_FILE.test(token) || FILENAMES.has(token)) continue;
    note(doc, `names \`${token}\`, which is nowhere in the repo`);
  }
}

// 3. The canonical URL has to agree everywhere it is written down.
const siteUrl = /site:\s*'([^']+)'/.exec(fs.readFileSync('astro.config.mjs', 'utf8'))?.[1];
const configUrl = /url:\s*'([^']+)'/.exec(fs.readFileSync('src/config.ts', 'utf8'))?.[1];
if (!siteUrl) problems.push('astro.config.mjs: no site URL found');
else if (siteUrl !== configUrl) {
  problems.push(`astro.config.mjs says ${siteUrl} but src/config.ts says ${configUrl}`);
} else {
  const readme = fs.readFileSync('README.md', 'utf8');
  if (!readme.includes(siteUrl)) note('README.md', `never mentions the live URL (${siteUrl})`);
  // The stale README linked "live at" to the pre-cutover Pages host.
  if (/\]\(https:\/\/oceansensing\.github\.io\)/.test(readme)) {
    note('README.md', 'links to the old oceansensing.github.io host — the live site is the custom domain');
  }
}

/* 4. Numbers the docs quote from the pipeline. These drift silently — the
      tile zoom threshold moved from 6 to 7 in the code while CLAUDE.md and a
      stale generated index still said 6, and nothing noticed. Read the value
      from the source, not from a build artefact, so this works in CI where
      the tiles do not exist. */
const claims = [
  {
    what: 'tile zoom threshold',
    file: 'scripts/fetch-currents.py',
    from: /'minZoom':\s*(\d+),\s*\n\s*#\s*0\.08/,
    doc: (v) => new RegExp(`zoom \u2265 ${v}\\b`),
  },
  {
    what: 'coastal erosion threshold',
    file: 'scripts/fetch-currents.py',
    from: /COASTAL_DRY_NEIGHBOURS = (\d+)/,
    doc: (v) => new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four'][+v] ?? v}\\b`),
  },
  /* Numbers the docs quote from the map component and the asset pipeline.
     Each of these has already gone stale once in a single working session,
     which is the argument for checking them rather than trusting a habit. */
  /* Per field now, and both have to be stated: the whole point of splitting
     them is that the two fields want different trail lengths, so a doc
     quoting one number is describing a map that no longer exists. */
  {
    what: 'current particle lifetime',
    file: 'packages/ocean-map/index.ts',
    from: /const PARTICLE_SECONDS = \{ current: (\d+)/,
    doc: (v) => new RegExp(`${v} s(econds)? (at \\d+ fps|suits the ocean)`),
  },
  {
    what: 'wind particle lifetime',
    file: 'packages/ocean-map/index.ts',
    from: /const PARTICLE_SECONDS = \{ current: \d+, wind: (\d+)/,
    doc: (v) => new RegExp(`${v} s(econds)? (for the wind|suits the air)`),
  },
  {
    what: 'Argo cycle window',
    file: 'scripts/fetch-ocean-assets.py',
    from: /ARGO_CYCLE_DAYS = (\d+)/,
    doc: (v) => new RegExp(`max\\(\`?HISTORY_DAYS\`?, ${v}\\)`),
  },
  {
    what: 'number of glider sources',
    file: 'scripts/fetch-ocean-assets.py',
    // count the entries in GLIDER_SOURCES
    from: /GLIDER_SOURCES = \[([\s\S]*?)\n\]/,
    count: (block) => (block.match(/\{'base':/g) ?? []).length,
    // Tolerate markdown emphasis between the word and the phrase.
    doc: (v) =>
      new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][+v] ?? v}\\*{0,2}\\s+regional ERDDAPs`),
  },
  /* The map's size is no longer capped, so the particle count would not be
     either — it is the map's area times a constant. The ceiling is the thing
     standing between a 4K window and ~52,000 particles at 18 fps, and the
     docs quote it twice. */
  {
    what: 'particle ceiling',
    file: 'packages/ocean-map/index.ts',
    from: /const MAX_PARTICLES = (\d+)/,
    doc: (v) => new RegExp(`${Number(v).toLocaleString('en-US')}[- ]particle ceiling|MAX_PARTICLES = ${v}|above \\*{0,2}\`?MAX_PARTICLES = ${v}\`?`),
  },
  /* How often the published step is allowed to move. It replaced the fixed
     T+36 lead, and it is the number the whole tide argument turns on: below
     the model's 3-hourly steps it cannot go without aliasing, and above it
     the reader drifts further from now. */
  {
    what: 'field refresh window',
    file: 'scripts/fetch-currents.py',
    from: /^REFRESH_HOURS = (\d+)/m,
    /* The *boundary*, not any phrase with the number and "hour" in it. A
       looser form passed against the prose's own "3-hourly" description of
       the model's steps, which is a different quantity that happens to
       share a word. */
    doc: (v) => new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][+v] ?? v}[- ]hour boundary\\b`),
  },
  /* How many frames the currents publish. Two is what puts the
     forecast-hour control back on the map, and what the storage table
     below is arithmetic on. */
  {
    what: 'published current frames',
    file: 'scripts/fetch-currents.py',
    from: /^FRAMES = (\d+)/m,
    doc: (v) => new RegExp(`\\b${['zero', 'one', 'two', 'three'][+v] ?? v} frames per (run|window)`),
  },
  /* How far past the viewport the field is simulated. It costs the square of
     itself in particles, so a doc quoting the wrong margin is understating
     the cost of the whole layer. */
  {
    what: 'particle view margin',
    file: 'packages/ocean-map/velocity-layer.ts',
    from: /const VIEW_MARGIN = ([\d.]+)/,
    doc: (v) => new RegExp(`${Math.round(Number(v) * 100)}% of the viewport|${Math.round(Number(v) * 100)}% past the viewport`),
  },
  /* The likeness bar. It is the whole argument that the picker's labels are
     honest — loosen it and "Green" starts returning yellow — and the docs
     quote it as the reason the names can be trusted. */
  /* The marker bar. It moved from the gate into the palette so the map could
     apply it too, and the prose explains why it is lower than the background
     one — a number the docs argue about at length must not be able to drift
     from the file. */
  {
    what: 'particle-vs-marker bar',
    file: 'packages/ocean-map/data/map-palette.json',
    from: /"marker":\s*(\d+)/,
    doc: (v) => new RegExp(`\`bars.marker\`, ${v} rather than`),
  },
  {
    what: 'runtime ramp likeness bar',
    file: 'packages/ocean-map/contrast.ts',
    from: /likeness = (\d+)/,
    doc: (v) => new RegExp(`\\u0394E \\u2264 ${v} to an exemplar`),
  },
  /* How many lightness/chroma profiles the runtime search covers. Thinning
     it is what emptied the tight balls around named colours the first time,
     so a doc quoting the old count would be quoting the broken version. */
  {
    what: 'runtime ramp candidate profiles',
    file: 'packages/ocean-map/contrast.ts',
    from: /for \(const chroma of \[([\d, ]+)\]\)[\s\S]*?for \(const L0 of \[([\d, ]+)\]\)/,
    count: (chroma, lightness) => chroma.split(',').length * lightness.split(',').length,
    doc: (n) => new RegExp(`${n} profiles`),
  },
];


/* Whitespace-normalised, because these docs are hard-wrapped: a claim like
   "four regional ERDDAPs" can straddle a line break, and a pattern with a
   literal space would then report drift that is only a newline. */
const claimDoc = fs.readFileSync('CLAUDE.md', 'utf8').replace(/\s+/g, ' ');

/* The two particle drift rates, against the measured speed ratio the docs
   justify them with. This one is **not** a string match, because the two
   numbers are different quantities: the prose quotes the measured ratio of
   median speeds (wind against surface current) and `DRIFT` is a pair of
   constants chosen to cancel it. Requiring them to be equal to the decimal
   would be requiring the measurement to be rounded to the constant, which is
   backwards. What has to hold is that the constants still embody the
   measurement — so they are compared numerically, with room for the rounding
   that separates them. Diverge by more than a tenth and one of the two has
   moved without the other. */
{
  const src = fs.readFileSync('packages/ocean-map/index.ts', 'utf8');
  /* The **base** wind drift, before the deliberate boost. That base is what
     embodies the measurement — it was chosen so the two fields drift at the
     same apparent rate — and `WIND_BOOST` is a separate legibility choice on
     top. Comparing the base against the measured ratio keeps the two claims
     apart instead of letting one absorb the other. */
  const drift = /const DRIFT = \{ current: ([\d.]+), wind: ([\d.]+) \* WIND_BOOST \}/.exec(src);
  const quoted = /(\d+(?:\.\d+)?)\*{0,2}(?:x|×) (?:the median|faster)/.exec(claimDoc);
  if (!drift) {
    problems.push('packages/ocean-map/index.ts: cannot read DRIFT');
  } else if (!quoted) {
    problems.push('CLAUDE.md: does not say how much faster the wind runs than the current');
  } else {
    /* The wind is deliberately drawn faster than speed parity, so the drift
       ratio is the measured ratio divided by that boost. Reading the boost
       from the source rather than allowing slack is what keeps this a check:
       widening the tolerance until it passes would let the two numbers drift
       apart for any reason at all, which is the opposite of the point. */
    const constants = Number(drift[1]) / Number(drift[2]);
    const measured = Number(quoted[1]);
    if (Math.abs(constants - measured) / measured > 0.1) {
      problems.push(
        `CLAUDE.md quotes wind at ${measured}x the current, but the base DRIFT ` +
        `is set for ${constants.toFixed(1)}x — one moved without the other`
      );
    }
    // And the boost is its own claim, so the prose has to carry it too.
    const boost = /const WIND_BOOST = ([\d.]+)/.exec(src);
    if (!boost) {
      problems.push('packages/ocean-map/index.ts: cannot read WIND_BOOST');
    } else {
      const pct = Math.round((Number(boost[1]) - 1) * 100);
      if (!new RegExp(`${pct}% faster`).test(claimDoc)) {
        problems.push(
          `CLAUDE.md: WIND_BOOST draws the wind ${pct}% faster than parity, ` +
          `but the docs do not say so`
        );
      }
    }
  }
}
for (const claim of claims) {
  const source = fs.readFileSync(claim.file, 'utf8');
  const raw = claim.from.exec(source);
  // Every capture, not just the first: a claim derived from two constants
  // — the ratio between the two particle drift rates — needs both.
  const found = raw && [raw[0], claim.count ? String(claim.count(...raw.slice(1))) : raw[1]];
  if (!found) {
    problems.push(`${claim.file}: cannot read the ${claim.what}`);
    continue;
  }
  if (!claim.doc(found[1]).test(claimDoc)) {
    problems.push(
      `CLAUDE.md: the ${claim.what} is ${found[1]} in the pipeline, but the docs do not say so`
    );
  }
}

/* The palette's own colours, against the prose that explains them. These have
   moved three times in a day — amber to coral for the currents, yellow to
   green for the wind — and each move rewrote a paragraph of reasoning. A hex
   that no longer appears in the file it is explained by is the cheapest
   possible signal that the explanation is about a colour nobody can see. */
{
  const palette = JSON.parse(fs.readFileSync('packages/ocean-map/data/map-palette.json', 'utf8'));
  for (const field of ['currents', 'wind']) {
    const first = palette[field]?.[0];
    if (!first) {
      problems.push(`map-palette.json: no ${field} ramp`);
      continue;
    }
    const note = palette[`_${field}`] ?? '';
    // The note beside a ramp has to be about *that* ramp. Naming the ramp's
    // own first stop is the one thing that cannot survive a colour change by
    // accident.
    if (!note.includes(first) && !claimDoc.includes(first)) {
      problems.push(
        `the ${field} ramp starts at ${first}, which neither its own note nor ` +
        `CLAUDE.md mentions — the reasoning may still be about the old colour`
      );
    }
  }
}

/* 4b. Every source the map can credit has to be described on the page that
       carries it.

       The page went two whole layers out of date before this existed — the
       isobaths and the EMODnet shoreline were both on the map and in its
       attribution control while the prose still credited GEBCO only as a
       basemap. Nothing noticed, because the page and the map are edited at
       different times for different reasons.

       Credits come from two places: the attribution strings baked into the
       module, and the `source` fields the pipelines write into the data,
       which the map displays at runtime. Both are read here, so adding a
       feed anywhere fails this until the page says where it came from.

       **What it does not guarantee**, and this is worth knowing rather than
       assuming: it checks that every crediting *organisation* is named, not
       that every layer's role is described. GEBCO supplies both a basemap and
       the isobaths, so dropping the isobath paragraph would leave the name on
       the page and pass — which is one of the two cases that prompted this.
       Matching the role would mean matching prose against strings like
       "isobaths" when the page reasonably says "depth contours", and a check
       that cries wolf gets switched off. Naming the limit is the honest
       trade: a new or removed *source* fails here, a rewritten description
       does not. */
const mapPages = fs
  .readdirSync('src/content/observations')
  .filter((f) => f.endsWith('.md'))
  .map((f) => `src/content/observations/${f}`)
  .filter((f) => /^map:\s*assets\s*$/m.test(fs.readFileSync(f, 'utf8')));

/* How the page words a credit, where it differs from the raw string. Names
   the difference rather than matching loosely: a fuzzy match on "NOAA" would
   pass for any of five separate feeds. A credit with no entry here has to
   appear verbatim, and a new one that does neither fails — which is the
   point. */
const WORDED_AS = {
  'GEBCO Compilation Group': 'GEBCO',
  'NOAA PMEL ERDDAP': 'NOAA PMEL',
  'Argo GDAC via Ifremer ERDDAP': 'Ifremer Argo GDAC',
  'NOAA PSL OISST v2.1': 'NOAA PSL OISST v2.1',
};

/* Scaffolding, not a live layer: MERCATOR_RASTER is false, so nothing is
   requested from Copernicus and the page must *not* credit it. Kept in the
   module so restoring the layer is one flag. */
const NOT_SHOWN = new Set(['Copernicus Marine']);

if (mapPages.length) {
  const moduleSource = fs.readFileSync('packages/ocean-map/index.ts', 'utf8');
  const credits = new Set();
  const clean = (t) =>
    t
      .replace(/<[^>]+>/g, '')
      .replace(/\$\{[^}]*\}?/g, '')
      .replace(/^(Currents|Field|Salinity|SST)\s*:\s*/i, '')
      .split(/\s+—\s+| at\s*$/)[0]
      .replace(/^©\s*/, '')
      .replace(/\s+contributors$/, '')
      .replace(/\s+\d{4}$/, '')
      .trim();

  for (const m of moduleSource.matchAll(
    /attribution:\s*\n?\s*((?:'[^']*'|`[^`]*`)(?:\s*\+\s*\n?\s*(?:'[^']*'|`[^`]*`))*)/g
  )) {
    const joined = [...m[1].matchAll(/'([^']*)'|`([^`]*)`/g)].map((q) => q[1] ?? q[2]).join('');
    const name = clean(joined);
    if (name) credits.add(name);
  }

  /* The animated fields name their publisher in a `source:` field rather
     than in the attribution literal, because one `buildFlow` serves the two
     ESPC depths and the ECMWF wind. Reading only the literals silently
     stopped seeing those layers the moment that refactor landed — the guard
     went on saying `ok` while it had nothing to check them against, which is
     the failure mode it exists to prevent in the docs. */
  for (const m of moduleSource.matchAll(/^\s*source:\s*'([^']+)'/gm)) {
    credits.add(m[1]);
  }

  // The sources the pipelines write, which the map credits at runtime.
  const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const assetsFile = readJson('public/map/ocean-assets.json');
  for (const v of Object.values(assetsFile?.sources ?? {})) credits.add(v);
  const argoFile = readJson('public/map/argo.json');
  if (argoFile?.source) credits.add(argoFile.source);
  for (const n of ['sst-oisst', 'sst-navy', 'sss-navy', 'wind']) {
    // Vector files are a [u, v] pair; scalar files are a single object.
    const file = readJson(`public/map/${n}.json`);
    const src = (Array.isArray(file) ? file[0] : file)?.header?.source;
    if (src) credits.add(src);
  }

  for (const page of mapPages) {
    // Link syntax out of the way, so "[Marine Regions](url) (VLIZ)" reads as
    // the name the attribution control shows.
    const prose = fs.readFileSync(page, 'utf8').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    for (const credit of credits) {
      if (NOT_SHOWN.has(credit)) {
        if (prose.includes(credit)) {
          note(page, `credits \`${credit}\`, which the map does not show`);
        }
        continue;
      }
      const wanted = WORDED_AS[credit] ?? credit;
      if (!prose.includes(wanted)) {
        note(page, `never mentions \`${wanted}\`, which the map credits as "${credit}"`);
      }
    }
  }
}

/* 4c. Layer presets have to name layers that exist.

       A page opens the map on a preset — a list of overlay names as the
       switcher shows them. Misspell one and nothing happens: no error, no
       warning, just a layer that quietly fails to come on, which is the same
       silent-partial-result this project keeps meeting. The names live in the
       module's `overlays` object, so both sides are read here. */
const overlayBlock = /const overlays[^=]*=\s*\{([\s\S]*?)\n  \};/.exec(
  fs.readFileSync('packages/ocean-map/index.ts', 'utf8')
);
if (overlayBlock) {
  const known = new Set([...overlayBlock[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
  const pages = fs
    .readdirSync('src/pages', { recursive: true })
    .filter((f) => String(f).endsWith('.astro'))
    .map((f) => `src/pages/${f}`);
  for (const page of pages) {
    const text = fs.readFileSync(page, 'utf8');
    /* Both lists, because they fail the same silent way. `layers` is what
       opens on; `preload` is what is fetched at startup despite opening
       off. A misspelling in either does nothing at all — the preset simply
       switches nothing on, and the preload simply warms nothing. */
    for (const [prop, verb] of [
      ['layers', 'opens the map on'],
      ['preload', 'preloads'],
    ]) {
      const list = new RegExp(`${prop}=\\{\\[([\\s\\S]*?)\\]\\}`).exec(text);
      if (!list) continue;
      for (const [, name] of list[1].matchAll(/'([^']+)'/g)) {
        if (!known.has(name)) {
          note(page, `${verb} \`${name}\`, which is not a layer the map offers`);
        }
      }
    }
  }

  /* And the Layers menu's own presets, which fail the same silent way and
     from inside the package rather than from a page. An interest names
     overlays by their switcher labels and colormaps by their palette keys;
     a typo in either does nothing at all — the entry appears to work and
     changes nothing, or falls back to an arbitrary scale. */
  const places = fs.readFileSync('packages/ocean-map/places.ts', 'utf8');
  const palette = JSON.parse(
    fs.readFileSync('packages/ocean-map/data/map-palette.json', 'utf8')
  );
  const maps = new Set(Object.keys(palette.colormaps ?? {}));
  for (const [, block] of places.matchAll(/layers:\s*\[([\s\S]*?)\]/g)) {
    for (const [, name] of block.matchAll(/'([^']+)'/g)) {
      if (!known.has(name)) {
        problems.push(`packages/ocean-map/places.ts: an interest names \`${name}\`, which is not a layer the map offers`);
      }
    }
  }
  for (const [, block] of places.matchAll(/colours:\s*\{([\s\S]*?)\}/g)) {
    for (const [, name] of block.matchAll(/:\s*'([^']+)'/g)) {
      if (maps.size && !maps.has(name)) {
        problems.push(`packages/ocean-map/places.ts: an interest asks for the \`${name}\` colour scale, which the palette does not define`);
      }
    }
  }
}

/* 5. The two ESPC pipelines must snap to the same refresh window.
 *
 *    They select their step independently — same rule, two copies, because
 *    each is a standalone standard-library script — and the currents and the
 *    Navy fields come off one model. A different window in each means one
 *    hour of temperature under another hour of current, and the map crediting
 *    ESPC twice for a single product.
 *
 *    `test-schema.mjs` catches this in the published data, which is stronger
 *    but only fires after a fetch. This fires in `verify`, before anything
 *    has been asked of HYCOM. */
{
  const windows = ['scripts/fetch-currents.py', 'scripts/fetch-ocean-fields.py']
    .map((f) => [f, fs.readFileSync(f, 'utf8').match(/^REFRESH_HOURS = (\d+)/m)?.[1]]);
  for (const [f, v] of windows) {
    if (!v) problems.push(`${f}: cannot read REFRESH_HOURS`);
  }
  if (windows.every(([, v]) => v) && windows[0][1] !== windows[1][1]) {
    problems.push(
      `${windows[0][0]} snaps to ${windows[0][1]} h but ${windows[1][0]} snaps to ` +
      `${windows[1][1]} h — one model, two anchors, so the currents and the ` +
      'fields would publish different hours'
    );
  }

  /* And the fields resolve the currents' whole window in order to publish
     its last step, so their idea of how wide it is has to match too. A
     narrower one lands the field on an hour the currents never publish,
     which is a credit line nothing on the map can be stepped into agreement
     with. */
  const span = [
    ['scripts/fetch-currents.py', /^FRAMES = (\d+)/m],
    ['scripts/fetch-ocean-fields.py', /^WINDOW = (\d+)/m],
  ].map(([f, re]) => [f, fs.readFileSync(f, 'utf8').match(re)?.[1]]);
  for (const [f, v] of span) {
    if (!v) problems.push(`${f}: cannot read the published window width`);
  }
  if (span.every(([, v]) => v) && span[0][1] !== span[1][1]) {
    problems.push(
      `${span[0][0]} publishes ${span[0][1]} frames per window but ` +
      `${span[1][0]} resolves a window of ${span[1][1]} — the field would ` +
      'land on an hour the currents never publish'
    );
  }
}

/* 6. The README promises CI gates the deploy on `npm run verify`. Keep that
      promise honest: if the gate is removed, the claim is a lie. */
const workflow = fs.readFileSync(WORKFLOW, 'utf8');
if (!workflow.includes('npm run verify')) {
  problems.push(`${WORKFLOW}: no \`npm run verify\` gate, but README.md says deploys are gated on it`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error(`\n${problems.length} problem(s) — the docs no longer match the repo.`);
  process.exit(1);
}
console.log(`ok    ${DOCS.join(', ')} match the repo (paths, npm scripts, live URL, deploy gate)`);
