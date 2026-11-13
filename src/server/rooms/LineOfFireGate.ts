/**
 * NPC line-of-fire check (friendly fire slice 2, owner decision 2026-11-10:
 * "Fire hits all, but we need NPCs to be aware of this and not fire when
 * blocked").
 *
 * Every shot hits the first thing in its path (slice 1). Before an NPC fires
 * (a drone's slot, a capital's turret, an NPC base's turret, a player base's
 * turret), the room asks this gate whether a FRIENDLY body lies on the shot's
 * path from the muzzle to the target. If one does, the shooter holds fire this
 * tick: the gun keeps aiming and the lock stays. Players are never gated.
 *
 * What counts as friendly is the caller's predicate (`SectorRoom.lofFriendly`);
 * this class only finds the bodies on the segment.
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
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF } from '../../shared-types/sabLayout.js';

/** The swarm record fields the gate reads. */
export interface LineOfFireBody extends BroadphaseShape {
  id: string;
  slot: number;
}

export interface LineOfFireGateDeps<R extends LineOfFireBody> {
  /** Swarm registry (every kind: drones, structures, rocks, scrap). */
  registry: { all(): Iterable<R>; readonly version?: number };
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
  private builtTick = -1;
  private builtVersion = -1;

  constructor(private readonly deps: LineOfFireGateDeps<R>) {}

  /**
   * True when a body that `friendly` accepts lies on the segment from
   * (fx, fy) along unit (dx, dy) for `maxDist`. The shooter and its target
   * are never tested (the target may share the shooter's side, e.g. a drone
   * that provoked it). Alloc-free: pass a pre-bound predicate, not a new
   * closure. A registry without `version` rebuilds on every check.
   */
  blocked(
    fx: number, fy: number, dx: number, dy: number, maxDist: number,
    shooterId: string, targetId: string, friendly: (rec: R) => boolean,
  ): boolean {
    if (!(maxDist > 0)) return false;
    this.checks++;
    const d = this.deps;
    const tick = d.tick();
    const version = d.registry.version ?? -1;
    if (tick !== this.builtTick || version !== this.builtVersion || version === -1) this.rebuild(tick, version);
    const bp = this.bp;
    bp.query(fx, fy, dx * maxDist, dy * maxDist, 0);
    const n = bp.outCount;
    this.candidates += n;
    for (let k = 0; k < n; k++) {
      const i = bp.out[k]!;
      const rec = bp.recs[i]!;
      if (rec.id === shooterId || rec.id === targetId || !friendly(rec)) continue;
      this.narrow++;
      if (d.rayHit(rec, fx, fy, dx, dy, maxDist, bp.x[i]!, bp.y[i]!, bp.angle[i]!) !== null) {
        this.lastBlockerId = rec.id;
        this.lastBlockerX = bp.x[i]!;
        this.lastBlockerY = bp.y[i]!;
        return true;
      }
    }
    return false;
  }

  private rebuild(tick: number, version: number): void {
    const d = this.deps;
    const bp = this.bp;
    bp.begin();
    for (const rec of d.registry.all()) {
      const b = slotBase(rec.slot);
      bp.add(rec, d.sabF32[b + SLOT_X_OFF]!, d.sabF32[b + SLOT_Y_OFF]!, d.sabF32[b + SLOT_ANGLE_OFF]!);
    }
    bp.end();
    this.builtTick = tick;
    this.builtVersion = version;
    this.builds++;
  }
}
