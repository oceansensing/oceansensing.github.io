/* The particle field: sampling a u/v grid, and advecting a pool of particles
   through it. No Leaflet, no DOM — see S1 in BOUNDARIES.md. The renderer
   supplies a projection and draws the segments this produces; everything
   about *where the particles go* is here, and a native port keeps it.

   This replaces `leaflet-velocity`, which was last released in March 2023,
   is UMD-only, and reaches for `L.latLng`, `L.point` and `L.setOptions` —
   all three removed in Leaflet 2. Two things are deliberately different:

   **Land is respected.** The plugin hands its interpolator `[u, v]` — an
   array, so always truthy, so its `isValue()` check passes — and then
   multiplies straight through a bilinear blend where `null` becomes zero. A
   cell partly over land therefore yields a reduced but *non-zero* velocity
   defined over the land, and particles advect onto it and keep going. Here a
   null nearest cell means no water, full stop, and the blend renormalises
   over whichever corners are wet — the same two-step rule the scalar field
   sampler already uses, and for the same reason.

   **There is no velocity scale to get wrong.** The plugin turned a velocity
   into a screen displacement by multiplying by a `velocityScale`, then by
   `mapArea^0.4`, then by the projection's Jacobian, and three of the four
   particle bugs this map has shipped were about cancelling those correctly.
   None of it is needed. Web Mercator is **conformal**: a geographic vector
   (u east, v north) maps to the screen direction (u, −v) scaled by a single
   local factor, whatever the latitude or zoom. Dropping that factor is what
   makes the drift a constant number of pixels per m/s everywhere, which is
   exactly the property all that arithmetic was labouring to recover. So the
   whole of it is `x += u * drift`.

   The cost of dropping it is worth stating: particles no longer move at
   *screen-accurate* speed, so a current at 60°N — where Mercator stretches
   the ground — appears to drift at the same pixel rate as the same current
   at the equator. Direction stays exact, and relative speeds within a view
   stay exact. That was already the behaviour, since the old code divided the
   Jacobian out at the view centre; it is now the behaviour on purpose. */

/** What a renderer must tell the field about the view it is drawing into. */
export interface ParticleView {
  width: number;
  height: number;
  /** Screen pixel to geographic degrees. The one thing only a renderer knows. */
  toLngLat(x: number, y: number): { lng: number; lat: number };
}

/** One component of a published vector pair — see `VectorGrid` in schema.ts.
    Restated structurally rather than imported so this file stays free of
    anything that might drag a renderer in behind it. */
export interface ComponentGrid {
  header: { nx: number; ny: number; lo1: number; la1: number; dx: number; dy: number };
  data: (number | null)[];
}

/** Deterministic seeding, so the harness can assert where particles land.
    Defaults to Math.random in a browser. */
export type Random = () => number;

/* Sampling ------------------------------------------------------------- */

/** Bilinear u/v at a point, or null where there is no water.

    Two steps, and the order matters. The **nearest** cell decides whether
    this point is water at all, which keeps the field's edge exactly where
    the data's own mask puts it. Only then are the four corners blended, with
    the weights renormalised over whichever of them are wet — interpolating
    through a null would drag a phantom zero into the average and bend the
    flow towards the coast. */
export function sampleVector(
  u: ComponentGrid,
  v: ComponentGrid,
  lng: number,
  lat: number
): { u: number; v: number } | null {
  const h = u.header;
  // Floored modulo: the grids start at 0°E and half the world is west of
  // that, so a bare remainder is negative for the western hemisphere.
  const x = (((lng - h.lo1) % 360) + 360) % 360 / h.dx;
  const y = (h.la1 - lat) / h.dy;
  if (y < 0 || y > h.ny - 1) return null;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  // The column after the last is the first when the grid spans a full turn.
  // Clamping instead leaves a one-cell seam nothing paints, which is how the
  // scalar field once drew a stripe down the prime meridian.
  const wrap = Math.abs(h.nx * h.dx - 360) < h.dx;
  const col = (i: number) => (wrap ? ((i % h.nx) + h.nx) % h.nx : Math.min(Math.max(i, 0), h.nx - 1));
  const row = (j: number) => Math.min(Math.max(j, 0), h.ny - 1);

  const at = (i: number, j: number) => row(j) * h.nx + col(i);
  const nearest = at(Math.round(x), Math.round(y));
  if (u.data[nearest] === null || u.data[nearest] === undefined) return null;

  let su = 0;
  let sv = 0;
  let w = 0;
  for (let k = 0; k < 4; k++) {
    const ci = x0 + (k & 1);
    const cj = y0 + (k >> 1);
    const weight = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    const idx = at(ci, cj);
    const cu = u.data[idx];
    const cv = v.data[idx];
    if (cu === null || cu === undefined || cv === null || cv === undefined) continue;
    su += cu * weight;
    sv += cv * weight;
    w += weight;
  }
  if (w === 0) return null;
  return { u: su / w, v: sv / w };
}

/* The pool ------------------------------------------------------------- */

/** A pool of particles advecting through a vector field.

    Positions are screen pixels and stay there: a particle is seeded in the
    view, stepped in the view, and retired when it leaves. Flat typed arrays
    rather than objects because at sixteen thousand particles the allocation
    churn of one object per particle per frame is the whole frame budget —
    and because this is the shape a Swift port wants too. */
export class ParticleField {
  /** Where each particle is now, and where it was last frame. The renderer
      strokes between the two, which is what makes a trail rather than a dot. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** Speed in m/s, for colouring. */
  readonly speed: Float32Array;
  /** Frames lived. A particle is respawned past `maxAge` even if it is still
      in water, which is what keeps the field evenly covered: particles advect
      into the fast cores and stay there, so without respawning the picture
      decays from an even texture into a few long ropes with bare water
      between them. */
  readonly age: Int32Array;
  /** Whether this particle has anywhere to be. A dead one is skipped by the
      renderer and reseeded on the next step. */
  readonly live: Uint8Array;

  readonly count: number;
  private readonly maxAge: number;
  private readonly random: Random;

  constructor(count: number, maxAge: number, random: Random = Math.random) {
    this.count = Math.max(0, Math.floor(count));
    this.maxAge = Math.max(1, Math.floor(maxAge));
    this.random = random;
    this.x = new Float32Array(this.count);
    this.y = new Float32Array(this.count);
    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.speed = new Float32Array(this.count);
    this.age = new Int32Array(this.count);
    this.live = new Uint8Array(this.count);
  }

  /** Drop every particle. The next step reseeds them, so a view change does
      not need its own seeding pass. */
  clear(): void {
    this.live.fill(0);
  }

  private seed(i: number, view: ParticleView): void {
    this.x[i] = this.random() * view.width;
    this.y[i] = this.random() * view.height;
    this.px[i] = this.x[i];
    this.py[i] = this.y[i];
    // Staggered rather than zero, or every particle in the pool would expire
    // on the same frame and the field would pulse.
    this.age[i] = Math.floor(this.random() * this.maxAge);
    this.live[i] = 1;
  }

  /** Advance one frame. `drift` is pixels travelled per (m/s) per frame —
      see the note at the top of this file for why that is the only constant
      involved. Returns how many particles are drawable this frame. */
  step(view: ParticleView, u: ComponentGrid, v: ComponentGrid, drift: number): number {
    let drawable = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.live[i]) {
        this.seed(i, view);
        // Seeded this frame: no previous position, so nothing to stroke yet.
        continue;
      }
      if (++this.age[i] > this.maxAge) {
        this.live[i] = 0;
        continue;
      }
      const here = view.toLngLat(this.x[i], this.y[i]);
      const flow = sampleVector(u, v, here.lng, here.lat);
      if (!flow) {
        // Land, or off the grid. Retire rather than freeze: a particle stuck
        // on a coastline is a bright stationary dot, which reads as a marker.
        this.live[i] = 0;
        continue;
      }
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      // Screen y grows downward; v is northward. Mercator is conformal, so
      // this is the true direction and the magnitude is ours to choose.
      this.x[i] += flow.u * drift;
      this.y[i] -= flow.v * drift;
      this.speed[i] = Math.hypot(flow.u, flow.v);
      if (this.x[i] < 0 || this.x[i] >= view.width || this.y[i] < 0 || this.y[i] >= view.height) {
        this.live[i] = 0;
        continue;
      }
      drawable++;
    }
    return drawable;
  }
}

/** Which colour a speed belongs to: an index into a ramp of `stops` colours,
    clamped. Separate from the ramp itself so `ramp.ts` keeps owning colour
    and this file keeps owning motion. */
export function speedIndex(speed: number, max: number, stops: number): number {
  if (!(max > 0) || stops < 1) return 0;
  const t = Math.min(Math.max(speed / max, 0), 1);
  return Math.min(stops - 1, Math.floor(t * stops));
}
