import { describe, expect, it } from 'vitest';
import {
  APP_BAR_H, ARROW_HALF, FOCUS_IDLE, FOCUS_MAX_SCALE, PANEL_RIGHT_W, PANEL_TOUCH_MIN_W, SHEET_MAX_H,
  focusFrame, focusHidesHover, focusPanelDock, focusPanelInsets, focusPanelWidth, focusStep, focusTapResult, hopArrow,
  type FocusState,
} from './galaxyFocus';

const view = { scale: 0.5, cx: 10, cy: 20 };

describe('focusPanelDock / focusPanelInsets', () => {
  it('any landscape screen docks right (desktop or a sideways phone); upright gets a bottom sheet', () => {
    expect(focusPanelDock(false)).toBe('right');
    expect(focusPanelDock(true)).toBe('bottom');
  });

  it('a phone panel is narrower than the desktop one, never below the floor', () => {
    expect(focusPanelWidth(1440, false)).toBe(PANEL_RIGHT_W);
    expect(focusPanelWidth(915, true)).toBe(275);
    expect(focusPanelWidth(500, true)).toBe(PANEL_TOUCH_MIN_W);
    expect(focusPanelWidth(2000, true)).toBe(PANEL_RIGHT_W);
  });

  it('insets match the panel the drawer draws', () => {
    expect(focusPanelInsets('right', 1440, 900, false)).toEqual({ top: APP_BAR_H, right: PANEL_RIGHT_W, bottom: 0 });
    // Sideways phone: no app bar, so the hex keeps the full height.
    expect(focusPanelInsets('right', 915, 412, true)).toEqual({ top: 0, right: 275, bottom: 0 });
    // Upright: 40 %, capped.
    expect(focusPanelInsets('bottom', 412, 915, true)).toEqual({ top: 0, right: 0, bottom: SHEET_MAX_H });
  });
});

describe('hopArrow', () => {
  const R = 64;
  const S3 = Math.sqrt(3);
  // The six neighbour directions of a pointy-top hex.
  const dirs = [0, 1, 2, 3, 4, 5].map((i) => ({ x: Math.cos((i * Math.PI) / 3) * S3 * R, y: Math.sin((i * Math.PI) / 3) * S3 * R }));

  it('points from the focused hex into the neighbour, on their shared edge', () => {
    for (const n of dirs) {
      const t = hopArrow(0, 0, n.x, n.y, R);
      const d = (i: number) => Math.hypot(t[i]!, t[i + 1]!);
      // Tip further out than the base, both near the shared edge (sqrt(3)/2 R).
      expect(d(0)).toBeGreaterThan(d(2));
      expect(Math.abs(d(2) - (S3 / 2) * R)).toBeLessThan(0.05 * R);
      // Tip is in the neighbour's direction.
      expect((t[0]! * n.x + t[1]! * n.y) / (Math.hypot(t[0]!, t[1]!) * Math.hypot(n.x, n.y))).toBeCloseTo(1, 6);
    }
  });

  it('never reaches the neighbour name (upper-centre of its hex)', () => {
    // The map label box: at most 0.7 R either side, from 0.4 R above the centre to just below it.
    for (const n of dirs) {
      const t = hopArrow(0, 0, n.x, n.y, R);
      for (let i = 0; i < t.length; i += 2) {
        const lx = t[i]! - n.x;
        const ly = t[i + 1]! - n.y;
        const inLabel = Math.abs(lx) <= 0.7 * R && ly >= -0.4 * R && ly <= 0.03 * R;
        expect(inLabel).toBe(false);
      }
      expect(Math.hypot(t[2]! - t[4]!, t[3]! - t[5]!)).toBeCloseTo(2 * ARROW_HALF * R, 6);
    }
  });
});

describe('focusFrame', () => {
  it('centres the hex in the free area left of a right panel', () => {
    const insets = { top: 0, right: 200, bottom: 0 };
    const f = focusFrame(0, 0, 10, 1000, 600, insets);
    // Screen x of the hex = W/2 + (0 - cx) * scale = centre of the free 800 px.
    expect(500 + (0 - f.cx) * f.scale).toBeCloseTo(400, 6);
    expect(300 + (0 - f.cy) * f.scale).toBeCloseTo(300, 6);
  });

  it('centres the hex above a bottom sheet, below the app bar', () => {
    const insets = { top: 48, right: 0, bottom: 200 };
    const f = focusFrame(50, 50, 10, 900, 600, insets);
    expect(300 + (50 - f.cy) * f.scale).toBeCloseTo(48 + (600 - 248) / 2, 6);
  });

  it('a sideways phone: the hex takes nearly the full height beside the panel', () => {
    const insets = focusPanelInsets('right', 915, 412, true);
    const f = focusFrame(0, 0, 64, 915, 412, insets);
    expect(2 * 64 * f.scale).toBeGreaterThan(0.9 * 412);
    expect(457.5 + (0 - f.cx) * f.scale).toBeCloseTo((915 - insets.right) / 2, 6);
  });

  it('never zooms past the camera range', () => {
    expect(focusFrame(0, 0, 1, 1440, 900, { top: 0, right: 0, bottom: 0 }).scale).toBe(FOCUS_MAX_SCALE);
  });
});

describe('focusStep', () => {
  it('open from the map glides in and remembers the view to return to', () => {
    const r = focusStep(FOCUS_IDLE, { type: 'open', key: 'a', view });
    expect(r).toEqual({ state: { phase: 'in', key: 'a', home: view }, glide: 'to-key' });
  });

  it('arrives, hops keeping the original home, and backs out to it', () => {
    let s: FocusState = focusStep(FOCUS_IDLE, { type: 'open', key: 'a', view }).state;
    s = focusStep(s, { type: 'arrived' }).state;
    expect(s.phase).toBe('focused');
    const hop = focusStep(s, { type: 'open', key: 'b', view: { scale: 3, cx: 0, cy: 0 } });
    expect(hop.glide).toBe('to-key');
    expect(hop.state.home).toBe(view);
    const out = focusStep(hop.state, { type: 'close' });
    expect(out).toEqual({ state: { phase: 'out', key: null, home: view }, glide: 'home' });
    expect(focusStep(out.state, { type: 'arrived' }).state).toBe(FOCUS_IDLE);
  });

  it('re-opening the focused sector does nothing', () => {
    const s = focusStep(FOCUS_IDLE, { type: 'open', key: 'a', view }).state;
    expect(focusStep(s, { type: 'open', key: 'a', view }).glide).toBeNull();
  });

  it('re-opening while backing out keeps the first home', () => {
    let s = focusStep(FOCUS_IDLE, { type: 'open', key: 'a', view }).state;
    s = focusStep(s, { type: 'close' }).state;
    const r = focusStep(s, { type: 'open', key: 'c', view: { scale: 1, cx: 5, cy: 5 } });
    expect(r.state).toEqual({ phase: 'in', key: 'c', home: view });
  });

  it('a grab mid-glide settles the phase; close while idle is a no-op', () => {
    const s = focusStep(FOCUS_IDLE, { type: 'open', key: 'a', view }).state;
    expect(focusStep(s, { type: 'interrupt' }).state.phase).toBe('focused');
    expect(focusStep(FOCUS_IDLE, { type: 'close' })).toEqual({ state: FOCUS_IDLE, glide: null });
  });
});

describe('focusTapResult / focusHidesHover', () => {
  it('plain map: a hex selects, empty space deselects', () => {
    expect(focusTapResult(null, [], 'a')).toEqual({ kind: 'select', key: 'a' });
    expect(focusTapResult(null, [], null)).toEqual({ kind: 'deselect' });
  });

  it('in focus: a lit neighbour hops, the focused hex does nothing, anything else backs out', () => {
    expect(focusTapResult('a', ['b', 'c'], 'b')).toEqual({ kind: 'select', key: 'b' });
    expect(focusTapResult('a', ['b'], 'a')).toEqual({ kind: 'none' });
    expect(focusTapResult('a', ['b'], 'z')).toEqual({ kind: 'deselect' });
    expect(focusTapResult('a', ['b'], null)).toEqual({ kind: 'deselect' });
  });

  it('no hover tooltip while gliding or over the focused hex; neighbours keep theirs', () => {
    expect(focusHidesHover('in', 'a', 'b')).toBe(true);
    expect(focusHidesHover('out', null, 'b')).toBe(true);
    expect(focusHidesHover('focused', 'a', 'a')).toBe(true);
    expect(focusHidesHover('focused', 'a', 'b')).toBe(false);
    expect(focusHidesHover('idle', null, 'a')).toBe(false);
  });
});
