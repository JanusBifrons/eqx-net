/**
 * Ship-kind catalogue — the single source of truth for what flavours of ship
 * exist in EQX Peri. Read by:
 *
 *   - `src/core/physics/World.ts`     (per-kind damping, max speed, lateral
 *                                      grip, thrust impulse, etc. when the
 *                                      worker spawns or applies input).
 *   - `src/core/ai/HostileDroneBehaviour.ts` (per-kind AI tuning — drones
 *                                      pick a random kind on spawn and steer
 *                                      with that kind's `thrust / turnKp /
 *                                      maxTorque`).
 *   - `src/server/rooms/SectorRoom.ts` (validates the `shipKind` field on
 *                                      `JoinOptions`, writes it to
 *                                      `ShipState.kind`, threads it into the
 *                                      `SPAWN` worker command).
 *   - `src/server/spawn/SwarmSpawner.ts` (picks a random kind per drone).
 *   - `src/client/components/ShipPickerModal.tsx` and the in-game renderer
 *                                      (`shape` drives the polygon and colour
 *                                      so the picker silhouette and the in-
 *                                      world sprite are guaranteed identical).
 *
 * Adding a new kind is one record in `SHIP_KINDS` — no other code change.
 *
 * Living in `src/shared-types/` (pure TS + zod, no runtime behaviour) is what
 * lets server / core / client all read the same definitions without violating
 * the boundary invariants.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Visual shape — a polygon in entity-local space, Pixi-up convention
// (nose at -y, tail at +y). Same convention as `buildShipGfx` /
// `buildDroneGfx` in `src/client/render/PixiRenderer.ts`.
// ---------------------------------------------------------------------------

export const ShipShapeSchema = z
  .object({
    kind: z.literal('polygon'),
    /** Local-space points, [x, y]. Nose typically at (0, -radius). */
    points: z.array(z.tuple([z.number(), z.number()])).min(3),
    /** Fill colour as a 24-bit RGB integer (e.g. `0x00ff88`). */
    color: z.number().int().nonnegative(),
    /** Uniform scale applied to the points at draw time. Default 1. */
    scale: z.number().positive().default(1),
  })
  .strict();
export type ShipShape = z.infer<typeof ShipShapeSchema>;

// ---------------------------------------------------------------------------
// ShipKind — the absolute (not multiplicative) tuning record. Adding a new
// kind never requires diffing against a base — every value is final.
// ---------------------------------------------------------------------------

export const ShipKindSchema = z
  .object({
    /** Stable, lowercase identifier. Wire and persistence safe. */
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    displayName: z.string().min(1),
    description: z.string().default(''),

    // -- Player physics ----------------------------------------------------
    /** Per-tick forward impulse applied while the player holds W / Up. */
    thrustImpulse: z.number().positive(),
    /** Multiplier on `thrustImpulse` while reverse (S / Down) is held.
     *  0 disables reverse, 1 = same magnitude as forward thrust. */
    reverseFactor: z.number().min(0).max(1),
    /** Multiplier on forward thrust impulse while Shift is also held.
     *  Steady-state boosted speed = `thrustImpulse * boostMultiplier /
     *  (1 - e^(-linearDamping/60))`. */
    boostMultiplier: z.number().min(1),
    /** Yaw rate in rad/s while a turn key is held. The controller writes
     *  `body.setAngvel(±maxAngvel)` directly — there is no eased ramp-up.
     *  When the key is released, `angularDamping` decays the angvel. */
    maxAngvel: z.number().positive(),
    /** Hard ceiling on linear velocity magnitude. Per-tick clamp keeps the
     *  ship from running away from the camera. */
    maxSpeed: z.number().positive(),
    /** Rapier `setLinearDamping` value. High = car-like coast-to-stop. */
    linearDamping: z.number().nonnegative(),
    /** Rapier `setAngularDamping` value. */
    angularDamping: z.number().nonnegative(),
    /** Strength of the per-tick lateral-velocity bleed. The lateral-velocity
     *  half-life is `ln(2) / -ln(1 - grip)` ticks at 60 Hz, so:
     *    0     = ice (sideways drift forever; pure space-feel)
     *    0.012 = ≈ 1 s half-life (heavy slide)
     *    0.025 = ≈ 460 ms half-life (clear drift)
     *    0.05  = ≈ 230 ms half-life (quick drift)
     *    0.25  = ≈ 40 ms half-life (instant snap — too grippy for arcade)
     *    1     = on-rails (cancels lateral every tick)
     *  Lower = more drifty. */
    lateralGrip: z.number().min(0).max(1),
    /** Collider radius. Also drives sprite scale. */
    radius: z.number().positive(),
    /** Initial (and `ShipState.maxHealth`) health value. */
    maxHealth: z.number().positive(),

    // -- AI tuning (for drones spawning AS this kind) -----------------------
    ai: z
      .object({
        /** Per-tick forward impulse the drone applies via `applyImpulse`. */
        thrust: z.number().positive(),
        /** P-controller proportional gain on bearing error.
         *  Effective torque = `turnKp * bearingError - 1.5 * angvel`. */
        turnKp: z.number().positive(),
        /** Hard cap on the magnitude of the torque-impulse the drone may
         *  apply per tick. */
        maxTorque: z.number().positive(),
      })
      .strict(),

    shape: ShipShapeSchema,
  })
  .strict();
export type ShipKind = z.infer<typeof ShipKindSchema>;
export type ShipKindId = ShipKind['id'];

// ---------------------------------------------------------------------------
// The three v1 kinds. Drifty-arcade tuning baseline:
//   - linearDamping ≈ 2.0  (was 0.01 — heavy coast-to-stop)
//   - lateralGrip   ≈ 0.45 (drifty, not on-rails)
//   - boostMultiplier 3.5  (matches the legacy BOOST_MULTIPLIER)
// Per-kind axes: scout = nimble & fragile, fighter = balanced, heavy =
// punishing top-end at the cost of agility.
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────
// Tuning derivation (top-down arcade — between space-feel and full-car).
//
// At a fixed 60 Hz step with `setLinearDamping(d)`, the steady-state speed
// from a constant per-tick impulse F applied to a body of mass m=1 is:
//
//   v_terminal = F / (1 - e^(-d/60))
//
// `d` is tuned from a "coast" target — how much velocity remains T seconds
// after release: `e^(-d * T)`.
//
//   d = 0.2 → 67% retained after 2 s (very floaty, near-space feel)
//   d = 0.3 → 55% retained                (Fighter)
//   d = 0.5 → 37% retained                (Scout, faster decel)
//   d = 0.6 → 30% retained
//   d = 1.0 → 14% retained                (full car-feel)
//
// Once `d` is fixed, F is solved from `v_terminal = F / (1 - e^(-d/60))` to
// land on the cruise speed. `maxSpeed` is the hard cap that boost can hit.
//
// Mass for ball colliders is normalised to ≈ 1 by the density formula in
// `World.spawnShip` (`density = 1 / (π * r²)`), so the formula above
// applies uniformly across kinds.
//
// `maxAngvel` is written directly each tick while a turn key is held;
// releasing both keys writes 0. Per-tap rotation is exactly
// `maxAngvel * tap_duration_seconds` — a 100 ms tap at `maxAngvel = 2.0`
// turns the ship 0.2 rad ≈ 11.5°. That's the resolution of fine aim.
// ─────────────────────────────────────────────────────────────────────────

const SCOUT: ShipKind = ShipKindSchema.parse({
  id: 'scout',
  displayName: 'Scout',
  description: 'Light, fast, twitchy. Glass cannon.',
  // d=0.5 → 37% retained after 2 s (decisive decel without being grippy).
  // F=6.0, boost=2 → v_boosted = 6*2 / (1-e^(-0.5/60)) = 12 / 0.00831 ≈ 1444 u/s
  // Doubled impulse vs initial tune: punchier off the line AND higher cruise.
  thrustImpulse: 6.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 3.0,        // 172°/s — twitchy.
  maxSpeed: 1500,
  linearDamping: 0.5,
  angularDamping: 0,     // unused — applyInput owns angvel every tick.
  lateralGrip: 0.05,     // half-life ≈ 230 ms — quickest to bite, still drifts.
  radius: 10,
  maxHealth: 60,
  // Phase-1 agility uplift (2026-05-10): drone terminal angvel
  // = maxTorque / ANGVEL_DAMPING (1.5). To match the player's
  // `maxAngvel = 3.0` we need `maxTorque ≈ 4.5`. `turnKp` bumped from
  // 5.0 → 8.0 so the P-controller actually asks for the new headroom
  // at modest bearing errors instead of saturating only when way off.
  ai: { thrust: 0.7, turnKp: 8.0, maxTorque: 4.5 },
  shape: {
    kind: 'polygon',
    color: 0x00d4ff,
    scale: 1,
    // Slim dart, narrow waist.
    points: [
      [0, -14],
      [6, 8],
      [0, 4],
      [-6, 8],
    ],
  },
});

const FIGHTER: ShipKind = ShipKindSchema.parse({
  id: 'fighter',
  displayName: 'Fighter',
  description: 'Balanced all-rounder. The default.',
  // d=0.3 → 55% retained after 2 s (clear glide, still slows down).
  // F=4.0, boost=2 → v_boosted = 4*2 / (1-e^(-0.3/60)) = 8 / 0.00499 ≈ 1604 u/s
  // Doubled impulse vs initial tune: punchier accel, higher cruise.
  thrustImpulse: 4.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.0,        // 115°/s — fine aim resolution at short taps.
  maxSpeed: 1700,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.025,    // half-life ≈ 460 ms — clear drift on hard turns.
  radius: 12,
  maxHealth: 100,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 2.0`
  // — terminal angvel = maxTorque / 1.5, so maxTorque = 3.0.
  ai: { thrust: 0.5, turnKp: 6.0, maxTorque: 3.0 },
  shape: {
    kind: 'polygon',
    color: 0x00ff88,
    scale: 1,
    // The legacy `buildShipGfx` arrowhead, lifted verbatim for visual
    // continuity with pre-kind builds.
    points: [
      [0, -16],
      [-10, 10],
      [0, 5],
      [10, 10],
    ],
  },
});

const HEAVY: ShipKind = ShipKindSchema.parse({
  id: 'heavy',
  displayName: 'Heavy',
  description: 'Sluggish accel, brutal top speed, a lot of hull.',
  // d=0.2 → 67% retained after 2 s (heavy momentum, long glide).
  // F=3.0, boost=2 → v_boosted = 3*2 / (1-e^(-0.2/60)) = 6 / 0.00333 ≈ 1802 u/s
  // Doubled impulse vs initial tune: still slowest accel, but the highest top speed.
  thrustImpulse: 3.0,
  reverseFactor: 0.4,
  boostMultiplier: 2.0,
  maxAngvel: 1.4,        // 80°/s — sluggish wheel.
  maxSpeed: 1900,
  linearDamping: 0.2,
  angularDamping: 0,
  lateralGrip: 0.012,    // half-life ≈ 960 ms — slides like a tank around corners.
  radius: 16,
  maxHealth: 180,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 1.4`.
  ai: { thrust: 0.35, turnKp: 4.0, maxTorque: 2.1 },
  shape: {
    kind: 'polygon',
    color: 0xff7733,
    scale: 1,
    // Stubby pentagon — wide shoulders, blunt nose.
    points: [
      [0, -14],
      [12, -2],
      [10, 14],
      [-10, 14],
      [-12, -2],
    ],
  },
});

/**
 * The catalogue, frozen so a typo can't mutate it at runtime. Insertion order
 * is the canonical order — the swarm wire format encodes drone kinds as a
 * `u8` index into `SHIP_KINDS_LIST` (see `swarmWireFormat.ts`), so kinds may
 * only be **appended**. Reordering or removing entries breaks decode for any
 * snapshot persisted by an older build.
 */
// Insertion order = canonical catalogue order. Fighter is first so it
// satisfies the "default to the first ship in the list" rule and so it ends
// up at index 0 of `SHIP_KINDS_LIST` (the swarm wire format encodes drones'
// kinds as a u8 index into this list — appending new kinds is safe;
// reordering or removing entries breaks decode for older snapshots).
export const SHIP_KINDS = Object.freeze({
  fighter: FIGHTER,
  scout: SCOUT,
  heavy: HEAVY,
} as const) satisfies Readonly<Record<string, ShipKind>>;

export const SHIP_KINDS_LIST: readonly ShipKind[] = Object.freeze(Object.values(SHIP_KINDS));

export const DEFAULT_SHIP_KIND: ShipKindId = 'fighter';

/**
 * Legacy export: the previous build hard-coded `BOOST_MULTIPLIER` in
 * `src/core/physics/World.ts` and several tests imported it from there.
 * Re-exported here so those import sites keep resolving without churn while
 * Phase 2 migrates them. The new authoritative value is per-kind.
 */
export const BOOST_MULTIPLIER = FIGHTER.boostMultiplier;

/**
 * Resolve a (possibly missing or malformed) kind id to a concrete `ShipKind`.
 * Falls back to `DEFAULT_SHIP_KIND` on any unknown / invalid input — this is
 * deliberate so a legacy snapshot or a malformed wire packet can never crash
 * the spawn path.
 */
export function getShipKind(id: string | null | undefined): ShipKind {
  if (id != null && Object.prototype.hasOwnProperty.call(SHIP_KINDS, id)) {
    return (SHIP_KINDS as Record<string, ShipKind>)[id]!;
  }
  return (SHIP_KINDS as Record<string, ShipKind>)[DEFAULT_SHIP_KIND]!;
}

/** Type guard — narrows a string to `ShipKindId` if it's a known kind. */
export function isShipKindId(id: string): id is ShipKindId {
  return Object.prototype.hasOwnProperty.call(SHIP_KINDS, id);
}

/**
 * Index of a kind in `SHIP_KINDS_LIST`. Used by the swarm wire format to
 * encode a drone's kind as a `u8` byte. Returns 0 (the default kind's slot
 * if the default sits at index 0; otherwise the first kind in the list) on
 * unknown ids, so a malformed encode is decoded back to the first kind
 * rather than crashing — same forgiving stance as `getShipKind`.
 */
export function shipKindToIndex(id: ShipKindId): number {
  for (let i = 0; i < SHIP_KINDS_LIST.length; i++) {
    if (SHIP_KINDS_LIST[i]!.id === id) return i;
  }
  return 0;
}

/** Inverse of `shipKindToIndex`. Out-of-range indices fall back to default. */
export function shipKindFromIndex(index: number): ShipKindId {
  const k = SHIP_KINDS_LIST[index];
  return k ? k.id : DEFAULT_SHIP_KIND;
}
