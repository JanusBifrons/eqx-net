/**
 * Pose + velocity read / write of a `PhysicsWorld` (World.ts) body as a
 * `ShipPhysicsState`. Moved verbatim out of World.ts (god-file split);
 * `PhysicsWorld.setShipState` / `setShipStateAsleep` / `getShipState` /
 * `getAllShipStates` are short delegates, so the API is unchanged.
 *
 * 2026-05-25 heap-growth fix — pooled scratches for the Rapier
 * `setTranslation` / `setLinvel` Vector2 arguments. `setShipState` was called
 * per-drone per-RAF on the client (the since-retired follower for
 * snapshot-interpolated drones) — at 25 drones × 90 RAFs/sec the prior
 * `{x, y}` literals were 2 × 2250 = 4500 allocations/sec just from this
 * method. Rapier's API takes Vector2-like objects, so we reuse a single
 * instance per call site. Safe because rapier copies the values into native
 * memory synchronously inside the call (so one module scratch serves every
 * world on the thread: each call finishes with it before the next starts).
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import type { ShipBody, ShipPhysicsState } from './worldTypes.js';

const _translationScratch = { x: 0, y: 0 };
const _linvelScratch = { x: 0, y: 0 };

/** Write `state` to `body`, waking it (`wake`) or not (`setShipStateAsleep`). */
export function writeBodyState(body: RAPIER.RigidBody, state: ShipPhysicsState, wake: boolean): void {
  const t = _translationScratch;
  t.x = state.x; t.y = state.y;
  body.setTranslation(t, wake);
  const v = _linvelScratch;
  v.x = state.vx; v.y = state.vy;
  body.setLinvel(v, wake);
  body.setRotation(state.angle, wake);
  if (state.angvel !== undefined) body.setAngvel(state.angvel, wake);
}

/** `PhysicsWorld.getShipState` for a live body. */
export function readBodyState(body: RAPIER.RigidBody): ShipPhysicsState {
  const t = body.translation();
  const v = body.linvel();
  return { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y, angvel: body.angvel() };
}

/** `PhysicsWorld.getAllShipStates` over the world's body map. */
export function readAllBodyStates(bodies: ReadonlyMap<string, ShipBody>, skip?: ReadonlySet<string>): Map<string, ShipPhysicsState> {
  const result = new Map<string, ShipPhysicsState>();
  for (const [id, rec] of bodies) {
    // Sub-cap break-up slice 2: the worker passes the bodies that have been
    // asleep (and flagged so in the SAB) since before this tick; their SAB
    // record is already their resting pose, so they cost no Rapier read and
    // no allocation here (permanent debris that has settled is near free).
    if (skip !== undefined && skip.has(id)) continue;
    const t = rec.body.translation();
    const v = rec.body.linvel();
    result.set(id, { x: t.x, y: t.y, angle: rec.body.rotation(), vx: v.x, vy: v.y, angvel: rec.body.angvel() });
  }
  return result;
}
