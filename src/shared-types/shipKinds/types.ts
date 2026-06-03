/**
 * Ship-kind catalogue — schemas and shared templates. Split out from
 * the monolithic `shipKinds.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 4).
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
export const MountWeaponIdSchema = z.enum(['hitscan', 'laser', 'heat-seeker']);

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
    /** Optional override for the energy drained per trigger of THIS slot.
     *  When absent, the slot cost defaults to the MAX `energyCost` of its
     *  mounts' weapons (see `resolveSlotEnergyCost`). Present only where a
     *  kind wants a per-chassis tweak — e.g. the gunship's two-barrel slot
     *  costs slightly more than a single-barrel bolt ship. (plan §3.3) */
    energyCost: z.number().nonnegative().optional(),
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
    /** Optional translational mass override. Default 1 (the historical
     *  pinned value — every legacy kind sat at mass 1 for "arcade-feel
     *  parity"). Bumping this scales how much the body resists pushes
     *  and ramming impulses; angular inertia is auto-scaled to the disc
     *  formula `0.5 * mass * radius²` so heavier ships also pivot
     *  proportionally slower under torque. Used by ships that are
     *  semantically heavy (e.g. the huge T-shaped Crossguard variant
     *  spawned in the engineering shield-test room). */
    mass: z.number().positive().optional(),
    /** Engineering-only test fixture (e.g. the scale-10 `crossguard` and
     *  `el` chassis used by smoke-test rooms). Excluded from the galaxy
     *  spawn pool — `GAMEPLAY_SHIP_KINDS_LIST` filters these out and
     *  `pickRandomShipKind` / `HunterBotPool.seed` consume that filtered
     *  list. Player ships and `JoinOption.shipKind`-driven spawns can
     *  still pick them explicitly; this only gates the *random* picker
     *  used by ambient drone seeding + Living World hunter bots.
     *  Default `false`. Added 2026-05-28 (capture ilhqk6) — engineering
     *  kinds were leaking into Sol Prime as hunter bots, producing the
     *  "square ship bigger than its shield" smoke report. */
    engineeringOnly: z.boolean().optional(),
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

    // -- Energy (weapons/energy/AI overhaul, 2026-06-01) -------------------
    /** Full energy pool. ALL weapon slot triggers AND boosting drain from
     *  this single pool; it regenerates at a steady rate every tick (no
     *  post-spend delay, unlike shield — so the bar feels alive). Like
     *  shield, energy is TRANSIENT: always (re)spawns full, never persisted,
     *  so it is exempt from the catalogue-version hull-drift clamp despite
     *  being a numeric stat. Optional in the schema for backward-compat with
     *  any external snapshot that pre-dates the energy system; every kind
     *  shipped in `SHIP_KINDS` carries it. See
     *  `docs/plans/weapons-energy-ai-overhaul.md` §3. */
    energyMax: z.number().positive().optional(),
    /** Energy restored per tick (60 Hz). Authored per-kind to hit the
     *  continuous-fire-duration targets in plan §3.3 (beams 5-10 s, bolts
     *  10-20 s on a full pool; regen extends real-world sustain). */
    energyRegenRate: z.number().positive().optional(),

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
// Legacy single-mount/single-slot template — used by fighter / scout / heavy
// (the pre-multi-mount kinds). The catalogue-version refactor (Phase 1)
// pushed every kind to declare mounts explicitly; these constants are the
// shared "single forward gun" baseline.
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
export const LEGACY_FORWARD_MOUNT: WeaponMount = Object.freeze({
  id: 'forward',
  localX: 0,
  localY: 0,
  baseAngle: 0,
  arcMin: 0,
  arcMax: 0,
  rotationSpeed: 0,
  weaponId: 'hitscan',
}) as WeaponMount;

export const LEGACY_PRIMARY_SLOT: WeaponSlot = Object.freeze({
  id: 'primary',
  displayName: 'Primary',
  mountIds: Object.freeze(['forward']) as unknown as ReadonlyArray<string>,
}) as WeaponSlot;
