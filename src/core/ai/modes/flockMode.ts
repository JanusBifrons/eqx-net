/**
 * Flock follow (peacetime job `JOB_FLOCK`): leader-led flocking (non-combat
 * herding), the FOLLOWER path. Continuously steer toward a standard boids
 * blend resolved against LIVE poses every tick: COHESION toward the leader
 * with an ARRIVAL ramp (slows as it nears the follow-distance — "slow down
 * once close"), ALIGNMENT with the leader's heading (the herd flies as one
 * along the leader's course), and SEPARATION from squad neighbours (holds
 * spacing, spreads the blob into a herd). The wanted velocity is the calm
 * cruise scaled by the boids magnitude — NO boost: the arrival ramp + the
 * pilot's braking settle the follower into the cluster with no
 * overshoot/fling, and the LEADER is throttled / waits (see
 * `LEADER_CRUISE_THROTTLE` + the director) so a full-cruise follower can
 * catch it. The boids maths lives in `flocking.ts`.
 *
 * The brain calls `sense` first: with the leader gone (or no resolver) the
 * ship flies its next job instead (`pilotJob(JOB_ORDER_NO_FLOCK)`).
 */
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import type { AiEntityPoseOut, AiWorldView } from '../../contracts/IAiBehaviour.js';
import {
  addAlignment,
  addCohesion,
  addSeparation,
  FLOCK_COHESION_GAIN,
  makeFlockAccumulator,
  makeFlockOutput,
  resetFlock,
  resolveFlock,
  type FlockAccumulator,
  type FlockOutput,
} from '../flocking.js';
import { CALM_CRUISE_FRAC, FLOCK_ACTIVITY_GAP_MUL, FLOCK_CATCH_UP } from '../hostileDroneTuning.js';
import { DEFAULT_PILOT_PARAMS, facingOf } from '../virtualPilot.js';
import { MODE_GOAL_FLY, type IPilotMode, type PilotModeContext, type PilotModeGoal } from '../tactics/manoeuvre.js';

export class FlockMode implements IPilotMode {
  /** The leader this ship follows; null = none (it leads or flies alone).
   *  The brain's `pilotJob()` reads it. */
  leaderId: string | null = null;
  /** Squad member ids for the separation rule. Owned (copied on assignment)
   *  so the director may reuse its source array. */
  private readonly memberIds: string[] = [];
  /** Alloc-free flocking scratch (invariant #14) — all allocated once here. */
  private readonly acc: FlockAccumulator = makeFlockAccumulator();
  private readonly out: FlockOutput = makeFlockOutput();
  private readonly leader: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly neighbour: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** Squared distance to the leader at the last flock tick (Infinity until
   *  one), and the leader it was measured to: the panel's activity. */
  private gap2 = Infinity;
  private leaderPrev: string | null = null;
  /** This tick's resolver (set by `sense`). */
  private resolve: AiWorldView['resolveEntityInto'] = undefined;

  /** Follow `leaderId` with squad `memberIds` (`setFlockFollow`). */
  follow(leaderId: string, memberIds: readonly string[]): void {
    this.leaderId = leaderId;
    if (this.leaderPrev !== leaderId) this.gap2 = Infinity;
    this.leaderPrev = leaderId;
    this.memberIds.length = 0;
    for (let i = 0; i < memberIds.length; i++) this.memberIds.push(memberIds[i]!);
  }

  /** Read the leader's live pose; false when it (or the resolver) is gone. */
  sense(view: AiWorldView): boolean {
    const resolve = view.resolveEntityInto;
    this.resolve = resolve;
    return resolve !== undefined && this.leaderId !== null && resolve(this.leaderId, this.leader);
  }

  /** Activity: close enough to its pack to count as guarding it. */
  isWithPack(kind: ShipKind): boolean {
    const r = FLOCK_ACTIVITY_GAP_MUL * shipTuning(kind).flockFollow;
    return this.gap2 <= r * r;
  }

  begin(_ctx: PilotModeContext): void {}

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    const self = ctx.self;
    const resolve = this.resolve!;
    const leaderX = this.leader.x;
    const leaderY = this.leader.y;
    const acc = this.acc;
    resetFlock(acc);
    // COHESION toward the leader (its position is the herd's anchor — followers
    // bunch AROUND it) with the arrival ramp baked into addCohesion. SEPARATION
    // from every squad neighbour (incl. the leader) so they cluster around it at
    // a spacing rather than piling on. ALIGNMENT with the leader's heading so the
    // herd flies the course as one + keeps pace.
    const tuning = shipTuning(ctx.kind);
    addCohesion(acc, self.x, self.y, leaderX, leaderY, FLOCK_COHESION_GAIN, tuning.flockFollow);
    const gx = leaderX - self.x;
    const gy = leaderY - self.y;
    this.gap2 = gx * gx + gy * gy;
    for (let i = 0; i < this.memberIds.length; i++) {
      const mid = this.memberIds[i]!;
      if (mid === self.id) continue;
      const mx = mid === this.leaderId ? leaderX : (resolve(mid, this.neighbour) ? this.neighbour.x : NaN);
      if (Number.isNaN(mx)) continue;
      const my = mid === this.leaderId ? leaderY : this.neighbour.y;
      addSeparation(acc, self.x, self.y, mx, my, tuning.flockSeparation);
    }
    addAlignment(acc, this.leader.angle);
    const flock = resolveFlock(acc, this.out);
    out.kind = MODE_GOAL_FLY;
    out.boost = false;
    out.params = DEFAULT_PILOT_PARAMS;
    if (flock.thrustScale <= 1e-4) {
      out.facing = self.angle;
      out.vx = 0;
      out.vy = 0;
      return;
    }
    // Calm cruise scaled by the boids desired-velocity magnitude. As the follower
    // settles at the follow-radius, cohesion ramps to ~0 and separation cancels
    // it, so the magnitude shrinks toward the alignment term alone → the pilot
    // eases off (and brakes the residual). A leader faster than that (a pilot
    // flying the squad's lead ship, RTS Part B slice 10; it cannot be made to
    // wait) sets the pace: a little over its speed so the pack closes up,
    // never over this ship's top speed and never boosting. An AI pilots' pack
    // leader is throttled below the calm cruise, so its pack is unchanged.
    const h = ctx.handling;
    const lv = Math.hypot(this.leader.vx, this.leader.vy);
    const pace = Math.min(h.maxSpeed, Math.max(h.cruiseSpeed * CALM_CRUISE_FRAC, lv * FLOCK_CATCH_UP));
    const speed = pace * flock.thrustScale;
    out.facing = facingOf(flock.dirX, flock.dirY);
    out.vx = flock.dirX * speed;
    out.vy = flock.dirY * speed;
  }

  /** Open-ended: the flock ends by order (a new job setter). */
  isDone(_ctx: PilotModeContext): boolean {
    return false;
  }
}
