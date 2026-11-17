/**
 * Galaxy feed — `RobotTerritory.sectorControl` (the snapshot's `control`
 * object) and the per-sector history ring sampled on the control tick.
 */
import { describe, expect, it } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { RobotTerritory, THREAT_STRUCTURE_HIT_WINDOW_MS } from './RobotTerritory.js';
import type { FactionPresenceMap } from './factionPresence.js';
import type { LivingWorldRoom, SectorLiveCounts } from './LivingWorldRoom.js';
import { HISTORY_SAMPLE_MS } from './sectorControlHistory.js';

interface RoomKnobs { byFaction: FactionPresenceMap; lockSides?: string[]; hitSide?: string; combat?: boolean }

function mockRoom(k: RoomKnobs): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => false,
    liveCounts: (): SectorLiveCounts => ({ players: 0, enemies: 0, neutrals: 0, structures: 0, byFaction: k.byFaction, lockSides: k.lockSides }),
    sideStructuresHitWithin: (side: string, windowMs: number) => windowMs === THREAT_STRUCTURE_HIT_WINDOW_MS && side === k.hitSide,
    recentCombat: () => (k.combat ? { shipsDestroyed: 1, structuresDestroyed: 0, lastEventMs: 0 } : null),
  } as unknown as LivingWorldRoom;
}

const sides = (o: Record<string, [number, number]>): FactionPresenceMap =>
  new Map(Object.entries(o).map(([k, [ships, structures]]) => [k, { ships, structures }]));

function setup(key: string, knobs: RoomKnobs) {
  const clock = { now: 0 };
  const rooms = new Map<string, LivingWorldRoom>([[key, mockRoom(knobs)]]);
  const t = new RobotTerritory(rooms, () => new Map(), { nowMs: () => clock.now, nexusSector: '__none__' });
  t.start();
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; t.tick(clock.now); }
  };
  return { t, run, clock, knobs };
}

describe('RobotTerritory.sectorControl — the feed control object', () => {
  it('a calm seeded sector: full share, no challenger, steady, no threat', () => {
    const { t } = setup('sol-prime', { byFaction: new Map() });
    expect(t.sectorControl('sol-prime')).toEqual({
      holderShare: 100, challenger: null, challengerShare: 0, trend: 0, threat: 0, flippedAtMs: null, locked: false,
    });
    expect(t.sectorControl('nowhere')).toBeNull();
    t.stop();
  });

  it('a challenger pushing in: falling share, challenger named, threat rises with combat and hits', () => {
    const knobs: RoomKnobs = { byFaction: sides({ alice: [5, 0] }) };
    const { t, run } = setup('sol-prime', knobs);
    run(5);
    const c = t.sectorControl('sol-prime')!;
    expect(c.trend).toBe(-1);
    expect(c.challenger).toBe('alice');
    expect(c.challengerShare).toBeGreaterThan(0);
    expect(c.holderShare).toBeLessThan(100);
    expect(c.threat).toBe(1);
    knobs.combat = true;
    expect(t.sectorControl('sol-prime')!.threat).toBe(2);
    knobs.hitSide = 'core';
    expect(t.sectorControl('sol-prime')!.threat).toBe(3);
    t.stop();
  });

  it('records the flip time and reports a holder lock', () => {
    const knobs: RoomKnobs = { byFaction: sides({ alice: [4, 2] }), lockSides: ['alice'] };
    const { t, run, clock } = setup('orion-belt', knobs);
    run(60);
    const c = t.sectorControl('orion-belt')!;
    expect(t.sectorOwner('orion-belt')?.factionId).toBe('alice');
    expect(c.flippedAtMs).not.toBeNull();
    expect(c.flippedAtMs!).toBeLessThanOrEqual(clock.now);
    expect(c.locked).toBe(true);
    t.stop();
  });

  it('samples history once a minute from the control tick', () => {
    const { t, run } = setup('sol-prime', { byFaction: new Map() });
    run(1);
    expect(t.history('sol-prime')).toEqual([{ atMs: 1000, holder: 'core', holderShare: 100 }]);
    run(HISTORY_SAMPLE_MS / 1000 - 1);
    expect(t.history('sol-prime')).toHaveLength(1);
    run(1);
    expect(t.history('sol-prime')).toHaveLength(2);
    t.stop();
  });
});
