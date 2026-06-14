import { describe, it, expect } from 'vitest';
import { LivingWorldDirector, type LivingWorldOptions } from './LivingWorldDirector.js';
import type { LivingWorldRoom, SectorLiveCounts } from './LivingWorldRoom.js';
import { Bus } from '../../core/events/Bus.js';
import { getSector } from '../../core/galaxy/galaxy.js';

/** A LivingWorldRoom mock with benign defaults — only the surface the
 *  director's start() + galaxy-stats recompute touches needs real behaviour
 *  (eventBus / playerCount / liveCounts); the rest are interface stubs. */
function fullMockRoom(over: Partial<LivingWorldRoom>): LivingWorldRoom {
  const bus = new Bus();
  const base: LivingWorldRoom = {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => false,
    spawnLivingWorldBot: () => false,
    despawnLivingWorldBot: () => null,
    markBotHostile: () => {},
    getBotPose: () => null,
    setBotMoveTarget: () => {},
    factionBaseReadiness: () => [],
    setFactionUnderWave: () => {},
    markSquadHostileToFaction: () => {},
    purgeFactionHostility: () => {},
    broadcastWarpWarning: () => {},
    broadcastWarpWarningClear: () => {},
  };
  return { ...base, ...over };
}

function withCounts(c: SectorLiveCounts): LivingWorldRoom {
  return fullMockRoom({ playerCount: () => c.players, liveCounts: () => c });
}

// botCount 0 → no bot pool seeded; huge interval → the control timer never
// fires during the test (start() populates the cache once; we read it directly).
const OPTS: Partial<LivingWorldOptions> & { rng: () => number; nowMs: () => number } = {
  botCount: 0,
  controlIntervalMs: 1_000_000,
  rng: () => 0,
  nowMs: () => 0,
};

describe('LivingWorldDirector.galaxySnapshot', () => {
  it('aggregates per-room live counts and stamps the static region faction', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', withCounts({ players: 2, enemies: 0, neutrals: 1, structures: 3 })],
      ['orion-belt', withCounts({ players: 0, enemies: 4, neutrals: 2, structures: 0 })],
    ]);
    const director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    try {
      const snap = director.galaxySnapshot();
      expect(snap).toHaveLength(2);

      const sol = snap.find((s) => s.key === 'sol-prime')!;
      expect(sol).toMatchObject({ players: 2, enemies: 0, neutrals: 1, structures: 3 });
      expect(sol.owner).toEqual({ factionId: getSector('sol-prime')!.region, contested: false });

      const orion = snap.find((s) => s.key === 'orion-belt')!;
      expect(orion).toMatchObject({ players: 0, enemies: 4, neutrals: 2, structures: 0 });
      expect(orion.owner!.factionId).toBe(getSector('orion-belt')!.region);
    } finally {
      director.stop();
    }
  });

  it('falls back to playerCount + zero counts when a room omits liveCounts', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['vega-reach', fullMockRoom({ playerCount: () => 5 })], // no liveCounts
    ]);
    const director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    try {
      const vega = director.galaxySnapshot().find((s) => s.key === 'vega-reach')!;
      expect(vega).toMatchObject({ players: 5, enemies: 0, neutrals: 0, structures: 0 });
    } finally {
      director.stop();
    }
  });
});
