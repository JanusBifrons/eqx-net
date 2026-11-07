/**
 * Warp travel (plan prancy-squishing-donut Phase 4, travel state step 1).
 *
 * The run of a warp is a pseudo state: once a ship has visibly left, it is out
 * of the world for everyone else until it drops out at the destination. The
 * physics already makes the run untouchable (colliders off, World.applyInput);
 * this tracker owns the rest, decided from each pilot's warp phase (read from
 * the SAB flags every tick):
 *
 *  - ENTER the run (→ cruise): the ship is TRAVELLING (hidden from others' snapshots,
 *    not targetable, not damageable). If the drop point is blocked, the run is
 *    retargeted to the nearest clear spot (the worker lands it there).
 *  - LEAVE the run (cruise → idle): travelling ends; the ship is "just arrived"
 *    for ARRIVED_TICKS so every client in range draws the drop. If it was
 *    retargeted, its pose epoch bumps so the pilot's client re-seeds its
 *    prediction at the real landing point (no correction slide).
 *
 * While travelling, the pilot's interest window sits on the destination, so
 * nothing along the route is sent and the destination streams in early.
 *
 * Decisions only; the room injects the effects (TransitOrchestrator pattern).
 * Steady state: one Map lookup per tracked pilot per tick, no allocation.
 */

/** Ticks a landed ship counts as "just arrived" (drop effect window). */
export const ARRIVED_TICKS = 30;
/** A clear spot closer than this to the drop point is "the drop point". */
const RETARGET_EPS = 1;

export interface WarpTravelHooks {
  /** 0 idle, 1 spooling, 2 running (SAB flags). */
  phaseOf(playerId: string): 0 | 1 | 2;
  /** Nearest clear landing spot to (x, y) for this pilot's ship. */
  clearPointNear(playerId: string, x: number, y: number): { x: number; y: number };
  /** Move the running warp's drop point (worker WARP_RETARGET). */
  retarget(playerId: string, x: number, y: number): void;
  /** Mark the ship travelling (or not). */
  setTravelling(playerId: string, on: boolean): void;
  /** Tell the pilot's client to re-seed its prediction (poseEpoch++). */
  bumpPoseEpoch(playerId: string): void;
}

interface Rec {
  phase: 0 | 1 | 2;
  /** Last validated drop point the pilot asked for. */
  tx: number; ty: number;
  /** Where the run actually lands (clear spot). */
  lx: number; ly: number;
  retargeted: boolean;
  arrivedUntil: number;
}

export class WarpTravelTracker {
  private readonly recs = new Map<string, Rec>();
  private readonly point = { x: 0, y: 0 };

  constructor(private readonly hooks: WarpTravelHooks) {}

  /** A validated warp request arrived (input handler). */
  noteRequest(playerId: string, x: number, y: number): void {
    let r = this.recs.get(playerId);
    if (!r) {
      r = { phase: 0, tx: x, ty: y, lx: x, ly: y, retargeted: false, arrivedUntil: -1 };
      this.recs.set(playerId, r);
    }
    if (r.phase !== 2) { r.tx = x; r.ty = y; }
  }

  /** Once per server tick, after the SAB pose mirror. */
  tick(serverTick: number): void {
    if (this.recs.size === 0) return;
    for (const [pid, r] of this.recs) {
      const phase = this.hooks.phaseOf(pid);
      if (phase === 2 && r.phase !== 2) {
        // Into the run: out of the world; land clear of anything at the drop.
        this.hooks.setTravelling(pid, true);
        const c = this.hooks.clearPointNear(pid, r.tx, r.ty);
        r.lx = c.x; r.ly = c.y;
        r.retargeted = Math.hypot(c.x - r.tx, c.y - r.ty) > RETARGET_EPS;
        if (r.retargeted) this.hooks.retarget(pid, c.x, c.y);
      } else if (phase !== 2 && r.phase === 2) {
        // Out of the run: back in the world, at the landing point.
        this.hooks.setTravelling(pid, false);
        r.arrivedUntil = serverTick + ARRIVED_TICKS;
        if (r.retargeted) this.hooks.bumpPoseEpoch(pid);
        r.retargeted = false;
      }
      r.phase = phase;
      if (phase === 0 && serverTick >= r.arrivedUntil) this.recs.delete(pid);
    }
  }

  /** A ship just appeared here another way (a join or a sector arrival):
   *  every client draws the same drop effect for it. */
  markArrived(playerId: string, serverTick: number): void {
    let r = this.recs.get(playerId);
    if (!r) {
      r = { phase: 0, tx: 0, ty: 0, lx: 0, ly: 0, retargeted: false, arrivedUntil: -1 };
      this.recs.set(playerId, r);
    }
    r.arrivedUntil = serverTick + ARRIVED_TICKS;
  }

  /** True while the pilot's ship is on the run. */
  isTravelling(playerId: string): boolean {
    return this.recs.get(playerId)?.phase === 2;
  }

  /** Where the pilot's interest window should sit (the landing point) while
   *  travelling; null otherwise. Reused object: read it at once. */
  interestPoint(playerId: string): { x: number; y: number } | null {
    const r = this.recs.get(playerId);
    if (r === undefined || r.phase !== 2) return null;
    this.point.x = r.lx; this.point.y = r.ly;
    return this.point;
  }

  /** True for ARRIVED_TICKS after the ship dropped out. */
  arrivedRecently(playerId: string, serverTick: number): boolean {
    const r = this.recs.get(playerId);
    return r !== undefined && r.phase === 0 && serverTick < r.arrivedUntil;
  }

  /** The pilot left the room. */
  forget(playerId: string): void {
    this.recs.delete(playerId);
  }
}
