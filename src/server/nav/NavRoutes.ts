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
import type { IAiNavRoutes } from '../../core/contracts/IAiBehaviour.js';
import { createNavRoute, setNavRoute, stepNavRoute, type NavRoute } from '../../core/ai/stepRoute.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';

/** Plans a route (the room's `NavField.route`). */
export type NavRouteRequest = (sx: number, sy: number, tx: number, ty: number, clearance: number) => Promise<NavRouteMsg>;

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
}

export class NavRoutes implements IAiNavRoutes {
  wpX = 0;
  wpY = 0;
  ahead = 0;
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

  /** Ships with a record (diagnostics, tests). */
  get size(): number { return this.ships.size; }

  waypoint(entityId: string, x: number, y: number, tx: number, ty: number, clearance: number, arrive: number, keep = false): boolean {
    const now = this.now();
    if (now >= this.nextSweep) this.sweep(now);
    let s = this.ships.get(entityId);
    if (s === undefined) {
      s = { route: createNavRoute(), goalX: NaN, goalY: NaN, gen: 0, pending: false, short: false, askedAt: -Infinity, usedAt: now, chkAt: now, chkX: x, chkY: y, stuck: 0 };
      this.ships.set(entityId, s);
    }
    s.usedAt = now;
    const gdx = tx - s.goalX, gdy = ty - s.goalY;
    if (!(gdx * gdx + gdy * gdy <= arrive * arrive)) {
      // A new goal: the old route leads elsewhere (a moving goal kept: near enough until the new plan lands).
      if (!keep) { s.route.count = 0; s.short = false; }
      s.stuck = 0; s.chkAt = now; s.chkX = x; s.chkY = y;
      if (!s.pending && now - s.askedAt >= NAV_REPLAN_MS) this.plan(s, x, y, tx, ty, clearance, now);
    } else if (s.short) {
      if (!s.pending && now - s.askedAt >= NAV_WAIT_RETRY_MS) {
        s.stuck = 0; s.chkAt = now; s.chkX = x; s.chkY = y; // a fresh start if the way has opened
        this.plan(s, x, y, tx, ty, clearance, now);
      }
    } else if (now - s.chkAt >= NAV_STUCK_MS) {
      this.progress(s, x, y, tx, ty, clearance, arrive, now);
    }
    let leg = stepNavRoute(s.route, x, y, arrive);
    if (leg < 0) {
      if (!s.short || s.route.count === 0) return false;
      leg = s.route.count - 1; // as close as it gets: wait there
    }
    const p = s.route.points;
    const wx = p[leg * 2]!, wy = p[leg * 2 + 1]!;
    const dx = wx - x, dy = wy - y, d = Math.sqrt(dx * dx + dy * dy);
    let ahead = d;
    if (leg + 1 < s.route.count && d > 1e-6) {
      // The next leg counts as far as it runs on the same way (a sharp corner: brake for it).
      const nx = p[leg * 2 + 2]! - wx, ny = p[leg * 2 + 3]! - wy, nl = Math.sqrt(nx * nx + ny * ny);
      if (nl > 1e-6) ahead += nl * Math.max(0, (dx * nx + dy * ny) / (d * nl));
    }
    this.wpX = wx; this.wpY = wy; this.ahead = ahead;
    return true;
  }

  /** Does the ship wait short of its goal (no way fits, or stuck)? */
  waiting(entityId: string): boolean { return this.ships.get(entityId)?.short === true; }

  /** Drop a ship's route (it left or died). */
  forget(entityId: string): void { this.ships.delete(entityId); }

  private plan(s: ShipNav, x: number, y: number, tx: number, ty: number, clearance: number, now: number): void {
    s.goalX = tx; s.goalY = ty;
    s.pending = true;
    s.askedAt = now;
    const gen = ++s.gen;
    this.requests++;
    this.request(x, y, tx, ty, clearance).then((msg) => {
      if (s.gen !== gen) return;
      s.pending = false;
      if (msg.status === 'straight') { s.route.count = 0; s.short = false; } // the way is clear (again)
      else if (msg.status === 'route' || msg.status === 'nearest') {
        setNavRoute(s.route, msg.points);
        s.short = msg.status === 'nearest';
        if (s.short) this.short++; else this.routed++;
      }
    }, () => { if (s.gen === gen) s.pending = false; });
  }

  /** The periodic stuck check: plan again from here, or wait here. */
  private progress(s: ShipNav, x: number, y: number, tx: number, ty: number, clearance: number, arrive: number, now: number): void {
    const mx = x - s.chkX, my = y - s.chkY, gx = tx - x, gy = ty - y;
    s.chkAt = now; s.chkX = x; s.chkY = y;
    if (mx * mx + my * my >= arrive * arrive || gx * gx + gy * gy <= 4 * arrive * arrive) { s.stuck = 0; return; }
    s.stuck++;
    if (s.stuck <= NAV_STUCK_REPLANS) {
      if (!s.pending) { this.stuckReplans++; this.plan(s, x, y, tx, ty, clearance, now); }
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
