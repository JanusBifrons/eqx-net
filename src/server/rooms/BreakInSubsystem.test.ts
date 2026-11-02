import { describe, expect, it } from 'vitest';
import { BreakInSubsystem } from './BreakInSubsystem.js';
import { BREAK_IN_ACCESS_MS, BREAK_IN_BASE_MS, BREAK_IN_MAX_MS, breakInDurationMs } from '../../shared-types/breakIn.js';

function setup() {
  const clock = { t: 0 };
  const state = { inRange: true, exists: true };
  const events: string[] = [];
  const b = new BreakInSubsystem({
    now: () => clock.t,
    canContinue: () => state.inRange,
    exists: () => state.exists,
    onStart: (a, s) => events.push(`start ${a} ${s}`),
    onEnd: (a, s, o, r) => events.push(`${o} ${a} ${s} ${r}`),
  });
  return { b, clock, state, events };
}

describe('break-in rules (C2)', () => {
  it('bigger and higher-level storage takes longer, within limits', () => {
    expect(breakInDurationMs(0, 1)).toBe(BREAK_IN_BASE_MS);
    expect(breakInDurationMs(5000, 1)).toBeGreaterThan(breakInDurationMs(2000, 1));
    expect(breakInDurationMs(2000, 3)).toBeGreaterThan(breakInDurationMs(2000, 1));
    expect(breakInDurationMs(1e9, 5)).toBe(BREAK_IN_MAX_MS);
  });
});

describe('BreakInSubsystem (C2)', () => {
  it('succeeds after its duration and grants access for a window', () => {
    const { b, clock, events } = setup();
    b.start('thief', 's1', 1000);
    expect(events).toEqual(['start thief s1']);
    expect(b.breached('s1')).toBe(true);
    clock.t = 500; b.tick();
    expect(b.progress('thief', 's1')).toBeCloseTo(0.5, 6);
    expect(b.hasGrant('thief', 's1')).toBe(false);
    clock.t = 1000; b.tick();
    expect(events.at(-1)).toBe('success thief s1 You are in.');
    expect(b.breached('s1')).toBe(false);
    expect(b.hasGrant('thief', 's1')).toBe(true);
    clock.t = 1000 + BREAK_IN_ACCESS_MS; b.tick();
    expect(b.hasGrant('thief', 's1')).toBe(false);
  });

  it('a hit, leaving range, or the target vanishing interrupts it (no access)', () => {
    const { b, clock, state, events } = setup();
    b.start('thief', 's1', 1000);
    b.onActorDamaged('thief');
    expect(events.at(-1)).toBe('interrupted thief s1 You were hit.');
    b.start('thief', 's1', 1000);
    state.inRange = false; clock.t = 100; b.tick();
    expect(events.at(-1)).toBe('interrupted thief s1 You moved away.');
    state.inRange = true;
    b.start('thief', 's1', 1000);
    state.exists = false; clock.t = 200; b.tick();
    expect(events.at(-1)).toBe('interrupted thief s1 It is gone.');
    expect(b.hasGrant('thief', 's1')).toBe(false);
    expect(b.activeCount()).toBe(0);
  });

  it('a hit on someone not breaking in is ignored', () => {
    const { b, events } = setup();
    b.onActorDamaged('bystander');
    expect(events).toEqual([]);
  });
});
