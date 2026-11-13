/**
 * Parametric WW2-inspired warship generator (capital-ship R&D, plan
 * eager-sauteeing-curry). One function turns a class's grounded targets
 * (`capitalReference.ts`) and a design style into a catalogue record: a
 * composite deck-plan hull, naval turret mounts at their real stations, and
 * the solved physics.
 *
 * Round 2 (2026-11-05, after the user's top-down reference of Iowa / North
 * Carolina / Alabama): the hull outline is a MEASURED half-breadth table
 * (widths read row by row off that plan view; Iowa L/B measured 8.12 against
 * the real 8.2), not a wedge on a box. Turrets are gunhouses with real barrel
 * counts on barbettes sized from `CAPITAL_TURRETS`; B turrets superfire over
 * A; twin 5" secondaries line the beams; quad-40 mm AA tubs cluster round the
 * superstructure.
 *
 * Coordinates: hull and part points are Pixi-up (nose at −y). Mount `localY`
 * is positive FORWARD (the catalogue's mount convention).
 * Pure: imports only shared data.
 */
import {
  capitalTargets, solveCapitalPhysics, CAPITAL_MAPPINGS,
  type CapitalClassId, type CapitalMountSize,
} from '../../shipScale/capitalReference.js';
import { CAPITAL_TURRETS, DESTROYER_S_SCALE } from '../../shipScale/capitalTurrets.js';
import type { CapitalMap, CapitalStyle } from './capitalConfig.js';

type Pt = [number, number];

/** Half-breadth (× max beam) at t = 0, 0.05 … 1 (bow → stern), measured off
 *  the user's reference plan view (diag/_measure-hull.mjs). */
export const PLAN_IOWA = [0.1, 0.23, 0.3, 0.38, 0.47, 0.61, 0.71, 0.81, 0.88, 0.93, 0.94, 0.99, 0.97, 0.96, 0.99, 0.94, 0.91, 0.86, 0.76, 0.56, 0.13];
export const PLAN_ALABAMA = [0.08, 0.32, 0.41, 0.47, 0.55, 0.63, 0.74, 0.85, 0.93, 0.97, 0.97, 0.97, 0.97, 0.97, 0.96, 0.93, 0.9, 0.82, 0.72, 0.55, 0.35];

interface StyleParams {
  label: string;
  plan: readonly number[];
  /** Outline samples per side: many = smooth curve, few = straight facets. */
  samples: number;
  beamMul: number;
  /** Superstructure tiers [tStart, tEnd, width × beam], bottom to top. */
  superstructure: Array<[number, number, number]>;
  /** Heat-sink stacks: [t, length × L, width × beam]. */
  stacks: Array<[number, number, number]>;
  colors: { hull: number; deck: number; upper: number; stack: number; engine: number; barbette: number; aa: number };
}

export const CAPITAL_STYLES: Readonly<Record<CapitalStyle, StyleParams>> = {
  // A — the Iowa line: long fine bow, widest aft of midships, rounded stern.
  A: {
    label: 'Iowa line', plan: PLAN_IOWA, samples: 40, beamMul: 1,
    superstructure: [[0.38, 0.62, 0.5], [0.4, 0.5, 0.34], [0.42, 0.47, 0.2]],
    stacks: [[0.49, 0.045, 0.2], [0.56, 0.045, 0.2]],
    colors: { hull: 0x56677a, deck: 0x6b7887, upper: 0x8794a0, stack: 0x3b4148, engine: 0x2c3138, barbette: 0x5f6c79, aa: 0x48525c },
  },
  // B — the same line in straight facets: an angular, hard-chined look.
  B: {
    label: 'Faceted', plan: PLAN_IOWA, samples: 9, beamMul: 0.96,
    superstructure: [[0.39, 0.6, 0.44], [0.41, 0.5, 0.3]],
    stacks: [[0.52, 0.075, 0.24]],
    colors: { hull: 0x7f878d, deck: 0x8e969b, upper: 0xa3aaaf, stack: 0x454b50, engine: 0x30353a, barbette: 0x89919a, aa: 0x5d646a },
  },
  // C — the fuller Alabama line with a tall stepped tower.
  C: {
    label: 'Full, towering', plan: PLAN_ALABAMA, samples: 40, beamMul: 1.05,
    superstructure: [[0.37, 0.63, 0.62], [0.39, 0.56, 0.46], [0.41, 0.5, 0.3], [0.43, 0.47, 0.18]],
    stacks: [[0.55, 0.06, 0.26]],
    colors: { hull: 0x66705f, deck: 0x7a8472, upper: 0x8e9589, stack: 0x3a3e38, engine: 0x2d302b, barbette: 0x717a6a, aa: 0x4c5248 },
  },
};

/** Main turret stations (t) and barrels per class, from the real layouts:
 *  Fletcher 2 fore + 3 aft singles; Cleveland 2+2 triples; Baltimore, Alaska
 *  and Iowa 2 superfiring fore + 1 aft triples. */
const MAIN: Readonly<Record<CapitalClassId, { stations: number[]; barrels: number }>> = {
  destroyer: { stations: [0.13, 0.2, 0.7, 0.77, 0.85], barrels: 1 },
  'light-cruiser': { stations: [0.19, 0.25, 0.71, 0.77], barrels: 3 },
  'heavy-cruiser': { stations: [0.22, 0.29, 0.79], barrels: 3 },
  battlecruiser: { stations: [0.22, 0.29, 0.79], barrels: 3 },
  battleship: { stations: [0.24, 0.3, 0.82], barrels: 3 },
};
/** Twin 5" secondary stations per side (t). */
const SECONDARY: Readonly<Record<CapitalClassId, number[]>> = {
  destroyer: [],
  'light-cruiser': [0.4, 0.5, 0.6],
  'heavy-cruiser': [0.4, 0.5, 0.6],
  battlecruiser: [0.39, 0.48, 0.57, 0.65],
  battleship: [0.38, 0.44, 0.5, 0.56, 0.62],
};
/** Quad-40 mm AA tubs per side (t, x × beam). */
const AA: Readonly<Record<CapitalClassId, Array<[number, number]>>> = {
  destroyer: [[0.45, 0.25], [0.6, 0.28]],
  'light-cruiser': [[0.33, 0.28], [0.65, 0.3], [0.86, 0.22]],
  'heavy-cruiser': [[0.34, 0.28], [0.66, 0.3], [0.88, 0.2]],
  battlecruiser: [[0.34, 0.26], [0.69, 0.3], [0.88, 0.22]],
  battleship: [[0.34, 0.24], [0.68, 0.3], [0.74, 0.22], [0.9, 0.2], [0.14, 0.14]],
};
/** Turret traverse (rad/s), near the real rates (review round, 2026-11-06):
 *  16" ~4°/s, 12" ~5°/s, 8" ~8°/s, 5"/38 ~15°/s. */
const TRAVERSE: Readonly<Record<CapitalMountSize, number>> = { S: 0.26, M: 0.14, L: 0.087, XL: 0.07 };
/** Main-battery training limit either side of the rest bearing (±135°, about
 *  the Iowa limits: never back across its own superstructure). */
const MAIN_ARC = (3 * Math.PI) / 4;
/** Quad 40 mm AA traverse (rad/s): ~26°/s, quick but not quick enough for a
 *  fighter crossing close by. */
const AA_TRAVERSE = 0.45;
/** Each mount size fires its calibre's naval gun (core/combat/WeaponCatalogue). */
const NAVAL_GUN = { S: 'naval_s', M: 'naval_m', L: 'naval_l', XL: 'naval_xl' } as const satisfies Record<CapitalMountSize, string>;

const CLASS_NAMES: Readonly<Record<CapitalClassId, string>> = {
  destroyer: 'Destroyer',
  'light-cruiser': 'Light Cruiser',
  'heavy-cruiser': 'Heavy Cruiser',
  battlecruiser: 'Battlecruiser',
  battleship: 'Battleship',
};

/** Hull half-width at t (0 bow … 1 stern) for a style, in beam units (0..0.5). */
export function hullHalfWidth(s: StyleParams, t: number): number {
  const p = s.plan, n = p.length - 1;
  const x = Math.max(0, Math.min(1, t)) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
  return 0.5 * (p[i]! * (1 - f) + p[i + 1]! * f);
}

/** Transom half-width × beam: the engine block (0.34 B) plus a margin. */
export const TRANSOM_HALF = 0.21;

function hullOutline(s: StyleParams, L: number, B: number): Pt[] {
  const N = s.samples;
  const right: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // A flat transom at the stern, wide enough for the engine bank: the
    // reference plans taper to a point, which left no room for four nozzles
    // (capitals review round, 2026-11-06).
    const transom = t >= 0.9 ? TRANSOM_HALF * B : 0;
    right.push([Math.max(0.4, transom, hullHalfWidth(s, t) * B), -L / 2 + t * L]);
  }
  const left: Pt[] = right.slice(1, -1).reverse().map(([x, y]): Pt => [-x, y]);
  const sternR = right[right.length - 1]!, bowR = right[0]!;
  const out: Pt[] = [[0, bowR[1] - L * 0.004], ...right, [-sternR[0], sternR[1]], ...left, [-bowR[0], bowR[1]]];
  return out;
}

/**
 * Main turret stations (t, bow 0 → stern 1) pushed apart so neighbouring
 * gunhouses never touch at any training angle: `gap` is the minimum spacing
 * in t (two gunhouse half-diagonals). The fore group spreads aft from the bow
 * turret, the aft group forward from the stern turret. The MAIN tables list
 * each group in order (fore ascending, aft ascending), so ids stay stable.
 */
export function spaceStations(raw: readonly number[], gap: number): number[] {
  const out = raw.slice();
  const fore: number[] = [], aft: number[] = [];
  out.forEach((x, i) => (x < 0.5 ? fore : aft).push(i));
  for (let k = 1; k < fore.length; k++) out[fore[k]!] = Math.max(out[fore[k]!]!, out[fore[k - 1]!]! + gap);
  for (let k = aft.length - 2; k >= 0; k--) out[aft[k]!] = Math.min(out[aft[k]!]!, out[aft[k + 1]!]! - gap);
  return out;
}
function rect(cx: number, cy: number, w: number, h: number, chamfer = 0.18): Pt[] {
  const c = Math.min(w, h) * chamfer;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}

function circle(cx: number, cy: number, r: number, n = 14): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Convex hull (monotone chain) — the single collider over all parts. */
function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export interface WarshipDesign {
  /** The raw catalogue record (validated by `defineCapitalShipKind`). */
  record: Record<string, unknown>;
  length: number;
  beam: number;
  mainMountSize: CapitalMountSize;
  mountCount: number;
}

export function warshipDesign(id: CapitalClassId, style: CapitalStyle, map: CapitalMap): WarshipDesign {
  const s = CAPITAL_STYLES[style];
  const t = capitalTargets(id, CAPITAL_MAPPINGS[map]);
  const p = solveCapitalPhysics(t);
  const L = t.length, B = t.beam * s.beamMul;
  const yAt = (tt: number): number => -L / 2 + tt * L;

  const parts: Array<Record<string, unknown>> = [];
  const part = (points: Pt[], color: number, role: string): void => {
    parts.push({ points, color, offsetX: 0, offsetY: 0, role });
  };
  part(hullOutline(s, L, B), s.colors.hull, 'hull');
  // Deck: an inset of the hull line, a shade lighter (the planked weather deck).
  {
    const inset: Pt[] = [];
    const N = s.samples;
    for (let i = 1; i < N; i++) inset.push([hullHalfWidth(s, i / N) * B * 0.86, yAt(i / N)]);
    part([...inset, ...inset.slice().reverse().map(([x, y]): Pt => [-x, y])], s.colors.deck, 'deck');
  }
  // The engine block runs to the transom so the nozzles sit at the very stern.
  part(rect(0, yAt(0.9775), B * 0.34, L * 0.045, 0.12), s.colors.engine, 'engine');

  const mounts: Array<Record<string, unknown>> = [];
  const mainSize = t.mainMountSize;
  const main = MAIN[id];
  const scale = id === 'destroyer' ? DESTROYER_S_SCALE : 1;
  const geo = CAPITAL_TURRETS[mainSize];
  const stations = spaceStations(main.stations, (2 * Math.hypot(geo.houseW / 2, geo.houseL / 2) * B * scale * 1.05) / L);
  stations.forEach((tt, i) => {
    const fwd = tt < 0.5;
    // Superfiring: the inner turret of a fore/aft pair sits on a raised,
    // wider barbette (drawn later, so on top).
    const inner = fwd ? stations.filter((x) => x < 0.5).length > 1 && tt === Math.max(...stations.filter((x) => x < 0.5))
      : stations.filter((x) => x >= 0.5).length > 1 && tt === Math.min(...stations.filter((x) => x >= 0.5));
    part(circle(0, yAt(tt), B * geo.barbette * scale * (inner ? 1.12 : 1)), s.colors.barbette, inner ? 'barbette-raised' : 'barbette');
    mounts.push({
      id: `main-${i + 1}`, localX: 0, localY: L / 2 - tt * L,
      baseAngle: fwd ? 0 : Math.PI, arcMin: -MAIN_ARC, arcMax: MAIN_ARC,
      rotationSpeed: TRAVERSE[mainSize], weaponId: NAVAL_GUN[mainSize], size: mainSize,
      barrels: main.barrels, ...(scale !== 1 ? { turretScale: scale } : {}),
    });
  });
  SECONDARY[id].forEach((tt, i) => {
    for (const side of [1, -1] as const) {
      const x = side * B * 0.34;
      part(circle(x, yAt(tt), B * CAPITAL_TURRETS.S.barbette), s.colors.barbette, 'barbette');
      mounts.push({
        id: `sec-${side > 0 ? 's' : 'p'}${i + 1}`, localX: x, localY: L / 2 - tt * L,
        // Starboard (+x) faces −π/2 in the mount frame (0 = forward), port +π/2.
        baseAngle: side > 0 ? -Math.PI / 2 : Math.PI / 2, arcMin: -1.4, arcMax: 1.4,
        rotationSpeed: TRAVERSE.S, weaponId: NAVAL_GUN.S, size: 'S', barrels: 2,
      });
    }
  });
  // Superstructure tiers and heat-sink stacks on top of the deck.
  for (const [t0, t1, w] of s.superstructure) part(rect(0, yAt((t0 + t1) / 2), B * w, L * (t1 - t0)), s.colors.upper, 'superstructure');
  for (const [tt, len, w] of s.stacks) part(rect(0, yAt(tt), B * w, L * len, 0.45), s.colors.stack, 'stack');
  // Quad-40 mm AA: working mounts in their tubs (review round 2026-11-07).
  // Four barrels firing in turn (laser bolts), facing outboard; they engage
  // only small craft and, traverse-limited, struggle against close, crossing
  // targets (core/combat/mountTargeting.ts).
  AA[id].forEach(([tt, xb], i) => {
    for (const side of [1, -1] as const) {
      const cx = side * B * xb, cy = yAt(tt);
      part(circle(cx, cy, B * CAPITAL_TURRETS.AA.barbette, 10), s.colors.aa, 'barbette');
      mounts.push({
        id: `aa-${side > 0 ? 's' : 'p'}${i + 1}`, localX: cx, localY: L / 2 - tt * L,
        baseAngle: side > 0 ? -Math.PI / 2 : Math.PI / 2, arcMin: -1.6, arcMax: 1.6,
        rotationSpeed: AA_TRAVERSE, weaponId: 'laser', size: 'AA', barrels: 4,
      });
    }
  });

  const hull = convexHull(parts.flatMap((q) => q['points'] as Pt[]));
  const massRatio = t.mass / CAPITAL_MAPPINGS[map].destroyerMass;
  const health = Math.round(900 * Math.pow(massRatio, 0.85));
  const engines = id === 'destroyer' ? 2 : 4;

  const record = {
    id,
    displayName: CLASS_NAMES[id],
    description: `WW2-inspired ${CLASS_NAMES[id].toLowerCase()} (capital class, style ${style}: ${s.label}).`,
    npcOnly: true,
    sizeClass: 'capital',
    thrustImpulse: p.thrustImpulse,
    reverseFactor: 0.3,
    boostMultiplier: 1,
    maxAngvel: p.maxAngvel,
    turnTorque: p.turnTorque,
    maxSpeed: p.maxSpeed,
    linearDamping: p.linearDamping,
    angularDamping: p.angularDamping,
    lateralGrip: 0.05,
    radius: p.radius,
    mass: p.mass,
    thrusters: { count: engines, size: B * 0.07 },
    maxHealth: health,
    shieldMax: Math.round(health * 0.5),
    shieldRegenDelayTicks: 600,
    shieldRegenRate: (health * 0.5) / 600,
    energyMax: 600,
    energyRegenRate: 2,
    ai: { thrust: p.thrustImpulse },
    aiRole: 'capital',
    shape: { kind: 'composite', scale: 1, hull, parts },
    mounts,
    // exp/fire-control: three weapon groups (3 locks each, the capital default):
    // main battery, secondaries, quad AA. Each mount still picks among ITS
    // group's locks via the capital per-turret fire control.
    slots: capitalGroups(mounts.map((m) => m['id'] as string)),
  };
  return { record, length: L, beam: B, mainMountSize: mainSize, mountCount: mounts.length };
}

/** Split a capital's mounts into Main / Secondary / AA weapon groups by id
 *  prefix (main-, sec-, aa-). A group with no mounts (a destroyer has no
 *  secondaries) is left out. */
function capitalGroups(ids: string[]): Array<{ id: string; displayName: string; mountIds: string[]; colour: number }> {
  const groups = [
    { id: 'main', displayName: 'Main battery', mountIds: ids.filter((i) => i.startsWith('main-')), colour: 0 },
    { id: 'sec', displayName: 'Secondaries', mountIds: ids.filter((i) => i.startsWith('sec-')), colour: 1 },
    { id: 'aa', displayName: 'AA', mountIds: ids.filter((i) => i.startsWith('aa-')), colour: 2 },
  ];
  return groups.filter((g) => g.mountIds.length > 0);
}
