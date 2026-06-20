import { describe, it, expect } from 'vitest';
import {
  STAT_IDS,
  STAT_LABELS,
  toDraft,
  adjustDraft,
  remainingPoints,
  draftToAlloc,
} from './upgradeModalDraft';

/**
 * Phase 4 WS-B2 — pure draft logic for the upgrade modal: the budget-clamped
 * spend/refund + the canonical alloc round-trip. Keeps the modal's branching out
 * of React (Phase-A3 rule) and guarantees the UI never offers a spend the server
 * (the authority) would silently drop.
 */

describe('upgradeModalDraft — toDraft', () => {
  it('normalises a partial wire alloc into a full per-stat draft (0 where unspent)', () => {
    const d = toDraft({ hull: 2, topSpeed: 1 });
    expect(d.hull).toBe(2);
    expect(d.topSpeed).toBe(1);
    expect(d.energy).toBe(0);
    expect(d.shield).toBe(0);
  });

  it('treats undefined / garbage entries as 0', () => {
    expect(toDraft(undefined).hull).toBe(0);
    expect(toDraft({ hull: -3 } as never).hull).toBe(0);
  });
});

describe('upgradeModalDraft — remainingPoints', () => {
  it('budget minus spend, never negative', () => {
    expect(remainingPoints(toDraft({}), 5)).toBe(4); // budget 4, spent 0
    expect(remainingPoints(toDraft({ hull: 4 }), 5)).toBe(0); // fully spent
    expect(remainingPoints(toDraft({ hull: 4 }), 1)).toBe(0); // budget 0, clamped ≥ 0
  });
});

describe('upgradeModalDraft — adjustDraft (budget-clamped)', () => {
  it('increments a stat within budget', () => {
    const d = adjustDraft(toDraft({}), 'hull', +1, 5);
    expect(d.hull).toBe(1);
  });

  it('REFUSES an increment that would exceed the budget (no change)', () => {
    const start = toDraft({ hull: 2, topSpeed: 2 }); // 4 / 4 spent at level 5
    const d = adjustDraft(start, 'damage', +1, 5);
    expect(d).toBe(start); // same reference — no-op
  });

  it('decrements but never below 0', () => {
    expect(adjustDraft(toDraft({ hull: 1 }), 'hull', -1, 5).hull).toBe(0);
    const z = toDraft({});
    expect(adjustDraft(z, 'hull', -1, 5)).toBe(z); // already 0 → no-op
  });

  it('re-distributing within budget is allowed (drop one, add another)', () => {
    let d = toDraft({ hull: 4 }); // 4 / 4 at level 5
    d = adjustDraft(d, 'hull', -1, 5); // free a point
    d = adjustDraft(d, 'topSpeed', +1, 5); // spend it elsewhere
    expect(d.hull).toBe(3);
    expect(d.topSpeed).toBe(1);
    expect(remainingPoints(d, 5)).toBe(0);
  });
});

describe('upgradeModalDraft — draftToAlloc', () => {
  it('strips zeros so the wire alloc only carries spent stats', () => {
    expect(draftToAlloc(toDraft({ hull: 2 }))).toEqual({ hull: 2 });
    expect(draftToAlloc(toDraft({}))).toEqual({});
  });
});

describe('upgradeModalDraft — labels + order', () => {
  it('every stat id has a label', () => {
    for (const id of STAT_IDS) expect(typeof STAT_LABELS[id]).toBe('string');
  });
});
