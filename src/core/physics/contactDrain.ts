/**
 * Pure-function contact-event drain — Stage 2 of the network-feel roadmap.
 *
 * After `world.step(eventQueue)`, Rapier has populated the queue with one
 * `ContactForceEvent` per collider pair that experienced a contact-force
 * spike above the engine-level threshold (set on the collider via
 * `setContactForceEventThreshold`). This function:
 *
 *   1. Drains the queue.
 *   2. Resolves collider handles to the entity IDs they were spawned with.
 *   3. Filters out events below `forceFloor` (caller-controlled — engine
 *      threshold is set conservatively low so this filter has flexibility).
 *   4. Reads each body's *post-step* linear velocity (vPost) directly from
 *      the world — that's the velocity the client needs to mirror to its
 *      predWorld for instant collision recovery.
 *
 * The function is pure in the sense that it has no I/O and is fully
 * unit-testable against a real `PhysicsWorld` plus a synthetic collision
 * scenario (see `contactDrain.test.ts`). It does not import the worker
 * runtime or any networking concretion — `src/core/CLAUDE.md` invariants
 * preserved.
 */
import RAPIER from '@dimforge/rapier2d-compat';
import type { PhysicsWorld } from './World.js';

export interface Contact {
  /** Entity ID of the first body in the contact pair. */
  aId: string;
  /** Entity ID of the second body. */
  bId: string;
  /** Post-step linear velocity of body `a`. */
  vAxPost: number;
  vAyPost: number;
  /** Post-step linear velocity of body `b`. */
  vBxPost: number;
  vByPost: number;
  /** Magnitude of the total contact force (Newtons). */
  forceMagnitude: number;
}

/**
 * Drain `eventQueue` and return contacts above `forceFloor`.
 *
 * Mutates `eventQueue` (consumes pending events). Pass a freshly-stepped
 * queue; otherwise the caller is responsible for understanding that older
 * events from prior ticks may also be returned.
 */
export function drainContacts(
  eventQueue: RAPIER.EventQueue,
  world: PhysicsWorld,
  forceFloor: number,
): Contact[] {
  const contacts: Contact[] = [];

  // Rapier exposes contact-force events by handle pairs; iterate, resolve,
  // and read post-step linvel for both bodies. Skip pairs where either
  // collider's parent body is no longer registered (despawned mid-step).
  eventQueue.drainContactForceEvents((event) => {
    const force = event.totalForceMagnitude();
    if (force < forceFloor) return;

    const aHandle = colliderHandleToBodyHandle(world, event.collider1());
    const bHandle = colliderHandleToBodyHandle(world, event.collider2());
    if (aHandle === undefined || bHandle === undefined) return;

    const aId = world.resolveHandle(aHandle);
    const bId = world.resolveHandle(bHandle);
    if (!aId || !bId) return;

    const a = world.getShipState(aId);
    const b = world.getShipState(bId);
    if (!a || !b) return;

    contacts.push({
      aId,
      bId,
      vAxPost: a.vx,
      vAyPost: a.vy,
      vBxPost: b.vx,
      vByPost: b.vy,
      forceMagnitude: force,
    });
  });

  return contacts;
}

/**
 * Helper: given a *collider* handle, return the parent rigid-body handle.
 * Rapier's contact events expose collider handles, but PhysicsWorld's
 * `resolveHandle` map is keyed by *body* handle. Bridging the two requires
 * looking up the collider's parent. PhysicsWorld doesn't expose its world
 * handle directly, so the bridge function lives here and uses Rapier's
 * world reference held privately on `PhysicsWorld`.
 *
 * Implementation note: PhysicsWorld doesn't currently expose a public
 * collider→body lookup; we reach in via a small accessor helper added on
 * the class. If a future refactor eliminates this, update the import.
 */
function colliderHandleToBodyHandle(world: PhysicsWorld, colliderHandle: number): number | undefined {
  return world.bodyHandleForCollider(colliderHandle);
}
