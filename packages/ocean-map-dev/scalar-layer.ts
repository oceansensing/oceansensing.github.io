/* The scalar field layer: one canvas painting one grid of numbers.

   Temperature, salinity, ice concentration and ice thickness are the same
   kind of thing — a value per cell, drawn as a raster — so they share this
   layer, the tier machinery and the readout, and differ only in their
   entry in `FIELDS`. A new scalar is an entry there and one in the
   pipeline's PRODUCTS, not another layer.

   Lifted out of `index.ts`. It closed over two pieces of the reader's own
   state — the colormap they picked and any range they pinned — which is
   what kept it in that closure. Those come in as one `choice()` accessor
   now, read at draw time so a colour change still lands on the next
   repaint, and they stay per-map: two maps on a page keep separate colour
   scales, which module-level state would have quietly merged. */
import L from 'leaflet';
import { rampColour } from './ramp';
import type { ScalarGrid } from './schema';

/* How far past the visible edge the raster is painted, as a fraction of the
   viewport on every side.

   The same 30% the particle field uses, and for the same reason: the canvas
   is positioned in *layer* coordinates, so a drag carries it and whatever
   was painted stays over the water it was painted for. Without a margin the
   strip a pan reveals is simply unpainted until the next `moveend` render,
   so the field arrives a beat after the basemap under it.

   It costs 1.6x in each dimension, so 2.56x the pixels — see the note on
   `_render`, where that is measured rather than assumed. */
const VIEW_MARGIN = 0.3;

/* What a scalar layer needs to know about the quantity it is painting.
   `FIELDS` below is the whole set; a new scalar is an entry there and one in
   the pipeline's PRODUCTS, not another layer. */
export interface FieldDescriptor {
  key: string;
  unit: string;
  /** The colour bar rounds outward to this. */
  step: number;
  label: string;
  /** Bounds the *automatic* range, where the extremes are not ocean — see
      the salinity note in FIELDS. A pinned range ignores it. */
  autoClamp?: [number, number];
  /** Which pane to paint into. Fields sharing a pane occlude each other
      and so must be mutually exclusive; a field with its own pane can be
      read on top of another — which only works because ice has a draw
      floor and is therefore transparent over most of the ocean. */
  pane?: string;
  /** Shown as a percentage rather than as the fraction it is stored as.

      Ice concentration is published 0–1 and reported by every ice service
      in percent — the edge is "the 15% contour", a full floe is "90%
      ice". A legend reading "0.15 to 1" is the number the file holds and
      not the number anybody says. Display only: the data, the pinned
      range and the contour threshold all stay fractions, so nothing has
      to be converted back and the trap that `icec` fell into — a unit
      label disagreeing with the values — cannot be reintroduced here. */
  percent?: boolean;
  /** Below this the field is not drawn at all, and is not counted when the
      automatic range is measured.

      Temperature and salinity have no such value: every reading is the
      ocean, and a raster covering all of it is the point. Ice
      concentration is the opposite — most of the sea has none, and the two
      products do not even agree on how to say so. The analysis masks open
      water as missing; the forecast writes a real 0, so 37,530 cells that
      one omits the other reports as ice-free ocean. Drawn literally, the
      forecast layer paints the entire ocean in the ramp's bottom colour
      and hides the basemap, while the analysis of the same hour paints
      only the pack — two renderings of one quantity that look nothing
      alike.

      Discarding it upstream was the alternative and is worse: 0 is true,
      and the edge contour is cut from exactly that 0-to-non-0 boundary.
      So the pipeline publishes what the model says and the floor lives
      here, at the same 15% the edge uses, which also makes the two
      products draw the same thing. */
  drawAbove?: number;
}

/* One entry per scalar field the map can paint. Temperature and salinity
   are the same kind of thing — a value per cell, drawn as a raster — so
   they share the layer, the tier machinery and the readout, and differ
   only in what is listed here. */
/** Whether a value falls under its field's draw floor. */
export const below = (field: FieldDescriptor | undefined, v: number) =>
  field?.drawAbove !== undefined && v < field.drawAbove;

export const FIELDS: Record<string, FieldDescriptor> = {
  // "Sea surface" alone stopped being unambiguous the moment a second
  // surface field existed.
  sst: { key: 'sst', unit: '°C', step: 1, label: 'Sea surface temp' },
  /* Salinity gets a half-unit step where temperature gets a whole one.
     Both round outward to bound the water in view, but open ocean spans
     maybe 34–37 psu against 10 °C or more of temperature — rounding
     salinity to whole units would leave a typical view occupying a
     quarter of the ramp and looking flat. */
  /* And its automatic range is held to oceanic values. Salinity is the
     one field here whose extremes are not ocean at all: river plumes and
     estuaries run to single figures — this model reaches 3 psu in
     Chesapeake Bay — so one bay in the corner of a view stretched the
     ramp across water nobody was looking at and flattened the 34-37 psu
     where the fronts actually are. Clamping the *automatic* bounds to
     29-39 spends the ramp on seawater; fresher water simply pins to the
     bottom stop, which is the honest thing for it to do on a scale
     labelled in psu. A range the reader pins by hand is untouched — this
     bounds what "Auto" chooses, not what they are allowed to ask for. */
  sss: { key: 'sss', unit: 'psu', step: 0.5, label: 'Salinity', autoClamp: [29, 39] },
  /* Sea ice concentration, as a fraction. The range is pinned by
     `autoClamp` to the whole of it rather than bounded to the view: a
     per-view range is right for temperature, where a basin spans ten of
     the ocean's thirty degrees and a fixed scale would waste the ramp,
     and wrong here, because 0.15-1.0 *is* the whole scale and rescaling
     it to whatever pack happens to be on screen would make the same
     colour mean a different concentration in every view. Ice is read as
     "how packed", not "how packed relative to here". */
  sic: {
    key: 'sic', unit: '%', step: 0.05, label: 'Ice concentration',
    autoClamp: [0.15, 1], drawAbove: 0.15, percent: true, pane: 'ice',
  },
  /* Thickness in metres. Unlike concentration this is *not* pinned to a
     fixed scale: 0-15 m spans ridged multi-year ice that almost no view
     contains, so a fixed bar would leave a typical Arctic summer view in
     the bottom fifth of the ramp. It bounds the automatic range instead,
     the way salinity does. The floor is 0.1 m — thinner than that is
     nominal ice the concentration field already shows better. */
  sit: {
    key: 'sit', unit: 'm', step: 0.25, label: 'Ice thickness',
    autoClamp: [0, 8], drawAbove: 0.1, pane: 'ice',
  },
};

/* What the reader has chosen for a field, read fresh on every paint.

   A snapshot taken at construction would freeze the colour scale at
   whatever it was when the grid first arrived — and the layer is built
   when its data lands, which is before most readers have touched
   anything. */
export interface ScalarChoice {
  /** The selected colormap, already expanded to stops. */
  stops: number[][];
  /** A range pinned by hand, or null to bound it to the water in view. */
  range: [number, number] | null;
}

export interface ScalarLayerOptions {
  field: FieldDescriptor;
  choice: () => ScalarChoice;
}

/* What L.Layer.extend gives back. Leaflet's typings stop at the base class,
   so the members added below have to be declared for callers to see them —
   without this every use site reached for `any` and the layer's own API was
   invisible. */
export interface ScalarLayer extends L.Layer {
  options: L.LayerOptions & ScalarLayerOptions;
  _grid: ScalarGrid | null;
  _canvas: HTMLCanvasElement | null;
  _range: [number, number] | null;
  setGrid(grid: ScalarGrid): ScalarLayer;
  getGrid(): ScalarGrid | null;
  getRange(): [number, number] | null;
  _rangeFor(sampled: number[]): [number, number] | null;
  _render(): void;
}

const SstLayer = L.Layer.extend({
  /* Leaflet's Class only passes constructor arguments through when the
     class defines initialize — without this the field descriptor is
     silently dropped and the layer paints with no ramp. */
  initialize(this: ScalarLayer, options: ScalarLayerOptions) {
    L.setOptions(this, options);
  },
  onAdd(this: ScalarLayer, map: L.Map) {
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer map-sst');
    map.getPane(this.options.field?.pane ?? 'sst')!.appendChild(this._canvas);
    map.on('moveend zoomend resize viewreset', this._render, this);
    this._render();
  },
  onRemove(this: ScalarLayer, map: L.Map) {
    map.off('moveend zoomend resize viewreset', this._render, this);
    this._canvas?.remove();
    this._canvas = null;
  },
  setGrid(this: ScalarLayer, grid: ScalarGrid) {
    this._grid = grid;
    this._render();
    return this;
  },
  getGrid(this: ScalarLayer) {
    return this._grid ?? null;
  },
  getRange(this: ScalarLayer) {
    return this._range ?? null;
  },
  /* The range the ramp is stretched over: the whole-degree bounds of the
     water actually in view, not a fixed global scale.

     A fixed scale wastes almost all of the ramp — a basin spans maybe
     ten degrees out of the thirty-odd the ocean covers, so everything on
     screen came out within a couple of shades of itself. Rescaling per
     view spends the entire ramp on the water you are looking at, which
     is what makes a front visible. The cost is that colour no longer
     means the same temperature between two views, which is why the
     legend prints the bounds rather than a fixed key. */
  _rangeFor(this: ScalarLayer, sampled: number[]) {
    if (!sampled.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of sampled) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const step = this.options.field?.step ?? 1;
    /* Snapped back to the step's own precision after the arithmetic.
       `Math.floor(0.15 / 0.05) * 0.05` is 0.1 and the ceil of the same
       pair overshoots to 0.15000000000000002 — a step that is not a
       binary fraction cannot survive the round trip. Temperature steps by
       1 and salinity by 0.5, both exact, so this was invisible until ice
       arrived with 0.05 and printed its own range into the legend. */
    const snap = (v: number) => Number(v.toFixed(6));
    lo = snap(Math.floor(snap(lo / step)) * step);
    hi = snap(Math.ceil(snap(hi / step)) * step);
    /* Some fields have automatic bounds worth holding to a sensible
       window — see the salinity note in FIELDS. Applied after rounding
       so the clamp lands exactly on the stated numbers. */
    const clamp = this.options.field?.autoClamp;
    if (clamp) {
      lo = Math.max(lo, clamp[0]);
      hi = Math.min(hi, clamp[1]);
      // A view entirely outside the window (an estuary, say) would leave
      // an inverted range; collapse it to the nearest edge instead.
      if (hi <= lo) {
        lo = Math.min(Math.max(lo, clamp[0]), clamp[1] - step);
        hi = lo + step;
      }
    }
    // A view of uniform water would otherwise divide by zero and paint
    // one flat colour; one step of headroom keeps it a gradient.
    if (hi <= lo) hi = lo + step;
    return [lo, hi] as [number, number];
  },
  _render(this: ScalarLayer) {
    const map: L.Map = this._map;
    const cv: HTMLCanvasElement | null = this._canvas;
    if (!map || !cv) return;

    const size = map.getSize();
    /* Whole pixels, so the container-point offsets below stay integers and
       a row or column cannot land half a pixel off the lattice. */
    const mx = Math.round(size.x * VIEW_MARGIN);
    const my = Math.round(size.y * VIEW_MARGIN);
    if (cv.width !== size.x + mx * 2 || cv.height !== size.y + my * 2) {
      cv.width = size.x + mx * 2;
      cv.height = size.y + my * 2;
    }
    /* Pinned in *layer* coordinates, offset by the margin, so the pane
       carries it through a drag and the pre-painted margin is already over
       the water it belongs to when that water comes into view. */
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([-mx, -my]));

    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const grid: ScalarGrid | null = this._grid;
    if (!grid?.header) return;

    const h = grid.header;
    const w = cv.width;
    const ht = cv.height;

    /* Web Mercator is separable — longitude depends only on the column,
       latitude only on the row — so the projection is inverted once per
       column and once per row rather than once per pixel: about 1,700
       calls instead of 650,000. containerPointToLatLng is used rather
       than any assumed formula, and unlike latLngToContainerPoint it
       does not round, which is what made the particle scaling wrong. */
    /* Cell coordinates, kept fractional: the coarsest tier is a degree
       across, which at low zoom is tens of pixels, and nearest-neighbour
       there paints the ocean as a chessboard of squares that look like
       structure in the data rather than the sampling. */
    /* A grid whose columns span the full globe has no edge: the cell
       after the last one is the first. Clamping there instead leaves a
       one-cell column at the seam that nothing paints, and the dark
       basemap shows through it as a line down the map — visible at the
       prime meridian, because that is where these grids start. The
       Arctic band wraps too (720 x 0.5°). */
    const wraps = Math.abs(h.nx * h.dx - 360) < h.dx;
    const cols = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      const lng = map.containerPointToLatLng([x + 0.5 - mx, 0]).lng;
      const u = ((((lng - h.lo1) % 360) + 360) % 360) / h.dx;
      if (wraps) cols[x] = u % h.nx;
      else cols[x] = u >= 0 && u <= h.nx - 1 ? u : -1;
    }

    /* Bilinear, in two steps, because the coast needs both things at
       once: land must not be painted, and the water beside it must not
       go blocky.

       First the nearest cell decides whether this pixel is water at all,
       which keeps the shoreline exactly where the data puts it and stops
       a sea temperature bleeding inland. Then the value is averaged over
       whichever of the four neighbours are water, with their bilinear
       weights renormalised. Simply refusing to interpolate next to land
       was the first attempt and it showed: the open ocean came out
       smooth while the entire continental shelf — where a storm is
       actually read — stayed a grid of squares. */
    const sample = (u: number, v: number) => {
      const i0 = Math.floor(u) % h.nx;
      const j0 = Math.floor(v);
      const fi = u - Math.floor(u);
      const fj = v - j0;
      // Round the world rather than stopping at the last column.
      const i1 = wraps ? (i0 + 1) % h.nx : Math.min(i0 + 1, h.nx - 1);
      const j1 = Math.min(j0 + 1, h.ny - 1);

      const near = (fj < 0.5 ? j0 : j1) * h.nx + (fi < 0.5 ? i0 : i1);
      if (typeof grid.data[near] !== 'number') return null;

      let sum = 0;
      let weight = 0;
      const corners: [number, number, number][] = [
        [i0, j0, (1 - fi) * (1 - fj)],
        [i1, j0, fi * (1 - fj)],
        [i0, j1, (1 - fi) * fj],
        [i1, j1, fi * fj],
      ];
      for (const [i, j, wgt] of corners) {
        const value = grid.data[j * h.nx + i];
        if (typeof value === 'number') {
          sum += value * wgt;
          weight += wgt;
        }
      }
      return weight > 0 ? sum / weight : null;
    };

    /* Latitudes are wanted twice — once to find the range, once to
       paint — so invert the projection for them once and keep them. */
    const rowV = new Float64Array(ht);
    for (let y = 0; y < ht; y++) {
      rowV[y] = (h.la1 - map.containerPointToLatLng([0, y + 0.5 - my]).lat) / h.dy;
    }

    /* First pass, on a coarse stride: the range only needs the extremes,
       and sampling every sixteenth pixel finds them just as well as
       sampling all 650,000 while costing a fraction of the work.

       **Bounded to the viewport, not the canvas**, and that is not tidiness.
       The canvas runs 30% past every edge so a pan has field to reveal, but
       the automatic range is defined as the bounds of the water *in view* —
       and the margin is 2.56x the area, so letting it in would let water the
       reader cannot see stretch the ramp and flatten what they can. A margin
       reaching into much colder water would do it silently, with the legend
       printing a range that does not describe the picture. */
    const seen: number[] = [];
    for (let y = my; y < ht - my; y += 4) {
      if (rowV[y]! < 0 || rowV[y]! > h.ny - 1) continue;
      for (let x = mx; x < w - mx; x += 4) {
        const u = cols[x]!;
        if (u < 0) continue;
        const v = sample(u, rowV[y]!);
        if (v !== null && !below(this.options.field, v)) seen.push(v);
      }
    }
    // A range the reader has pinned wins over the view.
    const range = this.options.choice().range ?? this._rangeFor(seen);
    this._range = range;
    this.fire('rangechange');
    if (!range) return;
    const [lo, hi] = range;

    const img = ctx.createImageData(w, ht);
    const out = img.data;
    for (let y = 0; y < ht; y++) {
      const vRow = rowV[y]!;
      if (vRow < 0 || vRow > h.ny - 1) continue;
      for (let x = 0; x < w; x++) {
        const u = cols[x]!;
        if (u < 0) continue;
        const v = sample(u, vRow);
        if (v === null) continue;              // land, ice, or no data
        // Below a field's floor there is nothing to draw — see `drawAbove`.
        if (below(this.options.field, v)) continue;
        const rgb = rampColour(this.options.choice().stops, v, lo, hi);
        const k = (y * w + x) * 4;
        out[k] = rgb[0]!;
        out[k + 1] = rgb[1]!;
        out[k + 2] = rgb[2]!;
        /* Fully opaque, and that is load-bearing: the contrast gate
           checks the markers against these exact ramp colours. Blending
           the ramp with the bathymetry underneath would put a different
           colour on screen than the one that was gated. */
        out[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  },
});

/* Interpolated between stops rather than stepped: a field of flat bands
   reads as contours the data does not have. */
export function createScalarLayer(options: ScalarLayerOptions): ScalarLayer {
  return new (SstLayer as unknown as new (o: ScalarLayerOptions) => ScalarLayer)(options);
}
