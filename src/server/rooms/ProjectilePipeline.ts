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
import { ProjectileBroadphase } from './ProjectileBroadphase.js';
import { projectileSweepCircle, projectileSweepBox } from '../../core/combat/Weapons.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { shellBlastDamage } from '../../shared-types/shellBlast.js';
import type { ShipState } from './schema/SectorState.js';
import { GLOBAL_SHIP_TUNING } from '../../shared-types/shipScale/lookup.js';
import {
  NAVAL_SHELL_WEAPON_IDS, quantiseShellSpawn, shellPoseAt,
  type ShellPoseMut, type ShellSpawnMut,
} from '../../core/combat/shellFlight.js';

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
  /** Shells as events: the quantised spawn point. Set only on an EVENT shell
   *  (naval, shell events on); its pose is then the closed form
   *  `shellPoseAt(ox, oy, vx, vy, birthTick, tick)`, never an Euler sum. */
  ox?: number;
  oy?: number;
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

/** The swarm record fields the sweep reads. */
export interface SwarmCandidate {
  id: string; slot: number; radius: number; kind?: number; shipKind?: string;
  halfW?: number; halfH?: number; boxes?: Float32Array;
}

/** Narrow view of the swarm registry the pipeline iterates. */
export interface SwarmCandidateSource {
  all(): Iterable<SwarmCandidate>;
  /** Bumped on every register/unregister (`SwarmEntityRegistry.version`).
   *  Absent ⇒ the broadphase is rebuilt after every hit in a tick. */
  readonly version?: number;
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
  /** A shell with a blast burst at (x, y): show it (plan coastal-defences).
   *  Absent ⇒ no visual (unit harnesses); the damage still lands. */
  onBlast?: (x: number, y: number, radius: number) => void;
  /** Swarm pass broadphase (default on). `false` restores the full
   *  every-shell × every-entity scan — the parity oracle in tests. */
  broadphase?: boolean;
  /** Shells as events (shell-events.md; always on since slice 4): every naval
   *  shell is an EVENT shell: its spawn is quantised to wire precision, it
   *  moves to the closed-form pose at `serverTick + 1` each advance (so it
   *  follows the worker tick even when room updates and ticks drift apart),
   *  and the hooks below report its life. */
  /** An event shell was spawned (after quantising). */
  onShellSpawn?: (projId: string, rec: ProjectileRecord) => void;
  /** An event shell hit something (or a shield wall: radius 0) at `tick`. */
  onShellEnd?: (projId: string, tick: number, x: number, y: number, blastRadius: number) => void;
  /** An event shell reached the end of its flight: a silent miss. */
  onShellExpire?: (projId: string) => void;
}

export const DT_SEC = 1 / 60;

const spawnQ: ShellSpawnMut = { x: 0, y: 0, vx: 0, vy: 0 };
const poseQ: ShellPoseMut = { x: 0, y: 0 };

export class ProjectilePipeline {
  readonly liveProjectiles = new Map<string, ProjectileRecord>();
  private projectileCounter = 0;
  /** Narrow-phase sweeps (player + swarm + lingering) in the last
   *  `advance()`. A COUNT, host-independent: the broadphase's gate. */
  narrowChecks = 0;
  private readonly bp = new ProjectileBroadphase<SwarmCandidate>();
  /** The broadphase no longer matches the registry (start of tick, or a hit
   *  may have spawned / evicted entities). */
  private bpStale = true;
  private bpVersion = -1;

  constructor(private readonly deps: ProjectilePipelineDeps) {}

  /** (Re)bin every swarm entity at its current SAB pose. O(entities). */
  private rebuildBroadphase(): void {
    const d = this.deps;
    const bp = this.bp;
    bp.begin();
    for (const rec of d.swarmRegistry.all()) {
      const b = slotBase(rec.slot);
      bp.add(rec, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, d.sabF32[b + SLOT_ANGLE_OFF]!);
    }
    bp.end();
    this.bpVersion = d.swarmRegistry.version ?? -1;
    this.bpStale = false;
  }

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
    const d = this.deps;
    if (NAVAL_SHELL_WEAPON_IDS.has(weaponId)) {
      // Quantise BEFORE the first step so server and client integrate the
      // same numbers (shell-events.md §2).
      quantiseShellSpawn(x, y, vx, vy, spawnQ);
      const rec: ProjectileRecord = {
        x: spawnQ.x, y: spawnQ.y, vx: spawnQ.vx, vy: spawnQ.vy, ownerId,
        birthTick: d.serverTick(),
        damage, radius, maxTicks, weaponId,
        ox: spawnQ.x, oy: spawnQ.y,
      };
      this.liveProjectiles.set(projId, rec);
      d.onShellSpawn?.(projId, rec);
      return;
    }
    this.liveProjectiles.set(projId, {
      x, y, vx, vy, ownerId,
      birthTick: d.serverTick(),
      damage, radius, maxTicks, weaponId,
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
    const useBp = d.broadphase !== false;
    // Swarm entities moved since last tick: rebin before the first shell.
    this.bpStale = true;
    let checks = 0;
    for (const [projId, proj] of this.liveProjectiles) {
      let stepX: number;
      let stepY: number;
      const event = proj.ox !== undefined && proj.oy !== undefined;
      if (event) {
        // Event shell: sweep to the closed-form pose at serverTick + 1 (the
        // parity convention: the advance at tick S ends at S − birth + 1
        // steps). A skipped worker tick lengthens this step (no tunnelling);
        // a repeated one makes it zero.
        shellPoseAt(proj.ox!, proj.oy!, proj.vx, proj.vy, proj.birthTick, serverTick + 1, poseQ);
        stepX = poseQ.x - proj.x;
        stepY = poseQ.y - proj.y;
      } else {
        stepX = proj.vx * DT_SEC;
        stepY = proj.vy * DT_SEC;
      }

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
        checks++;
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

      // 2. Swarm (drones + asteroids + structures — sphere). The broadphase
      // hands back only entities near this step, in registry order, so the
      // first-contact winner (and its tie-break) is the full scan's.
      if (useBp) {
        const reg = d.swarmRegistry;
        if (this.bpStale || (reg.version ?? this.bpVersion) !== this.bpVersion) this.rebuildBroadphase();
        const bp = this.bp;
        bp.query(proj.x, proj.y, stepX, stepY, proj.radius);
        for (let k = 0; k < bp.outCount; k++) {
          const i = bp.out[k]!;
          const rec = bp.recs[i]!;
          if (!this.canHitSwarm(proj, rec)) continue;
          checks++;
          const sweep = this.sweepSwarm(proj, rec, stepX, stepY, bp.x[i]!, bp.y[i]!, bp.angle[i]!);
          if (sweep && sweep.entry < bestEntry) {
            bestEntry = sweep.entry;
            bestTargetId = rec.id;
            bestHitX = sweep.hitX;
            bestHitY = sweep.hitY;
          }
        }
      } else {
        for (const rec of d.swarmRegistry.all()) {
          if (!this.canHitSwarm(proj, rec)) continue;
          checks++;
          const b = slotBase(rec.slot);
          const sweep = this.sweepSwarm(proj, rec, stepX, stepY,
            d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, d.sabF32[b + SLOT_ANGLE_OFF]!);
          if (sweep && sweep.entry < bestEntry) {
            bestEntry = sweep.entry;
            bestTargetId = rec.id;
            bestHitX = sweep.hitX;
            bestHitY = sweep.hitY;
          }
        }
      }

      // 3. Lingering hulls (sphere; targetId = shipInstanceId).
      for (const [shipInstanceId, slot] of d.lingeringSlots) {
        if (shipInstanceId === proj.ownerId) continue;
        const b = slotBase(slot);
        const cx = d.sabF32[b + SLOT_X_OFF]!;
        const cy = d.sabF32[b + SLOT_Y_OFF]!;
        checks++;
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
        const blastR = this.blast(proj, bestHitX, bestHitY, bestTargetId);
        this.liveProjectiles.delete(projId);
        if (event) d.onShellEnd?.(projId, serverTick, bestHitX, bestHitY, blastR);
        // A kill may evict / spawn swarm entities (scrap, loot). The registry
        // version catches that; a source without one is rebuilt to be safe.
        if (d.swarmRegistry.version === undefined) this.bpStale = true;
        continue;
      }

      // Shield-fence plan: no target this tick — an ACTIVE wall the step crosses
      // absorbs the bolt (target ordering is handled across ticks: a closer
      // target is hit on an earlier step before the projectile reaches the wall).
      if (d.wallBlocksProjectile?.(proj.x, proj.y, stepX, stepY, proj.damage)) {
        this.liveProjectiles.delete(projId);
        // The wall stopped it somewhere on this step; the shell's pose at the
        // step start is the nearest known point (a hit with no blast).
        if (event) d.onShellEnd?.(projId, serverTick, proj.x, proj.y, 0);
        continue;
      }

      // No hit — commit integration + lifetime check.
      proj.x += stepX;
      proj.y += stepY;
      if (serverTick - proj.birthTick >= proj.maxTicks) {
        // A miss just ends: shells explode only on what they hit (no burst,
        // no splash at the end of the flight).
        this.liveProjectiles.delete(projId);
        if (event) d.onShellExpire?.(projId);
      }
    }
    this.narrowChecks = checks;
  }

  /** The swarm skip rule (never the shooter itself), shared by both scans. */
  private canHitSwarm(proj: ProjectileRecord, rec: SwarmCandidate): boolean {
    // WS-8 — a structure-fired bolt (ownerId = pstruct-) must not detonate on
    // the FIRING turret (a kind-2 swarm entity at the spawn point). Mirrors
    // the lingering-hull owner skip below. Sibling structures in the line of
    // fire are still hit (realistic — place defence turrets at the perimeter).
    if (rec.id === proj.ownerId) return false;
    // Friendly fire (owner decision 2026-11-10): no allegiance filter. A
    // bolt hits the first thing in its path, its own side included.
    return true;
  }

  /** Narrow phase vs one swarm entity at (cx, cy, angle). */
  private sweepSwarm(
    proj: ProjectileRecord, rec: SwarmCandidate, stepX: number, stepY: number,
    cx: number, cy: number, angle: number,
  ): SweepHit | null {
    return rec.halfW !== undefined && rec.halfH !== undefined
      ? projectileSweepBox(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.halfW, rec.halfH, rec.boxes)
      : rec.kind === 1
        // A capital's circle is half its hull's length: refine to the hull (#15).
        ? refineSweepHit(rec.shipKind, projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius), proj.x, proj.y, stepX, stepY, cx, cy, angle)
        : projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius);
  }

  /**
   * Burst a blast shell at (x, y): every ship, drone, structure and lingering
   * hull within the blast — except the firer and the target the shell struck
   * directly (it already took the full hit) — takes `shellBlastDamage` by its
   * distance from the centre, measured to its edge. No-op for a plain shell.
   * Rare (one siege shell every two minutes), so a plain scan is fine.
   * Returns the blast radius (0 for a plain shell).
   */
  private blast(proj: ProjectileRecord, x: number, y: number, directId: string | null): number {
    const w = getWeapon(proj.weaponId);
    const splash = w.mode === 'projectile' ? w.splash : undefined;
    if (splash === undefined) return 0;
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
      const b = slotBase(rec.slot);
      const r = rec.halfW !== undefined && rec.halfH !== undefined ? Math.min(rec.halfW, rec.halfH) : rec.radius;
      hurt(rec.id, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, r);
    }
    for (const [shipInstanceId, slot] of d.lingeringSlots) {
      const b = slotBase(slot);
      hurt(shipInstanceId, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, GLOBAL_SHIP_TUNING.hitRadius);
    }
    d.onBlast?.(x, y, R);
    return R;
  }
}
