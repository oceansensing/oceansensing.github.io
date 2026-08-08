/* The status line above the map: the active-storm list, and the one-line
 * summary of what is reporting.
 *
 * Lifted out of `index.ts` as the first seam of that split after
 * `graticule`, `measure` and `scalar-layer` — and taken first because it was
 * the clearest instance of the problem the split is for. `statusParts` was
 * **written at line 2912 and declared at line 4421**: legal, because the
 * write sits in the Argo fetch's `.then` and cannot run during setup, and
 * entirely invisible to `astro check`. The same shape as `measure.ts` being
 * declared 700 lines below one of its callers.
 *
 * It touches the DOM, so it is not a portable module. What it is instead is a
 * *signature*: everything it needs is a parameter, so the ordering question
 * has an answer a reader can see.
 *
 * The formatting stays in `storm-status.ts`, which the site's own
 * `StormStatus.astro` also imports — this is the map's runtime rebuild of the
 * markup that component renders at build time, and the two must agree.
 */

import { stormLines, stormLabel, NO_STORMS } from './storm-status';

/** The facts the line can carry, in the order it prints them. */
const ORDER = ['storms', 'assets', 'argo', 'updated'] as const;
export type StatusFact = (typeof ORDER)[number];

/* **Each fact is shown only while a layer it describes is on**, the same rule
   the legend keys and the particle controls follow. A count of something the
   reader cannot see is worse than no count: "63 assets reporting" beside a
   map with no platforms on it reads as the map having lost them.

   `assets` covers gliders *and* saildrones, so it survives while either is on
   — the number is their sum, and dropping it when only one is off would
   understate what is drawn. `updated` has no layer at all: it is about the
   fetch rather than about anything on the map, so it always shows. */
const FACT_LAYERS: Partial<Record<StatusFact, string[]>> = {
  storms: ['Hurricanes'],
  assets: ['Ocean gliders', 'NOAA USVs'],
  argo: ['Argo floats'],
};

export interface StatusLineOptions {
  /** The boxes claimed for the storm list, resolved late — a host may rebuild
      them, and the first map to ask is the one that owns them. */
  boxes: () => HTMLElement[];
  /** Where the one-line summary goes. Absent on a host that renders none. */
  summary: HTMLElement | null;
  /** Whether a named overlay is currently on the map. Passed in rather than
      taking the map, so this module needs no Leaflet. */
  isShown: (layerName: string) => boolean;
  /** Called after the storm list is rebuilt, so the host can re-wire the zoom
      buttons it just replaced. */
  onRendered?: () => void;
}

export interface StatusLine {
  /** Rebuild the storm list in place from a fresh feed. */
  renderStorms(raw: unknown[]): void;
  /** Record one fact. Does not repaint — call `show()`. */
  set(fact: StatusFact, text: string): void;
  /** Recompute the summary from the facts and what is on the map. */
  show(): void;
}

export function createStatusLine(options: StatusLineOptions): StatusLine {
  const { boxes, summary, isShown, onRendered } = options;
  const parts: Partial<Record<StatusFact, string>> = {};

  /* Rebuilds the storm line in place. Mirrors StormStatus.astro's markup
     exactly — same classes, same order — because the stylesheet is written
     against that structure and this replaces it wholesale. */
  const renderStorms = (raw: unknown[]) => {
    const box = boxes()[0];
    if (!box) return;
    const lines = stormLines(raw as Parameters<typeof stormLines>[0]);

    box.textContent = '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = stormLabel(lines.length);
    box.append(label);

    if (!lines.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = NO_STORMS;
      box.append(none);
      onRendered?.();
      return;
    }

    const list = document.createElement('ul');
    for (const line of lines) {
      const item = document.createElement('li');

      let name: HTMLElement;
      if (line.url) {
        const link = document.createElement('a');
        link.href = line.url;
        /* Same treatment as the popup links: the advisory is another site,
           and a reader sent there loses the map. Kept in step with the
           build-time markup in StormStatus.astro — this line exists twice
           on purpose, and the two silently diverging is the failure that
           arrangement is meant to avoid. */
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${line.name} advisory (opens in a new tab)`);
        name = link;
      } else {
        name = document.createElement('strong');
      }
      name.textContent = line.name;

      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'zoom';
      if (line.id) zoom.dataset.stormZoom = line.id;
      zoom.title = `Zoom the map to ${line.name}`;
      zoom.setAttribute('aria-label', zoom.title);
      zoom.hidden = true;
      zoom.textContent = '🔍';

      const facts = document.createElement('span');
      facts.className = 'facts';
      facts.textContent = line.facts.join(' · ');

      item.append(name, zoom, facts);
      list.append(item);
    }
    box.append(list);
    /* The buttons this just created are new elements, so whatever wired the
       previous set is now pointing at nodes that have been thrown away. The
       host is told rather than left to notice. */
    onRendered?.();
  };

  const show = () => {
    if (!summary) return;
    const line = ORDER.filter((fact) => {
      const names = FACT_LAYERS[fact];
      if (!names) return true; // `updated` — not about a layer
      /* A layer the host's preset never registered cannot be switched on, so
         its fact stays hidden rather than showing permanently. */
      return names.some((name) => isShown(name));
    })
      .map((fact) => parts[fact])
      .filter(Boolean)
      .join(' · ');
    /* Assigned even when empty, unlike an earlier version: the parts are
       filled in asynchronously and the old guard existed to avoid blanking
       the line before the data landed. It also has to be able to *clear* the
       line when every layer behind it goes off, so the guard moved to the
       thing it was actually protecting — whether anything has arrived. */
    if (line || Object.keys(parts).length) summary.textContent = line;
  };

  return {
    renderStorms,
    set: (fact, text) => {
      parts[fact] = text;
    },
    show,
  };
}
