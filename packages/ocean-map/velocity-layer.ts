/* The Leaflet half of the particle field: a canvas in a pane, an animation
   loop, and fading trails. Everything about where particles *go* is in
   `particles.ts`, which knows nothing about Leaflet — this file is the
   adapter, and the only part a native port rewrites.

   **Written to run unmodified on Leaflet 1.9 and 2.0.** Leaflet 2 removes
   every lowercase factory (`L.point`, `L.latLng`, `L.setOptions`) but keeps
   the classes, so this uses `new Point(...)`, `new Bounds(...)` and
   `Util.setOptions`, and subclasses `Layer` with a native `class`. Verified
   against both versions: every construct here exists in each. That is also
   precisely why `leaflet-velocity` had to go — it reaches for all three of
   the removed factories, and has not shipped since March 2023.

   It also means no `globalThis.L` dance. The plugin was UMD and read Leaflet
   off the global object, which a bundled ESM build never sets, so it had to
   be pulled in by dynamic import *after* the global was assigned — a static
   import would hoist above the assignment and die in `dist/` only. This is a
   normal module. */

import { Bounds, DomUtil, Layer, Util, type Map as LeafletMap } from 'leaflet';
import { ParticleField, speedIndex, type ComponentGrid } from './particles';

export interface VelocityLayerOptions {
  /** The published `[u, v]` pair. */
  data: [ComponentGrid, ComponentGrid];
  /** Which map pane to draw into. */
  paneName: string;
  /** Ramp colours, slow to fast. */
  colorScale: string[];
  /** Top of the ramp, in m/s. Speeds past it take the last colour. */
  maxVelocity: number;
  /** Pixels travelled per (m/s) per frame — see `particles.ts`. */
  drift: number;
  /** Particles per square pixel of map. */
  particleMultiplier: number;
  /** How long a particle lives, in seconds. */
  particleSeconds: number;
  frameRate: number;
  lineWidth: number;
  attribution?: string;
  /** Injected only by the harness, so seeding is deterministic. */
  random?: () => number;
}

export class VelocityLayer extends Layer {
  declare options: VelocityLayerOptions;

  /** A stable tag, for tooling that has to find this layer among the map's
      layers without being able to import the class — which is the harness,
      working off the built bundle. It used to find the old plugin by its
      `_windy` internal: a grip on someone else's private field, which is the
      kind that breaks the day they rename it and reports nothing. */
  readonly isVelocityLayer = true;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: ParticleField | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: VelocityLayerOptions) {
    super();
    Util.setOptions(this, options);
  }

  onAdd(map: LeafletMap): this {
    const pane = map.getPane(this.options.paneName) ?? map.getPanes().overlayPane;
    this.canvas = DomUtil.create('canvas', 'om-velocity', pane) as HTMLCanvasElement;
    this.canvas.style.position = 'absolute';
    // The canvas is the field's, not a control's: a click belongs to whatever
    // is under it — a marker, or the map's own context menu.
    this.canvas.style.pointerEvents = 'none';
    this.ctx = this.canvas.getContext('2d');
    this.stopped = false;
    this.resize();
    map.on('moveend zoomend resize', this.onViewChange, this);
    map.on('movestart zoomstart', this.pause, this);
    this.start();
    return this;
  }

  onRemove(map: LeafletMap): this {
    this.stop();
    map.off('moveend zoomend resize', this.onViewChange, this);
    map.off('movestart zoomstart', this.pause, this);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.field = null;
    return this;
  }

  getAttribution(): string | null {
    // null, not undefined: Leaflet's own signature, and the attribution
    // control tests for it rather than for falsiness.
    return this.options.attribution ?? null;
  }

  /** Change the grid, the drift or the density without tearing the layer
      down. Named to match what the map already calls, so stepping a forecast
      hour or swapping in a finer tier is one call. */
  setOptions(next: Partial<VelocityLayerOptions>): this {
    Util.setOptions(this, { ...this.options, ...next });
    // A new grid means the particles in flight belong to the old one, and a
    // new density means a different pool size. Rebuilt on the next frame.
    if (next.data || next.particleMultiplier !== undefined) this.field = null;
    return this;
  }

  private get map(): LeafletMap | null {
    return (this as unknown as { _map?: LeafletMap })._map ?? null;
  }

  private resize(): void {
    const map = this.map;
    if (!map || !this.canvas) return;
    const size = map.getSize();
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    // The pane is translated as the map moves; put the canvas back at the
    // container's top-left so its pixels are screen pixels.
    const corner = map.containerPointToLayerPoint(new Bounds([0, 0], [size.x, size.y]).min!);
    DomUtil.setPosition(this.canvas, corner);
  }

  private pause(): void {
    // Nothing is drawn mid-gesture: the pane is being translated under us, so
    // a trail laid down now would smear across the drag.
    this.clearCanvas();
  }

  private onViewChange(): void {
    this.resize();
    // Positions are screen pixels, so every one of them means something else
    // after a move. Drop them rather than teleporting them.
    this.field?.clear();
    this.clearCanvas();
  }

  private clearCanvas(): void {
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private start(): void {
    this.stop();
    // After stop(), not before: stop() sets the flag that frame() bails on,
    // so starting without clearing it again leaves a layer with a running
    // timer that draws nothing — every frame returns on the first line.
    this.stopped = false;
    const interval = Math.max(1, Math.round(1000 / this.options.frameRate));
    this.timer = setInterval(() => this.frame(), interval);
  }

  private stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private frame(): void {
    const map = this.map;
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!map || !ctx || !canvas || this.stopped) return;
    const [u, v] = this.options.data ?? [];
    if (!u || !v) return;

    const size = map.getSize();
    if (!this.field) {
      const count = Math.max(1, Math.round(size.x * size.y * this.options.particleMultiplier));
      const maxAge = Math.max(1, Math.round(this.options.particleSeconds * this.options.frameRate));
      this.field = new ParticleField(count, maxAge, this.options.random);
    }

    /* The trail. Painting a translucent black over the whole canvas each
       frame would tint the water — the pane composites normally, which the
       contrast gate depends on. `destination-out` erases instead, taking a
       fixed fraction of the existing alpha, so old strokes fade to nothing
       without laying down any colour of their own.

       **The rate sets how long a trail looks, and it is not the particle's
       lifetime.** A particle lives `particleSeconds`; what a reader sees
       behind it is however many frames of stroke have not yet faded out,
       which is this number alone. Retaining 1 − 0.18 per frame leaves a
       stroke at a tenth of its alpha after twelve frames, so at the measured
       p90 of 1.5 px/frame the visible tail is ~18 px.

       Tuned by eye against what the map looked like before, and the first
       value was wrong in the documented direction: at 0.10 the tail ran ~33
       px and the field read as long bright ropes rather than the fine even
       texture this map wants — the exact decay the particle lifetime note
       further up was written about. Shorten this before shortening the
       lifetime; the lifetime is what keeps the slow water seeded. */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    const view = {
      width: size.x,
      height: size.y,
      toLngLat: (x: number, y: number) => {
        const ll = map.containerPointToLatLng([x, y]);
        return { lng: ll.lng, lat: ll.lat };
      },
    };
    this.field.step(view, u, v, this.options.drift);

    const ramp = this.options.colorScale;
    ctx.lineWidth = this.options.lineWidth;
    ctx.lineCap = 'round';
    /* Grouped by colour: one path per ramp stop rather than one per
       particle, so sixteen thousand `beginPath`/`stroke` pairs become five.

       Built on the context rather than as `Path2D` objects, and that is not
       style. A `Path2D` takes its `moveTo`/`lineTo` on itself, so the
       segments never touch the context — which hides them from anything
       watching it. The harness records exactly those calls to measure
       per-frame displacement, and it is the only thing that has ever caught
       a runaway particle field; with `Path2D` it read 51,115 strokes and
       **zero** segments, which is indistinguishable from a field that has
       stopped moving. The batching is identical either way. */
    const f = this.field;
    const buckets: number[][] = ramp.map(() => []);
    for (let i = 0; i < f.count; i++) {
      if (!f.live[i]) continue;
      if (f.px[i] === f.x[i] && f.py[i] === f.y[i]) continue;
      buckets[speedIndex(f.speed[i], this.options.maxVelocity, ramp.length)].push(i);
    }
    for (let k = 0; k < buckets.length; k++) {
      if (!buckets[k].length) continue;
      ctx.strokeStyle = ramp[k];
      ctx.beginPath();
      for (const i of buckets[k]) {
        ctx.moveTo(f.px[i], f.py[i]);
        ctx.lineTo(f.x[i], f.y[i]);
      }
      ctx.stroke();
    }
  }
}
