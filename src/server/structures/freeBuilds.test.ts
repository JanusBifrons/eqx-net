/**
 * Sandbox `freeBuilds` (docs/features/sandbox.md): a player's placement of
 * ANY kind needs no crate and costs no minerals, at normal build time; its
 * upgrades are free too, and taking it down repacks into nothing.
 */
import { describe, it, expect } from 'vitest';
import { StructurePlacementSubsystem, type StructurePlacementHooks } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';

function rig(freeBuild: boolean, crateHeld = false) {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const gateCalls: string[] = [];
  let commits = 0;
  let counter = 0;
  const hooks: StructurePlacementHooks = {
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => health.delete(id),
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
    sectorKey: () => 'sandbox',
    freeBuild: () => freeBuild,
    packedGateForBuild: (_owner, kind) => {
      gateCalls.push(kind);
      return { ok: crateHeld, commit: () => { commits++; return { product: `structure:${kind}`, quality: 42 }; } };
    },
  };
  const placement = new StructurePlacementSubsystem(hooks);
  const repacked: string[] = [];
  const goodsAsked: unknown[] = [];
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => health.delete(id),
    findNearestAsteroid: () => null,
    drawAsteroidResources: (_e, amount) => amount,
    findNearestDrone: () => null,
    applyDamage: () => {},
    broadcastBeam: () => {},
    spawnProjectile: () => {},
    spawnMissile: () => {},
    rigTick: () => 0,
    onRepack: (rec) => repacked.push(rec.id),
    takeGoods: (_rec, bill) => { goodsAsked.push(bill); return false; },
  });
  let now = 0;
  const pulseUntil = (done: () => boolean): number => {
    let n = 0;
    while (!done() && n < 20_000) { now += 1000; grid.pulse(now); n++; }
    return n;
  };
  return { registry, placement, grid, gateCalls, commits: () => commits, repacked, goodsAsked, pulseUntil };
}

const KINDS = ['solar', 'refinery', 'capital'] as const; // starter, crate-stocked, the Capital

describe('freeBuilds — placement', () => {
  for (const kind of KINDS) {
    it(`a player's ${kind} places free: no crate asked for, no minerals, not prepaid`, () => {
      const r = rig(true);
      const id = r.placement.place('alice', kind, 0, 0, { requirePacked: true });
      expect(id).not.toBeNull();
      const rec = r.registry.get(id!)!;
      expect(rec.free).toBe(true);
      expect(rec.prepaid).toBeUndefined();
      expect(r.gateCalls).toEqual([]);
    });
  }

  it('a held crate is NOT consumed in a free room', () => {
    const r = rig(true, true);
    r.placement.place('alice', 'refinery', 0, 0, { requirePacked: true });
    r.placement.place('alice', 'capital', 9000, 0, { requirePacked: true });
    expect(r.commits()).toBe(0);
  });

  it('a system placement in a free room is not marked free', () => {
    const r = rig(true);
    const rec = r.registry.get(r.placement.place('npc', 'refinery', 0, 0)!)!;
    expect(rec.free).toBeUndefined();
  });

  it('option off: the crate rule holds (Capital refused, refinery a bank build)', () => {
    const r = rig(false);
    expect(r.placement.place('alice', 'capital', 0, 0, { requirePacked: true })).toBeNull();
    const rec = r.registry.get(r.placement.place('alice', 'refinery', 0, 0, { requirePacked: true })!)!;
    expect(rec.free).toBeUndefined();
    expect(r.gateCalls).toEqual(['capital', 'refinery']);
  });
});

describe('freeBuilds — grid pulse', () => {
  it('a free blueprint builds at the normal rate with no Capital or route; a paid one stalls', () => {
    const r = rig(true);
    const free = r.registry.get(r.placement.place('alice', 'refinery', 0, 0, { requirePacked: true })!)!;
    const paid = r.registry.get(r.placement.place('alice', 'refinery', 9000, 0)!)!;
    expect(r.grid.estimateBuildEtaMs(free)).not.toBeNull();
    expect(r.grid.buildStallReason(free)).toBeNull();
    const pulses = r.pulseUntil(() => free.isConstructed);
    expect(free.isConstructed).toBe(true);
    expect(pulses).toBeGreaterThan(1); // normal build time, not instant
    expect(paid.isConstructed).toBe(false);
    expect(paid.constructionProgress).toBe(0);
  });

  it('a free Capital keeps its bank while a free blueprint builds beside it', () => {
    const r = rig(true);
    const cap = r.registry.get(r.placement.place('alice', 'capital', 0, 0, { requirePacked: true, rot: 180 })!)!; // crane pad away from the link
    const bank = cap.minerals;
    const bp = r.registry.get(r.placement.place('alice', 'connector', 0, 490, { requirePacked: true })!)!;
    expect(r.registry.connectionsOf(bp.id).length).toBeGreaterThan(0); // routed: a paid build would draw
    r.pulseUntil(() => bp.isConstructed);
    expect(bp.isConstructed).toBe(true);
    expect(cap.minerals).toBe(bank);
  });

  it('deconstructing a free structure repacks into nothing', () => {
    const r = rig(true);
    const id = r.placement.place('alice', 'refinery', 0, 0, { requirePacked: true })!;
    const rec: StructureRecord = r.registry.get(id)!;
    r.pulseUntil(() => rec.isConstructed);
    rec.isDeconstructing = true;
    r.pulseUntil(() => r.registry.get(id) === undefined);
    expect(r.registry.get(id)).toBeUndefined();
    expect(r.repacked).toEqual([]);
  });

  it('an upgrade of a free structure costs no minerals and no goods', () => {
    const r = rig(true);
    const id = r.placement.place('alice', 'solar', 0, 0, { requirePacked: true })!;
    const rec = r.registry.get(id)!;
    r.pulseUntil(() => rec.isConstructed);
    rec.level = 2; // 2 → 3 normally bills goods too
    expect(r.grid.upgradeStructure(id)).toBe(true);
    expect(r.goodsAsked).toEqual([]);
    expect(r.grid.buildStallReason(rec)).toBeNull();
    r.pulseUntil(() => rec.isConstructed);
    expect(rec.level).toBe(3);
  });
});
