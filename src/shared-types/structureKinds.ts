/**
 * Structure-kind catalogue — the single source of truth for placeable
 * power-grid structures (speed-dial-resource-structures plan, Phase 2).
 *
 * Modelled on the flash game *The Space Game* and the user's `eqx-peri` repo:
 * the player places structures, links them through hubs (Connectors / the
 * Capital), and a 1 Hz pulse moves power + minerals around the web. This file
 * is the structure analogue of [shipKinds.ts](./shipKinds.ts).
 *
 * Read by:
 *   - `src/server/structures/*` (placement validation, the grid pulse).
 *   - `src/server/net/BinarySwarmBroadcast.ts` (encodes a structure's subtype
 *     as the shared `shipKind` u8 byte when the pose-core `kind` is 2).
 *   - `src/client/net/BinarySwarmDecoder.ts` (decodes that byte back to an id).
 *   - `src/client/render/*` (silhouette + tint per subtype).
 *   - `src/client/structures/*` (the blueprint ghost + Build speed-dial menu).
 *
 * **Invariant #11 (append-only).** `STRUCTURE_KINDS_LIST` order is part of the
 * binary swarm wire format — a structure's subtype encodes as a `u8` index into
 * this list (sharing the `shipKind` byte that drones use). Adding a kind:
 * APPEND a record + append it to the list, and bump
 * `STRUCTURE_KIND_CATALOGUE_VERSION`. NEVER reorder or remove — that
 * invalidates the index for in-flight packets and any persisted blueprint.
 *
 * Living in `src/shared-types/` (pure TS + zod, no runtime behaviour) is what
 * lets server / core / client all read the same definitions without violating
 * the boundary invariants.
 *
 * Reference values mirror eqx-peri's `STRUCTURE_DEFINITIONS` + The Space Game
 * (see `docs/plans/speed-dial-resource-structures.md`); tune for eqx-net world
 * scale during the build. Any numeric edit MUST bump
 * `STRUCTURE_KIND_CATALOGUE_VERSION`.
 */
import { z } from 'zod';
import { WeaponMountSchema } from './shipKinds/types.js';

export const StructureKindIdSchema = z.enum([
  'capital',
  'connector',
  'solar',
  'miner',
  'turret',
  'battery',
  'shield_pylon',
]);
export type StructureKindId = z.infer<typeof StructureKindIdSchema>;

export const StructureKindSchema = z
  .object({
    /** Stable, lowercase identifier. Wire- and persistence-safe. */
    id: StructureKindIdSchema,
    displayName: z.string().min(1),
    description: z.string().default(''),

    /** Collider + sprite radius, world units. */
    radius: z.number().positive(),
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
    /** Max simultaneous grid connections. Capital 4, Connector 6, leaves 1. */
    maxConnections: z.number().int().positive(),
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

// ---------------------------------------------------------------------------
// Kind records. Values mirror eqx-peri's STRUCTURE_DEFINITIONS + The Space
// Game; see the plan's "Logistics mechanics reference" table.
// ---------------------------------------------------------------------------

/** The Core — pre-built root hub. Baseline power + the big mineral bank. */
export const CAPITAL: StructureKind = {
  id: 'capital',
  displayName: 'Capital',
  description: 'The Core. Pre-built root hub: baseline power output and the main mineral bank.',
  radius: 80,
  maxHealth: 5000,
  maxConnections: 4,
  isHub: true,
  // WS-5 (R2.10) — the Capital reaches a SHORTER distance than the global 600 u
  // (= CAPITAL_CONNECTION_RANGE in src/core/structures/structureGridConstants.ts;
  // shared-types must not import core, so the literal is mirrored here).
  connectionRange: 300,
  powerOutput: 50,
  powerConsumption: 0,
  storageCapacity: 2_000_000,
  constructionCost: 0,
  color: 0xffcc44,
};

/** The Relay — a cheap, low-HP pure hub node. The linking mechanism. */
export const CONNECTOR: StructureKind = {
  id: 'connector',
  displayName: 'Connector',
  description: 'A relay. Tiny pure hub (≤6 links) that lets power + minerals flow between structures.',
  radius: 24,
  maxHealth: 200,
  maxConnections: 6,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 80,
  color: 0x66ccff,
};

/** Solar panel — the only power generator. A leaf node. */
export const SOLAR: StructureKind = {
  id: 'solar',
  displayName: 'Solar Panel',
  description: 'Power generator. Attaches to a hub and feeds the grid once built.',
  radius: 40,
  maxHealth: 300,
  maxConnections: 1,
  isHub: false,
  powerOutput: 30,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 120,
  color: 0xffee66,
};

/** Mining tower — drills asteroids for minerals. A leaf node. */
export const MINER: StructureKind = {
  id: 'miner',
  displayName: 'Mining Tower',
  description: 'Drills asteroids in range for minerals (power-gated). A leaf node.',
  radius: 50,
  maxHealth: 2000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 60,
  storageCapacity: 200_000,
  constructionCost: 400,
  color: 0xee8844,
  miningRate: 1000,
  miningRange: 800,
  mounts: [
    {
      id: 'drill',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 2,
      weaponId: 'laser',
    },
  ],
};

/** Defensive turret — targets hostile drones, power-gated firing. A leaf. */
export const TURRET: StructureKind = {
  id: 'turret',
  displayName: 'Turret',
  description: 'Defensive turret. Targets hostile drones in range (power-gated). A leaf node.',
  radius: 36,
  maxHealth: 600,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 15,
  storageCapacity: 0,
  constructionCost: 300,
  color: 0xff5555,
  weaponRange: 600,
  fireRateMs: 600,
  weaponDamage: 20,
  mounts: [
    {
      id: 'barrel',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
  ],
};

/** Battery — stored-power buffer. A leaf node that produces/consumes no power
 *  itself; it charges from a powered grid's surplus and discharges to keep its
 *  component running through a deficit (turrets/miners/shield-walls draw on it
 *  when generation dips). The shield-wall damage model drains it first. */
export const BATTERY: StructureKind = {
  id: 'battery',
  displayName: 'Battery',
  description:
    'Stores surplus power and discharges to keep the grid running through a deficit. A leaf node.',
  radius: 40,
  maxHealth: 800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 600,
  color: 0xcc8844,
  powerStorageCapacity: 300,
};

/** Shield Pylon — pairs with another pylon to project a blocking shield wall in
 *  the span between them (the wall itself is a derived collider, NOT a catalogue
 *  kind). A HUB (so two pylons may connect directly under the hub rule), it draws
 *  power while it stands; the wall stuns when the grid browns out under fire.
 *  Hull-only — the wall, not the pylon, is the "shield" (grid-power-modelled). */
export const SHIELD_PYLON: StructureKind = {
  id: 'shield_pylon',
  displayName: 'Shield Pylon',
  description:
    'Pairs with another pylon to project a blocking shield wall between them. A powered hub.',
  radius: 30,
  maxHealth: 800,
  maxConnections: 3,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 20,
  storageCapacity: 0,
  constructionCost: 500,
  color: 0x4488ff,
};

/**
 * Canonical catalogue order = wire subtype-byte index. APPEND-ONLY (invariant
 * #11). The structure subtype rides the shared `shipKind` u8 in the binary
 * swarm wire when the pose-core `kind` byte is 2 — reordering breaks decode for
 * in-flight packets and persisted blueprints.
 */
export const STRUCTURE_KINDS_LIST: readonly StructureKind[] = Object.freeze([
  CAPITAL,
  CONNECTOR,
  SOLAR,
  MINER,
  TURRET,
  BATTERY,
  SHIELD_PYLON,
]);

/** Id-keyed lookup, derived from the canonical list (the list is the source of
 *  truth for wire order; this object is a convenience for id-based lookup).
 *  Both agree by construction; the golden test snapshots both. */
export const STRUCTURE_KINDS: Record<StructureKindId, StructureKind> = Object.freeze(
  Object.fromEntries(STRUCTURE_KINDS_LIST.map((k) => [k.id, k])) as Record<
    StructureKindId,
    StructureKind
  >,
);

/** Bump on every catalogue edit (add a kind OR change any numeric field).
 *  3→4 (WS-5): added `CAPITAL.connectionRange = 300` (R2.10). */
export const STRUCTURE_KIND_CATALOGUE_VERSION = 4;

/** The pre-built anchor every base starts from. */
export const DEFAULT_STRUCTURE_KIND: StructureKindId = 'capital';

/** Resolve a kind's record. Forgiving: unknown ids fall back to the Capital,
 *  matching `getShipKind`'s stance so a malformed id never crashes. */
export function getStructureKind(id: string | null | undefined): StructureKind {
  if (id != null && Object.prototype.hasOwnProperty.call(STRUCTURE_KINDS, id)) {
    return STRUCTURE_KINDS[id as StructureKindId];
  }
  return STRUCTURE_KINDS[DEFAULT_STRUCTURE_KIND];
}

/** Type guard — narrows a string to `StructureKindId`. */
export function isStructureKindId(id: string): id is StructureKindId {
  return Object.prototype.hasOwnProperty.call(STRUCTURE_KINDS, id);
}

/** Index in `STRUCTURE_KINDS_LIST` — the wire subtype byte. Unknown ids → 0
 *  (the Capital), the same forgiving stance as `shipKindToIndex`. */
export function structureKindToIndex(id: StructureKindId): number {
  for (let i = 0; i < STRUCTURE_KINDS_LIST.length; i++) {
    if (STRUCTURE_KINDS_LIST[i]!.id === id) return i;
  }
  return 0;
}

/** Inverse of `structureKindToIndex`. Out-of-range indices fall back to the
 *  Capital. */
export function structureKindFromIndex(index: number): StructureKindId {
  const k = STRUCTURE_KINDS_LIST[index];
  return k ? k.id : DEFAULT_STRUCTURE_KIND;
}

// ── Unified entity hull (unified-hull plan) ────────────────────────────────
// A structure's FORM is a regular N-gon. This side-count is the single piece
// of shape data; `structureHullPoints` turns it into the point-set that drives
// BOTH the rendered silhouette (`buildStructureGfx`) AND the polygon collision
// hull (server `SwarmSpawner.spawnStructure` + client `structureClientLeaf`) —
// so render == collider, and the ball collider + the renderer's old procedural
// generation are both retired. Hubs read many-sided; leaves simpler.
export const STRUCTURE_SIDES: Record<StructureKindId, number> = {
  capital: 8,
  connector: 6,
  solar: 4,
  miner: 5,
  turret: 3,
  battery: 4, // boxy like the solar, distinguished by its amber tint
  shield_pylon: 7, // a distinct heptagon; the wall span between a pair is the star
};

/**
 * The structure's hull POINTS — a regular N-gon at `radius`, first vertex at
 * the top (−y, Pixi-up) going clockwise (identical to the renderer's former
 * inline generation, so the silhouette is unchanged). SINGLE SOURCE for the
 * rendered shape AND the polygon collider. Regular polygons are symmetric, so
 * the Pixi-up authoring is invariant under the renderer's Y-flip and under
 * convex-hull collider construction (vertex order doesn't matter) — render and
 * collider coincide with no per-frame work (called once at sprite-create /
 * entity-spawn, never in a hot loop). Unknown id ⇒ the Capital's silhouette,
 * the same forgiving stance as `getStructureKind`.
 */
export function structureHullPoints(
  kindId: string | null | undefined,
  radius: number,
): Array<{ x: number; y: number }> {
  const id = kindId != null && isStructureKindId(kindId) ? kindId : DEFAULT_STRUCTURE_KIND;
  const sides = STRUCTURE_SIDES[id];
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return out;
}
