/**
 * Structure-kind catalogue — schemas and types. Split out from the monolithic
 * `structureKinds.ts` (now a barrel), the same way as `../shipKinds/types.ts`.
 */
import { z } from 'zod';
import { WeaponMountSchema } from '../shipKinds/types.js';

export const StructureKindIdSchema = z.enum([
  'capital',
  'connector',
  'solar',
  'miner',
  'turret',
  'battery',
  'shield_pylon',
  // WS-8 (R2.15) — two new defence turrets. APPEND-ONLY (wire subtype index).
  'laser_bolt_turret',
  'missile_turret',
  'cargo_bay', // Living World P1a-2 — APPEND ONLY
  // Gates (plan soft-leaping-truffle v2, phase V follow-up) — APPEND ONLY.
  'shield_gate',
  'shield_airlock',
  // Production chains (plan soft-leaping-truffle v3, P2a) — APPEND ONLY.
  'gas_collector',
  'reclaimer',
  'smelter',
  'refinery',
  'silicon_works',
  'hydroponics',
  'fabricator',
  'munitions_works',
  'freight_dock',
  'deep_core_rig',
  'ore_processing_complex',
  'assembly_plant',
  // Economy v2 W3 (plan peppy-jumping-pinwheel) — APPEND ONLY.
  'research_lab',
  // P2d (plan soft-leaping-truffle v3) — APPEND ONLY.
  'autocannon_turret',
  // D1 consolidated kinds (plan soft-leaping-truffle v3) — APPEND ONLY.
  'reactor',
  'battery_bank',
  'storage_vault',
  // Economy v2 W5b (plan peppy-jumping-pinwheel) — APPEND ONLY.
  'shipyard',
  // D3 habitation modules (plan soft-leaping-truffle v3) — APPEND ONLY.
  'habitat_module',
  'tower_module',
  // Mine Layer (plan soft-leaping-truffle v3) — APPEND ONLY.
  'mine_layer',
  'teleporter',
  'teleporter_large',
  // v4 A — the Ancients' border gates (never built by anyone) — APPEND ONLY.
  'alien_gate',
  // Wrap-up W1b — transit pads between solar-system pockets (never built) — APPEND ONLY.
  'pocket_pad',
  // Coastal defences (plan coastal-defences) — the static gun catalogue — APPEND ONLY.
  'aa_quad_40mm',
  'dp_mount_5in',
  'coastal_casemate_8in',
  'coastal_turret_11in',
  'coastal_barbette_16in',
  'coastal_lindemann',
  'siege_gun_80cm',
  // Sector control lock (galaxy-map plan) — APPEND ONLY.
  'territory_lock',
]);
export type StructureKindId = z.infer<typeof StructureKindIdSchema>;

export const StructureKindSchema = z
  .object({
    /** Stable, lowercase identifier. Wire- and persistence-safe. */
    id: StructureKindIdSchema,
    displayName: z.string().min(1),
    description: z.string().default(''),

    /** BOUNDING-CIRCLE radius (half the footprint diagonal, world units):
     *  broad checks only (interest, sprite bounds, the wire record). Collision,
     *  placement, connection range + line of sight use `footprint`. */
    radius: z.number().positive(),
    /** Rectangular footprint (world units) at rotation 0 — the collider,
     *  placement overlap, connection edge distance and line-of-sight box
     *  (phase V, plan soft-leaping-truffle v2). Rotated in 90° steps. */
    footprint: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
    /** Full hull pool (and `swarmHealth` seed once built). */
    maxHealth: z.number().positive(),

    // -- Optional shield (GENERIC per-kind ENTITY attribute) ----------------
    /** Optional shield pool. ABSENT ⇒ the kind is SHIELDLESS — hull-only:
     *  damage goes straight to hull, the collider is always the hull polygon,
     *  no shield bubble, no 0-cross / `SET_HULL_EXPOSED` swap, no aura.
     *  Shield-presence is the SAME generic mechanism ships use; a structure
     *  opts into a shield purely by setting these fields (no code change).
     *  **No structure declares a shield today** (all ships do; no structures) —
     *  resolving a structure's OWN (absent) shield is what removes the old
     *  fighter-shield borrow that corrupted the collider on break. */
    shieldMax: z.number().nonnegative().optional(),
    /** Ticks of zero-damage before shield regen begins. Only meaningful with
     *  `shieldMax`. */
    shieldRegenDelayTicks: z.number().int().nonnegative().optional(),
    /** Shield regen per tick once the delay elapses. Only with `shieldMax`. */
    shieldRegenRate: z.number().nonnegative().optional(),

    // -- Grid topology -----------------------------------------------------
    /** Max simultaneous grid connections. Capital 4, Connector 6, leaves 1;
     *  0 never joins a grid (the alien gate). */
    maxConnections: z.number().int().nonnegative(),
    /** Hub flag — at least one endpoint of EVERY connection must be a hub
     *  (Capital or Connector). Leaves (solar/miner/turret) can only attach to
     *  a hub, never to each other. This is the eqx-peri rule verbatim. */
    isHub: z.boolean(),
    /** WS-5 (R2.10) — optional per-kind max edge-to-edge connection range
     *  (world units). ABSENT ⇒ the global `CONNECTION_MAX_RANGE` (600) applies.
     *  Only the Capital overrides today (a shorter reach forces relay chaining).
     *  `Grid.canConnect` takes the `min` of both endpoints' ranges, so a short
     *  range caps every pair the kind is part of. */
    connectionRange: z.number().positive().optional(),

    // -- Power economy (all gated behind `isConstructed` at runtime) --------
    /** Power produced per pulse once built. */
    powerOutput: z.number().nonnegative(),
    /** Power consumed per pulse once built. */
    powerConsumption: z.number().nonnegative(),
    /** Mineral storage capacity. The Capital is the bank + the source the
     *  construction stream draws from; the Miner buffers locally before
     *  hauling toward the Capital. */
    storageCapacity: z.number().nonnegative(),
    /** Stored-power buffer capacity (power-units; charge/discharge measured
     *  per grid pulse, same scale as `powerOutput`/`powerConsumption`).
     *  Present only on the Battery. ABSENT ⇒ the kind cannot store power — it
     *  is a pure generator/consumer/relay. A battery charges from a powered
     *  grid's surplus and discharges to keep its component `powered` through a
     *  deficit; the shield-wall damage model drains it first. */
    powerStorageCapacity: z.number().nonnegative().optional(),
    /** Living World P1a-2 (plan peppy-jumping-pinwheel) — cargo HOLD capacity
     *  (goods weight units, `GOOD_DEFS` weights) for deposited loot. ABSENT ⇒
     *  the kind is not a storage structure. Minerals delivered to a Capital
     *  still go to its `storageCapacity` bank (they fund construction). */
    holdCapacity: z.number().nonnegative().optional(),

    // -- Construction ------------------------------------------------------
    /** Total minerals to fully build from a blueprint (drained gradually by
     *  the grid pulse — Phase 3). Capital = 0 ⇒ pre-built anchor. */
    constructionCost: z.number().nonnegative(),

    /** Render tint (0xRRGGBB). */
    color: z.number().int().nonnegative(),

    // -- Miner (Phase 4) ---------------------------------------------------
    /** Minerals extracted per pulse while powered + a target asteroid is in
     *  range. Present only on the miner. */
    miningRate: z.number().nonnegative().optional(),
    /** Asteroid-targeting range, world units. Present only on the miner. */
    miningRange: z.number().positive().optional(),
    /** Gas collected per pulse in a nebula sector (P2c). Present only on the
     *  Gas Collector. */
    gasRate: z.number().nonnegative().optional(),
    /** D1 — burns ONE unit of fuel from network storage every N pulses; its
     *  `powerOutput` counts only while fuelled. Present only on the Reactor. */
    fuelEveryPulses: z.number().int().positive().optional(),

    // -- Turret (Phase 5) --------------------------------------------------
    /** Hostile-targeting range, world units. Present only on the turret. */
    weaponRange: z.number().positive().optional(),
    /** Cooldown between shots, ms. Present only on the turret. */
    fireRateMs: z.number().positive().optional(),
    /** Damage per shot. Present only on the turret. */
    weaponDamage: z.number().positive().optional(),

    /** Aim mounts for the turret / miner — reuses the ship `WeaponMount`
     *  shape so `WeaponMountController.tickSlot` can drive them unchanged. */
    mounts: z.array(WeaponMountSchema).optional(),
  })
  .strict();
export type StructureKind = z.infer<typeof StructureKindSchema>;
