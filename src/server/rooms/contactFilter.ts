import type { Contact } from '../../core/physics/contactDrain.js';

/**
 * Phase 6b self-collision filter (2026-05-13).
 *
 * When a player has BOTH an active hull AND a lingering hull in the
 * same sector, the physics worker has two distinct Rapier rigid
 * bodies whose `resolveHandle` identity is the same string — both
 * are tagged with the player's `playerId`. Rapier reports the
 * inter-body contact correctly, but `aId === bId === playerId` on
 * the wire. The client's `applyCollisionResolved` iterates `[aId,
 * bId]` applying vA then vB to the SAME `predWorld` body — the
 * second iteration's velocity overrides the first, and the player's
 * local ship snaps to a velocity that came from one of the
 * participants but is wrong for either.
 *
 * Symptom: the user's active hull bouncing around their own parked
 * (lingering) hull with no visible attacker.
 *
 * The pure-function predicate below is the canonical guard. Inlined
 * in `SectorRoom.ts`'s CONTACT_BATCH handler for the hot path; this
 * module exists so the contract is unit-testable + documented.
 *
 * This filter does NOT fix the server-side physics interaction —
 * the two bodies still collide and impart impulse on each other.
 * That deeper fix requires either:
 *   1. Distinct body identities (e.g. shipInstanceId, not playerId),
 *   2. Collision groups so the lingering body doesn't push the
 *      active body, or
 *   3. Removing the lingering body from the physics world entirely
 *      and only spawning a "ghost" sensor for hit-tests.
 *
 * Tracked in task #17.
 */
export function shouldBroadcastContact(c: Contact): boolean {
  return c.aId !== c.bId;
}
