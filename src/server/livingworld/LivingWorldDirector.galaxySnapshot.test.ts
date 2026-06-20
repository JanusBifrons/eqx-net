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
    factionHostility: (id) => ({ playerId: id, structureIds: [] }),
    getBotPose: () => null,
    setBotMoveTarget: () => {},
    setBotFlockFollow: () => {},
    setBotFlockLeaderCourse: () => {},
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
  it('aggregates per-room counts; enemies are FACTION-derived (no waves ⇒ all present drones are neutral)', () => {
    // The director re-splits enemies vs neutrals by squad faction-hostility, NOT
    // the room's present-player view. With botCount:0 there are no squads/waves,
    // so EVERY present drone is neutral — the room's `enemies` count is folded
    // back into `neutrals` (total present drones is preserved). Squad-derived
    // enemy counting is locked in population.test.ts (enemyBotCountsBySector).
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
      // No wave ⇒ enemies 0; the mock's 4 "enemies" + 2 neutrals = 6 present
      // drones, all classified neutral (total preserved).
      expect(orion).toMatchObject({ players: 0, enemies: 0, neutrals: 6, structures: 0 });
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

  it('forwards each room\'s recentCombat into the snapshot (null when the room omits it)', () => {
    // Equinox Phase 9 item 5 — the room owns the sliding window; the director just
    // forwards `recentCombat()`, defaulting to null for rooms that omit the hook.
    const rc = { shipsDestroyed: 2, structuresDestroyed: 1, lastEventMs: 123 };
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', fullMockRoom({ recentCombat: () => rc })],
      ['orion-belt', fullMockRoom({})], // omits recentCombat → null
    ]);
    const director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    try {
      const snap = director.galaxySnapshot();
      expect(snap.find((s) => s.key === 'sol-prime')!.recentCombat).toEqual(rc);
      expect(snap.find((s) => s.key === 'orion-belt')!.recentCombat).toBeNull();
    } finally {
      director.stop();
    }
  });
});

describe('LivingWorldDirector.playerStructurePresence (Equinox Phase 7)', () => {
  it('aggregates owned-structure counts per sector, omitting sectors the player owns nothing in', () => {
    const rooms = new Map<string, LivingWorldRoom>([
      ['sol-prime', fullMockRoom({ ownedStructureCount: (pid) => (pid === 'p1' ? 3 : 0) })],
      ['orion-belt', fullMockRoom({ ownedStructureCount: (pid) => (pid === 'p1' ? 1 : 9) })],
      ['vega-reach', fullMockRoom({ ownedStructureCount: () => 0 })], // p1 owns nothing here
      ['lyra-fringe', fullMockRoom({})], // room omits the hook entirely → 0
    ]);
    const director = new LivingWorldDirector(rooms, OPTS);
    director.start();
    try {
      const presence = director.playerStructurePresence('p1');
      // Only sectors where p1 owns ≥ 1 structure, with p1's own counts.
      expect(presence).toEqual(
        expect.arrayContaining([
          { key: 'sol-prime', structures: 3 },
          { key: 'orion-belt', structures: 1 },
        ]),
      );
      expect(presence).toHaveLength(2);
      expect(presence.find((s) => s.key === 'vega-reach')).toBeUndefined();
      expect(presence.find((s) => s.key === 'lyra-fringe')).toBeUndefined();
    } finally {
      director.stop();
    }
  });
});
