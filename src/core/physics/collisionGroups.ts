/**
 * Rapier collision-group bit packing (scrap-on-death Phase 2b-i).
 *
 * Rapier encodes a collider's collision groups as a single `u32`:
 *
 *     groups = (membershipBits << 16) | filterBits      // each half is 16 bits
 *
 * Two colliders A and B collide IFF BOTH directions are satisfied:
 *
 *     (A.membership & B.filter) !== 0   AND   (B.membership & A.filter) !== 0
 *
 * The Rapier default (when `setCollisionGroups` is never called) is
 * `0xFFFFFFFF` — membership = all 16 bits, filter = all 16 bits — so a default
 * collider is a member of every group and collides with every group.
 *
 * Pure module. No imports, no side effects.
 */

/**
 * Rapier's default collision groups (membership = all, filter = all). Exported
 * for clarity at the call sites that want to be explicit that a body uses the
 * engine default rather than a custom mask.
 */
export const DEFAULT_COLLISION_GROUPS = 0xffffffff;

/**
 * Collision groups for SCRAP bodies.
 *
 *   membership = 0x0002 (bit 1 only)
 *   filter     = 0xFFFD (every bit EXCEPT bit 1)
 *   packed u32 = (0x0002 << 16) | 0xFFFD = 0x0002FFFD
 *
 * Behaviour proof (apply the two-direction rule above):
 *
 *   scrap vs scrap:
 *     (A.membership & B.filter) = (0x0002 & 0xFFFD) = 0  → first clause fails
 *     ⇒ NO collision. Scrap pieces pass cleanly through one another so a
 *       death-burst of overlapping scrap never explodes apart.
 *
 *   scrap vs default body (ship / drone / asteroid / structure, groups
 *   0xFFFFFFFF ⇒ membership 0xFFFF, filter 0xFFFF):
 *     (scrap.membership & default.filter) = (0x0002 & 0xFFFF) = 0x0002 ≠ 0  ✓
 *     (default.membership & scrap.filter) = (0xFFFF & 0xFFFD) = 0xFFFD ≠ 0  ✓
 *     ⇒ COLLIDE. Scrap still bumps off everything that isn't scrap.
 */
export const SCRAP_COLLISION_GROUPS = 0x0002fffd;

/**
 * Collision groups for capital WRECK pieces (membership bit 2, filter every
 * bit): pieces collide with each other and with everything else (ships,
 * rocks, scrap, structures). They are solid, heavy bodies that bump.
 *
 * History: 2026-11-12 they ignored each other (filter 0xFFFB), because a fast
 * push from the kill point drove pieces into their slower neighbours and the
 * contacts traded the push away. The owner review of 2026-11-13 found pieces
 * sliding over each other instead, and asked for heavy, fully simulated
 * chunks. Now the push is slow, every pair of neighbours is given a parting
 * velocity along its shared cut (`buildWreckPieces`), and each collider is
 * inset a hair (`wreckColliderInset`) so neighbours don't start touching.
 * The membership bit stays so a rule can single wreck pieces out.
 *
 *   packed u32 = (0x0004 << 16) | 0xFFFF = 0x0004FFFF
 */
export const WRECK_COLLISION_GROUPS = 0x0004ffff;

/**
 * Collision groups for SUB-CAPITAL wreck pieces (sub-capital break-up slice
 * 2; the `subcap` profile's `piecesCollide: false`). Membership bit 3, filter
 * every bit EXCEPT bit 3, the scrap pattern on its own bit:
 *
 *   sub-cap piece vs sub-cap piece: (0x0008 & 0xFFF7) = 0 ⇒ NO collision
 *     (pieces of a fighter never fight each other, and resting debris never
 *     piles up and keeps itself awake: cheap).
 *   sub-cap piece vs a capital piece (0x0004FFFF): (0x0008 & 0xFFFF) ≠ 0 and
 *     (0x0004 & 0xFFF7) ≠ 0 ⇒ collide (capital pieces stay solid to all).
 *   sub-cap piece vs a default body (ships, drones, rocks, structures): collide.
 *   sub-cap piece vs scrap (0x0002FFFD): (0x0008 & 0xFFFD) ≠ 0 and
 *     (0x0002 & 0xFFF7) ≠ 0 ⇒ collide.
 *
 *   packed u32 = (0x0008 << 16) | 0xFFF7 = 0x0008FFF7
 */
export const SUBCAP_WRECK_COLLISION_GROUPS = 0x0008fff7;

/**
 * Rig parts (structure-restyle 2d, plan §5 / §8 "over-layer collision").
 *
 * Layer rule: only a `plane`-layer part with an outline gets a collider (a
 * kinematic body, `PhysicsWorld.attachRig`). `under` and `over` parts are
 * drawn only and get NO body, so they collide with nothing. That needs no
 * mask: a part that is not in the world cannot collide (the over layer is
 * drawn above ships and must never touch them).
 *
 * The one mask that IS needed: a plane part sits inside (or across) its own
 * host's hull (the turret's door leaves are inside the 140 × 140 footprint).
 * The host is a LOCKED dynamic body, so Rapier would report a
 * dynamic-vs-kinematic contact between them every step (and the host's
 * contact-force events would read as rams). So:
 *
 *   rig part: membership bit 4 only, filter every bit
 *     packed u32 = (0x0010 << 16) | 0xFFFF = 0x0010FFFF
 *   rig host: its existing groups with filter bit 4 cleared
 *     (`withoutRigParts`; a default host becomes 0xFFFFFFEF)
 *
 *   part vs host:  (part.membership & host.filter) = 0x0010 & 0xFFEF = 0
 *     ⇒ NO collision (with its own host, and with any other rig host).
 *   part vs a default body (ships, drones, rocks): 0x0010 & 0xFFFF ≠ 0 and
 *     0xFFFF & 0xFFFF ≠ 0 ⇒ COLLIDE (solid, like the structure body).
 *   part vs scrap (0x0002FFFD): 0x0010 & 0xFFFD ≠ 0, 0x0002 & 0xFFFF ≠ 0
 *     ⇒ collide. Same for wreck pieces (filter 0xFFFF / 0xFFF7).
 *   host vs everything else: membership unchanged, filter only loses bit 4
 *     (nothing else is a member of bit 4) ⇒ unchanged.
 * Kinematic vs kinematic / fixed never collide in Rapier's default
 * `ActiveCollisionTypes`, so two parts never touch each other.
 */
export const RIG_PART_COLLISION_GROUPS = 0x0010ffff;
/** The rig-part membership bit, for `withoutRigParts`. */
export const RIG_PART_BIT = 0x0010;

/** A rig host collider's groups: `groups` with the rig-part bit cleared from
 *  its filter half (see `RIG_PART_COLLISION_GROUPS`). */
export function withoutRigParts(groups: number): number {
  return (groups & ~RIG_PART_BIT) >>> 0;
}
