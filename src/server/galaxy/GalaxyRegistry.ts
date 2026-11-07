/**
 * Resolves a `GalaxySector.key` to the SectorRoom-ready options bag passed
 * into `gameServer.define`. Keeps `src/server/index.ts`'s boot loop a thin
 * shell; configuration knobs live here.
 *
 * See docs/architecture/galaxy-graph.md for the walkthrough.
 */
import { sectorSpace, SOLAR_SECTORS } from '../../shared-types/sectorBounds.js';
import { sectorSites } from '../../core/galaxy/sectorSites.js';
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
  /** T1 — grow the sector's NPC base (`SectorRoom.seedGalaxyBase`). */
  galaxyBases: boolean;
  /** v4 A — seed the Ancients' border gates (`SectorRoom.seedAlienGates`). */
  alienGates: boolean;
}

export function resolveSectorConfig(key: string): ResolvedSectorConfig {
  const sector = getSector(key);
  if (!sector) {
    throw new Error(`resolveSectorConfig: unknown galaxy sector key '${key}'`);
  }
  return {
    sectorKey: sector.key,
    // Fields spread with the sector space; rock sizes stay (round 3 C).
    asteroidConfig: [
      ...ASTEROID_CONFIGS[sector.asteroidConfigKey].map((a) => ({ ...a, x: sectorSpace(a.x), y: sectorSpace(a.y) })),
      ...(SOLAR_SECTORS ? beltPocketAsteroids(sector.key) : []),
    ],
    droneCount: sector.droneCount,
    maxClients: DEFAULT_MAX_CLIENTS,
    galaxyBases: true,
    alienGates: true,
  };
}

/**
 * Solar-system sectors (Phase 4): each belt pocket is a mining field, two
 * rings of the dense pattern around its centre (rock sizes as authored).
 */
export function beltPocketAsteroids(sectorKey: string): AsteroidSpec[] {
  const out: AsteroidSpec[] = [];
  for (const site of sectorSites(sectorKey)) {
    if (site.kind !== 'belt') continue;
    for (const [ring, spread, turn] of [[0, 3, 0], [1, 5, Math.PI]] as const) {
      const c = Math.cos(turn), sn = Math.sin(turn);
      for (const a of ASTEROID_CONFIGS.dense) {
        const ox = (a.x * c - a.y * sn) * spread, oy = (a.x * sn + a.y * c) * spread;
        out.push({ ...a, id: `${site.id}-${ring}-${a.id}`, x: Math.round(site.x + ox), y: Math.round(site.y + oy) });
      }
    }
  }
  return out;
}

export function listGalaxySectors(): readonly GalaxySector[] {
  return GALAXY_SECTORS;
}
