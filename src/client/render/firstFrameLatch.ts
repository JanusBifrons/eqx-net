/**
 * Pure decision for the renderer's join-render readiness latch (Phase A3 —
 * renderer decision logic lives in a pure, unit-lockable module, never inlined
 * in `PixiRenderer`).
 *
 * `firstFrameRendered` is one of the gates `computeBootstrapReadyFromState`
 * ANDs before the client sends `client_ready` (which lifts the load curtain).
 * It must flip true once the renderer has painted a frame the player can
 * meaningfully see.
 *
 * **The shipless-spectator fix (Equinox Phase-5 audit, 2026-06-21).** The latch
 * used to require the LOCAL player's ship in the mirror
 * (`mirror.ships.has(localPlayerId)`). A JOIN-AS-SPECTATOR player has NO ship, so
 * that condition could never be met → `firstFrameRendered` never flipped →
 * `client_ready` never sent → the curtain HUNG until the server's 30 s watchdog
 * ("connecting → taking longer than expected"). When SPECTATING, the painted
 * frame (starfield + the sector) IS what the player sees, so the latch flips on
 * a painted frame once we've been welcomed (`localPlayerId !== null`).
 */

export function shouldLatchFirstFrame(
  alreadyLatched: boolean,
  localPlayerId: string | null,
  hasLocalShip: boolean,
  spectator: boolean,
): boolean {
  if (alreadyLatched) return false;
  if (localPlayerId === null) return false;
  // Piloting: wait until we've painted the local player's OWN ship (not just any
  // remote ship — strict enough that an idle sector with only remote ships
  // visible doesn't flip the gate early). Spectating: there is no own ship, so a
  // painted frame of the sector is the readiness signal.
  return hasLocalShip || spectator;
}
