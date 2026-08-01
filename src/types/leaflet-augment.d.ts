/**
 * Declares L.velocityLayer, which leaflet-velocity adds to Leaflet at import
 * time. Covers only the options this site sets (verified against
 * node_modules/leaflet-velocity/dist/leaflet-velocity.js).
 *
 * The import below is load-bearing: without it this file would be ambient
 * and `declare module 'leaflet'` would shadow @types/leaflet outright rather
 * than extend it, taking every other L.* method down with it.
 */
import 'leaflet';

declare module 'leaflet' {
  interface VelocityLayerOptions {
    /** Two grib2json-shaped objects: eastward, then northward. */
    data: unknown;
    /** Leaflet pane to draw into; the layer creates it if absent. */
    paneName?: string;
    /** Hover readout control. */
    displayValues?: boolean;
    displayOptions?: Record<string, unknown>;
    /** Screen speed of the particles, not a physical quantity. */
    velocityScale?: number;
    /** Ends of the colour ramp, in the data's units (m/s here). */
    minVelocity?: number;
    maxVelocity?: number;
    colorScale?: string[];
    particleAge?: number;
    particleMultiplier?: number;
    lineWidth?: number;
    frameRate?: number;
    opacity?: number;
  }

  function velocityLayer(options: VelocityLayerOptions): Layer;
}
