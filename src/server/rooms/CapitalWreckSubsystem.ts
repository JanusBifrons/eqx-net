/**
 * Capital destruction S2a (docs/architecture/capital-destruction.md §S2):
 * every capital, NPC or player-flown, breaks into wreck pieces that are solid
 * server bodies. Behind the `capitalWrecks` room option (off by default until
 * S3 gives the pieces their art; since S2b clients draw them plainly). With
 * the option off the room never constructs this class.
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
 *     The pieces move with the dead hull for `WRECK_CRACK_MS` (game ticks),
 *     then `tick()` gives each its slow separating kick.
 *  3. DESCRIPTORS (S2b): each wreck gets a u16 `wreckId` (its pieces carry it
 *     on the binary wire) and one `WreckDescriptor` (the fracture inputs) that
 *     rides the snapshot while any of its pieces lives. A client, a late joiner
 *     included, rebuilds the pieces from it (#16); no vertex is on the wire.
 *
 * Hand-rolled-mock testable: everything room-shaped comes in as hooks.
 */
import { buildWreckPieces, MAX_LIVE_WRECK_PIECES, WRECK_ANGULAR_DAMPING, WRECK_LINEAR_DAMPING, WRECK_RECENT_DAMAGE_TICKS, type WreckDeathPose } from '../../core/destruction/wreckPieces.js';
import { fnv1a32, fnvMixU32 } from '../../core/random/rng.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../shared-types/messages/snapshotMessages.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';

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
  /** S2b: the wreck this piece belongs to (u16, on the binary wire). */
  wreckId: number;
  parts: ReadonlyArray<ReadonlyArray<Vec2>>;
  /** The physics collider (`WreckPieceGeometry.colliderParts`). */
  colliderParts: ReadonlyArray<ReadonlyArray<Vec2>>; linearDamping: number; angularDamping: number;
}

interface LiveWreck {
  desc: WreckDescriptor;
  /** Pieces of this wreck still alive. */
  pieces: number;
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
  /** A live piece's current angle (rad), or null when it is gone. */
  pieceAngle: (id: string) => number | null;
  /** Add this velocity (world u/s) and spin (rad/s) to a live piece's body. */
  kickPiece: (id: string, dvx: number, dvy: number, dw: number) => void;
  /** Apply impulse (jx, jy) at world point (px, py) to a live piece's body
   *  (overkill knock-back). Optional: absent ⇒ hits never shove pieces. */
  impulsePiece?: (id: string, jx: number, jy: number, px: number, py: number) => void;
}

/** How hard a hit knocks one piece (fixed at spawn; read per hit, #14). */
interface PieceKnock {
  /** The piece's mass (its body's mass). */
  mass: number;
  /** Impulse per point of damage: hull mass × `wreckKnockSpeed` ÷ max hull. */
  impulsePerDamage: number;
  /** The most one hit may change its speed (`wreckKnockMax`, u/s). */
  maxDv: number;
}

/** A piece's separating kick, held until the wreck's crack delay ends. */
interface PendingKick {
  id: string;
  dueTick: number;
  /** Kick in the world frame at the death angle. */
  vx: number;
  vy: number;
  w: number;
  angle0: number;
}

export class CapitalWreckSubsystem {
  /** Kicks waiting for `WRECK_CRACK_MS` (oldest first; compacted in place). */
  private readonly kicks: PendingKick[] = [];
  private readonly entries = new Map<string, HitEntry>();
  private readonly pool: HitEntry[] = [];
  /** Live wreck piece ids, oldest first (budget FIFO). */
  private readonly live: string[] = [];
  private deaths = 0;
  private readonly lastDeathTick = new Map<string, number>();
  /** S2b: live wrecks by wreckId, and the snapshot slice (one descriptor per
   *  live wreck, rebuilt only when the set changes). */
  private readonly wrecks = new Map<number, LiveWreck>();
  private readonly pieceWreck = new Map<string, number>();
  /** Per live piece: how a hit knocks it (overkill knock-back). */
  private readonly knock = new Map<string, PieceKnock>();
  private readonly slice: WreckDescriptor[] = [];
  private nextWreckId = 1;
  /** Bumped whenever the set of live wrecks changes. */
  version = 0;
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
    const { pieces, fracture } = buildWreckPieces({ kindId, pose, killWorld, attackerWorld, seed, killBlowDamage, recentDamageRate });
    const n = this.deaths++;
    const wreckId = this.allocWreckId();
    const crackTicks = wreckCrackTicks();
    // Overkill knock-back (#18): a blow worth the whole hull's HP would move
    // the whole hull at `wreckKnockSpeed`.
    const tuning = shipTuning(getShipKind(kindId));
    let hullMass = 0;
    for (const p of pieces) hullMass += p.mass;
    const impulsePerDamage = (hullMass * tuning.wreckKnockSpeed) / hull;
    let spawned = 0;
    for (const p of pieces) {
      const id = `wreck-${n}-${p.index}`;
      const ok = this.d.spawnPiece({
        id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, angvel: p.angvel,
        radius: p.radius, mass: p.mass, parentShipKind: kindId, pieceIndex: p.index, wreckId,
        parts: p.parts, colliderParts: p.colliderParts,
        linearDamping: WRECK_LINEAR_DAMPING, angularDamping: WRECK_ANGULAR_DAMPING,
      });
      if (!ok) continue;
      spawned++;
      this.knock.set(id, { mass: p.mass, impulsePerDamage, maxDv: tuning.wreckKnockMax });
      // The hull holds together for the crack delay, then parts (game ticks).
      this.kicks.push({ id, dueTick: tick + crackTicks, vx: p.kickVx, vy: p.kickVy, w: p.kickAngvel, angle0: pose.angle });
      this.live.push(id);
      this.pieceWreck.set(id, wreckId);
    }
    if (spawned > 0) {
      this.wrecks.set(wreckId, {
        desc: {
          wreckId, parentKind: kindId, seed: fracture.seed, killX: fracture.killX, killY: fracture.killY,
          killBlowDamage: fracture.killBlowDamage, recentDamageRate: fracture.recentDamageRate,
          snapChance: fracture.snapChance, algoVersion: FRACTURE_ALGO_VERSION,
          deathTick: tick,
        },
        pieces: spawned,
      });
      this.setChanged();
    }
    this.enforceCap();
    return spawned;
  }

  /**
   * Per server tick: give each piece whose wreck's crack delay is over its
   * separating kick. The kick was built at the death angle; the piece has
   * turned with the hull since, so it is turned by the same amount. Kicks for
   * pieces already gone are dropped. Alloc-free (#14): compacts in place.
   */
  tick(): void {
    const k = this.kicks;
    if (k.length === 0) return;
    const now = this.d.serverTick();
    let w = 0;
    for (let r = 0; r < k.length; r++) {
      const e = k[r]!;
      if (e.dueTick > now) {
        k[w++] = e;
        continue;
      }
      const angle = this.d.pieceAngle(e.id);
      if (angle === null) continue;
      const da = angle - e.angle0;
      const c = Math.cos(da);
      const s = Math.sin(da);
      this.d.kickPiece(e.id, e.vx * c - e.vy * s, e.vx * s + e.vy * c, e.w);
    }
    k.length = w;
  }

  /**
   * Overkill knock-back (owner request 2026-11-13): a weapon hit `damage` on
   * wreck piece `id` at world point (hitX, hitY), travelling along (dirX,
   * dirY). Posts an impulse J = damage × hull mass × `wreckKnockSpeed` ÷ max
   * hull at the hit point, along the shot, so an off-centre hit also turns
   * the piece; the speed change J ÷ m is capped at `wreckKnockMax`. Returns
   * false (and does nothing) when `id` is not a live wreck piece or the
   * direction is degenerate. Scalars only, alloc-free (#14): it runs in the
   * projectile and beam hit paths.
   */
  onWreckHit(id: string, hitX: number, hitY: number, dirX: number, dirY: number, damage: number): boolean {
    const k = this.knock.get(id);
    if (k === undefined || this.d.impulsePiece === undefined || !(damage > 0)) return false;
    const len = Math.hypot(dirX, dirY);
    if (!(len > 1e-9) || !Number.isFinite(hitX) || !Number.isFinite(hitY)) return false;
    let j = damage * k.impulsePerDamage;
    const jMax = k.maxDv * k.mass;
    if (j > jMax) j = jMax;
    const s = j / len;
    this.d.impulsePiece(id, dirX * s, dirY * s, hitX, hitY);
    return true;
  }

  /** Pieces still holding together (waiting for their kick). */
  pendingKicks(): number {
    return this.kicks.length;
  }

  /** A free u16 wreck id (never 0, never one still live). */
  private allocWreckId(): number {
    for (;;) {
      const id = this.nextWreckId;
      this.nextWreckId = id >= 0xffff ? 1 : id + 1;
      if (!this.wrecks.has(id)) return id;
    }
  }

  private setChanged(): void {
    this.version++;
    this.slice.length = 0;
    for (const w of this.wrecks.values()) this.slice.push(w.desc);
  }

  /** A wreck piece left the world (cap, or any other removal). */
  pieceGone(id: string): void {
    this.knock.delete(id);
    const wreckId = this.pieceWreck.get(id);
    if (wreckId === undefined) return;
    this.pieceWreck.delete(id);
    const w = this.wrecks.get(wreckId);
    if (w === undefined) return;
    w.pieces--;
    if (w.pieces <= 0) {
      this.wrecks.delete(wreckId);
      this.setChanged();
    }
  }

  /** The snapshot slice: one descriptor per live wreck (shared array, rebuilt
   *  only on change; empty when there are none). */
  descriptors(): readonly WreckDescriptor[] {
    return this.slice;
  }

  /** Live wreck pieces this subsystem tracks. */
  liveCount(): number {
    return this.live.length;
  }

  private enforceCap(): void {
    while (this.live.length > MAX_LIVE_WRECK_PIECES) {
      const id = this.live.shift()!;
      if (this.d.isLive(id)) this.d.removePiece(id);
      this.pieceGone(id);
    }
  }
}
