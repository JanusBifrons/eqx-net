import { describe, it, expect, beforeEach } from 'vitest';
import { SnapshotRing } from './SnapshotRing.js';

describe('SnapshotRing', () => {
  let ring: SnapshotRing;

  beforeEach(() => {
    ring = new SnapshotRing();
    ring.registerEntity('ship-a');
    ring.registerEntity('ship-b');
  });

  it('allocation matches RING_CAPACITY × RING_DEPTH × 6 floats (Phase C — angvel)', () => {
    // 2048 × 12 × 6 floats × 4 bytes = 589_824 bytes.
    // The 6th float is angvel, added in Phase C of the AI lockstep work
    // so the snapshot drone-slice path can carry temporally-aligned ω.
    expect(ring.capacity).toBe(2048);
    expect(ring.byteLength).toBe(2048 * 12 * 6 * 4);
  });

  it('records and retrieves angvel alongside the pose', () => {
    ring.record(7, [{ id: 'ship-a', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 1.75 }]);
    const pose = ring.getPoseAt('ship-a', 7);
    expect(pose!.angvel).toBeCloseTo(1.75, 5);
  });

  it('records and retrieves a pose at the recorded tick', () => {
    ring.record(5, [{ id: 'ship-a', x: 10, y: 20, vx: 1, vy: 2, angle: 0.5, angvel: 0 }]);
    const pose = ring.getPoseAt('ship-a', 5);
    expect(pose).not.toBeNull();
    expect(pose!.x).toBeCloseTo(10);
    expect(pose!.y).toBeCloseTo(20);
    expect(pose!.vx).toBeCloseTo(1);
    expect(pose!.vy).toBeCloseTo(2);
    expect(pose!.angle).toBeCloseTo(0.5);
  });

  it('records 12 distinct ticks and retrieves each correctly', () => {
    for (let tick = 0; tick < 12; tick++) {
      ring.record(tick, [{ id: 'ship-a', x: tick * 10, y: tick * 5, vx: 0, vy: 0, angle: tick * 0.1 }]);
    }
    for (let tick = 0; tick < 12; tick++) {
      const pose = ring.getPoseAt('ship-a', tick);
      expect(pose).not.toBeNull();
      expect(pose!.x).toBeCloseTo(tick * 10);
      expect(pose!.y).toBeCloseTo(tick * 5);
      expect(pose!.angle).toBeCloseTo(tick * 0.1);
    }
  });

  it('returns null for ticks older than 12 (overwritten by ring wrap)', () => {
    for (let tick = 0; tick < 13; tick++) {
      ring.record(tick, [{ id: 'ship-a', x: tick, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }]);
    }
    expect(ring.getPoseAt('ship-a', 0)).toBeNull();
  });

  it('returns null for an unknown entity', () => {
    ring.record(1, [{ id: 'ship-a', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }]);
    expect(ring.getPoseAt('unknown', 1)).toBeNull();
  });

  it('returns null when tick was never recorded', () => {
    expect(ring.getPoseAt('ship-a', 99)).toBeNull();
  });

  it('tracks multiple entities independently', () => {
    ring.record(10, [
      { id: 'ship-a', x: 1, y: 2, vx: 0, vy: 0, angle: 0.1, angvel: 0 },
      { id: 'ship-b', x: 3, y: 4, vx: 0, vy: 0, angle: -0.2, angvel: 0 },
    ]);
    expect(ring.getPoseAt('ship-a', 10)!.x).toBeCloseTo(1);
    expect(ring.getPoseAt('ship-a', 10)!.angle).toBeCloseTo(0.1);
    expect(ring.getPoseAt('ship-b', 10)!.x).toBeCloseTo(3);
    expect(ring.getPoseAt('ship-b', 10)!.angle).toBeCloseTo(-0.2);
  });

  it('unregistering an entity frees the slot and makes getPoseAt return null', () => {
    ring.record(1, [{ id: 'ship-a', x: 5, y: 5, vx: 0, vy: 0, angle: 0, angvel: 0 }]);
    ring.unregisterEntity('ship-a');
    expect(ring.getPoseAt('ship-a', 1)).toBeNull();
  });

  it('beginTick + recordEntity is allocation-free hot path', () => {
    // The streaming API is what SectorRoom.update() uses to avoid materializing
    // an entity array per tick. Verify it produces identical results to the
    // batch `record` form.
    ring.beginTick(42);
    ring.recordEntity('ship-a', 7, 8, 9, 10, 1.234, 0.5);
    ring.recordEntity('ship-b', -1, -2, -3, -4, -0.567, -0.25);
    const a = ring.getPoseAt('ship-a', 42)!;
    expect(a.x).toBeCloseTo(7);
    expect(a.angle).toBeCloseTo(1.234);
    const b = ring.getPoseAt('ship-b', 42)!;
    expect(b.y).toBeCloseTo(-2);
    expect(b.angle).toBeCloseTo(-0.567);
  });

  it('handles capacity-bound entity registration without throwing', () => {
    // Register up to capacity, then one more — the overflow should be silently
    // ignored (the entity is never recorded, getPoseAt returns null).
    const fresh = new SnapshotRing();
    for (let i = 0; i < fresh.capacity; i++) fresh.registerEntity(`e${i}`);
    fresh.registerEntity('one-too-many');
    fresh.record(1, [{ id: 'one-too-many', x: 1, y: 2, vx: 0, vy: 0, angle: 0, angvel: 0 }]);
    expect(fresh.getPoseAt('one-too-many', 1)).toBeNull();
  });

  it('handles negative ticks via positive-modulo ring slot calculation', () => {
    // Defensive: server tick is always positive in production, but a buggy
    // caller passing -1 must not blow up the buffer indexing.
    ring.record(-1, [{ id: 'ship-a', x: 5, y: 6, vx: 0, vy: 0, angle: 0, angvel: 0 }]);
    expect(ring.getPoseAt('ship-a', -1)).not.toBeNull();
  });
});
