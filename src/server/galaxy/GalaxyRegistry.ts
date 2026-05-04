/**
 * Resolves a `GalaxySector.key` to the SectorRoom-ready options bag passed
 * into `gameServer.define`. Keeps `src/server/index.ts`'s boot loop a thin
 * shell; configuration knobs live here.
 *
 * See docs/architecture/galaxy-graph.md for the walkthrough.
 */
import { GALAXY_SECTORS, getSector } from '../../core/galaxy/galaxy.js';
import type { GalaxySector } from '../../core/galaxy/galaxy.js';
import { ASTEROID_CONFIGS } from './asteroidConfigs.js';
import type { AsteroidSpec } from '../spawn/SwarmSpawner.js';

const DEFAULT_MAX_CLIENTS = 16;

export interface ResolvedSectorConfig {
  /** Stable identity, becomes `roomOpts.sectorKey`. */
  sectorKey: string;
  /** Resolved roster, becomes `roomOpts.asteroidConfig`. */
  asteroidConfig: ReadonlyArray<AsteroidSpec>;
  /** Number of drones to seed at room creation. */
  droneCount: number;
  /** Per-room player cap. */
  maxClients: number;
}

export function resolveSectorConfig(key: string): ResolvedSectorConfig {
  const sector = getSector(key);
  if (!sector) {
    throw new Error(`resolveSectorConfig: unknown galaxy sector key '${key}'`);
  }
  return {
    sectorKey: sector.key,
    asteroidConfig: ASTEROID_CONFIGS[sector.asteroidConfigKey],
    droneCount: sector.droneCount,
    maxClients: DEFAULT_MAX_CLIENTS,
  };
}

export function listGalaxySectors(): readonly GalaxySector[] {
  return GALAXY_SECTORS;
}
