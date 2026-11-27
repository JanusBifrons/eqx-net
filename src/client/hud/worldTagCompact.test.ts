/**
 * Selection HUD S10: the world tag's compact switch. It reuses the far-zoom
 * icon rule (`isIconOnly`, enter below `solidPx`, leave above
 * `solidPx × hysteresis`) on the focus's on-screen diameter, and flips the
 * tag root's `data-compact` on change only.
 */
import { describe, expect, it } from 'vitest';
import { FAR_ICON } from '../render/farIconRule.js';
import { setWorldTagAnchor, setWorldTagElement, updateWorldTag, worldTagCompact, worldTagCompactDiam } from './worldTag.js';

/** A fake tag wrapper whose `[data-world-tag]` root counts data-compact writes. */
function tagEl() {
  const writes: string[] = [];
  const root = { setAttribute: (k: string, v: string) => { writes.push(`${k}=${v}`); } };
  const el = {
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    offsetWidth: 80,
    offsetHeight: 30,
    querySelector: (sel: string) => (sel === '[data-world-tag]' ? root : null),
  };
  return { el: el as unknown as HTMLElement, writes };
}

const at = (diam: number) => ({ focusScreenX: 100, focusScreenY: 50, focusOnScreen: true, focusScreenDiam: diam });
const LEAVE = FAR_ICON.solidPx * FAR_ICON.hysteresis;

describe('world tag compact switch (S10)', () => {
  it('goes compact below solidPx and back only above solidPx × hysteresis; writes on change only', () => {
    const { el, writes } = tagEl();
    setWorldTagAnchor('focus', 'p1');
    setWorldTagElement(el);
    updateWorldTag(at(40), 800, 400);
    expect(writes).toEqual(['data-compact=0']); // first shown frame syncs the DOM
    expect(worldTagCompact()).toBe(false);
    updateWorldTag(at(FAR_ICON.solidPx + 0.5), 800, 400);
    expect(writes.length).toBe(1); // inside the band: no change
    updateWorldTag(at(FAR_ICON.solidPx - 0.5), 800, 400);
    expect(writes).toEqual(['data-compact=0', 'data-compact=1']);
    expect(worldTagCompact()).toBe(true);
    // Hysteresis: back between solidPx and the leave size stays compact.
    updateWorldTag(at(LEAVE - 0.5), 800, 400);
    updateWorldTag(at(LEAVE - 0.5), 800, 400);
    expect(writes.length).toBe(2);
    updateWorldTag(at(LEAVE + 0.5), 800, 400);
    expect(writes).toEqual(['data-compact=0', 'data-compact=1', 'data-compact=0']);
    expect(worldTagCompact()).toBe(false);
    setWorldTagElement(null);
  });

  it('a hidden tag does not run the rule (no focus diameter 0 latches compact)', () => {
    const { el, writes } = tagEl();
    setWorldTagAnchor('focus', null);
    setWorldTagElement(el);
    updateWorldTag({ focusScreenX: NaN, focusScreenY: NaN, focusOnScreen: false, focusScreenDiam: 0 }, 800, 400);
    expect(writes).toEqual([]);
    expect(worldTagCompact()).toBe(false);
    setWorldTagElement(null);
  });
});

describe('worldTagCompactDiam', () => {
  const fb = { focusScreenX: 0, focusScreenY: 0, focusOnScreen: true, focusScreenDiam: 12, viewHalf: 4000 };

  it('a single tag and a group with a focused member judge the focus diameter', () => {
    expect(worldTagCompactDiam(fb, 'focus', 'p1', 0, 800, 400)).toBe(12);
    expect(worldTagCompactDiam(fb, 'centroid', 's1', 50, 800, 400)).toBe(12);
  });

  it('a group with no focus judges its biggest hull at the camera zoom', () => {
    // 800 px across the larger side shows 2 × 4000 u ⇒ 0.1 px/u; radius 50 ⇒ 10 px.
    expect(worldTagCompactDiam(fb, 'centroid', null, 50, 800, 400)).toBeCloseTo(10);
    expect(worldTagCompactDiam({ ...fb, viewHalf: 0 }, 'centroid', null, 50, 800, 400)).toBeNaN();
    expect(worldTagCompactDiam(fb, 'centroid', null, 0, 800, 400)).toBeNaN();
  });
});
