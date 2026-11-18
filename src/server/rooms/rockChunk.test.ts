/**
 * Mined rock never becomes a pod (owner 2026-11-17): a cut rock piece goes
 * into the hold whole as one heavy chunk, and its hidden ore grows with the
 * chunk's weight squared (`OreDraw.chunkYield`). A ship's wreck sliver still
 * drops its salvage pod.
 */
import { describe, expect, it } from 'vitest';
import { dropPieceSalvage } from './wreckResplit.js';
import { rockWreckSource, shipWreckSource } from '../../core/destruction/wreckSource.js';
import { ROCK_CHUNK_MIN_WEIGHT } from '../../core/combat/salvageTargeting.js';
import type { CapitalWreckDeps } from './capitalWreckTypes.js';

function dropped(ore: Parameters<typeof dropPieceSalvage>[2], fighter = false): number {
  let qty = -1;
  const d = { dropSalvage: (q: number) => { qty = q; return 'pod-1'; } } as unknown as CapitalWreckDeps;
  const src = fighter ? shipWreckSource('fighter') : rockWreckSource({ id: 'rock-1', shape: 7, r: 300 });
  dropPieceSalvage(d, src, ore, 1, 0, 0, 0, 0);
  return qty;
}

describe('a rock piece is a chunk, never a pod', () => {
  it('a worn rock sliver drops no pod', () => {
    expect(dropped({ rockId: 'rock-1', resource: 'rock', perArea: 40 })).toBe(-1);
  });

  it('a ship wreck sliver still drops its salvage', () => {
    expect(dropped(undefined, true)).toBeGreaterThanOrEqual(1);
  });
});

// OreDraw.ts pulls in the DB worker (node:sqlite), so the unit layer pins
// the curve constant; OreDraw.chunkYield is covered in the oreDraw
// integration test.
const ROCK_CHUNK_ORE_PER_WEIGHT_SQ = 0.08;

describe('chunk ore: very steep in the chunk weight', () => {
  const units = (w: number): number => Math.floor(ROCK_CHUNK_ORE_PER_WEIGHT_SQ * w * w);

  it('the smallest chunk holds about 5,000 units; a 4,000 one 1.28 million', () => {
    expect(units(ROCK_CHUNK_MIN_WEIGHT)).toBe(5_000);
    expect(units(1_000)).toBe(80_000);
    expect(units(4_000)).toBe(1_280_000);
  });
});
