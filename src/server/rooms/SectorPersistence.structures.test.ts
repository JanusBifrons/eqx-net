/**
 * Phase-5 regression lock (Equinox Bugs doc, 2026-06-14):
 *
 *   "Structures are lost after server reset… wtf is this? It should save a
 *    snapshot, surely?!"
 *
 * Before this, `SectorPersistence` only persisted swarm HEALTH and the hydrate
 * side filtered `kind !== 1`, so placed structures (their owner / subtype /
 * construction / minerals / power, all in the server `StructureRegistry`) were
 * never written NOR restored. This test drives the persist→hydrate round-trip
 * with injected fakes and asserts a placed structure survives: it is written
 * into the snapshot payload and handed back to the restore callback intact.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { SectorPersistence, type PersistableStructure } from './SectorPersistence.js';
import type { SectorSnapshotPayload, SectorSnapshotStructure } from './SectorSnapshot.js';
import { CURRENT_SCHEMA_VERSION } from './SectorSnapshot.js';

const noopLogger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function makeStructure(over: Partial<PersistableStructure> = {}): PersistableStructure {
  return {
    id: 'pstruct-7',
    owner: 'player-alice',
    kind: 'capital',
    x: 1234,
    y: -567,
    isConstructed: true,
    constructionProgress: 100,
    minerals: 42,
    storedPower: 0,
    ...over,
  };
}

function makeDeps(structures: PersistableStructure[], restore: (rows: readonly SectorSnapshotStructure[]) => void) {
  let storedRow: { snapshot: string; created_at: number } | undefined;
  const swarmHealth = new Map<string, number>();
  for (const s of structures) swarmHealth.set(s.id, 333);
  return {
    deps: {
      sectorKey: () => 'galaxy-sol',
      sabF32: new Float32Array(64),
      swarmRegistry: { all: () => [], has: () => false },
      swarmHealth,
      structures: () => structures,
      restoreStructures: restore,
      saveRow: (_key: string, payload: SectorSnapshotPayload) => {
        storedRow = { snapshot: JSON.stringify(payload), created_at: Date.now() };
      },
      loadRow: () => storedRow,
      logger: noopLogger,
    },
    readStored: () => storedRow,
  };
}

describe('SectorPersistence — structures survive a server restart', () => {
  it('persist() writes the full structure state into the snapshot payload', () => {
    const struct = makeStructure();
    const { deps, readStored } = makeDeps([struct], () => undefined);
    new SectorPersistence(deps).persist();

    const payload = JSON.parse(readStored()!.snapshot) as SectorSnapshotPayload;
    expect(payload.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(payload.structures).toHaveLength(1);
    expect(payload.structures![0]).toMatchObject({
      entityId: 'pstruct-7',
      owner: 'player-alice',
      kind: 'capital',
      x: 1234,
      y: -567,
      health: 333,
      isConstructed: true,
      constructionProgress: 100,
      minerals: 42,
      storedPower: 0,
    });
  });

  it('hydrate() hands the persisted structures back to the restore callback', () => {
    const struct = makeStructure({ id: 'pstruct-9', kind: 'solar', minerals: 5 });
    const restore = vi.fn();
    const { deps } = makeDeps([struct], restore);
    const persistence = new SectorPersistence(deps);
    persistence.persist(); // writes the row
    persistence.hydrate(); // reads it back

    expect(restore).toHaveBeenCalledTimes(1);
    const rows = restore.mock.calls[0]![0] as readonly SectorSnapshotStructure[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: 'pstruct-9', kind: 'solar', minerals: 5, health: 333 });
  });

  it('hydrate() does not call restore when there are no structures', () => {
    const restore = vi.fn();
    const { deps } = makeDeps([], restore);
    const persistence = new SectorPersistence(deps);
    persistence.persist();
    persistence.hydrate();
    expect(restore).not.toHaveBeenCalled();
  });
});
