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
 * PASS-THROUGH (the capital railgun, plan beam-slices §7): a shell whose
 * weapon has a channel `killCut` is NOT dropped when its hit KILLS the
 * target (`applyDamage` returns true). It carries on along the same step at
 * full damage, never hitting the same target twice (a pooled per-shell list),
 * and ends at the first target that survives a hit, or at the end of its
 * flight. It flies through capital wreck pieces (kind 4): "the slug ignores
 * debris" (owner, 2026-11-14). Each pass-through hit is reported to
 * `onShellEnd` with `continues` set.
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

import { shipSplashRadius, shipSweepHit } from '../../core/combat/shipHitShape.js';
import { wreckSweepHit } from '../../core/destruction/wreckHits.js';
import { ProjectileBroadphase } from './ProjectileBroadphase.js';
import { isLootPod } from '../net/SwarmEntityRegistry.js';
import { projectileSweepCircle, projectileSweepBox } from '../../core/combat/Weapons.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { shotPassesThrough } from '../../core/combat/blockedLineHold.js';
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
  /** The worker tick this (non-event) projectile last stepped at; unset until
   *  its first step (treated as `birthTick - 1`). See `MAX_CATCH_UP_TICKS`. */
  lastTick?: number;
  /** Pass-through shell (its weapon's `killCut` is a channel): a kill doesn't
   *  stop it, and it ignores wreck pieces. Set at spawn. */
  pass?: true;
  /** A pass-through shell's victims so far (pooled; never hit twice). */
  hits?: string[];
}

/** Most kills one pass-through shell may make in a single step (a guard; a
 *  step is ~100 u, so a real line never reaches it). */
export const MAX_PASS_HITS_PER_STEP = 16;

/**
 * A projectile moves by the WORKER ticks that passed since its last step, not
 * one step per room update: under load the room loop can run slower than the
 * physics worker (measured ~25 Hz vs ~34 Hz on a loaded E2E host), and bolts
 * then slowed down relative to the ships (2026-11-12, `missile-frigate-homing`
 * E2E). Each update steps
 * `max(1, ticks since the last step)`, so a room that keeps pace behaves as
 * before; the swept collision covers a long step (no tunnelling). Capped so a
 * hard stall doesn't teleport anything.
 */
export const MAX_CATCH_UP_TICKS = 30;

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
  /** A ship's shield is down: hit on its hull, not its bubble. */
  shieldDown?: boolean;
  /** Capital wreck pieces (kind 4): convex parts, body-local. */
  wreckParts?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
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
  /** A lingering hull's ship state, so its sweep uses the same per-kind
   *  shield/hull shape as an active ship (`playerSweep`). Absent / undefined
   *  ⇒ the fighter-sized `hitRadius` circle (unit harnesses). */
  lingeringShip?: (shipInstanceId: string) => ShipState | undefined;
  /** Damage sink — invoked on a confirmed hit. (dirX, dirY) is the shot's
   *  direction of travel (any length) on a direct hit: a capital wreck piece
   *  it lands on is knocked along it (overkill knock-back). `weaponId` is the
   *  projectile's weapon (direct hits and splash alike). Returns true iff the
   *  hit destroyed the target (`SectorRoom.applyDamage`); a pass-through shell
   *  carries on only then. A sink returning nothing never passes through. */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
    dirX?: number,
    dirY?: number,
    weaponId?: WeaponId,
  ) => boolean | void;
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
  /** An event shell hit something (or a shield wall: radius 0) at `tick`.
   *  `continues`: a pass-through kill; the shell flies on (still live). */
  onShellEnd?: (projId: string, tick: number, x: number, y: number, blastRadius: number, continues?: boolean) => void;
  /** An event shell reached the end of its flight: a silent miss. */
  onShellExpire?: (projId: string) => void;
}

export const DT_SEC = 1 / 60;

/** Does a shell of this weapon pass through what it kills? (Its `killCut` is
 *  a channel: the capital railgun, plan beam-slices §7.) */
export function passesThrough(weaponId: WeaponId): boolean {
  return shotPassesThrough(weaponId); // one source with the blocked-line hold
}

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
  /** Pooled victim lists for pass-through shells (#14). */
  private readonly hitListPool: string[][] = [];
  /** The current step's best hit (`findHit`), reused per shell (#14). */
  private bestTargetId: string | null = null;
  private bestHitX = 0;
  private bestHitY = 0;
  private checks = 0;

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
      if (passesThrough(weaponId)) rec.pass = true;
      this.liveProjectiles.set(projId, rec);
      d.onShellSpawn?.(projId, rec);
      return;
    }
    const rec: ProjectileRecord = {
      x, y, vx, vy, ownerId,
      birthTick: d.serverTick(),
      damage, radius, maxTicks, weaponId,
    };
    if (passesThrough(weaponId)) rec.pass = true;
    this.liveProjectiles.set(projId, rec);
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
    this.checks = 0;
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
        // Elapsed worker ticks since the last step (MAX_CATCH_UP_TICKS).
        const last = proj.lastTick ?? proj.birthTick - 1;
        let n = serverTick - last;
        if (n < 1) n = 1;
        else if (n > MAX_CATCH_UP_TICKS) n = MAX_CATCH_UP_TICKS;
        if (serverTick > last) proj.lastTick = serverTick;
        stepX = proj.vx * DT_SEC * n;
        stepY = proj.vy * DT_SEC * n;
      }

      // The step's targets, earliest first. A pass-through shell that KILLS
      // its target looks again along the rest of the same step (its victims
      // excluded); anything else ends at its first hit.
      let ended = false;
      for (let pass = 0; pass < MAX_PASS_HITS_PER_STEP; pass++) {
        this.findHit(proj, stepX, stepY, useBp);
        const targetId = this.bestTargetId;
        if (targetId === null) break;
        const hitX = this.bestHitX;
        const hitY = this.bestHitY;
        const killed = d.applyDamage(targetId, proj.ownerId, proj.damage, hitX, hitY, proj.vx, proj.vy, proj.weaponId) === true;
        const blastR = this.blast(proj, hitX, hitY, targetId);
        // A kill may evict / spawn swarm entities (scrap, loot). The registry
        // version catches that; a source without one is rebuilt to be safe.
        if (d.swarmRegistry.version === undefined) this.bpStale = true;
        if (proj.pass === true && killed) {
          // Pass-through: full damage on, this victim never hit again.
          (proj.hits ??= this.hitListPool.pop() ?? []).push(targetId);
          if (event) d.onShellEnd?.(projId, serverTick, hitX, hitY, blastR, true);
          continue;
        }
        this.drop(projId, proj);
        if (event) d.onShellEnd?.(projId, serverTick, hitX, hitY, blastR);
        ended = true;
        break;
      }
      if (ended) continue;

      // Shield-fence plan: no target this tick — an ACTIVE wall the step crosses
      // absorbs the bolt (target ordering is handled across ticks: a closer
      // target is hit on an earlier step before the projectile reaches the wall).
      if (d.wallBlocksProjectile?.(proj.x, proj.y, stepX, stepY, proj.damage)) {
        this.drop(projId, proj);
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
        this.drop(projId, proj);
        if (event) d.onShellExpire?.(projId);
      }
    }
    this.narrowChecks = this.checks;
  }

  /** Remove a projectile, returning a pass-through victim list to the pool. */
  private drop(projId: string, proj: ProjectileRecord): void {
    this.liveProjectiles.delete(projId);
    const hits = proj.hits;
    if (hits !== undefined) {
      hits.length = 0;
      this.hitListPool.push(hits);
      proj.hits = undefined;
    }
  }

  /** Has pass-through shell `proj` already hit `id`? */
  private static passed(proj: ProjectileRecord, id: string): boolean {
    const hits = proj.hits;
    if (hits === undefined) return false;
    for (let i = 0; i < hits.length; i++) if (hits[i] === id) return true;
    return false;
  }

  /**
   * The earliest target `proj`'s step (stepX, stepY) meets, into
   * `bestTargetId` / `bestHitX` / `bestHitY` (null = none), in three
   * passes: player ships, swarm entities, lingering hulls. Counts narrow
   * checks into `checks`. Alloc-free.
   */
  private findHit(proj: ProjectileRecord, stepX: number, stepY: number, useBp: boolean): void {
    const d = this.deps;
    let bestEntry = Infinity;
    let bestTargetId: string | null = null;
    let bestHitX = proj.x;
    let bestHitY = proj.y;
    let checks = this.checks;

    // 1. Player ships (shield-vs-hull via the injected playerSweep).
    for (const [targetId] of d.playerToSlot) {
      if (targetId === proj.ownerId) continue;
      if (ProjectilePipeline.passed(proj, targetId)) continue;
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
      if (ProjectilePipeline.passed(proj, shipInstanceId)) continue;
      const b = slotBase(slot);
      const cx = d.sabF32[b + SLOT_X_OFF]!;
      const cy = d.sabF32[b + SLOT_Y_OFF]!;
      checks++;
      // A parked hull is the same ship it was when flown: its own size
      // (#18), not a fighter-sized circle (a parked capital let shells
      // within the aim tolerance of its centre fly straight through).
      const lship = d.lingeringShip?.(shipInstanceId);
      const sweep = lship !== undefined
        ? d.playerSweep(lship, proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, d.sabF32[b + SLOT_ANGLE_OFF]!)
        : projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, GLOBAL_SHIP_TUNING.hitRadius);
      if (sweep && sweep.entry < bestEntry) {
        bestEntry = sweep.entry;
        bestTargetId = shipInstanceId;
        bestHitX = sweep.hitX;
        bestHitY = sweep.hitY;
      }
    }
    this.bestTargetId = bestTargetId;
    this.bestHitX = bestHitX;
    this.bestHitY = bestHitY;
    this.checks = checks;
  }

  /** The swarm skip rule (never the shooter itself), shared by both scans. */
  private canHitSwarm(proj: ProjectileRecord, rec: SwarmCandidate): boolean {
    // WS-8 — a structure-fired bolt (ownerId = pstruct-) must not detonate on
    // the FIRING turret (a kind-2 swarm entity at the spawn point). Mirrors
    // the lingering-hull owner skip below. Sibling structures in the line of
    // fire are still hit (realistic — place defence turrets at the perimeter).
    if (rec.id === proj.ownerId) return false;
    // No weapon ever touches a cargo pod (owner 2026-11-17): every shot from
    // anyone passes over it, so a pod is never destroyed and never a shield.
    if (isLootPod(rec)) return false;
    // A pass-through slug ignores debris (wreck pieces) and its own victims.
    if (proj.pass === true && (rec.kind === 4 || ProjectilePipeline.passed(proj, rec.id))) return false;
    // Friendly fire (owner decision 2026-11-10): no allegiance filter. A
    // bolt hits the first thing in its path, its own side included.
    return true;
  }

  /** Narrow phase vs one swarm entity at (cx, cy, angle). */
  private sweepSwarm(
    proj: ProjectileRecord, rec: SwarmCandidate, stepX: number, stepY: number,
    cx: number, cy: number, angle: number,
  ): SweepHit | null {
    // Capital wreck pieces (kind 4, S2a) and cut-field rocks (C1b) block
    // shots: circle, then their parts.
    if (rec.kind === 4 || rec.wreckParts !== undefined) return wreckSweepHit(rec.wreckParts, rec.radius, proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, angle);
    return rec.halfW !== undefined && rec.halfH !== undefined
      ? projectileSweepBox(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.halfW, rec.halfH, rec.boxes)
      : rec.kind === 1 && rec.shipKind
        // A ship: the same shape as if a player flew it (`shipHitShape.ts`,
        // owner's rule 2026-11-13): bubble while its shield is up, hull once
        // it is down, a capital's hull either way.
        ? shipSweepHit(rec.shipKind, !rec.shieldDown, proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, angle)
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
      if (dmg > 0) d.applyDamage(id, proj.ownerId, dmg, x, y, undefined, undefined, proj.weaponId);
    };
    for (const [pid] of d.playerToSlot) {
      const ship = d.getActiveShip(pid);
      if (!ship || !ship.alive) continue;
      const pose = d.shipPoseCache.get(pid);
      // Every ship's edge is its own size (#18), player or NPC alike.
      if (pose) hurt(pid, pose.x, pose.y, shipSplashRadius(ship.kind));
    }
    for (const rec of d.swarmRegistry.all()) {
      if (rec.kind !== 1 && rec.kind !== 2) continue; // ships and structures; rocks shrug it off
      const b = slotBase(rec.slot);
      const r = rec.halfW !== undefined && rec.halfH !== undefined
        ? Math.min(rec.halfW, rec.halfH)
        : rec.kind === 1 && rec.shipKind ? shipSplashRadius(rec.shipKind) : rec.radius;
      hurt(rec.id, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, r);
    }
    for (const [shipInstanceId, slot] of d.lingeringSlots) {
      const b = slotBase(slot);
      const lship = d.lingeringShip?.(shipInstanceId);
      hurt(shipInstanceId, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!,
        lship !== undefined ? shipSplashRadius(lship.kind) : GLOBAL_SHIP_TUNING.hitRadius);
    }
    d.onBlast?.(x, y, R);
    return R;
  }
}
