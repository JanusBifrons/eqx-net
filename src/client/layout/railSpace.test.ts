/**
 * UI language U1-1: the layout knows about the right rail (`--rail-w`, 0px
 * until U1-5 mounts it), and the z tiers follow plan B2.
 */
import { describe, expect, it } from 'vitest';
import { ANCHOR_NAMES, ANCHOR_STYLES, SAFE_RIGHT } from './anchors.js';
import { Z } from './zIndex.js';
import { RAIL_W_CSS, parseRailWidth, railWidthPx } from './railWidth.js';

describe('rail space anchors', () => {
  it('SAFE_RIGHT sits in by the rail width', () => {
    expect(RAIL_W_CSS).toBe('var(--rail-w, 0px)');
    expect(SAFE_RIGHT).toContain('var(--rail-w');
    expect(ANCHOR_STYLES['top-right'].right).toBe(SAFE_RIGHT);
    expect(ANCHOR_STYLES['middle-right'].right).toBe(SAFE_RIGHT);
    expect(String(ANCHOR_STYLES['bottom-right'].right)).toContain('var(--rail-w');
  });

  it('right-rail and left-strip anchors exist', () => {
    expect(ANCHOR_NAMES).toContain('right-rail');
    expect(ANCHOR_NAMES).toContain('left-strip');
  });

  it('right-rail is flush right, full height below the safe top, --rail-w wide', () => {
    const r = ANCHOR_STYLES['right-rail'];
    expect(r.position).toBe('fixed');
    expect(r.width).toBe(RAIL_W_CSS);
    expect(r.right).toBe('env(safe-area-inset-right, 0px)');
    expect(String(r.top)).toContain('safe-area-inset-top');
    expect(r.bottom).toBeDefined();
    expect(r.zIndex).toBe(Z.railStrip);
  });

  it('left-strip hugs the left edge, clear of the top-left corner', () => {
    const s = ANCHOR_STYLES['left-strip'];
    expect(s.position).toBe('fixed');
    expect(String(s.left)).toContain('safe-area-inset-left');
    // Centred at 57% while it fits, never above the top-left HUD (leftStripFit.ts).
    expect(String(s.top)).toContain('57%');
    expect(String(s.top)).toContain('--hud-tl-bottom');
    expect(String(s.top)).toContain('--left-strip-h');
    expect(s.zIndex).toBe(Z.railStrip);
  });
});

describe('z tiers (plan B2)', () => {
  it('full order, lowest to highest', () => {
    const order = (Object.keys(Z) as (keyof typeof Z)[]).sort((a, b) => Z[a] - Z[b]);
    expect(order).toEqual([
      'canvas', 'hud', 'mobileControls', 'hudOverSticks', 'panel', 'railStrip', 'drawer', 'appBar',
      'overlay', 'modal', 'prompt', 'transit', 'rotatePrompt',
    ]);
    expect(new Set(Object.values(Z)).size).toBe(Object.keys(Z).length);
  });
});

describe('railWidthPx', () => {
  it('parses the custom property; junk and empty read 0', () => {
    expect(parseRailWidth('48px')).toBe(48);
    expect(parseRailWidth(' 56px')).toBe(56);
    expect(parseRailWidth('0px')).toBe(0);
    expect(parseRailWidth('')).toBe(0);
    expect(parseRailWidth('auto')).toBe(0);
  });

  it('is 0 with no DOM (render worker, node)', () => {
    expect(railWidthPx()).toBe(0);
  });
});
