/**
 * Capture plan 4E (S6) — owner rule: "A fallen NPC base never regrows, even
 * after a restart, until captured" (and once captured the site is taken, so
 * it still never regrows).
 *
 * Drives the real seams end to end: `seedGalaxyBase` grows the sector's bases,
 * the base's Capital dies (`StructureRegistry.remove` → `none:` pieces),
 * `SectorPersistence.persist` saves the sector, a FRESH registry restores it
 * (`SectorSnapshotRestore.restoreStructures`) and `seedGalaxyBase` runs again
 * as on boot. Each structure the seeder places carries its `originBase` (the
 * NPC owner it was grown under); the saved pieces keep it, so the seeder skips
 * that base. An old save (no `originBase`) loads and regrows as before.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import { galaxyBasePlan } from '../../core/bases/galaxyBases.js';
import { isNpcOwner } from '../../shared-types/relations.js';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { SectorPersistence } from '../rooms/SectorPersistence.js';
import { SectorSnapshotRestore, type SectorSnapshotRestoreHost } from '../rooms/SectorSnapshotRestore.js';
import type { SectorSnapshotPayload, SectorSnapshotStructure } from '../rooms/SectorSnapshot.js';
import { seedGalaxyBase, type NpcBaseSeedHost } from './NpcBaseSubsystem.js';

// The restore module reaches the roster and accounts (node:sqlite) and the ship
// schema (decorators) for hulls; structures touch none of them.
vi.mock('../db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => ({ get: () => null }) }));
vi.mock('../auth/AuthService.js', () => ({ getUser: () => null }));
vi.mock('../rooms/schema/SectorState.js', () => ({ ShipState: class {} }));

const SECTOR = GALAXY_SECTORS.find((s) => galaxyBasePlan(s.key).length >= 2)?.key
  ?? GALAXY_SECTORS.find((s) => galaxyBasePlan(s.key).length >= 1)!.key;

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** One "room": a registry, the real placement seam and the seeder's host. */
function room() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    structureUid: (_o, kind, x, y) => `uid-${kind}-${x}-${y}`,
    registry,
  });
  const host: NpcBaseSeedHost = {
    structureRegistry: registry,
    swarmRegistry: { all: () => [] },
    lingeringPoseCache: new Map(),
    patrols: { addBase: () => undefined, watchBaseFalls: () => undefined },
    obstacles: { rocks: () => [] },
    logger: quiet,
    sabF32: () => new Float32Array(0),
    structurePlacement: () => placement,
    swarmHealth: () => health,
    sectorKey: () => SECTOR,
    evictSwarmEntity: () => undefined,
    structureGridTick: () => undefined,
  };
  const restore = new SectorSnapshotRestore({
    structurePlacement: () => placement,
    storage: () => ({ restore: () => undefined, restorePad: () => undefined, restoreSlot: () => undefined }),
    swarmHealth: () => health,
    structureRegistry: registry,
    logger: quiet,
    structureGridTick: () => undefined,
  } as unknown as SectorSnapshotRestoreHost);
  return { registry, health, host, restore };
}

/** Save `r`'s sector, then restore it into a fresh room (the server restart). */
function restart(r: ReturnType<typeof room>, edit?: (rows: SectorSnapshotStructure[]) => void) {
  let saved: SectorSnapshotPayload | undefined;
  new SectorPersistence({
    sectorKey: () => SECTOR,
    sabF32: new Float32Array(0),
    swarmRegistry: { all: () => [], has: () => false },
    swarmHealth: r.health,
    structures: () => r.registry.all(),
    restoreStructures: () => undefined,
    scrapEntities: () => [],
    restoreScrap: () => undefined,
    lingeringHulls: () => [],
    restoreLingeringHulls: () => undefined,
    saveRow: (_k, p) => { saved = JSON.parse(JSON.stringify(p)) as SectorSnapshotPayload; },
    loadRow: () => undefined,
    logger: quiet,
  }).persist();
  const rows = saved!.structures ?? [];
  edit?.(rows);
  const next = room();
  next.restore.restoreStructures(rows);
  return { next, rows };
}

const npcOwners = (reg: StructureRegistry): Set<string> => {
  const s = new Set<string>();
  for (const r of reg.all()) if (isNpcOwner(r.owner)) s.add(r.owner);
  return s;
};

/** Seed the sector, kill base 0's Capital; returns the fallen base's owner. */
function fallenSector() {
  const r = room();
  seedGalaxyBase(r.host, SECTOR);
  const before = npcOwners(r.registry);
  const capital = [...r.registry.all()].find((s) => s.kind === 'capital' && isNpcOwner(s.owner))!;
  const fallenOwner = capital.owner;
  r.registry.remove(capital.id);
  expect(npcOwners(r.registry).has(fallenOwner), 'the base fell').toBe(false);
  return { r, before, fallenOwner };
}

describe('a fallen NPC base never regrows (capture plan 4E S6)', () => {
  it('seeded structures carry their base of origin', () => {
    const r = room();
    seedGalaxyBase(r.host, SECTOR);
    const recs = [...r.registry.all()].filter((s) => isNpcOwner(s.owner));
    expect(recs.length).toBeGreaterThan(0);
    for (const s of recs) expect(s.originBase).toBe(s.owner);
  });

  it('after a restart, the faction does not grow the fallen base again; its other bases do', () => {
    const { r, before, fallenOwner } = fallenSector();
    const { next, rows } = restart(r);
    expect(rows.length, 'the ownerless pieces are saved').toBeGreaterThan(0);
    expect(rows.every((row) => row.originBase === fallenOwner)).toBe(true);
    seedGalaxyBase(next.host, SECTOR);
    const after = npcOwners(next.registry);
    expect(after.has(fallenOwner)).toBe(false);
    for (const o of before) if (o !== fallenOwner) expect(after.has(o), `${o} still grows`).toBe(true);
  });

  it('a captured base (pieces now a player\'s) does not regrow after a restart either', () => {
    const { r, fallenOwner } = fallenSector();
    for (const s of r.registry.all()) if (!isNpcOwner(s.owner)) s.owner = 'player-finder';
    const { next } = restart(r);
    expect([...next.registry.all()].some((s) => s.owner === 'player-finder' && s.originBase === fallenOwner)).toBe(true);
    seedGalaxyBase(next.host, SECTOR);
    expect(npcOwners(next.registry).has(fallenOwner)).toBe(false);
  });

  it('no regrow without a restart: seeding again in the running room skips the fallen base', () => {
    const { r, fallenOwner } = fallenSector();
    const live = [...r.registry.all()].filter((s) => isNpcOwner(s.owner)).map((s) => s.id);
    for (const id of live) r.registry.remove(id); // clear the living bases so only the fallen one could block
    seedGalaxyBase(r.host, SECTOR);
    expect(npcOwners(r.registry).has(fallenOwner)).toBe(false);
  });

  it('an old save (pieces without originBase) still loads, and the base is not taken as fallen', () => {
    const { r, fallenOwner } = fallenSector();
    const { next } = restart(r, (rows) => { for (const row of rows) delete row.originBase; });
    expect(next.registry.size).toBeGreaterThan(0);
    for (const s of next.registry.all()) expect(s.originBase).toBeUndefined();
    seedGalaxyBase(next.host, SECTOR);
    expect(npcOwners(next.registry).has(fallenOwner)).toBe(true);
  });
});
