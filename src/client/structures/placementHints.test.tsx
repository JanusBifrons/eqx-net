/**
 * The "Can't connect: too close" hint under the placement ghost: shown by a
 * direct DOM write when the preview's only links were refused too short.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { updatePlacementHints, TOO_CLOSE_LINK_TEXT } from './placementHints';

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
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    expect(el.style.left).toBe('200px');
    expect(el.textContent).toBe("Can't connect: too close");
  });

  it('stays hidden when another link forms, and hides again when the ghost moves away', () => {
    updatePlacementHints({ placementPreviewConnectionCount: 1, placementPreviewTooShortCount: 1 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 1 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(false);
    updatePlacementHints({ placementPreviewConnectionCount: 0, placementPreviewTooShortCount: 0 }, 200, 300, 'connector', 0, 0, mirror);
    expect(el.hidden).toBe(true);
  });
});
