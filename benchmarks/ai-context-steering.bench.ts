/**
 * Context steering (src/core/ai/contextSteering.ts) — one agent's per-tick
 * cost: clear, ~10 writers over 16 slots, resolve. Budget intent: well under
 * 1 µs so 80 bots stay negligible against the 16.67 ms tick.
 *
 * Module-level setup only (vitest 2.1 bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import {
  addDangerFromPoint,
  addDangerFromSegment,
  addInterestToward,
  clearContextMaps,
  createContextMaps,
  makeContextOutput,
  resolveContext,
} from '../src/core/ai/contextSteering.js';

const MAPS = createContextMaps();
const OUT = makeContextOutput();

describe('context steering — one agent tick', () => {
  bench('clear + 1 interest + 6 point dangers + 3 lanes + resolve', () => {
    clearContextMaps(MAPS);
    addInterestToward(MAPS, 0.3, 1, 1, 2);
    for (let k = 0; k < 6; k++) addDangerFromPoint(MAPS, k - 3, 1, 40 + k * 20, 30, 80, 1);
    for (let k = 0; k < 3; k++) addDangerFromSegment(MAPS, 50, 100, -200 + k * 100, 0, 0, 900, 20, 300, 1);
    resolveContext(MAPS, OUT);
  });
});
