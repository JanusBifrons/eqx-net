import { describe, it, expect } from 'vitest';
import { CollisionBroadcastGate, COLLISION_RESEND_TICKS } from './CollisionBroadcastGate.js';
import { RAM_MIN_IMPACT_SPEED } from '../../core/combat/Ramming.js';

/**
 * Regression: arcade handling (PR #566, thrust ×16–18) made ships pressed
 * together report a contact above the force floor EVERY tick, and the room
 * broadcast each one: fleet-fight pilots received ~3,000 `collision_resolved`
 * a second (533 KB/s of a 745 KB/s total; main 104 KB/s), 99 % with a closing
 * speed under 10 u/s. The client keeps one shield contact per shield per
 * 150 ms and 4 velocity mirrors per ship per second.
 */
describe('CollisionBroadcastGate', () => {
  it('sends a lasting low-speed contact once per resend window, not every tick', () => {
    const g = new CollisionBroadcastGate();
    let sent = 0;
    for (let tick = 100; tick < 160; tick++) if (g.shouldSend('a', 'b', 0.3, tick)) sent++;
    // One second of a ship pressed into another: 60 contacts in, 7 out.
    expect(sent).toBe(Math.ceil(60 / COLLISION_RESEND_TICKS));
  });

  it('a clump sends per body, not per pair', () => {
    const g = new CollisionBroadcastGate();
    // a pressed into b, c and d every tick for a second: 180 contacts.
    let sent = 0;
    for (let tick = 0; tick < 60; tick++) {
      for (const o of ['b', 'c', 'd']) if (g.shouldSend('a', o, 0, tick)) sent++;
    }
    // Each of b, c, d still gets its contact every resend window.
    expect(sent).toBe(3 * Math.ceil(60 / COLLISION_RESEND_TICKS));
  });

  it('sends a body\'s first touch at once', () => {
    const g = new CollisionBroadcastGate();
    expect(g.shouldSend('a', 'b', 0, 10)).toBe(true);
    expect(g.shouldSend('b', 'a', 0, 11)).toBe(false);
    expect(g.shouldSend('a', 'c', 0, 11)).toBe(true); // c is new
  });

  it('always sends an impact (a closing speed that can deal ram damage)', () => {
    const g = new CollisionBroadcastGate();
    expect(g.shouldSend('a', 'b', 0, 10)).toBe(true);
    expect(g.shouldSend('a', 'b', RAM_MIN_IMPACT_SPEED, 11)).toBe(true);
    expect(g.shouldSend('a', 'b', RAM_MIN_IMPACT_SPEED - 1, 12)).toBe(false);
  });

  it('forgets bodies it has not sent for a while', () => {
    const g = new CollisionBroadcastGate();
    g.shouldSend('a', 'b', 0, 0);
    g.shouldSend('c', 'd', 0, 200);
    expect(g.size()).toBe(4);
    g.sweep(240);
    expect(g.size()).toBe(2);
    expect(g.shouldSend('a', 'b', 0, 241)).toBe(true);
  });
});
