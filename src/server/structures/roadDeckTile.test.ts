/**
 * Base platforms slice 20 — the road deck tile. A road is placed as a
 * hologram (the blueprint ghost body) and stays one for good: it builds like
 * any blueprint, but never turns solid, so ships fly over it. Weapons pass
 * over it too (`isWeaponTransparent`), and it still takes its space for
 * placement (no building on top).
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { settleBlueprintBody } from './blueprintBody.js';
import { isStructureBodySolid } from '../../core/structures/structureBody.js';
import { isWeaponTransparent, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import { getStructureKind, isDeckOnlyStructureKind, isFlatDeckKind } from '../../shared-types/structureKinds.js';

function makeHarness() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const spawns: Array<{ id: string; blueprint?: boolean }> = [];
  const solidified: string[] = [];
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: (s) => { spawns.push({ id: s.id, ...(s.blueprint ? { blueprint: true } : {}) }); return true; },
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    registry,
    shipHulls: () => [],
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    findNearestAsteroid: () => null,
    shipHulls: () => [],
    solidify: (id) => solidified.push(id),
  });
  return { registry, placement, grid, spawns, solidified };
}

describe('road deck tile (base platforms slice 20)', () => {
  it('is a flat, deck-only hex kind', () => {
    const k = getStructureKind('road');
    expect(k.deckSlot).toBe('hex');
    expect(isFlatDeckKind('road')).toBe(true);
    expect(isDeckOnlyStructureKind('road')).toBe(true);
    expect(isFlatDeckKind('connector')).toBe(false);
    expect(isDeckOnlyStructureKind('connector')).toBe(false);
  });

  it('spawns as a hologram body and stays one after it is built', () => {
    const h = makeHarness();
    const id = h.placement.place('p1', 'road', 0, 0)!;
    expect(id).toBeTruthy();
    expect(h.spawns).toEqual([{ id, blueprint: true }]);
    const rec = h.registry.get(id)!;
    expect(isStructureBodySolid(rec)).toBe(false);
    rec.prepaid = true;
    for (let i = 0; i < 500 && !rec.isConstructed; i++) h.grid.pulse(i);
    expect(rec.isConstructed, 'it builds like any blueprint').toBe(true);
    h.grid.pulse(9_999);
    expect(isStructureBodySolid(rec), 'ships still fly over it').toBe(false);
    expect(h.solidified).toEqual([]);
  });

  it('settling never turns it solid', () => {
    const h = makeHarness();
    const id = h.placement.place('p1', 'road', 0, 0)!;
    const rec = h.registry.get(id)!;
    const solidified: string[] = [];
    expect(settleBlueprintBody(rec, { shipHulls: () => [], solidify: (s) => solidified.push(s) })).toBe(true);
    expect(rec.ghostBody).toBe(true);
    expect(solidified).toEqual([]);
  });

  it('still takes its hex: nothing else is placed on top of it', () => {
    const h = makeHarness();
    expect(h.placement.place('p1', 'road', 0, 0)).toBeTruthy();
    expect(h.placement.place('p1', 'connector', 0, 0)).toBeNull();
  });

  it('weapons pass over it; every other structure is still hit', () => {
    expect(isWeaponTransparent({ kind: SWARM_KIND_STRUCTURE, shipKind: 'road' })).toBe(true);
    expect(isWeaponTransparent({ kind: SWARM_KIND_STRUCTURE, shipKind: 'connector' })).toBe(false);
    expect(isWeaponTransparent({ kind: SWARM_KIND_STRUCTURE, shipKind: 'capital' })).toBe(false);
  });
});
