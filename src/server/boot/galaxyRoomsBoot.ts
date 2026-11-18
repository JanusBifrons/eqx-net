import { matchMaker } from 'colyseus';
import type { Logger } from 'pino';
import type { SectorRoom } from '../rooms/SectorRoom.js';
import { galaxySectorsToBoot } from '../rooms/galaxyBoot.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

/**
 * Boot step 4 — eagerly create the galaxy rooms (and the E2E wave room when
 * armed). Returns the sector-key → room map the directors run over.
 */
export async function createGalaxyRooms(deps: { logger: Logger }): Promise<Map<string, SectorRoom>> {
  const { logger } = deps;
  // Phase 8 — eagerly instantiate each galaxy room so they hydrate from
  // snapshots at boot (not on first traveller) and so future transit
  // reservations always find a live destination. Sequential await: the
  // matchmaker doesn't love parallel `create` calls during boot.
  const galaxyRooms = new Map<string, SectorRoom>();
  // EQX_GALAXY_SECTORS (memory, 2026-11-07): which sectors boot eagerly. Unset
  // = all (normal play). A test or showcase server that only uses test rooms
  // boots none; a sector left out still starts on demand when someone joins.
  const bootSectors = galaxySectorsToBoot(GALAXY_SECTORS.map((s) => s.key));
  if (bootSectors.length !== GALAXY_SECTORS.length) logger.info({ sectors: bootSectors }, 'EQX_GALAXY_SECTORS: booting a subset of the galaxy');
  for (const sector of GALAXY_SECTORS) {
    if (!bootSectors.includes(sector.key)) continue;
    try {
      const listing = await matchMaker.createRoom(`galaxy-${sector.key}`, {});
      const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as SectorRoom;
      galaxyRooms.set(sector.key, room);
      logger.info({ sectorKey: sector.key }, 'galaxy room created');
    } catch (err) {
      logger.error({ err, sectorKey: sector.key }, 'failed to eagerly create galaxy room');
    }
  }

  // Wave-system E2E — when EQX_E2E_WAVE=1, eager-create the player-owned
  // ready-base room and add it to the director's room map so the WaveDirector
  // polls it + sends a squad once the owner (`wave-tester`) joins. Boot-gated
  // so production never spins it up. Added AFTER the galaxy loop so no squad
  // homes here (squads home at sectorKeys[0..2]); the assigned squad warps IN
  // → fires the warp_warning banner the spec asserts on.
  if (process.env['EQX_E2E_WAVE'] === '1') {
    try {
      const listing = await matchMaker.createRoom('galaxy-wave-test', {});
      const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as SectorRoom;
      galaxyRooms.set('galaxy-wave-test', room);
      logger.info('E2E wave-attack room created + director-managed (EQX_E2E_WAVE=1)');
    } catch (err) {
      logger.error({ err }, 'failed to create E2E wave-attack room');
    }
  }
  return galaxyRooms;
}
