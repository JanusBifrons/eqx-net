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
 * The same watch frames a command-view JOIN (`commandArrivalWatch`): the
 * camera followed the pre-arrival local ship, whose drawn pose can be far
 * from the hull (a re-join seeds it at the pose-less schema's (0, 0) and it
 * glides in), so at the arrival flip the camera is pointed at the hull once
 * its snapshot pose has landed. Frame only: nothing is selected.
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
  /** Command-view join: frame the hull only (no re-select), and only after
   *  the settle window (its drawn pose at the flip is the pre-arrival one). */
  frameOnly?: boolean;
}

/** The watch a command-view join arms at the arrival flip for its own hull. */
export function commandArrivalWatch(hullId: string, nowMs: number): FleetArrivalWatch {
  return { ids: [hullId], armedAtMs: nowMs, firstSeenAtMs: null, frameOnly: true };
}

export interface FleetArrival {
  /** The warped ships present now (a subset when some never arrived). */
  ids: string[];
  /** Their centroid, game space (the camera glide target). */
  x: number;
  y: number;
  /** Re-select `ids` (a fleet warp); false for a command-view join. */
  select: boolean;
}

/** Glide to the arrival unless it is a join whose hull is already near the
 *  middle of the view (`viewHalf`: half the view's larger extent). */
export function arrivalNeedsGlide(a: FleetArrival, viewX: number, viewY: number, viewHalf: number): boolean {
  if (a.select) return true;
  const near = viewHalf * 0.25;
  return Math.abs(a.x - viewX) > near || Math.abs(a.y - viewY) > near;
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
  const settling = nowMs - w.firstSeenAtMs < FLEET_ARRIVAL_SETTLE_MS;
  if (settling && (present < w.ids.length || w.frameOnly === true)) return null;
  const ids: string[] = [];
  let sx = 0, sy = 0;
  for (let i = 0; i < w.ids.length; i++) {
    const s = ships.get(w.ids[i]!);
    if (s === undefined) continue;
    ids.push(w.ids[i]!);
    sx += s.x; sy += s.y;
  }
  return { ids, x: sx / ids.length, y: sy / ids.length, select: w.frameOnly !== true };
}
