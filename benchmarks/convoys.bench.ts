/**
 * Convoy planning cost (plan soft-leaping-truffle v3, phase T budget: a
 * planning pass ≤ 2 ms, run every 15 s by the ConvoyDirector). Worst case:
 * every NPC base in today's galaxy starved of every input with every output
 * piled up (`convoyGalaxyFixture.ts`). Module-level setup only (vitest 2.1
 * bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import { matchConvoys } from '../src/core/economy/convoys.js';
import { hopDistance } from '../src/server/livingworld/population.js';
import { DEFAULT_CONVOY_OPTIONS } from '../src/server/economy/ConvoyDirector.js';
import { galaxyConvoyViews } from './convoyGalaxyFixture.js';

const VIEWS = galaxyConvoyViews();

describe('Convoy planning — whole galaxy, worst case', () => {
  bench(`matchConvoys over ${VIEWS.length} NPC bases`, () => {
    matchConvoys(VIEWS, {
      haulerCapacity: DEFAULT_CONVOY_OPTIONS.haulerCapacity,
      maxConvoys: DEFAULT_CONVOY_OPTIONS.maxActive,
      hops: hopDistance,
    });
  });
});
