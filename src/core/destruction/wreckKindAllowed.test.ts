import { describe, expect, it } from 'vitest';
import { wreckKindAllowed } from './wreckKindAllowed.js';

describe('wreckKindAllowed', () => {
  it('follows the destruction profile and the room switches', () => {
    expect(wreckKindAllowed('battleship', true, false)).toBe(true);
    expect(wreckKindAllowed('battleship', false, true)).toBe(false);
    expect(wreckKindAllowed('fighter', false, true)).toBe(true);
    expect(wreckKindAllowed('fighter', true, false)).toBe(false);
    // Composite sub-cap keeps its per-component scrap; `none` never wrecks.
    expect(wreckKindAllowed('havok', true, true)).toBe(false);
    expect(wreckKindAllowed('cargo-pod', true, true)).toBe(false);
    expect(wreckKindAllowed('not-a-kind', true, true)).toBe(false);
  });
});
