/**
 * Plan wave 4 job 4H — per-kind wipe flag. A structure-catalogue bump used to
 * discard EVERY saved structure in every sector; now a bump that flags only the
 * kinds it changed wipes only those, and every other player building survives.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { SectorPersistence, type PersistableStructure } from './SectorPersistence.js';
import type { SectorSnapshotPayload, SectorSnapshotStructure } from './SectorSnapshot.js';
import { STRUCTURE_KIND_CATALOGUE_VERSION } from '../../shared-types/structureKinds.js';
import { migrateStructureRows } from './structureKindWipes.js';

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const LIVE = STRUCTURE_KIND_CATALOGUE_VERSION;

function s(id: string, kind: string): PersistableStructure {
  return {
    id, owner: 'player-alice', kind, x: 0, y: 0,
    isConstructed: true, constructionProgress: 100, minerals: 0, storedPower: 0,
  };
}

function harness(live: PersistableStructure[], wipes: Record<number, readonly string[]>) {
  let stored: { snapshot: string; created_at: number } | undefined;
  const restore = vi.fn<(rows: readonly SectorSnapshotStructure[]) => void>();
  const p = new SectorPersistence({
    sectorKey: () => 'galaxy-sol',
    sabF32: new Float32Array(64),
    swarmRegistry: { all: () => [], has: () => false },
    swarmHealth: new Map(),
    structures: () => live,
    restoreStructures: restore,
    scrapEntities: () => [],
    restoreScrap: () => undefined,
    lingeringHulls: () => [],
    restoreLingeringHulls: () => undefined,
    saveRow: (_k, payload) => { stored = { snapshot: JSON.stringify(payload), created_at: Date.now() }; },
    loadRow: () => stored,
    logger,
    structureKindWipes: wipes,
  });
  const restamp = (version: number) => {
    const payload = JSON.parse(stored!.snapshot) as SectorSnapshotPayload;
    payload.structureCatalogueVersion = version;
    stored = { snapshot: JSON.stringify(payload), created_at: Date.now() };
  };
  const kinds = (call: number) => restore.mock.calls[call]![0].map((r) => r.kind).sort();
  return { p, restore, restamp, kinds };
}

describe('structure-kind wipe flag (job 4H)', () => {
  it('a bump that flags kind B wipes only B; kind A survives, and the new version is recorded so it does not wipe again', () => {
    const live = [s('a1', 'capital'), s('b1', 'solar'), s('a2', 'capital')];
    const { p, restore, restamp, kinds } = harness(live, { [LIVE]: ['solar'] });
    p.persist();
    restamp(LIVE - 1); // saved under the previous catalogue
    p.hydrate();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(kinds(0)).toEqual(['capital', 'capital']);

    // After the wipe the next save stamps the live version: a Solar built
    // since then survives the next restart.
    live.splice(0, live.length, s('a1', 'capital'), s('b2', 'solar'));
    p.persist();
    p.hydrate();
    expect(kinds(1)).toEqual(['capital', 'solar']);
  });

  it('a bump with NO wipe entry still discards every structure (legacy behaviour)', () => {
    const { p, restore, restamp } = harness([s('a1', 'capital'), s('b1', 'solar')], {});
    p.persist();
    restamp(LIVE - 1);
    p.hydrate();
    expect(restore).not.toHaveBeenCalled();
  });

  it('skipping several flagged bumps wipes the union of their kinds', () => {
    const rows = [{ kind: 'capital' }, { kind: 'solar' }, { kind: 'reactor' }, { kind: 'miner' }];
    const r = migrateStructureRows(rows, 4, 6, { 5: ['solar'], 6: ['reactor'] });
    expect(r.kept.map((x) => x.kind)).toEqual(['capital', 'miner']);
    expect(r.wiped).toBe(2);
  });

  it('one unflagged bump in the gap wipes everything', () => {
    const r = migrateStructureRows([{ kind: 'capital' }], 4, 6, { 6: ['solar'] });
    expect(r.kept).toEqual([]);
  });

  it('a missing or future stamp wipes everything; the same version keeps everything', () => {
    const rows = [{ kind: 'capital' }];
    expect(migrateStructureRows(rows, undefined, 6, { 6: [] }).kept).toEqual([]);
    expect(migrateStructureRows(rows, 7, 6, {}).kept).toEqual([]);
    expect(migrateStructureRows(rows, 6, 6, {}).kept).toEqual(rows);
  });
});
