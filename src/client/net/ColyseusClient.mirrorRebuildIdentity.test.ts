/**
 * Reference-identity regression lock for the 2026-05-25 GC-discipline
 * sweep — `updateMirror()` MUTATES the existing `mirror.ships` entry
 * in place, it does NOT replace it via `mirror.ships.set(id, {...})`.
 *
 * Why this matters:
 *   - The previous spread-based rebuild allocated one object per ship
 *     per frame (60 Hz × ship count) — visible as periodic V8 minor-GC
 *     bursts in `gc_pause` events.
 *   - The mutate-in-place pattern preserves non-spatial fields
 *     (`kind`, `displayName`, `mountAngles`) automatically — we only
 *     write `x/y/vx/vy/angle/angvel`.
 *   - First-frame allocation is the only exception: when `prev` is
 *     undefined, we set the entry once. Subsequent frames mutate.
 *
 * This test exists to prevent silent regression: if a future refactor
 * goes back to `mirror.ships.set(id, { ...prev, x, y })`, the reference
 * identity assertion fails.
 *
 * See: src/client/CLAUDE.md "Renderer Rules", docs/architecture/gc-discipline.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';

interface ColyseusClientInternals {
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, Record<string, unknown>>;
  };
  predWorld: {
    getShipState(id: string): ShipPhysicsState | null;
  } | null;
  reconciler: { lerpOffset: { x: number; y: number }; lerpAngleOffset: number; advanceLerp(dtMs: number): void } | null;
  lastFrameMs: number;
  updateMirror(): void;
}

const asInternals = (c: ColyseusGameClient): ColyseusClientInternals =>
  c as unknown as ColyseusClientInternals;

function makePredWorld(state: ShipPhysicsState): ColyseusClientInternals['predWorld'] {
  return {
    getShipState: (_id: string): ShipPhysicsState | null => state,
  };
}

function makeReconciler(): NonNullable<ColyseusClientInternals['reconciler']> {
  return {
    lerpOffset: { x: 0, y: 0 },
    lerpAngleOffset: 0,
    advanceLerp(_dtMs: number): void { /* no-op */ },
  };
}

describe('updateMirror — mutate-in-place reference identity (2026-05-25 GC sweep)', () => {
  let client: ColyseusGameClient;

  beforeEach(() => {
    client = new ColyseusGameClient();
    const c = asInternals(client);
    c.mirror.localPlayerId = 'local-1';
    c.predWorld = makePredWorld({ x: 100, y: 200, vx: 0, vy: 0, angle: 0, angvel: 0 });
    c.reconciler = makeReconciler();
    c.lastFrameMs = 16.67;
  });

  it('preserves the mirror.ships entry reference across updateMirror() calls', () => {
    const c = asInternals(client);
    c.updateMirror(); // first frame allocates
    const firstRef = c.mirror.ships.get('local-1');
    expect(firstRef).toBeDefined();

    // Tag the entry — a real reference should survive across frames.
    (firstRef as Record<string, unknown>).__tag = 'tracked';

    // Mutate predWorld state for the next frame.
    c.predWorld = makePredWorld({ x: 150, y: 250, vx: 1, vy: 2, angle: 0.5, angvel: 0 });
    c.updateMirror();

    const secondRef = c.mirror.ships.get('local-1');
    expect(secondRef).toBe(firstRef);              // same reference
    expect((secondRef as Record<string, unknown>).__tag).toBe('tracked'); // mutation survived
    expect((secondRef as { x: number }).x).toBe(150); // spatial fields updated
    expect((secondRef as { y: number }).y).toBe(250);
  });

  it('preserves non-spatial fields (kind, displayName, mountAngles) without explicit spread', () => {
    const c = asInternals(client);
    c.updateMirror();
    const entry = c.mirror.ships.get('local-1');
    expect(entry).toBeDefined();

    // Simulate snapshot-anchored data written into the entry.
    Object.assign(entry!, { kind: 'fighter', displayName: 'Alice', mountAngles: [0.1, 0.2] });

    // Update spatial state — must NOT wipe the non-spatial fields.
    c.predWorld = makePredWorld({ x: 50, y: 60, vx: 0, vy: 0, angle: 1, angvel: 0 });
    c.updateMirror();

    const after = c.mirror.ships.get('local-1');
    expect(after).toBe(entry); // same reference
    expect((after as { kind?: string }).kind).toBe('fighter');
    expect((after as { displayName?: string }).displayName).toBe('Alice');
    expect((after as { mountAngles?: number[] }).mountAngles).toEqual([0.1, 0.2]);
    expect((after as { x: number }).x).toBe(50);
  });

  it('allocates exactly once per ship lifetime (peak == ship count, not frame count)', () => {
    const c = asInternals(client);

    // Run many frames; capture the entry reference each time. All must be
    // the same object — total allocation count for this ship is 1.
    const refs = new Set<Record<string, unknown>>();
    for (let frame = 0; frame < 100; frame++) {
      c.predWorld = makePredWorld({ x: frame, y: frame * 2, vx: 0, vy: 0, angle: 0, angvel: 0 });
      c.updateMirror();
      const r = c.mirror.ships.get('local-1');
      if (r) refs.add(r);
    }
    expect(refs.size).toBe(1);
  });
});
