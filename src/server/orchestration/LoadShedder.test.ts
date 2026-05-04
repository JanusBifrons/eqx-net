import { describe, it, expect, vi } from 'vitest';
import { LoadShedder } from './LoadShedder.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { Bus } from '../../core/events/Bus.js';

interface Pos { x: number; y: number }

function makeRegistry(positions: Array<{ id: string; kind: 0 | 1; x: number; y: number }>): {
  registry: SwarmEntityRegistry;
  posByRec: Map<SwarmEntityRecord, Pos>;
} {
  const registry = new SwarmEntityRegistry();
  const posByRec = new Map<SwarmEntityRecord, Pos>();
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    const rec = registry.register(p.id, i, p.kind, 8, p.x, p.y, 0);
    posByRec.set(rec, { x: p.x, y: p.y });
  }
  return { registry, posByRec };
}

function makeShedder(opts: {
  registry: SwarmEntityRegistry;
  posByRec: Map<SwarmEntityRecord, Pos>;
  players: Pos[];
  evicted: SwarmEntityRecord[];
  bus?: Bus;
}): LoadShedder {
  const bus = opts.bus ?? new Bus();
  return new LoadShedder({
    registry: opts.registry,
    getPlayers: () => opts.players,
    getPosition: (rec) => opts.posByRec.get(rec)!,
    evict: (rec) => opts.evicted.push(rec),
    bus,
  });
}

describe('LoadShedder', () => {
  it('returns 0 when rate is above floor', () => {
    const { registry, posByRec } = makeRegistry([
      { id: 'd0', kind: 1, x: 9999, y: 0 },
    ]);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({ registry, posByRec, players: [{ x: 0, y: 0 }], evicted });
    expect(shedder.consider(0.8, 18)).toBe(0);
    expect(evicted.length).toBe(0);
  });

  it('returns 0 when rate is at floor but budget is healthy', () => {
    const { registry, posByRec } = makeRegistry([
      { id: 'd0', kind: 1, x: 9999, y: 0 },
    ]);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({ registry, posByRec, players: [{ x: 0, y: 0 }], evicted });
    expect(shedder.consider(0.7, 12)).toBe(0);
    expect(evicted.length).toBe(0);
  });

  it('returns 0 when no players are alive (defensive)', () => {
    const { registry, posByRec } = makeRegistry([
      { id: 'd0', kind: 1, x: 9999, y: 0 },
    ]);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({ registry, posByRec, players: [], evicted });
    expect(shedder.consider(0.7, 18)).toBe(0);
    expect(evicted.length).toBe(0);
  });

  it('ignores asteroids — only drones are eligible for shedding', () => {
    const { registry, posByRec } = makeRegistry([
      { id: 'a0', kind: 0, x: 9999, y: 0 },
      { id: 'a1', kind: 0, x: 9000, y: 0 },
    ]);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({ registry, posByRec, players: [{ x: 0, y: 0 }], evicted });
    expect(shedder.consider(0.7, 18)).toBe(0);
    expect(evicted.length).toBe(0);
  });

  it('evicts the farthest-from-closest-player drones in batches of 10% (capped at 8)', () => {
    // 100 drones at random radii, 2 players at (0,0) and (1000,0).
    const positions = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`,
      kind: 1 as const,
      x: (i + 1) * 100, // 100, 200, ..., 10000
      y: 0,
    }));
    const { registry, posByRec } = makeRegistry(positions);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({
      registry,
      posByRec,
      players: [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
      evicted,
    });
    const n = shedder.consider(0.7, 18);
    expect(n).toBe(8); // min(8, ceil(100*0.10)) = 8
    expect(evicted.length).toBe(8);
    // The 8 evicted should be d92..d99 — the rightmost drones, which are
    // farthest from the closer (rightmost) player at x=1000.
    const evictedIds = evicted.map((r) => r.id).sort();
    expect(evictedIds).toEqual(['d92', 'd93', 'd94', 'd95', 'd96', 'd97', 'd98', 'd99']);
  });

  it('emits ENTITY_SHED on the bus once per evicted drone', () => {
    const positions = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      kind: 1 as const,
      x: (i + 1) * 1000,
      y: 0,
    }));
    const { registry, posByRec } = makeRegistry(positions);
    const evicted: SwarmEntityRecord[] = [];
    const bus = new Bus();
    const sed: string[] = [];
    bus.on('ENTITY_SHED', (p) => sed.push(p.entityId));
    const shedder = makeShedder({ registry, posByRec, players: [{ x: 0, y: 0 }], evicted, bus });
    const n = shedder.consider(0.7, 18);
    expect(n).toBe(1); // ceil(5 * 0.10) = 1
    expect(sed).toEqual([evicted[0]!.id]);
  });

  it('uses min-distance across multiple players (closest-player wins)', () => {
    // Drone at (500, 0): player A at (0,0) is dist 500; player B at (450, 0) is dist 50.
    // Closer player is B → drone is "near", should NOT be picked first.
    // Compare against another drone at (-500, 0): closest is A at (0,0), dist 500.
    const { registry, posByRec } = makeRegistry([
      { id: 'near-via-B', kind: 1, x: 500, y: 0 },
      { id: 'far-from-both', kind: 1, x: -500, y: 0 },
    ]);
    const evicted: SwarmEntityRecord[] = [];
    const shedder = makeShedder({
      registry,
      posByRec,
      players: [{ x: 0, y: 0 }, { x: 450, y: 0 }],
      evicted,
    });
    const n = shedder.consider(0.7, 18);
    expect(n).toBe(1);
    expect(evicted[0]!.id).toBe('far-from-both');
  });

  it('does not call evict or emit when no candidates exist', () => {
    const { registry, posByRec } = makeRegistry([]);
    const evicted: SwarmEntityRecord[] = [];
    const bus = new Bus();
    const emit = vi.spyOn(bus, 'emit');
    const shedder = makeShedder({ registry, posByRec, players: [{ x: 0, y: 0 }], evicted, bus });
    expect(shedder.consider(0.7, 18)).toBe(0);
    expect(evicted.length).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
