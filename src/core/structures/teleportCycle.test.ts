import { describe, expect, it } from 'vitest';
import { armCycle, rulesSayFire, stepCycle, type CycleState } from './teleportCycle.js';
import { DEFAULT_TELEPORT_RULES, SHIP_BOARD_DWELL_MS, TP_PHASE, TP_PHASE_MS, jumpCharge, jumpDistance, TELEPORT_HOP_DISTANCE_U } from '../../shared-types/teleport.js';

describe('teleport cycle', () => {
  it('runs armed → closing → sealed → swap → open → idle, swapping exactly once', () => {
    const s: CycleState = { phase: TP_PHASE.IDLE, phaseEndsAtMs: 0 };
    armCycle(s, 0);
    expect(s.phase).toBe(TP_PHASE.ARMED);
    const events: Array<string | null> = [];
    let t = 0;
    for (const p of [1, 2, 3, 4] as const) {
      t += TP_PHASE_MS[p];
      events.push(stepCycle(s, t - 1)); // not yet
      events.push(stepCycle(s, t));
    }
    expect(events.filter((e) => e === 'swap')).toHaveLength(1);
    expect(events[events.length - 1]).toBe('done');
    expect(s.phase).toBe(TP_PHASE.IDLE);
  });

  it('scales for tests, and a long gap advances one phase per step (never skips the swap)', () => {
    const s: CycleState = { phase: TP_PHASE.IDLE, phaseEndsAtMs: 0 };
    armCycle(s, 0, 0.01);
    expect(s.phaseEndsAtMs).toBe(TP_PHASE_MS[1] * 0.01);
    const seen: Array<string | null> = [];
    for (let i = 1; i <= 6; i++) seen.push(stepCycle(s, i * 1_000_000, 0.01));
    expect(seen).toContain('swap');
    expect(s.phase).toBe(TP_PHASE.IDLE);
  });
});

describe('firing rules', () => {
  const base = { charged: true, boardedForMs: 0, padGoods: {}, padWeight: 0 };
  it('never fires uncharged; manual-only rules never fire on their own', () => {
    expect(rulesSayFire({ ...DEFAULT_TELEPORT_RULES, whenCharged: true }, { ...base, charged: false })).toBe(false);
    expect(rulesSayFire(DEFAULT_TELEPORT_RULES, base)).toBe(false);
  });
  it('when charged / when a ship boards / when loaded', () => {
    expect(rulesSayFire({ ...DEFAULT_TELEPORT_RULES, whenCharged: true }, base)).toBe(true);
    const boards = { ...DEFAULT_TELEPORT_RULES, shipBoards: true };
    expect(rulesSayFire(boards, { ...base, boardedForMs: SHIP_BOARD_DWELL_MS - 1 })).toBe(false);
    expect(rulesSayFire(boards, { ...base, boardedForMs: SHIP_BOARD_DWELL_MS })).toBe(true);
    const alloy = { ...DEFAULT_TELEPORT_RULES, loaded: { good: 'alloy' as const, qty: 10 } };
    expect(rulesSayFire(alloy, { ...base, padGoods: { alloy: 9 } })).toBe(false);
    expect(rulesSayFire(alloy, { ...base, padGoods: { alloy: 10 } })).toBe(true);
    const weight = { ...DEFAULT_TELEPORT_RULES, loaded: { good: null, qty: 50 } };
    expect(rulesSayFire(weight, { ...base, padWeight: 50 })).toBe(true);
  });
});

describe('jump charge depends only on distance', () => {
  it('grows with distance; a hop counts as a fixed distance', () => {
    expect(jumpCharge(0)).toBeGreaterThan(0);
    expect(jumpCharge(5000)).toBeGreaterThan(jumpCharge(1000));
    expect(jumpDistance(0, 0, 0, 3000, 4000)).toBe(5000);
    expect(jumpDistance(2, 0, 0, 3000, 4000)).toBe(2 * TELEPORT_HOP_DISTANCE_U);
  });
});
