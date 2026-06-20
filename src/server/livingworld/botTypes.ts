/**
 * Living World — shared bot value types.
 *
 * Kept in its own tiny module (not inside the ~3.8k-line SectorRoom) so
 * the director / transit controller can depend on the carry-state shape
 * without importing the room's full surface, and so SectorRoom imports a
 * narrow type rather than the other way round.
 */
import type { ShipKindId } from '../../shared-types/shipKinds.js';

/**
 * The state a bot carries across a server-internal inter-sector warp.
 * Captured by `SectorRoom.despawnLivingWorldBot` (SAB pose + health +
 * kind) and replayed by `spawnLivingWorldBot` in the destination room —
 * the in-process analogue of the player Limbo payload (bots are not
 * Colyseus clients, so they never touch Limbo / reserveSeatFor / onJoin).
 */
export interface BotCarry {
  kind: ShipKindId;
  health: number;
  /** WS-E #13/#19 — the bot's pre-despawn WORLD position in the SOURCE sector.
   *  Carried so a hop ARRIVES near where it left (clamped to the destination
   *  bounds), instead of all attackers snapping to one clustered edge anchor.
   *  Captured in `LivingWorldBotHooks.despawnBot` from the live SAB pose. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}
