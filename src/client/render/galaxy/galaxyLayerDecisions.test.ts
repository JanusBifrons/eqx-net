/**
 * Locks the GalaxyMapLayer mode-selectability contract (single-canvas
 * refactor, 2026-06-05). The one shared galaxy layer must behave as:
 *  - `selector` (spawn/warp picker): EVERY sector tappable.
 *  - `overlay`  (in-game Map-B HUD): only docked neighbours of the
 *    current sector tappable.
 * A regression here is "the spawn picker stops letting you pick a
 * sector" or "the in-game overlay lets you warp to a non-neighbour."
 */
import { describe, it, expect } from 'vitest';
import { isSectorSelectable, clusterFitFraction } from './galaxyLayerDecisions';
import { isNeighbour } from '@core/galaxy/galaxy';

// Concrete galaxy facts: sol-prime (the core hub) is graph-adjacent to
// vega-reach; no sector neighbours itself (no self-loop — enforced by
// galaxy.test.ts). Uses a real adjacency so the selectability contract is
// exercised against the live multi-region graph.
const CENTRE = 'sol-prime';
const OUTER = 'vega-reach';

describe('isSectorSelectable', () => {
  it('selector mode: every sector is selectable, regardless of dock/current', () => {
    for (const docked of [true, false]) {
      for (const current of [CENTRE, null]) {
        expect(
          isSectorSelectable({ mode: 'selector', docked, currentSectorKey: current, sectorKey: OUTER }),
        ).toBe(true);
        // even the current sector itself is pickable at spawn
        expect(
          isSectorSelectable({ mode: 'selector', docked, currentSectorKey: current, sectorKey: CENTRE }),
        ).toBe(true);
      }
    }
  });

  it('overlay mode: a docked neighbour of the current sector is selectable', () => {
    expect(isNeighbour(CENTRE, OUTER)).toBe(true); // precondition
    expect(
      isSectorSelectable({ mode: 'overlay', docked: true, currentSectorKey: CENTRE, sectorKey: OUTER }),
    ).toBe(true);
  });

  it('overlay mode: the current sector itself is NOT selectable (no self-warp)', () => {
    expect(
      isSectorSelectable({ mode: 'overlay', docked: true, currentSectorKey: CENTRE, sectorKey: CENTRE }),
    ).toBe(false);
  });

  it('overlay mode: nothing is selectable while undocked (mid-warp)', () => {
    expect(
      isSectorSelectable({ mode: 'overlay', docked: false, currentSectorKey: CENTRE, sectorKey: OUTER }),
    ).toBe(false);
  });

  it('overlay mode: nothing is selectable before the current sector is known', () => {
    expect(
      isSectorSelectable({ mode: 'overlay', docked: true, currentSectorKey: null, sectorKey: OUTER }),
    ).toBe(false);
  });
});

describe('clusterFitFraction', () => {
  it('selector fills more of the viewport than the overlay HUD', () => {
    expect(clusterFitFraction('selector')).toBeGreaterThan(clusterFitFraction('overlay'));
  });
});
