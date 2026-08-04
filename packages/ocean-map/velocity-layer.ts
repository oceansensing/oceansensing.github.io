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

import { DomUtil, Layer, Util, type Point, type Map as LeafletMap } from 'leaflet';
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
  private raf: number | null = null;
  private lastFrame = 0;
  private stopped = false;
  /** Where the canvas currently sits, in layer points. Kept so a pan can be
      measured and the field carried across it rather than reseeded. */
  private corner: Point | null = null;
  /** True between movestart and moveend. The field freezes rather than
      clearing: the canvas translates with the pane during a drag, so the
      trails stay over the water they belong to and simply come along. */
  private moving = false;

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
    this.reposition(true);
    map.on('moveend zoomend resize', this.onViewChange, this);
    map.on('movestart zoomstart', this.freeze, this);
    this.start();
    return this;
  }

  onRemove(map: LeafletMap): this {
    this.stop();
    map.off('moveend zoomend resize', this.onViewChange, this);
    map.off('movestart zoomstart', this.freeze, this);
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

  /** Put the canvas back over the viewport, and carry the field with it.

      The canvas is placed at a **layer point**, so during a drag it is
      translated by the pane along with everything else and the trails stay
      over the water they were drawn for. At the end of the gesture it has to
      be moved back to cover the new viewport — and that move is the whole
      problem this method exists to solve, because naively it means throwing
      the field away.

      A pan does not invalidate anything: the water has not moved, only the
      window onto it. So the particles are slid by the same offset the canvas
      moved, and the already-drawn trails are slid with them by copying the
      canvas onto itself. Nothing is lost and nothing has to rebuild.

      A **zoom or a resize** does reset, because screen distance stops meaning
      the same thing — a trail drawn at the old scale would be the wrong
      length, and the canvas is cleared by resizing it in any case. */
  private reposition(reset: boolean): void {
    const map = this.map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();

    // Only when it actually changed: assigning width clears the canvas, and
    // doing that on every pan is exactly the flash this is here to avoid.
    const resized = canvas.width !== size.x || canvas.height !== size.y;
    if (resized) {
      canvas.width = size.x;
      canvas.height = size.y;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }

    const corner = map.containerPointToLayerPoint([0, 0]);
    const previous = this.corner;
    DomUtil.setPosition(canvas, corner);
    this.corner = corner;

    if (reset || resized || !previous) {
      this.field?.clear();
      this.clearCanvas();
      return;
    }

    const dx = previous.x - corner.x;
    const dy = previous.y - corner.y;
    if (!dx && !dy) return;
    this.field?.shift(dx, dy);
    if (this.ctx) {
      // `copy` rather than the default, or the shifted image would be
      // composited over the original and every trail would be drawn twice.
      this.ctx.globalCompositeOperation = 'copy';
      this.ctx.drawImage(canvas, dx, dy);
      this.ctx.globalCompositeOperation = 'source-over';
    }
  }

  private freeze(): void {
    // Frozen, not blanked. The canvas rides along with the pane, so the field
    // stays visible and correctly placed for the whole gesture; advecting it
    // would be wrong, because canvas coordinates stop matching container
    // coordinates the moment the pane starts moving.
    this.moving = true;
  }

  private onViewChange(e?: { type?: string }): void {
    this.reposition(e?.type === 'zoomend' || e?.type === 'resize');
    this.moving = false;
  }

  private clearCanvas(): void {
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private start(): void {
    this.stop();
    // After stop(), not before: stop() sets the flag that frame() bails on,
    // so starting without clearing it again leaves a layer with a running
    // loop that draws nothing — every frame returns on the first line.
    this.stopped = false;
    this.lastFrame = 0;

    /* **requestAnimationFrame, not setInterval**, and the difference is a
       background tab. A hidden tab pauses rAF entirely; `setInterval` is only
       throttled to about 1 Hz and keeps running. This layer advects up to
       16,000 particles per step, so on a timer it would go on doing that once
       a second forever on a page nobody is looking at — and this page is one
       people leave open, since it refreshes itself hourly by design.

       Shipped on a timer first, which is how the difference got noticed. The
       plugin this replaced used rAF, so the behaviour was already correct
       before and the change would have been a silent regression: nothing on
       screen looks different, a hidden tab just keeps burning CPU.

       The frame rate is a gate on top rather than a separate timer. rAF runs
       at the display's rate, so without this the field would animate at 60 or
       120 fps instead of the 18 it is tuned for — and particle drift is per
       *frame*, so it would also move three to six times too fast. */
    const loop = (now: number) => {
      if (this.stopped) return;
      this.raf = requestAnimationFrame(loop);
      const interval = 1000 / this.options.frameRate;
      if (now - this.lastFrame < interval) return;
      this.lastFrame = now;
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.stopped = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private frame(): void {
    const map = this.map;
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!map || !ctx || !canvas || this.stopped || this.moving) return;
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
