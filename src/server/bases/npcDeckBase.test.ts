/**
 * Base platforms slice 23 — on a deck room (`registry.deck`) the NPC seeder
 * grows its base on plates and seeds it on the deck lattice: the real
 * placement seam takes every piece, `connectExplicit` (the deck `canConnect`)
 * takes every edge, and every piece stands on its owner's plates.
 */
import { describe, expect, it } from 'vitest';
import { npcOwner } from '../../shared-types/relations.js';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import { isConnectorKind } from '../../shared-types/structureKinds.js';
import { NpcBaseSubsystem, galaxyBaseClearing, type NpcBaseSpec } from './NpcBaseSubsystem.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../core/structures/deckLinks.js';


/** On the owner's deck: the centre on a plate, or (a fence post/gate on a
 *  seam, as the placement rule allows) a point 2 u around it on one. */
function onOwnDeck(registry: StructureRegistry, owner: string, kind: string, x: number, y: number): boolean {
  if (registry.plates.plateAtWorld(owner, x, y)) return true;
  if (kind !== DECK_FENCE_POST_KIND && kind !== DECK_FENCE_GATE_KIND) return false;
  for (let k = 0; k < 12; k++) if (registry.plates.plateAtWorld(owner, x + 2 * Math.cos(k * Math.PI / 6), y + 2 * Math.sin(k * Math.PI / 6))) return true;
  return false;
}

function seedOn(deck: boolean, dense = false) {
  const registry = new StructureRegistry();
  registry.deck = deck;
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: () => undefined,
    despawn: () => undefined,
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    structureUid: (_o, kind, x, y) => `uid-${kind}-${x}-${y}`,
    registry,
  });
  const sub = new NpcBaseSubsystem({
    registry,
    place: (owner, kind, x, y, rot) => placement.place(owner, kind, x, y, { skipAutoConnect: true, rot }),
    setHealth: () => undefined,
  });
  const spec: NpcBaseSpec = { baseId: 'b0', role: 'refinery', tier: 'settlement', seed: 7, x: 4321, y: -2100, side: 'traders', features: ['minerals'] };
  const r = sub.seed(spec, dense ? sub.grow(spec, true) : undefined);
  return { registry, r };
}

describe('NPC base on a deck room (base platforms 23)', () => {
  it('seeds on plates: every piece placed and linked, all on its own deck', () => {
    const { registry, r } = seedOn(true);
    expect(r.rejectedPlace).toBe(0);
    expect(r.rejectedEdge).toBe(0);
    const owner = npcOwner('traders', 'b0');
    expect(r.owner).toBe(owner);
    expect(registry.plates.plateCount(owner)).toBeGreaterThan(0);
    for (const rec of registry.all()) {
      expect(rec.owner).toBe(owner);
      expect(onOwnDeck(registry, owner, rec.kind, rec.x, rec.y), `${rec.kind} on a plate`).toBe(true);
    }
  });

  it('a room without the deck flag grows the row base as before (no plates)', () => {
    const { registry, r } = seedOn(false);
    expect(r.rejectedPlace).toBe(0);
    expect(r.grown.fencePylons).toBeGreaterThan(0);
    expect([...registry.all()].some((s) => s.kind === 'capital' && s.x === 4321 && s.y === -2100)).toBe(true);
  });
});

describe('dense deck bases in asteroid fields (base platforms 25)', () => {
  const plates = (g: { placements: ReadonlyArray<{ kind: string }> }): number => g.placements.filter((p) => isConnectorKind(p.kind)).length;

  it('the field signal: a home pocket in an asteroid sector sits in a clearing (dense), elsewhere none (sparse)', () => {
    const field = GALAXY_SECTORS.find((s) => s.features.includes('asteroid') && galaxyBaseClearing(s.key, null, true) !== null);
    const open = GALAXY_SECTORS.find((s) => !s.features.includes('asteroid'));
    expect(field, 'an asteroid sector with a home clearing').toBeDefined();
    expect(open).toBeDefined();
    expect(galaxyBaseClearing(open!.key, null, true)).toBeNull();
    // Solar-system sectors off: no cut field, so no clearing and no dense base.
    expect(galaxyBaseClearing(field!.key, null, false)).toBeNull();
  });

  it('a dense deck base seeds cleanly on fewer plates; dense is ignored off the deck', () => {
    const sparse = seedOn(true), dense = seedOn(true, true);
    expect(dense.r.rejectedPlace).toBe(0);
    expect(dense.r.rejectedEdge).toBe(0);
    const owner = npcOwner('traders', 'b0');
    expect(dense.registry.plates.plateCount(owner)).toBeLessThan(sparse.registry.plates.plateCount(owner));
    expect(plates(dense.r.grown)).toBe(dense.registry.plates.plateCount(owner));
    const rowsDense = seedOn(false, true), rows = seedOn(false);
    expect(rowsDense.r.grown).toEqual(rows.r.grown);
  });
});
