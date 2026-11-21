/**
 * S0-3: count the clock anchor's and the render due time's 200 ms hard snaps,
 * so we can tell whether they ever fire on a real link. Mock times only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLOCK_ANCHOR_HARD_SNAP_MS,
  getAnchorHardSnapCount,
  resetAnchorHardSnapCount,
  updateAnchor,
} from '../../src/client/net/clockAnchor.js';
import {
  RENDER_DUE_SLEW_MS,
  RENDER_DUE_SNAP_MS,
  getRenderDueSnapCount,
  resetRenderDueSnapCount,
  slewTickDue,
} from '../../src/client/net/renderTickPhase.js';

const F = 1000 / 60;

describe('clock snap counters', () => {
  beforeEach(() => {
    resetAnchorHardSnapCount();
    resetRenderDueSnapCount();
  });

  it('anchor: a 250 ms drift counts one hard snap', () => {
    updateAnchor({ anchorServerTick: 100, anchorPerfNow: 1000 }, 101, 1000 + F + 250);
    expect(getAnchorHardSnapCount()).toBe(1);
  });

  it('anchor: a 50 ms drift counts none', () => {
    updateAnchor({ anchorServerTick: 100, anchorPerfNow: 1000 }, 101, 1000 + F + 50);
    expect(getAnchorHardSnapCount()).toBe(0);
    expect(CLOCK_ANCHOR_HARD_SNAP_MS).toBe(200);
  });

  it('anchor: reset zeroes the count', () => {
    updateAnchor({ anchorServerTick: 100, anchorPerfNow: 1000 }, 101, 1000 + F - 250);
    expect(getAnchorHardSnapCount()).toBe(1);
    resetAnchorHardSnapCount();
    expect(getAnchorHardSnapCount()).toBe(0);
  });

  it('render due: a 250 ms gap counts one snap', () => {
    slewTickDue(1000, 1000 + F + 250, F, RENDER_DUE_SLEW_MS, RENDER_DUE_SNAP_MS);
    expect(getRenderDueSnapCount()).toBe(1);
  });

  it('render due: a 50 ms gap counts none', () => {
    slewTickDue(1000, 1000 + F + 50, F, RENDER_DUE_SLEW_MS, RENDER_DUE_SNAP_MS);
    expect(getRenderDueSnapCount()).toBe(0);
  });

  it('render due: reset zeroes the count', () => {
    slewTickDue(1000, 1000 + F - 250, F, RENDER_DUE_SLEW_MS, RENDER_DUE_SNAP_MS);
    expect(getRenderDueSnapCount()).toBe(1);
    resetRenderDueSnapCount();
    expect(getRenderDueSnapCount()).toBe(0);
  });
});
