/**
 * RTS fleet warp (S7/S8): the commander's view follows their fleet.
 *
 * In Command view the commander flies no ship. When their fleet warp commits,
 * the server reserves them a SPECTATOR seat at the fleet's arrival point and
 * sends `transit_ready` with the ids of the ships that went. The client takes
 * the ONE existing room-change path (the `transit_ready` handler), skipping
 * only the local ship's trip (there is no local ship to fly out), so the load
 * curtain covers the switch (a short spinner). Once the warped ships show up
 * in the destination's mirror (same shipInstanceIds), they are re-selected
 * and the camera glides to them.
 *
 * Pure (no store, no renderer): decisions only, unit-tested.
 */

type PilotMode = 'pilot' | 'spectator';

/** True when this `transit_ready` is a commander following their fleet with
 *  no ship of their own: the trip code for the local ship is skipped. */
export function isCommanderFleetFollow(shipIds: readonly string[] | undefined, pilotMode: PilotMode): boolean {
  return shipIds !== undefined && pilotMode === 'spectator';
}

/** True when the IN_TRANSIT edge should start the local ship's trip. In
 *  Command view (no flown ship) only a fleet warp can commit, and there is no
 *  local ship to fly out. */
export function transitStartsLocalTrip(pilotMode: PilotMode): boolean {
  return pilotMode !== 'spectator';
}

/** After the first warped ship shows up, wait this long for the rest (they
 *  arrive in the same hand-off, but snapshots carry them in over a few). */
export const FLEET_ARRIVAL_SETTLE_MS = 1000;
/** Stop waiting entirely after this (every ship was lost on the way). */
export const FLEET_ARRIVAL_GIVE_UP_MS = 15_000;

/** One pending re-selection (armed at `transit_ready`). */
export interface FleetArrivalWatch {
  ids: readonly string[];
  armedAtMs: number;
  /** When the first of `ids` appeared in the mirror; null until then. */
  firstSeenAtMs: number | null;
}

export interface FleetArrival {
  /** The warped ships present now (a subset when some never arrived). */
  ids: string[];
  /** Their centroid, game space (the camera glide target). */
  x: number;
  y: number;
}

/**
 * Step the watch once per frame. Returns:
 *  - a `FleetArrival` once every id is present, or the settle window after the
 *    first one passed (fire once, then drop the watch);
 *  - `'drop'` when nothing arrived before the give-up deadline;
 *  - null while still waiting (mutates `w.firstSeenAtMs`).
 * Allocates only on the one frame it fires.
 */
export function stepFleetArrival(
  w: FleetArrivalWatch,
  ships: ReadonlyMap<string, { x: number; y: number }>,
  nowMs: number,
): FleetArrival | 'drop' | null {
  let present = 0;
  for (let i = 0; i < w.ids.length; i++) if (ships.has(w.ids[i]!)) present++;
  if (present === 0) return nowMs - w.armedAtMs > FLEET_ARRIVAL_GIVE_UP_MS ? 'drop' : null;
  if (w.firstSeenAtMs === null) w.firstSeenAtMs = nowMs;
  if (present < w.ids.length && nowMs - w.firstSeenAtMs < FLEET_ARRIVAL_SETTLE_MS) return null;
  const ids: string[] = [];
  let sx = 0, sy = 0;
  for (let i = 0; i < w.ids.length; i++) {
    const s = ships.get(w.ids[i]!);
    if (s === undefined) continue;
    ids.push(w.ids[i]!);
    sx += s.x; sy += s.y;
  }
  return { ids, x: sx / ids.length, y: sy / ids.length };
}
