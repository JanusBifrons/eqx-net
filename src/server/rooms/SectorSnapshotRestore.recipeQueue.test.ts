/**
 * Building panels B4 — `restoreStructures` brings a processor's recipe queue
 * back: known ids this kind can run, capped at MAX_RECIPE_QUEUE - 1 after the
 * head; an old save with no queue restores exactly as before (no queue, no
 * repeat), and a non-processor never gets one.
 */
import { describe, it, expect, vi } from 'vitest';

// The unit config has no decorator transform: a plain stand-in for the schema class.
vi.mock('./schema/SectorState.js', () => ({ ShipState: class {} }));
vi.mock('../db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => ({ get: () => null }) }));
vi.mock('../auth/AuthService.js', () => ({ getUser: () => null }));

import { SectorSnapshotRestore, type SectorSnapshotRestoreHost } from './SectorSnapshotRestore.js';
import type { SectorSnapshotStructure } from './SectorSnapshot.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import { MAX_RECIPE_QUEUE } from '../../shared-types/production.js';

function restoreRows(rows: SectorSnapshotStructure[]): StructureRecord[] {
  const recs = new Map<string, StructureRecord>();
  let n = 0;
  const host = {
    structurePlacement: () => ({
      place: (owner: string, kind: StructureRecord['kind']) => {
        const id = `s${n++}`;
        recs.set(id, { id, owner, kind } as StructureRecord);
        return id;
      },
    }),
    structureRegistry: { get: (id: string) => recs.get(id), topologyDirty: false },
    storage: () => ({ restore: () => undefined, restoreSlot: () => undefined, restorePad: () => undefined }),
    swarmHealth: () => new Map(),
    structureGridTick: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  } as unknown as SectorSnapshotRestoreHost;
  new SectorSnapshotRestore(host).restoreStructures(rows);
  return [...recs.values()];
}

function row(over: Partial<SectorSnapshotStructure>): SectorSnapshotStructure {
  return {
    entityId: 'e', owner: 'alice', kind: 'shipyard', x: 0, y: 0, health: 100,
    isConstructed: true, constructionProgress: 100, minerals: 0, storedPower: 0, ...over,
  } as SectorSnapshotStructure;
}

describe('restoreStructures: recipe queue (B4)', () => {
  it('an old save without a queue restores as before: head only, no queue, no repeat', () => {
    const [yard] = restoreRows([row({ recipe: 'build_gunship', prodCount: 3 })]);
    expect(yard!.recipe).toBe('build_gunship');
    expect(yard!.prodCount).toBe(3);
    expect(yard!.prodQueue).toBeUndefined();
    expect(yard!.prodQueueRepeat).toBeUndefined();
  });

  it('restores the queue and repeat; drops unknown ids and recipes the kind cannot run; caps the length', () => {
    const [yard, bare] = restoreRows([
      row({
        recipe: 'build_interceptor', prodCount: 1, prodQueueRepeat: true,
        prodQueue: ['build_gunship', 'nope', 'smelt_alloy', 7, ...Array.from({ length: 10 }, () => 'build_heavy')],
      }),
      row({ recipe: 'build_interceptor', prodCount: 1, prodQueue: [] }),
    ]);
    expect(yard!.recipe).toBe('build_interceptor');
    expect(yard!.prodQueue).toHaveLength(MAX_RECIPE_QUEUE - 1);
    expect(yard!.prodQueue![0]).toBe('build_gunship');
    expect(yard!.prodQueue!.slice(1).every((r) => r === 'build_heavy')).toBe(true);
    expect(yard!.prodQueueRepeat).toBe(true);
    expect(bare!.prodQueue, 'an empty saved queue still means queue mode').toEqual([]);
  });

  it('a non-processor never gets a queue', () => {
    const [bay] = restoreRows([row({ kind: 'cargo_bay', prodQueue: ['build_gunship'], prodQueueRepeat: true })]);
    expect(bay!.prodQueue).toBeUndefined();
    expect(bay!.prodQueueRepeat).toBeUndefined();
  });
});
