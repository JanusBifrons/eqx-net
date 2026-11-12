/**
 * Capital destruction S2a (docs/architecture/capital-destruction.md §S2):
 * every capital, NPC or player-flown, breaks into wreck pieces that are solid
 * server bodies. Behind the `capitalWrecks` room option (off by default:
 * clients don't draw wrecks until S3, so a playtest must never meet invisible
 * walls). With the option off the room never constructs this class.
 *
 * Two jobs:
 *  1. HIT TRACKING (per hit, from `SectorRoom.applyDamage`): for each capital
 *     target, the last hit's world point, damage and shooter, plus the
 *     damage taken over the last ~3 s in a fixed 6-bucket ring. Entries are
 *     pooled (one per capital ever hit, reused after death): no per-hit
 *     allocation (#14).
 *  2. DEATH (once, from the capital's death hook): read the tracker, build the
 *     pieces (`buildWreckPieces`: the kill point on the hull edge, piece count
 *     from the final hit and the recent damage rate), spawn one body per piece.
 *
 * Hand-rolled-mock testable: everything room-shaped comes in as hooks.
 */
import { buildWreckPieces, MAX_LIVE_WRECK_PIECES, WRECK_ANGULAR_DAMPING, WRECK_LINEAR_DAMPING, WRECK_RECENT_DAMAGE_TICKS, type WreckDeathPose } from '../../core/destruction/wreckPieces.js';
import { fnv1a32, fnvMixU32 } from '../../core/random/rng.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';

const BUCKETS = 6;
const BUCKET_TICKS = WRECK_RECENT_DAMAGE_TICKS / BUCKETS;

interface HitEntry {
  hasPoint: boolean;
  x: number;
  y: number;
  lastDamage: number;
  shooterId: string;
  /** Damage per bucket; `stamp[i]` is the bucket index it holds. */
  dmg: Float64Array;
  stamp: Int32Array;
}

export interface WreckPieceSpawn {
  id: string;
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
  radius: number; mass: number; parentShipKind: ShipKindId; pieceIndex: number;
  parts: ReadonlyArray<ReadonlyArray<Vec2>>; linearDamping: number; angularDamping: number;
}

export interface CapitalWreckDeps {
  serverTick: () => number;
  /** The capital ship kind of a damage target (drone id, playerId or
   *  lingering shipInstanceId), or null when it is not a capital. */
  capitalKindOf: (targetId: string) => ShipKindId | null;
  /** World position of an entity (the attacker fallback), or null. */
  positionOf: (id: string) => Vec2 | null;
  /** Spawn one wreck body; false = no free slot. */
  spawnPiece: (spec: WreckPieceSpawn) => boolean;
  /** Quietly remove a wreck body (budget cap). */
  removePiece: (id: string) => void;
  /** Is this wreck id still live? (The FIFO skips pieces gone otherwise.) */
  isLive: (id: string) => boolean;
}

export class CapitalWreckSubsystem {
  private readonly entries = new Map<string, HitEntry>();
  private readonly pool: HitEntry[] = [];
  /** Live wreck piece ids, oldest first (budget FIFO). */
  private readonly live: string[] = [];
  private deaths = 0;
  private readonly lastDeathTick = new Map<string, number>();
  /** Test seam: a fixed fracture seed. */
  forcedSeed: number | null = null;

  constructor(private readonly d: CapitalWreckDeps) {}

  /** Record a hit on `targetId` (called for every damaging hit). Cheap for
   *  non-capitals (one kind lookup). `hitX/hitY` absent ⇒ the attacker's
   *  position stands in at death. */
  noteHit(targetId: string, shooterId: string, damage: number, hitX: number | undefined, hitY: number | undefined): void {
    if (damage <= 0) return;
    if (this.d.capitalKindOf(targetId) === null) return;
    let e = this.entries.get(targetId);
    if (e === undefined) {
      e = this.pool.pop() ?? { hasPoint: false, x: 0, y: 0, lastDamage: 0, shooterId: '', dmg: new Float64Array(BUCKETS), stamp: new Int32Array(BUCKETS).fill(-1) };
      e.dmg.fill(0);
      e.stamp.fill(-1);
      this.entries.set(targetId, e);
    }
    e.hasPoint = hitX !== undefined && hitY !== undefined;
    e.x = hitX ?? 0;
    e.y = hitY ?? 0;
    e.lastDamage = damage;
    e.shooterId = shooterId;
    const b = Math.floor(this.d.serverTick() / BUCKET_TICKS);
    const i = b % BUCKETS;
    if (e.stamp[i] !== b) {
      e.stamp[i] = b;
      e.dmg[i] = 0;
    }
    e.dmg[i]! += damage;
  }

  /** Damage `targetId` took over the last ~3 s (whole buckets). */
  private recentDamage(e: HitEntry): number {
    const now = Math.floor(this.d.serverTick() / BUCKET_TICKS);
    let sum = 0;
    for (let i = 0; i < BUCKETS; i++) {
      const s = e.stamp[i]!;
      if (s >= 0 && now - s < BUCKETS) sum += e.dmg[i]!;
    }
    return sum;
  }

  /** Forget a target that left without dying (evicted, despawned). */
  forget(targetId: string): void {
    const e = this.entries.get(targetId);
    if (e === undefined) return;
    this.entries.delete(targetId);
    this.pool.push(e);
  }

  /**
   * A capital died at `pose`: break it into wreck bodies. Returns the number
   * of pieces spawned (0 for a non-capital). Call BEFORE the dying body is
   * despawned (the worker processes the spawns and the despawn in order,
   * before its next step, so the pieces never overlap the old hull).
   */
  onDeath(targetId: string, kindId: ShipKindId, pose: WreckDeathPose, maxHull: number): number {
    // Two lethal hits in one tick can report the same death twice
    // (the 2026-06-19 double SHIP_DESTROYED): break the hull once.
    const tick = this.d.serverTick();
    if (this.lastDeathTick.get(targetId) === tick) return 0;
    if (this.lastDeathTick.size > 256) this.lastDeathTick.clear();
    this.lastDeathTick.set(targetId, tick);
    const e = this.entries.get(targetId);
    const hull = maxHull > 0 ? maxHull : 1;
    const killWorld = e !== undefined && e.hasPoint ? { x: e.x, y: e.y } : null;
    const attackerWorld = e !== undefined && e.shooterId !== '' ? this.d.positionOf(e.shooterId) : null;
    const killBlowDamage = e !== undefined ? e.lastDamage / hull : 0;
    const recentDamageRate = e !== undefined ? this.recentDamage(e) / hull : 0;
    this.forget(targetId);
    const seed = this.forcedSeed ?? fnvMixU32(fnv1a32(targetId), this.d.serverTick() >>> 0);
    const { pieces } = buildWreckPieces({ kindId, pose, killWorld, attackerWorld, seed, killBlowDamage, recentDamageRate });
    const n = this.deaths++;
    let spawned = 0;
    for (const p of pieces) {
      const id = `wreck-${n}-${p.index}`;
      const ok = this.d.spawnPiece({
        id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, angvel: p.angvel,
        radius: p.radius, mass: p.mass, parentShipKind: kindId, pieceIndex: p.index,
        parts: p.parts, linearDamping: WRECK_LINEAR_DAMPING, angularDamping: WRECK_ANGULAR_DAMPING,
      });
      if (!ok) continue;
      spawned++;
      this.live.push(id);
    }
    this.enforceCap();
    return spawned;
  }

  /** Live wreck pieces this subsystem tracks. */
  liveCount(): number {
    return this.live.length;
  }

  private enforceCap(): void {
    while (this.live.length > MAX_LIVE_WRECK_PIECES) {
      const id = this.live.shift()!;
      if (this.d.isLive(id)) this.d.removePiece(id);
    }
  }
}
