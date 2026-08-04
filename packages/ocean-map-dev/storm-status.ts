/* How an active storm is described in the status line above the map.
 *
 * Shared deliberately, and it lives with the map rather than with the site
 * because the map is the thing that cannot do without it: the component
 * renders this at build time so the line is right with JavaScript off, and
 * the map re-renders it in the browser from freshly fetched data so it stays
 * right between builds. Two copies of the formatting would drift, and the
 * drift would show as the line disagreeing with itself after a refresh.
 */

export interface Storm {
  id?: string;
  name?: string;
  classification?: string;
  intensityKt?: string | number;
  movementDir?: number | null;
  movementSpeedKt?: number | null;
  advisoryUrl?: string;
}

export interface StormLine {
  id?: string;
  name: string;
  url?: string;
  facts: string[];
}

const POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];
const compass = (deg: number) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

// NHC status codes.
const KIND: Record<string, string> = {
  TD: 'Tropical depression',
  TS: 'Tropical storm',
  HU: 'Hurricane',
  MH: 'Major hurricane',
  STD: 'Subtropical depression',
  STS: 'Subtropical storm',
  PTC: 'Post-tropical cyclone',
  PC: 'Potential tropical cyclone',
  DB: 'Disturbance',
  LO: 'Low',
};

// Saffir-Simpson thresholds in knots, so "Hurricane" reads "Category 3 hurricane".
const CATEGORY: [number, number][] = [[137, 5], [113, 4], [96, 3], [83, 2], [64, 1]];

/* Null and '' both coerce to 0, which would report a missing intensity as
   "0 kt" — so screen them out before converting. */
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const describe = (s: Storm) => {
  const kt = num(s.intensityKt);
  const kind = KIND[s.classification ?? ''] ?? s.classification ?? 'Tropical cyclone';
  if (/hurricane/i.test(kind) && kt !== null) {
    const cat = CATEGORY.find(([floor]) => kt >= floor);
    if (cat) return `Category ${cat[1]} hurricane`;
  }
  return kind;
};

/* NHC storm ids carry the basin as a two-letter prefix — al052026 is the
   fifth Atlantic storm of 2026, ep072026 the seventh in the eastern
   Pacific. Nothing else in the feed names the basin. */
const BASIN: Record<string, string> = {
  al: 'Atlantic',
  ep: 'Eastern Pacific',
  cp: 'Central Pacific',
};
const basin = (id?: string) => BASIN[(id ?? '').slice(0, 2).toLowerCase()] ?? null;

export function stormLines(storms: Storm[]): StormLine[] {
  return storms.map((s) => {
    const kt = num(s.intensityKt);
    const dir = num(s.movementDir);
    const speed = num(s.movementSpeedKt);
    return {
      id: s.id,
      name: s.name ?? 'Unnamed',
      url: s.advisoryUrl,
      facts: [
        basin(s.id),
        describe(s),
        kt === null ? null : `${kt} kt`,
        dir === null || speed === null ? null : `${compass(dir)} ${speed} kt`,
      ].filter(Boolean) as string[],
    };
  });
}

export const stormLabel = (count: number) => (count === 1 ? 'Active storm' : 'Active storms');
export const NO_STORMS = 'None — no tropical cyclones are being tracked right now.';
