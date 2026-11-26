/**
 * Phase 4 travel state (sector-to-sector trip): the local ship's synthetic
 * flight, moved verbatim out of `ColyseusClient` (god-file split). The client
 * holds one `TravelTrip | null`; `updateMirror` calls `stepTravel` LAST.
 */
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { PhysicsWorld } from '@core/physics/World';
import { WARP_SPEED } from '../../../core/physics/warpDrive.js';
import { useUIStore } from '../../state/store.js';

/** Phase 4 travel state (sector-to-sector trip), seconds: accelerate out of
 *  the old sector, the shortest trip (it stretches while loading), and the
 *  deceleration into the new one. Feel knobs. */
export const TRAVEL_OUT_S = 3;
const TRAVEL_MIN_S = 25;
/** The approach into the new sector: brake from warp speed to a glide
 *  (TRAVEL_BRAKE_S), then glide the last TRAVEL_GLIDE_D slowing evenly to a
 *  stop, so whatever is near the arrival point passes at a speed you can see. */
const TRAVEL_BRAKE_S = 2.5;
const TRAVEL_GLIDE_V = 2500;
const TRAVEL_GLIDE_D = 4000;
const TRAVEL_GLIDE_S = (2 * TRAVEL_GLIDE_D) / TRAVEL_GLIDE_V;
const TRAVEL_IN_S = TRAVEL_BRAKE_S + TRAVEL_GLIDE_S;
const TRAVEL_BRAKE_D = TRAVEL_GLIDE_V * TRAVEL_BRAKE_S + ((WARP_SPEED - TRAVEL_GLIDE_V) * TRAVEL_BRAKE_S) / 3;
const TRAVEL_IN_D = TRAVEL_BRAKE_D + TRAVEL_GLIDE_D;

/** Approach progress `tau` s in: [distance covered, speed]. Pure. */
export function travelApproach(tau: number): [number, number] {
  if (tau <= TRAVEL_BRAKE_S) {
    const u = Math.max(0, tau) / TRAVEL_BRAKE_S;
    const span = (WARP_SPEED - TRAVEL_GLIDE_V) * TRAVEL_BRAKE_S;
    return [TRAVEL_GLIDE_V * tau + span * (u - u * u + (u * u * u) / 3), TRAVEL_GLIDE_V + (WARP_SPEED - TRAVEL_GLIDE_V) * (1 - u) * (1 - u)];
  }
  const s = Math.min(TRAVEL_GLIDE_S, tau - TRAVEL_BRAKE_S);
  return [TRAVEL_BRAKE_D + TRAVEL_GLIDE_V * (s - (s * s) / (2 * TRAVEL_GLIDE_S)), TRAVEL_GLIDE_V * (1 - s / TRAVEL_GLIDE_S)];
}

/** What `stepTravel` reads (the `MirrorPassCtx` satisfies it). */
export interface TravelCtx {
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly predWorld: PhysicsWorld | null;
}

/** The sector-to-sector trip under way. */
export interface TravelTrip {
  x: number; y: number; dx: number; dy: number; angle: number; lastMs: number; startMs: number;
  phase: 'out' | 'cruise' | 'in'; inStartMs: number; ax: number; ay: number; landed: boolean;
  /** A teleport (gate or paired teleporter): no flight at all. The ship holds
   *  still where it sealed, then is put straight on the far pad. */
  hold: boolean;
  /** The store's `joinGeneration` when the trip began: a hold lands only after
   *  the room swap re-arms join readiness (the source room's body and first
   *  snapshot are still there while the gate seals). */
  joinGen: number;
}

/**
 * One frame of the trip (Phase 4 travel state):
 *  - OUT: accelerate along the heading (ease-in over TRAVEL_OUT_S); the old
 *    sector stays live and falls behind (the room swap waits until then).
 *  - CRUISE: warp speed through empty space while the destination loads.
 *  - IN: once at least TRAVEL_MIN_S - TRAVEL_IN_S has passed and the
 *    destination is loaded, the ship is placed on approach (TRAVEL_IN_S of
 *    deceleration out from its arrival point, along its heading) and slows
 *    into the arrival point, so the new sector comes into view as you fly
 *    in. The placement jump is recorded (`mirror.travelJumpX/Y`) so the
 *    renderer carries the sky across it. When the approach ends the trip is
 *    done: the minimum-display gate opens and the ship arrives for everyone.
 */
export function stepTravel(ctx: TravelCtx, t: TravelTrip, e: ShipRenderState, localId: string): void {
  if (t.hold) { stepHold(ctx, t, e, localId); return; }
  const now = ctx.clock.now();
  const dt = Math.min(0.1, Math.max(0, (now - t.lastMs) / 1000));
  t.lastMs = now;
  const el = (now - t.startMs) / 1000;
  if (t.phase !== 'in') {
    const arrival = ctx.predWorld?.getShipState(localId);
    if (el >= TRAVEL_MIN_S - TRAVEL_IN_S && arrival && useUIStore.getState().firstSnapshotApplied) {
      // Approach: placed TRAVEL_IN_D out from the arrival point along the heading.
      const sx = arrival.x - t.dx * TRAVEL_IN_D, sy = arrival.y - t.dy * TRAVEL_IN_D;
      ctx.mirror.travelJumpX = (ctx.mirror.travelJumpX ?? 0) + (sx - t.x);
      ctx.mirror.travelJumpY = (ctx.mirror.travelJumpY ?? 0) + (sy - t.y);
      t.phase = 'in'; t.inStartMs = now; t.ax = arrival.x; t.ay = arrival.y;
      t.x = sx; t.y = sy;
    } else {
      const ramp = Math.min(1, el / TRAVEL_OUT_S);
      const v = WARP_SPEED * ramp * ramp;
      t.x += t.dx * v * dt;
      t.y += t.dy * v * dt;
      if (ramp >= 1) t.phase = 'cruise';
      e.vx = t.dx * v; e.vy = t.dy * v;
    }
  }
  if (t.phase === 'in') {
    // Brake, then glide onto the arrival point (travelApproach).
    const tau = (now - t.inStartMs) / 1000;
    const [d, v] = travelApproach(tau);
    t.x = t.ax - t.dx * (TRAVEL_IN_D - d);
    t.y = t.ay - t.dy * (TRAVEL_IN_D - d);
    e.vx = t.dx * v; e.vy = t.dy * v;
    if (tau >= TRAVEL_IN_S) {
      t.landed = true;
      if (!useUIStore.getState().joinMinimumElapsed) useUIStore.getState().setJoinMinimumElapsed(true);
    }
  }
  ctx.mirror.travelDeep = t.phase === 'cruise';
  e.x = t.x; e.y = t.y; e.angle = t.angle;
  // On the run until the ship has landed (then WarpFx draws the drop, while
  // the arrival handshake finishes).
  const w = t.landed ? undefined : 2;
  if (e.warp !== w) e.warp = w;
}

/**
 * A teleport's "trip": the ship sits still in the sealed pad or gate while the
 * far sector loads, then is put on its arrival point (the far pad) in one
 * step, like a same-sector swap. The jump is recorded for the sky. No warp
 * run is drawn: a teleport is not a warp.
 */
function stepHold(ctx: TravelCtx, t: TravelTrip, e: ShipRenderState, localId: string): void {
  t.lastMs = ctx.clock.now();
  if (!t.landed) {
    const arrival = ctx.predWorld?.getShipState(localId);
    const ui = useUIStore.getState();
    if (arrival && ui.joinGeneration !== t.joinGen && ui.firstSnapshotApplied) {
      ctx.mirror.travelJumpX = (ctx.mirror.travelJumpX ?? 0) + (arrival.x - t.x);
      ctx.mirror.travelJumpY = (ctx.mirror.travelJumpY ?? 0) + (arrival.y - t.y);
      t.x = arrival.x; t.y = arrival.y; t.angle = arrival.angle;
      t.landed = true;
      if (!ui.joinMinimumElapsed) ui.setJoinMinimumElapsed(true);
    }
  }
  ctx.mirror.travelDeep = false;
  e.x = t.x; e.y = t.y; e.angle = t.angle; e.vx = 0; e.vy = 0;
  if (e.warp !== undefined) e.warp = undefined;
}
