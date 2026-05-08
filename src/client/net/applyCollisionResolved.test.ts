/**
 * Stage 2 cycles 3, 4, 5 of the network-feel roadmap. The client-side
 * application logic for the server's `collision_resolved` message: vPost
 * applied to predWorld immediately, stale events dropped, rate limit
 * enforced. Pure function tested against a minimal-interface fake
 * predWorld — no Rapier, no message bus, no Colyseus.
 */
import { describe, it, expect } from 'vitest';
import type { CollisionResolvedMessage } from '@shared-types/messages';
import type { ShipPhysicsState } from '@core/physics/World';
import {
  applyCollisionResolved,
  createCollisionGuard,
  type MinimalPredWorld,
} from './applyCollisionResolved.js';

class FakePredWorld implements MinimalPredWorld {
  private states = new Map<string, ShipPhysicsState>();

  spawn(id: string, state: ShipPhysicsState): void {
    this.states.set(id, { ...state });
  }
  hasShip(id: string): boolean {
    return this.states.has(id);
  }
  getShipState(id: string): ShipPhysicsState | null {
    return this.states.get(id) ?? null;
  }
  setShipState(id: string, state: ShipPhysicsState): void {
    if (this.states.has(id)) this.states.set(id, { ...state });
  }
}

function makeMsg(overrides: Partial<CollisionResolvedMessage> = {}): CollisionResolvedMessage {
  return {
    type: 'collision_resolved',
    aId: 'player1',
    bId: 'asteroid42',
    vA: { x: -10, y: 5 },
    vB: { x: 30, y: -2 },
    impulse: 100,
    tick: 1000,
    ...overrides,
  };
}

describe('applyCollisionResolved', () => {
  it('Cycle 3: applies vPost to predWorld for matching participants', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 100, y: 200, angle: 0, vx: 50, vy: 0 });
    // asteroid42 deliberately not in predWorld — only matching IDs are touched

    const guard = createCollisionGuard();
    const result = applyCollisionResolved(makeMsg(), fake, guard, 1000);

    expect(result.applied).toEqual(['player1']);
    expect(result.dropped).toBeNull();
    const after = fake.getShipState('player1')!;
    expect(after.vx).toBe(-10);
    expect(after.vy).toBe(5);
    // x, y, angle, angvel preserved — only velocity is overwritten.
    expect(after.x).toBe(100);
    expect(after.y).toBe(200);
    expect(after.angle).toBe(0);
  });

  it('Cycle 3: applies vPost to BOTH participants when both are in predWorld', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 100, y: 200, angle: 0, vx: 50, vy: 0 });
    fake.spawn('player2', { x: 110, y: 200, angle: 0, vx: -40, vy: 0 });

    const guard = createCollisionGuard();
    const result = applyCollisionResolved(
      makeMsg({ aId: 'player1', bId: 'player2' }),
      fake,
      guard,
      1000,
    );

    expect(result.applied.sort()).toEqual(['player1', 'player2']);
    expect(fake.getShipState('player1')!.vx).toBe(-10);
    expect(fake.getShipState('player2')!.vx).toBe(30);
  });

  it('Cycle 3: silently no-ops when neither participant is in predWorld', () => {
    const fake = new FakePredWorld();
    const guard = createCollisionGuard();
    const result = applyCollisionResolved(makeMsg(), fake, guard, 1000);
    expect(result.applied).toEqual([]);
    expect(result.dropped).toBeNull();
  });

  it('Cycle 4: drops messages with tick < lastSnapshotServerTick', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 100, y: 200, angle: 0, vx: 50, vy: 0 });

    const guard = createCollisionGuard();
    guard.lastSnapshotServerTick = 2000;

    const result = applyCollisionResolved(makeMsg({ tick: 1500 }), fake, guard, 1500);

    expect(result.applied).toEqual([]);
    expect(result.dropped).toBe('stale');
    expect(fake.getShipState('player1')!.vx).toBe(50); // unchanged
  });

  it('Cycle 4: applies messages with tick === lastSnapshotServerTick (boundary)', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 100, y: 200, angle: 0, vx: 50, vy: 0 });

    const guard = createCollisionGuard();
    guard.lastSnapshotServerTick = 1500;

    const result = applyCollisionResolved(makeMsg({ tick: 1500 }), fake, guard, 1500);

    expect(result.dropped).toBeNull();
    expect(result.applied).toEqual(['player1']);
  });

  it('Cycle 5: rate-limits to 4 events per ship per second', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
    const guard = createCollisionGuard();

    // 4 events at t=1000, 1100, 1200, 1300 — all within 1 s window — should apply.
    for (let i = 0; i < 4; i++) {
      const r = applyCollisionResolved(
        makeMsg({ aId: 'player1', bId: 'X', vA: { x: i, y: 0 }, tick: 1000 + i }),
        fake,
        guard,
        1000 + i * 100,
      );
      expect(r.applied).toContain('player1');
    }

    // 5th at t=1400 — within window, count would be 5 — drop.
    const r5 = applyCollisionResolved(
      makeMsg({ aId: 'player1', bId: 'X', vA: { x: 99, y: 0 }, tick: 1004 }),
      fake,
      guard,
      1400,
    );
    expect(r5.dropped).toBe('rate-limited');
    expect(r5.applied).toEqual([]);
    expect(fake.getShipState('player1')!.vx).toBe(3); // last applied was event #4 with vx=3

    // 6th at t=2100 — outside the 1 s window since the first event at t=1000 — apply.
    const r6 = applyCollisionResolved(
      makeMsg({ aId: 'player1', bId: 'X', vA: { x: 77, y: 0 }, tick: 1005 }),
      fake,
      guard,
      2100,
    );
    expect(r6.applied).toContain('player1');
    expect(fake.getShipState('player1')!.vx).toBe(77);
  });

  it('Cycle 5: rate-limit window slides — dropping the oldest event allows new ones', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
    const guard = createCollisionGuard();

    // Fill the window at t=1000, 1100, 1200, 1300.
    for (let i = 0; i < 4; i++) {
      applyCollisionResolved(
        makeMsg({ aId: 'player1', bId: 'X', tick: 1000 + i }),
        fake,
        guard,
        1000 + i * 100,
      );
    }
    // Now at t=2050, the t=1000 event is just outside the 1 s window — new event should apply.
    const r = applyCollisionResolved(
      makeMsg({ aId: 'player1', bId: 'X', vA: { x: 42, y: 0 }, tick: 1006 }),
      fake,
      guard,
      2050,
    );
    expect(r.applied).toContain('player1');
    expect(fake.getShipState('player1')!.vx).toBe(42);
  });

  it('Cycle 5: rate-limit is per ship, not global', () => {
    const fake = new FakePredWorld();
    fake.spawn('player1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
    fake.spawn('player2', { x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
    const guard = createCollisionGuard();

    // Saturate player1's window with 4 (player1, X) events.
    for (let i = 0; i < 4; i++) {
      applyCollisionResolved(
        makeMsg({ aId: 'player1', bId: 'X', tick: 1000 + i }),
        fake,
        guard,
        1000 + i * 50,
      );
    }
    // player2 has had no events — should still apply.
    const r = applyCollisionResolved(
      makeMsg({ aId: 'player2', bId: 'Y', vA: { x: 88, y: 0 }, tick: 1100 }),
      fake,
      guard,
      1300,
    );
    expect(r.applied).toContain('player2');
    expect(fake.getShipState('player2')!.vx).toBe(88);
  });
});
