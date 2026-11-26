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
import { NpcBaseSubsystem } from './NpcBaseSubsystem.js';

function seedOn(deck: boolean) {
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
  const r = sub.seed({ baseId: 'b0', role: 'refinery', tier: 'settlement', seed: 7, x: 4321, y: -2100, side: 'traders', features: ['minerals'] });
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
      expect(registry.plates.plateAtWorld(owner, rec.x, rec.y), `${rec.kind} on a plate`).toBe(true);
    }
  });

  it('a room without the deck flag grows the row base as before (no plates)', () => {
    const { registry, r } = seedOn(false);
    expect(r.rejectedPlace).toBe(0);
    expect(r.grown.fencePylons).toBeGreaterThan(0);
    expect([...registry.all()].some((s) => s.kind === 'capital' && s.x === 4321 && s.y === -2100)).toBe(true);
  });
});
