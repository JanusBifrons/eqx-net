/**
 * Ship body ids across the wire (RTS Part A S3, #15).
 *
 * The SERVER physics worker keys a parked (lingering / AI-flown) hull's body
 * `linger-<shipInstanceId>`, so it never collides with its owner's active
 * body (keyed by playerId) when the owner rejoins. The CLIENT keys the same
 * hull's prediction body by the bare shipInstanceId (its key in the one ship
 * list, `mirror.ships`). Anything the server sends that names a ship BODY
 * (today: `collision_resolved` aId / bId) goes through `wireShipBodyId`, the
 * ONE place the server prefix is stripped, so the client's body lookup finds
 * the hull. Two-sided lock: `tests/integration/sectorRoom/lingeringHullCollisionIds.test.ts`.
 */

/** The server worker's body-id prefix for a parked hull. */
export const LINGER_BODY_PREFIX = 'linger-';

/** A server body id as the client keys it: `linger-<sid>` → `<sid>`; any other
 *  id (an active pilot's playerId, a drone's `swarm-<n>`, …) unchanged.
 *  Allocates one substring for a parked hull only (a rate-gated, discrete
 *  message, never per tick per body). */
export function wireShipBodyId(bodyId: string): string {
  return bodyId.startsWith(LINGER_BODY_PREFIX) ? bodyId.slice(LINGER_BODY_PREFIX.length) : bodyId;
}
