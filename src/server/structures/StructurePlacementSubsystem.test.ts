import { describe, it, expect, beforeEach } from 'vitest';
import { StructurePlacementSubsystem, type StructurePlacementHooks } from './StructurePlacementSubsystem.js';
import { StructureRegistry } from './StructureRegistry.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { SCAFFOLDING_HP_FRACTION } from '../../core/structures/structureGridConstants.js';
import type { GridObstacle } from '../../core/structures/Grid.js';

interface Spawned {
  id: string;
  x: number;
  y: number;
  radius: number;
  shipKind: string;
}

function makeHarness(
  opts: { spawnOk?: boolean; clampTo?: { x: number; y: number }; obstacles?: GridObstacle[] } = {},
) {
  const registry = new StructureRegistry();
  const spawned: Spawned[] = [];
  const seeded = new Map<string, number>();
  const despawned: string[] = [];
  let counter = 0;
  const hooks: StructurePlacementHooks = {
    spawnStructure: (s) => {
      if (opts.spawnOk === false) return false;
      spawned.push(s);
      return true;
    },
    seedHealth: (id, hp) => seeded.set(id, hp),
    despawn: (id) => despawned.push(id),
    clamp: (x, y) => opts.clampTo ?? { x, y },
    nextId: () => `pstruct-${counter++}`,
    registry,
    // Phase-4 C2 — asteroid/obstacle poses, the same hook the room populates from
    // `gatherStructureObstacles()`. Absent ⇒ legacy structures-only validation.
    ...(opts.obstacles ? { getObstacles: () => opts.obstacles! } : {}),
  };
  const sub = new StructurePlacementSubsystem(hooks);
  return { sub, registry, spawned, seeded, despawned };
}

describe('StructurePlacementSubsystem', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('places the Capital as a PRE-BUILT structure (full HP, isConstructed)', () => {
    const id = h.sub.place('player-1', 'capital', 1000, -500);
    expect(id).not.toBeNull();
    const rec = h.registry.get(id!)!;
    expect(rec.owner).toBe('player-1');
    expect(rec.kind).toBe('capital');
    expect(rec.isConstructed).toBe(true);
    expect(rec.constructionProgress).toBe(0); // capital cost is 0
    expect(rec.constructionCost).toBe(0);
    // Seeded at full hull.
    expect(h.seeded.get(id!)).toBe(getStructureKind('capital').maxHealth);
    // Subtype rode through to the spawn call (drives the wire byte).
    expect(h.spawned[0]!.shipKind).toBe('capital');
  });

  it('places a non-Capital as a BLUEPRINT (10% HP, not constructed, 0 progress)', () => {
    const id = h.sub.place('player-1', 'connector', 0, 0);
    expect(id).not.toBeNull();
    const rec = h.registry.get(id!)!;
    expect(rec.isConstructed).toBe(false);
    expect(rec.constructionProgress).toBe(0);
    expect(rec.constructionCost).toBe(getStructureKind('connector').constructionCost);
    const expectedHp = Math.floor(getStructureKind('connector').maxHealth * SCAFFOLDING_HP_FRACTION);
    expect(h.seeded.get(id!)).toBe(expectedHp);
  });

  it('rejects an unknown kind without spawning', () => {
    const id = h.sub.place('player-1', 'deathstar', 0, 0);
    expect(id).toBeNull();
    expect(h.spawned.length).toBe(0);
    expect(h.registry.size).toBe(0);
  });

  it('rejects an overlapping placement', () => {
    const first = h.sub.place('player-1', 'capital', 0, 0);
    expect(first).not.toBeNull();
    // Second within (capital.radius + connector.radius) of the first → reject.
    const overlap = h.sub.place('player-1', 'connector', 10, 10);
    expect(overlap).toBeNull();
    // Far away → accepted.
    const far = h.sub.place('player-1', 'connector', 5000, 5000);
    expect(far).not.toBeNull();
    expect(h.registry.size).toBe(2);
  });

  // ── Phase-4 C2 — placement must reject overlapping an ASTEROID, not just
  // another structure. Pre-fix the overlap loop iterated structures ONLY, so a
  // capital dropped on a rock LANDED ("places on an asteroid"). ──
  it('rejects a placement overlapping an ASTEROID obstacle (C2)', () => {
    // An asteroid (radius 120) parked at the origin; the capital (radius 80)
    // dropped centred on it overlaps (0 < 200) → must be rejected, nothing spawned.
    const withRock = makeHarness({ obstacles: [{ x: 0, y: 0, radius: 120 }] });
    const onRock = withRock.sub.place('player-1', 'capital', 0, 0);
    expect(onRock).toBeNull();
    expect(withRock.spawned.length).toBe(0);
    expect(withRock.registry.size).toBe(0);
    // Well clear of the rock → accepted.
    const clear = withRock.sub.place('player-1', 'capital', 5000, 5000);
    expect(clear).not.toBeNull();
    expect(withRock.registry.size).toBe(1);
  });

  it('still places normally when no obstacle hook is supplied (legacy back-compat)', () => {
    const id = h.sub.place('player-1', 'capital', 0, 0); // h has no obstacles
    expect(id).not.toBeNull();
    expect(h.registry.size).toBe(1);
  });

  it('returns null and records nothing when the slot pool is exhausted', () => {
    const full = makeHarness({ spawnOk: false });
    const id = full.sub.place('player-1', 'solar', 0, 0);
    expect(id).toBeNull();
    expect(full.registry.size).toBe(0);
    expect(full.seeded.size).toBe(0);
  });

  it('clamps the requested position before recording it', () => {
    const clamped = makeHarness({ clampTo: { x: 5000, y: -5000 } });
    const id = clamped.sub.place('player-1', 'solar', 999999, -999999);
    const rec = clamped.registry.get(id!)!;
    expect(rec.x).toBe(5000);
    expect(rec.y).toBe(-5000);
    expect(clamped.spawned[0]!.x).toBe(5000);
  });

  it('remove: owner can remove (despawns + drops record); others cannot', () => {
    const id = h.sub.place('player-1', 'turret', 0, 0)!;
    expect(h.sub.remove('player-2', id)).toBe(false); // not the owner
    expect(h.registry.has(id)).toBe(true);
    expect(h.sub.remove('player-1', id)).toBe(true);
    expect(h.registry.has(id)).toBe(false);
    expect(h.despawned).toContain(id);
    // Removing an unknown id is a no-op false.
    expect(h.sub.remove('player-1', 'nope')).toBe(false);
  });
});
