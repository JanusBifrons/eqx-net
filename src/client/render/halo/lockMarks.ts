/**
 * Lock marks on the edge radar (pure, unit-locked). Lock-to-fire NPC locks
 * start beyond the screen edge, so the off-screen icon of a contact in a lock
 * relationship with the local ship is tinted:
 *   - locking YOU (own-ship `lockedBy`, acquiring or locked) → threat red;
 *   - one of YOUR LOCKED targets (`groups[gi].l[].s === 2`) → that group's colour.
 * Threat wins when both apply. Scans the (tiny) lock arrays — no allocation,
 * safe per frame (invariant #14). Keys are the fire-control lock keys
 * (`s:<entityId>` / `p:<playerId>`).
 */
import { groupColour, THREAT_COLOUR } from '../../hud/groupColours.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

/** No lock relationship → draw in the category colour. */
export const LOCK_TINT_NONE = -1;

export function radarLockTint(
  lockKey: string,
  groups: RenderMirror['localGroups'],
  lockedBy: RenderMirror['localLockedBy'],
): number {
  if (lockedBy) {
    for (let i = 0; i < lockedBy.length; i++) {
      const l = lockedBy[i]!;
      if (l.t === lockKey && l.s >= 1) return THREAT_COLOUR;
    }
  }
  if (groups) {
    for (let gi = 0; gi < groups.length; gi++) {
      const locks = groups[gi]!.l;
      for (let i = 0; i < locks.length; i++) {
        const l = locks[i]!;
        if (l.s === 2 && l.t === lockKey) return groupColour(gi);
      }
    }
  }
  return LOCK_TINT_NONE;
}
