/**
 * Mining-barge hull LOOK OPTIONS (plan partitioned-chasing-lark, PR 14). The
 * owner's brief: a container ship. Maximise cargo volume, about 1.3× a
 * battleship's length, broad and boxy, a container-stack deck, no barbettes
 * for guns, lined both sides with mining lasers and tractors of varying sizes
 * (to strip-mine a field), and gigantic engines on the stern.
 *
 * Three variants for the owner to pick from, built with the warship
 * generator's helpers (`warshipDesign.ts`: rect, circle, convexHull,
 * `solveCapitalPhysics`) into an ordinary capital catalogue record:
 *  - A  classic container ship: blunt bow, bridge aft, one long container deck;
 *  - B  twin-hull barge: two pontoons round a central open hold of containers,
 *       laser rows on both outer edges, hold-rim tractors;
 *  - C  blocky ore carrier: a forward mining "jaw" of big lasers, hatch covers.
 *
 * Every variant's stern is an oversized engine bank: `thrusters` (nozzle count
 * and size, read by the forge's nozzle pass and the existing engine FX path)
 * plus composite `engine` housings lined up exactly where the forge puts the
 * nozzles (`fields.ts`: span = (count − 1) × r × 2.4).
 *
 * Tractor beams do not exist yet: tractor mounts carry ids `tractor-*` and the
 * `mining_laser` weapon as a placeholder; PR 15 swaps their `weaponId`.
 * Ships are never faction-bound: no allegiance here, ever.
 *
 * Not a catalogue kind: `bargeLookConfig.ts` appends the chosen variant behind
 * the dev flag `?bargeLook=` / `EQX_BARGE_LOOK` only. Coordinates as in
 * `warshipDesign.ts` (Pixi-up points, mount `localY` positive forward).
 * Pure: imports only shared data.
 */
import { capitalTargets, solveCapitalPhysics, CAPITAL_MAPPINGS, type CapitalMountSize } from '../../shipScale/capitalReference.js';
import { CAPITAL_TURRETS } from '../../shipScale/capitalTurrets.js';
import type { CapitalMap } from './capitalConfig.js';
import { circle, convexHull, hullHalfWidth, rect, type Pt } from './warshipDesign.js';

export type BargeLook = 'A' | 'B' | 'C';
export const BARGE_LOOKS: readonly BargeLook[] = ['A', 'B', 'C'];
/** The look kind's id (R&D only; PR 15 appends the picked hull as its own kind). */
export const BARGE_LOOK_KIND_ID = 'barge-look';

/** Mount gunhouse width in world units per size: the barge's mining turrets,
 *  from a light S cutter to an XL bow laser (a battleship's 16" house is ~320). */
const HOUSE: Readonly<Record<CapitalMountSize, number>> = { S: 60, M: 100, L: 145, XL: 210 };
/** Traverse (rad/s): mining turrets slew faster than naval guns. */
const SLEW: Readonly<Record<CapitalMountSize, number>> = { S: 0.5, M: 0.35, L: 0.25, XL: 0.18 };
/** Placeholder until the tractor beam exists (PR 15 swaps it). */
export const TRACTOR_PLACEHOLDER_WEAPON = 'mining_laser';

const COLORS = {
  hull: 0x5f5b53, deck: 0x6f6b61, hold: 0x2f2d2a, upper: 0xb9b3a4, upper2: 0xcfc9ba,
  engine: 0x2c2e32, housing: 0x3a3d42, barbette: 0x7b756a, hatch: 0x6d5b3c, coaming: 0x4a463f,
};
/** Container paints (weathered): rust, blue, teal, ochre, grey, maroon, green. */
const CONTAINERS = [0x93452f, 0x2f5a82, 0x3c7566, 0xa9843a, 0x7a7f86, 0x683d56, 0x55703a];

interface VariantSpec {
  label: string;
  length: number;
  beam: number;
  thrusters: { count: number; size: number };
}
export const BARGE_VARIANTS: Readonly<Record<BargeLook, VariantSpec>> = {
  A: { label: 'container ship', length: 7480, beam: 1400, thrusters: { count: 6, size: 180 } },
  B: { label: 'twin-hull barge', length: 7480, beam: 1640, thrusters: { count: 8, size: 170 } },
  C: { label: 'ore carrier with mining jaw', length: 7480, beam: 1360, thrusters: { count: 4, size: 260 } },
};

/** Half-breadth (× beam) at t = 0, 0.05 … 1 for the boxy container hull (A). */
const PLAN_BOX = [0.3, 0.62, 0.8, 0.9, 0.96, 0.99, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.99, 0.98, 0.96, 0.94];

export interface BargeDesign {
  record: Record<string, unknown>;
  length: number;
  beam: number;
  /** Mount counts per size, lasers and tractors separately. */
  lasers: Record<CapitalMountSize, number>;
  tractors: Record<CapitalMountSize, number>;
  /** Plan area of the cargo footprint (container stacks, hatch covers), u². */
  holdArea: number;
}

const area = (pts: readonly Pt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

export function bargeDesign(look: BargeLook, map: CapitalMap = 'C'): BargeDesign {
  const v = BARGE_VARIANTS[look];
  const L = v.length, B = v.beam;
  const yAt = (t: number): number => -L / 2 + t * L;
  const parts: Array<Record<string, unknown>> = [];
  const part = (points: Pt[], color: number, role: string): void => {
    parts.push({ points, color, offsetX: 0, offsetY: 0, role });
  };
  const mounts: Array<Record<string, unknown>> = [];
  const lasers = { S: 0, M: 0, L: 0, XL: 0 }, tractors = { S: 0, M: 0, L: 0, XL: 0 };
  let holdArea = 0;
  const hold = (points: Pt[], color: number, role: string): void => { holdArea += area(points); part(points, color, role); };

  /** A mining turret (laser, or a tractor placeholder) on a barbette ring.
   *  `facing`: rest bearing in the mount frame (0 forward, −π/2 starboard). */
  const mount = (kind: 'laser' | 'tractor', size: CapitalMountSize, x: number, y: number, facing: number, arc = 1.6): void => {
    const scale = HOUSE[size] / (CAPITAL_TURRETS[size].houseW * B);
    part(circle(x, y, CAPITAL_TURRETS[size].barbette * B * scale * 1.15, 12), COLORS.barbette, 'barbette');
    const n = (kind === 'laser' ? lasers : tractors)[size]++;
    mounts.push({
      id: `${kind}-${size.toLowerCase()}${n + 1}${x > 0.5 ? 's' : x < -0.5 ? 'p' : 'c'}`, localX: x, localY: -y,
      baseAngle: facing, arcMin: -arc, arcMax: arc, rotationSpeed: SLEW[size],
      weaponId: kind === 'laser' ? 'mining_laser' : TRACTOR_PLACEHOLDER_WEAPON, size, barrels: 1, turretScale: scale,
    });
  };
  /** A row down both sides at x = ±(edge(t) − house/2 − margin). Pattern
   *  letters: upper case a laser of that size, lower case a tractor. */
  const sideRows = (pattern: string, t0: number, t1: number, edge: (t: number) => number): void => {
    const n = pattern.length;
    for (let i = 0; i < n; i++) {
      const ch = pattern[i]!, size = ch.toUpperCase() as CapitalMountSize;
      const t = n === 1 ? t0 : t0 + ((t1 - t0) * i) / (n - 1);
      for (const side of [1, -1] as const) {
        mount(ch === size ? 'laser' : 'tractor', size, side * (edge(t) - HOUSE[size] / 2 - B * 0.035), yAt(t), side > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
    }
  };
  /** Container stacks: `bays` rows along [t0, t1], `cols` stacks across ±w/2. */
  const containerDeck = (t0: number, t1: number, w: number, bays: number, cols: number, x0 = 0, seed = 0): void => {
    const bayL = ((t1 - t0) * L) / bays, colW = w / cols;
    for (let b = 0; b < bays; b++) {
      for (let c = 0; c < cols; c++) {
        const paint = CONTAINERS[(b * 7 + c * 3 + seed + ((b * c) % 5)) % CONTAINERS.length]!;
        hold(rect(x0 - w / 2 + colW * (c + 0.5), yAt(t0) + bayL * (b + 0.5), colW * 0.9, bayL * 0.84, 0.04), paint, 'cargo');
      }
    }
  };
  /** The engine bank: a transverse engine room plus one housing per nozzle,
   *  lined up with the forge's nozzle spread and reaching `ext` aft of the hull. */
  const engines = (blockT0: number, blockW: number, ext: number): void => {
    const nr = v.thrusters.size / 2, n = v.thrusters.count;
    const span = (n - 1) * nr * 2.4;
    part(rect(0, (yAt(blockT0) + yAt(1)) / 2, blockW, yAt(1) - yAt(blockT0), 0.06), COLORS.engine, 'engine');
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      part(rect(x, yAt(1) + ext / 2 - nr * 0.6, nr * 2.3, ext + nr * 1.2, 0.2), COLORS.housing, 'engine');
    }
  };
  const superstructure = (t0: number, t1: number, tiers: ReadonlyArray<number>): void => {
    tiers.forEach((w, i) => {
      const inset = (t1 - t0) * 0.12 * i;
      part(rect(0, yAt((t0 + t1) / 2), B * w, L * (t1 - t0 - 2 * inset), 0.1), i % 2 ? COLORS.upper2 : COLORS.upper, 'superstructure');
    });
  };

  if (look === 'A') {
    const s = { plan: PLAN_BOX };
    const N = 20;
    const right: Pt[] = [];
    for (let i = 0; i <= N; i++) right.push([hullHalfWidth(s, i / N) * B, yAt(i / N)]);
    part([[0, yAt(0) - L * 0.004], ...right, ...right.slice().reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    part(right.slice(1).map(([x, y]): Pt => [x * 0.9, y]).concat(right.slice(1).reverse().map(([x, y]): Pt => [-x * 0.9, y])), COLORS.deck, 'deck');
    containerDeck(0.17, 0.75, B * 0.7, 13, 6);
    superstructure(0.765, 0.83, [0.9, 0.62, 0.34]);
    engines(0.885, B * 0.92, L * 0.035);
    const edge = (t: number): number => hullHalfWidth(s, t) * B;
    sideRows('LsMSmLsMSmL', 0.19, 0.73, edge);
    mount('laser', 'XL', B * 0.24, yAt(0.13), 0, 1.9);
    mount('laser', 'XL', -B * 0.24, yAt(0.13), 0, 1.9);
    mount('tractor', 'XL', B * 0.32, yAt(0.85), -Math.PI / 2);
    mount('tractor', 'XL', -B * 0.32, yAt(0.85), Math.PI / 2);
  } else if (look === 'B') {
    // Two pontoons (0.3 B each) at ±0.35 B with their own bows; a notch between
    // them forward of the hold; a flat transom across both carries the engines.
    const Y = yAt;
    const right: Pt[] = [[0, Y(0.15)], [B * 0.2, Y(0.13)], [B * 0.23, Y(0.04)], [B * 0.3, Y(0.005)], [B * 0.37, Y(0)], [B * 0.44, Y(0.02)], [B * 0.49, Y(0.07)], [B * 0.5, Y(0.12)], [B * 0.5, Y(1)]];
    part([...right, ...right.slice(1).reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    for (const side of [1, -1]) part(rect(side * B * 0.35, Y(0.56), B * 0.25, L * 0.84, 0.08), COLORS.deck, 'deck');
    part(rect(0, Y(0.5), B * 0.42, L * 0.66, 0.03), COLORS.hold, 'hold');
    containerDeck(0.19, 0.81, B * 0.4, 15, 4, 0, 2);
    superstructure(0.84, 0.885, [1, 0.5, 0.26]);
    engines(0.9, B, L * 0.03);
    sideRows('LsMmLSsMLsM', 0.13, 0.8, () => B * 0.5);
    // Hold-rim tractors (pull the cut ore in), facing forward over the hold.
    for (const t of [0.24, 0.42, 0.6, 0.78]) {
      for (const side of [1, -1]) mount('tractor', 'M', side * B * 0.245, Y(t), 0, 2.2);
    }
    mount('laser', 'XL', B * 0.36, Y(0.07), 0, 1.9);
    mount('laser', 'XL', -B * 0.36, Y(0.07), 0, 1.9);
  } else {
    // The jaw: two prongs ahead of the hold, a mouth between them.
    const Y = yAt;
    const right: Pt[] = [[0, Y(0.2)], [B * 0.2, Y(0.195)], [B * 0.22, Y(0.03)], [B * 0.3, Y(0)], [B * 0.42, Y(0.015)], [B * 0.49, Y(0.09)], [B * 0.5, Y(0.15)], [B * 0.5, Y(0.97)], [B * 0.47, Y(1)]];
    part([...right, ...right.slice(1).reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    part(rect(0, Y(0.6), B * 0.88, L * 0.76, 0.04), COLORS.deck, 'deck');
    // Ore-carrier hatches: a coaming and a ridged cover per hatch.
    const hatches = 8, h0 = 0.25, h1 = 0.78, hl = (h1 - h0) / hatches;
    for (let i = 0; i < hatches; i++) {
      const cy = Y(h0 + hl * (i + 0.5));
      part(rect(0, cy, B * 0.72, L * hl * 0.9, 0.05), COLORS.coaming, 'coaming');
      hold(rect(0, cy, B * 0.66, L * hl * 0.8, 0.08), COLORS.hatch, 'cargo');
      part(rect(0, cy, B * 0.04, L * hl * 0.8, 0.2), COLORS.coaming, 'cargo');
    }
    superstructure(0.8, 0.86, [0.66, 0.46, 0.24]);
    engines(0.885, B * 0.9, L * 0.04);
    sideRows('MsSMsSMsSM', 0.27, 0.77, () => B * 0.5);
    // The jaw: XL cutters on the prong tips, L cutters lining the mouth
    // (angled in), and an XL tractor on the mouth's back wall.
    for (const side of [1, -1] as const) {
      mount('laser', 'XL', side * B * 0.33, Y(0.055), 0, 1.9);
      mount('laser', 'L', side * B * 0.29, Y(0.12), side * Math.PI / 4, 1.6);
      mount('laser', 'L', side * B * 0.29, Y(0.17), side * Math.PI / 4, 1.6);
    }
    mount('tractor', 'XL', 0, Y(0.24), 0, 1.4);
  }

  // Physics: the battleship's, scaled to the barge's length and beam, heavier,
  // slower and less nimble (a loaded freighter).
  const bs = capitalTargets('battleship', CAPITAL_MAPPINGS[map]);
  const mass = bs.mass * (L / bs.length) * (B / bs.beam) * 1.2;
  const p = solveCapitalPhysics({
    ...bs, length: L, beam: B, mass, topSpeed: bs.topSpeed * 0.7,
    accelSeconds: bs.accelSeconds * 1.6, turnDiameter: bs.turnDiameter * 1.6, turnResponseSeconds: bs.turnResponseSeconds * 1.6,
  });
  const health = Math.round(900 * Math.pow(mass / CAPITAL_MAPPINGS[map].destroyerMass, 0.85));
  const ids = mounts.map((m) => m['id'] as string);
  const record = {
    id: BARGE_LOOK_KIND_ID,
    displayName: 'Mining Barge',
    description: `Mining barge look option ${look} (${v.label}): container hold, mining lasers and tractors down both sides, oversized stern engines.`,
    npcOnly: true,
    randomSpawn: false,
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
    thrusters: v.thrusters,
    maxHealth: health,
    shieldMax: Math.round(health * 0.5),
    shieldRegenDelayTicks: 600,
    shieldRegenRate: (health * 0.5) / 600,
    energyMax: 600,
    energyRegenRate: 2,
    cargoCapacity: Math.round(holdArea / 100),
    ai: { thrust: p.thrustImpulse },
    aiRole: 'civilian',
    shape: { kind: 'composite', scale: 1, hull: convexHull(parts.flatMap((q) => q['points'] as Pt[])), parts },
    mounts,
    slots: [
      { id: 'laser', displayName: 'Mining lasers', mountIds: ids.filter((i) => i.startsWith('laser-')), colour: 0 },
      { id: 'tractor', displayName: 'Tractors', mountIds: ids.filter((i) => i.startsWith('tractor-')), colour: 1 },
    ],
  };
  return { record, length: L, beam: B, lasers, tractors, holdArea };
}
