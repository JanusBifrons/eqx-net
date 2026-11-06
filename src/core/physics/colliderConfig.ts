/**
 * Pure RAPIER collider configuration helpers. Extracted from the
 * monolithic `World.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 5).
 *
 * All ship/drone colliders (the cheap ball AND every hull-polygon
 * triangle on shield-down) share the same density / restitution /
 * friction / event-emission config — that uniformity is what makes
 * the shield 0-cross collider swap dynamically transparent
 * (`setAdditionalMassProperties` pins mass + inertia once in
 * `spawnShip`, so the body's properties are independent of which
 * collider geometry is currently attached).
 */

import RAPIER from '@dimforge/rapier2d-compat';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';

/**
 * Shared config for EVERY ship/drone collider (the cheap ball OR each hull
 * polygon triangle). Density is 0 on all of them: the body's mass + inertia
 * come entirely from `setAdditionalMassProperties` (pinned once in `spawnShip`
 * to the legacy disc-equivalent), which is what makes the shield 0-cross
 * collider swap dynamically transparent. Contact-force events stay enabled
 * on every piece so ramming + the contact drain still fire with N colliders.
 */
export function configureShipCollider(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setDensity(0)
    .setRestitution(0.3)
    .setFriction(0)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(10);
}

export function shipBallColliderDesc(radius: number): RAPIER.ColliderDesc {
  return configureShipCollider(RAPIER.ColliderDesc.ball(radius));
}

/**
 * The SHIELD-UP collider for a ship kind (capital-ship R&D round 3): a ball of
 * `radius + shieldPad` for every kind, EXCEPT capitals, whose shield follows
 * the hull: the convex hull of its collision outline, rounded outward by the
 * pad (`roundConvexHull`). A ball of half a 5.8 km hull's length would wall
 * off everything round a long warship (the round-2 fly-by stopped dead in the
 * channel between two cruisers). One function for the server worker and the
 * client predWorld (#15).
 */
export function shipShieldColliderDesc(kind: ShipKind): RAPIER.ColliderDesc {
  const pad = shipTuning(kind).shieldPad;
  if (kind.sizeClass === 'capital') {
    const parts = shipCollisionParts(kind.id);
    let n = 0;
    for (const p of parts) n += p.length;
    const flat = new Float32Array(n * 2);
    let i = 0;
    for (const p of parts) for (const v of p) { flat[i++] = v.x; flat[i++] = v.y; }
    const d = RAPIER.ColliderDesc.roundConvexHull(flat, pad);
    if (d) return configureShipCollider(d);
  }
  return shipBallColliderDesc(kind.radius + pad);
}
