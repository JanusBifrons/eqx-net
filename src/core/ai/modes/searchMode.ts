/**
 * Hunt search (peacetime job `JOB_SEARCH`): an expanding square (the standard
 * search pattern) round where the search began, legs `HUNT_LEG_SPACING_MUL`
 * sighting ranges apart (d, d, 2d, 2d, 3d, ...; each turn 90° left), the
 * first leg along the nose. Each leg is the brain's plain fly-to (player
 * controls); a leg counts as flown once inside the arrive radius, so the ship
 * rolls on without stopping. Waypoints are clamped inside the sector; once
 * the square outgrows the sector the search starts again from where the ship
 * is. A fight that ends restarts it from there (`reset`, set by the brain's
 * combat branch and `setHunt`).
 */
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../shared-types/sectorBounds.js';
import { HUNT_EDGE_FRAC, HUNT_LEG_SPACING_MUL, MOVE_ARRIVE_SLOW_RADIUS, TRAVEL_NONE } from '../hostileDroneTuning.js';
import {
  MODE_GOAL_MOVE_TO, type IPilotMode, type PilotModeContext, type PilotModeGoal, type PilotOrderModes,
} from '../tactics/manoeuvre.js';

export class SearchMode implements IPilotMode {
  /** Hunt (RTS Part B slice 6, `setHunt`): no leash, on-sight engagement out
   *  to the sensor range, and with nothing to fight the ship searches the
   *  sector in an expanding square round where the search began. */
  on = false;
  /** The search (re)starts from where the ship is on its next idle tick. */
  reset = true;
  /** Current leg (0-based), its unit direction and its end point. */
  private leg = 0;
  private dirX = 0;
  private dirY = 1;
  private wpX = 0;
  private wpY = 0;

  /** `sensorRange`: the brain's sighting range (fixed per brain). */
  constructor(private readonly sensorRange: number) {}

  /** Hunt on / off (`setHunt`): on lifts the guard leash, the move target,
   *  a travel and a follower role; a search not running restarts. */
  hunt(on: boolean, o: PilotOrderModes): void {
    if (on) {
      o.guard.on = false;
      o.course.moveTarget = null;
      o.travel.state = TRAVEL_NONE;
      o.flock.leaderId = null;
      o.course.leaderCruise = false;
      if (!this.on) this.reset = true;
    }
    this.on = on;
  }

  begin(_ctx: PilotModeContext): void {}

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    const self = ctx.self;
    const lim = SECTOR_PLAYABLE_HALF_EXTENT * HUNT_EDGE_FRAC;
    const d = HUNT_LEG_SPACING_MUL * this.sensorRange;
    if (this.reset) {
      this.reset = false;
      this.leg = 0;
      this.dirX = -Math.sin(self.angle);
      this.dirY = Math.cos(self.angle);
      this.wpX = self.x;
      this.wpY = self.y;
      this.nextLeg(d, lim);
    }
    // This leg flown (or clamped to where the ship already is): the next.
    for (let i = 0; i < 4; i++) {
      const dx = this.wpX - self.x;
      const dy = this.wpY - self.y;
      if (dx * dx + dy * dy > MOVE_ARRIVE_SLOW_RADIUS * MOVE_ARRIVE_SLOW_RADIUS) break;
      this.leg++;
      // Turn 90° left: (x, y) → (-y, x).
      const t = this.dirX;
      this.dirX = -this.dirY;
      this.dirY = t;
      if ((Math.floor(this.leg / 2) + 1) * d > 2 * lim) {
        // The square covers the sector: a new one from here.
        this.leg = 0;
        this.wpX = self.x;
        this.wpY = self.y;
      }
      this.nextLeg(d, lim);
    }
    out.kind = MODE_GOAL_MOVE_TO;
    out.tx = this.wpX;
    out.ty = this.wpY;
    out.cruiseCap = -1;
    out.boost = false;
  }

  /** Open-ended: the hunt ends by order, not by the search. */
  isDone(_ctx: PilotModeContext): boolean {
    return false;
  }

  /** The end of leg `leg` from the last waypoint, clamped inside the sector. */
  private nextLeg(d: number, lim: number): void {
    const len = (Math.floor(this.leg / 2) + 1) * d;
    let x = this.wpX + this.dirX * len;
    let y = this.wpY + this.dirY * len;
    if (x > lim) x = lim; else if (x < -lim) x = -lim;
    if (y > lim) y = lim; else if (y < -lim) y = -lim;
    this.wpX = x;
    this.wpY = y;
  }
}
