import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from './structureMessages.js';
import { StructurePlacementSubsystem } from '../../structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../structures/StructureRegistry.js';
import { StructureGridSubsystem } from '../../structures/StructureGridSubsystem.js';
import type { GridObstacle } from '../../../core/structures/Grid.js';
import { territoryLockRefusal } from '../../structures/territoryLockRules.js';
import { parseOwner } from '../../../shared-types/relations.js';

/** A host over a REAL placement subsystem; records the notices sent and
 *  the replies. `crates`: the owner holds that many packed crates of each
 *  kind (a sector room, so the Capital needs one); absent = no crate rule.
 *  `slots`: free spawn slots (absent = endless); `locks`: the Territory
 *  Lock rule, with the owner's side holding the sector. */
function rig(obstacles: GridObstacle[] = [], crates?: number, opts: { slots?: number; locks?: boolean } = {}) {
  let slots = opts.slots ?? Infinity;
  const registry = new StructureRegistry();
  let n = 0;
  let held = crates ?? 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => { if (slots <= 0) return false; slots--; return true; },
    seedHealth: () => {}, despawn: () => {}, clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`, registry, getObstacles: () => obstacles,
    ...(opts.slots === undefined ? {} : { freeSpawnSlots: () => slots }),
    ...(opts.locks !== true ? {} : {
      placementRefusal: (owner: string, kind: string, earlier?: Iterable<{ kind: string; owner: string }>) =>
        territoryLockRefusal(owner, kind, 'A1', parseOwner(owner).faction, registry.all(), earlier),
    }),
    ...(crates === undefined ? {} : {
      sectorKey: () => 'A1',
      packedGateForBuild: (_o: string, kind: string) => ({
        ok: held > 0, available: held,
        commit: () => { held--; return { product: `structure:${kind}`, quality: 42 }; },
      }),
    }),
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
  const sent: Array<{ type: string; msg: unknown }> = [];
  const client = { sessionId: 's1', send: (type: string, msg: unknown) => { sent.push({ type, msg: structuredClone(msg) }); } } as unknown as Client;
  const place = (kind: string, x: number, y: number) =>
    handlers.get('place_structure')!(client, { type: 'place_structure', kind, x, y });
  const placeAll = (items: Array<{ kind: string; x: number; y: number }>) =>
    handlers.get('place_structures')!(client, { type: 'place_structures', batchId: 7, items });
  const placeRaw = (m: unknown) => handlers.get('place_structures')!(client, m);
  return { place, placeAll, placeRaw, notices, registry, sent, crates: () => held };
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

describe('place_structures — plan then Build, all or nothing', () => {
  it('an all-valid batch places every item and sends ONE placed reply echoing the batchId', () => {
    const r = rig();
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'solar', x: 3000, y: 0 }, { kind: 'reactor', x: 0, y: 3000 }]);
    expect(r.registry.size).toBe(3);
    expect(r.sent).toEqual([{ type: 'place_structures_placed', msg: { type: 'place_structures_placed', batchId: 7 } }]);
    expect(r.notices).toEqual([]);
  });

  it('one item on an asteroid: nothing placed, its index refused', () => {
    const r = rig([{ x: 3000, y: 0, radius: 120 }]);
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'solar', x: 3000, y: 0 }, { kind: 'reactor', x: 0, y: 3000 }]);
    expect(r.registry.size).toBe(0);
    expect(r.sent).toEqual([{ type: 'place_structures_refused', msg: { type: 'place_structures_refused', batchId: 7, refused: [{ index: 1, code: 'overlap-obstacle' }] } }]);
    expect(r.sent.some((m) => m.type === 'place_structures_placed')).toBe(false);
    expect(r.notices).toEqual(["Can't build here: blocked by an asteroid or wreck"]);
  });

  it('one item overlapping a placed structure: nothing placed, its index refused', () => {
    const r = rig();
    r.place('capital', 0, 0);
    r.placeAll([{ kind: 'solar', x: 5000, y: 0 }, { kind: 'connector', x: 10, y: 10 }]);
    expect(r.registry.size).toBe(1);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 1, code: 'overlap-structure' }] });
  });

  it('two items overlapping each other: the later is refused, none placed', () => {
    const r = rig();
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'solar', x: 100, y: 0 }]);
    expect(r.registry.size).toBe(0);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 1, code: 'overlap-structure' }] });
  });

  it('crates for 2 but a batch of 3 Capitals: the third is refused no-crate, none placed', () => {
    const r = rig([], 2);
    r.placeAll([{ kind: 'capital', x: 0, y: 0 }, { kind: 'capital', x: 5000, y: 0 }, { kind: 'capital', x: 10000, y: 0 }]);
    expect(r.registry.size).toBe(0);
    expect(r.crates()).toBe(2);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 2, code: 'no-crate' }] });
  });

  it('crates for 2 and a batch of 2 Capitals: both placed, both crates spent', () => {
    const r = rig([], 2);
    r.placeAll([{ kind: 'capital', x: 0, y: 0 }, { kind: 'capital', x: 5000, y: 0 }]);
    expect(r.registry.size).toBe(2);
    expect(r.crates()).toBe(0);
    expect(r.sent).toEqual([{ type: 'place_structures_placed', msg: { type: 'place_structures_placed', batchId: 7 } }]);
  });

  it('a kind no player may build is refused not-buildable', () => {
    const r = rig();
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'alien_gate', x: 9000, y: 0 }]);
    expect(r.registry.size).toBe(0);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 1, code: 'not-buildable' }] });
  });

  it('two Territory Locks in one batch: the second breaks the one-per-sector rule, none placed', () => {
    const r = rig([], undefined, { locks: true });
    r.placeAll([{ kind: 'territory_lock', x: 0, y: 0 }, { kind: 'territory_lock', x: 5000, y: 0 }]);
    expect(r.registry.size).toBe(0);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 1, code: 'kind-rule' }] });
    expect(r.notices).toEqual(['This sector already has a Territory Lock.']);
  });

  it('one Territory Lock in a batch is fine', () => {
    const r = rig([], undefined, { locks: true });
    r.placeAll([{ kind: 'territory_lock', x: 0, y: 0 }, { kind: 'solar', x: 5000, y: 0 }]);
    expect(r.registry.size).toBe(2);
    expect(r.sent).toEqual([{ type: 'place_structures_placed', msg: { type: 'place_structures_placed', batchId: 7 } }]);
  });

  it('free spawn slots for 2 but a batch of 3: the batch is refused no-room, none placed', () => {
    const r = rig([], undefined, { slots: 2 });
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'solar', x: 3000, y: 0 }, { kind: 'solar', x: 6000, y: 0 }]);
    expect(r.registry.size).toBe(0);
    expect(r.sent[0]!.msg).toEqual({ type: 'place_structures_refused', batchId: 7, refused: [{ index: 2, code: 'no-room' }] });
  });

  it('free spawn slots for exactly the batch: all placed', () => {
    const r = rig([], undefined, { slots: 2 });
    r.placeAll([{ kind: 'solar', x: 0, y: 0 }, { kind: 'solar', x: 3000, y: 0 }]);
    expect(r.registry.size).toBe(2);
    expect(r.sent).toEqual([{ type: 'place_structures_placed', msg: { type: 'place_structures_placed', batchId: 7 } }]);
  });

  it('a malformed or oversized batch is dropped', () => {
    const r = rig();
    r.placeAll([]);
    r.placeAll(Array.from({ length: 33 }, (_, i) => ({ kind: 'solar', x: i * 3000, y: 0 })));
    // No batchId (or a bad one): the client could not match a reply, so it is dropped too.
    r.placeRaw({ type: 'place_structures', items: [{ kind: 'solar', x: 0, y: 0 }] });
    r.placeRaw({ type: 'place_structures', batchId: -1, items: [{ kind: 'solar', x: 0, y: 0 }] });
    expect(r.registry.size).toBe(0);
    expect(r.sent).toEqual([]);
  });
});
