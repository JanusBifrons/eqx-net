import { describe, expect, it } from 'vitest';
import { armCycle, rulesSayFire, stepCycle, trackBoarding, type BoardingState, type CycleState } from './teleportCycle.js';
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

describe('chamber doors gate CLOSING (redesign T2)', () => {
  const closing = (): CycleState => ({ phase: TP_PHASE.CLOSING, phaseEndsAtMs: 100 });
  it('waits past the timer until both pads are shut, then seals', () => {
    const s = closing();
    expect(stepCycle(s, 10_000, 1, { shut: false, stalled: false })).toBeNull();
    expect(s.phase).toBe(TP_PHASE.CLOSING);
    expect(stepCycle(s, 10_001, 1, { shut: true, stalled: false })).toBeNull();
    expect(s.phase).toBe(TP_PHASE.SEALED);
    expect(s.phaseEndsAtMs).toBe(10_001 + TP_PHASE_MS[3]);
  });
  it('seals early when the doors shut before the nominal time', () => {
    const s = closing();
    stepCycle(s, 5, 1, { shut: true, stalled: false });
    expect(s.phase).toBe(TP_PHASE.SEALED);
  });
  it('a stalled (unpowered) pad cancels: straight to OPEN, no swap', () => {
    const s = closing();
    expect(stepCycle(s, 50, 1, { shut: false, stalled: true })).toBe('cancel');
    expect(s.phase).toBe(TP_PHASE.OPEN);
    expect(s.phaseEndsAtMs).toBe(50 + TP_PHASE_MS[4]);
  });
  it('without doors, CLOSING ends on its timer as before', () => {
    const s = closing();
    expect(stepCycle(s, 99)).toBeNull();
    expect(s.phase).toBe(TP_PHASE.CLOSING);
    stepCycle(s, 100);
    expect(s.phase).toBe(TP_PHASE.SEALED);
  });
  it('doors are ignored outside CLOSING', () => {
    const s: CycleState = { phase: TP_PHASE.SEALED, phaseEndsAtMs: 100 };
    expect(stepCycle(s, 100, 1, { shut: false, stalled: true })).toBe('swap');
  });
});

describe('trackBoarding (when a ship boards)', () => {
  it('a ship flying onto an idle pad starts the clock; leaving clears it', () => {
    const s: BoardingState = {};
    trackBoarding(s, 1, false, 100);
    expect(s.tpBoardedSinceMs).toBe(100);
    trackBoarding(s, 1, false, 200);
    expect(s.tpBoardedSinceMs).toBe(100);
    trackBoarding(s, 0, false, 300);
    expect(s.tpBoardedSinceMs).toBeUndefined();
  });

  it('ships on the pad through a cycle (arrivals) are not boarders', () => {
    const s: BoardingState = { tpBoardedSinceMs: 50 };
    trackBoarding(s, 1, true, 100); // mid-cycle: the arrival is a rider
    expect(s.tpBoardedSinceMs).toBeUndefined();
    trackBoarding(s, 1, false, 200); // idle again, the arrival sits there
    trackBoarding(s, 1, false, 200 + SHIP_BOARD_DWELL_MS * 2);
    expect(s.tpBoardedSinceMs).toBeUndefined();
  });

  it('a new ship flying on beside an arrival boards; once the arrival leaves, a re-entry boards', () => {
    const s: BoardingState = {};
    trackBoarding(s, 1, true, 0);
    trackBoarding(s, 2, false, 100);
    expect(s.tpBoardedSinceMs).toBe(100);
    const t: BoardingState = {};
    trackBoarding(t, 1, true, 0);
    trackBoarding(t, 0, false, 100); // the arrival flew off
    expect(t.tpAboardAfterCycle).toBeUndefined();
    trackBoarding(t, 1, false, 200); // and came back: that is boarding
    expect(t.tpBoardedSinceMs).toBe(200);
  });
});
