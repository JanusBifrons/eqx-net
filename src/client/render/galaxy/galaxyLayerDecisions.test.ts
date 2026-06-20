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
import {
  isSectorSelectable,
  isSectorWarpable,
  clusterFitFraction,
  hoverShrinkTargetScale,
  HOVER_SHRINK_SCALE,
} from './galaxyLayerDecisions';
import { isNeighbour } from '@core/galaxy/galaxy';

const SHRINK = HOVER_SHRINK_SCALE; // the layer's tuned shrink target

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

describe('hoverShrinkTargetScale (#1 single-owner gate)', () => {
  // The contiguous-territory hover-shrink "breathes" a region toward its
  // centroid when hovered. But when the whole galaxy is ONE territory (every
  // sector NEUTRAL — the default, no capture mechanics), shrinking the SOLE
  // territory shrinks the entire map under the pointer, which reads as a janky
  // global flinch with nothing to contrast against. The shrink must only engage
  // when there are 2+ territories to differentiate.
  //
  // POSITIONAL SCALAR signature (isActive, territoryCount) — the hot-loop
  // callsite (`GalaxyMapLayer.tick` on `Ticker.shared`) must NOT allocate an
  // object literal per-territory per-frame (invariant #14).
  it('does NOT shrink the active territory when it is the only one', () => {
    expect(hoverShrinkTargetScale(true, 1)).toBe(1);
  });

  it('shrinks the active territory when there are multiple', () => {
    expect(hoverShrinkTargetScale(true, 2)).toBe(SHRINK);
  });

  it('leaves non-active territories at 1.0 even with multiple territories', () => {
    expect(hoverShrinkTargetScale(false, 3)).toBe(1);
  });

  it('does not shrink with zero territories (degenerate guard)', () => {
    expect(hoverShrinkTargetScale(true, 0)).toBe(1);
  });
});

describe('isSectorWarpable (Equinox Phase 7 / Item 1)', () => {
  it('a docked neighbour of the current sector is warpable', () => {
    expect(isNeighbour(CENTRE, OUTER)).toBe(true); // precondition
    expect(isSectorWarpable({ docked: true, currentSectorKey: CENTRE, sectorKey: OUTER })).toBe(true);
  });

  it('the current sector itself is NOT warpable (no self-warp)', () => {
    expect(isSectorWarpable({ docked: true, currentSectorKey: CENTRE, sectorKey: CENTRE })).toBe(false);
  });

  it('nothing is warpable while undocked (mid-warp)', () => {
    expect(isSectorWarpable({ docked: false, currentSectorKey: CENTRE, sectorKey: OUTER })).toBe(false);
  });

  it('nothing is warpable before the current sector is known (the landing map)', () => {
    expect(isSectorWarpable({ docked: true, currentSectorKey: null, sectorKey: OUTER })).toBe(false);
  });
});
