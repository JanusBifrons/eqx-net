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
 *   - 4-target sweep (other players + lingering hulls + swarm +
 *     wrecks); earliest-entry wins
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
  HitscanWeaponDef,
  ProjectileWeaponDef,
  MissileWeaponDef,
  WeaponId,
  getWeapon,
  isWeaponId,
} from '../../core/combat/WeaponCatalogue.js';
import {
  rayHitsSphere,
  rayHitsConvexPolygon,
  SHIP_COLLISION_RADIUS,
  WEAPON_COOLDOWN_TICKS,
} from '../../core/combat/Weapons.js';
import { clampFireTick } from '../../core/combat/fireTemporal.js';
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
  /** SAB Float32 view — swarm + wreck pose source. */
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
  /** Wreck bookkeeping (sphere-shootable). */
  wreckToSlot: Map<string, number>;
  /** Swarm registry (sphere / convex-hull hit candidates). */
  swarmRegistry: SwarmHitSource;
  /** Per-player slewed mount angles. */
  playerMountAngles: Map<string, Float32Array>;
  /** Resolves the active-slot mount list for a kind. */
  resolveSlotMounts: (kind: ShipKind, slotId?: string) => ReadonlyArray<WeaponMount>;
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
  /** Broadcast a laser_fired event to every client. */
  broadcast: (type: 'laser_fired', msg: LaserFiredEvent) => void;
  /** Diagnostic log sink. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /** Pino logger for the malformed-fire warning + the 1% sample line. */
  logger: Logger;
}

export class PlayerFireResolver {
  constructor(private readonly deps: PlayerFireResolverDeps) {}

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

    // Cooldown rate limit.
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < WEAPON_COOLDOWN_TICKS) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }
    d.lastFireClientTick.set(shooterId, tick);

    // Lag-comp rewind → fallback → angle anchor.
    const rewoundShooter = d.snapshotRing.getPoseAt(shooterId, effTick);
    const fallbackShooter = d.shipPoseCache.get(shooterId);
    const sx = rewoundShooter?.x ?? fallbackShooter?.x;
    const sy = rewoundShooter?.y ?? fallbackShooter?.y;
    if (sx === undefined || sy === undefined) return;
    const shooterVx = rewoundShooter?.vx ?? fallbackShooter?.vx ?? 0;
    const shooterVy = rewoundShooter?.vy ?? fallbackShooter?.vy ?? 0;
    const shipAngleAtFireTick = rewoundShooter?.angle ?? fallbackShooter?.angle ?? dirAngle;

    const shipKind = getShipKind(ship.kind);
    const slotMounts = d.resolveSlotMounts(shipKind, slotId);
    if (slotMounts.length === 0) return;

    const weaponId: WeaponId = isWeaponId(weapon) ? weapon : 'hitscan';
    const weaponDef = getWeapon(weaponId);

    // Per-mount fire result accumulator.
    let bestHitId: string | null = null;
    let bestHitDist = Infinity;
    let bestHitIsObstacle = false;
    let bestHitX = 0;
    let bestHitY = 0;
    let bestHitDamage = 0;
    let bestHitWireId: string | undefined;

    const playerAngles = d.playerMountAngles.get(shooterId);
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
      const mountWorld = d.mountWorldOrigin(sx, sy, shipAngleAtFireTick, mount);
      const currentMountAngle = playerAngles?.[mIdx] ?? 0;
      const mountFireAngle = shipAngleAtFireTick + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * 20;
      const rayFromY = mountWorld.y + ndy * 20;

      d.serverLogEvent('fire_received', {
        shooterId,
        mountId: mount.id,
        clientTick: tick,
        serverTick,
        tickDelta: serverTick - tick,
        effTick,
        weapon,
        rewoundFromRing: rewoundShooter != null,
        shooter: { x: parseFloat(sx.toFixed(3)), y: parseFloat(sy.toFixed(3)) },
        ray: {
          fromX: parseFloat(rayFromX.toFixed(3)),
          fromY: parseFloat(rayFromY.toFixed(3)),
          dirX: parseFloat(ndx.toFixed(4)),
          dirY: parseFloat(ndy.toFixed(4)),
        },
      });

      if (weaponDef.mode === 'projectile') {
        const projDef = weaponDef as ProjectileWeaponDef;
        d.spawnServerProjectile(
          shooterId,
          rayFromX, rayFromY,
          shooterVx + ndx * projDef.speed,
          shooterVy + ndy * projDef.speed,
          projDef.damage, projDef.radius, projDef.maxTicks,
          weaponId,
        );
        continue;
      }

      if (weaponDef.mode === 'missile') {
        // Missile: lock-at-launch happens inside MissileSimulation; the
        // spawn returns false (and we skip broadcasting laser_fired) when
        // the pool is exhausted. No hit-resolution at fire-time — the
        // simulation owns the lifecycle and emits missile_fired /
        // missile_detonated.
        d.spawnServerMissile(
          shooterId,
          rayFromX, rayFromY,
          ndx, ndy,
          weaponDef as MissileWeaponDef,
        );
        continue;
      }

      // Hitscan: lag-comp check against rewound positions of all other
      // ships and swarm entities for this mount's ray.
      const hitscanDef = weaponDef as HitscanWeaponDef;
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
        const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, rewound?.angle ?? fallback?.angle ?? 0);
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
        const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, lingeringPose.x, lingeringPose.y, SHIP_COLLISION_RADIUS);
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
          dist = rayHitsConvexPolygon(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, ca, rec.vertices);
        } else {
          dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, rec.radius);
        }
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = rec.id;
          mountHitIsObstacle = true;
        }
      }

      // 4. Wrecks (sphere-shootable; `wreck-` prefix routes applyDamage to state.wrecks).
      for (const [shipInstanceId, slot] of d.wreckToSlot) {
        const b = slotBase(slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, SHIP_COLLISION_RADIUS);
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = `wreck-${shipInstanceId}`;
          mountHitIsObstacle = false;
        }
      }

      // Resolve wire target id (swarm hits → `swarm-${entityId}`).
      let wireTargetId: string | undefined = mountHitId ?? undefined;
      if (mountHitId && mountHitIsObstacle) {
        const rec = d.swarmRegistry.get(mountHitId);
        if (rec) wireTargetId = `swarm-${rec.entityId}`;
      }

      if (mountHitId) {
        if (Math.random() < 0.01) {
          d.logger.info({ shooterId, mountId: mount.id, hitId: mountHitId, hitIsObstacle: mountHitIsObstacle }, 'LASER_FIRED (1% sample)');
        }
        const hitX = rayFromX + ndx * mountHitDist;
        const hitY = rayFromY + ndy * mountHitDist;
        d.applyDamage(mountHitId, shooterId, hitscanDef.damage, hitX, hitY);
        if (mountHitDist < bestHitDist) {
          bestHitDist = mountHitDist;
          bestHitId = mountHitId;
          bestHitIsObstacle = mountHitIsObstacle;
          bestHitX = hitX;
          bestHitY = hitY;
          bestHitDamage = hitscanDef.damage;
          bestHitWireId = wireTargetId;
        }
      }

      const beamEndX = rayFromX + ndx * (mountHitDist === Infinity ? hitscanDef.range : mountHitDist);
      const beamEndY = rayFromY + ndy * (mountHitDist === Infinity ? hitscanDef.range : mountHitDist);
      d.broadcast('laser_fired', {
        type: 'laser_fired',
        shooterId,
        mountId: mount.id,
        fromX: rayFromX,
        fromY: rayFromY,
        toX: beamEndX,
        toY: beamEndY,
        hit: !!mountHitId,
        targetId: wireTargetId,
      });
    }

    // Aggregate hit_ack.
    void bestHitX; void bestHitY; void bestHitIsObstacle;
    if (bestHitId) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: bestHitWireId, damage: bestHitDamage };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }
  }
}
