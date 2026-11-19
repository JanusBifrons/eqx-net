/**
 * Navigation numbers derived from a ship's tuning (kept out of `tuning.ts`,
 * which is at its god-file cap).
 */
import type { ShipKind } from '../shipKinds.js';
import { shipTuning, shieldVisualRadius } from './tuning.js';

/** What a nav route keeps from rock where it has room: the shield ball
 *  (radius + shieldPad) plus half a pad for steering error, never under
 *  `navClearance`, which is all a tight street gets (owner 2026-11-19,
 *  "margin where room"). 54 u for a fighter; a battleship's is its clearance. */
export function navComfort(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.max(t.navClearance, kind.radius + t.shieldPad * 1.5);
}

/** What a nav route keeps along a STRAIGHT run (owner 2026-11-19, "width on
 *  straights"): the hull's half beam plus the same quarter-length margin as
 *  `navClearance`. A long hull flies a lane on its width; only where the route
 *  turns does it need its length ({@link navTurnRoom}). Equal to
 *  `navClearance` for every non-capital (their half beam is their radius).
 *  Battleship ≈ 1 067 u against a 3 595 u clearance. */
export function navBeamClearance(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.min(t.navClearance, shieldVisualRadius(kind) + t.navClearance - kind.radius);
}

/** The room a hull needs to turn by θ about its centre: the margin plus the
 *  half-width its outline sweeps, a·sinθ + b·cosθ (a half length, b half
 *  beam), at most hypot(a, b). From the hull's two nav clearances: `full`
 *  (`navClearance` = radius × 1.25, tuning.ts) and `beam`
 *  ({@link navBeamClearance}); `navTuning.test.ts` locks that coupling.
 *  θ = 0 ⇒ `beam`; past atan(a/b) ⇒ just over `full`. */
export function navTurnRoom(full: number, beam: number, sin: number, cos: number): number {
  const a = full / 1.25, m = full - a, b = Math.max(0, beam - m);
  // Past the sweep's peak (tanθ ≥ a/b) the outline's corner is the widest point.
  return m + (sin * b >= cos * a ? Math.hypot(a, b) : a * sin + b * cos);
}

/** A hull's nav numbers, bundled for a route request (`IAiNavRoutes.waypoint`,
 *  `NavField.route`): `clearance` on any turn, `comfort` where room allows,
 *  `beam` on straight runs. */
export interface NavHull { readonly clearance: number; readonly comfort: number; readonly beam: number }

const HULLS = new WeakMap<ShipKind, NavHull>();
/** {@link NavHull} for a kind, built once per kind (per-tick callers allocate nothing, #14). */
export function navHull(kind: ShipKind): NavHull {
  let h = HULLS.get(kind);
  if (h === undefined) {
    h = { clearance: shipTuning(kind).navClearance, comfort: navComfort(kind), beam: navBeamClearance(kind) };
    HULLS.set(kind, h);
  }
  return h;
}
