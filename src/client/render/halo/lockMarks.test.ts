/**
 * Lock marks on the edge radar: an off-screen contact locking the local ship
 * tints threat red; one of the pilot's own LOCKED targets tints its group colour.
 */
import { describe, it, expect } from 'vitest';
import { radarLockTint, LOCK_TINT_NONE } from './lockMarks.js';
import { groupColour, THREAT_COLOUR } from '../../hud/groupColours.js';

const groups = [
  { id: 'g0', m: 0, l: [{ t: 's:5', s: 2, p: 100 }, { t: 's:6', s: 1, p: 40 }] },
  { id: 'g1', m: 0, l: [{ t: 'p:bob', s: 2, p: 100 }] },
];

describe('radarLockTint', () => {
  it('no locks → none', () => {
    expect(radarLockTint('s:5', undefined, undefined)).toBe(LOCK_TINT_NONE);
    expect(radarLockTint('s:5', [], [])).toBe(LOCK_TINT_NONE);
  });

  it('own LOCKED target → its group colour (by group index)', () => {
    expect(radarLockTint('s:5', groups, undefined)).toBe(groupColour(0));
    expect(radarLockTint('p:bob', groups, undefined)).toBe(groupColour(1));
  });

  it('own lock still acquiring / failsafe → no mark', () => {
    expect(radarLockTint('s:6', groups, undefined)).toBe(LOCK_TINT_NONE);
    expect(radarLockTint('s:6', [{ id: 'g', m: 0, l: [{ t: 's:6', s: 0, p: 10 }] }], undefined)).toBe(LOCK_TINT_NONE);
  });

  it('a contact locking you (acquiring or locked) → threat red', () => {
    expect(radarLockTint('s:9', undefined, [{ t: 's:9', s: 1, p: 30 }])).toBe(THREAT_COLOUR);
    expect(radarLockTint('s:9', undefined, [{ t: 's:9', s: 2, p: 100 }])).toBe(THREAT_COLOUR);
  });

  it('threat wins over your own lock on the same contact', () => {
    expect(radarLockTint('s:5', groups, [{ t: 's:5', s: 2, p: 100 }])).toBe(THREAT_COLOUR);
  });

  it('capped rows (owner 2026-11-14): only the listed lockers tint; one off the list stays its category colour', () => {
    // The server lists the 8 nearest lockers of 20 (the total rides `lockedByN`).
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((e) => ({ t: `s:${e}`, s: 2, p: 100 }));
    for (const r of rows) expect(radarLockTint(r.t, undefined, rows)).toBe(THREAT_COLOUR);
    expect(radarLockTint('s:15', undefined, rows)).toBe(LOCK_TINT_NONE);
  });

  it('unrelated contact → none', () => {
    expect(radarLockTint('s:7', groups, [{ t: 's:9', s: 2, p: 100 }])).toBe(LOCK_TINT_NONE);
  });
});
