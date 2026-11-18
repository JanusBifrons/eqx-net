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

interface ShipNav {
  readonly route: NavRoute;
  goalX: number;
  goalY: number;
  /** Bumped on each new plan; a reply for an older one is dropped. */
  gen: number;
  pending: boolean;
  askedAt: number;
  usedAt: number;
}

export class NavRoutes implements IAiNavRoutes {
  wpX = 0;
  wpY = 0;
  ahead = 0;
  /** Plans asked for (count gate), and answered with a route. */
  requests = 0;
  routed = 0;
  private readonly ships = new Map<string, ShipNav>();
  private nextSweep = 0;

  constructor(private readonly request: NavRouteRequest, private readonly now: () => number) {}

  /** Ships with a record (diagnostics, tests). */
  get size(): number { return this.ships.size; }

  waypoint(entityId: string, x: number, y: number, tx: number, ty: number, clearance: number, arrive: number): boolean {
    const now = this.now();
    if (now >= this.nextSweep) this.sweep(now);
    let s = this.ships.get(entityId);
    if (s === undefined) {
      s = { route: createNavRoute(), goalX: NaN, goalY: NaN, gen: 0, pending: false, askedAt: -Infinity, usedAt: now };
      this.ships.set(entityId, s);
    }
    s.usedAt = now;
    const gdx = tx - s.goalX, gdy = ty - s.goalY;
    if (!(gdx * gdx + gdy * gdy <= arrive * arrive)) {
      // A new goal: the old route leads elsewhere.
      s.route.count = 0;
      if (!s.pending && now - s.askedAt >= NAV_REPLAN_MS) this.plan(s, x, y, tx, ty, clearance, now);
    }
    const leg = stepNavRoute(s.route, x, y, arrive);
    if (leg < 0) return false;
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
      if (msg.status === 'route') { setNavRoute(s.route, msg.points); this.routed++; }
    }, () => { if (s.gen === gen) s.pending = false; });
  }

  private sweep(now: number): void {
    this.nextSweep = now + NAV_FORGET_MS;
    for (const [id, s] of this.ships) if (now - s.usedAt > NAV_FORGET_MS) this.ships.delete(id);
  }
}
