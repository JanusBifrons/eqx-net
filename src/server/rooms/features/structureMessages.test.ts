import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from './structureMessages.js';
import { StructurePlacementSubsystem } from '../../structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../structures/StructureRegistry.js';
import { StructureGridSubsystem } from '../../structures/StructureGridSubsystem.js';
import type { GridObstacle } from '../../../core/structures/Grid.js';

/** A host over a REAL placement subsystem; records the notices sent. */
function rig(obstacles: GridObstacle[] = []) {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true, seedHealth: () => {}, despawn: () => {}, clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`, registry, getObstacles: () => obstacles,
  });
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const notices: string[] = [];
  const host = {
    onMessage: (type: string, h: (client: Client, raw: unknown) => void) => { handlers.set(type, h); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'player-1']]),
    structureRegistry: registry,
    structurePlacement: () => placement,
    testSeedStorageHold: () => null,
    deck: () => false,
    rebuildStructuresSlice: () => {},
    sectorPersistence: () => ({ persistSoon: () => {} }),
    sectorKey: () => null,
    findPacked: () => null,
    sendNotice: (_c: Client, text: string) => { notices.push(text); },
    logger: { warn: () => {} },
  } as unknown as StructureMessageHost;
  registerStructureMessages(host);
  const client = { sessionId: 's1' } as Client;
  const place = (kind: string, x: number, y: number) =>
    handlers.get('place_structure')!(client, { type: 'place_structure', kind, x, y });
  return { place, notices, registry };
}

describe('place_structure refusal notice', () => {
  it('a refused placement sends a notice', () => {
    const r = rig([{ x: 0, y: 0, radius: 120 }]);
    r.place('capital', 0, 0);
    expect(r.registry.size).toBe(0);
    expect(r.notices).toEqual(["Can't build here: blocked by an asteroid or wreck"]);
  });

  it('an overlap with a structure says so; an accepted placement sends nothing', () => {
    const r = rig();
    r.place('capital', 0, 0);
    expect(r.notices).toEqual([]);
    r.place('connector', 10, 10);
    expect(r.notices).toEqual(["Can't build here: too close to another structure"]);
  });
});

/** A host over REAL placement + grid subsystems sharing one obstacle list;
 *  `structure_action` resolves entityId n to `pstruct-n`. */
function gridRig(obstacles: GridObstacle[]) {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true, seedHealth: () => {}, despawn: () => {}, clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`, registry, getObstacles: () => obstacles,
  });
  const grid = new StructureGridSubsystem({
    registry, getHealth: () => 100, setHealth: () => {}, despawn: () => {},
    findNearestAsteroid: () => null, getObstacles: () => obstacles,
  });
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const notices: string[] = [];
  const host = {
    onMessage: (type: string, h: (client: Client, raw: unknown) => void) => { handlers.set(type, h); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'player-1']]),
    swarmRegistry: { getByEntityId: (e: number) => (registry.get(`pstruct-${e}`) ? { id: `pstruct-${e}` } : undefined) },
    structureRegistry: registry,
    structurePlacement: () => placement,
    structureGrid: () => grid,
    testSeedStorageHold: () => null,
    deck: () => false,
    rebuildStructuresSlice: () => {},
    sectorPersistence: () => ({ persistSoon: () => {} }),
    sectorKey: () => null,
    findPacked: () => null,
    sendNotice: (_c: Client, text: string) => { notices.push(text); },
    logger: { warn: () => {} },
  } as unknown as StructureMessageHost;
  registerStructureMessages(host);
  const client = { sessionId: 's1' } as Client;
  const place = (kind: string, x: number, y: number) =>
    placement.place('player-1', kind as never, x, y, kind === 'capital' ? { rot: 180 } : undefined)!;
  const reconnect = (id: string) =>
    handlers.get('structure_action')!(client, { type: 'structure_action', id: Number(id.slice('pstruct-'.length)), action: 'reconnect' });
  return { place, reconnect, notices, registry };
}

describe('structure_action reconnect notice', () => {
  it('reconnect that cannot link because a rock blocks the line says so', () => {
    const rock: GridObstacle[] = [];
    const r = gridRig(rock);
    r.place('connector', 0, 0);
    const pylon = r.place('shield_pylon', 450, 0);
    r.registry.disconnect(pylon); // stranded, as if the rock was there at placement
    rock.push({ x: 225, y: 0, radius: 100 });
    r.reconnect(pylon);
    expect(r.registry.connectionCount(pylon)).toBe(0);
    expect(r.notices).toEqual(["Can't link: the way is blocked by an asteroid or structure"]);
  });

  it('reconnect with no building in range says so', () => {
    const r = gridRig([]);
    r.place('connector', 0, 0);
    const pylon = r.place('shield_pylon', 5000, 0);
    r.reconnect(pylon);
    expect(r.notices).toEqual(["Can't link: no building in reach to link to"]);
  });

  it('a pylon with only a non-Connector building in reach names the pylon rule', () => {
    const r = gridRig([]);
    r.place('solar', 0, 0);
    const pylon = r.place('shield_pylon', 0, 450);
    r.reconnect(pylon);
    expect(r.notices).toEqual(["Can't link: shield posts link only to a Connector or another shield post"]);
  });

  it('a successful reconnect sends nothing', () => {
    const r = gridRig([]);
    r.place('connector', 0, 0);
    const pylon = r.place('shield_pylon', 450, 0);
    r.registry.disconnect(pylon);
    r.reconnect(pylon);
    expect(r.registry.connectionCount(pylon)).toBe(1);
    expect(r.notices).toEqual([]);
  });
});
