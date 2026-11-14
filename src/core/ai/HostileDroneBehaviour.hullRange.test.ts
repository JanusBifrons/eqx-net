import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { shipHullDistance } from '../combat/shipHitShape.js';

// The brain measures "can I shoot / where do I stop" to the target's HULL, the
// same shape the fire gate (mountReach) measures to — not its centre.
const drone = (): AiEntity => ({ id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
const view = (p: { id: string; x: number; y: number; kindId?: string; angle?: number; shieldUp?: boolean }): AiWorldView => ({
  players: [{ vx: 0, vy: 0, ...p }],
  tick: 1000,
  dtSec: 1 / 60,
});

describe('HostileDroneBehaviour — range to the target hull', () => {
  it('fires on a battleship whose hull is in reach though its centre is beyond fireRange', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('cap', 0);
    const R = b.getFireRange();
    // Battleship straight ahead (+y): nearest hull point at ~0.8 × fireRange,
    // centre well past fireRange.
    let y = R;
    while (shipHullDistance('battleship', false, 0, 0, 0, y, 0) < R * 0.8) y += 5;
    expect(y).toBeGreaterThan(R * 1.1);
    const intent = b.tick(drone(), view({ id: 'cap', x: 0, y, kindId: 'battleship', angle: 0, shieldUp: false }));
    expect(intent.fire).toBeDefined();
  });

  it('a small target behaves as before: holds fire past fireRange, fires inside it', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const R = b.getFireRange();
    const far = b.tick(drone(), view({ id: 'p', x: 0, y: R * 1.3, kindId: 'fighter', angle: 0, shieldUp: true }));
    expect(far.fire).toBeUndefined();
    const b2 = new HostileDroneBehaviour();
    b2.markHostile('p', 0);
    const near = b2.tick(drone(), view({ id: 'p', x: 0, y: R * 0.8, kindId: 'fighter', angle: 0, shieldUp: true }));
    expect(near.fire).toBeDefined();
  });
});
