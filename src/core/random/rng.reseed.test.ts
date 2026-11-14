import { describe, expect, it } from 'vitest';
import { Rng } from './rng.js';

describe('Rng.reseed', () => {
  it('replays exactly the stream of a fresh Rng with that seed', () => {
    const reused = new Rng(1);
    reused.u32();
    for (const seed of [0, 1, 42, 0xdeadbeef]) {
      const fresh = new Rng(seed);
      reused.reseed(seed);
      for (let i = 0; i < 5; i++) expect(reused.u32()).toBe(fresh.u32());
    }
  });
});
