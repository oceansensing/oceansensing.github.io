#!/usr/bin/env node
/**
 * Checks the built UTC clock against a deliberately wrong device clock.
 *
 *   npm run build && node scripts/test-clock.mjs
 *
 * The point of the clock is that it is right even when the reader's machine
 * is not, so the test skews Date.now by hours and asserts the clock still
 * shows real UTC — and that when the server cannot be reached it says it is
 * falling back to the device rather than implying it checked.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const PAGE = 'dist/observations/hurricanes/index.html';
const html = fs.readFileSync(PAGE, 'utf8');

// The clock's script is small enough that Astro inlines it into the page.
const source = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('getUTCFullYear'));
if (!source) {
  console.error(`no inline clock script found in ${PAGE} — run \`npm run build\` first`);
  process.exit(1);
}

const REAL_NOW = Date.now;
const pad = (n) => String(n).padStart(2, '0');
const expected = (t) => {
  const d = new Date(t);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
};

/**
 * Run the clock once in a fresh DOM.
 * @param skewMs  how wrong the device clock is
 * @param serveDate  true to answer the HEAD with a correct Date header,
 *                   false to fail the request
 */
async function boot(name, skewMs, serveDate) {
  const dom = new JSDOM('<!doctype html><body><time id="utc-clock" hidden></time></body>', {
    url: 'https://oceansensing.org/observations/hurricanes/',
  });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.URL = window.URL;

  // The device clock is wrong by skewMs. Only Date.now is bent; parsing and
  // formatting stay honest, exactly as on a machine with a bad clock.
  Date.now = () => REAL_NOW() + skewMs;

  globalThis.fetch = async () => {
    if (!serveDate) throw new Error('offline');
    // A real server dates its response from its own correct clock, truncated
    // to whole seconds by the HTTP date format.
    const truncated = Math.floor(REAL_NOW() / 1000) * 1000;
    return {
      headers: {
        get: (k) =>
          k.toLowerCase() === 'date'
            ? new Date(truncated).toUTCString()
            : k.toLowerCase() === 'age'
              ? '0'
              : null,
      },
    };
  };

  const tmp = path.join('dist', `.clock-${name}.mjs`);
  fs.writeFileSync(tmp, source);
  await import('../' + tmp);
  await new Promise((r) => setTimeout(r, 250));

  const clock = window.document.getElementById('utc-clock');
  const result = {
    text: clock.textContent,
    title: clock.title,
    hidden: clock.hidden,
    deviceSays: expected(Date.now()),
    trulyIs: expected(REAL_NOW()),
  };

  Date.now = REAL_NOW;
  fs.unlinkSync(tmp);
  return result;
}

// A device nine and a bit hours behind, with a reachable server.
const SKEW = -(9 * 3600 + 17 * 60 + 42) * 1000 - 300;
const synced = await boot('synced', SKEW, true);
// Same skew, but the server cannot be reached.
const offline = await boot('offline', SKEW, false);

// One second of slack: the clock and the assertion can straddle a boundary.
const within1s = (shown, truth) =>
  Math.abs(Date.parse(isoish(shown)) - Date.parse(isoish(truth))) <= 1000;
function isoish(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2}) UTC$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}Z` : 'invalid';
}

const checks = [
  ['format is YYYY-MM-DDTHH:MM:SS UTC', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC$/.test(synced.text)],
  ['clock is revealed once running', synced.hidden === false],
  ['the device clock really is wrong', !within1s(synced.deviceSays, synced.trulyIs)],
  ['clock shows real UTC, not the device clock', within1s(synced.text, synced.trulyIs)],
  ['says it synchronised with the server', /synchronised with the server/.test(synced.title)],
  ['still shows a clock when the server is unreachable', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC$/.test(offline.text)],
  ['admits it is the device clock when unverified', /from this device/.test(offline.title)],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  ok &&= pass;
}
console.log(`device clock said: ${synced.deviceSays}`);
console.log(`clock displayed:   ${synced.text}`);
console.log(`truth was:         ${synced.trulyIs}`);
process.exit(ok ? 0 : 1);
