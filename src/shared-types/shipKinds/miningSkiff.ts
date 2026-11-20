/**
 * Mining Skiff — a small mining ship a player flies (playable base loop, job
 * 1D). It carries the existing mining laser and tractor on S mounts (the
 * laser-and-chunk path: cut a rock, tractor the pieces in, chunks go to the
 * hold through `LootSubsystem`). Not the robot harvester's `mineAsteroid`
 * path, and no new machinery: data only.
 *
 * Mount sizes: both S, so the salvage ladder closes (`salvageTargeting.ts`):
 * the S laser cuts pieces above tier 2 and the S tractor pulls tier 2 and
 * below. Reach: laser 5,455, tractor 1,364 (the mount-size ladder).
 * Hold: 2,000 weight = 8 of the lightest rock chunk (250), or 2 of the
 * heaviest an S tractor can pull (~1,000).
 *
 * LOOK: three hull options (`MINING_SKIFF_HULLS`), owner picks one. The kind
 * flies option A until then. Each option is a composite (parts over a convex
 * collision hull) with its mounts placed on its own emitter and dishes.
 * Points are Pixi-up (nose at -y); mounts are game-space (+y forward).
 */

import { defineShipKind } from '../shipScale/defineShipKind.js';
import { convexHull, type Pt } from './capitals/warshipDesign.js';
import type { ShipKind } from './types.js';

const GREY = 0x8b929c;
const DARK = 0x3b4049;
const AMBER = 0xd9a227;
const GLOW = 0x4fd1ff;

/** One hull option, authored on a ~±20 grid then scaled by `SKIFF_SIZE`. */
interface SkiffHullDraft {
  readonly label: string;
  /** [points, colour, role]; a `sym` part is drawn on both sides (x mirrored). */
  readonly parts: ReadonlyArray<readonly [Pt[], number, string, 'sym'?]>;
  /** Laser emitter and the starboard tractor dish, Pixi-up (port mirrors). */
  readonly laser: Pt;
  readonly tractor: Pt;
}

/** Authored grid → world units at 1×: a stubby hull between the fighter
 *  (radius 12) and the missile frigate (24). */
const SKIFF_SIZE = 0.85;

/** A: "Cutter jaw" — a spine with two forward mandibles cradling the laser,
 *  side hold pods carrying the tractor dishes, a stern engine block. */
const HULL_A: SkiffHullDraft = {
  label: 'Cutter jaw',
  parts: [
    [[[-5, -12], [5, -12], [7, 14], [-7, 14]], DARK, 'spine'],
    [[[4, -12], [9, -22], [12, -20], [11, -6], [7, -4]], GREY, 'mandible', 'sym'],
    [[[8, -4], [16, -2], [16, 12], [9, 14]], GREY, 'cargo', 'sym'],
    [[[9, 10], [16, 9], [16, 12], [9, 14]], AMBER, 'stripe', 'sym'],
    [[[-9, 14], [9, 14], [7, 20], [-7, 20]], DARK, 'engine'],
    [[[-3, -17], [3, -17], [2, -12], [-2, -12]], GLOW, 'emitter'],
    [[[-2, -7], [2, -7], [2, -1], [-2, -1]], GLOW, 'cockpit'],
  ],
  laser: [0, -16],
  tractor: [12.5, 3],
};

/** B: "Spindle rig" — a hexagonal hold core, a long forward boom with the
 *  laser at its tip, swept outrigger arms ending in tractor nacelles. */
const HULL_B: SkiffHullDraft = {
  label: 'Spindle rig',
  parts: [
    [[[-2, -9], [2, -9], [2, -21], [-2, -21]], DARK, 'boom'],
    [[[-4, -25], [4, -25], [3, -21], [-3, -21]], GLOW, 'emitter'],
    [[[7, -2], [15, -10], [17, -8], [9, 2]], DARK, 'arm', 'sym'],
    [[[14, -14], [19, -12], [18, -6], [14, -7]], AMBER, 'nacelle', 'sym'],
    [[[-8, -4], [0, -9], [8, -4], [8, 8], [0, 12], [-8, 8]], GREY, 'cargo'],
    [[[-5, 0], [5, 0], [5, 3], [-5, 3]], AMBER, 'stripe'],
    [[[3, 10], [8, 8], [8, 17], [4, 17]], DARK, 'engine', 'sym'],
  ],
  laser: [0, -23],
  tractor: [16.5, -10],
};

/** C: "Manta scoop" — a flat delta with a scoop mouth at the bow, the laser
 *  deep in the mouth, tractor pods on the wingtips, dorsal hold modules. */
const HULL_C: SkiffHullDraft = {
  label: 'Manta scoop',
  parts: [
    [[[0, -6], [6, -18], [18, -10], [20, 6], [10, 14], [-10, 14], [-20, 6], [-18, -10], [-6, -18]], GREY, 'wing'],
    [[[15, -12], [20, -11], [21, -4], [17, -4]], AMBER, 'pod', 'sym'],
    [[[1, -2], [7, -2], [7, 8], [1, 8]], DARK, 'cargo', 'sym'],
    [[[-8, 14], [8, 14], [6, 19], [-6, 19]], DARK, 'engine'],
    [[[-2, -10], [2, -10], [1, -6], [-1, -6]], GLOW, 'emitter'],
  ],
  laser: [0, -9],
  tractor: [18.5, -8],
};

const mirror = (pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [-x, y] as Pt).reverse();
const sized = (pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [x * SKIFF_SIZE, y * SKIFF_SIZE] as Pt);

/** A built hull option: the shape and the mount positions that go with it. */
export interface SkiffHull {
  readonly label: string;
  readonly shape: { kind: 'composite'; scale: 1; hull: Pt[]; parts: Array<{ points: Pt[]; color: number; offsetX: 0; offsetY: 0; role: string }> };
  readonly radius: number;
  /** Game-space (+y forward) mount spots. */
  readonly laser: { localX: number; localY: number };
  readonly tractor: { localX: number; localY: number };
}

function buildHull(d: SkiffHullDraft): SkiffHull {
  const parts: SkiffHull['shape']['parts'] = [];
  for (const [pts, color, role, sym] of d.parts) {
    parts.push({ points: sized(pts), color, offsetX: 0, offsetY: 0, role });
    if (sym) parts.push({ points: sized(mirror(pts)), color, offsetX: 0, offsetY: 0, role });
  }
  const hull = convexHull(parts.flatMap((p) => p.points));
  const radius = Math.max(...hull.map(([x, y]) => Math.hypot(x, y)));
  return {
    label: d.label,
    shape: { kind: 'composite', scale: 1, hull, parts },
    radius,
    laser: { localX: d.laser[0] * SKIFF_SIZE, localY: -d.laser[1] * SKIFF_SIZE },
    tractor: { localX: d.tractor[0] * SKIFF_SIZE, localY: -d.tractor[1] * SKIFF_SIZE },
  };
}

export const MINING_SKIFF_HULL_A: SkiffHull = buildHull(HULL_A);
export const MINING_SKIFF_HULL_B: SkiffHull = buildHull(HULL_B);
export const MINING_SKIFF_HULL_C: SkiffHull = buildHull(HULL_C);
export const MINING_SKIFF_HULLS = { A: MINING_SKIFF_HULL_A, B: MINING_SKIFF_HULL_B, C: MINING_SKIFF_HULL_C } as const;

/** The 250-weight rock chunk × 8 (see header). */
export const MINING_SKIFF_CARGO = 2000;

const LASER_ARC = Math.PI * 0.6;
const TRACTOR_ARC = Math.PI * 0.85;
const SLEW = 2.5;

/** The kind record for hull option `h` (the catalogue flies option A). */
export function miningSkiffRecord(h: SkiffHull): Record<string, unknown> {
  return {
    id: 'mining-skiff',
    displayName: 'Mining Skiff',
    description: 'Small mining ship: a mining laser to cut rock, tractor dishes to pull the pieces in, a hold for the chunks.',
    // Owned only: never picked by the random spawn pools.
    randomSpawn: false,
    thrustImpulse: 1.4,
    reverseFactor: 0.4,
    boostMultiplier: 1.5,
    maxAngvel: 1.4,
    maxSpeed: 650,
    linearDamping: 0.25,
    angularDamping: 0,
    lateralGrip: 0.03,
    radius: h.radius,
    maxHealth: 260,
    shieldMax: 180,
    shieldRegenDelayTicks: 300,
    shieldRegenRate: 180 / 120,
    // Laser (12 / 10 ticks) + both tractors (4 / 10 ticks each) ≈ 2 / tick:
    // regen carries a steady cut-and-pull.
    energyMax: 300,
    energyRegenRate: 2,
    cargoCapacity: MINING_SKIFF_CARGO,
    ai: { thrust: 0.6 },
    aiRole: 'civilian',
    shape: h.shape,
    mounts: [
      { id: 'laser', localX: h.laser.localX, localY: h.laser.localY, baseAngle: 0, arcMin: -LASER_ARC, arcMax: LASER_ARC, rotationSpeed: SLEW, weaponId: 'mining_laser', size: 'S' },
      { id: 'tractor-s', localX: h.tractor.localX, localY: h.tractor.localY, baseAngle: 0, arcMin: -TRACTOR_ARC, arcMax: TRACTOR_ARC, rotationSpeed: SLEW, weaponId: 'tractor', size: 'S' },
      { id: 'tractor-p', localX: -h.tractor.localX, localY: h.tractor.localY, baseAngle: 0, arcMin: -TRACTOR_ARC, arcMax: TRACTOR_ARC, rotationSpeed: SLEW, weaponId: 'tractor', size: 'S' },
    ],
    slots: [
      { id: 'laser', displayName: 'Mining laser', mountIds: ['laser'], colour: 0 },
      { id: 'tractor', displayName: 'Tractors', mountIds: ['tractor-s', 'tractor-p'], colour: 1 },
    ],
  };
}

export const MINING_SKIFF: ShipKind = defineShipKind(miningSkiffRecord(MINING_SKIFF_HULL_A));
