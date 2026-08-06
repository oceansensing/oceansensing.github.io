/**
 * The two menu buttons in the top-left stack: regions and interests.
 *
 * See `places.ts` for why they are two and not one. This file is only the
 * drawing and the wiring; every entry it offers is data over there.
 *
 * **A menu of actions, not a `<select>`.** The particle picker has a note
 * about a `<select>` being the wrong control for choosing a colour; this is
 * the other reason to avoid one — these entries *do* something rather than
 * setting a value, and a select would report a current selection that does
 * not exist. There is no "current region": you jump somewhere and then pan.
 */
import L from 'leaflet';
import type { Interest, Region } from './places.js';

export interface PlaceMenuHandlers {
  /** Fly to fixed bounds. */
  goTo(bounds: [[number, number], [number, number]]): void;
  /** The page's own view — what the old Basin button did. */
  goHome(): void;
  /** Fit whatever is reporting — what the old Global button did, and it
      never meant the globe. */
  goFleet(): void;
  /** Apply an interest's layers and colour scales. */
  apply(interest: Interest): void;
  /** Everything back to defaults. */
  reset(): void;
}

interface MenuSpec<T> {
  /** The button face. Short: it sits in a 30px Leaflet bar. */
  face: string;
  label: string;
  entries: T[];
  /** Marker class, so the stylesheet and the harness can find each menu. */
  kind: 'regions' | 'interests';
  run(entry: T): void;
  titleOf(entry: T): string;
  labelOf(entry: T): string;
  /* Which entries are the "undo" ones at the top — Home and All platforms
     in one menu, Reset in the other. A rule is drawn under the last of
     them.

     Asked of the entry rather than counted off the top, because the two
     menus have different numbers of them and a positional rule would put
     the line under the wrong item in one of the two. */
  isSpecial(entry: T): boolean;
}

/** Both menus, added to the map in stack order. Returns nothing to unwire —
    the controls live as long as the map does, like the rest of the chrome. */
export function createPlaceMenus(
  map: L.Map,
  regions: Region[],
  interests: Interest[],
  on: PlaceMenuHandlers
): void {
  /* Only one open at a time, and clicking the map closes both. Tracked here
     rather than per menu, because two open panels would overlap in a 30px
     wide stack and the lower one would be unreachable. */
  const panels: { close: () => void }[] = [];
  const closeAll = () => panels.forEach((p) => p.close());

  const build = <T>(spec: MenuSpec<T>) => {
    const Menu = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const bar = L.DomUtil.create(
          'div', `leaflet-bar om-place-menu om-place-${spec.kind}`
        );
        const button = L.DomUtil.create('a', 'om-place-button', bar);
        button.href = '#';
        button.textContent = spec.face;
        button.title = spec.label;
        /* The face is a word, so it needs an accessible name that says what
           pressing it does rather than repeating the word. */
        button.setAttribute('role', 'button');
        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', spec.label);

        const panel = L.DomUtil.create('div', 'om-place-panel', bar);
        panel.hidden = true;
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', spec.label);

        const lastSpecial = spec.entries.reduce(
          (at, entry, i) => (spec.isSpecial(entry) ? i : at), -1
        );
        spec.entries.forEach((entry, i) => {
          const item = L.DomUtil.create(
            'button', `om-place-item${i === lastSpecial ? ' om-place-divide' : ''}`, panel
          );
          item.type = 'button';
          item.setAttribute('role', 'menuitem');
          item.textContent = spec.labelOf(entry);
          item.title = spec.titleOf(entry);
          L.DomEvent.on(item, 'click', (e) => {
            L.DomEvent.stop(e);
            close();
            spec.run(entry);
          });
        });

        const open = () => {
          // Close the other one first: see the note on `panels`.
          closeAll();
          panel.hidden = false;
          button.setAttribute('aria-expanded', 'true');
          bar.classList.add('om-place-open');
        };
        const close = () => {
          panel.hidden = true;
          button.setAttribute('aria-expanded', 'false');
          bar.classList.remove('om-place-open');
        };
        panels.push({ close });

        L.DomEvent.on(button, 'click', (e) => {
          L.DomEvent.stop(e);
          if (panel.hidden) open(); else close();
        });

        /* Without this a click inside the panel reaches the map underneath —
           which pans it, and on a touch device dismisses the panel before the
           tap lands on an item. */
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.disableScrollPropagation(bar);
        return bar;
      },
    });
    map.addControl(new Menu());
  };

  build<Region>({
    face: 'Region',
    label: 'Jump to a region. Does not change which layers are on.',
    kind: 'regions',
    entries: regions,
    labelOf: (r) => r.label,
    titleOf: (r) => r.title,
    isSpecial: (r) => Boolean(r.dynamic),
    run: (r) => {
      if (r.dynamic === 'home') on.goHome();
      else if (r.dynamic === 'fleet') on.goFleet();
      else if (r.bounds) on.goTo(r.bounds);
    },
  });

  build<Interest>({
    face: 'Layers',
    label: 'Choose a set of layers and colour scales. Does not move the map.',
    kind: 'interests',
    entries: interests,
    labelOf: (i) => i.label,
    titleOf: (i) => i.title,
    isSpecial: (i) => Boolean(i.reset),
    run: (i) => (i.reset ? on.reset() : on.apply(i)),
  });

  /* Escape closes, and it is bound on the document for the same reason the
     measuring tool's is: a reader pressing it has usually not clicked into
     the map first, so a container-scoped listener would never see it. */
  L.DomEvent.on(document as unknown as HTMLElement, 'keydown', ((e: KeyboardEvent) => {
    if (e.key === 'Escape') closeAll();
  }) as EventListener);

  // A click on the map is a decision to look at the map.
  map.on('click movestart', closeAll);
}
