import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from './structureMessages.js';
import { StructurePlacementSubsystem } from '../../structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../structures/StructureRegistry.js';
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
