import { describe, it, expect } from 'vitest';
import { pickWingmanFireTarget, type WingmanFireCandidates } from './wingmanFireTarget.js';

function cand(over: Partial<WingmanFireCandidates> = {}): WingmanFireCandidates {
  return {
    orderTargetId: null, brainTargetId: null, recentAttackerId: null,
    guardHostileId: null, reachHostileId: null, retreating: false, ...over,
  };
}

describe('pickWingmanFireTarget (RTS slice 5 stance gating)', () => {
  const all = cand({ orderTargetId: 'order', brainTargetId: 'brain', recentAttackerId: 'hitter', guardHostileId: 'guard', reachHostileId: 'reach' });

  it('holdFire never fires, whatever is around', () => {
    expect(pickWingmanFireTarget('holdFire', all)).toBeNull();
    expect(pickWingmanFireTarget('holdFire', { ...all, retreating: true })).toBeNull();
  });

  it('defensive: explicit attack target, then whoever hit it, then a hostile inside its guard radius', () => {
    expect(pickWingmanFireTarget('defensive', all)).toBe('order');
    expect(pickWingmanFireTarget('defensive', cand({ recentAttackerId: 'hitter', guardHostileId: 'guard' }))).toBe('hitter');
    expect(pickWingmanFireTarget('defensive', cand({ guardHostileId: 'guard', reachHostileId: 'reach' }))).toBe('guard');
  });

  it('defensive never starts a fight with a hostile merely in weapon reach, nor chases the hunt target', () => {
    expect(pickWingmanFireTarget('defensive', cand({ reachHostileId: 'reach', brainTargetId: 'brain' }))).toBeNull();
  });

  it('aggressive: its own target first, then the defensive candidates, then any hostile in reach', () => {
    expect(pickWingmanFireTarget('aggressive', all)).toBe('brain');
    expect(pickWingmanFireTarget('aggressive', cand({ orderTargetId: 'order', reachHostileId: 'reach' }))).toBe('order');
    expect(pickWingmanFireTarget('aggressive', cand({ recentAttackerId: 'hitter', reachHostileId: 'reach' }))).toBe('hitter');
    expect(pickWingmanFireTarget('aggressive', cand({ reachHostileId: 'reach' }))).toBe('reach');
    expect(pickWingmanFireTarget('aggressive', cand())).toBeNull();
  });

  it('a retreating ship only returns fire', () => {
    expect(pickWingmanFireTarget('aggressive', { ...all, retreating: true })).toBe('hitter');
    expect(pickWingmanFireTarget('defensive', cand({ guardHostileId: 'guard', retreating: true }))).toBeNull();
  });
});
