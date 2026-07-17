/**
 * Unit lock for MalformedMessageTracker (campaign PR 1.3) — the shared
 * per-connection error counter + sampled warn behind invariant #3's second
 * half. The seam-level lock is InputHandler.malformedSampling.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { MalformedMessageTracker } from './MalformedMessageTracker.js';

describe('MalformedMessageTracker', () => {
  it('warns on the FIRST malformed packet per connection', () => {
    const warn = vi.fn();
    const t = new MalformedMessageTracker({ warn }, 10);
    t.record('s1', 'fire');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ sessionId: 's1', messageType: 'fire', malformedCount: 1 });
  });

  it('samples: 1st + every Nth', () => {
    const warn = vi.fn();
    const t = new MalformedMessageTracker({ warn }, 10);
    for (let i = 0; i < 30; i++) t.record('s1', 'input');
    // warns at counts 1, 10, 20, 30
    expect(warn).toHaveBeenCalledTimes(4);
    expect(t.countFor('s1')).toBe(30);
  });

  it('counts are per-connection', () => {
    const warn = vi.fn();
    const t = new MalformedMessageTracker({ warn }, 10);
    t.record('s1', 'fire');
    t.record('s2', 'fire');
    expect(t.countFor('s1')).toBe(1);
    expect(t.countFor('s2')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2); // each connection's first
  });

  it('clear() forgets a connection (no leak across reconnects)', () => {
    const warn = vi.fn();
    const t = new MalformedMessageTracker({ warn }, 10);
    t.record('s1', 'fire');
    t.clear('s1');
    expect(t.countFor('s1')).toBe(0);
    t.record('s1', 'fire'); // fresh connection with a reused sessionId: warns again as "first"
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
