/**
 * A blueprint whose build is complete but that has not turned solid yet: the
 * server finishes a blueprint only when no ship overlaps its footprint
 * (`src/server/structures/blueprintBody.ts`), so a hull parked inside it makes
 * it wait. Derived from the room-state row alone (buildPct + built, #16), so a
 * late joiner sees the same status. Read by the in-world build label
 * (`swarmSpriteUpdater`) and the structure inspector (`EntityStatsPanel`).
 */
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';

/** In-world label above the blueprint (short; drawn at 13 CSS px). */
export const BUILD_AWAITING_CLEAR_LABEL = 'WAITING FOR SHIPS TO CLEAR';
/** Inspector card line. */
export const BUILD_AWAITING_CLEAR_LINE = 'FINISHED — WAITING FOR SHIPS TO CLEAR';

/** True when the build is done but the structure is still a blueprint. */
export function isBuildAwaitingClear(
  st: Pick<StructureRenderState, 'built' | 'buildPct' | 'isDeconstructing'>,
): boolean {
  return st.built !== true && st.buildPct >= 1 && st.isDeconstructing !== true;
}
