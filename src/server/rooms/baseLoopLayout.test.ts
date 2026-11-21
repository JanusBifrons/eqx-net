/**
 * Perf scene `base-loop` (plan step 4I): its prebuilt base must seed as ONE
 * powered network, with the two Shield Pylons linked (so their wall forms) and
 * the Shipyard on a recipe. A dropped link would quietly measure a smaller,
 * unpowered base. Placement whole-ness is `prebuiltLayouts.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { BASE_LOOP_OPTS } from './scenarioLayouts.js';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

function seed(): { registry: StructureRegistry; ids: string[] } {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: () => {},
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    registry,
  });
  const ids: string[] = [];
  for (const p of BASE_LOOP_OPTS.prebuiltStructures) {
    const id = placement.place('owner', p.kind, p.x, p.y, { rot: p.rot });
    if (id !== null) ids.push(id);
  }
  return { registry, ids };
}

describe('base-loop perf base', () => {
  it('seeds every structure into one network', () => {
    const { registry, ids } = seed();
    expect(ids).toHaveLength(BASE_LOOP_OPTS.prebuiltStructures.length);
    const adj = registry.adjacencyMap();
    const seen = new Set<string>([ids[0]!]);
    const queue = [ids[0]!];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const c of adj.get(id) ?? []) {
        const o = c.getOtherNode(id);
        if (o !== null && !seen.has(o)) { seen.add(o); queue.push(o); }
      }
    }
    const unlinked = ids.filter((id) => !seen.has(id)).map((id) => registry.get(id)!.kind);
    expect(unlinked).toEqual([]);
  });

  it('links the two Shield Pylons (their wall forms)', () => {
    const { registry } = seed();
    const pylons = [...registry.all()].filter((r) => r.kind === 'shield_pylon');
    expect(pylons).toHaveLength(2);
    expect(registry.hasConnection(pylons[0]!.id, pylons[1]!.id)).toBe(true);
  });

  it('makes more power than it uses', () => {
    let out = 0;
    let use = 0;
    for (const p of BASE_LOOP_OPTS.prebuiltStructures) {
      out += getStructureKind(p.kind as Parameters<typeof getStructureKind>[0]).powerOutput;
      use += getStructureKind(p.kind as Parameters<typeof getStructureKind>[0]).powerConsumption;
    }
    expect(out).toBeGreaterThan(use);
  });

  it('puts the Shipyard on a blueprint recipe', () => {
    const yard = BASE_LOOP_OPTS.prebuiltStructures.find((p) => p.kind === 'shipyard');
    expect(yard?.recipe).toBe('build_interceptor');
  });
});
