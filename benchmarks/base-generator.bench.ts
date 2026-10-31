/**
 * Generator wall time (plan: soft-leaping-truffle; budget GENERATE_MS_MAX =
 * 50 ms for one max-size base, desktop). The generator runs once at room
 * create (server) and once per join / chunk stream on the client worker —
 * never per tick — but a slow generator stalls a join, so it is budgeted.
 */
import { bench, describe } from 'vitest';
import { generateBase } from '../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../src/core/procgen/baseLayout.js';
import { SHOWCASE_BASE_MAX_SIZE } from '../src/shared-types/baseBudgets.js';

let seed = 1;
describe('base generator', () => {
  bench(`warehouse ${SHOWCASE_BASE_MAX_SIZE} u (generate + validate, incl. re-seeds)`, () => {
    generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: seed++, x: 0, y: 0, size: SHOWCASE_BASE_MAX_SIZE });
  });
});
