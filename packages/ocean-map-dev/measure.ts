/* The measuring tool: great-circle distance and bearing between clicked
   points.

   Lifted out of `index.ts`, where it was declared 700 lines *below* one of
   its callers. That worked only because the caller was inside a click
   handler that could not run until later — the exact shape of hazard the
   split exists to remove. As a module the dependency is a parameter and an
   import, not a line number.

   Distance and bearing are both **great-circle**. A rhumb line is what you
   would steer, but quoting the two from different geometries invites the
   reader to combine them into something that is neither. */
import L from 'leaflet';
import { coordText, initialBearing, spanText } from './geo';
import { palette } from './palette';

export interface MeasureTool {
  /** Whether the reader has the tool switched on. Live, not a snapshot. */
  readonly active: boolean;
  /** Add a point to the run. Callers pass a feature's own position rather
      than the click, so a leg drawn to a glider ends where the glider is. */
  addPoint(at: L.LatLng): void;
  /** Switch the tool off and clear the run. */
  stop(): void;
}

/**
 * Builds the tool, its control and its handlers. The map gets a 📏 button;
 * the caller gets a handle for the one case it has to know about — a click
 * on a feature, which the feature claims before the map sees it.
 */
export function createMeasureTool(map: L.Map, host: HTMLElement): MeasureTool {
  const MEASURE = palette.features.measure;

  const measured = L.layerGroup().addTo(map);
  let measuring = false;
  let points: L.LatLng[] = [];
  let readout: HTMLElement | null = null;
  let button: HTMLAnchorElement | null = null;

  const draw = () => {
    measured.clearLayers();
    if (!points.length) return;

    if (points.length > 1) {
      /* A light halo under a dark line, so the measurement reads on the
         pale Esri basemap and the dark GEBCO one alike. The halo is an
         outline, themed in CSS like the track casings rather than gated
         as a feature colour. */
      L.polyline(points, { className: 'map-measure-halo', weight: 6, lineCap: 'round' }).addTo(measured);
      L.polyline(points, {
        color: MEASURE,
        weight: 2.5,
        dashArray: '7,5',
        lineCap: 'round',
      }).addTo(measured);
    }

    points.forEach((point, i) => {
      L.circleMarker(point, {
        radius: 4,
        color: MEASURE,
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
      })
        .addTo(measured)
        .bindTooltip(
          i === 0
            ? `Start · ${coordText(point)}`
            : `Leg ${i}: ${spanText(points[i - 1]!.distanceTo(point))} · ` +
              `${initialBearing(points[i - 1]!, point).toFixed(0)}°T<br>${coordText(point)}`,
          { direction: 'top' }
        );
    });

    if (readout) {
      const total = points.reduce(
        (sum, point, i) => (i ? sum + points[i - 1]!.distanceTo(point) : 0),
        0
      );
      const legs = points.length - 1;
      readout.textContent =
        legs < 1
          ? 'Click a second point'
          : `${spanText(total)}${legs > 1 ? ` over ${legs} legs` : ''} · ` +
            `${initialBearing(points[0]!, points[points.length - 1]!).toFixed(0)}°T direct`;
    }
  };

  const setMeasuring = (on: boolean) => {
    measuring = on;
    host.style.cursor = on ? 'crosshair' : '';
    if (!on) {
      points = [];
      measured.clearLayers();
    }
    if (readout) readout.textContent = on ? 'Click a point to start' : '';
    if (button) {
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('active', on);
    }
  };

  const Measure = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar measure-control');
      button = L.DomUtil.create('a', '', bar) as HTMLAnchorElement;
      button.href = '#';
      button.textContent = '📏';
      button.title = 'Measure distance and bearing';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Measure distance and bearing');
      button.setAttribute('aria-pressed', 'false');
      readout = L.DomUtil.create('span', 'measure-readout', bar);
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.stop(e);
        setMeasuring(!measuring);
      });
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    },
  });
  map.addControl(new Measure());

  const addPoint = (at: L.LatLng) => {
    points.push(at);
    draw();
  };

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (!measuring) return;
    addPoint(e.latlng);
  });

  /* Escape is bound on the document rather than the container, which is the
     one thing here that reaches outside its own map: a reader pressing
     Escape has usually not clicked into the map first, so a container-scoped
     handler would never see it. With two maps on a page it cancels both,
     which is the behaviour a global cancel key should have anyway. */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && measuring) setMeasuring(false);
  });

  return {
    get active() {
      return measuring;
    },
    addPoint,
    stop: () => setMeasuring(false),
  };
}
