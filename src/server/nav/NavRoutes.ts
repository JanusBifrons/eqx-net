/**
 * Each AI-flown ship's nav route to its current goal (navigation slice 7):
 * the room's `IAiNavRoutes`, handed to brains as `view.nav`.
 *
 * A brain flying to a goal (`tickMoveTo`) asks for the waypoint to fly to
 * now. A new goal starts one plan on the nav worker (`NavField.route`); until
 * it answers, and when the straight line is clear or no way fits, there is no
 * waypoint and the brain flies straight as before. The route itself is a
 * `NavRoute` walked by the one `stepRoute` (open mode).
 *
 * No way fits (slice 9): the planner's route ends at the reachable point
 * nearest the goal; the ship flies there and waits on it (the last waypoint
 * stays its waypoint) until the goal changes (owner, 2026-11-17).
 *
 * Stuck (slice 9, game time #20): a ship far from its goal that has moved
 * less than its arrive distance in `NAV_STUCK_MS` plans again from where it
 * is; after `NAV_STUCK_REPLANS` such plans it waits where it is. A waiting
 * ship asks again every `NAV_WAIT_RETRY_MS` (the way may have opened).
 *
 * Main thread, per tick: allocation-free except one record the first time a
 * ship asks, and the request itself on a goal change (a discrete event).
 */
import type { NavHull } from '../../shared-types/shipScale/navTuning.js';
import type { IAiNavRoutes } from '../../core/contracts/IAiBehaviour.js';
import { createNavRoute, setNavRoute, stepNavRoute, type NavRoute } from '../../core/ai/stepRoute.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';

/** Plans a route (the room's `NavField.route`). */
export type NavRouteRequest = (sx: number, sy: number, tx: number, ty: number, hull: NavHull, heading: number, turnRadius: number) => Promise<NavRouteMsg>;

/** A ship not asking for this long (game ms) is forgotten. */
const NAV_FORGET_MS = 10_000;
/** At most one plan per ship this often (game ms), however the goal moves. */
const NAV_REPLAN_MS = 1_000;
/** Progress check period (game ms). */
const NAV_STUCK_MS = 4_000;
/** Plans from where a stuck ship is, before it waits there. */
const NAV_STUCK_REPLANS = 2;
/** A waiting ship (short route, or stuck) asks again this often (game ms). */
const NAV_WAIT_RETRY_MS = 10_000;
/** How far off its route a ship may swing in a turn, as a fraction of its
 *  clearance (sets how hard it brakes for a corner; 6 u for a fighter cleared
 *  the streets flight 4/4 where 24 u still brushed rock, 2026-11-19). */
const NAV_TURN_SWING = 0.2;
/** Asked with no nose (heading NaN), a ship out of a corner holds its turn
 *  speed this many times as long as its nose needs to swing the corner's
 *  angle (θ / turn rate): margin for a nose already off the old leg. */
const NAV_TURN_HOLD = 1.5;
/** With the nose known, the hold out of a corner ends once the nose is within
 *  10° of the aim point (the cap there is many times any cruise). */
const NAV_TURN_ROUND_COS = Math.cos((10 * Math.PI) / 180);

interface ShipNav {
  readonly route: NavRoute;
  goalX: number;
  goalY: number;
  /** Bumped on each new plan; a reply for an older one is dropped. */
  gen: number;
  pending: boolean;
  /** The route ends short of the goal (`nearest`): wait at its end. */
  short: boolean;
  askedAt: number;
  /** Progress check: where the ship was at `chkAt`, and stuck checks in a row. */
  chkAt: number;
  chkX: number;
  chkY: number;
  stuck: number;
  usedAt: number;
  /** The leg flown last call (a new leg = a corner just passed), and the
   *  turn speed held out of that corner until `holdUntil` (game ms). */
  turnLeg: number;
  holdUntil: number;
  holdSpeed: number;
}

export class NavRoutes implements IAiNavRoutes {
  wpX = 0;
  wpY = 0;
  /** The route corner the ship is flying to now (`wpX`/`wpY` is the aim point on its leg). */
  turnX = 0;
  turnY = 0;
  ahead = 0;
  /** Speed cap (u/s) while the nose comes round a corner just passed; Infinity otherwise. */
  turnSpeed = Infinity;
  /** Plans asked for (count gate), and answered with a route. */
  requests = 0;
  routed = 0;
  /** Plans answered with a route that ends short of the goal. */
  short = 0;
  /** Plans made because a ship was stuck, and ships that then waited. */
  stuckReplans = 0;
  held = 0;
  private readonly ships = new Map<string, ShipNav>();
  private nextSweep = 0;

  constructor(private readonly request: NavRouteRequest, private readonly now: () => number) {}

  /** This call's nose and turning radius (passed on to its plans, slice 11). */
  private heading = NaN;
  private turnRadius = 0;
  private hull: NavHull = { clearance: 0, comfort: 0, beam: 0, turnRate: 0 };

  /** Ships with a record (diagnostics, tests). */
  get size(): number { return this.ships.size; }

  waypoint(entityId: string, x: number, y: number, tx: number, ty: number, hull: NavHull, arrive: number, keep = false,
    heading = NaN, turnRadius = 0): boolean {
    this.heading = heading; this.turnRadius = turnRadius; this.hull = hull;
    const clearance = hull.clearance;
    const now = this.now();
    if (now >= this.nextSweep) this.sweep(now);
    let s = this.ships.get(entityId);
    if (s === undefined) {
      s = { route: createNavRoute(), goalX: NaN, goalY: NaN, gen: 0, pending: false, short: false, askedAt: -Infinity, usedAt: now, chkAt: now, chkX: x, chkY: y, stuck: 0,
        turnLeg: 0, holdUntil: -Infinity, holdSpeed: Infinity };
      this.ships.set(entityId, s);
    }
    s.usedAt = now;
    const gdx = tx - s.goalX, gdy = ty - s.goalY;
    if (!(gdx * gdx + gdy * gdy <= arrive * arrive)) {
      // A new goal: the old route leads elsewhere (a moving goal kept: near enough until the new plan lands).
      if (!keep) { s.route.count = 0; s.short = false; }
      s.stuck = 0; s.chkAt = now; s.chkX = x; s.chkY = y;
      if (!s.pending && now - s.askedAt >= NAV_REPLAN_MS) this.plan(s, x, y, tx, ty, now);
    } else if (s.short) {
      if (!s.pending && now - s.askedAt >= NAV_WAIT_RETRY_MS) {
        s.stuck = 0; s.chkAt = now; s.chkX = x; s.chkY = y; // a fresh start if the way has opened
        this.plan(s, x, y, tx, ty, now);
      }
    } else if (now - s.chkAt >= NAV_STUCK_MS) {
      this.progress(s, x, y, tx, ty, arrive, now);
    }
    let leg = stepNavRoute(s.route, x, y, arrive);
    if (leg < 0) {
      if (!s.short || s.route.count === 0) { this.turnSpeed = Infinity; return false; }
      leg = s.route.count - 1; // as close as it gets: wait there
    }
    const p = s.route.points;
    if (leg !== s.turnLeg) {
      if (leg === s.turnLeg + 1) this.holdTurn(s, leg, hull, now); // a corner just passed
      else s.holdUntil = -Infinity; // a new route
      s.turnLeg = leg;
    }
    const wx = p[leg * 2]!, wy = p[leg * 2 + 1]!;
    const dx = wx - x, dy = wy - y, d = Math.sqrt(dx * dx + dy * dy);
    let ahead = d;
    const px = leg > 0 ? p[leg * 2 - 2]! : s.route.sx, py = leg > 0 ? p[leg * 2 - 1]! : s.route.sy;
    if (leg + 1 < s.route.count) {
      // A corner: the next leg counts as far as it runs the same way as this
      // leg (not the ship's bearing to the corner, which swings as it closes),
      // and no further than lets the ship kill its sideways speed in the turn
      // within a fifth of its clearance: drift (v·sinθ)²/2a ⇒ extra ≤ swing / sin²θ.
      const nx = p[leg * 2 + 2]! - wx, ny = p[leg * 2 + 3]! - wy, nl = Math.sqrt(nx * nx + ny * ny);
      let ix = wx - px, iy = wy - py, il = Math.sqrt(ix * ix + iy * iy);
      if (!(il > 1e-6)) { ix = dx; iy = dy; il = d; } // no incoming leg known: from the ship
      if (nl > 1e-6 && il > 1e-6) {
        const cs = Math.max(0, (ix * nx + iy * ny) / (il * nl));
        ahead += Math.min(nl * cs, (clearance * NAV_TURN_SWING) / Math.max(1e-6, 1 - cs * cs));
      }
    }
    // Fly the leg, not at its corner: aim one arrive distance ahead of the ship's
    // place on the leg (never past the corner), so a ship swung wide by a turn
    // comes back onto the route's line instead of cutting across towards rock.
    let ax = wx, ay = wy;
    if (px === px && py === py) { // the incoming leg is known (not NaN)
      const lx = wx - px, ly = wy - py, len = Math.sqrt(lx * lx + ly * ly);
      if (len > 1e-6) {
        const along = Math.max(0, ((x - px) * lx + (y - py) * ly) / len) + arrive;
        if (along < len) { ax = px + (lx * along) / len; ay = py + (ly * along) / len; }
      }
    }
    this.turnSpeed = this.turnCap(s, x, y, ax, ay, hull, now);
    this.wpX = ax; this.wpY = ay; this.turnX = wx; this.turnY = wy; this.ahead = ahead;
    return true;
  }

  /**
   * Out of the corner at the start of `leg`: hold the speed whose swing off
   * the new leg stays within `NAV_TURN_SWING` × clearance while the nose comes
   * round. The pilot thrusts along its nose as it turns (the wanted course's
   * share along it, v·cosφ), so a nose swinging θ at turn rate ω drifts the
   * ship v·sin²θ / 2ω off the new leg ⇒ v ≤ 2ω·swing / sin²θ (past 90°, the
   * 90° figure). With the nose known, `turnCap` holds it until the nose is
   * round, by the angle it has left; without, for `NAV_TURN_HOLD` × θ / ω. Measured on the streets
   * flight: a fighter stalled at a 76° corner and left it at the leg's full
   * cruise ran 33 u off the line into rock; the model says 31 u.
   */
  private holdTurn(s: ShipNav, leg: number, hull: NavHull, now: number): void {
    s.holdUntil = -Infinity;
    const p = s.route.points, w = hull.turnRate;
    const cx = p[leg * 2 - 2]!, cy = p[leg * 2 - 1]!;
    const qx = leg > 1 ? p[leg * 2 - 4]! : s.route.sx, qy = leg > 1 ? p[leg * 2 - 3]! : s.route.sy;
    const ix = cx - qx, iy = cy - qy, il = Math.sqrt(ix * ix + iy * iy);
    const ox = p[leg * 2]! - cx, oy = p[leg * 2 + 1]! - cy, ol = Math.sqrt(ox * ox + oy * oy);
    if (!(w > 0) || !(il > 1e-6) || !(ol > 1e-6)) return; // NaN start or a zero leg: no corner known
    const cs = Math.max(-1, Math.min(1, (ix * ox + iy * oy) / (il * ol)));
    const sin2 = cs < 0 ? 1 : 1 - cs * cs;
    s.holdSpeed = (2 * w * hull.clearance * NAV_TURN_SWING) / Math.max(1e-6, sin2);
    // The nose known: held until it is round (turnCap); else for a time.
    s.holdUntil = this.heading === this.heading ? Infinity : now + (1000 * NAV_TURN_HOLD * Math.acos(cs)) / w;
  }

  /**
   * This call's speed cap out of a corner (`holdTurn`). With the nose known
   * the cap follows what is left of its swing: φ between the nose and the aim
   * point gives v ≤ 2ω·swing / sin²φ (90° and past: the 90° figure), so a ship
   * stalled at the corner creeps out, and one whose nose is already round is
   * not held at all. Without a nose: the timed hold's corner figure.
   */
  private turnCap(s: ShipNav, x: number, y: number, ax: number, ay: number, hull: NavHull, now: number): number {
    if (!(now < s.holdUntil)) return Infinity;
    const a = this.heading;
    const dx = ax - x, dy = ay - y, dl = Math.sqrt(dx * dx + dy * dy);
    if (a !== a || !(dl > 1e-6)) return s.holdSpeed;
    const c = (-Math.sin(a) * dx + Math.cos(a) * dy) / dl; // nose (-sin a, cos a) · aim
    if (c >= NAV_TURN_ROUND_COS) { s.holdUntil = -Infinity; return Infinity; } // round: the hold is over
    const sin2 = c < 0 ? 1 : 1 - c * c;
    return (2 * hull.turnRate * hull.clearance * NAV_TURN_SWING) / sin2;
  }

  /** Does the ship wait short of its goal (no way fits, or stuck)? */
  waiting(entityId: string): boolean { return this.ships.get(entityId)?.short === true; }

  /** Drop a ship's route (it left or died). */
  forget(entityId: string): void { this.ships.delete(entityId); }

  private plan(s: ShipNav, x: number, y: number, tx: number, ty: number, now: number): void {
    s.goalX = tx; s.goalY = ty;
    s.pending = true;
    s.askedAt = now;
    const gen = ++s.gen;
    this.requests++;
    this.request(x, y, tx, ty, this.hull, this.turnRadius > 0 ? this.heading : NaN, this.turnRadius).then((msg) => {
      if (s.gen !== gen) return;
      s.pending = false;
      if (msg.status === 'straight') { s.route.count = 0; s.short = false; } // the way is clear (again)
      else if (msg.status === 'route' || msg.status === 'nearest') {
        setNavRoute(s.route, msg.points, x, y); // planned from (x, y): the first turn's incoming leg
        s.short = msg.status === 'nearest';
        if (s.short) this.short++; else this.routed++;
      }
    }, () => { if (s.gen === gen) s.pending = false; });
  }

  /** The periodic stuck check: plan again from here, or wait here. */
  private progress(s: ShipNav, x: number, y: number, tx: number, ty: number, arrive: number, now: number): void {
    const mx = x - s.chkX, my = y - s.chkY, gx = tx - x, gy = ty - y;
    s.chkAt = now; s.chkX = x; s.chkY = y;
    if (mx * mx + my * my >= arrive * arrive || gx * gx + gy * gy <= 4 * arrive * arrive) { s.stuck = 0; return; }
    s.stuck++;
    if (s.stuck <= NAV_STUCK_REPLANS) {
      if (!s.pending) { this.stuckReplans++; this.plan(s, x, y, tx, ty, now); }
      return;
    }
    // Plans did not help: wait where it is (retried every NAV_WAIT_RETRY_MS).
    s.gen++; s.pending = false; s.askedAt = now;
    s.route.points[0] = x; s.route.points[1] = y; s.route.count = 1; s.route.leg = 0;
    s.short = true;
    this.held++;
  }

  private sweep(now: number): void {
    this.nextSweep = now + NAV_FORGET_MS;
    for (const [id, s] of this.ships) if (now - s.usedAt > NAV_FORGET_MS) this.ships.delete(id);
  }
}
