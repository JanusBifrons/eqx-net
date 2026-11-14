/**
 * Ship scale + tuning — the ONE place every size-dependent number comes from
 * (plan: ship scale infrastructure). Shared by server and client (#15).
 *
 * Two layers:
 *  1. `scaleShipKind(kind, factor)` — scales a kind's geometry (radius, shape
 *     scale, mount and latent-mount positions) and records the factor as
 *     `appliedScale`. `defineShipKind` (shipKinds/types) runs it for every
 *     catalogue kind with `effectiveScale(kind)`.
 *  2. `shipTuning(kind)` — every OTHER number that depends on a ship's size,
 *     derived from its `appliedScale` and its `sizeClass` through the
 *     `CLASS_TUNING` table: muzzle clearance, hit radius, shield pad, turret
 *     sizes, exhaust, spawn clearance, loot pickup, flocking, bake budget.
 *
 * Rule: a size-dependent number comes from here, never a constant. At scale 1
 * with today's classes every value equals the old constant exactly, so the
 * 1× game is byte-identical; at 2× they follow the ships; a capital class
 * gets its own multipliers. Tuning is a data change in `CLASS_TUNING`.
 *
 * Cached per kind object (a hot loop pays one WeakMap lookup, #14). Pure.
 */
import type { ShipKind, WeaponMount } from '../shipKinds/types.js';
import { SHIP_SCALE, SHIP_TUNING, type ShipTuningProfile } from './config.js';
import { NAVAL_RANGE, type NavalRangeMode } from '../combat/navalRange.js';
import { REAL_NAVAL_GUNS, navalGunEngageReach, type NavalGunId } from '../combat/navalGuns.js';
import { destructionProfileIdForKind, type DestructionProfileId } from './destruction.js';

export type SizeClass = 'fighter' | 'frigate' | 'cruiser' | 'capital';
export const SIZE_CLASSES: readonly SizeClass[] = ['fighter', 'frigate', 'cruiser', 'capital'];

/** Mount size: scales a weapon's reach, projectile radius and splash. */
export type MountSize = 'S' | 'M' | 'L' | 'XL';

/** The 1× fighter values every size-dependent number starts from. These ARE
 *  the old constants (kept here so the 1× game is unchanged). */
export const BASE = {
  /** Player chin-gun clearance (was MUZZLE_CLEARANCE). */
  muzzleClearance: 20,
  /** Drone chin-gun clearance (was a literal 16 in AiFireResolver). */
  droneMuzzleClearance: 16,
  /** Missile vs player / wreck hit radius (was SHIP_COLLISION_RADIUS). */
  hitRadius: 12,
  /** Shield ball padding over the radius (was SHIELD_RADIUS_PAD). */
  shieldPad: 10,
  /** Turret caps (were BARREL_LEN_MAX / WID / CAP / RACK in muzzle.ts). */
  barrelLenMax: 40, barrelWidMax: 6, capMax: 9, rackCapMax: 10,
  /** Turret minimums (barrel ≥ 7, width ≥ 2, cap ≥ 3, rack ≥ 3.2). */
  barrelLenMin: 7, barrelWidMin: 2, capMin: 3, rackCapMin: 3.2,
  /** Exhaust: the radius plumes are drawn relative to, the nozzle radius cap. */
  plumeRefRadius: 12, nozzleMax: 5,
  /** Engine ribbon history, seconds of nozzle path (the exhaust lab's 16 samples at 60 Hz, at 1x). */
  exhaustTrailS: 16 / 60,
  /** Spawn clearance from structures (was SPAWN_STRUCTURE_CLEARANCE 120). */
  spawnClearance: 120,
  /** Loot pickup radius (was LOOT_PICKUP_RADIUS). */
  lootPickup: 80,
  /** Flocking (were FLOCK_FOLLOW_DISTANCE / FLOCK_SEPARATION_RADIUS). */
  flockFollow: 220, flockSeparation: 150,
  /** Smallest guard area an NPC holds round its post (a 1x fighter's). */
  guardRadiusMin: 600,
  /** Art bake: ppu for small / big hulls, the radius between them, the side cap. */
  ppuSmall: 4, ppuBig: 3, ppuBigRadius: 25, bakeMaxSide: 512,
} as const;

/** Per-class multipliers on top of `appliedScale`. 1 everywhere for the
 *  classes today's kinds use, so 1× is unchanged; tune capitals here. */
export interface ClassTuning {
  /** Multiplier on muzzle, hit radius, shield pad, turret caps, exhaust. */
  geometry: number;
  /** Multiplier on spawn clearance, loot pickup, flocking. */
  spacing: number;
  /** Bake side cap for this class (texels). */
  bakeMaxSide: number;
  /** Default mount size for this class. */
  mountSize: MountSize;
  /** Clearances also reach past the hull (radius × 1.05): a gigantic hull's
   *  chin gun must clear it, whatever the fighter-relative rule says. */
  clearHull: boolean;
}

export const CLASS_TUNING: Readonly<Record<SizeClass, ClassTuning>> = {
  fighter: { geometry: 1, spacing: 1, bakeMaxSide: BASE.bakeMaxSide, mountSize: 'S', clearHull: false },
  frigate: { geometry: 1, spacing: 1, bakeMaxSide: BASE.bakeMaxSide, mountSize: 'S', clearHull: false },
  cruiser: { geometry: 1, spacing: 1, bakeMaxSide: BASE.bakeMaxSide, mountSize: 'S', clearHull: false },
  // Capitals (gigantic hulls): bigger turrets and nozzles than the per-scale
  // rule alone would give, more room to spawn, a bigger texture budget.
  // Capitals bake up to 3072 texels long, cut into 1024-texel tiles (round 3 E).
  capital: { geometry: 2, spacing: 2, bakeMaxSide: 3072, mountSize: 'L', clearHull: true },
};

/** Mount size multipliers on weapon reach / projectile radius / splash. */
export const MOUNT_SIZE_TUNING: Readonly<Record<MountSize, { reach: number; radius: number; splash: number }>> = {
  S: { reach: 1, radius: 1, splash: 1 },
  M: { reach: 1.25, radius: 1.5, splash: 1.5 },
  L: { reach: 1.6, radius: 2.5, splash: 2.5 },
  XL: { reach: 2.2, radius: 4, splash: 4 },
};

/** A kind's size class: authored, else by its UNSCALED radius. */
export function sizeClassOf(kind: Pick<ShipKind, 'radius'> & { sizeClass?: SizeClass; appliedScale?: number; engineeringOnly?: boolean }): SizeClass {
  if (kind.sizeClass) return kind.sizeClass;
  // Engineering test hulls (the 10× crossguard / el) keep fighter rules, so
  // the tests built on them see today's numbers.
  if (kind.engineeringOnly) return 'fighter';
  const r = kind.radius / (kind.appliedScale ?? 1);
  return r < 20 ? 'fighter' : r < 40 ? 'frigate' : r < 120 ? 'cruiser' : 'capital';
}

/** The scale a catalogue kind is built at: the global scale (engineering
 *  test hulls are pinned) times its own `sizeScale`. */
export function effectiveScale(kind: { engineeringOnly?: boolean; sizeScale?: number }, global: number = SHIP_SCALE): number {
  return (kind.engineeringOnly ? 1 : global) * (kind.sizeScale ?? 1);
}

function scaleMount(m: WeaponMount, f: number): WeaponMount {
  return { ...m, localX: m.localX * f, localY: m.localY * f };
}

/**
 * The motion model: how size changes mass, thrust, turning and top speed.
 * Exponents are tuning data. At scale `s` (uniform, same engines):
 *  - mass ∝ volume: s^massExp (3);
 *  - thrust ∝ total nozzle area: s² (more / bigger engines via `thrusters`);
 *  - linear acceleration = thrust / mass ∝ s^(2 − massExp);
 *  - turning: thruster torque (area × lever arm ∝ s³) over rotational inertia
 *    (mass × r² ∝ s^(massExp + 2)); the turn RATE follows that ratio to the
 *    power `turnExp` (0.5 ⇒ 1/s at uniform scale);
 *  - top speed follows the acceleration change to the power `speedExp`.
 * Applied ONCE when a kind is scaled, to the kind's own fields (`mass`,
 * `thrustImpulse`, `ai.thrust`, `maxAngvel`, `maxSpeed`), so the player
 * input, the drone brain and the collider mass all follow on both sides.
 */
export const MOTION = { massExp: 3, turnExp: 0.5, speedExp: 0.5 } as const;

/** Total nozzle area (count × size²) of a kind's thrusters at 1×: authored,
 *  else one nozzle sized like the bake's (radius × 0.16, 0.9–5). */
export function thrusterArea(kind: Pick<ShipKind, 'radius'> & { thrusters?: { count: number; size: number } }, unscaledRadius = kind.radius): number {
  if (kind.thrusters) return kind.thrusters.count * kind.thrusters.size * kind.thrusters.size;
  const nr = Math.min(5, Math.max(0.9, unscaledRadius * 0.16));
  return nr * nr;
}

export interface MotionFactors { mass: number; thrust: number; turn: number; speed: number }

/** Motion multipliers for scaling a kind by `s` (1 ⇒ all 1). `engines` is
 *  the ratio of the kind's thruster area to the default (1 unless authored). */
export function motionFactors(s: number, engines = 1): MotionFactors {
  const mass = Math.pow(s, MOTION.massExp);
  const thrust = s * s * engines;
  const accel = thrust / mass;
  const torque = thrust * s; // area × lever arm
  const inertia = mass * s * s;
  return { mass, thrust, turn: Math.pow(torque / inertia, MOTION.turnExp), speed: Math.pow(accel, MOTION.speedExp) };
}

/**
 * Scale a kind by `factor`: geometry (radius, shape scale, mount and
 * latent-mount positions) and motion (`motionFactors`). Records
 * `appliedScale` (compounding). At factor 1 with default engines the input
 * is returned unchanged in every field, so 1× kinds are today's kinds.
 */
export function scaleShipKind(kind: ShipKind, factor: number): ShipKind {
  const unscaledR = kind.radius / (kind.appliedScale ?? 1);
  // Engines vs the default, both at 1× (an already-scaled kind's nozzles are
  // scaled by appliedScale too, so the ratio is unchanged by re-scaling).
  const s0 = kind.appliedScale ?? 1;
  const engines = kind.thrusters
    ? (kind.thrusters.count * (kind.thrusters.size / s0) ** 2) / thrusterArea({ radius: unscaledR })
    : 1;
  if (factor === 1 && (engines === 1 || kind.appliedScale !== undefined)) return kind.appliedScale === undefined ? { ...kind, appliedScale: 1 } : kind;
  // Authored engines apply once, at the first scale (defineShipKind).
  const m = motionFactors(factor, kind.appliedScale === undefined ? engines : 1);
  const shape = { ...kind.shape, scale: (kind.shape.scale ?? 1) * factor } as ShipKind['shape'];
  return {
    ...kind,
    radius: kind.radius * factor,
    shape,
    ...(kind.mounts ? { mounts: kind.mounts.map((mt) => scaleMount(mt, factor)) } : {}),
    ...(kind.latentMounts ? { latentMounts: kind.latentMounts.map((mt) => scaleMount(mt, factor)) } : {}),
    massScale: (kind.massScale ?? 1) * m.mass,
    thrustImpulse: kind.thrustImpulse * m.thrust,
    maxAngvel: kind.maxAngvel * m.turn,
    maxSpeed: kind.maxSpeed * m.speed,
    // Terminal speed under drag is accel / damping: scale the damping so the
    // top speed lands on the model's speed factor, not just the cap.
    linearDamping: kind.linearDamping * ((m.thrust / m.mass) / m.speed),
    ai: { ...kind.ai, thrust: kind.ai.thrust * m.thrust },
    // Already scaled: a re-scale must not count the authored engines twice.
    ...(kind.thrusters ? { thrusters: { count: kind.thrusters.count, size: kind.thrusters.size * factor } } : {}),
    appliedScale: (kind.appliedScale ?? 1) * factor,
  };
}

/** A kind's physics mass: its authored mass (else the side's fallback) times
 *  the motion model's multiplier. Every body spawn uses this. */
export function massOf(kind: { mass?: number; massScale?: number }, fallback: number): number {
  return (kind.mass ?? fallback) * (kind.massScale ?? 1);
}

/** An NPC (swarm drone) body's mass when its kind authors none. One source for
 *  the spawner (`SwarmSpawner.DRONE_DEFAULT_MASS`) and the AI pilot, which needs
 *  the body's mass to know how hard a tick of thrust pushes it. */
export const NPC_MASS_FALLBACK = 2;

/** A ship body's rotational inertia: the disc formula the physics world
 *  sets (`World.spawnShip`, density-0 colliders), shared with the capital
 *  solver so torque turning hits its targets (invariant 15). */
export function shipAngularInertia(mass: number, radius: number): number {
  return 0.5 * mass * radius * radius;
}

/** Every size-dependent number for one kind (cached per kind object). */
export interface ShipTuning {
  sizeClass: SizeClass;
  appliedScale: number;
  muzzleClearance: number;
  droneMuzzleClearance: number;
  hitRadius: number;
  shieldPad: number;
  barrelLenMin: number; barrelLenMax: number;
  barrelWidMin: number; barrelWidMax: number;
  capMin: number; capMax: number;
  rackCapMin: number; rackCapMax: number;
  /** Exhaust plume multiplier (1 for a 1× fighter). */
  plumeScale: number;
  nozzleMax: number;
  /** Seconds of nozzle path the engine ribbon spans: the lab's 1x window, grown so
   *  the ribbon stays the same number of hull lengths when ships are bigger (and
   *  slower, `motionFactors`). Authored as a constant it came out ~2.8x shorter
   *  against the hull at 2x and hid inside the flame (2026-11-06). */
  exhaustTrailS: number;
  spawnClearance: number;
  lootPickup: number;
  flockFollow: number;
  flockSeparation: number;
  /** Smallest guard radius round an NPC's guard post (`HostileDroneBehaviour.setGuardPost`):
   *  a post smaller than this would leave a big hull no room to turn. */
  guardRadiusMin: number;
  /** Capital wreck break-up (capital-destruction.md): the outward push of a
   *  piece at the kill point and far from it (u/s). Proportional to the hull
   *  radius, so a bigger hull's debris field opens at the same rate relative
   *  to its size: heavy cruiser (2×) ~22 / ~9 u/s, battleship ~29 / ~12.
   *  Owner review 2026-11-13: "they should break apart slower and have more
   *  inertia and weight" (the 2026-11-12 money-shot push was ~10× this). */
  wreckPushMax: number;
  wreckPushMin: number;
  /** How this kind breaks up when it dies (`destruction.ts`): `capital`,
   *  `subcap` or `none`. The numbers are `DESTRUCTION_PROFILES[id]`. */
  destruction: DestructionProfileId;
  /** Capital wreck break-up: the least speed (u/s) at which two neighbouring
   *  pieces part along their shared cut, at every point of it (spin
   *  included), so no seam hinges or slides shut (owner review 2026-11-13).
   *  Heavy cruiser (2×) ~31 u/s: fast enough that every cut is visibly open
   *  1 s after the crack (owner, same day: at ~5 u/s the hull read as
   *  "cracked but intact"), slow enough that no piece passes ~80 u/s. */
  wreckSeparate: number;
  /** Capital wreck pieces collide with each other: each convex collider part
   *  is shrunk this far (u, toward the part's centre) so neighbours that
   *  share a cut edge start a hair apart instead of touching. ~1 u for a 2×
   *  heavy cruiser. */
  wreckColliderInset: number;
  /** Art bake pixels per world unit, and the texture side cap. */
  bakePpu: number;
  bakeMaxSide: number;
  mountSize: MountSize;
  /** Incoming-fire warning: a naval shell whose predicted path passes within
   *  this distance (u) of the ship's centre gets a fall-point marker. Twice the
   *  shield ball (hull radius + shield pad): the ball is what a shell must
   *  touch to hit, and the second ball-width is the margin for the ship's turn
   *  and the straight-line prediction over a long flight. The client adds a
   *  gun's splash radius per shot. Fighter (2x) 88 u; battleship ~5,790 u. */
  incomingFireRadius: number;
  /** Capital hull overlap (capitalOverlap.ts): overlap below this is contact
   *  skin left to Rapier, a quarter of the shield pad (5 u for a 2x capital). */
  overlapSkin: number;
  /** Capital hull overlap: the most a hull pair is moved apart per fixed step,
   *  0.3 % of the hull radius (6.6 u/tick ≈ 390 u/s for a 2x heavy cruiser, so
   *  a forced 350 u overlap clears in about a second). */
  overlapMaxStep: number;
}

const CACHE = new WeakMap<object, ShipTuning>();

/** Wreck push at the kill point / far from it, per unit of hull radius per
 *  second (`wreckPushMax` / `wreckPushMin`). */
const WRECK_PUSH_MAX_PER_RADIUS = 0.01;
const WRECK_PUSH_MIN_PER_RADIUS = 0.004;
/** Least parting speed of two neighbouring wreck pieces, per unit of hull
 *  radius per second (`wreckSeparate`). */
const WRECK_SEPARATE_PER_RADIUS = 0.014;
/** Wreck collider inset, per unit of hull radius (`wreckColliderInset`). */
const WRECK_COLLIDER_INSET_PER_RADIUS = 0.0005;

/** The size-dependent numbers for a (scaled) kind. */
export function shipTuning(kind: ShipKind): ShipTuning {
  let t = CACHE.get(kind);
  if (t) return t;
  const s = kind.appliedScale ?? 1;
  const cls = sizeClassOf(kind);
  const ct = CLASS_TUNING[cls];
  const g = s * ct.geometry, sp = s * ct.spacing;
  const unscaledR = kind.radius / s;
  t = {
    sizeClass: cls,
    appliedScale: s,
    muzzleClearance: ct.clearHull ? Math.max(BASE.muzzleClearance * g, kind.radius * 1.05) : BASE.muzzleClearance * g,
    droneMuzzleClearance: ct.clearHull ? Math.max(BASE.droneMuzzleClearance * g, kind.radius * 1.05) : BASE.droneMuzzleClearance * g,
    hitRadius: BASE.hitRadius * g,
    shieldPad: BASE.shieldPad * g,
    barrelLenMin: BASE.barrelLenMin * g, barrelLenMax: BASE.barrelLenMax * g,
    barrelWidMin: BASE.barrelWidMin * g, barrelWidMax: BASE.barrelWidMax * g,
    capMin: BASE.capMin * g, capMax: BASE.capMax * g,
    rackCapMin: BASE.rackCapMin * g, rackCapMax: BASE.rackCapMax * g,
    plumeScale: (kind.radius / BASE.plumeRefRadius) * ct.geometry,
    nozzleMax: BASE.nozzleMax * g,
    exhaustTrailS: (BASE.exhaustTrailS * s) / motionFactors(s).speed,
    spawnClearance: ct.clearHull ? Math.max(BASE.spawnClearance * sp, kind.radius * 2) : BASE.spawnClearance * sp,
    lootPickup: ct.clearHull ? Math.max(BASE.lootPickup * sp, kind.radius * 1.3) : BASE.lootPickup * sp,
    flockFollow: ct.clearHull ? Math.max(BASE.flockFollow * sp, kind.radius * 3.3) : BASE.flockFollow * sp,
    flockSeparation: ct.clearHull ? Math.max(BASE.flockSeparation * sp, kind.radius * 2.2) : BASE.flockSeparation * sp,
    guardRadiusMin: ct.clearHull ? Math.max(BASE.guardRadiusMin * sp, kind.radius * 2) : BASE.guardRadiusMin * sp,
    wreckPushMax: WRECK_PUSH_MAX_PER_RADIUS * kind.radius,
    wreckPushMin: WRECK_PUSH_MIN_PER_RADIUS * kind.radius,
    destruction: destructionProfileIdForKind(kind),
    wreckSeparate: WRECK_SEPARATE_PER_RADIUS * kind.radius,
    wreckColliderInset: WRECK_COLLIDER_INSET_PER_RADIUS * kind.radius,
    // Pixel density by the UNSCALED hull (so a 2× fighter stays as sharp per
    // world unit as today's), within the class's side budget.
    bakePpu: unscaledR >= BASE.ppuBigRadius ? BASE.ppuBig : BASE.ppuSmall,
    bakeMaxSide: ct.bakeMaxSide,
    mountSize: ct.mountSize,
    incomingFireRadius: 2 * (kind.radius + BASE.shieldPad * g),
    overlapSkin: (BASE.shieldPad * g) / 4,
    overlapMaxStep: kind.radius * 0.003,
  };
  CACHE.set(kind, t);
  return t;
}

/** A mount's size: authored, else its ship class's default. */
export function mountSizeOf(m: WeaponMount & { size?: MountSize }, kind: ShipKind): MountSize {
  return m.size ?? shipTuning(kind).mountSize;
}

/**
 * How the combat profile scales weapon distances at a ship scale: A keeps
 * them, B grows reach half as fast as the ships and splash with them.
 */
export function combatDistanceScale(profile: ShipTuningProfile = SHIP_TUNING, scale: number = SHIP_SCALE): { reach: number; splash: number } {
  if (profile === 'A') return { reach: 1, splash: 1 };
  return { reach: 1 + (scale - 1) / 2, splash: scale };
}

/** Camera at the ship scale. The world isn't scaled, so the zoom-out floor
 *  (how much space you can see) stays; the START zoom eases out by
 *  scale^-0.5, so bigger ships draw bigger on screen (s^0.5 ×) while the
 *  spawn view still shows more space around them. 1× ⇒ the base value. */
export const CAMERA_ZOOM_EXP = 0.5;
export function startZoomForScale(base: number, scale: number = SHIP_SCALE): number {
  return base / Math.pow(scale, CAMERA_ZOOM_EXP);
}

/** Gameplay camera zoom-out floor for an ordinary ship. */
export const GAMEPLAY_MIN_ZOOM = 0.15;
/** Hulls up to this radius keep the ordinary zoom range; a bigger hull widens
 *  it in proportion (capital-ship R&D round 3 D). Above every non-capital. */
export const HULL_ZOOM_REF_RADIUS = 600;

/** How much further out the camera may go for this hull (1 for every
 *  non-capital; ~4.8 for a 10x battleship). */
export function hullZoomFactor(kind: Pick<ShipKind, 'radius'>): number {
  return kind.radius > HULL_ZOOM_REF_RADIUS ? kind.radius / HULL_ZOOM_REF_RADIUS : 1;
}

/** Half the width, in CSS px, of the widest view the shell interest plans for
 *  (a 1920-px desktop window). A phone (390×844) is narrower on both axes. */
export const SHELL_VIEW_HALF_PX = 960;

/** Head-room past a capital's longest reach at its zoom-out floor, so the
 *  range ring and a shell landing at full reach sit inside the screen edge. */
export const GUN_VIEW_MARGIN = 1.05;

/** What the zoom-out floor reads from a kind: its radius always; a capital's
 *  class and mounts for its gun reach. */
export type ZoomKind = Pick<ShipKind, 'radius'> & {
  sizeClass?: SizeClass;
  mounts?: ReadonlyArray<Pick<WeaponMount, 'weaponId' | 'localX' | 'localY'>>;
};

/** The half-width (u) a CAPITAL pilot's widest view must show to see its
 *  longest naval gun's engage reach (from the ship's centre: reach + that
 *  mount's offset, as `mountTargetReach`), × `GUN_VIEW_MARGIN`. 0 for every
 *  sub-capital, and for every kind in `legacy` mode (the hull floor already
 *  covers the legacy reaches), so both keep today's floor exactly.
 *  Owner decision 2026-11-10: capitals may zoom out to their gun's reach. */
export function gunneryViewHalfExtent(kind: ZoomKind, mode: NavalRangeMode = NAVAL_RANGE): number {
  if (mode !== 'real' || kind.sizeClass !== 'capital' || !kind.mounts) return 0;
  let r = 0;
  for (const m of kind.mounts) {
    if (!(m.weaponId in REAL_NAVAL_GUNS)) continue;
    const reach = navalGunEngageReach(m.weaponId as NavalGunId, mode) + Math.hypot(m.localX, m.localY);
    if (reach > r) r = reach;
  }
  return r * GUN_VIEW_MARGIN;
}

const FLOOR_CACHE = new WeakMap<object, number>();

/** The REFERENCE gameplay zoom-out floor for the ship you fly, at a
 *  `SHELL_VIEW_HALF_PX` half-width (a 1920-px desktop): the hull floor
 *  `GAMEPLAY_MIN_ZOOM / hullZoomFactor`, lowered for a capital in `real`
 *  naval-range mode until that half-width shows `gunneryViewHalfExtent`. The
 *  live camera uses `zoomFloorForView` (the actual viewport); this one is the
 *  viewport-free reference (starfield tuning, tests). Cached per kind object
 *  for this process's mode. */
export function zoomFloorForKind(kind: ZoomKind, mode: NavalRangeMode = NAVAL_RANGE): number {
  const cache = mode === NAVAL_RANGE;
  if (cache) {
    const hit = FLOOR_CACHE.get(kind);
    if (hit !== undefined) return hit;
  }
  const hull = GAMEPLAY_MIN_ZOOM / hullZoomFactor(kind);
  const gun = gunneryViewHalfExtent(kind, mode);
  const floor = gun > 0 ? Math.min(hull, SHELL_VIEW_HALF_PX / gun) : hull;
  if (cache) FLOOR_CACHE.set(kind, floor);
  return floor;
}

/** The widest screen aspect (long side / short side) for which a capital's
 *  zoom floor fits its gun reach to the SHORT side. Past it (wider than 21:9,
 *  taller than a 19.5:9 phone) the floor fits the long side to
 *  `MAX_VIEW_ASPECT × reach` instead, so no viewport ever shows more than that
 *  — the bound the server's far-shell interest uses (`shellViewHalfExtent`,
 *  #15). */
export const MAX_VIEW_ASPECT = 2.4;

/** The live gameplay zoom-out floor for the ship you fly in a `viewW × viewH`
 *  (CSS px) viewport. As `zoomFloorForKind`, except a capital in `real` mode
 *  fits its gun reach to the viewport's SHORTER half-dimension (the camera is
 *  north-up, so a target can lie in any direction), clamped so the longer half
 *  never shows more than `MAX_VIEW_ASPECT × gunneryViewHalfExtent`. Never
 *  above the hull floor. No viewport size ⇒ the reference floor. */
export function zoomFloorForView(kind: ZoomKind, viewW: number, viewH: number, mode: NavalRangeMode = NAVAL_RANGE): number {
  const gun = gunneryViewHalfExtent(kind, mode);
  if (gun <= 0 || !(viewW > 0) || !(viewH > 0)) return zoomFloorForKind(kind, mode);
  const longHalf = Math.max(viewW, viewH) / 2;
  const fitHalf = Math.max(Math.min(viewW, viewH) / 2, longHalf / MAX_VIEW_ASPECT);
  return Math.min(GAMEPLAY_MIN_ZOOM / hullZoomFactor(kind), fitHalf / gun);
}

/** Gameplay camera zoom-in cap for a hull that fits the view at it (every
 *  ordinary hull on an ordinary screen). */
export const GAMEPLAY_MAX_ZOOM = 3;
/** Head-room around the hull at the zoom-in cap (5 % of its length). */
export const HULL_VIEW_MARGIN = 1.05;

/** The live gameplay zoom-in cap for the ship you fly in a `viewW × viewH`
 *  (CSS px) viewport: the closest zoom at which the whole hull (its radius ×
 *  `HULL_VIEW_MARGIN`) still fits the view's SHORTER half (north-up camera,
 *  so the hull may point any way). `GAMEPLAY_MAX_ZOOM` at most (a fighter
 *  keeps 3), never below `floor` (the zoom-out floor). No viewport size ⇒
 *  `GAMEPLAY_MAX_ZOOM`. Owner decision 2026-11-12: "You can't zoom in past the
 *  point where your whole hull fits on screen." */
export function zoomCeilingForView(kind: Pick<ShipKind, 'radius'>, viewW: number, viewH: number, floor: number): number {
  if (!(viewW > 0) || !(viewH > 0) || !(kind.radius > 0)) return Math.max(GAMEPLAY_MAX_ZOOM, floor);
  const fit = Math.min(viewW, viewH) / 2 / (kind.radius * HULL_VIEW_MARGIN);
  return Math.max(floor, Math.min(GAMEPLAY_MAX_ZOOM, fit));
}

/** The gameplay zoom range for the ship you fly: the zoom-out floor is
 *  `zoomFloorForView` for the live `viewW × viewH` viewport (the reference
 *  `zoomFloorForKind` when no size is given), and the start zoom divides by
 *  `hullZoomFactor`, so a battleship pilot can pull back to see the ship and
 *  several kilometres around it (in `real` naval-range mode, its longest gun's
 *  reach), while a fighter's range is unchanged. The zoom-in cap is
 *  `zoomCeilingForView` (the whole hull fits), and the start zoom never
 *  exceeds it. `base` is the 1x start zoom. Writes into `out`. */
export function zoomRangeForKind(
  kind: ZoomKind, base: number, out: { minScale: number; startZoom: number; maxScale?: number }, mode: NavalRangeMode = NAVAL_RANGE,
  viewW = 0, viewH = 0,
): { minScale: number; startZoom: number; maxScale: number } {
  out.minScale = zoomFloorForView(kind, viewW, viewH, mode);
  out.maxScale = zoomCeilingForView(kind, viewW, viewH, out.minScale);
  out.startZoom = Math.min(startZoomForScale(base) / hullZoomFactor(kind), out.maxScale);
  return out as { minScale: number; startZoom: number; maxScale: number };
}

const SHELL_VIEW_CACHE = new WeakMap<object, number>();

/** Half-extent (u) of the square around a viewer inside which a naval shell,
 *  or the point where it will fall, is sent to that viewer: at least the widest
 *  view the pilot of `kind` can pull the camera out to (#15). The hull floor's
 *  view at a `SHELL_VIEW_HALF_PX` half-width (legacy: fighter / sub-capital
 *  6,400 u; destroyer (r 1,220) ~13,000 u; battleship (r 2,876) ~30,700 u);
 *  in `real` mode a capital's camera floor follows the viewport
 *  (`zoomFloorForView`), so the server keeps a fixed conservative bound: gun
 *  reach × `GUN_VIEW_MARGIN` × `MAX_VIEW_ASPECT`, which no viewport's longer
 *  half exceeds at the floor. Cached per kind for this process's mode (called
 *  once per recipient per snapshot). */
export function shellViewHalfExtent(kind: ZoomKind, mode: NavalRangeMode = NAVAL_RANGE): number {
  const cache = mode === NAVAL_RANGE;
  if (cache) {
    const hit = SHELL_VIEW_CACHE.get(kind);
    if (hit !== undefined) return hit;
  }
  const hullView = SHELL_VIEW_HALF_PX / (GAMEPLAY_MIN_ZOOM / hullZoomFactor(kind));
  const half = Math.max(hullView, gunneryViewHalfExtent(kind, mode) * MAX_VIEW_ASPECT);
  if (cache) SHELL_VIEW_CACHE.set(kind, half);
  return half;
}

/** The radius shield EFFECTS are sized to (hit flash, break dome, the legacy
 *  ring). The hull radius for every kind, except capitals, whose shield follows
 *  the hull (`shipShieldColliderDesc`): their effects use the hull's half beam,
 *  not half a 5.8 km length (capital-ship R&D round 3). */
export function shieldVisualRadius(kind: ShipKind): number {
  if (kind.sizeClass !== 'capital') return kind.radius;
  const hull = (kind.shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull;
  if (!hull) return kind.radius;
  let w = 0;
  for (const p of hull) w = Math.max(w, Math.abs(p[0]));
  return w > 0 ? w : kind.radius;
}

/** The radius of a ship's shield BUBBLE: the shield effects' radius plus the
 *  `shipTuning` shield pad. For every non-capital this IS the shield-up
 *  collider (`shipShieldColliderDesc` = `ball(radius + shieldPad)`), so the
 *  bubble that is drawn is the bubble that collides (owner's rule 2026-11-10,
 *  #15/#18). A capital's shield collider is its hull rounded out by the pad; its
 *  bubble is drawn at half beam + pad. Locked by `shieldColliderParity.test.ts`. */
export function shieldBubbleRadius(kind: ShipKind): number {
  return shieldVisualRadius(kind) + shipTuning(kind).shieldPad;
}
