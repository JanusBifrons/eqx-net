import { describe, it, expect } from 'vitest';
import { ShieldWallManager } from './ShieldWallManager.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { CONNECTION_THROUGHPUT } from '../../core/structures/structureGridConstants.js';

function pylon(id: string, x: number, y: number, owner = 'p1', built = true): StructureRecord {
  return {
    id, owner, kind: 'shield_pylon', subtypeIndex: 0, x, y, radius: 30,
    isConstructed: built, constructionProgress: built ? 500 : 0, constructionCost: 500,
    isDeconstructing: false, minerals: 0, storedPower: 0,
  };
}

function makeManager(opts: { powered?: boolean; netPower?: number; charge?: number } = {}) {
  const registry = new StructureRegistry();
  const calls = {
    spawn: [] as Array<{ id: string; ax: number; ay: number; bx: number; by: number }>,
    setActive: [] as Array<{ id: string; active: boolean }>,
    remove: [] as string[],
  };
  let drained = 0;
  const mgr = new ShieldWallManager({
    registry,
    powerSummaryFor: () => ({ netPower: opts.netPower ?? 50, powered: opts.powered ?? true }),
    componentBatteryCharge: () => opts.charge ?? 0,
    drainComponentBatteries: (_id, amount) => { drained += amount; return amount; },
    spawnWall: (id, ax, ay, bx, by) => calls.spawn.push({ id, ax, ay, bx, by }),
    setWallActive: (id, active) => calls.setActive.push({ id, active }),
    removeWall: (id) => calls.remove.push(id),
  });
  /** Seed a connected, built, same-owner pylon pair. */
  const seedPair = (): void => {
    registry.add(pylon('a', 0, 0));
    registry.add(pylon('b', 200, 0));
    registry.addConnection('a', 'b', CONNECTION_THROUGHPUT);
  };
  return { registry, mgr, calls, seedPair, getDrained: () => drained };
}

describe('ShieldWallManager', () => {
  it('forms one wall between a connected, built, same-owner pylon pair', () => {
    const { mgr, calls, seedPair } = makeManager();
    seedPair();
    mgr.update(1000);
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]).toMatchObject({ id: 'wall-a|b', ax: 0, ay: 0, bx: 200, by: 0 });
    expect(mgr.wallStateFor('a', 1000)).toEqual({ otherPost: 'b', active: true });
    // Idempotent — a second update does NOT re-spawn.
    mgr.update(1100);
    expect(calls.spawn).toHaveLength(1);
  });

  it('does not form a wall across different owners or with a blueprint', () => {
    const { registry, mgr, calls } = makeManager();
    registry.add(pylon('a', 0, 0, 'p1'));
    registry.add(pylon('b', 200, 0, 'p2')); // different owner
    registry.add(pylon('c', 0, 200, 'p1', /*built*/ false)); // blueprint, same owner as a
    registry.addConnection('a', 'b', CONNECTION_THROUGHPUT);
    registry.addConnection('a', 'c', CONNECTION_THROUGHPUT);
    mgr.update(1000);
    expect(calls.spawn).toHaveLength(0);
  });

  it('drops the wall to inactive while its grid is unpowered', () => {
    const { mgr, calls, seedPair } = makeManager({ powered: false });
    seedPair();
    mgr.update(1000);
    expect(calls.setActive).toContainEqual({ id: 'wall-a|b', active: false });
    expect(mgr.wallStateFor('a', 1000)?.active).toBe(false);
  });

  it('tears the wall down when a pylon is removed', () => {
    const { registry, mgr, calls, seedPair } = makeManager();
    seedPair();
    mgr.update(1000);
    registry.remove('b'); // severs the connection too
    mgr.update(1200);
    expect(calls.remove).toContain('wall-a|b');
    expect(mgr.wallStateFor('a', 1200)).toBeUndefined();
  });

  it('onWallHit: batteries cover the excess over surplus, no stun', () => {
    const { mgr, seedPair, getDrained } = makeManager({ netPower: 50, charge: 100 });
    seedPair();
    mgr.update(1000);
    const absorbed = mgr.onWallHit('wall-a|b', 80, 2000); // 30 over surplus, charge 100
    expect(absorbed).toBe(true);
    expect(getDrained()).toBe(30);
    expect(mgr.wallStateFor('a', 2000)?.active).toBe(true); // still up
  });

  it('onWallHit: overwhelming surplus + batteries stuns the wall (then passes shots)', () => {
    const { mgr, calls, seedPair } = makeManager({ netPower: 50, charge: 0 });
    seedPair();
    mgr.update(1000);
    expect(mgr.onWallHit('wall-a|b', 80, 2000)).toBe(true); // absorbed, but stuns
    expect(calls.setActive).toContainEqual({ id: 'wall-a|b', active: false });
    expect(mgr.wallStateFor('a', 2000)?.active).toBe(false);
    // A shot at a down wall is NOT absorbed (passes through to the pylon behind).
    expect(mgr.onWallHit('wall-a|b', 80, 2100)).toBe(false);
  });

  it('blockShot absorbs a beam crossing an up wall (and stops at the crossing)', () => {
    // Wall span a(0,0)→b(200,0). A beam from (100,-50) heading +y crosses at y=0.
    const { mgr, seedPair, getDrained } = makeManager({ netPower: 50, charge: 0 });
    seedPair();
    mgr.update(1000);
    const dist = mgr.blockShot(100, -50, 0, 1, 250, 80, 2000);
    expect(dist).toBe(50); // crosses the wall 50u ahead
    // The hit was applied (surplus 50 < 80 damage → drained 0, but stunned).
    expect(mgr.wallStateFor('a', 2000)?.active).toBe(false);
    expect(getDrained()).toBe(0);
  });

  it('blockShot ignores a beam that misses the span / a down wall', () => {
    const { mgr, seedPair } = makeManager({ powered: false }); // wall down (unpowered)
    seedPair();
    mgr.update(1000);
    expect(mgr.blockShot(100, -50, 0, 1, 250, 80, 2000)).toBeNull(); // down → passes
  });

  it('blockProjectile absorbs a step that crosses an up wall', () => {
    const { mgr, seedPair } = makeManager();
    seedPair();
    mgr.update(1000);
    // Step from (100,-10) moving +y by 20 → crosses the wall at y=0.
    expect(mgr.blockProjectile(100, -10, 0, 20, 30, 2000)).toBe(true);
    // A step that doesn't reach the wall passes.
    expect(mgr.blockProjectile(100, -50, 0, 5, 30, 2100)).toBe(false);
  });

  it('forEachActiveWall yields the live segment of an up wall only', () => {
    const { mgr, seedPair } = makeManager();
    seedPair();
    mgr.update(1000);
    const segs: Array<[string, number, number, number, number]> = [];
    mgr.forEachActiveWall(1000, (id, ax, ay, bx, by) => segs.push([id, ax, ay, bx, by]));
    expect(segs).toEqual([['wall-a|b', 0, 0, 200, 0]]);
    // Stun it → no active segment.
    mgr.onWallHit('wall-a|b', 999, 2000);
    segs.length = 0;
    mgr.forEachActiveWall(2000, (id, ax, ay, bx, by) => segs.push([id, ax, ay, bx, by]));
    expect(segs).toEqual([]);
  });
});
