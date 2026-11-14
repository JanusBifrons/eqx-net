/**
 * The ONE answer to "under which mirror key does this wire ship live?"
 * (RTS Part A S0). Both the snapshot router (`snapshotShipRouter.ts`, pose)
 * and the schema diff (`ColyseusClient.syncMirror`, identity) ask it, so the
 * two can never disagree about which ship is the local player's again.
 *
 * Keys (plan Part A: one ship list, mixed keys):
 *  - `playerId`        — an ACTIVE ship (`mirror.ships`; local prediction is
 *                        playerId-keyed), and the local player's WELCOME ship
 *                        while it is still `isActive=false` during the
 *                        pending-join handshake (the bootstrap chain needs it
 *                        in `mirror.ships`).
 *  - `shipInstanceId`  — a parked hull (`mirror.ships`, same list since S3): any inactive
 *                        ship that is not the pending welcome ship, including
 *                        the local player's displaced hulls and the hull they
 *                        parked by Spectate / Command. ALSO the spectate race:
 *                        the local player let go of the controls but the wire
 *                        still lists their ship ACTIVE (the server's
 *                        `isActive=false` lands a tick or more after the send).
 *                        `ColyseusClient.dropLocalShipForCommand` has already
 *                        moved the drawn entry to the shipInstanceId (seamless
 *                        hand-over, RTS Part A), so the ship keeps being drawn
 *                        as the hull it is becoming; it is never keyed by the
 *                        playerId (a pose-less schema entry there respawned a
 *                        phantom local ship at (0,0), 2026-11-12).
 *  - `null`            — never returned since the seamless hand-over (kept in
 *                        the type for callers' guards).
 *
 * Null `localShipInstanceId` (decided 2026-11-14, S0): the welcome carried no
 * ship id. That happens only when the server has NO ship for us — the
 * shipless join-as-spectator, or a rebind whose hull is gone. (Engineering
 * rooms get a synthetic UUID before the welcome, so they are not this case.)
 * With no welcome ship there is nothing pending, so NO inactive own hull is
 * ever claimed as the pending-join ship: each stays a parked hull under its
 * own shipInstanceId. Claiming by playerId would let several own hulls fight
 * over one `mirror.ships` key — the 2026-06-03 "pinned in my old interceptor"
 * bug class. (Before S0 the router already did this; `syncMirror` claimed
 * the hull by playerId, and the two disagreed.)
 *
 * Pure and allocation-free: scalars in, one string (or null) out. Lock:
 * `shipMirrorKey.test.ts`.
 */

export interface ShipMirrorKeyLocal {
  /** The local player's id (null before the welcome). */
  localPlayerId: string | null;
  /** The welcome ship's id (null when the welcome carried none). */
  localShipInstanceId: string | null;
  /** The local player chose Spectate (or Command view): they fly nothing. */
  localSpectating: boolean;
}

export function shipMirrorKey(
  shipInstanceId: string,
  playerId: string,
  isActive: boolean,
  local: ShipMirrorKeyLocal,
): string | null {
  const own = local.localPlayerId !== null && playerId === local.localPlayerId;
  if (isActive) {
    // Spectate race: we fly nothing, so our own ACTIVE entry is the hull we
    // just parked: drawn under its shipInstanceId, never the playerId.
    if (own && local.localSpectating) return shipInstanceId;
    return playerId;
  }
  // Inactive: only the pending welcome ship keeps its playerId key.
  if (
    own
    && !local.localSpectating
    && local.localShipInstanceId !== null
    && shipInstanceId === local.localShipInstanceId
  ) {
    return playerId;
  }
  return shipInstanceId;
}
