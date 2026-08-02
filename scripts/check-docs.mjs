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

const DOCS = ['README.md', 'CLAUDE.md', 'PLAN.md'];
const WORKFLOW = '.github/workflows/deploy.yml';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const problems = [];
const note = (doc, msg) => problems.push(`${doc}: ${msg}`);

/* Where a path appears in prose it is always in backticks, so that is the
   only place worth looking — prose sentences are full of slashes that are
   not paths. Placeholders (<person-id>) and globs are skipped: they are
   patterns, not files. dist/ is build output and may not exist. */
const REPO_PATH = /^(src|public|scripts|\.github)\/[A-Za-z0-9._/-]+$/;

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
  for (const m of text.matchAll(/npm run ([a-z][a-z:-]*)/g)) {
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
  {
    what: 'particle lifetime',
    file: 'src/components/AssetMap.astro',
    from: /const PARTICLE_SECONDS = (\d+)/,
    doc: (v) => new RegExp(`${v} s at \\d+ fps`),
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
];
/* Whitespace-normalised, because these docs are hard-wrapped: a claim like
   "four regional ERDDAPs" can straddle a line break, and a pattern with a
   literal space would then report drift that is only a newline. */
const claimDoc = fs.readFileSync('CLAUDE.md', 'utf8').replace(/\s+/g, ' ');
for (const claim of claims) {
  const source = fs.readFileSync(claim.file, 'utf8');
  const raw = claim.from.exec(source);
  const found = raw && [raw[0], claim.count ? String(claim.count(raw[1])) : raw[1]];
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

/* 5. The README promises CI gates the deploy on `npm run verify`. Keep that
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
