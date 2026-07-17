/**
 * Per-player weapon-fire pipeline.
 *
 * Server-authoritative `fire` message handler. Mirrors the AI counterpart
 * (`AiFireResolver`) but adds:
 *   - zod parse + `clientShotId` plumbing
 *   - per-session cooldown ack (`hit_ack { rejected:true }`)
 *   - lag-comp rewind via `SnapshotRing.getPoseAt` (preferred) →
 *     `shipPoseCache` fallback
 *   - temporal-plausibility CLAMP (clampFireTick → effTick) — stale
 *     claims resolve against the OLDEST ring pose instead of being
 *     rejected (2026-05-19 fix; see capture `uf0o8g`)
 *   - 3-target sweep (other players + lingering hulls + swarm);
 *     earliest-entry wins
 *   - per-mount `laser_fired` broadcast PLUS the aggregate `hit_ack`
 *     for the closest mount-hit, with the WIRE id (`swarm-<entityId>`)
 *     so the client's prediction reconcile compares like-for-like
 *
 * Single-fire-path-per-side contract (Invariant #12). Composes
 * `clampFireTick` + `pickTarget`/`rotateMountToward` (via the mount
 * ticker that owns the angles map) + the pure ray helpers.
 *
 * Extracted from SectorRoom (commit 21 partial). The deps interface is
 * intentionally fat: handleFire is the densest collaboration point in
 * the server, and the seams document themselves.
 */

import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import {
  MissileWeaponDef,
  WeaponId,
  getWeapon,
  hitscanFalloffFrac,
} from '../../core/combat/WeaponCatalogue.js';
import {
  rayHitsSphere,
  rayHitsConvexPolygon,
  SHIP_COLLISION_RADIUS,
  MUZZLE_CLEARANCE,
} from '../../core/combat/Weapons.js';
import { getWeaponObject } from '../../core/combat/weapons/index.js';
import type { WeaponFireContext, WeaponFireSink } from '../../core/combat/weapons/Weapon.js';
import { clampFireTick } from '../../core/combat/fireTemporal.js';
import { canAfford, spendEnergy, resolveSlotEnergyCost } from '../../core/combat/Energy.js';
import { deriveStatMultipliers } from '../../core/leveling/shipStats.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import {
  FireMessageSchema,
  type HitAckMessage,
  type LaserFiredEvent,
} from '../../shared-types/messages.js';
import {
  getShipKind,
  type ShipKind,
  type WeaponMount,
} from '../../shared-types/shipKinds.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { WeaponId as _WeaponId } from '../../core/combat/WeaponCatalogue.js';

const LAG_COMP_WINDOW = 12;

/** Subset of SwarmEntityRecord PlayerFireResolver iterates for hits. */
export interface SwarmHitTarget {
  id: string;
  slot: number;
  kind: number;
  entityId: number;
  radius: number;
  vertices?: ReadonlyArray<Vec2> | undefined;
}

export interface SwarmHitSource {
  get(id: string): { entityId: number } | null | undefined;
  all(): Iterable<SwarmHitTarget>;
}

/** Cached per-tick player pose. */
export interface PlayerPose {
  x: number;
  y: number;
  angle: number;
}

/** Narrow snapshot-ring view for lag-comp rewind. */
export interface SnapshotRingReader {
  getPoseAt(entityId: string, tick: number): { x: number; y: number; vx: number; vy: number; angle: number } | null | undefined;
}

export interface PlayerFireResolverDeps {
  /** SAB Float32 view — swarm pose source. */
  sabF32: Float32Array;
  /** Current server tick (lag-comp window + log lines). */
  serverTick: () => number;
  /** Session → playerId binding. */
  sessionToPlayer: Map<string, string>;
  /** Resolves the active ShipState for a playerId. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Per-shooter cooldown ledger. */
  lastFireClientTick: Map<string, number>;
  /** Lag-comp pose ring. */
  snapshotRing: SnapshotRingReader;
  /** Per-tick cached player poses (fallback when ring misses). */
  shipPoseCache: Map<string, ShipPhysicsState>;
  /** Iterable of `[playerId, _]` for other-player hit search. */
  playerToSlot: Iterable<[string, number]>;
  /** Phase 6b lingering hulls — `shipInstanceId` → slot. */
  lingeringSlots: Map<string, number>;
  /** Phase 6b lingering pose mirror (no lag-comp; slow-drifting). */
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  /** Swarm registry (sphere / convex-hull hit candidates). */
  swarmRegistry: SwarmHitSource;
  /** Per-player slewed mount angles. */
  playerMountAngles: Map<string, Float32Array>;
  /** Resolves the active-slot mount list for a kind. */
  resolveSlotMounts: (kind: ShipKind, slotId?: string) => ReadonlyArray<WeaponMount>;
  /** WS-B3 — the firing ship's FULL per-instance mount list `[...kind.mounts,
   *  ...activated latent]` — the `playerMountAngles` index space (so the fire
   *  ray reads the SAME slewed angle the ticker wrote). Reads `ship.mounts`. */
  resolveInstanceMounts: (ship: ShipState) => ReadonlyArray<WeaponMount>;
  /** WS-B3 — the firing ship's FIRING mount set `[...active-slot for slotId,
   *  ...activated latent]`. Only these mounts spawn a shot; every other instance
   *  mount is in the angle array but does not fire. Reads `ship.mounts` + slotId. */
  resolveInstanceFireMounts: (ship: ShipState, slotId?: string) => ReadonlyArray<WeaponMount>;
  /** Pure mount world-origin helper. */
  mountWorldOrigin: (
    shipX: number, shipY: number, shipAngle: number, mount: WeaponMount,
  ) => { x: number; y: number };
  /** Shield-aware ray-vs-ship test (cheap circle / hull-polygon refine). */
  playerHitscanDist: (
    ship: ShipState,
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
    cx: number, cy: number, angle: number,
  ) => number | null;
  /** Spawn a server-side projectile (delegates to ProjectilePipeline). */
  spawnServerProjectile: (
    ownerId: string,
    x: number, y: number, vx: number, vy: number,
    damage: number, radius: number, maxTicks: number,
    weaponId: WeaponId,
  ) => void;
  /** Spawn a server-side missile (delegates to MissileSimulation). Returns
   *  the assigned missileId on success or `null` on pool overflow. */
  spawnServerMissile: (
    ownerId: string,
    spawnX: number, spawnY: number,
    dirX: number, dirY: number,
    def: MissileWeaponDef,
  ) => number | null;
  /** Damage sink — invoked on a confirmed hit. */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
  ) => void;
  /** Shield-fence plan — if an ACTIVE shield wall lies along the beam within
   *  `maxDist`, absorb the shot (apply the wall's grid-power damage model) and
   *  return the crossing distance; else null. Absent ⇒ no walls (byte-identical). */
  blockBeamAtWall?: (
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, damage: number,
  ) => number | null;
  /** Broadcast a laser_fired event to every client. */
  broadcast: (type: 'laser_fired', msg: LaserFiredEvent) => void;
  /** Diagnostic log sink. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /** Pino logger for the malformed-fire warning + the 1% sample line. */
  logger: Logger;
}

export class PlayerFireResolver implements WeaponFireSink {
  constructor(private readonly deps: PlayerFireResolverDeps) {}

  /** Reused per-mount fire geometry (the resolver IS the WeaponFireSink — see
   *  `src/core/combat/weapons/`). Mutated per mount; no per-fire allocation. */
  private readonly _fireCtx: WeaponFireContext = {
    fromX: 0, fromY: 0, dirX: 0, dirY: 0, shooterVx: 0, shooterVy: 0, mountId: '',
  };
  // Per-fire-event sink state — set in resolve() before the salvo, read by the
  // sink methods. resolve() is synchronous + single-threaded, so race-free.
  private _shooterId = '';
  private _effTick = 0;
  // Review must-fix #1 — the shooter's per-instance outgoing-DAMAGE multiplier
  // (`mul.damage`, derived from ship.statAlloc), set once per resolve() and
  // applied to every barrel's damage in the sink methods. ONLY player ships
  // level, so this lives in the PLAYER resolver — drone (AiFireResolver) and
  // structure/turret damage are untouched. 1 = un-upgraded (byte-identical).
  private _damageMul = 1;
  private _bestHitId: string | null = null;
  private _bestHitDist = Infinity;
  private _bestHitDamage = 0;
  private _bestHitWireId: string | undefined = undefined;

  /**
   * Handle a player's `fire` message. Drops silently on malformed
   * input (zod parse fail), missing shooter, dead shooter, or zero
   * mounts. Sends a `hit_ack { rejected:true }` on cooldown rejection
   * AND on every successful fire (hit:true with the closest mount-hit
   * OR hit:false when every mount missed; projectile fires always ack
   * hit:false — their resolution rides the snapshot's projectiles[]
   * slice).
   */
  resolve(client: Client, raw: unknown): void {
    const d = this.deps;
    const parsed = FireMessageSchema.safeParse(raw);
    if (!parsed.success) {
      d.logger.warn({ sessionId: client.sessionId }, 'malformed fire message');
      return;
    }
    const { tick, clientShotId, weapon, dirAngle, slotId } = parsed.data;

    const shooterId = d.sessionToPlayer.get(client.sessionId);
    if (!shooterId) return;

    const ship = d.getActiveShip(shooterId);
    if (!ship || !ship.alive) return;

    // Temporal CLAMP (LESSONS 2026-05-19 fix). Stale claims resolve
    // against the oldest ring pose instead of being hard-rejected.
    const serverTick = d.serverTick();
    const effTick = clampFireTick(tick, serverTick, LAG_COMP_WINDOW);

    // Resolve the active slot's mounts up-front. Weapons/energy/AI overhaul
    // (2026-06-01 §1): the server fires each mount's BOUND weapon
    // (`mount.weaponId`) and STOPS TRUSTING the client's claimed `weapon`
    // field (kept on the wire for back-compat but ignored for selection).
    const shipKind = getShipKind(ship.kind);
    // WS-B3 — the FIRING set is the active slot's mounts PLUS every activated
    // latent mount; un-upgraded ⇒ exactly the active slot (byte-identical).
    const slotMounts = d.resolveInstanceFireMounts(ship, slotId);
    if (slotMounts.length === 0) return;

    // Slot-level cooldown gate. The slot fires as ONE synchronised trigger,
    // so the whole trigger is rejected unless the slot is off cooldown — the
    // slot cooldown is the MAX over its mounts' weapons (so parallel lasers
    // never desync, and a mixed slot can't fire its fast barrel while its
    // slow barrel is still cooling). For today's single-slot ships the
    // per-shooter scalar `lastFireClientTick` IS the slot-fire tick (with one
    // slot there is no slot-switching exploit); when multi-slot ships ship,
    // track fire time per-(shooter, slotId).
    let slotCooldown = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      const c = getWeapon(slotMounts[i]!.weaponId).cooldownTicks;
      if (c > slotCooldown) slotCooldown = c;
    }
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < slotCooldown) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }

    // Energy gate (weapons/energy/AI overhaul §3.1). The slot trigger drains
    // its cost ONCE (not per mount). Reject — WITHOUT consuming the cooldown,
    // so a depleted ship keeps trying and fires the instant it can afford —
    // when the pool is short. Drain atomically on a successful gate.
    const slotEnergyCost = resolveSlotEnergyCost(shipKind, slotId);
    if (!canAfford(ship.energy, slotEnergyCost)) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }
    d.lastFireClientTick.set(shooterId, tick);
    ship.energy = spendEnergy(ship.energy, slotEnergyCost);

    // Lag-comp rewind → fallback → angle anchor.
    const rewoundShooter = d.snapshotRing.getPoseAt(shooterId, effTick);
    const fallbackShooter = d.shipPoseCache.get(shooterId);
    const sx = rewoundShooter?.x ?? fallbackShooter?.x;
    const sy = rewoundShooter?.y ?? fallbackShooter?.y;
    if (sx === undefined || sy === undefined) return;
    const shooterVx = rewoundShooter?.vx ?? fallbackShooter?.vx ?? 0;
    const shooterVy = rewoundShooter?.vy ?? fallbackShooter?.vy ?? 0;
    const shipAngleAtFireTick = rewoundShooter?.angle ?? fallbackShooter?.angle ?? dirAngle;

    // Reset the per-fire-event sink accumulator (the resolver IS the sink).
    this._shooterId = shooterId;
    this._effTick = effTick;
    // Outgoing-damage upgrade multiplier for THIS shooter (review must-fix #1).
    // deriveStatMultipliers allocates one small literal — fire is a LOW-
    // frequency discrete event (cooldown-gated), not a per-tick hot loop, so
    // invariant #14's hot-loop ban does not bite.
    this._damageMul = deriveStatMultipliers(ship.statAlloc).damage;
    this._bestHitId = null;
    this._bestHitDist = Infinity;
    this._bestHitDamage = 0;
    this._bestHitWireId = undefined;

    const playerAngles = d.playerMountAngles.get(shooterId);
    // WS-B3 — the slewed angle array is indexed by the FULL per-instance mount
    // list `[...kind.mounts, ...activated]` (what the mount ticker writes), NOT
    // the firing-set order. Resolve each firing mount's angle by its index in
    // that list so an activated latent mount reads ITS slewed angle (not a base
    // mount's). For un-upgraded single-slot ships the firing set == the instance
    // list, so this is byte-identical to the pre-WS-B3 `playerAngles[mIdx]`.
    const instanceMounts = d.resolveInstanceMounts(ship);
    const ctx = this._fireCtx;
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
      // Each barrel fires its own catalogue weapon (data-driven loadout).
      const weaponId: WeaponId = mount.weaponId;
      const mountWorld = d.mountWorldOrigin(sx, sy, shipAngleAtFireTick, mount);
      // Find this firing mount's slot in the full instance angle array by id.
      let angleIdx = mIdx;
      for (let k = 0; k < instanceMounts.length; k++) {
        if (instanceMounts[k]!.id === mount.id) { angleIdx = k; break; }
      }
      const currentMountAngle = playerAngles?.[angleIdx] ?? 0;
      const mountFireAngle = shipAngleAtFireTick + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * MUZZLE_CLEARANCE;
      const rayFromY = mountWorld.y + ndy * MUZZLE_CLEARANCE;

      d.serverLogEvent('fire_received', {
        shooterId,
        mountId: mount.id,
        clientTick: tick,
        serverTick,
        tickDelta: serverTick - tick,
        effTick,
        claimedWeapon: weapon,
        firedWeapon: weaponId,
        rewoundFromRing: rewoundShooter != null,
        shooter: { x: parseFloat(sx.toFixed(3)), y: parseFloat(sy.toFixed(3)) },
        ray: {
          fromX: parseFloat(rayFromX.toFixed(3)),
          fromY: parseFloat(rayFromY.toFixed(3)),
          dirX: parseFloat(ndx.toFixed(4)),
          dirY: parseFloat(ndy.toFixed(4)),
        },
      });

      // Per-mode fire dispatch collapses to one virtual call (GEP B3): the
      // weapon flyweight calls back the matching sink method below
      // (hitscan / spawnProjectile / spawnMissile).
      ctx.fromX = rayFromX;
      ctx.fromY = rayFromY;
      ctx.dirX = ndx;
      ctx.dirY = ndy;
      ctx.shooterVx = shooterVx;
      ctx.shooterVy = shooterVy;
      ctx.mountId = mount.id;
      getWeaponObject(weaponId).resolveFire(ctx, this);
    }

    // Aggregate hit_ack (from the sink's best-hit accumulator).
    if (this._bestHitId) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: this._bestHitWireId, damage: this._bestHitDamage };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }
  }

  // ─── WeaponFireSink — the per-mode server bodies, dispatched by the weapon
  //     flyweight; relocated VERBATIM from the former mode if-tree (GEP B3). ───

  /** Beam: the 4-pass lag-comp candidate sweep + applyDamage + laser_fired,
   *  updating the best-hit accumulator for the aggregate hit_ack. */
  hitscan(ctx: WeaponFireContext, range: number, damage: number, falloffMinDamageFrac?: number, maxRange?: number): void {
    const d = this.deps;
    // P3.13 — `range` is the OPTIMAL (full-damage) range; the ray reaches
    // `maxRange` (≥ range) and damage falls off reverse-square BEYOND optimal.
    const rayRange = maxRange ?? range;
    const rayFromX = ctx.fromX;
    const rayFromY = ctx.fromY;
    const ndx = ctx.dirX;
    const ndy = ctx.dirY;
    const effTick = this._effTick;
    const shooterId = this._shooterId;
    let mountHitId: string | null = null;
    let mountHitDist = Infinity;
    let mountHitIsObstacle = false;

    // 1. Other player ships (lag-comp via snapshot ring).
    for (const [targetId] of d.playerToSlot) {
      if (targetId === shooterId) continue;
      const targetShip = d.getActiveShip(targetId);
      if (!targetShip || !targetShip.alive) continue;
      const rewound = d.snapshotRing.getPoseAt(targetId, effTick);
      const fallback = d.shipPoseCache.get(targetId);
      const cx = rewound?.x ?? fallback?.x;
      const cy = rewound?.y ?? fallback?.y;
      if (cx === undefined || cy === undefined) continue;
      const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, rayRange, cx, cy, rewound?.angle ?? fallback?.angle ?? 0);
      if (dist !== null && dist < mountHitDist) {
        mountHitDist = dist;
        mountHitId = targetId;
        mountHitIsObstacle = false;
      }
    }

    // 2. Lingering hulls (live pose; no ring rewind).
    for (const [shipInstanceId] of d.lingeringSlots) {
      const lingeringPose = d.lingeringPoseCache.get(shipInstanceId);
      if (!lingeringPose) continue;
      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, rayRange, lingeringPose.x, lingeringPose.y, SHIP_COLLISION_RADIUS);
      if (dist !== null && dist < mountHitDist) {
        mountHitDist = dist;
        mountHitId = shipInstanceId;
        mountHitIsObstacle = false;
      }
    }

    // 3. Swarm (drones + asteroids).
    for (const rec of d.swarmRegistry.all()) {
      const rewound = d.snapshotRing.getPoseAt(rec.id, effTick);
      const b = slotBase(rec.slot);
      const cx = rewound?.x ?? d.sabF32[b + SLOT_X_OFF]!;
      const cy = rewound?.y ?? d.sabF32[b + SLOT_Y_OFF]!;
      const ca = rewound?.angle ?? d.sabF32[b + SLOT_ANGLE_OFF]!;
      let dist: number | null;
      if (rec.kind === 0 && rec.vertices) {
        dist = rayHitsConvexPolygon(rayFromX, rayFromY, ndx, ndy, rayRange, cx, cy, ca, rec.vertices);
      } else {
        dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, rayRange, cx, cy, rec.radius);
      }
      if (dist !== null && dist < mountHitDist) {
        mountHitDist = dist;
        mountHitId = rec.id;
        mountHitIsObstacle = true;
      }
    }

    // Resolve wire target id (swarm hits → `swarm-${entityId}`).
    let wireTargetId: string | undefined = mountHitId ?? undefined;
    if (mountHitId && mountHitIsObstacle) {
      const rec = d.swarmRegistry.get(mountHitId);
      if (rec) wireTargetId = `swarm-${rec.entityId}`;
    }

    // Shield-fence plan: an ACTIVE shield wall in front of the target absorbs
    // the beam (the wall takes the hit; the target behind takes nothing). Only
    // walls closer than the resolved target (or the range) count.
    const scanDist = mountHitDist === Infinity ? rayRange : mountHitDist;
    const wallDist = d.blockBeamAtWall?.(rayFromX, rayFromY, ndx, ndy, scanDist, damage) ?? null;
    const blocked = wallDist !== null;

    if (!blocked && mountHitId) {
      if (Math.random() < 0.01) {
        d.logger.info({ shooterId, mountId: ctx.mountId, hitId: mountHitId, hitIsObstacle: mountHitIsObstacle }, 'LASER_FIRED (1% sample)');
      }
      const hitX = rayFromX + ndx * mountHitDist;
      const hitY = rayFromY + ndy * mountHitDist;
      // Review must-fix #1 — scale the BASE damage by the shooter's per-instance
      // damage upgrade (player ships only; un-upgraded ⇒ ×1) BEFORE the range
      // falloff. R2.29 — reverse-square falloff over range (server-authoritative;
      // the client reads the scaled number off the DamageEvent, never predicts it).
      const upgraded = damage * this._damageMul;
      const effDamage = falloffMinDamageFrac !== undefined
        ? upgraded * hitscanFalloffFrac(mountHitDist, range, rayRange, falloffMinDamageFrac)
        : upgraded;
      d.applyDamage(mountHitId, shooterId, effDamage, hitX, hitY);
      if (mountHitDist < this._bestHitDist) {
        this._bestHitDist = mountHitDist;
        this._bestHitId = mountHitId;
        this._bestHitDamage = effDamage;
        this._bestHitWireId = wireTargetId;
      }
    }

    const endDist = blocked ? wallDist : scanDist;
    const beamEndX = rayFromX + ndx * endDist;
    const beamEndY = rayFromY + ndy * endDist;
    d.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId,
      mountId: ctx.mountId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: blocked || !!mountHitId,
      targetId: blocked ? undefined : wireTargetId,
    });
  }

  /** Bolt: spawn a server projectile (collision resolved by ProjectilePipeline). */
  spawnProjectile(
    ctx: WeaponFireContext,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    maxTicks: number,
    weaponId: WeaponId,
  ): void {
    // Review must-fix #1 — scale outgoing bolt damage by the shooter's
    // per-instance damage upgrade (player ships only; ×1 un-upgraded).
    this.deps.spawnServerProjectile(this._shooterId, ctx.fromX, ctx.fromY, vx, vy, damage * this._damageMul, radius, maxTicks, weaponId);
  }

  /** Missile: lock-at-launch + lifecycle owned by MissileSimulation. The
   *  missile's damage is baked into `def` (the catalogue WeaponDef); scale it by
   *  the shooter's damage upgrade so a player missile shot also benefits (review
   *  must-fix #1). A shallow clone keeps the catalogue record immutable. */
  spawnMissile(ctx: WeaponFireContext, def: MissileWeaponDef): void {
    const scaled = this._damageMul === 1 ? def : { ...def, damage: def.damage * this._damageMul };
    this.deps.spawnServerMissile(this._shooterId, ctx.fromX, ctx.fromY, ctx.dirX, ctx.dirY, scaled);
  }
}
