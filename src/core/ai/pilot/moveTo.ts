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
import { navHull } from '../../../shared-types/shipScale/navTuning.js';
import type { AiEntity, AiWorldView, IAiNavRoutes, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import {
  CALM_CRUISE_FRAC, LEADER_CRUISE_THROTTLE, MOVE_ARRIVE_SLOW_RADIUS, MOVE_SETTLE_HULL_FRAC, MOVE_SETTLE_RELEASE_MUL,
} from '../hostileDroneTuning.js';
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
  /** Settle band (u): inside it the ship counts as at its spot; never less
   *  than one tap's coast (thrust per tick / damping), else a share of the
   *  hull radius (`MOVE_SETTLE_HULL_FRAC`), so a big hull doesn't keep
   *  tapping thrust to correct a few units. */
  private readonly settleBand: number;
  /** Settled at (settledX, settledY): stays settled until the error passes
   *  `MOVE_SETTLE_RELEASE_MUL` bands (hysteresis) or the spot moves. */
  private settled = false;
  private settledX = 0;
  private settledY = 0;

  constructor(
    private readonly kind: ShipKind,
    private readonly handling: PilotHandling,
    private readonly shieldPad: number,
    private readonly avoid: HullAvoid,
  ) {
    const tapCoast = handling.linearDamping > 0 ? handling.thrustAccel / handling.linearDamping : 0;
    this.settleBand = Math.max(tapCoast, kind.radius * MOVE_SETTLE_HULL_FRAC);
  }

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
      this.settled = false;
      this.out(facingOf(av.x, av.y), self.vx + av.x * h.maxSpeed, self.vy + av.y * h.maxSpeed, boostOk);
      return true;
    }
    // Round rock: fly the route's next waypoint, braking for what lies ahead on it.
    // A capital plans with its nose and turning radius: no U-turn where it has no room (slice 11).
    const cap = this.kind.sizeClass === 'capital';
    if (nav !== null && nav.waypoint(self.id, self.x, self.y, tx, ty, navHull(this.kind), t.wingmanArrive, false,
      self.angle, cap ? pilotTurnRadius(h) : 0)) {
      const w = arrive(self.x, self.y, nav.wpX, nav.wpY, 1, this.steerScratch), v = Math.min(cruiseCap >= 0 ? cruiseCap : this.handling.cruiseSpeed * CALM_CRUISE_FRAC, brakingSpeed(this.handling, nav.ahead), nav.turnSpeed);
      this.settled = false;
      this.out(facingOf(w.dirX, w.dirY), w.dirX * v, w.dirY * v, boostOk);
      return false;
    }
    const steer = arrive(self.x, self.y, tx, ty, MOVE_ARRIVE_SLOW_RADIUS, this.steerScratch);
    // Close in: keep the nose where it is and just brake (no turn-around for
    // an overshoot). A flock follower keeps it inside its flock spacing; an
    // owner's order (cruiseCap >= 0: Move, Retreat) only inside the arrival
    // radius, so a short move beside or behind the ship turns and flies there
    // instead of sliding sideways or backwards on reverse thrust. Once arrived
    // the travel writes cruiseCap -1 again, so a small overshoot never spins it round.
    const keepNose = cruiseCap >= 0 ? t.wingmanArrive : t.flockFollow;
    if (this.arrived(self, tx, ty, steer.dist, keepNose)) {
      this.out(self.angle, 0, 0, false);
      return false;
    }
    // A flock leader cruises SLOWER than its full-cruise followers so they
    // tighten into the herd around it (the "make the leader wait" lever).
    const cruise = cruiseCap >= 0
      ? cruiseCap
      : this.handling.cruiseSpeed * CALM_CRUISE_FRAC * (leaderCruise ? LEADER_CRUISE_THROTTLE : 1);
    const speed = Math.min(cruise, brakingSpeed(this.handling, steer.dist));
    const facing = steer.dist > keepNose ? facingOf(steer.dirX, steer.dirY) : self.angle;
    this.out(facing, steer.dirX * speed, steer.dirY * speed, boostOk);
    return false;
  }

  /** At the spot: the pilot brakes to zero and lets go, as a player who has
   *  arrived does. Inside the settle band any press can only overshoot (a
   *  fighter gains 18 u/s a tick); for a big hull a few units off its spot are
   *  nothing worth thrusting for. With the nose held (`keepNose`), thrust only
   *  corrects the error along the nose, so only that part counts: a sideways
   *  offset no press can fix never keeps the engines tapping. Once settled it
   *  flies again only past `MOVE_SETTLE_RELEASE_MUL` bands, or for a new spot. */
  private arrived(self: AiEntity, tx: number, ty: number, dist: number, keepNose: number): boolean {
    const band = this.settleBand;
    if (this.settled && Math.hypot(tx - this.settledX, ty - this.settledY) > band) this.settled = false;
    // Forward is (-sin θ, cos θ).
    const err = dist > keepNose ? dist : Math.abs((ty - self.y) * Math.cos(self.angle) - (tx - self.x) * Math.sin(self.angle));
    if (err <= band || (this.settled && err <= band * MOVE_SETTLE_RELEASE_MUL)) {
      if (!this.settled) { this.settled = true; this.settledX = tx; this.settledY = ty; }
      return true;
    }
    this.settled = false;
    return false;
  }
}
