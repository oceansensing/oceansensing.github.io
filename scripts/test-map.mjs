#!/usr/bin/env node
/**
 * Runs the built asset-map bundle against the real data in a headless DOM.
 *
 *   npm run build && node scripts/test-map.mjs
 *
 * Exists because the map is the one piece of the site with meaningful
 * client-side logic; this exercises it end to end (Leaflet, coastline,
 * storms, markers, controls) without needing a browser.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const dom = new JSDOM(
  '<!doctype html><body><div id="asset-map"></div><span id="map-status"></span></body>',
  { pretendToBeVisual: true, url: 'http://localhost/' }
);
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser'])
  globalThis[k] = window[k];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;

const box = { width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500, x: 0, y: 0 };
window.Element.prototype.getBoundingClientRect = () => box;
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 500, configurable: true });

const files = {
  coastline: JSON.parse(fs.readFileSync('public/map/coastline.json', 'utf8')),
  boundaries: JSON.parse(fs.readFileSync('public/map/boundaries.json', 'utf8')),
  'ocean-assets': JSON.parse(fs.readFileSync('public/map/ocean-assets.json', 'utf8')),
};
globalThis.fetch = async (u) => {
  const key = Object.keys(files).find((k) => String(u).includes(k));
  if (!key) throw new Error('unexpected fetch: ' + u);
  return { json: async () => files[key] };
};

const assets = files['ocean-assets'];
const bundle = fs.readdirSync('dist/_astro').find((f) => f.startsWith('AssetMap') && f.endsWith('.js'));
if (!bundle) {
  console.error('no AssetMap bundle in dist/_astro — run `npm run build` first');
  process.exit(1);
}
await import('./' + path.join('..', 'dist', '_astro', bundle));
await new Promise((r) => setTimeout(r, 1500));

const host = document.getElementById('asset-map');

// Open a marker popup for real, then read what it rendered.
let popupHtml = '';
const marker = [...host.querySelectorAll('path')].find(
  (p) => p.getAttribute('fill') === '#f08c00' || p.getAttribute('fill') === '#e8368f'
);
if (marker) {
  marker.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  popupHtml = host.querySelector('.leaflet-popup-content')?.innerHTML ?? '';
}

const status = document.getElementById('map-status').textContent;
const checks = [
  ['leaflet initialised', host.classList.contains('leaflet-container')],
  ['borders + markers drawn', host.querySelectorAll('path').length > 200],
  ['layer switcher', host.querySelectorAll('.leaflet-control-layers-selector').length >= 9],
  ['bathymetry is the default base', !!host.querySelector('.leaflet-tile-pane .leaflet-layer')],
  ['view toggle', host.querySelectorAll('.view-toggle a').length === 2],
  ['data pipeline completed', /assets reporting within/.test(status)],
  ['asset tracks drawn', host.querySelectorAll('path[stroke="#e8368f"], path[stroke="#f08c00"]').length >= assets.assets.length],
  ['glider colour is not the old teal', !host.querySelector('path[stroke="#0a7d8c"]')],
  ['popup shows deployment date', popupHtml.includes('Deployed')],
  ['popup links the dataset', /href="https?:[^"]*erddap[^"]*"/i.test(popupHtml)],
  // Theme-driven layers carry a class instead of a baked-in colour, so the
  // stylesheet can restyle them when the reader switches to dark mode.
  ['borders are theme-classed', host.querySelectorAll('path.map-border-country').length > 20],
  ['state lines are theme-classed', host.querySelectorAll('path.map-border-state').length > 20],
  ['track casings are theme-classed', host.querySelectorAll('path.map-casing').length > 0],
  ['asset markers are theme-classed', host.querySelectorAll('path.map-asset').length === assets.assets.length],
  ['no hardcoded border/casing colours left', !host.querySelector('path[stroke="#4a525c"], path[stroke="#6b7480"], path[stroke="#0d1218"], path[stroke="#8a949f"]')],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  ok &&= pass;
}
console.log(`status: ${status}`);
console.log('popup:', popupHtml.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ').trim().slice(0,240));
process.exit(ok ? 0 : 1);
