import { describe, it, expect, beforeEach } from 'vitest';
import { SnapshotRing } from './SnapshotRing.js';

describe('SnapshotRing', () => {
  let ring: SnapshotRing;

  beforeEach(() => {
    ring = new SnapshotRing();
    ring.registerEntity('ship-a');
    ring.registerEntity('ship-b');
  });

  it('allocation is exactly 192 KB (1000 × 12 × 16 bytes)', () => {
    expect(ring.byteLength).toBe(1000 * 12 * 16);
  });

  it('records and retrieves a position at the recorded tick', () => {
    ring.record(5, [{ id: 'ship-a', x: 10, y: 20, vx: 1, vy: 2 }]);
    const pos = ring.getAt('ship-a', 5);
    expect(pos).not.toBeNull();
    expect(pos!.x).toBeCloseTo(10);
    expect(pos!.y).toBeCloseTo(20);
  });

  it('records 12 distinct ticks and retrieves each correctly', () => {
    for (let tick = 0; tick < 12; tick++) {
      ring.record(tick, [{ id: 'ship-a', x: tick * 10, y: tick * 5, vx: 0, vy: 0 }]);
    }
    for (let tick = 0; tick < 12; tick++) {
      const pos = ring.getAt('ship-a', tick);
      expect(pos).not.toBeNull();
      expect(pos!.x).toBeCloseTo(tick * 10);
      expect(pos!.y).toBeCloseTo(tick * 5);
    }
  });

  it('returns null for ticks older than 12 (overwritten by ring wrap)', () => {
    for (let tick = 0; tick < 13; tick++) {
      ring.record(tick, [{ id: 'ship-a', x: tick, y: 0, vx: 0, vy: 0 }]);
    }
    // tick=0 ring slot was overwritten by tick=12 (12 % 12 === 0)
    expect(ring.getAt('ship-a', 0)).toBeNull();
  });

  it('returns null for an unknown entity', () => {
    ring.record(1, [{ id: 'ship-a', x: 0, y: 0, vx: 0, vy: 0 }]);
    expect(ring.getAt('unknown', 1)).toBeNull();
  });

  it('returns null when tick was never recorded', () => {
    expect(ring.getAt('ship-a', 99)).toBeNull();
  });

  it('tracks multiple entities independently', () => {
    ring.record(10, [
      { id: 'ship-a', x: 1, y: 2, vx: 0, vy: 0 },
      { id: 'ship-b', x: 3, y: 4, vx: 0, vy: 0 },
    ]);
    expect(ring.getAt('ship-a', 10)!.x).toBeCloseTo(1);
    expect(ring.getAt('ship-b', 10)!.x).toBeCloseTo(3);
  });

  it('unregistering an entity frees the slot and makes getAt return null', () => {
    ring.record(1, [{ id: 'ship-a', x: 5, y: 5, vx: 0, vy: 0 }]);
    ring.unregisterEntity('ship-a');
    expect(ring.getAt('ship-a', 1)).toBeNull();
  });
});
