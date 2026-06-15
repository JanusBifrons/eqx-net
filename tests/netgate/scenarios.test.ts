/**
 * Lock for the netgate scenario resolver (plan: misty-teapot). The CSV →
 * descriptor mapping is load-bearing: a silent miss would run the WRONG
 * scenario set (a fail-open gate). So `resolveScenarios` must throw loudly
 * on an unknown name and default to `core`.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, resolveScenarios } from './scenarios';

describe('resolveScenarios', () => {
  it('empty / whitespace CSV ⇒ defaults to core', () => {
    expect(resolveScenarios('').map((s) => s.name)).toEqual(['core']);
    expect(resolveScenarios('   ').map((s) => s.name)).toEqual(['core']);
  });

  it('resolves a known name', () => {
    expect(resolveScenarios('core').map((s) => s.name)).toEqual(['core']);
  });

  it('dedups and preserves catalogue order', () => {
    const names = resolveScenarios('core,core').map((s) => s.name);
    expect(names).toEqual(['core']);
  });

  it('throws LOUDLY on an unknown name (a typo must fail, never silently skip)', () => {
    expect(() => resolveScenarios('core,bogus')).toThrow(/unknown scenario 'bogus'/);
  });

  it('every catalogue scenario has the required descriptor fields', () => {
    for (const s of SCENARIOS) {
      expect(s.name).toBeTruthy();
      expect(s.room).toBeTruthy();
      expect(s.liveSelector).toBeTruthy();
      expect(['gate', 'print-only']).toContain(s.gating);
      expect(s.triggerGlobs.length).toBeGreaterThan(0);
    }
  });

  it('core is gated and points at the historical feel-test-25 room', () => {
    const core = SCENARIOS.find((s) => s.name === 'core');
    expect(core?.room).toBe('feel-test-25');
    expect(core?.gating).toBe('gate');
    expect(core?.urlParams).toBe('');
  });
});
