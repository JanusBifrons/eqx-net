import { describe, it, expect } from 'vitest';

// Phase 0 baseline: proves the vitest pipeline runs. Replaced by real core
// tests in Phase 1 (physics, event bus) and beyond.
describe('Phase 0 smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
