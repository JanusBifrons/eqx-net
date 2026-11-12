/**
 * Which sprite a camera cue on `'local'` should follow.
 *
 * Piloting, that is the local player's ship sprite (keyed by the player id).
 * Spectating, the pilot's ship is parked and drawn from the lingering sprites,
 * keyed by its ship-instance id, so the player-id lookup finds nothing and
 * the shot fell back to a wide view (review 2026-11-12, capital-lineup /
 * capital-breakup). Fall back to the parked hull the pilot owns.
 *
 * Called per frame by the camera director: no allocation (invariant #14) —
 * one reused result object and a pre-bound search callback.
 */
export interface LocalCameraKey {
  key: string;
  /** True when the key is the pilot's parked (lingering) hull. */
  parked: boolean;
}

const result: LocalCameraKey = { key: '', parked: false };
let searchOwner = '';
let found: string | null = null;
function visit(entry: { ownerPlayerId: string }, id: string): void {
  if (found === null && entry.ownerPlayerId === searchOwner) found = id;
}

export function localCameraKey(
  localPlayerId: string | null,
  isDrawn: (key: string) => boolean,
  lingering: ReadonlyMap<string, { ownerPlayerId: string }> | undefined,
): LocalCameraKey | null {
  if (localPlayerId === null) return null;
  if (isDrawn(localPlayerId)) {
    result.key = localPlayerId;
    result.parked = false;
    return result;
  }
  if (!lingering || lingering.size === 0) return null;
  searchOwner = localPlayerId;
  found = null;
  lingering.forEach(visit);
  if (found === null) return null;
  result.key = found;
  result.parked = true;
  return result;
}
