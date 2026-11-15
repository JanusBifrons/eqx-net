/**
 * NPC line-of-fire check (friendly fire slice 2, owner decision 2026-11-10:
 * "Fire hits all, but we need NPCs to be aware of this and not fire when
 * blocked").
 *
 * Every shot hits the first thing in its path (slice 1). Before an NPC fires
 * (a drone's slot, a capital's turret, an NPC base's turret, a player base's
 * turret), the room asks this gate whether a FRIENDLY body lies on the shot's
 * path from the muzzle to the target. If one does, the shooter holds fire this
 * tick: the gun keeps aiming and the lock stays. A player-owned hull flown by
 * the AI pilot (RTS) is gated too; a pilot's own fire never is.
 *
 * What counts as friendly is the caller's predicate (`SectorRoom.lofFriendly`);
 * this class only finds the bodies on the segment: the registry's, plus the
 * players' ships (`ships`: pilots' active ships and parked hulls, which are
 * not swarm records) binned in the same grid.
 *
 * Cost (root CLAUDE.md "gate on counts"): one broadphase per tick over the
 * swarm registry (the projectile broadphase type, #428), built lazily on the
 * first check of a tick and rebuilt only if membership changes. Each check is
 * one grid query over the segment's box; the predicate runs per candidate and
 * the narrow phase (the same ray shapes as `nonPlayerRayHit`) only for the
 * friendly ones, stopping at the first hit. `checks`, `candidates` and
 * `narrow` are running COUNTS (host-independent); the budget lives in
 * `perfBudgets.ts` (`LINE_OF_FIRE_*`). Allocation-free in steady state (#14).
 */
import { ProjectileBroadphase, type BroadphaseShape } from './ProjectileBroadphase.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, SLOT_VX_OFF, SLOT_VY_OFF } from '../../shared-types/sabLayout.js';
import { segmentNearCircle } from '../../core/combat/Weapons.js';

/** The swarm record fields the gate reads. */
export interface LineOfFireBody extends BroadphaseShape {
  id: string;
  slot: number;
}

export interface LineOfFireGateDeps<R extends LineOfFireBody> {
  /** Swarm registry (every kind: drones, structures, rocks, scrap). */
  registry: { all(): Iterable<R>; readonly version?: number };
  /** Bodies outside the registry (the players' ships): fills `out` from 0
   *  and returns the count. Read at each grid build, beside the registry, so
   *  an AI pilot sees a player ship on its line. Absent ⇒ registry only. */
  ships?: (out: R[]) => number;
  /** SAB Float32 view (slot-indexed poses). */
  sabF32: Float32Array;
  /** Current server tick: the grid is rebuilt once per tick at most. */
  tick: () => number;
  /** Narrow phase: distance along the unit ray to `rec` at (cx, cy, ca), or
   *  null when it misses within `maxDist`. */
  rayHit: (rec: R, fx: number, fy: number, dx: number, dy: number, maxDist: number, cx: number, cy: number, ca: number) => number | null;
}

export class LineOfFireGate<R extends LineOfFireBody> {
  /** Running counts (never reset; read deltas). */
  checks = 0;
  /** Broadphase candidates the friendly predicate looked at. */
  candidates = 0;
  /** Narrow-phase ray tests run (friendly candidates only). */
  narrow = 0;
  /** Grid builds (at most one per tick unless membership changes). */
  builds = 0;
  /** The body that blocked the latest check that returned true (its pose at
   *  the grid build). Scratch fields, overwritten per block (#14). */
  lastBlockerId = '';
  lastBlockerX = 0;
  lastBlockerY = 0;

  private readonly bp = new ProjectileBroadphase<R>();
  /** `deps.ships` output, reused (#14). */
  private readonly shipScratch: R[] = [];
  /** Velocity at the grid build, by dense index (the moving-shot check). */
  private vx = new Float64Array(64);
  private vy = new Float64Array(64);
  /** Fastest body speed in this build (bounds the moving-shot query). */
  private maxSpeed = 0;
  private builtTick = -1;
  private builtVersion = -1;

  constructor(private readonly deps: LineOfFireGateDeps<R>) {}

  /**
   * True when a body that `friendly` accepts lies on the segment from
   * (fx, fy) along unit (dx, dy) for `maxDist`. The shooter and its target
   * are never tested (the target may share the shooter's side, e.g. a drone
   * that provoked it). Alloc-free: pass a pre-bound predicate, not a new
   * closure. A registry without `version` rebuilds on every check.
   *
   * A MOVING shot (`shotSpeed` > 0, u/s; the shooter's velocity
   * (`svx`, `svy`), which the shot inherits): each friendly is ALSO tested
   * where it will be, relative to the shot, when the shot reaches it, so a
   * friend crossing the line during the shot's flight holds it too. Absent
   * (0) ⇒ the pose at the grid build only.
   */
  blocked(
    fx: number, fy: number, dx: number, dy: number, maxDist: number,
    shooterId: string, targetId: string, friendly: (rec: R) => boolean,
    shotSpeed = 0, svx = 0, svy = 0,
  ): boolean {
    if (!(maxDist > 0)) return false;
    this.checks++;
    const d = this.deps;
    const tick = d.tick();
    const version = d.registry.version ?? -1;
    if (tick !== this.builtTick || version !== this.builtVersion || version === -1) this.rebuild(tick, version);
    const bp = this.bp;
    const moving = shotSpeed > 0;
    // A body can close at most (its speed + the shooter's) × the flight time.
    const pad = moving ? (this.maxSpeed + Math.hypot(svx, svy)) * (maxDist / shotSpeed) : 0;
    bp.query(fx, fy, dx * maxDist, dy * maxDist, pad);
    const n = bp.outCount;
    this.candidates += n;
    for (let k = 0; k < n; k++) {
      const i = bp.out[k]!;
      const rec = bp.recs[i]!;
      if (rec.id === shooterId || rec.id === targetId || !friendly(rec)) continue;
      this.narrow++;
      let cx = bp.x[i]!, cy = bp.y[i]!;
      let hit = d.rayHit(rec, fx, fy, dx, dy, maxDist, cx, cy, bp.angle[i]!) !== null;
      if (!hit && moving) {
        // Where it will be (in the shot's frame) when the shot is level with it.
        const along = (cx - fx) * dx + (cy - fy) * dy;
        const t = (along > 0 ? (along < maxDist ? along : maxDist) : 0) / shotSpeed;
        cx += (this.vx[i]! - svx) * t;
        cy += (this.vy[i]! - svy) * t;
        this.narrow++;
        hit = d.rayHit(rec, fx, fy, dx, dy, maxDist, cx, cy, bp.angle[i]!) !== null;
      }
      if (hit) {
        this.lastBlockerId = rec.id;
        this.lastBlockerX = bp.x[i]!;
        this.lastBlockerY = bp.y[i]!;
        return true;
      }
    }
    return false;
  }

  /**
   * The tractor beam's line set (salvage plan PR 11): write into `ids` up to
   * `cap` swarm bodies (any kind) whose bound comes within `halfWidth` of the
   * segment (fx, fy) → (tx, ty), skipping `skipA` / `skipB` (emitter,
   * target), in registry order. Same per-tick grid as `blocked`; the narrow
   * test is the shared `segmentNearCircle` on the record's radius, never a
   * Rapier shape query. Returns the count. Allocation-free (#14).
   */
  lineBodies(
    fx: number, fy: number, tx: number, ty: number, halfWidth: number,
    skipA: string, skipB: string, ids: string[], cap: number,
  ): number {
    const d = this.deps;
    const tick = d.tick();
    const version = d.registry.version ?? -1;
    if (tick !== this.builtTick || version !== this.builtVersion || version === -1) this.rebuild(tick, version);
    const bp = this.bp;
    const sx = tx - fx, sy = ty - fy;
    bp.query(fx, fy, sx, sy, halfWidth);
    let n = 0;
    for (let k = 0; k < bp.outCount && n < cap; k++) {
      const i = bp.out[k]!;
      const rec = bp.recs[i]!;
      if (rec.id === skipA || rec.id === skipB) continue;
      if (segmentNearCircle(fx, fy, sx, sy, bp.x[i]!, bp.y[i]!, rec.radius + halfWidth)) ids[n++] = rec.id;
    }
    return n;
  }

  private rebuild(tick: number, version: number): void {
    const d = this.deps;
    const bp = this.bp;
    bp.begin();
    this.maxSpeed = 0;
    for (const rec of d.registry.all()) this.add(rec);
    const n = d.ships?.(this.shipScratch) ?? 0;
    for (let k = 0; k < n; k++) this.add(this.shipScratch[k]!);
    bp.end();
    this.builtTick = tick;
    this.builtVersion = version;
    this.builds++;
  }

  private add(rec: R): void {
    const sab = this.deps.sabF32;
    const b = slotBase(rec.slot);
    const i = this.bp.count;
    this.bp.add(rec, sab[b + SLOT_X_OFF]!, sab[b + SLOT_Y_OFF]!, sab[b + SLOT_ANGLE_OFF]!);
    if (i >= this.vx.length) {
      // Doubling growth past the high-water mark only (#14).
      const nx = new Float64Array(this.vx.length * 2); nx.set(this.vx); this.vx = nx;
      const ny = new Float64Array(this.vy.length * 2); ny.set(this.vy); this.vy = ny;
    }
    const vx = sab[b + SLOT_VX_OFF]!, vy = sab[b + SLOT_VY_OFF]!;
    this.vx[i] = vx; this.vy[i] = vy;
    const sp = Math.hypot(vx, vy);
    if (sp > this.maxSpeed) this.maxSpeed = sp;
  }
}
