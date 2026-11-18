/**
 * The brain's shared fly-to (`MODE_GOAL_MOVE_TO`): fly to (tx, ty) and stop
 * there. Owned by `HostileDroneBehaviour` and built once. Each call writes the
 * pilot's wanted facing, velocity and boost into this object's out fields; the
 * brain flies them through the virtual pilot. Allocation-free (#14).
 *
 * Face the slot and ask the pilot for a speed it can still brake from (the
 * arrive ramp), capped at the calm cruise (or `cruiseCap`: an owner's Move
 * flies at the full cruise, a long leg at the top speed with `boostOk`,
 * `modes/travelMode.ts`). At the slot the wanted velocity is zero and the nose
 * stays put, so the pilot brakes to a stop with reverse instead of turning
 * around. A wreck piece or drifting rock on a collision course is dodged
 * first; round rock it flies the nav route's next waypoint.
 */
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiWorldView, IAiNavRoutes, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import { CALM_CRUISE_FRAC, LEADER_CRUISE_THROTTLE, MOVE_ARRIVE_SLOW_RADIUS } from '../hostileDroneTuning.js';
import type { HullAvoid } from '../hullAvoid.js';
import { arrive, makeSteerOutput, type SteerOutput } from '../steering.js';
import { brakingSpeed, facingOf, pilotTurnRadius, type PilotHandling } from '../virtualPilot.js';

export class MoveToHelm {
  /** Out: the facing, wanted velocity and boost to fly. */
  facing = 0;
  wvx = 0;
  wvy = 0;
  boost = false;
  /** Reused arrive() output (alloc-free hot path, invariant #14). */
  private readonly steerScratch: SteerOutput = makeSteerOutput();
  /** This tick's routes round rock (`view.nav`, navigation slice 7), debris and tick. */
  private nav: IAiNavRoutes | null = null;
  private debris: IAiNeighbourQuery | undefined;
  private viewTick = 0;

  constructor(
    private readonly kind: ShipKind,
    private readonly handling: PilotHandling,
    private readonly shieldPad: number,
    private readonly avoid: HullAvoid,
  ) {}

  /** Read this tick's routes, debris and tick (top of the brain's `tick`). */
  sense(view: AiWorldView): void {
    this.nav = view.nav ?? null; this.debris = view.debris; this.viewTick = view.tick;
  }

  private out(facing: number, wvx: number, wvy: number, boost: boolean): void {
    this.facing = facing;
    this.wvx = wvx;
    this.wvy = wvy;
    this.boost = boost;
  }

  /** Write the fly-to goal; true when it dodged a hull this tick.
   *  `avoidAccel`: the brain's dodge thrust; `leaderCruise`: a flock leader
   *  cruises slower (`LEADER_CRUISE_THROTTLE`). */
  steerTo(self: AiEntity, tx: number, ty: number, cruiseCap: number, boostOk: boolean, avoidAccel: number, leaderCruise: boolean): boolean {
    const t = shipTuning(this.kind), nav = this.nav, h = this.handling, av = this.avoid;
    // A wreck piece or drifting rock on a collision course: dodge it first (navigation slice 8).
    if (!h.torqueTurn && av.check(self, h, this.kind.radius, this.shieldPad, avoidAccel, this.viewTick, undefined, this.debris, true)) {
      this.out(facingOf(av.x, av.y), self.vx + av.x * h.maxSpeed, self.vy + av.y * h.maxSpeed, boostOk);
      return true;
    }
    // Round rock: fly the route's next waypoint, braking for what lies ahead on it.
    // A capital plans with its nose and turning radius: no U-turn where it has no room (slice 11).
    const cap = this.kind.sizeClass === 'capital';
    if (nav !== null && nav.waypoint(self.id, self.x, self.y, tx, ty, t.navClearance, t.wingmanArrive, false,
      cap ? self.angle : NaN, cap ? pilotTurnRadius(h) : 0)) {
      const w = arrive(self.x, self.y, nav.wpX, nav.wpY, 1, this.steerScratch), v = Math.min(cruiseCap >= 0 ? cruiseCap : this.handling.cruiseSpeed * CALM_CRUISE_FRAC, brakingSpeed(this.handling, nav.ahead));
      this.out(facingOf(w.dirX, w.dirY), w.dirX * v, w.dirY * v, boostOk);
      return false;
    }
    const steer = arrive(self.x, self.y, tx, ty, MOVE_ARRIVE_SLOW_RADIUS, this.steerScratch);
    // Arrived: inside the distance one tap of thrust carries this hull before
    // damping stops it (live thrust per tick / damping), any press can only
    // overshoot the slot, so the pilot brakes to zero and lets go, as a player
    // who has arrived does. Without it a light hull (a fighter gains 18 u/s a
    // tick) taps forward and back across the slot for ever.
    const tapCoast = this.handling.linearDamping > 0 ? this.handling.thrustAccel / this.handling.linearDamping : 0;
    if (steer.thrustScale <= 0 || steer.dist <= tapCoast) {
      this.out(self.angle, 0, 0, false);
      return false;
    }
    // A flock leader cruises SLOWER than its full-cruise followers so they
    // tighten into the herd around it (the "make the leader wait" lever).
    const cruise = cruiseCap >= 0
      ? cruiseCap
      : this.handling.cruiseSpeed * CALM_CRUISE_FRAC * (leaderCruise ? LEADER_CRUISE_THROTTLE : 1);
    const speed = Math.min(cruise, brakingSpeed(this.handling, steer.dist));
    // Close in: keep the nose where it is and just brake (no turn-around for
    // an overshoot of a few lengths).
    const facing = steer.dist > t.flockFollow ? facingOf(steer.dirX, steer.dirY) : self.angle;
    this.out(facing, steer.dirX * speed, steer.dirY * speed, boostOk);
    return false;
  }
}
