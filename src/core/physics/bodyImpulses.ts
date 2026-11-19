/**
 * Velocity kicks and impulses of `PhysicsWorld` (World.ts) beyond Rapier's
 * own `applyImpulse`: a mass-independent velocity change, an off-centre
 * impulse, and an impulse on a group of bodies moved as one rigid body (a
 * capital wreck in its crack hold). Moved verbatim out of World.ts (god-file
 * split); `PhysicsWorld` keeps one-line delegates, so its API is unchanged.
 *
 * Invariant #14: reached from per-tick commands, so the scratch below is
 * module state built once. Rapier copies a Vector2 argument synchronously and
 * each call finishes with its scratch before the next starts, so sharing it
 * between worlds (one worker thread, many sectors) is safe.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import type { ShipBody } from './worldTypes.js';

const _kickVel = { x: 0, y: 0 };
const _impJ = { x: 0, y: 0 };
const _impP = { x: 0, y: 0 };

/** `PhysicsWorld.addVelocity` for a live body (see its doc). */
export function addBodyVelocity(body: RAPIER.RigidBody, dvx: number, dvy: number, dw: number): void {
  const v = body.linvel();
  _kickVel.x = v.x + dvx;
  _kickVel.y = v.y + dvy;
  body.setLinvel(_kickVel, true);
  body.setAngvel(body.angvel() + dw, true);
}

/** `PhysicsWorld.applyImpulseAtPoint` for a live body (see its doc). */
export function applyBodyImpulseAtPoint(body: RAPIER.RigidBody, jx: number, jy: number, px: number, py: number): void {
  _impJ.x = jx;
  _impJ.y = jy;
  _impP.x = px;
  _impP.y = py;
  body.applyImpulseAtPoint(_impJ, _impP, true);
}

/**
 * Behind `PhysicsWorld.applyRigidGroupImpulse` (World.ts).
 *
 * Apply a linear impulse (jx, jy) at world point (px, py) to a GROUP of
 * bodies as if they were one rigid body (a capital wreck still inside its
 * crack hold, hit by the rest of a salvo). The group's motion is first made
 * exactly rigid from its momentum (centre-of-mass velocity from the linear
 * momentum, spin from the angular momentum about the centre of mass over
 * the group's moment of inertia, parallel-axis theorem), then
 *   Δv = J ÷ M,  Δω = (r × J) ÷ I,
 * and every body gets v_com + ω × r_i and spin ω, so the pieces keep their
 * relative poses. Unknown ids are skipped (pieces already gone). Wakes the
 * bodies. Alloc-free apart from Rapier's own vector getters.
 */
export function applyRigidGroupImpulse(
  bodies: ReadonlyMap<string, ShipBody>,
  ids: readonly string[],
  jx: number,
  jy: number,
  px: number,
  py: number,
): void {
  let m = 0, cx = 0, cy = 0, momX = 0, momY = 0;
  for (let i = 0; i < ids.length; i++) {
    const rec = bodies.get(ids[i]!);
    if (!rec) continue;
    const b = rec.body;
    const mi = b.mass();
    const c = b.worldCom();
    const v = b.linvel();
    m += mi; cx += c.x * mi; cy += c.y * mi; momX += v.x * mi; momY += v.y * mi;
  }
  if (!(m > 0)) return;
  cx /= m; cy /= m;
  let vx = momX / m, vy = momY / m;
  // Angular momentum and inertia about the group's centre of mass.
  let l = 0, inertia = 0;
  for (let i = 0; i < ids.length; i++) {
    const rec = bodies.get(ids[i]!);
    if (!rec) continue;
    const b = rec.body;
    const mi = b.mass();
    const c = b.worldCom();
    const v = b.linvel();
    const rx = c.x - cx, ry = c.y - cy;
    const ii = b.principalInertia();
    inertia += ii + mi * (rx * rx + ry * ry);
    l += ii * b.angvel() + mi * (rx * (v.y - vy) - ry * (v.x - vx));
  }
  let w = inertia > 0 ? l / inertia : 0;
  vx += jx / m;
  vy += jy / m;
  if (inertia > 0) w += ((px - cx) * jy - (py - cy) * jx) / inertia;
  for (let i = 0; i < ids.length; i++) {
    const rec = bodies.get(ids[i]!);
    if (!rec) continue;
    const b = rec.body;
    const c = b.worldCom();
    _kickVel.x = vx - w * (c.y - cy);
    _kickVel.y = vy + w * (c.x - cx);
    b.setLinvel(_kickVel, true);
    b.setAngvel(w, true);
  }
}
