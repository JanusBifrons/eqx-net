import { describe, it, expect } from 'vitest';
import { assertRoomSeedBounds, MAX_SEED_ENTRIES } from './roomSeedBounds.js';

const pose = { kind: 'fighter', x: 0, y: 0 };

describe('assertRoomSeedBounds (S5)', () => {
  it('accepts empty / absent seed arrays', () => {
    expect(() => assertRoomSeedBounds({})).not.toThrow();
    expect(() => assertRoomSeedBounds({ dronePoses: [] })).not.toThrow();
  });

  it('accepts arrays exactly at the cap', () => {
    const atCap = Array.from({ length: MAX_SEED_ENTRIES }, () => pose);
    expect(() => assertRoomSeedBounds({ dronePoses: atCap })).not.toThrow();
  });

  it('rejects an array one over the cap', () => {
    const overCap = Array.from({ length: MAX_SEED_ENTRIES + 1 }, () => pose);
    expect(() => assertRoomSeedBounds({ dronePoses: overCap })).toThrow(/payload-DoS guard/);
  });

  it('names the offending field in the error', () => {
    const overCap = Array.from({ length: MAX_SEED_ENTRIES + 1 }, () => ({ x: 0, y: 0 }));
    expect(() => assertRoomSeedBounds({ scenarioAsteroids: overCap })).toThrow(/scenarioAsteroids/);
  });

  it('bounds every seed-array field, not just dronePoses', () => {
    for (const field of ['structurePoses', 'prebuiltStructures', 'scenarioDrones', 'droneKinds']) {
      const overCap = Array.from({ length: MAX_SEED_ENTRIES + 1 }, () => pose);
      expect(() => assertRoomSeedBounds({ [field]: overCap })).toThrow();
    }
  });

  it('ignores non-array values on a seed field (cast garbage)', () => {
    expect(() => assertRoomSeedBounds({ dronePoses: 'not-an-array' })).not.toThrow();
  });
});
