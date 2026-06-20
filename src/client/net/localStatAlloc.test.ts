import { describe, it, expect } from 'vitest';
import { statAllocKey, decideStatAllocReanchor } from './localStatAlloc.js';
import { STAT_POINT_FRAC } from '../../core/leveling/shipStats.js';

/**
 * Phase 4 WS-B2 — the client's re-anchor decision for the local predWorld body's
 * physics multipliers from the authoritative own-ship `statAlloc` snapshot slice.
 * The multipliers come from the SAME `deriveStatMultipliers` the server worker
 * uses (risk #1 — locked at the physics level in
 * `applyShipInput.levelMultiplier.test.ts`); this locks the WHEN-to-push guard.
 */

describe('localStatAlloc — statAllocKey', () => {
  it('an empty / absent allocation keys to ""', () => {
    expect(statAllocKey(undefined)).toBe('');
    expect(statAllocKey({})).toBe('');
  });
  it('a non-empty allocation keys to its JSON', () => {
    expect(statAllocKey({ hull: 2 })).toBe(JSON.stringify({ hull: 2 }));
  });
});

describe('localStatAlloc — decideStatAllocReanchor', () => {
  it('re-pushes the physics pair when the allocation changes', () => {
    const d = decideStatAllocReanchor({ topSpeed: 5, turnRate: 2 }, '');
    expect(d.changed).toBe(true);
    expect(d.mul).toEqual({
      topSpeed: 1 + 5 * STAT_POINT_FRAC,
      turnRate: 1 + 2 * STAT_POINT_FRAC,
    });
  });

  it('does NOT re-push an identical allocation (key unchanged)', () => {
    const key = statAllocKey({ topSpeed: 5 });
    const d = decideStatAllocReanchor({ topSpeed: 5 }, key);
    expect(d.changed).toBe(false);
  });

  it('resets to the un-upgraded factors (undefined mul) when the slice is absent', () => {
    const d = decideStatAllocReanchor(undefined, JSON.stringify({ hull: 3 }));
    expect(d.changed).toBe(true);
    expect(d.key).toBe('');
    expect(d.mul).toBeUndefined();
  });

  it('only carries the physics pair (no hull/energy/damage/shield factors)', () => {
    const d = decideStatAllocReanchor({ hull: 4, damage: 4 }, '');
    // hull/damage are non-physics — they do NOT scale topSpeed/turnRate here.
    expect(d.mul).toEqual({ topSpeed: 1, turnRate: 1 });
    expect(Object.keys(d.mul!)).toEqual(['topSpeed', 'turnRate']);
  });
});
