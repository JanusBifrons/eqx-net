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
// Weapon mounts + slots — multi-mount/turret refactor (Phase 1, 2026-05-11).
//
// A `WeaponMount` is a physical hardpoint on the ship: local offset from the
// ship's centre, a resting (base) angle, an arc of permissible rotation, a
// rotation speed (zero = fixed mount), and a weapon (catalogue id).
//
// A `WeaponSlot` is a logical grouping of mounts. The pilot selects an
// "active slot"; only mounts in the active slot run target-pick AI, rotate
// to aim, and fire. Slots are how a ship with both a forward cannon and a
// rear turret lets the pilot choose which set is hot. The fire trigger fans
// out to every mount in the active slot in one frame (intentional misses
// included for arc-limited mounts).
//
// `WeaponId` is duplicated as a local zod enum to keep `src/shared-types/`
// self-contained. Parity with the runtime catalogue at
// `src/core/combat/WeaponCatalogue.ts` is asserted in
// `tests/unit/shipKinds.test.ts` — adding a weapon means extending both
// places, and the test fails until they agree.
// ---------------------------------------------------------------------------

/** Catalogue-id of the weapon installed in a mount. Must match a
 *  `WeaponId` from `src/core/combat/WeaponCatalogue.ts`. */
export const MountWeaponIdSchema = z.enum(['hitscan', 'laser']);

export const WeaponMountSchema = z
  .object({
    /** Unique within the ship-kind, e.g. 'forward', 'wing-l', 'rear'. */
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    /** Ship-relative offset of the mount, in entity-local units (Pixi-up:
     *  forward = -y, right = +x). The visual turret sprite is drawn here. */
    localX: z.number().finite(),
    localY: z.number().finite(),
    /** Resting angle of the barrel, ship-relative, in radians. 0 = barrel
     *  points down-+y axis (i.e. forward) by Pixi convention; π for a
     *  rear-facing mount. Final world fire direction is
     *  `ship.angle + baseAngle + currentMountAngle`. */
    baseAngle: z.number().finite(),
    /** Lower bound on rotation from `baseAngle`, radians. Equal min=max ⇒
     *  fixed mount. The legacy single-forward-mount ships set both to 0. */
    arcMin: z.number().finite(),
    /** Upper bound on rotation from `baseAngle`, radians. Must be ≥ arcMin. */
    arcMax: z.number().finite(),
    /** Maximum rotation rate, rad/s. 0 ⇒ no rotation (fixed). The TurretAi
     *  uses this to limit per-tick angle delta when slewing toward target. */
    rotationSpeed: z.number().min(0),
    /** Catalogue id of the weapon in this mount. Data-driven so a future
     *  loadout UI can swap weapons without touching ship-kind definitions. */
    weaponId: MountWeaponIdSchema,
  })
  .strict()
  .refine((m) => m.arcMax >= m.arcMin, {
    message: 'arcMax must be ≥ arcMin',
    path: ['arcMax'],
  });
export type WeaponMount = z.infer<typeof WeaponMountSchema>;

export const WeaponSlotSchema = z
  .object({
    /** Unique within the ship-kind, e.g. 'primary', 'secondary'. */
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    displayName: z.string().min(1),
    /** Ordered list of mount ids that belong to this slot. Each mount must
     *  exist on the same ship-kind, and each mount can belong to at most one
     *  slot — both invariants are enforced by `ShipKindSchema`'s top-level
     *  refinement. The ordering is the canonical fire-order (mount 0 fires
     *  first, etc.) for any future serial-fire effects; today all mounts in
     *  a slot fire on the same tick so the order is presentation-only. */
    mountIds: z.array(z.string()).min(1),
  })
  .strict();
export type WeaponSlot = z.infer<typeof WeaponSlotSchema>;

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

    // -- Shield (Halo-style outer layer, 2026-05-16) -----------------------
    /** Full shield pool. Covers the whole hull and absorbs damage; the
     *  final hit before it drops is FULLY absorbed (no spillover -- a 1 HP
     *  shield eats an arbitrarily large single hit, then is 0). Shield > 0
     *  => cheap circle collision; shield 0 => exact rendered polygon.
     *  Transient: always (re)spawns full, never persisted (only hull
     *  persists), so it is exempt from the catalogue-version hull-drift
     *  clamp despite being a numeric stat. */
    shieldMax: z.number().positive(),
    /** Ticks of zero damage (shield OR hull) before regen begins. 60 Hz,
     *  so 300 ~= 5 s (Halo-classic). Any hit resets the timer. */
    shieldRegenDelayTicks: z.number().int().positive(),
    /** Shield HP restored per tick once regen is active. Authored as
     *  shieldMax / 120 so a fully-broken shield refills in ~2 s at 60 Hz. */
    shieldRegenRate: z.number().positive(),

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

    // -- Multi-mount/turret catalogue (Phase 1, 2026-05-11) -----------------
    /** Physical weapon mounts (hardpoints) on the ship. Optional in the
     *  schema for backward compat with any external snapshot that pre-dates
     *  the multi-mount refactor, but every kind shipped in
     *  `SHIP_KINDS` carries this field — the legacy fighter/scout/heavy
     *  define a single `'forward'` mount at the origin with zero arc and
     *  zero rotation speed (behaviour-equivalent to pre-refactor combat). */
    mounts: z.array(WeaponMountSchema).optional(),
    /** Logical groupings of mounts the pilot selects between. Every mount
     *  must belong to exactly one slot. Legacy ships have a single
     *  `'primary'` slot containing their single forward mount. */
    slots: z.array(WeaponSlotSchema).optional(),
  })
  .strict()
  .superRefine((kind, ctx) => {
    // Mount + slot structural integrity. Optional-but-correlated: either
    // both fields present or both absent.
    const mounts = kind.mounts;
    const slots = kind.slots;
    if ((mounts === undefined) !== (slots === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [mounts === undefined ? 'mounts' : 'slots'],
        message: 'mounts and slots must both be present or both absent',
      });
      return;
    }
    if (mounts === undefined || slots === undefined) return;

    // Mount ids are unique within the ship-kind.
    const mountIds = new Set<string>();
    for (const m of mounts) {
      if (mountIds.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mounts'],
          message: `duplicate mount id: '${m.id}'`,
        });
        return;
      }
      mountIds.add(m.id);
    }

    // Slot ids are unique within the ship-kind.
    const slotIds = new Set<string>();
    for (const s of slots) {
      if (slotIds.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots'],
          message: `duplicate slot id: '${s.id}'`,
        });
        return;
      }
      slotIds.add(s.id);
    }

    // Every slot.mountIds entry references a known mount; every mount
    // belongs to exactly one slot.
    const mountSlotOwner = new Map<string, string>();
    for (const s of slots) {
      for (const mid of s.mountIds) {
        if (!mountIds.has(mid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['slots'],
            message: `slot '${s.id}' references unknown mount '${mid}'`,
          });
          return;
        }
        const prior = mountSlotOwner.get(mid);
        if (prior !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['slots'],
            message: `mount '${mid}' belongs to both '${prior}' and '${s.id}'`,
          });
          return;
        }
        mountSlotOwner.set(mid, s.id);
      }
    }
    for (const m of mounts) {
      if (!mountSlotOwner.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots'],
          message: `mount '${m.id}' is not assigned to any slot`,
        });
        return;
      }
    }
  });
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

/** Legacy single-mount/single-slot template — behaviour-equivalent to the
 *  pre-multi-mount-refactor combat (one fixed forward weapon firing from the
 *  ship centre). Fighter, scout, and heavy all use this shape; new
 *  multi-mount kinds (Phase 3) supply their own.
 *
 *  Each ship-kind clones this so the consumer reads a per-kind catalogue
 *  entry rather than a shared singleton — `World.spawnShip`, `MountAngleRing`,
 *  etc. allocate per-ship state by mount index, so sharing the array literal
 *  is fine, but cloning keeps the option open. */
const LEGACY_FORWARD_MOUNT: WeaponMount = Object.freeze({
  id: 'forward',
  localX: 0,
  localY: 0,
  baseAngle: 0,
  arcMin: 0,
  arcMax: 0,
  rotationSpeed: 0,
  weaponId: 'hitscan',
}) as WeaponMount;

const LEGACY_PRIMARY_SLOT: WeaponSlot = Object.freeze({
  id: 'primary',
  displayName: 'Primary',
  mountIds: Object.freeze(['forward']) as unknown as ReadonlyArray<string>,
}) as WeaponSlot;

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
  // F=3.0, boost=2 → v_boosted = 3*2 / (1-e^(-0.5/60)) = 6 / 0.00831 ≈ 722 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 3.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 3.0,        // 172°/s — twitchy.
  maxSpeed: 750,
  linearDamping: 0.5,
  angularDamping: 0,     // unused — applyInput owns angvel every tick.
  lateralGrip: 0.05,     // half-life ≈ 230 ms — quickest to bite, still drifts.
  radius: 10,
  maxHealth: 90,
  // Glass cannon: shield equals hull, standard Halo regen.
  shieldMax: 90,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 90 / 120,
  // Phase-1 agility uplift (2026-05-10): drone terminal angvel
  // = maxTorque / ANGVEL_DAMPING (1.5). To match the player's
  // `maxAngvel = 3.0` we need `maxTorque ≈ 4.5`. `turnKp` bumped from
  // 5.0 → 8.0 so the P-controller actually asks for the new headroom
  // at modest bearing errors instead of saturating only when way off.
  ai: { thrust: 0.35, turnKp: 8.0, maxTorque: 4.5 },
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
  mounts: [LEGACY_FORWARD_MOUNT],
  slots: [LEGACY_PRIMARY_SLOT],
});

const FIGHTER: ShipKind = ShipKindSchema.parse({
  id: 'fighter',
  displayName: 'Fighter',
  description: 'Balanced all-rounder. The default.',
  // d=0.3 → 55% retained after 2 s (clear glide, still slows down).
  // F=2.0, boost=2 → v_boosted = 2*2 / (1-e^(-0.3/60)) = 4 / 0.00499 ≈ 802 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 2.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.0,        // 115°/s — fine aim resolution at short taps.
  maxSpeed: 850,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.025,    // half-life ≈ 460 ms — clear drift on hard turns.
  radius: 12,
  maxHealth: 150,
  // Balanced: shield equals hull, standard Halo regen.
  shieldMax: 150,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 150 / 120,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 2.0`
  // — terminal angvel = maxTorque / 1.5, so maxTorque = 3.0.
  ai: { thrust: 0.25, turnKp: 6.0, maxTorque: 3.0 },
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
  mounts: [LEGACY_FORWARD_MOUNT],
  slots: [LEGACY_PRIMARY_SLOT],
});

const HEAVY: ShipKind = ShipKindSchema.parse({
  id: 'heavy',
  displayName: 'Heavy',
  description: 'Sluggish accel, brutal top speed, a lot of hull.',
  // d=0.2 → 67% retained after 2 s (heavy momentum, long glide).
  // F=1.5, boost=2 → v_boosted = 1.5*2 / (1-e^(-0.2/60)) = 3 / 0.00333 ≈ 901 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 1.5,
  reverseFactor: 0.4,
  boostMultiplier: 2.0,
  maxAngvel: 1.4,        // 80°/s — sluggish wheel.
  maxSpeed: 950,
  linearDamping: 0.2,
  angularDamping: 0,
  lateralGrip: 0.012,    // half-life ≈ 960 ms — slides like a tank around corners.
  radius: 16,
  maxHealth: 270,
  // Tank: deepest shield mirrors deepest hull, standard Halo regen.
  shieldMax: 270,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 270 / 120,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 1.4`.
  ai: { thrust: 0.175, turnKp: 4.0, maxTorque: 2.1 },
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
  mounts: [LEGACY_FORWARD_MOUNT],
  slots: [LEGACY_PRIMARY_SLOT],
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-mount kinds (Phase 3, 2026-05-11). These are the first ship-kinds
// that exercise the mount/slot plumbing introduced in Phases 1–2c.
//
// `interceptor` — twin wing-mounted lasers. Faster than a fighter, less hull
// than a scout, but fires two beams per cooldown so it has a higher DPS
// ceiling. The wing mounts sit at (±8, 2), which puts them at the rear of
// the wings on the polygon below. Both mounts are in one `primary` slot, so
// pressing fire emits two beams in one frame.
//
// `gunship` — fore-and-aft hitscan platform. Sluggish hull with a brutal
// rear arc: the rear mount has `baseAngle = π`, so it fires backward
// regardless of which way the ship is moving. Pilots can run from a pursuer
// while still landing hits. Both mounts share the `primary` slot so the fire
// trigger fans out to both — the player decides which to USE by orienting
// the ship.
//
// Phase 3 ships static mounts (`arcMin === arcMax === 0`, `rotationSpeed === 0`).
// Phase 4b adds rotation via WeaponMountController + MountAngleRing.
// ─────────────────────────────────────────────────────────────────────────

const INTERCEPTOR: ShipKind = ShipKindSchema.parse({
  id: 'interceptor',
  displayName: 'Interceptor',
  description: 'Twin-cannon light. Two forward beams per cooldown — high DPS, low hull.',
  // d=0.4 → 45% retained after 2 s (between fighter 0.3 and scout 0.5).
  // F=2.5, boost=2 → v_boosted = 2.5*2 / (1-e^(-0.4/60)) = 5 / 0.00664 ≈ 753 u/s.
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 2.5,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.5,        // 143°/s — quicker than fighter, less twitchy than scout.
  maxSpeed: 800,
  linearDamping: 0.4,
  angularDamping: 0,
  lateralGrip: 0.04,     // half-life ≈ 280 ms — clear drift but bites.
  radius: 11,
  maxHealth: 120,
  // Twin-cannon light: shield equals hull, standard Halo regen.
  shieldMax: 120,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 120 / 120,
  // AI tuning sized to the new maxAngvel: maxTorque = maxAngvel * 1.5 = 3.75.
  ai: { thrust: 0.3, turnKp: 7.0, maxTorque: 3.75 },
  shape: {
    kind: 'polygon',
    color: 0xb066ff,
    scale: 1,
    // Long nose, broad swept wings, narrow tail.
    points: [
      [0, -15],
      [-4, -3],
      [-12, 8],
      [-3, 10],
      [3, 10],
      [12, 8],
      [4, -3],
    ],
  },
  mounts: [
    // Wing mounts: ±30° forward arc, 4 rad/s slew. Phase 4b.1 (2026-05-11)
    // — arc and rotation declared in the catalogue; client-side tracking
    // animation lands in 4b.2, server-authoritative compute in 4b.3.
    {
      id: 'wing-l',
      localX: -8,
      localY: 2,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'hitscan',
    },
    {
      id: 'wing-r',
      localX: 8,
      localY: 2,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['wing-l', 'wing-r'] },
  ],
});

const GUNSHIP: ShipKind = ShipKindSchema.parse({
  id: 'gunship',
  displayName: 'Gunship',
  description: 'Fore-and-aft platform. Forward laser plus a backward rear gun — fire while you flee.',
  // d=0.25 → 60% retained after 2 s (between fighter 0.3 and heavy 0.2).
  // F=1.75, boost=2 → v_boosted = 1.75*2 / (1-e^(-0.25/60)) = 3.5 / 0.00415 ≈ 842 u/s.
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 1.75,
  reverseFactor: 0.4,
  boostMultiplier: 2.0,
  maxAngvel: 1.6,        // 92°/s — between fighter 2.0 and heavy 1.4.
  maxSpeed: 750,
  linearDamping: 0.25,
  angularDamping: 0,
  lateralGrip: 0.018,    // half-life ≈ 640 ms — slidy.
  radius: 14,
  maxHealth: 210,
  // Fore-and-aft platform: shield equals hull, standard Halo regen.
  shieldMax: 210,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 210 / 120,
  ai: { thrust: 0.2, turnKp: 5.0, maxTorque: 2.4 },
  shape: {
    kind: 'polygon',
    color: 0xff7722,
    scale: 1,
    // Elongated brick — long fuselage, modest wings.
    points: [
      [-3, -16],
      [3, -16],
      [10, -4],
      [10, 12],
      [-10, 12],
      [-10, -4],
    ],
  },
  mounts: [
    // Forward mount: ±45° arc, 3 rad/s slew. Slower than the interceptor's
    // dedicated wings because the gunship is the heavy chassis.
    {
      id: 'forward',
      localX: 0,
      localY: -12,        // pivot near the nose
      baseAngle: 0,       // fires forward (−y)
      arcMin: -Math.PI / 4,
      arcMax: Math.PI / 4,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
    // Rear mount: ±90° arc, 3 rad/s. Wider sweep so the rear turret can
    // cover the gunship's blind sides while the body keeps moving forward.
    {
      id: 'rear',
      localX: 0,
      localY: 10,         // pivot near the tail
      baseAngle: Math.PI, // fires backward (+y)
      arcMin: -Math.PI / 2,
      arcMax: Math.PI / 2,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['forward', 'rear'] },
  ],
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
  interceptor: INTERCEPTOR,
  gunship: GUNSHIP,
} as const) satisfies Readonly<Record<string, ShipKind>>;

export const SHIP_KINDS_LIST: readonly ShipKind[] = Object.freeze(Object.values(SHIP_KINDS));

/**
 * Catalogue stat-version. Bumped by hand whenever a kind's numerical stats
 * change (maxSpeed, maxHealth, maxAngvel, damping, grip, thrust, mount
 * positions, etc.) — anything that affects gameplay feel for a stored ship
 * picked up after a long absence.
 *
 * The kind *id* set is append-only (invariant #11), but the numbers attached
 * to each id can drift across releases. Stored `player_ships` rows record
 * the catalogue version they were saved at; on hydrate, if the version is
 * older than this constant, the per-ship `health` is clamped down to the
 * current `maxHealth` (so we never strip earned damage but never gift hull
 * above the new cap either) and other stats are read live from the
 * catalogue. See `src/server/playerShips/PlayerShipStore.ts` for the
 * hydrate path.
 *
 * Bumping rule: any PR that edits a numeric field inside `SHIP_KINDS`
 * MUST bump this value by 1 in the same PR. Mount-layout changes are not
 * auto-handled — they require a separate migration story.
 */
export const SHIP_KIND_CATALOGUE_VERSION = 3;

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
