/**
 * Capture plan 4E (S5) — an NPC base whose Capital dies goes the same way as a
 * player's (the one flip in `StructureRegistry.remove`): ownerless
 * (`none:<lostCapitalId>`), still powered. Then the AI side lets go of it: it
 * is no NPC trade anchor, no garrison patrols it, it no longer counts for its
 * old faction, and nobody's standing moves (finders keepers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from '../structures/StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { unownedOwner } from '../../shared-types/relations.js';
import { npcBaseTrade } from '../economy/npcBaseTrade.js';
import { FactionLedger } from '../faction/FactionLedger.js';
import { sectorLiveCounts } from '../rooms/sectorLiveCounts.js';
import { RoomHitStanding } from '../rooms/features/hitStanding.js';
import { setTradeSink, type TradeSink } from '../economy/tradeSink.js';
import { PatrolSubsystem } from './PatrolSubsystem.js';

const NPC = 'npc:core:mil';

/** A built, powered NPC base: Capital → relay → Solar + Turret + Cargo Bay. */
function npcBase() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let counter = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    structureUid: (_o, kind, x, y) => `uid-${kind}-${x}-${y}`,
    registry,
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    findNearestAsteroid: () => null,
    applyDamage: () => {},
    broadcastBeam: () => {},
  });
  const capital = placement.place(NPC, 'capital', 0, 0, { rot: 180 })!;
  const relay = placement.place(NPC, 'connector', 0, 380)!;
  const solar = placement.place(NPC, 'solar', 450, 500)!;
  const turret = placement.place(NPC, 'turret', -170, 420)!;
  const bay = placement.place(NPC, 'cargo_bay', 0, 900)!;
  for (const id of [relay, solar, turret, bay]) {
    const r = registry.get(id)!;
    r.isConstructed = true;
    r.constructionProgress = r.constructionCost;
    health.set(id, getStructureKind(r.kind).maxHealth);
  }
  registry.topologyDirty = true;
  let now = 0;
  for (let i = 0; i < 5; i++) grid.pulse(now += 1000);
  expect(grid.componentMembersOf(relay)).toEqual(expect.arrayContaining([capital, solar, turret, bay]));
  expect(grid.powerSummaryFor(turret).powered).toBe(true);
  return { registry, grid, capital, relay, solar, turret, bay, pulse: () => grid.pulse(now += 1000) };
}

/** Kill the base's Capital (every removal path ends in `registry.remove`). */
function fallen() {
  const b = npcBase();
  b.registry.remove(b.capital);
  b.pulse();
  return { ...b, none: unownedOwner(b.capital) };
}

const STORAGE = { tradeSnapshot: () => ({ goods: {}, freeCapacity: 100 }) };

afterEach(() => setTradeSink(null));

describe('an NPC base whose Capital dies (capture plan 4E S5)', () => {
  it('turns ownerless and stays powered, like a player base', () => {
    const b = fallen();
    for (const id of [b.relay, b.solar, b.turret, b.bay]) expect(b.registry.get(id)!.owner).toBe(b.none);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
  });

  it('no longer counts for its old faction (structures on the control meter, faction lookups)', () => {
    const before = npcBase();
    const host = (r: StructureRegistry) => ({
      playerToSlot: () => new Map<string, number>(),
      getActiveShip: () => undefined,
      swarmRegistry: { all: () => [][Symbol.iterator]() },
      structureRegistry: r,
      patrols: { count: 0, factionOf: () => undefined },
      npcHostileTo: () => false,
    });
    expect(sectorLiveCounts(host(before.registry)).byFaction!.get('core')?.structures).toBe(5);
    const b = fallen();
    expect(sectorLiveCounts(host(b.registry)).byFaction!.get('core')).toBeUndefined();
    const ledger = new FactionLedger({ structures: () => b.registry.all() });
    expect(ledger.factionOf(b.turret)).toBeNull();
    expect(ledger.baseReadiness({
      sectorKey: () => 's', serverTick: () => 0, waveNeedsOwner: () => false,
      ownerPresent: () => false, broadcastBaseReady: () => {},
    })).toEqual([]);
  });

  it('is no NPC trade anchor', () => {
    expect(npcBaseTrade(npcBase().registry, STORAGE).map((t) => t.owner)).toEqual([NPC]);
    expect(npcBaseTrade(fallen().registry, STORAGE)).toEqual([]);
  });

  it('its garrison stops patrolling: no respawn, no roaming round it', () => {
    const b = npcBase();
    const poses = new Map<string, { x: number; y: number }>();
    const moves: string[] = [];
    const patrols = new PatrolSubsystem({
      spawn: (id, x, y) => { poses.set(id, { x, y }); return true; },
      poseOf: (id, out) => { const p = poses.get(id); if (!p) return false; out.x = p.x; out.y = p.y; return true; },
      moveTo: (id) => moves.push(id),
      markHostile: () => {},
      forEachPilot: () => {},
      isHostileToOwner: () => false,
    });
    patrols.watchBaseFalls(b.registry);
    patrols.addBase('s-mil', NPC, 'core', { x0: -600, x1: 600, y0: -300, y1: 700 }, 0, 0, 3);
    patrols.tick(0);
    const ids = [...poses.keys()];
    expect(ids).toHaveLength(3);
    poses.delete(ids[0]!); // one patrol ship was shot down earlier
    b.registry.remove(b.capital);
    moves.length = 0;
    patrols.tick(1_000_000);
    expect(poses.has(ids[0]!)).toBe(false); // never comes back
    expect(moves).toEqual([]); // the survivors no longer fly its corners
    // The survivors still fly for their faction until they are gone.
    expect(patrols.factionOf(ids[1]!)).toBe('core');
    poses.delete(ids[1]!);
    poses.delete(ids[2]!);
    patrols.tick(1_001_000);
    expect(patrols.count).toBe(0);
  });

  it('a garrison keeps patrolling while another built Capital still holds the base', () => {
    const b = npcBase();
    const spare = b.registry.get(b.capital)!;
    b.registry.add({ ...spare, id: 'cap-2', x: 5000, y: 5000 });
    const patrols = new PatrolSubsystem({
      spawn: () => true, poseOf: () => true, moveTo: () => {}, markHostile: () => {},
      forEachPilot: () => {}, isHostileToOwner: () => false,
    });
    patrols.watchBaseFalls(b.registry);
    patrols.addBase('s-mil', NPC, 'core', { x0: -600, x1: 600, y0: -300, y1: 700 }, 0, 0, 3);
    b.registry.remove(b.capital);
    expect(patrols.count).toBe(1);
  });

  it('moves no standing: hitting the fallen pieces touches nobody', () => {
    const calls: Array<[string, string, number]> = [];
    setTradeSink({ adjustStanding: (f: string, t: string, d: number) => { calls.push([f, t, d]); } } as unknown as TradeSink);
    const b = fallen();
    const standing = new RoomHitStanding({
      swarmRegistry: { get: () => undefined },
      gameClock: { now: () => 0 },
      playerToSlot: () => new Map([['alice', 0]]),
      structureRegistry: () => b.registry,
    });
    expect(calls).toEqual([]); // the fall itself moved nothing
    standing.noteStandingHit(b.turret, 'alice');
    expect(calls).toEqual([]);
  });
});
