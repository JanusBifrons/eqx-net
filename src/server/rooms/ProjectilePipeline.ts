/**
 * Server-side projectile lifecycle: spawn + per-tick sweep + cleanup.
 *
 * Owns:
 *   - `liveProjectiles: Map<projId, ProjectileRecord>` — every in-flight
 *     bolt the server is simulating.
 *   - `projectileCounter` — monotonic id generator (`proj-${n}`).
 *
 * Per-tick `advance()` Euler-integrates each projectile through one
 * step, then runs three collision passes against:
 *   1. Player ships (lag-comp via shipPoseCache; shield-vs-hull routed
 *      through the injected `playerSweep` hook to share polygon
 *      geometry with the hitscan path).
 *   2. Swarm entities (drones + asteroids — sphere-only).
 *   3. Lingering hulls (sphere; targetId is the shipInstanceId so
 *      applyDamage routes through the schema map's isActive=false row).
 *
 * Earliest-entry wins. On hit: emit damage, drop the projectile.
 * On miss + alive: commit integration. On lifetime expiry: drop.
 *
 * A shell whose weapon has a `splash` (the 80 cm siege gun, plan
 * coastal-defences) also bursts where it HITS: everything else within the
 * blast takes `shellBlastDamage`, and `onBlast` shows it. A shell that hits
 * nothing ends silently at the end of its flight — no burst, no splash
 * (owner, 2026-11-10: "hit anything in-between if it's there, but only
 * explode on target"). The client agrees: `NavalShellBursts` lets a shell
 * that ran its full range fade (lock: `tests/unit/navalShellMissParity.test.ts`).
 *
 * Extracted from SectorRoom (commit 21 of v3 refactor plan; Combat
 * Architecture section of src/server/CLAUDE.md).
 */

import { refineSweepHit } from '../../core/combat/capitalHits.js';
import { projectileSweepCircle, projectileSweepBox } from '../../core/combat/Weapons.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { shellBlastDamage } from '../../shared-types/shellBlast.js';
import { allegianceOfKind } from '../../shared-types/shipKinds.js';
import type { ShipState } from './schema/SectorState.js';
import { GLOBAL_SHIP_TUNING } from '../../shared-types/shipScale/lookup.js';

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
  /** Allegiances P0 — the firing NPC's allegiance (resolved once at spawn), or
   *  undefined for a player / structure shooter. A bolt passes THROUGH swarm
   *  combatants of the same allegiance (no friendly fire between AI allies). */
  ownerAllegiance?: string;
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
  all(): Iterable<{ id: string; slot: number; radius: number; kind?: number; shipKind?: string; halfW?: number; halfH?: number; boxes?: Float32Array }>;
}

export interface ProjectilePipelineDeps {
  /** SAB Float32 view — swarm + lingering pose source. */
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
  /** Shield-fence plan — if this tick's step crosses an ACTIVE shield wall,
   *  absorb the projectile (apply the wall's grid-power damage) and return true
   *  so it's dropped. Absent ⇒ no walls (byte-identical). Alloc-free. */
  wallBlocksProjectile?: (
    x: number, y: number, stepX: number, stepY: number, damage: number,
  ) => boolean;
  /** Allegiances P0 — the allegiance of an NPC (kind-1 swarm) shooter, or
   *  undefined for a player / structure owner. Called once per SPAWN (fire is
   *  low-frequency), never per tick. Absent ⇒ no friendly-fire filter. */
  ownerAllegianceOf?: (ownerId: string) => string | undefined;
  /** A shell with a blast burst at (x, y): show it (plan coastal-defences).
   *  Absent ⇒ no visual (unit harnesses); the damage still lands. */
  onBlast?: (x: number, y: number, radius: number) => void;
}

export const DT_SEC = 1 / 60;

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
      ownerAllegiance: this.deps.ownerAllegianceOf?.(ownerId),
    });
  }

  /**
   * Advance every in-flight projectile by one fixed tick. Hits resolve
   * to `applyDamage` and drop the projectile; non-hits commit the
   * integration; expired projectiles drop. See `src/server/CLAUDE.md`
   * "Combat Architecture" → "Projectile vs swarm collision" for the
   * 3-pass mandate (player + swarm + lingering).
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

      // 2. Swarm (drones + asteroids + structures — sphere).
      for (const rec of d.swarmRegistry.all()) {
        // WS-8 — a structure-fired bolt (ownerId = pstruct-) must not detonate on
        // the FIRING turret (a kind-2 swarm entity at the spawn point). Mirrors
        // the lingering-hull owner skip below. Sibling structures in the line of
        // fire are still hit (realistic — place defence turrets at the perimeter).
        if (rec.id === proj.ownerId) continue;
        // Allegiances P0 — an AI bolt passes through its own allegiance's
        // combatants (drones no longer shoot down fellow drones in the way).
        if (proj.ownerAllegiance !== undefined && rec.kind === 1
          && allegianceOfKind(rec.shipKind) === proj.ownerAllegiance) continue;
        const b = slotBase(rec.slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const sweep = rec.halfW !== undefined && rec.halfH !== undefined
          ? projectileSweepBox(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.halfW, rec.halfH, rec.boxes)
          : rec.kind === 1
            // A capital's circle is half its hull's length: refine to the hull (#15).
            ? refineSweepHit(rec.shipKind, projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius), proj.x, proj.y, stepX, stepY, cx, cy, d.sabF32[b + SLOT_ANGLE_OFF]!)
            : projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = rec.id;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // 3. Lingering hulls (sphere; targetId = shipInstanceId).
      for (const [shipInstanceId, slot] of d.lingeringSlots) {
        if (shipInstanceId === proj.ownerId) continue;
        const b = slotBase(slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, GLOBAL_SHIP_TUNING.hitRadius);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = shipInstanceId;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      if (bestTargetId !== null) {
        d.applyDamage(bestTargetId, proj.ownerId, proj.damage, bestHitX, bestHitY);
        this.blast(proj, bestHitX, bestHitY, bestTargetId);
        this.liveProjectiles.delete(projId);
        continue;
      }

      // Shield-fence plan: no target this tick — an ACTIVE wall the step crosses
      // absorbs the bolt (target ordering is handled across ticks: a closer
      // target is hit on an earlier step before the projectile reaches the wall).
      if (d.wallBlocksProjectile?.(proj.x, proj.y, stepX, stepY, proj.damage)) {
        this.liveProjectiles.delete(projId);
        continue;
      }

      // No hit — commit integration + lifetime check.
      proj.x += stepX;
      proj.y += stepY;
      if (serverTick - proj.birthTick >= proj.maxTicks) {
        // A miss just ends: shells explode only on what they hit (no burst,
        // no splash at the end of the flight).
        this.liveProjectiles.delete(projId);
      }
    }
  }

  /**
   * Burst a blast shell at (x, y): every ship, drone, structure and lingering
   * hull within the blast — except the firer and the target the shell struck
   * directly (it already took the full hit) — takes `shellBlastDamage` by its
   * distance from the centre, measured to its edge. No-op for a plain shell.
   * Rare (one siege shell every two minutes), so a plain scan is fine.
   */
  private blast(proj: ProjectileRecord, x: number, y: number, directId: string | null): void {
    const w = getWeapon(proj.weaponId);
    const splash = w.mode === 'projectile' ? w.splash : undefined;
    if (splash === undefined) return;
    const d = this.deps;
    const R = splash.radius;
    const hurt = (id: string, cx: number, cy: number, r: number): void => {
      if (id === proj.ownerId || id === directId) return;
      const dist = Math.max(0, Math.hypot(cx - x, cy - y) - r);
      const dmg = shellBlastDamage(proj.damage, dist, R, splash.falloffMin);
      if (dmg > 0) d.applyDamage(id, proj.ownerId, dmg, x, y);
    };
    for (const [pid] of d.playerToSlot) {
      const ship = d.getActiveShip(pid);
      if (!ship || !ship.alive) continue;
      const pose = d.shipPoseCache.get(pid);
      if (pose) hurt(pid, pose.x, pose.y, GLOBAL_SHIP_TUNING.hitRadius);
    }
    for (const rec of d.swarmRegistry.all()) {
      if (rec.kind !== 1 && rec.kind !== 2) continue; // ships and structures; rocks shrug it off
      if (proj.ownerAllegiance !== undefined && rec.kind === 1
        && allegianceOfKind(rec.shipKind) === proj.ownerAllegiance) continue;
      const b = slotBase(rec.slot);
      const r = rec.halfW !== undefined && rec.halfH !== undefined ? Math.min(rec.halfW, rec.halfH) : rec.radius;
      hurt(rec.id, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, r);
    }
    for (const [shipInstanceId, slot] of d.lingeringSlots) {
      const b = slotBase(slot);
      hurt(shipInstanceId, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, GLOBAL_SHIP_TUNING.hitRadius);
    }
    d.onBlast?.(x, y, R);
  }
}
