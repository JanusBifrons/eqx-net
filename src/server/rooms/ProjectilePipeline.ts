/**
 * Server-side projectile lifecycle: spawn + per-tick sweep + cleanup.
 *
 * Owns:
 *   - `liveProjectiles: Map<projId, ProjectileRecord>` — every in-flight
 *     bolt the server is simulating.
 *   - `projectileCounter` — monotonic id generator (`proj-${n}`).
 *
 * Per-tick `advance()` Euler-integrates each projectile through one
 * step, then runs four collision passes against:
 *   1. Player ships (lag-comp via shipPoseCache; shield-vs-hull routed
 *      through the injected `playerSweep` hook to share polygon
 *      geometry with the hitscan path).
 *   2. Swarm entities (drones + asteroids — sphere-only).
 *   3. Wrecks (sphere; targetId carries the `wreck-` prefix so
 *      applyDamage routes through state.wrecks).
 *   4. Lingering hulls (sphere; targetId is the shipInstanceId so
 *      applyDamage routes through the schema map's isActive=false row).
 *
 * Earliest-entry wins. On hit: emit damage, drop the projectile.
 * On miss + alive: commit integration. On lifetime expiry: drop.
 *
 * Extracted from SectorRoom (commit 21 of v3 refactor plan; Combat
 * Architecture section of src/server/CLAUDE.md).
 */

import { projectileSweepCircle } from '../../core/combat/Weapons.js';
import { SHIP_COLLISION_RADIUS } from '../../core/combat/Weapons.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';
import type { ShipState } from './schema/SectorState.js';

export interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
  damage: number;
  radius: number;
  maxTicks: number;
  weaponId: WeaponId;
}

/** A successful projectile-sweep result. */
export interface SweepHit {
  entry: number;
  hitX: number;
  hitY: number;
}

/** Narrow view of the per-player pose cache the pipeline reads. */
export interface ShipPose {
  x: number;
  y: number;
  angle: number;
}

/** Narrow view of the swarm registry the pipeline iterates. */
export interface SwarmCandidateSource {
  all(): Iterable<{ id: string; slot: number; radius: number }>;
}

export interface ProjectilePipelineDeps {
  /** SAB Float32 view — swarm + wreck + lingering pose source. */
  sabF32: Float32Array;
  /** Current server tick (for birth-tick + lifetime check). */
  serverTick: () => number;
  /** Iterable of `[playerId, slot]` for the active-ship sweep pass. */
  playerToSlot: Iterable<[string, number]>;
  /** Active-ship resolver for the player-sweep branch. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Per-tick player pose cache (top-of-update SAB read). */
  shipPoseCache: Map<string, ShipPose>;
  /** Per-ship sweep that respects shield (cheap circle) vs hull (polygon). */
  playerSweep: (
    ship: ShipState,
    fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
    cx: number, cy: number, angle: number,
  ) => SweepHit | null;
  /** Swarm candidate source (drones + asteroids). */
  swarmRegistry: SwarmCandidateSource;
  /** Wreck bookkeeping: shipInstanceId -> slot. */
  wreckToSlot: Map<string, number>;
  /** Phase 6b lingering hulls: shipInstanceId -> slot. */
  lingeringSlots: Map<string, number>;
  /** Damage sink — invoked on a confirmed hit. */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
  ) => void;
}

const DT_SEC = 1 / 60;

export class ProjectilePipeline {
  readonly liveProjectiles = new Map<string, ProjectileRecord>();
  private projectileCounter = 0;

  constructor(private readonly deps: ProjectilePipelineDeps) {}

  /** Diagnostic — count of in-flight projectiles. */
  size(): number {
    return this.liveProjectiles.size;
  }

  /**
   * Spawn a fresh projectile. Wire-discipline P3: projectiles never
   * ride MapSchema; the per-recipient interest-filtered list is folded
   * into the snapshot in the broadcast loop.
   */
  spawn(
    ownerId: string,
    x: number, y: number,
    vx: number, vy: number,
    damage: number, radius: number, maxTicks: number,
    weaponId: WeaponId,
  ): void {
    const projId = `proj-${this.projectileCounter++}`;
    this.liveProjectiles.set(projId, {
      x, y, vx, vy, ownerId,
      birthTick: this.deps.serverTick(),
      damage, radius, maxTicks, weaponId,
    });
  }

  /**
   * Advance every in-flight projectile by one fixed tick. Hits resolve
   * to `applyDamage` and drop the projectile; non-hits commit the
   * integration; expired projectiles drop. See `src/server/CLAUDE.md`
   * "Combat Architecture" → "Projectile vs swarm collision" for the
   * 4-pass mandate (player + swarm + wreck + lingering).
   */
  advance(): void {
    const d = this.deps;
    const serverTick = d.serverTick();
    for (const [projId, proj] of this.liveProjectiles) {
      const stepX = proj.vx * DT_SEC;
      const stepY = proj.vy * DT_SEC;

      let bestEntry = Infinity;
      let bestTargetId: string | null = null;
      let bestHitX = proj.x;
      let bestHitY = proj.y;

      // 1. Player ships (shield-vs-hull via the injected playerSweep).
      for (const [targetId] of d.playerToSlot) {
        if (targetId === proj.ownerId) continue;
        const targetShip = d.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const targetPose = d.shipPoseCache.get(targetId);
        if (!targetPose) continue;
        const sweep = d.playerSweep(
          targetShip, proj.x, proj.y, stepX, stepY, proj.radius,
          targetPose.x, targetPose.y, targetPose.angle,
        );
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = targetId;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // 2. Swarm (drones + asteroids — sphere).
      for (const rec of d.swarmRegistry.all()) {
        const b = slotBase(rec.slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = rec.id;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // 3. Wrecks (sphere; targetId prefixed `wreck-` for applyDamage).
      for (const [shipInstanceId, slot] of d.wreckToSlot) {
        const b = slotBase(slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, SHIP_COLLISION_RADIUS);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = `wreck-${shipInstanceId}`;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // 4. Lingering hulls (sphere; targetId = shipInstanceId).
      for (const [shipInstanceId, slot] of d.lingeringSlots) {
        if (shipInstanceId === proj.ownerId) continue;
        const b = slotBase(slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, SHIP_COLLISION_RADIUS);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = shipInstanceId;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      if (bestTargetId !== null) {
        d.applyDamage(bestTargetId, proj.ownerId, proj.damage, bestHitX, bestHitY);
        this.liveProjectiles.delete(projId);
        continue;
      }

      // No hit — commit integration + lifetime check.
      proj.x += stepX;
      proj.y += stepY;
      if (serverTick - proj.birthTick >= proj.maxTicks) {
        this.liveProjectiles.delete(projId);
      }
    }
  }
}
