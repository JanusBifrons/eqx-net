/**
 * Mined rock never becomes a pod (owner 2026-11-17): a cut rock piece goes
 * into the hold whole as one heavy chunk, carrying its share by weight of
 * the rock's ore (`OreDraw.chunkYield`; the share is locked in
 * rockFloor.test.ts). A ship's wreck sliver still drops its salvage pod.
 */
import { describe, expect, it } from 'vitest';
import { dropPieceSalvage } from './wreckResplit.js';
import { rockWreckSource, shipWreckSource } from '../../core/destruction/wreckSource.js';
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
