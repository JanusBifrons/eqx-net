import { describe, it, expect } from 'vitest';
import { isBuildAwaitingClear } from './buildAwaitingClear.js';

describe('isBuildAwaitingClear', () => {
  it('is true only for a finished build that is still a blueprint', () => {
    expect(isBuildAwaitingClear({ built: false, buildPct: 1 })).toBe(true);
    expect(isBuildAwaitingClear({ built: false, buildPct: 0.99 })).toBe(false);
    expect(isBuildAwaitingClear({ built: true, buildPct: 1 })).toBe(false);
  });

  it('is false while the structure is being taken down', () => {
    expect(isBuildAwaitingClear({ built: false, buildPct: 1, isDeconstructing: true })).toBe(false);
  });
});
