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
 * LOOK: hull C, "Manta scoop" (owner pick from three options). A composite
 * (parts over a convex collision hull) with its mounts placed on its own
 * emitter and wingtip dishes.
 * Points are Pixi-up (nose at -y); mounts are game-space (+y forward).
 */

import { defineShipKind } from '../shipScale/defineShipKind.js';
import { convexHull, type Pt } from './capitals/warshipDesign.js';
import type { ShipKind } from './types.js';

const GREY = 0x8b929c;
const DARK = 0x3b4049;
const AMBER = 0xd9a227;
const GLOW = 0x4fd1ff;

/** The hull, authored on a ~±20 grid then scaled by `SKIFF_SIZE`. */
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

/** The built hull: the shape and the mount positions that go with it. */
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

export const MINING_SKIFF_HULL: SkiffHull = buildHull(HULL_C);

/** The 250-weight rock chunk × 8 (see header). */
export const MINING_SKIFF_CARGO = 2000;

const LASER_ARC = Math.PI * 0.6;
const TRACTOR_ARC = Math.PI * 0.85;
const SLEW = 2.5;

/** The kind record for hull `h`. */
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

export const MINING_SKIFF: ShipKind = defineShipKind(miningSkiffRecord(MINING_SKIFF_HULL));
