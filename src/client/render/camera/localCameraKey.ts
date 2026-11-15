/**
 * Which sprite a camera cue on `'local'` should follow.
 *
 * Piloting, that is the local player's ship sprite (keyed by the player id).
 * Spectating, the pilot's ship is parked: it is drawn under its ship-instance
 * id (since RTS Part A S3 in the same ship list as every ship), so the
 * player-id lookup finds nothing and the shot fell back to a wide view
 * (review 2026-11-12, capital-lineup / capital-breakup). Fall back to the
 * first parked hull the pilot owns (`isParkedHull` + `isOwnedByMe`, #17).
 *
 * Called per frame by the camera director: no allocation (invariant #14) —
 * one reused result object and a pre-bound search callback.
 */
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import { isOwnedByMe, isParkedHull } from '../shipOwnership';

export interface LocalCameraKey {
  key: string;
  /** True when the key is the pilot's parked hull. */
  parked: boolean;
}

const result: LocalCameraKey = { key: '', parked: false };
let searchMirror: RenderMirror | null = null;
let found: string | null = null;
function visit(entry: ShipRenderState, id: string): void {
  if (found !== null || searchMirror === null) return;
  if (isParkedHull(searchMirror, id, entry) && isOwnedByMe(searchMirror, id, entry)) found = id;
}

export function localCameraKey(
  mirror: RenderMirror | null,
  isDrawn: (key: string) => boolean,
): LocalCameraKey | null {
  const localPlayerId = mirror?.localPlayerId ?? null;
  if (mirror === null || localPlayerId === null) return null;
  if (isDrawn(localPlayerId)) {
    result.key = localPlayerId;
    result.parked = false;
    return result;
  }
  searchMirror = mirror;
  found = null;
  mirror.ships.forEach(visit);
  searchMirror = null;
  if (found === null) return null;
  result.key = found;
  result.parked = true;
  return result;
}
