/**
 * Server-side missile lifecycle: spawn + per-tick guidance + collision +
 * detonate. Lives alongside `ProjectilePipeline` but runs its own loop:
 * missiles homing-track a locked target, integrate Euler, sweep for
 * collision/proximity-fuse each tick, and on detonation emit splash damage
 * + impulse via the physics worker.
 *
 * Network/GC discipline (user-stated priorities — see plan):
 *
 *   - Pre-allocated `MissileRecord[]` pool of `POOL_CAPACITY = 256`.
 *     Free-list of integer indices; `live[]` compacts on release
 *     (swap-with-last). Zero per-tick allocation in steady state.
 *   - Overflow: `spawn()` returns `false`. Fire path treats this as a
 *     soft cooldown reject (no `missile_fired` broadcast, no SFX).
 *     `highWaterCount` is exposed for telemetry; a Pino warn is the
 *     caller's responsibility.
 *
 * Authority model:
 *
 *   - Lock-at-launch via `pickTarget` from the WeaponMountController
 *     pure module. The locked id stays SERVER-INTERNAL (never on the
 *     wire) so a client can't target-spoof.
 *   - Each tick: verify the lock still resolves; missing target → drop
 *     the lock; missile continues straight until proximity-fuse, direct
 *     hit, or lifetime expiry. **String ids are unique-on-register in
 *     `SwarmEntityRegistry`**, so dense-u16 entityId reuse cannot cause
 *     a missile to chase a freshly-spawned different entity (hostile-
 *     review #4 is moot at this layer).
 *
 * Impulse dispatch:
 *
 *   - The server main thread has NO live Rapier world (physics lives in
 *     the worker — see src/server/CLAUDE.md "Threading"). On detonate,
 *     we enqueue `{ targetId, fx, fy }` and the SectorRoom drains the
 *     queue into `postToWorker({ type: 'MISSILE_IMPULSE', ... })` each
 *     tick. The worker applies `body.applyImpulse` on the resolved
 *     Rapier body; the resulting velocity rides the existing pose
 *     broadcast.
 *
 * Bus events:
 *
 *   - `MISSILE_FIRED` / `MISSILE_DETONATED` are local-only (per-process
 *     bus). Cross-process propagation is via Colyseus `broadcast()`
 *     (`missile_fired` / `missile_detonated` zod-schema'd messages); the
 *     client re-emits them onto its own bus on receipt.
 *
 * See docs/architecture/missile-simulation.md for the full lifecycle
 * walkthrough + the Open/Closed seams for future variants.
 */

import { pickTarget, type MountTargetView } from '../../core/ai/WeaponMountController.js';
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { wrapPi } from '../../core/ai/WeaponMountController.js';
import type { MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
import type { ShipState } from './schema/SectorState.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { Bus } from '../../core/events/Bus.js';
import type {
  MissileFiredEvent,
  MissileDetonatedEvent,
} from '../../shared-types/messages/missileMessages.js';

/** Maximum simultaneous in-flight missiles per sector. 256 = ~4× the
 *  steady-state ceiling under saturation (8 frigates × 3 mounts ×
 *  cooldown-rate ~= 27 missiles/sec, lifetime 6 s → ~160 peak; 256 is
 *  cheap insurance). On overflow `spawn()` returns false; the caller
 *  treats it as a soft reject. */
const POOL_CAPACITY = 256;

const DT_SEC = 1 / 60;

/** Re-acquisition cadence for an unlocked missile (playtest 2026-06-10 Issue
 *  10). ~6 Hz at 60 Hz tick — responsive enough to chase a freshly-appeared
 *  hostile within a few hundred ms, cheap enough that the candidate scan isn't
 *  paid every tick for every dumb-flying missile. */
const MISSILE_REACQUIRE_INTERVAL_TICKS = 10;

/** Owner-skip predicate for splash query: missiles by default do not damage
 *  their owner during splash (the catalogue's `splashExcludeOwner` toggles
 *  this per-weapon). */
type SplashKind = 'ship' | 'swarm';

export interface MissileRecord {
  /** Stable id within this sector (monotonic counter). Public on the
   *  wire (`MissileFiredEvent.missileId`, `SnapshotMessage.missiles[].id`). */
  id: number;
  /** Owner shooter id. Wire form (`swarm-${entityId}` for AI shooters,
   *  playerId for players) — same as `LaserFiredEvent.shooterId`. */
  ownerId: string;
  /** Catalogue id of the weapon that spawned this missile. */
  weaponId: 'heat-seeker';
  /** Cached weapon def (read-only). Avoids per-tick map lookup. */
  weaponDef: MissileWeaponDef;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Heading (rad). Pixi-up convention: forward = -y at angle 0. */
  angle: number;
  /** SIGNED angular velocity (rad/s) for THIS tick — `(angle − prevAngle) / DT`,
   *  computed in `advance()` after guidance. Rides the missile snapshot slice so
   *  the client can integrate the homing CURVE between 20 Hz snapshots instead of
   *  dead-reckoning a straight line off `vx/vy` (WS-C #5). 0 on a dumb-flying /
   *  just-spawned missile (no turn this tick). */
  angvel: number;
  /** Locked target id (server-internal). null = dumb-mode (fly straight).
   *  Re-verified each tick; lost-lock → null without changing trajectory. */
  lockedTargetId: string | null;
  /** Whether the locked target is a ship (playerId) or swarm entity
   *  (`swarm-...` id). Determines the pose-lookup path. */
  lockedKind: SplashKind | null;
  /** Ticks remaining before lifetime detonation. Decrements each tick. */
  ticksRemaining: number;
  /** Per-owner hostility predicate, captured at launch so `advance()` can
   *  RE-ACQUIRE a lost lock onto the nearest remaining hostile (playtest
   *  2026-06-10 Issue 10). null on a free-list record. */
  isHostile: ((id: string) => boolean) | null;
  /** Pool flag — true = active; false = on free-list. */
  alive: boolean;
  /** Pool index — stable for the record's lifetime. */
  poolIndex: number;
}

/** Pose snapshot for the snapshot-broadcaster slice. */
export interface MissileSnapshotEntry {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Signed angular velocity (rad/s) for the latest tick — drives client-side
   *  curve-aware interpolation (WS-C #5). */
  angvel: number;
  ownerId: string;
  weaponId: 'heat-seeker';
  /** Remaining life as a fraction [0..1]. 0 = about to expire. */
  lifePct: number;
}

/** Pending physics impulse — drained by SectorRoom each tick and posted
 *  as a `MISSILE_IMPULSE` worker command. */
export interface PendingImpulse {
  /** Target id — playerId for players or `swarm-${entityId}` for drones.
   *  The worker resolves to a Rapier body by id (same id used in
   *  player→body and drone→body maps). */
  targetId: string;
  fx: number;
  fy: number;
}

/** Narrow view of swarmRegistry the simulation reads. `kind` is the
 *  SwarmKind enum (0 = asteroid, 1 = drone) — exposed so missile
 *  lock-on and sweep collision can skip asteroids by kind rather than
 *  by string-prefix (galaxy asteroids spawn as `asteroid-N` per
 *  `galaxy/asteroidConfigs.ts`, NOT `swarm-asteroid-N`, so any prefix-
 *  based filter is a leaky abstraction). */
interface SwarmRecLookup {
  get(id: string): { entityId: number; radius: number; kind: number } | null | undefined;
  all(): Iterable<{ id: string; slot: number; radius: number; kind: number }>;
}

export interface MissileSimulationDeps {
  /** SAB Float32 view — swarm pose source. */
  sabF32: Float32Array;
  serverTick: () => number;
  /** Iterable of `[playerId, _]` for player target candidates. */
  playerToSlot: Iterable<[string, number]>;
  getActiveShip: (playerId: string) => ShipState | undefined;
  shipPoseCache: Map<string, { x: number; y: number; vx: number; vy: number }>;
  /** Phase 6b lingering hulls (R2.22 symptom 3). `lingeringSlots` is the
   *  authoritative set of lingering hulls (`shipInstanceId` → SAB slot);
   *  `lingeringPoseCache` carries each one's live mirror pose (lazily written
   *  by `SabPoseMirror`). Missiles COLLIDE with + splash-damage lingering hulls
   *  exactly like active hulls — a fired missile must not pass through an
   *  abandoned hull. Iterate `lingeringSlots`, read the pose from the cache
   *  (skip if not yet mirrored), mirroring `PlayerFireResolver`. */
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  swarmRegistry: SwarmRecLookup;
  /** Damage sink — same one ProjectilePipeline + handleFire use. Routes
   *  through `damageRouter` to shield/hull layered application. */
  applyDamage: (
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
  ) => void;
  /** Colyseus broadcast facade. Type-narrowed at the call site. */
  broadcastFired: (msg: MissileFiredEvent) => void;
  broadcastDetonated: (msg: MissileDetonatedEvent) => void;
  /** Local per-process bus (SFX/Pino subscribers). Cross-process is
   *  handled by the broadcast* callbacks above. */
  bus: Bus;
  /** Diagnostic ring-buffer sink. Optional so pool unit tests can omit it.
   *  Production wiring: `serverLogEvent` from src/server/debug/ServerEventLog.
   *  Emits `missile_spawned` / `missile_detonated` / `missile_lock_lost`. */
  serverLogEvent?: (tag: string, data: Record<string, unknown>) => void;
}

/** Detonation cause — surfaced into `missile_detonated` diag entries so
 *  a capture can distinguish "homed onto target and hit" from "dumb-flight
 *  expired". */
export type DetonateCause = 'sweep' | 'fuse' | 'lifetime';

export class MissileSimulation {
  /** Pre-allocated record pool. Indices are stable for the record's
   *  lifetime (free-list reuses them). */
  private readonly pool: MissileRecord[];
  /** Free indices (LIFO — recently freed reused first for cache locality). */
  private readonly freeIndices: number[];
  /** Active record indices. Compacted on release (swap-with-last). */
  private readonly liveIndices: number[] = [];
  /** Monotonic per-sector id counter. u32 — practically unbounded. */
  private missileCounter = 0;
  /** Peak `liveIndices.length` observed since last reset. Telemetry. */
  private highWater = 0;
  /** Pending physics impulses drained by SectorRoom each tick. */
  private readonly pendingImpulses: PendingImpulse[] = [];

  constructor(private readonly deps: MissileSimulationDeps) {
    this.pool = new Array<MissileRecord>(POOL_CAPACITY);
    this.freeIndices = new Array<number>(POOL_CAPACITY);
    for (let i = 0; i < POOL_CAPACITY; i++) {
      this.pool[i] = this.makeBlankRecord(i);
      this.freeIndices[i] = POOL_CAPACITY - 1 - i; // pop returns 0 first
    }
  }

  private makeBlankRecord(index: number): MissileRecord {
    return {
      id: 0,
      ownerId: '',
      weaponId: 'heat-seeker',
      // Placeholder — overwritten in spawn(). The MissileWeaponDef shape
      // is constant for any given weapon id, so a per-record cache is safe.
      weaponDef: null as unknown as MissileWeaponDef,
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      lockedTargetId: null,
      lockedKind: null,
      ticksRemaining: 0,
      isHostile: null,
      alive: false,
      poolIndex: index,
    };
  }

  /** Telemetry — current in-flight count. */
  size(): number {
    return this.liveIndices.length;
  }

  /** Telemetry — peak in-flight count since last reset. */
  highWaterCount(): number {
    return this.highWater;
  }

  /** Reset the high-water mark (telemetry sampler). */
  resetHighWater(): void {
    this.highWater = this.liveIndices.length;
  }

  /**
   * Drain pending physics impulses. SectorRoom calls this each tick and
   * posts each entry as a `MISSILE_IMPULSE` worker command. Clears the
   * queue on return.
   */
  drainImpulses(): readonly PendingImpulse[] {
    if (this.pendingImpulses.length === 0) return EMPTY_IMPULSE_ARRAY;
    const copy = this.pendingImpulses.slice();
    this.pendingImpulses.length = 0;
    return copy;
  }

  /**
   * Spawn a missile. Returns the missile id on success, `null` when the
   * pool is full. Locks the target at launch via `pickTarget` over the
   * player + swarm candidate set, filtered by `isHostile`.
   *
   * `dirX`/`dirY` is the launch heading (pre-normalised by the mount-fire
   * geometry). For a heat-seeker the initial velocity is `dir * speed`;
   * lock-on adjusts course over the missile's lifetime.
   */
  spawn(
    ownerId: string,
    spawnX: number,
    spawnY: number,
    dirX: number,
    dirY: number,
    weaponDef: MissileWeaponDef,
    isHostile: (id: string) => boolean,
  ): number | null {
    const idx = this.freeIndices.pop();
    if (idx === undefined) return null; // pool exhausted

    const rec = this.pool[idx]!;
    const missileId = this.missileCounter++;
    rec.id = missileId;
    rec.ownerId = ownerId;
    rec.weaponId = weaponDef.id as 'heat-seeker';
    rec.weaponDef = weaponDef;
    rec.x = spawnX;
    rec.y = spawnY;
    const len = Math.hypot(dirX, dirY);
    const ndx = len > 1e-6 ? dirX / len : 0;
    const ndy = len > 1e-6 ? dirY / len : 1;
    rec.vx = ndx * weaponDef.speed;
    rec.vy = ndy * weaponDef.speed;
    // Pixi-up: angle 0 → forward (-y). dir=(-sin θ, cos θ) ⇒ θ = atan2(-dx, dy).
    rec.angle = Math.atan2(-ndx, ndy);
    rec.angvel = 0; // fresh missile hasn't turned yet

    // Lock-at-launch: build candidate set (players + swarm) and pickTarget.
    const lockResult = this.lockOnTarget(spawnX, spawnY, ownerId, isHostile, weaponDef);
    rec.lockedTargetId = lockResult.lock?.id ?? null;
    rec.lockedKind = lockResult.lock?.kind ?? null;
    rec.ticksRemaining = weaponDef.lifetimeTicks;
    rec.isHostile = isHostile; // for mid-flight re-acquisition (Issue 10)
    rec.alive = true;

    // Diag — surfaces the "no lock acquired" smoke-test class. When
    // `lockedTargetId` is null and `candidateCount` is non-zero, the
    // hostility filter rejected all candidates; when both are zero,
    // the sector simply had no candidates in lock range.
    this.deps.serverLogEvent?.('missile_spawned', {
      missileId,
      ownerId,
      x: spawnX,
      y: spawnY,
      dirX: ndx,
      dirY: ndy,
      lockedTargetId: rec.lockedTargetId,
      lockedKind: rec.lockedKind,
      candidateCount: lockResult.candidateCount,
      hostileCandidateCount: lockResult.hostileCandidateCount,
    });

    this.liveIndices.push(idx);
    if (this.liveIndices.length > this.highWater) {
      this.highWater = this.liveIndices.length;
    }

    // Local bus — SFX/Pino subscribers in-process only.
    this.deps.bus.emit('MISSILE_FIRED', {
      type: 'MISSILE_FIRED',
      missileId,
      ownerId,
      x: spawnX,
      y: spawnY,
      angle: rec.angle,
      weaponId: 'heat-seeker',
    });
    // Cross-process — Colyseus broadcast to clients.
    this.deps.broadcastFired({
      type: 'missile_fired',
      missileId,
      ownerId,
      x: spawnX,
      y: spawnY,
      angle: rec.angle,
      weaponId: 'heat-seeker',
    });

    return missileId;
  }

  /**
   * Advance every in-flight missile by one fixed tick. Lock-verify →
   * proximity-fuse → guide → integrate → sweep → lifetime → release.
   */
  advance(): void {
    // Iterate by index so we can swap-pop releases without restarting.
    let i = 0;
    while (i < this.liveIndices.length) {
      const idx = this.liveIndices[i]!;
      const m = this.pool[idx]!;
      if (!m.alive) {
        // Defensive — shouldn't normally happen mid-advance.
        this.releaseAtPos(i);
        continue;
      }
      const def = m.weaponDef;

      // 1. Verify lock still resolves.
      let target: { x: number; y: number; vx: number; vy: number } | null = null;
      if (m.lockedTargetId !== null) {
        target = this.resolveLockPose(m.lockedTargetId, m.lockedKind!);
        if (target === null) {
          // Diag — lock dropped mid-flight (target died, despawned,
          // or became inactive).
          this.deps.serverLogEvent?.('missile_lock_lost', {
            missileId: m.id,
            previousTargetId: m.lockedTargetId,
            previousKind: m.lockedKind,
            ageTicks: def.lifetimeTicks - m.ticksRemaining,
          });
          m.lockedTargetId = null;
          m.lockedKind = null;
        }
      }

      // 1b. Re-acquire a lost / never-acquired lock (playtest 2026-06-10
      // Issue 10 — "missiles should bias tracking the closest enemy a lot
      // more"). Before this a missile whose target died flew straight forever.
      // Re-run the SAME closest-hostile selection (pickTarget with no previous
      // target = pure nearest, no sticky/health bias) from the missile's
      // CURRENT position, throttled to every MISSILE_REACQUIRE_INTERVAL_TICKS
      // so the per-missile candidate scan isn't paid every tick.
      if (target === null && m.isHostile !== null) {
        const ageTicks = def.lifetimeTicks - m.ticksRemaining;
        if (ageTicks % MISSILE_REACQUIRE_INTERVAL_TICKS === 0) {
          const reacq = this.lockOnTarget(m.x, m.y, m.ownerId, m.isHostile, def);
          if (reacq.lock !== null) {
            m.lockedTargetId = reacq.lock.id;
            m.lockedKind = reacq.lock.kind;
            target = this.resolveLockPose(m.lockedTargetId, m.lockedKind);
            this.deps.serverLogEvent?.('missile_reacquired', {
              missileId: m.id,
              targetId: m.lockedTargetId,
              targetKind: m.lockedKind,
              ageTicks,
            });
          }
        }
      }

      // 2. Proximity-fuse check (only when locked + def opts in).
      if (target !== null && def.proximityFuseRadius > 0) {
        const dxp = target.x - m.x;
        const dyp = target.y - m.y;
        const d2p = dxp * dxp + dyp * dyp;
        if (d2p <= def.proximityFuseRadius * def.proximityFuseRadius) {
          this.detonate(m, m.x, m.y, m.lockedTargetId, m.lockedKind, 'fuse');
          this.releaseAtPos(i);
          continue;
        }
      }

      // 3. Guidance: yaw toward target by at most turnRate * dt per tick.
      // Track the signed turn this tick as angvel so the client can integrate
      // the homing CURVE between 20 Hz snapshots (WS-C #5) instead of
      // dead-reckoning a straight line. Computed from the actual applied step
      // (wrapped) — never the raw desired delta, so it matches the integration.
      const angleBefore = m.angle;
      if (target !== null) {
        const desired = Math.atan2(-(target.x - m.x), (target.y - m.y));
        const delta = wrapPi(desired - m.angle);
        const maxStep = def.turnRate * DT_SEC;
        const step = Math.abs(delta) <= maxStep ? delta : (delta > 0 ? maxStep : -maxStep);
        m.angle = wrapPi(m.angle + step);
        m.vx = -Math.sin(m.angle) * def.speed;
        m.vy = Math.cos(m.angle) * def.speed;
      }
      m.angvel = wrapPi(m.angle - angleBefore) / DT_SEC;

      // 4. Integrate position.
      m.x += m.vx * DT_SEC;
      m.y += m.vy * DT_SEC;

      // 5. Sweep collision — direct-hit against players + swarm.
      const hit = this.sweepCollision(m);
      if (hit !== null) {
        this.detonate(m, hit.x, hit.y, hit.id, hit.kind, 'sweep');
        this.releaseAtPos(i);
        continue;
      }

      // 6. Lifetime decrement / expiry. Impact-only (smoke handoff
      // 2026-06-06, Issue 2): a missile that never lands a direct hit
      // DESPAWNS without detonating — no splash, no damage, no explosion
      // VFX (the client sprite alpha-fades over its last 15 % of life and
      // is reaped when it leaves the snapshot `missiles[]` slice, so the
      // fizzle is graceful with no broadcast needed). The TTL stays as a
      // despawn cap so a never-hitting missile doesn't fly forever. Only
      // the direct sweep (step 5) deals damage now.
      m.ticksRemaining -= 1;
      if (m.ticksRemaining <= 0) {
        this.deps.serverLogEvent?.('missile_expired', {
          missileId: m.id,
          ownerId: m.ownerId,
          x: m.x,
          y: m.y,
          lockedTargetId: m.lockedTargetId,
        });
        this.releaseAtPos(i);
        continue;
      }

      i++;
    }
  }

  /**
   * Snapshot slice for the per-recipient broadcaster. Caller supplies an
   * AOI filter (returns true for missiles the recipient should see); the
   * default (no filter) returns every in-flight missile.
   *
   * Pose entries are *constructed* per snapshot — they leave the encoder's
   * AOI loop as plain objects on the wire. Wire-side cost: ~6×8 bytes
   * pose + ownerId + id + weaponId + lifePct ≈ 40-50 bytes/missile JSON.
   */
  snapshotSlice(filter?: (m: MissileRecord) => boolean): MissileSnapshotEntry[] | undefined {
    if (this.liveIndices.length === 0) return undefined;
    const out: MissileSnapshotEntry[] = [];
    for (const idx of this.liveIndices) {
      const m = this.pool[idx]!;
      if (!m.alive) continue;
      if (filter && !filter(m)) continue;
      const lifePct = m.ticksRemaining / m.weaponDef.lifetimeTicks;
      out.push({
        id: m.id,
        x: m.x,
        y: m.y,
        vx: m.vx,
        vy: m.vy,
        angle: m.angle,
        angvel: m.angvel,
        ownerId: m.ownerId,
        weaponId: 'heat-seeker',
        lifePct: lifePct > 0 ? lifePct : 0,
      });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Read-only iterator over live missiles (for the interest-grid AOI). */
  *live(): IterableIterator<MissileRecord> {
    for (const idx of this.liveIndices) {
      const m = this.pool[idx]!;
      if (m.alive) yield m;
    }
  }

  // ── Internal: lock + collision + detonate ────────────────────────────

  private lockOnTarget(
    spawnX: number,
    spawnY: number,
    ownerId: string,
    isHostile: (id: string) => boolean,
    def: MissileWeaponDef,
  ): {
    lock: { id: string; kind: SplashKind } | null;
    candidateCount: number;
    hostileCandidateCount: number;
  } {
    const candidates: MountTargetView[] = [];
    // Players.
    for (const [playerId] of this.deps.playerToSlot) {
      if (playerId === ownerId) continue;
      const ship = this.deps.getActiveShip(playerId);
      if (!ship || !ship.alive || !ship.isActive) continue;
      const pose = this.deps.shipPoseCache.get(playerId);
      if (!pose) continue;
      candidates.push({ id: playerId, x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy });
    }
    // Swarm — drones only. Asteroids (kind=0) are EXCLUDED at the
    // candidate-build site (not via a string-prefix predicate, which
    // misses galaxy-sector asteroid ids like `asteroid-0`). They have
    // no `swarmHealth` entry so `damageSwarmLayered` short-circuits to
    // null → broadcast is silently dropped → user sees missile hit a
    // rock with zero damage (the "fires, tracks, aims, hits, zero
    // damage" smoke-test class). Drones (kind=1) and Living World
    // bots both pass this gate.
    for (const rec of this.deps.swarmRegistry.all()) {
      if (rec.id === ownerId) continue;
      if (rec.kind === 0) continue;
      const b = slotBase(rec.slot);
      const cx = this.deps.sabF32[b + SLOT_X_OFF]!;
      const cy = this.deps.sabF32[b + SLOT_Y_OFF]!;
      const vx = this.deps.sabF32[b + SLOT_VX_OFF]!;
      const vy = this.deps.sabF32[b + SLOT_VY_OFF]!;
      candidates.push({ id: rec.id, x: cx, y: cy, vx, vy });
    }
    let hostileCount = 0;
    for (const c of candidates) if (isHostile(c.id)) hostileCount++;
    // Range gate: missiles never lock past their full-life travel distance.
    const maxLockDistance = (def.speed * def.lifetimeTicks) / 60;
    const picked = pickTarget(spawnX, spawnY, candidates, null, isHostile, {
      maxDistance: maxLockDistance,
    });
    if (!picked) {
      return {
        lock: null,
        candidateCount: candidates.length,
        hostileCandidateCount: hostileCount,
      };
    }
    const kind: SplashKind = picked.id.startsWith('swarm-') || /^lwbot-/.test(picked.id)
      ? 'swarm'
      : 'ship';
    return {
      lock: { id: picked.id, kind },
      candidateCount: candidates.length,
      hostileCandidateCount: hostileCount,
    };
  }

  private resolveLockPose(
    id: string,
    kind: SplashKind,
  ): { x: number; y: number; vx: number; vy: number } | null {
    if (kind === 'ship') {
      const ship = this.deps.getActiveShip(id);
      if (!ship || !ship.alive || !ship.isActive) return null;
      const pose = this.deps.shipPoseCache.get(id);
      if (!pose) return null;
      return { x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy };
    }
    // swarm
    const rec = this.deps.swarmRegistry.get(id);
    if (!rec) return null;
    // Note: SwarmRecLookup doesn't expose `slot` on get(); iterate to find.
    // This path is the cold path (lock-resolve per missile per tick); the
    // hot path (snapshotSlice + advance integration) uses the cached
    // missile pose. For now we accept the lookup cost — it's O(swarm) per
    // missile per tick. If profiling shows this dominates, swap in a
    // slot-indexed cache.
    for (const r of this.deps.swarmRegistry.all()) {
      if (r.id !== id) continue;
      const b = slotBase(r.slot);
      const cx = this.deps.sabF32[b + SLOT_X_OFF]!;
      const cy = this.deps.sabF32[b + SLOT_Y_OFF]!;
      const vx = this.deps.sabF32[b + SLOT_VX_OFF]!;
      const vy = this.deps.sabF32[b + SLOT_VY_OFF]!;
      return { x: cx, y: cy, vx, vy };
    }
    return null;
  }

  /**
   * Sweep against players + swarm; return the first hit (any order — these
   * are short-step circles, ties are rare). Excludes the owner. Returns
   * `null` when no hit.
   */
  private sweepCollision(m: MissileRecord): { id: string; kind: SplashKind; x: number; y: number } | null {
    const r2 = m.weaponDef.radius * m.weaponDef.radius;

    // Players (sphere-only; missiles don't refine to hull polygons today).
    for (const [playerId] of this.deps.playerToSlot) {
      if (playerId === m.ownerId) continue;
      const ship = this.deps.getActiveShip(playerId);
      if (!ship || !ship.alive || !ship.isActive) continue;
      const pose = this.deps.shipPoseCache.get(playerId);
      if (!pose) continue;
      const dx = pose.x - m.x;
      const dy = pose.y - m.y;
      const shipR = 12; // SHIP_COLLISION_RADIUS (approx)
      const combined = (m.weaponDef.radius + shipR);
      if (dx * dx + dy * dy <= combined * combined) {
        return { id: playerId, kind: 'ship', x: m.x, y: m.y };
      }
    }

    // Lingering hulls (disconnected / fresh-spawn-displaced, isActive=false).
    // They are NOT in the active playerToSlot set above but are still solid
    // world objects (R2.22 symptom 3) — a missile must COLLIDE with them, not
    // pass through. Alloc-free for-of over the slot set; pose from the mirror
    // cache (skip if not yet written). Returns the shipInstanceId so
    // EntityResolver routes the hit to the lingering leaf.
    for (const [shipInstanceId] of this.deps.lingeringSlots) {
      const pose = this.deps.lingeringPoseCache.get(shipInstanceId);
      if (!pose) continue;
      const dx = pose.x - m.x;
      const dy = pose.y - m.y;
      const shipR = 12;
      const combined = m.weaponDef.radius + shipR;
      if (dx * dx + dy * dy <= combined * combined) {
        return { id: shipInstanceId, kind: 'ship', x: m.x, y: m.y };
      }
    }

    // Swarm — drones AND asteroids. Per the asteroid-interaction-model ADR
    // (R2.22 symptom 2 / WS-2b), asteroids are SOLID indestructible rock: a
    // missile must DETONATE on contact + despawn, NOT pass through. The 0-HP
    // detonation on the immune rock is CORRECT (applyDamage no-ops on the
    // asteroid id — no swarmHealth); the bug was the pass-through. Asteroids
    // are still NOT lockable (lockOnTarget keeps the kind===0 skip — you don't
    // home on rock, you just can't fly through it).
    for (const rec of this.deps.swarmRegistry.all()) {
      if (rec.id === m.ownerId) continue;
      const b = slotBase(rec.slot);
      const cx = this.deps.sabF32[b + SLOT_X_OFF]!;
      const cy = this.deps.sabF32[b + SLOT_Y_OFF]!;
      const dx = cx - m.x;
      const dy = cy - m.y;
      const combined = m.weaponDef.radius + rec.radius;
      if (dx * dx + dy * dy <= combined * combined) {
        return { id: rec.id, kind: 'swarm', x: m.x, y: m.y };
      }
    }

    void r2;
    return null;
  }

  /**
   * Detonate at `(dx, dy)`. Applies splash damage + impulse to every
   * entity within `splashRadius` (excluding owner if the def opts in).
   * `primaryId` is the directly-struck (or proximity-fused) target — it
   * gets the `directImpulseBonus` damage on top of splash.
   */
  private detonate(
    m: MissileRecord,
    dx: number,
    dy: number,
    primaryId: string | null,
    primaryKind: SplashKind | null,
    cause: DetonateCause,
  ): void {
    const def = m.weaponDef;
    const r2 = def.splashRadius * def.splashRadius;
    const ownerSkip = def.splashExcludeOwner ? m.ownerId : null;

    // Diag — fires BEFORE the splash loop so a panicked diagnostician
    // gets the cause + locked-vs-primary delta even if splash itself
    // throws. `ageTicks` = lifetimeTicks - ticksRemaining at the moment
    // of detonate (matches `advance()`'s tick accounting).
    this.deps.serverLogEvent?.('missile_detonated', {
      missileId: m.id,
      cause,
      x: dx,
      y: dy,
      ownerId: m.ownerId,
      ageTicks: def.lifetimeTicks - m.ticksRemaining,
      primaryId,
      primaryKind,
      lockedTargetId: m.lockedTargetId,
      lockedKind: m.lockedKind,
    });

    // Splash against players.
    for (const [playerId] of this.deps.playerToSlot) {
      if (playerId === ownerSkip) continue;
      const ship = this.deps.getActiveShip(playerId);
      if (!ship || !ship.alive || !ship.isActive) continue;
      const pose = this.deps.shipPoseCache.get(playerId);
      if (!pose) continue;
      const px = pose.x - dx;
      const py = pose.y - dy;
      const dist2 = px * px + py * py;
      if (dist2 > r2) continue;
      this.applySplash(m, playerId, primaryKind === 'ship' && primaryId === playerId, dx, dy, pose.x, pose.y, dist2);
    }

    // Splash against lingering hulls (R2.22 symptom 3) — identical to the
    // active-player loop minus the isActive gate. The struck lingering hull is
    // the primary; applySplash routes applyDamage by shipInstanceId →
    // EntityResolver's lingering leaf. Alloc-free for-of over the slot set.
    for (const [shipInstanceId] of this.deps.lingeringSlots) {
      if (shipInstanceId === ownerSkip) continue;
      const pose = this.deps.lingeringPoseCache.get(shipInstanceId);
      if (!pose) continue;
      const px = pose.x - dx;
      const py = pose.y - dy;
      const dist2 = px * px + py * py;
      if (dist2 > r2) continue;
      this.applySplash(m, shipInstanceId, primaryKind === 'ship' && primaryId === shipInstanceId, dx, dy, pose.x, pose.y, dist2);
    }

    // Splash against swarm.
    for (const rec of this.deps.swarmRegistry.all()) {
      if (rec.id === ownerSkip) continue;
      const b = slotBase(rec.slot);
      const cx = this.deps.sabF32[b + SLOT_X_OFF]!;
      const cy = this.deps.sabF32[b + SLOT_Y_OFF]!;
      const px = cx - dx;
      const py = cy - dy;
      const dist2 = px * px + py * py;
      if (dist2 > r2) continue;
      this.applySplash(m, rec.id, primaryKind === 'swarm' && primaryId === rec.id, dx, dy, cx, cy, dist2);
    }

    // Local bus + cross-process broadcast.
    this.deps.bus.emit('MISSILE_DETONATED', {
      type: 'MISSILE_DETONATED',
      missileId: m.id,
      x: dx,
      y: dy,
      splashRadius: def.splashRadius,
      weaponId: 'heat-seeker',
    });
    this.deps.broadcastDetonated({
      type: 'missile_detonated',
      missileId: m.id,
      x: dx,
      y: dy,
      splashRadius: def.splashRadius,
      weaponId: 'heat-seeker',
    });
  }

  /** Apply splash damage + queue an impulse for the worker. */
  private applySplash(
    m: MissileRecord,
    targetId: string,
    isPrimary: boolean,
    detX: number,
    detY: number,
    tgtX: number,
    tgtY: number,
    dist2: number,
  ): void {
    const def = m.weaponDef;
    const distRaw = Math.sqrt(dist2);
    const dist = distRaw < def.splashFalloffMin ? def.splashFalloffMin : distRaw;
    // Inverse-square falloff. At dist = splashFalloffMin → 1.0; at
    // dist = splashRadius → (splashFalloffMin/splashRadius)².
    const falloff = (def.splashFalloffMin / dist) * (def.splashFalloffMin / dist);
    const baseDamage = def.damage * falloff;
    const damage = isPrimary ? baseDamage + def.directImpulseBonus : baseDamage;
    this.deps.applyDamage(targetId, m.ownerId, damage, detX, detY);
    // Impulse vector: from detonation toward target. At dist=0 (rare —
    // covered by splashFalloffMin clamp) we'd otherwise divide by zero;
    // the clamp handles that.
    const invDist = 1 / dist;
    let nx = (tgtX - detX) * invDist;
    let ny = (tgtY - detY) * invDist;
    if (!isFinite(nx) || !isFinite(ny)) { nx = 0; ny = 0; }
    const impulseMag = def.splashImpulse * falloff;
    this.pendingImpulses.push({
      targetId,
      fx: nx * impulseMag,
      fy: ny * impulseMag,
    });
  }

  /** Release the missile at `liveIndices[i]` (swap-pop). */
  private releaseAtPos(i: number): void {
    const idx = this.liveIndices[i]!;
    const rec = this.pool[idx]!;
    rec.alive = false;
    rec.lockedTargetId = null;
    rec.lockedKind = null;
    rec.isHostile = null; // drop the captured closure (don't pin owner state)
    // Swap-pop.
    const last = this.liveIndices.length - 1;
    if (i !== last) this.liveIndices[i] = this.liveIndices[last]!;
    this.liveIndices.pop();
    this.freeIndices.push(idx);
  }
}

const EMPTY_IMPULSE_ARRAY: readonly PendingImpulse[] = Object.freeze([]);

/** Exposed for tests + dev tools. */
export const MISSILE_POOL_CAPACITY = POOL_CAPACITY;
