/**
 * Game time scale: the showcase server-pace gate counts ticks per GAME second,
 * so a sector filmed at 0.5× (30 ticks a wall second, by design) passes, and a
 * starved 1× server still fails.
 */
import { describe, it, expect } from 'vitest';
import { netProblem, netSummary } from './wobble.js';

describe('netProblem at a game speed', () => {
  it('a healthy 0.5× sector passes (30 Hz wall = 60 per game second)', () => {
    expect(netProblem({ serverHz: 30, serverGameHz: 60, corrections: 0, snapshots: 100 })).toBeNull();
    expect(netSummary({ serverHz: 30, serverGameHz: 60, corrections: 0, snapshots: 100 })).toContain('60 per game s');
  });
  it('a starved server still fails, at any speed', () => {
    expect(netProblem({ serverHz: 25, serverGameHz: 25, corrections: 0, snapshots: 100 })).toMatch(/server behind/);
    expect(netProblem({ serverHz: 25, corrections: 0, snapshots: 100 })).toMatch(/server behind/);
  });
});
