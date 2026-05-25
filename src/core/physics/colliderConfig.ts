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
