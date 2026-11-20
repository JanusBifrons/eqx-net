/**
 * The "Can't connect: too close" hint under the placement ghost: shown by a
 * direct DOM write when the preview's only links were refused too short.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { belowGhostPx, updatePlacementHints, TOO_CLOSE_LINK_TEXT } from './placementHints';

const mirror = { structures: new Map(), swarm: new Map() };

describe('updatePlacementHints: too-close link hint', () => {
  let el: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    el = document.createElement('div');
    el.dataset.testid = 'placement-link-hint';
    el.textContent = TOO_CLOSE_LINK_TEXT;
    el.hidden = true;
    document.body.appendChild(el);
  });

  it('shows under the ghost when a link is too short and none forms', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('200px');
    expect(el.textContent).toBe("Can't connect: too close");
  });

  it('stays hidden when another link forms, and hides again when the ghost moves away', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 1, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 0, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
  });

  it('says why the ghost cannot go there (the server notice), over "too close"', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: 'overlap-obstacle', viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Can't build here: blocked by an asteroid or wreck");
    // Moved clear: back to the too-close line, then hidden.
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.textContent).toBe(TOO_CLOSE_LINK_TEXT);
    updatePlacementHints({ placementPreviewConnectionCount: 1, placementPreviewTooShortCount: 0, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
  });

  it('leaves a docked hint (touch: under the top-centre banner) where it is', () => {
    el.dataset.docked = '1';
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1, placementPreviewRejection: null, viewHalf: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('');
    expect(el.style.top).toBe('');
  });

  it('sits just below the ghost edge at any zoom (a 1000 u dock at 2 px per unit)', () => {
    // 1280-wide window showing 640 u each side of centre: 1 px per unit; viewHalf 320: 2 px per unit.
    expect(belowGhostPx('freight_dock', 640, 1280, 800)).toBeCloseTo(500 + 10);
    expect(belowGhostPx('freight_dock', 320, 1280, 800)).toBeCloseTo(1000 + 10);
    expect(belowGhostPx('battery', 0, 1280, 800)).toBe(10);
  });
});
