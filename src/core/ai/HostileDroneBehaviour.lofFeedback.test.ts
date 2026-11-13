/**
 * Line-of-fire feedback (friendly fire; plan composed-harbor §4, slice 5a):
 * the room tells the brain when an ally held its shot. The brain keeps a
 * decaying recent-block count (game ticks, #20) and the latest blocker's
 * position, for later slices to steer by.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, BLOCK_HALF_LIFE_TICKS } from './HostileDroneBehaviour.js';
import { AiController } from './AiController.js';

describe('HostileDroneBehaviour.noteBlocked', () => {
  it('starts with no blocks', () => {
    const b = new HostileDroneBehaviour();
    expect(b.getRecentBlocks(100)).toBe(0);
    expect(b.getLastBlockedTick()).toBe(-1_000_000);
  });

  it('counts a block and records the blocker position', () => {
    const b = new HostileDroneBehaviour();
    b.noteBlocked(100, 12, -34);
    expect(b.getRecentBlocks(100)).toBe(1);
    expect(b.getLastBlockedTick()).toBe(100);
    expect(b.getLastBlockerX()).toBe(12);
    expect(b.getLastBlockerY()).toBe(-34);
  });

  it('counts at most once per tick but keeps the latest blocker', () => {
    const b = new HostileDroneBehaviour();
    b.noteBlocked(100, 1, 1);
    b.noteBlocked(100, 2, 3); // a second barrel the same tick
    expect(b.getRecentBlocks(100)).toBe(1);
    expect(b.getLastBlockerX()).toBe(2);
    expect(b.getLastBlockerY()).toBe(3);
  });

  it('halves every half-life and accumulates over repeated blocks', () => {
    const b = new HostileDroneBehaviour();
    b.noteBlocked(0, 0, 0);
    expect(b.getRecentBlocks(BLOCK_HALF_LIFE_TICKS)).toBeCloseTo(0.5, 9);
    expect(b.getRecentBlocks(2 * BLOCK_HALF_LIFE_TICKS)).toBeCloseTo(0.25, 9);
    b.noteBlocked(BLOCK_HALF_LIFE_TICKS, 0, 0);
    expect(b.getRecentBlocks(BLOCK_HALF_LIFE_TICKS)).toBeCloseTo(1.5, 9);
    expect(b.getRecentBlocks(BLOCK_HALF_LIFE_TICKS * 11)).toBeLessThan(0.01);
  });

  it('AiController.noteBlocked forwards to the registered behaviour and ignores unknown ids', () => {
    const ctrl = new AiController({ postIntent: () => {} } as unknown as ConstructorParameters<typeof AiController>[0]);
    const b = new HostileDroneBehaviour();
    ctrl.register('d1', 3, b);
    ctrl.noteBlocked('d1', 50, 7, 8);
    ctrl.noteBlocked('nobody', 50, 0, 0);
    expect(b.getRecentBlocks(50)).toBe(1);
    expect(b.getLastBlockerX()).toBe(7);
  });
});
