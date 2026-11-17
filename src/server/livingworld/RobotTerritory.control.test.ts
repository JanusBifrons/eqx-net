/**
 * Step 1c — `RobotTerritory` steps the control meter for EVERY side
 * (`stepMultiControl`), seeded from the static controllers, and `sectorOwner`
 * reports whichever side holds a sector. Mock rooms: only `liveCounts` and the
 * nexus-placement surface are real.
 */
import { describe, expect, it } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { RobotTerritory } from './RobotTerritory.js';
import { controlOpposes, fillSectorPresence, type FactionPresenceMap } from './factionPresence.js';
import type { LivingWorldRoom, SectorLiveCounts } from './LivingWorldRoom.js';
import type { SidePresence } from '../../core/territory/sectorControl.js';

function mockRoom(byFaction: () => FactionPresenceMap): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => false, // the nexus never spawns here: robots stay out of it
    liveCounts: (): SectorLiveCounts => ({ players: 0, enemies: 0, neutrals: 0, structures: 0, byFaction: byFaction() }),
  } as unknown as LivingWorldRoom;
}

function setup(presence: Record<string, FactionPresenceMap>, robots: Record<string, number> = {}) {
  const clock = { now: 0 };
  const rooms = new Map<string, LivingWorldRoom>();
  for (const key of Object.keys(presence)) rooms.set(key, mockRoom(() => presence[key]!));
  const t = new RobotTerritory(rooms, () => new Map(Object.entries(robots)), {
    nowMs: () => clock.now,
    nexusSector: '__none__',
  });
  t.start();
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; t.tick(clock.now); }
  };
  return { t, run };
}

const sides = (o: Record<string, [number, number]>): FactionPresenceMap =>
  new Map(Object.entries(o).map(([k, [ships, structures]]) => [k, { ships, structures }]));

describe('RobotTerritory — control for every side', () => {
  it('a player with 4 ships + 2 structures claims a neutral sector', () => {
    const { t, run } = setup({ 'orion-belt': sides({ alice: [4, 2] }) });
    expect(t.sectorOwner('orion-belt')).toBeNull();
    run(60);
    expect(t.sectorOwner('orion-belt')).toEqual({ factionId: 'alice', contested: false });
    t.stop();
  });

  it('a seeded Sol sector starts Sol\'s and stays Sol\'s while empty', () => {
    const { t, run } = setup({ 'sol-prime': new Map(), bloomgate: new Map(), 'orion-belt': new Map() });
    expect(t.sectorOwner('sol-prime')).toEqual({ factionId: 'core', contested: false });
    expect(t.sectorOwner('bloomgate')).toEqual({ factionId: 'verdant-reach', contested: false });
    expect(t.sectorOwner('orion-belt')).toBeNull();
    run(600);
    expect(t.sectorOwner('sol-prime')).toEqual({ factionId: 'core', contested: false });
    expect(t.heldSectors('core')).toEqual(['sol-prime']);
    t.stop();
  });

  it('a player in a Sol sector contests it and, staying long enough, takes it', () => {
    const presence = { 'sol-prime': sides({ alice: [5, 0] }) };
    const { t, run } = setup(presence);
    run(1);
    expect(t.sectorOwner('sol-prime')).toEqual({ factionId: 'core', contested: true });
    run(200);
    expect(t.sectorOwner('sol-prime')?.factionId).toBe('alice');
    t.stop();
  });

  it('Traders in a Sol sector never weaken Sol (friendly sides)', () => {
    const { t, run } = setup({ 'sol-prime': sides({ traders: [6, 0] }) });
    run(200);
    expect(t.sectorOwner('sol-prime')).toEqual({ factionId: 'core', contested: false });
    t.stop();
  });

  it('robots (the director count) claim a neutral sector; robot hulls are not also counted as ships', () => {
    // The room tallies the same 6 robot hulls under `robots` ships; the meter
    // must use the director's 6 robots (×12), not add 6×15 ships on top.
    const { t, run } = setup({ 'orion-belt': sides({ robots: [6, 0] }) }, { 'orion-belt': 6 });
    run(60);
    expect(t.sectorOwner('orion-belt')).toEqual({ factionId: 'robots', contested: false });
    t.stop();
  });
});

describe('controlOpposes', () => {
  it('reads the faction stance tables: robots fight everyone, Sol and the Traders do not', () => {
    expect(controlOpposes('core', 'traders')).toBe(false);
    expect(controlOpposes('core', 'verdant-reach')).toBe(false);
    expect(controlOpposes('robots', 'core')).toBe(true);
    expect(controlOpposes('core', 'robots')).toBe(true);
    expect(controlOpposes('robots', 'drones')).toBe(true);
    expect(controlOpposes('core', 'core')).toBe(false);
  });

  it('a player contests every other side, other players included', () => {
    expect(controlOpposes('alice', 'core')).toBe(true);
    expect(controlOpposes('traders', 'alice')).toBe(true);
    expect(controlOpposes('alice', 'bob')).toBe(true);
    expect(controlOpposes('alice', 'alice')).toBe(false);
  });
});

describe('fillSectorPresence', () => {
  it('takes robots from the director count + nexus, never the room\'s robot ships, and recycles records', () => {
    const out = new Map<string, SidePresence>();
    const pool: SidePresence[] = [];
    fillSectorPresence(out, pool, sides({ alice: [2, 1], robots: [3, 0] }), 3, true);
    expect(Object.fromEntries(out)).toEqual({
      alice: { ships: 2, structures: 1, robots: 0, nexus: false },
      robots: { ships: 0, structures: 0, robots: 3, nexus: true },
    });
    fillSectorPresence(out, pool, sides({ robots: [3, 0] }), 0, false);
    expect(out.size).toBe(0);
    expect(pool.length).toBe(2);
  });
});

describe('RobotTerritory — the nexus locks a robot-held sector', () => {
  it('a big player fleet cannot flip a robot sector with a live nexus; it flips once the nexus dies', () => {
    const bus = new Bus();
    const fleet: FactionPresenceMap = new Map();
    const room = {
      eventBus: () => bus,
      playerCount: () => 0,
      hasFreeSlot: () => true,
      spawnLivingWorldBot: (o: { botId: string }) => o.botId === 'rbot-nexus', // no harvesters
      liveCounts: (): SectorLiveCounts => ({ players: 0, enemies: 0, neutrals: 0, structures: 0, byFaction: fleet }),
    } as unknown as LivingWorldRoom;
    const clock = { now: 0 };
    const t = new RobotTerritory(new Map([['orion-belt', room]]), () => new Map(), {
      nowMs: () => clock.now,
      nexusSector: 'orion-belt',
    });
    t.start();
    const run = (seconds: number): void => {
      for (let i = 0; i < seconds; i++) { clock.now += 1000; t.tick(clock.now); }
    };
    run(60); // the nexus alone claims its sector
    expect(t.sectorOwner('orion-belt')).toEqual({ factionId: 'robots', contested: false });

    fleet.set('alice', { ships: 30, structures: 10 });
    run(600);
    expect(t.sectorOwner('orion-belt')).toEqual({ factionId: 'robots', contested: true });
    expect(t.controlState('orion-belt')!.shares.get('alice')).toBe(100);

    bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'rbot-nexus' });
    run(1);
    expect(t.sectorOwner('orion-belt')).toEqual({ factionId: 'alice', contested: false });
    t.stop();
  });
});
