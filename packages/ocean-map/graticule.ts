/* The lat/lon grid.

   Lifted out of `index.ts` whole. It captured nothing from that closure but
   the map itself, which is what made it the first thing to move: the seam
   was already there and only the file boundary was missing.

   The spacing ladder and the label wording stayed behind in `geo.ts` — they
   are renderer-independent, so they are testable without a build and are
   what a native port keeps. What is left here is the drawing. */
import L from 'leaflet';
import { gridLabel, gridStepFor } from './geo';

/* Web Mercator cannot draw past about 85.05, so the lines stop there rather
   than at the pole. */
const LIMIT = 85;

/**
 * Builds the grid and wires its own redraws. The caller gets a layer group
 * to put in the switcher and owes it nothing else.
 *
 * The lines are **redrawn on zoom** rather than all drawn and filtered,
 * because a graticule at 1° spacing over the whole world is 540 polylines
 * and Leaflet keeps every one of them in the DOM.
 */
export function createGraticule(map: L.Map): L.LayerGroup {
  const graticule = L.layerGroup();

  const draw = () => {
    const step = gridStepFor(map.getZoom());
    const bounds = map.getBounds();
    graticule.clearLayers();

    const label = (at: L.LatLngExpression, text: string, side: string) =>
      L.marker(at, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: `map-grid-label map-grid-label-${side}`,
          html: `<span>${text}</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(graticule);

    /* Labels ride the edge of the *view*, not the line's midpoint, so they
       stay on screen while the reader pans — a label anchored to the
       geometry is off the map the moment its line is only partly visible,
       which for a graticule is nearly always. */
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const inset = (bounds.getEast() - west) * 0.012;
    const insetY = (bounds.getNorth() - south) * 0.012;

    /* **One copy of the world, however many the view shows.** Below about
       zoom 3 a wide window spans more than 360°, and walking the raw bounds
       then draws every meridian twice — two labels reading 150°E on the same
       screen, which is worse than no label. Leaflet repeats the basemap
       tiles across copies but a vector lives in one, so the second pass was
       drawing lines nobody could tell from the first. */
    const east = Math.min(bounds.getEast(), west + 360);
    const first = Math.ceil(west / step) * step;
    for (let lon = first; lon <= east; lon += step) {
      L.polyline([[-LIMIT, lon], [LIMIT, lon]], { weight: 0.7, interactive: false,
        className: 'map-grid' }).addTo(graticule);
      label([south + insetY, lon], gridLabel(lon, 'E', 'W', 3), 'lon');
    }
    for (let lat = Math.ceil(Math.max(south, -LIMIT) / step) * step;
         lat <= Math.min(bounds.getNorth(), LIMIT); lat += step) {
      L.polyline([[lat, -180], [lat, 180]], { weight: 0.7, interactive: false,
        className: 'map-grid' }).addTo(graticule);
      label([lat, west + inset], gridLabel(lat, 'N', 'S', 2), 'lat');
    }
  };

  /* Redrawn on every settled view: the step may have changed, and the
     labels are pinned to the viewport so they move with it regardless.

     That second half is why there is no "has the step changed?" guard here.
     One used to be kept and never read — the labels have to move whatever
     the step does, so the guard could never have skipped a redraw. */
  map.on('moveend zoomend', () => {
    if (map.hasLayer(graticule)) draw();
  });
  map.on('overlayadd', (e: L.LayersControlEvent) => {
    if (e.layer === graticule) draw();
  });

  return graticule;
}
