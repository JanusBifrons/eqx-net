import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';
import { SHIP_MAX_HEALTH } from '../../../core/combat/Weapons.js';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';
import type { StatAlloc, ActivatedMount } from '../../playerShips/PlayerShipStore.js';

// Wire-traffic invariant (network-discipline P1, see plan):
// Spatial fields (x/y/vx/vy/angle/angvel) MUST NOT live on this schema.
// Pose flows on exactly one channel — the (binary) snapshot — sourced from
// `SectorRoom.shipPoseCache` (mirrored from SAB once per update). Re-adding
// `@type('number') x` here re-introduces the duplicate broadcast that this
// refactor deleted.
export class ShipState extends Schema {
  @type('string') playerId: string = '';
  @type('float32') health: number = SHIP_MAX_HEALTH;
  @type('float32') maxHealth: number = SHIP_MAX_HEALTH;
  @type('boolean') alive: boolean = true;
  /** Ship kind id from `SHIP_KINDS` (e.g. 'scout' | 'fighter' | 'heavy').
   *  Set on join from the client's `JoinOptions.shipKind`, validated server-side
   *  via `isShipKindId`. Drives per-kind physics in the worker and per-kind
   *  silhouette + colour on the client renderer. Defaults to the catalogue
   *  default so legacy snapshots that pre-date this field remain valid. */
  @type('string') kind: string = DEFAULT_SHIP_KIND;
  /** Player display name shown above remote ships in the renderer. Populated
   *  in `SectorRoom.onJoin` from the auth profile (`displayName ?? email`).
   *  Empty string when anonymous; client falls back to a `Pilot ${id}` label.
   *  Discrete UI string — broadcast through Colyseus MapSchema diff and read
   *  by the client's `LabelManager` once per state patch. */
  @type('string') displayName: string = '';
  /** Phase 3 multi-ship roster — the `player_ships.ship_id` UUID this ship
   *  was hydrated from (or freshly created with on first spawn). Empty
   *  string in engineering rooms (no persistence) and during the brief
   *  pre-Phase-3 transition window for galaxy rooms whose Limbo entry
   *  hasn't been backfilled yet. Lets the client roster panel mark the
   *  player's currently-bound ship and the abandon endpoint reject the
   *  active ship. */
  @type('string') shipInstanceId: string = '';
  /** Phase 6a — true while a session is actively piloting this hull;
   *  false for lingering hulls (Phase 6b reserved — invariant in 6a is
   *  "every entry has isActive === true"). Drives the client's
   *  snapshot-filter (skip lingering hulls until Phase 6b enables them)
   *  and the eventual Phase 6c drone-retargeting filter. */
  @type('boolean') isActive: boolean = true;

  // -- Shield (2026-05-16, plan: clever-wombat) --------------------------
  // PLAIN instance fields, intentionally NOT @type-decorated: the
  // authoritative shield value reaches clients via discrete DamageEvent /
  // SHIELD_* bus broadcasts, NEVER the Colyseus diff (locked design
  // decision — Halo regen would otherwise stream a per-tick float on
  // every ship). Living on ShipState means they die with the ship, so no
  // separate map + cleanup path is needed. shield === 0 <=> hull exposed
  // (polygon collision). Seeded to kind.shieldMax on spawn/respawn.
  shield = 0;
  shieldLastDamageTick = 0;

  // -- Level (Phase 4 Leveling & XP, WS-B1) ------------------------------
  // PLAIN instance field, intentionally NOT @type-decorated: like shield /
  // energy, the PUBLIC level reaches clients via the per-recipient
  // SnapshotMessage.states[id].level slice (emit-when > 1), NOT the Colyseus
  // diff. Mirrored from the roster row's `level` on spawn/restore and
  // incremented in-place by the XP-award path (SHIP_DESTROYED → applyKillXp).
  // Source of truth is the roster (PlayerShipStore); this is the live mirror
  // the broadcaster reads. Defaults to 1 (a fresh, un-levelled hull).
  level = 1;

  // -- Stat allocation (Phase 4 Leveling & XP, WS-B2) --------------------
  // PLAIN instance field, intentionally NOT @type-decorated: the per-instance
  // spent stat-point allocation. Mirrored from the roster row's `statAlloc` on
  // spawn/restore + on an `apply_ship_upgrade`/`respec_ship`. The PHYSICS
  // multipliers (topSpeed/turnRate) are pushed to the worker (SET_STAT_MUL) AND
  // ride the OWN-ship snapshot slice so the client predWorld scales movement
  // identically (risk #1). The non-physics factors (hull/energy/damage/shield)
  // are read off THIS field by the server caps + fire path — `effectiveShip*`
  // (maxHull/shield/energy seed + denominators in ShieldHullRouter/tickEnergy/
  // entity_stats) and `mul.damage` in PlayerFireResolver (review must-fix #1,
  // 2026-06-20 — these were dead code before). `{}` = un-upgraded.
  statAlloc: StatAlloc = {};

  // -- Activated dynamic mounts (Phase 4 WS-B3) --------------------------
  // PLAIN instance field, intentionally NOT @type-decorated: the per-instance
  // ACTIVATED latent mount slots (`{ slotId, weaponId }[]`). Mirrored from the
  // roster row's `mounts` on spawn/restore + on an `activate_mount`. PUBLIC —
  // rides the per-recipient SnapshotMessage.states[id].mounts slice (emit-when-
  // non-empty, for active AND lingering hulls) so OTHER players see the extra
  // turrets, NOT the Colyseus diff. The per-instance fire/aim/render mount list
  // is `[...kind.mounts, ...activated]` (geometry looked up by `slotId` from the
  // catalogue, never on the wire). `[]` = no activated mounts (the default).
  mounts: ActivatedMount[] = [];

  // -- Energy (weapons/energy/AI overhaul, 2026-06-01) -------------------
  // PLAIN instance field, intentionally NOT @type-decorated: the
  // authoritative energy value reaches the OWNING client via the
  // per-recipient SnapshotMessage.states[id].energy slice (own-ship only),
  // NEVER the Colyseus diff (it changes every tick — same reason shield is
  // off the diff). Seeded to kind.energyMax on spawn/respawn. Transient like
  // shield (respawns full, never persisted ⇒ exempt from the catalogue
  // hull-drift clamp). Drained per slot-fire trigger + per boost tick;
  // regenerated every tick by SectorRoom.tickEnergy.
  energy = 0;
}

// Phase 5c: ObstacleState removed. Asteroids and drones now flow through the
// binary swarm channel (see src/server/net/BinarySwarmBroadcast.ts) which
// bypasses MapSchema entirely. This was the master plan's "binary packed
// broadcast" deliverable for scaling past ~16 entities.
//
// Wire-discipline P3 follow-on: ProjectileState removed. Live projectiles now
// flow per-recipient on the (interest-filtered) snapshot message; the
// in-memory `liveProjectiles` map in `SectorRoom` is the sole source of
// truth.

// Wrecks RETIRED (Equinox P6.3 / C3, 2026-06-15). An abandoned hull now
// shatters into SCRAP (kind 3) and leaves the world — see
// `SectorRoom.abandonShipToScrap` / `abandonLingeringHullToScrap`. The
// former `WreckState` schema + `state.wrecks` MapSchema are removed; nothing
// creates a wreck any more.

/**
 * Procedural base descriptor (plan soft-leaping-truffle). Geometry is NEVER on
 * the wire: every side regenerates it from these scalars with the shared core
 * generator. Joiners get the full map with the room state; later changes
 * (destroy bits, PR-D) arrive as schema deltas — so a late joiner always
 * reconstructs the same base (Invariant #16). The world origin is the
 * descriptor's anchor, not a moving pose (no spatial-field duplicate).
 */
export class BaseState extends Schema {
  @type('uint16') ver: number = 1;
  @type('string') archetype: string = 'warehouse';
  @type('uint32') seed: number = 0;
  @type('int32') originX: number = 0;
  @type('int32') originY: number = 0;
  @type('uint32') size: number = 0;
  /** Destroy bits, one per layout piece (u32 words). Empty = intact. */
  @type(['uint32']) dead = new ArraySchema<number>();
}

/**
 * A structure's slow-changing grid state (plan soft-leaping-truffle v2, A2).
 * Lives in ROOM STATE — sent once on join, then only changed fields as delta
 * patches — instead of riding every 20 Hz snapshot to every client (A0
 * measured that at ~79 B per structure per snapshot: 689 KB/s per client at
 * citadel scale). Keyed by the structure's swarm entityId (decimal string).
 * Quantised: hp is a 0-100 percent, flags pack the booleans. Fields have NO
 * initialisers and are assigned only when they differ from the current value
 * (or, while unset, from STRUCTURE_DEFAULTS) — so the join payload carries only
 * non-default fields and an idle base sends nothing. Unset ⇒ the default. Two-sided contract (#15): the client decodes these
 * into the same `mirror.structures` shape (`STRUCTURE_FLAG_*` are shared).
 */
export class StructureState extends Schema {
  /** Index into `SectorState.structureOwners` / `structureOwnerNames`
   *  (owners are interned once per sector: a citadel's ~400 rows share one
   *  owner, so per-row id + name strings dominated the join payload). */
  @type('uint16') ownerIdx?: number;
  /** STRUCTURE_FLAG_* bits (built / powered / deconstructing / wallActive). */
  @type('uint8') flags?: number;
  @type('uint8') hpPct?: number;
  @type('uint8') level?: number;
  @type('float32') netPower?: number;
  @type('number') minerals?: number;
  /** 0..1 while a blueprint (or upgrade) builds. */
  @type('float32') buildPct?: number;
  /** ms to completion while building (STRUCTURE_ETA_* sentinels otherwise). */
  @type('int32') etaMs?: number;
  @type('float32') deconstructPct?: number;
  @type('uint16') storedPower?: number;
  /** > 0 only for power-storage kinds. */
  @type('uint16') storedPowerMax?: number;
  /** Pylon: the other post's entityId of its (first) wall; -1 ⇒ none. */
  @type('int32') shieldWallTo?: number;
  /** Connected structures' entityIds. */
  @type(['uint16']) connTo = new ArraySchema<number>();
}

export class SectorState extends Schema {
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
  /** Structure grid state, keyed by entityId (A2 — see StructureState). */
  @type({ map: StructureState }) structures = new MapSchema<StructureState>();
  /** Interned structure owners: owner index (decimal) → playerId / owner id. */
  @type({ map: 'string' }) structureOwners = new MapSchema<string>();
  /** owner index → display name ('' ⇒ unresolved; the client shows "Unknown"). */
  @type({ map: 'string' }) structureOwnerNames = new MapSchema<string>();
  /** Procedural bases in this sector, keyed by base id. */
  @type({ map: BaseState }) bases = new MapSchema<BaseState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
