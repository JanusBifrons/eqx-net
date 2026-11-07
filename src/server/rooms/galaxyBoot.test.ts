import { describe, expect, it } from 'vitest';
import { galaxySectorsToBoot } from './galaxyBoot';

describe('galaxySectorsToBoot (EQX_GALAXY_SECTORS)', () => {
  const all = ['sol-prime', 'vega-reach', 'lyra-fringe'];
  it('boots every sector by default', () => {
    expect(galaxySectorsToBoot(all, {})).toEqual(all);
    expect(galaxySectorsToBoot(all, { EQX_GALAXY_SECTORS: '' })).toEqual(all);
  });
  it('boots none for a test-room-only server', () => {
    expect(galaxySectorsToBoot(all, { EQX_GALAXY_SECTORS: 'none' })).toEqual([]);
  });
  it('boots a listed subset, in galaxy order, ignoring unknown keys', () => {
    expect(galaxySectorsToBoot(all, { EQX_GALAXY_SECTORS: 'lyra-fringe, sol-prime,nope' })).toEqual(['sol-prime', 'lyra-fringe']);
  });
});
