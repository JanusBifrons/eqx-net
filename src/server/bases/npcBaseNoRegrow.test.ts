/**
 * Capture plan 4E (S6) — owner rule: "A fallen NPC base never regrows, even
 * after a restart, until captured" (and once captured the site is taken, so
 * it still never regrows).
 *
 * Drives the real seams end to end: `seedGalaxyBase` grows the sector's bases,
 * the base's Capital dies (`StructureRegistry.remove` → `none:` pieces),
 * `SectorPersistence.persist` saves the sector, a FRESH registry restores it
 * (`SectorPersistence.hydrate` → `restoreStructures`) and `seedGalaxyBase` runs again
 * as on boot. Each structure the seeder places carries its `originBase` (the
 * NPC owner it was grown under); the saved pieces keep it, so the seeder skips
 * that base. The sector also saves `fallenBases` (every base that fell here), so a fallen
 * base whose pieces were all destroyed stays fallen. An old save (no
 * `originBase`, no `fallenBases`) loads and regrows as before.
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

/** Save `r`'s sector, then hydrate it into a fresh room through the real
 *  boot path (`SectorPersistence.persist` → `hydrate`): the server restart. */
function restart(r: ReturnType<typeof room>, edit?: (rows: SectorSnapshotStructure[], payload: SectorSnapshotPayload) => void) {
  const deps = (reg: StructureRegistry, health: Map<string, number>, restore: SectorSnapshotRestore, save: (p: SectorSnapshotPayload) => void, load: () => string | undefined) => new SectorPersistence({
    sectorKey: () => SECTOR,
    sabF32: new Float32Array(0),
    swarmRegistry: { all: () => [], has: () => false },
    swarmHealth: health,
    structures: () => reg.all(),
    restoreStructures: (rows) => restore.restoreStructures(rows),
    fallenBases: () => reg.fallenBases,
    restoreFallenBases: (origins) => reg.restoreFallenBases(origins),
    scrapEntities: () => [],
    restoreScrap: () => undefined,
    lingeringHulls: () => [],
    restoreLingeringHulls: () => undefined,
    saveRow: (_k, p) => save(p),
    loadRow: () => { const snapshot = load(); return snapshot === undefined ? undefined : { snapshot, created_at: Date.now() }; },
    logger: quiet,
  });
  let saved: SectorSnapshotPayload | undefined;
  deps(r.registry, r.health, r.restore, (p) => { saved = JSON.parse(JSON.stringify(p)) as SectorSnapshotPayload; }, () => undefined).persist();
  const rows = saved!.structures ?? [];
  edit?.(rows, saved!);
  const next = room();
  deps(next.registry, next.health, next.restore, () => undefined, () => JSON.stringify(saved)).hydrate();
  return { next, rows, saved: saved! };
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

  it('a fallen base whose pieces were all destroyed still does not regrow after a restart', () => {
    const { r, fallenOwner } = fallenSector();
    for (const s of [...r.registry.all()]) if (s.originBase === fallenOwner) r.registry.remove(s.id);
    expect([...r.registry.all()].some((s) => s.originBase === fallenOwner), 'no piece of it is left').toBe(false);
    const { next, saved } = restart(r);
    expect(saved.fallenBases, 'the sector remembers the fall').toContain(fallenOwner);
    seedGalaxyBase(next.host, SECTOR);
    expect(npcOwners(next.registry).has(fallenOwner)).toBe(false);
  });

  it('an old save (no originBase, no fallenBases) still loads, and the base is not taken as fallen', () => {
    const { r, fallenOwner } = fallenSector();
    const { next } = restart(r, (rows, payload) => { for (const row of rows) delete row.originBase; delete payload.fallenBases; });
    expect(next.registry.size).toBeGreaterThan(0);
    for (const s of next.registry.all()) expect(s.originBase).toBeUndefined();
    seedGalaxyBase(next.host, SECTOR);
    expect(npcOwners(next.registry).has(fallenOwner)).toBe(true);
  });
});
