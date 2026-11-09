import { describe, it, expect } from 'vitest';
import { SHOTS } from '../../showcase/registry';
import { PROFILE_ORDER } from '../../showcase/types';

describe('showcase profiles', () => {
  it('every shot uses a profile the runner records (else it is silently skipped)', () => {
    const missing = SHOTS.filter((s) => !PROFILE_ORDER.includes(s.server)).map((s) => `${s.id} (${s.server})`);
    expect(missing).toEqual([]);
  });
});
