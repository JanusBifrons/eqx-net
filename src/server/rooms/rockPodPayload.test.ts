/**
 * A rock's ore pod carries a pod-sized payload (barge-mining stills
 * 2026-11-15): a sliver's area share of a big rock's ore pool put 10,000 to
 * 26,000 weight in one pod, too heavy to haul and nothing like any other
 * pod. A rock pod now carries at most what a salvage-field pod can
 * (`SALVAGE_POD_MAX_WEIGHT`); a small share stays as it is, and cutting
 * never makes ore (the pod never exceeds its piece's share).
 */
import { describe, expect, it } from 'vitest';
import { dropPieceSalvage } from './wreckResplit.js';
import { rockWreckSource, shipWreckSource } from '../../core/destruction/wreckSource.js';
import { asteroidYield, type AsteroidResourceId } from '../../shared-types/asteroidResources.js';
import { holdWeight } from '../../core/cargo/hold.js';
import { SALVAGE_POD_MAX_WEIGHT } from '../../shared-types/worldEvents.js';
import type { CapitalWreckDeps } from './capitalWreckTypes.js';

function podUnits(area: number, perArea: number, resource: AsteroidResourceId): number {
  let qty = -1;
  const d = { dropSalvage: (q: number) => { qty = q; } } as unknown as CapitalWreckDeps;
  const src = rockWreckSource({ id: 'rock-1', shape: 7, r: 300 });
  dropPieceSalvage(d, src, { rockId: 'rock-1', resource, perArea }, area, 1, 0, 0, 0, 0);
  return qty;
}

describe('a rock pod carries a pod-sized payload', () => {
  for (const resource of ['rock', 'ice', 'crystal'] as const) {
    it(`a big ${resource} sliver's pod weighs no more than a salvage-field pod`, () => {
      // A 6 % sliver of a 300 u rock at the default 40 ore per u².
      const units = podUnits(0.06 * Math.PI * 300 * 300, 40, resource);
      const w = holdWeight({ goods: asteroidYield(resource, units), blueprints: [] });
      expect(w).toBeGreaterThan(0);
      expect(w, `${units} units of ${resource}`).toBeLessThanOrEqual(SALVAGE_POD_MAX_WEIGHT);
    });
  }

  it('a small share is paid as it is (never more than the piece held)', () => {
    expect(podUnits(10, 2, 'rock')).toBe(20);
  });

  it('a mined-out rock sliver drops no ore pod (no ore left to pay)', () => {
    expect(podUnits(500, 0, 'rock'), 'exhausted rock: nothing dropped').toBe(-1);
    expect(podUnits(0.1, 0.5, 'rock'), 'under one unit: nothing dropped').toBe(-1);
    expect(podUnits(2, 0.5, 'rock'), 'one whole unit is paid').toBe(1);
  });

  it('a ship wreck sliver still drops its salvage', () => {
    let qty = -1;
    const d = { dropSalvage: (q: number) => { qty = q; } } as unknown as CapitalWreckDeps;
    dropPieceSalvage(d, shipWreckSource('fighter'), undefined, 1, 1, 0, 0, 0, 0);
    expect(qty).toBeGreaterThanOrEqual(1);
  });
});
