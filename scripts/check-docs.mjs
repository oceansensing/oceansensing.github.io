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

/* 4. The README promises CI gates the deploy on `npm run verify`. Keep that
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
