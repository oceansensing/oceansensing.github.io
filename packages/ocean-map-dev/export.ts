/* Flattening the live map into a single PNG.
 *
 * The map is nine stacked panes holding four different kinds of thing —
 * raster tiles, our own canvases, CSS-styled SVG, and HTML — and a canvas can
 * be handed only two of them. So this is an ordered composite rather than a
 * screen grab, and each kind needs its own treatment:
 *
 * - **`<img>`** (basemap tiles, the EMODnet shoreline, the EEZ lines) draws
 *   directly. That works only because every raster layer is requested with
 *   `crossOrigin` — see `CORS_TILES` in `index.ts`. Without it the first tile
 *   taints the canvas and the whole figure is refused, with a SecurityError
 *   rather than a missing layer to show for it. Measured: with the attribute
 *   set, the live elements composite with no refetch at all.
 * - **`<canvas>`** (the scalar raster, the particle fields, the Argo dots)
 *   draws directly. These are ours already.
 * - **`<svg>`** (isobaths, graticule lines, tracks, markers) has to be
 *   serialised, and its styling does not come with it: every vector on this
 *   map carries a `className` and lets CSS own the stroke, which is the rule
 *   that makes a theme switch restyle the whole map with no redraw. The cost
 *   is paid exactly here — the computed style of every path is read off the
 *   live element and written onto the clone.
 * - **HTML** (the graticule labels, the scale bar, the brand mark) cannot be
 *   drawn at all, so it is redrawn with `fillText` — reading the live
 *   element's own text and position, never recomputing it. Recomputing would
 *   be a second source of truth for the wording, and the wording is the thing
 *   most likely to drift.
 *
 * **Pane order is the correctness condition**, and it is read off the live
 * DOM rather than restated here. A hardcoded table would be a second copy of
 * something the module already decides, and the first version of this got it
 * wrong by iterating in DOM order — which happens to be nearly right and is
 * not right.
 *
 * The layout of the figure — how tall the band is, where each key and credit
 * line sits — is in `figure.ts`, which imports neither Leaflet nor the DOM.
 */
import L from 'leaflet';
import { planFigure, type FigurePlan } from './figure';

export interface ExportRequest {
  /** 1 for the screen, 2 for print. */
  scale?: number;
  /** Colour bars and particle keys, in the order they should read. */
  keys?: Array<{ label: string; ramp: string[] }>;
  /** The credit, exactly as the map shows it: sources joined by "; ". */
  credit?: string;
  /** Painted behind the band. Comes from the stylesheet, never a literal. */
  bandFill: string;
  bandInk: string;
  /* The figure's scale bar. Here rather than in this module because a colour
     written into code is invisible to the contrast gate — BOUNDARIES S5 —
     and this one is judged against the water it sits on. */
  ruleInk: string;
  ruleHalo: string;
}

/* Panes holding chrome rather than map. `mapPane` is the transform wrapper
   Leaflet puts every other pane inside — compositing it would draw
   everything a second time — and `markerPane` holds the graticule's HTML
   labels, which are redrawn below. Popups and tooltips are transient UI that
   has no business in a figure. */
const SKIP_PANES = new Set(['map', 'marker', 'popup', 'tooltip', 'shadow']);

/** Every `<path>`'s computed stroke and fill, written onto a detached clone.
 *
 * `getComputedStyle` is read from the *live* element, so what lands in the
 * PNG is what the cascade actually resolved — the theme, the basemap tone,
 * and the reader's own isobath opacity all included — rather than anything
 * this module believes about colours. That matters beyond tidiness: the
 * palette is gated by `test:contrast`, and a second opinion about a stroke
 * here would be a colour no gate had ever seen. */
function inlineStyles(svg: SVGElement): SVGElement {
  const clone = svg.cloneNode(true) as SVGElement;
  const live = svg.querySelectorAll('path, circle, line, polyline, polygon');
  const copy = clone.querySelectorAll('path, circle, line, polyline, polygon');
  const PROPS = [
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-linecap',
    'stroke-linejoin',
    'fill',
    'fill-opacity',
    'opacity',
  ];
  live.forEach((el, i) => {
    const target = copy[i];
    if (!target) return;
    const style = window.getComputedStyle(el);
    for (const prop of PROPS) {
      const value = style.getPropertyValue(prop);
      if (value) target.setAttribute(prop, value);
    }
  });
  return clone;
}

/** An SVG pane as an image.
 *
 * Rasterised at the **figure's** size rather than the screen's, which is the
 * whole of what makes a 2x export worth asking for. An SVG is resolution
 * independent right up to the moment it becomes pixels, so rasterising at
 * CSS size and then letting `drawImage` stretch it would throw that away and
 * produce linework exactly as soft as an upscaled tile. Every contour,
 * coastline, border and track goes through here. */
function rasterise(
  svg: SVGElement,
  w: number,
  h: number,
  scale = 1
): Promise<HTMLImageElement> {
  const clone = inlineStyles(svg);
  clone.setAttribute('width', String(Math.round(w * scale)));
  clone.setAttribute('height', String(Math.round(h * scale)));
  const markup = new XMLSerializer().serializeToString(clone);
  return new Promise((resolve, reject) => {
    const img = new Image();
    /* A browser that refuses the data URL without firing either handler
       would otherwise leave this pending forever, and the export awaits it —
       so the button would sit on "Saving…" and never come back. A layer
       missing from the figure is a far better failure than a figure that
       never arrives, and the caller already treats a rejection that way. */
    const bail = window.setTimeout(() => reject(new Error('svg timed out')), 5000);
    const done = (settle: () => void) => {
      window.clearTimeout(bail);
      settle();
    };
    img.onload = () => done(() => resolve(img));
    img.onerror = () => done(() => reject(new Error('svg')));
    // A data URL, not a blob: no object URL to leak if this rejects.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

/** Paint a ramp across a rect, or a flat swatch when there is one colour. */
function paintRamp(
  ctx: CanvasRenderingContext2D,
  ramp: string[],
  at: { x: number; y: number; w: number; h: number }
): void {
  if (!ramp.length) return;
  if (ramp.length === 1) {
    ctx.fillStyle = ramp[0] as string;
  } else {
    const gradient = ctx.createLinearGradient(at.x, 0, at.x + at.w, 0);
    ramp.forEach((colour, i) => gradient.addColorStop(i / (ramp.length - 1), colour));
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(at.x, at.y, at.w, at.h);
}

/**
 * Composite the map into a canvas.
 *
 * Returns the canvas rather than a Blob so the caller decides how to encode
 * it, and so a test can look at what was drawn.
 */
export async function drawFigure(
  host: HTMLElement,
  request: ExportRequest
): Promise<{ canvas: HTMLCanvasElement; plan: FigurePlan }> {
  const scale = request.scale ?? 1;
  const mapW = host.clientWidth;
  const mapH = host.clientHeight;

  const canvas = document.createElement('canvas');
  const measuring = canvas.getContext('2d');
  if (!measuring) throw new Error('no 2d context');

  /* Measured with the same context that will draw, at the unscaled size —
     `planFigure` multiplies by `scale` itself, so measuring at the scaled
     size would apply it twice. */
  const plan = planFigure({
    mapW,
    mapH,
    scale,
    keys: request.keys,
    credit: request.credit,
    measure: (text, size) => {
      measuring.font = `${size}px system-ui, sans-serif`;
      return measuring.measureText(text).width;
    },
  });

  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /* One transform, set once: everything below is in CSS pixels and lands in
     figure pixels. The alternative is multiplying at every call site, which
     is the kind of thing that is right in eleven places and wrong in one. */
  ctx.save();
  ctx.scale(scale, scale);

  const origin = host.getBoundingClientRect();
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  };

  /* The map is clipped to its own rect. Leaflet keeps tiles and canvases
     beyond the visible edge — the particle field is deliberately 1.6x the
     viewport — and without this they would paint over the band. */
  ctx.beginPath();
  ctx.rect(0, 0, mapW, mapH);
  ctx.clip();

  const panes = [...host.querySelectorAll<HTMLElement>('.leaflet-pane')]
    .map((el) => ({
      el,
      name: /leaflet-([a-z0-9-]+)-pane/.exec(el.className)?.[1] ?? '',
      z: Number(window.getComputedStyle(el).zIndex) || 0,
    }))
    .filter((p) => p.name && !SKIP_PANES.has(p.name))
    .sort((a, b) => a.z - b.z);

  for (const pane of panes) {
    const items = [...pane.el.querySelectorAll<Element>('img, canvas, svg')];
    if (!items.length) continue;
    const style = window.getComputedStyle(pane.el);
    ctx.save();
    ctx.globalAlpha = Number(style.opacity) || 1;
    if (style.mixBlendMode && style.mixBlendMode !== 'normal') {
      ctx.globalCompositeOperation = style.mixBlendMode as GlobalCompositeOperation;
    }
    /* The isobath and shoreline halos are pane-level drop-shadows. `ctx.filter`
       takes the same syntax, but it is not everywhere — assigning an
       unsupported value silently leaves it 'none', which is the right
       degradation: a contour without its halo beats no figure at all. */
    if (style.filter && style.filter !== 'none') ctx.filter = style.filter;

    for (const item of items) {
      const box = boxOf(item);
      if (box.w <= 0 || box.h <= 0) continue;
      try {
        /* By tag rather than `instanceof SVGElement`: the harness runs this
           in jsdom, where the constructor a bundle closes over is not always
           the one the document built the node with, and the mismatch would
           silently send every SVG down the raster path. */
        const drawable =
          item.tagName.toLowerCase() === 'svg'
            ? await rasterise(item as unknown as SVGElement, box.w, box.h, scale)
            : (item as unknown as CanvasImageSource);
        ctx.drawImage(drawable, box.x, box.y, box.w, box.h);
      } catch {
        /* One unreachable item costs its layer, not the figure. A tile that
           404'd or an SVG the browser refused should not turn an export into
           an error message. */
      }
    }
    ctx.restore();
  }

  /* The HTML that has to be redrawn. Text and position both come off the
     live element, so nothing here decides what a label says. The brand mark
     is included deliberately — it sits over the map precisely so a picture
     of it "arrives somewhere still saying what it is" — while the zoom,
     layer, measure and place controls are not, being instruments rather than
     part of the picture. */
  ctx.save();
  ctx.textBaseline = 'middle';
  /* `.map-grid-label > span`, not the label itself: a graticule label is a
     `divIcon` of size 0x0 anchored on the line, with the text in an
     absolutely-positioned span that a transform lifts clear of it. Measuring
     the outer div gives the anchor rather than where the words actually
     are, which puts every label a line-height out — right enough in a
     screenshot to be missed, wrong everywhere it matters. */
  for (const el of host.querySelectorAll<HTMLElement>(
    '.map-grid-label > span, .leaflet-control-scale-line, .om-brand'
  )) {
    const raw = (el.textContent ?? '').trim();
    if (!raw) continue;
    const box = boxOf(el);
    const style = window.getComputedStyle(el);
    const pad = parseFloat(style.paddingLeft) || 0;
    const indent = parseFloat(style.textIndent) || 0;
    const isScale = el.classList.contains('leaflet-control-scale-line');

    ctx.save();
    /* **Three text properties that CSS applies and `fillText` does not**, and
       between them they are why the brand came out short of its own plate:
       the mark is uppercased, small-capped and letter-spaced by the
       stylesheet, and drawing `textContent` in the plain face rendered it
       ~20% narrower than the box drawn behind it. Dead space to the right of
       the words, reported as the mark being too large.

       Applied generally rather than as a brand special case: any redrawn
       chrome can carry them, and the failure is silent every time. */
    let text = raw;
    if (style.textTransform === 'uppercase') text = text.toUpperCase();
    else if (style.textTransform === 'lowercase') text = text.toLowerCase();
    else if (style.textTransform === 'capitalize') {
      text = text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    }
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const canSpace = 'letterSpacing' in ctx;
    if (canSpace) (ctx as { letterSpacing: string }).letterSpacing = style.letterSpacing;
    if ('fontVariantCaps' in ctx) {
      (ctx as { fontVariantCaps: string }).fontVariantCaps = style.fontVariantCaps;
    }

    if (isScale) {
      /* A cartographic scale bar rather than the interface's: a hairline
         with a tick at each end and the distance set above it. Leaflet
         draws a three-sided box with the number inside, which is a control
         — legible on a screen, and in a figure it reads as a stray
         rectangle with text trapped in it.

         Black, as asked, with a light halo. Every thin line on this map
         carries one for the same reason: the scale bar sits bottom-left
         over whatever water happens to be there, and over the dark Chukchi
         a bare black rule is invisible. The ink is still black; the casing
         is what makes it survive. */
      const y = box.y + box.h;
      const tick = 5;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      const rule = () => {
        ctx.beginPath();
        ctx.moveTo(box.x, y - tick);
        ctx.lineTo(box.x, y);
        ctx.lineTo(box.x + box.w, y);
        ctx.lineTo(box.x + box.w, y - tick);
        ctx.stroke();
      };
      ctx.strokeStyle = request.ruleHalo;
      ctx.lineWidth = 3;
      rule();
      ctx.strokeStyle = request.ruleInk;
      ctx.lineWidth = 1;
      rule();

      /* Lighter and a shade smaller than the interface's label, centred over
         the bar — it is a caption for the rule, not a button. */
      const size = Math.max(9, parseFloat(style.fontSize) * 0.92);
      ctx.font = `300 ${size}px ${style.fontFamily}`;
      if (canSpace) (ctx as { letterSpacing: string }).letterSpacing = '0px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const at = box.x + box.w / 2;
      ctx.strokeStyle = request.ruleHalo;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, at, y - tick - 3);
      ctx.fillStyle = request.ruleInk;
      ctx.fillText(text, at, y - tick - 3);
      ctx.restore();
      continue;
    }

    /* The plate behind the brand. It is as much a part of the mark as the
       words, and with the text now measuring what the DOM measures it fits
       rather than floating in it. */
    const plate = style.backgroundColor;
    if (plate && plate !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(plate)) {
      ctx.fillStyle = plate;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    const edge = parseFloat(style.borderTopWidth) || 0;
    if (edge > 0) {
      ctx.strokeStyle = style.borderTopColor;
      ctx.lineWidth = edge;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }

    /* A `text-shadow` halo is what makes a grid label legible over pale
       shelf water, and canvas has no such thing — so it is redrawn as a
       stroke behind the fill, in the halo's own colour. Without it the
       labels vanish over exactly the water this map is most used to look
       at, which is the same lesson the isobaths and the shoreline each had
       to learn separately. */
    const halo = /^none$/.test(style.textShadow)
      ? null
      : style.textShadow.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/)?.[0];

    /* **Kept inside the figure, measured on the glyphs.** A graticule label
       rides the edge of the *viewport*, and the longitude ones sit flush on
       it — measured, their boxes bottom out 0.6 px past the map — so the
       clip took their descenders and they read as cut off against the band.

       Clamped by the text's own ink rather than by its line box, because the
       two are not the same: a line box carries leading the glyphs do not
       fill, so clamping by half the box leaves a label technically inside
       and visibly touching. `AIR` is the margin that turns flush into
       legible; without it the fix is arithmetically right and looks
       unchanged. */
    const AIR = 3;
    const metrics = ctx.measureText(text);
    const up = metrics.actualBoundingBoxAscent || box.h / 2;
    const down = metrics.actualBoundingBoxDescent || box.h / 2;
    const baseline = Math.min(
      Math.max(box.y + box.h / 2, up + AIR),
      mapH - down - AIR
    );
    const width = metrics.width;
    const left = Math.min(
      Math.max(box.x + pad + indent, AIR),
      Math.max(AIR, mapW - width - AIR)
    );

    ctx.textAlign = 'left';
    if (halo) {
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, left, baseline);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(text, left, baseline);
    ctx.restore();
  }
  ctx.restore();
  ctx.restore(); // the clip and the scale

  if (plan.band) {
    /* Everything from here down is in figure pixels — `planFigure` has
       already applied `scale` — and the transform is back to identity, so
       none of it is multiplied again. */
    const band = plan.band;
    ctx.fillStyle = request.bandFill;
    ctx.fillRect(band.x, band.y, band.w, band.h);

    for (const key of plan.keys) {
      paintRamp(ctx, key.ramp, key.swatch);
      /* A hairline round every swatch, because a pale end of a ramp against
         a pale band is otherwise a swatch with no edge — which reads as the
         bar starting somewhere it does not. */
      ctx.strokeStyle = request.bandInk;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.strokeRect(key.swatch.x, key.swatch.y, key.swatch.w, key.swatch.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = request.bandInk;
      ctx.font = `${plan.fonts.key}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(key.label, key.text.x, key.text.y);
    }

    ctx.fillStyle = request.bandInk;
    ctx.font = `${plan.fonts.credit}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const line of plan.credits) ctx.fillText(line.text, line.x, line.y);
  }

  return { canvas, plan };
}

/** Hand the figure to the reader as a download. */
export function saveCanvas(canvas: HTMLCanvasElement, name: string): Promise<void> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      /* Appended because Firefox will not follow a click on a detached
         anchor, and removed immediately after — nothing here is left in the
         host's document, which is what S8 is about. The object URL is
         revoked on the next turn: revoking it synchronously races the
         download in Safari. */
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      resolve();
    }, 'image/png');
  });
}
