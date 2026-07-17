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
import { SectorPersistence, STRUCTURE_PERSIST_COALESCE_MS, type PersistableStructure } from './SectorPersistence.js';
import type {
  SectorSnapshotPayload,
  SectorSnapshotStructure,
  SectorSnapshotScrap,
  SectorSnapshotLingeringHull,
} from './SectorSnapshot.js';
import { CURRENT_SCHEMA_VERSION } from './SectorSnapshot.js';
import { STRUCTURE_KIND_CATALOGUE_VERSION } from '../../shared-types/structureKinds.js';

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

function makeDeps(
  structures: PersistableStructure[],
  restore: (rows: readonly SectorSnapshotStructure[]) => void,
  scrap: SectorSnapshotScrap[] = [],
  restoreScrap: (rows: readonly SectorSnapshotScrap[]) => void = () => undefined,
  lingeringHulls: SectorSnapshotLingeringHull[] = [],
  restoreLingeringHulls: (rows: readonly SectorSnapshotLingeringHull[]) => void = () => undefined,
) {
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
      scrapEntities: () => scrap,
      restoreScrap,
      lingeringHulls: () => lingeringHulls,
      restoreLingeringHulls,
      saveRow: (_key: string, payload: SectorSnapshotPayload) => {
        storedRow = { snapshot: JSON.stringify(payload), created_at: Date.now() };
      },
      loadRow: () => storedRow,
      logger: noopLogger,
    },
    readStored: () => storedRow,
  };
}

function makeLingeringHull(over: Partial<SectorSnapshotLingeringHull> = {}): SectorSnapshotLingeringHull {
  return {
    shipInstanceId: 'ship-abc',
    playerId: 'player-bob',
    kind: 'fighter',
    x: 111,
    y: 222,
    vx: 1,
    vy: 2,
    angle: 0.3,
    angvel: 0.01,
    health: 400,
    shieldDown: false,
    ...over,
  };
}

function makeScrap(over: Partial<SectorSnapshotScrap> = {}): SectorSnapshotScrap {
  return {
    entityId: 'scrap-3-0',
    parentShipKind: 'havok',
    componentIndex: 1,
    x: 700,
    y: -200,
    vx: 12,
    vy: -3,
    angle: 0.5,
    health: 18,
    ...over,
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

describe('SectorPersistence — scrap survives a server restart (v4)', () => {
  it('persist() writes scrap into the payload and hydrate() hands it to restoreScrap', () => {
    const scrap = makeScrap();
    const restoreScrap = vi.fn();
    const { deps, readStored } = makeDeps([], () => undefined, [scrap], restoreScrap);
    const persistence = new SectorPersistence(deps);
    persistence.persist();

    const payload = JSON.parse(readStored()!.snapshot) as SectorSnapshotPayload;
    expect(payload.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(payload.scrap).toHaveLength(1);
    expect(payload.scrap![0]).toMatchObject({
      entityId: 'scrap-3-0',
      parentShipKind: 'havok',
      componentIndex: 1,
      x: 700,
      y: -200,
      vx: 12,
      vy: -3,
      angle: 0.5,
      health: 18,
    });

    persistence.hydrate();
    expect(restoreScrap).toHaveBeenCalledTimes(1);
    const rows = restoreScrap.mock.calls[0]![0] as readonly SectorSnapshotScrap[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: 'scrap-3-0', parentShipKind: 'havok', health: 18 });
  });

  it('omits the scrap array entirely when there is none', () => {
    const { deps, readStored } = makeDeps([], () => undefined, []);
    new SectorPersistence(deps).persist();
    const payload = JSON.parse(readStored()!.snapshot) as SectorSnapshotPayload;
    expect(payload.scrap).toBeUndefined();
  });
});

describe('SectorPersistence — lingering hulls survive a server restart (v5)', () => {
  it('persist() writes lingering hulls and hydrate() hands them to the restore callback', () => {
    const hull = makeLingeringHull();
    const restoreHulls = vi.fn();
    const { deps, readStored } = makeDeps([], () => undefined, [], () => undefined, [hull], restoreHulls);
    const persistence = new SectorPersistence(deps);
    persistence.persist();

    const payload = JSON.parse(readStored()!.snapshot) as SectorSnapshotPayload;
    expect(payload.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(payload.lingeringHulls).toHaveLength(1);
    expect(payload.lingeringHulls![0]).toMatchObject({
      shipInstanceId: 'ship-abc',
      playerId: 'player-bob',
      kind: 'fighter',
      x: 111,
      y: 222,
      health: 400,
      shieldDown: false,
    });

    persistence.hydrate();
    expect(restoreHulls).toHaveBeenCalledTimes(1);
    const rows = restoreHulls.mock.calls[0]![0] as readonly SectorSnapshotLingeringHull[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shipInstanceId: 'ship-abc', playerId: 'player-bob', health: 400 });
  });

  it('omits the lingeringHulls array when there is none', () => {
    const { deps, readStored } = makeDeps([], () => undefined, [], () => undefined, []);
    new SectorPersistence(deps).persist();
    const payload = JSON.parse(readStored()!.snapshot) as SectorSnapshotPayload;
    expect(payload.lingeringHulls).toBeUndefined();
  });
});

describe('SectorPersistence — structure-catalogue version gate (campaign 6.2)', () => {
  // Anti-patterns review C-core 4 / Part D #19: STRUCTURE_KIND_CATALOGUE_VERSION
  // was write-only — nothing validated it at hydrate, unlike the roster's
  // SHIP_KIND_CATALOGUE_VERSION drift handling. A catalogue change between save
  // and restart could hydrate structure rows whose stats (health vs maxHealth,
  // constructionProgress vs constructionCost) were minted under a different
  // catalogue. The snapshot now stamps the version at persist; hydrate discards
  // ONLY the structures[] portion on mismatch (asteroid health / scrap /
  // lingering hulls are not structure-catalogue-coupled and still restore).

  it('persist stamps the LIVE structure catalogue version onto the payload', () => {
    const { deps, readStored } = makeDeps([makeStructure()], () => undefined);
    new SectorPersistence(deps).persist();
    const row = readStored();
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.snapshot) as SectorSnapshotPayload;
    expect(payload.structureCatalogueVersion).toBe(STRUCTURE_KIND_CATALOGUE_VERSION);
  });

  it('hydrate restores structures when the stamped version matches (round-trip)', () => {
    const restored: SectorSnapshotStructure[][] = [];
    const { deps } = makeDeps([makeStructure()], (rows) => restored.push([...rows]));
    const p = new SectorPersistence(deps);
    p.persist();
    p.hydrate();
    expect(restored).toHaveLength(1);
    expect(restored[0]![0]!.kind).toBe('capital');
  });

  it('hydrate DISCARDS structures on a mismatched catalogue version — but still restores lingering hulls', () => {
    const restoredStructures = vi.fn();
    const restoredHulls = vi.fn();
    const { deps } = makeDeps(
      [makeStructure()],
      restoredStructures,
      [],
      () => undefined,
      [makeLingeringHull()],
      restoredHulls,
    );
    const p = new SectorPersistence(deps);
    p.persist();
    // Simulate a catalogue bump between save and restart: rewrite the stored
    // row with a STALE stamped version (everything else untouched).
    const row = deps.loadRow('galaxy-sol')!;
    const payload = JSON.parse(row.snapshot) as SectorSnapshotPayload;
    payload.structureCatalogueVersion = STRUCTURE_KIND_CATALOGUE_VERSION - 1;
    deps.saveRow('galaxy-sol', payload);
    p.hydrate();
    expect(restoredStructures).not.toHaveBeenCalled();
    expect(restoredHulls).toHaveBeenCalledTimes(1);
  });
});

describe('SectorPersistence — event-driven throttled persist (campaign 6.3)', () => {
  // Part D #14: snapshots were written only by the 60 s cadence (+ onDispose),
  // so a structure placed then lost to a CRASH inside that window vanished.
  // `persistSoon()` closes it: schedule-once coalesce — the persist fires
  // STRUCTURE_PERSIST_COALESCE_MS after the FIRST event of a burst (later
  // events in the window ride the same write), bounding the crash window at
  // ~the coalesce window instead of 60 s.

  it('persistSoon coalesces a burst into ONE persist after the window', () => {
    vi.useFakeTimers();
    try {
      let saves = 0;
      const { deps } = makeDeps([makeStructure()], () => undefined);
      const origSave = deps.saveRow;
      deps.saveRow = (key, payload) => { saves += 1; origSave(key, payload); };
      const p = new SectorPersistence(deps);
      p.persistSoon();
      p.persistSoon();
      p.persistSoon();
      expect(saves).toBe(0);
      vi.advanceTimersByTime(STRUCTURE_PERSIST_COALESCE_MS + 10);
      expect(saves).toBe(1);
      // A later event schedules a fresh write.
      p.persistSoon();
      vi.advanceTimersByTime(STRUCTURE_PERSIST_COALESCE_MS + 10);
      expect(saves).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persistSoon is a no-op for engineering rooms (sectorKey null)', () => {
    vi.useFakeTimers();
    try {
      let saves = 0;
      const { deps } = makeDeps([makeStructure()], () => undefined);
      deps.sectorKey = () => null;
      deps.saveRow = () => { saves += 1; };
      new SectorPersistence(deps).persistSoon();
      vi.advanceTimersByTime(STRUCTURE_PERSIST_COALESCE_MS * 2);
      expect(saves).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose cancels a pending scheduled persist (room teardown owns the final write)', () => {
    vi.useFakeTimers();
    try {
      let saves = 0;
      const { deps } = makeDeps([makeStructure()], () => undefined);
      deps.saveRow = () => { saves += 1; };
      const p = new SectorPersistence(deps);
      p.persistSoon();
      p.dispose();
      vi.advanceTimersByTime(STRUCTURE_PERSIST_COALESCE_MS * 2);
      expect(saves).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
