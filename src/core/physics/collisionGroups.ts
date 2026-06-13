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
