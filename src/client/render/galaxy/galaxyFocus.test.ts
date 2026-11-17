import { describe, expect, it } from 'vitest';
import {
  APP_BAR_H, DOOR_RING, DOOR_SIZE, FOCUS_IDLE, FOCUS_MAX_SCALE, PANEL_RIGHT_W, SHEET_MAX_H,
  doorAt, focusFrame, focusPanelDock, focusPanelInsets, focusStep, focusTapResult, layoutDoors,
  type FocusState,
} from './galaxyFocus';

const view = { scale: 0.5, cx: 10, cy: 20 };

describe('focusPanelDock / focusPanelInsets', () => {
  it('desktop landscape docks right; a phone or portrait gets a bottom sheet', () => {
    expect(focusPanelDock(false, false)).toBe('right');
    expect(focusPanelDock(false, true)).toBe('bottom');
    expect(focusPanelDock(true, false)).toBe('bottom');
  });

  it('insets match the panel the drawer draws', () => {
    expect(focusPanelInsets('right', 1440, 900)).toEqual({ top: APP_BAR_H, right: PANEL_RIGHT_W, bottom: 0 });
    // Phone sideways: half the short height.
    expect(focusPanelInsets('bottom', 915, 412)).toEqual({ top: APP_BAR_H, right: 0, bottom: 206 });
    // Portrait: 40 %, capped.
    expect(focusPanelInsets('bottom', 412, 915)).toEqual({ top: APP_BAR_H, right: 0, bottom: SHEET_MAX_H });
  });
});

describe('layoutDoors / doorAt', () => {
  it('puts one door per neighbour on the ring, towards that neighbour', () => {
    const doors = layoutDoors(0, 0, 10, [{ key: 'e', x: 100, y: 0 }, { key: 'w', x: -100, y: 0 }]);
    expect(doors.map((d) => d.key).sort()).toEqual(['e', 'w']);
    const e = doors.find((d) => d.key === 'e')!;
    expect(e.x).toBeCloseTo(10 * DOOR_RING, 6);
    expect(e.y).toBeCloseTo(0, 6);
  });

  it('spreads neighbours that sit in nearly the same direction so doors never overlap', () => {
    const doors = layoutDoors(0, 0, 10, [
      { key: 'a', x: 100, y: 0 }, { key: 'b', x: 100, y: 1 }, { key: 'c', x: 100, y: -1 },
    ]);
    const r = 10 * DOOR_SIZE;
    for (let i = 0; i < doors.length; i++) {
      for (let j = i + 1; j < doors.length; j++) {
        expect(Math.hypot(doors[i]!.x - doors[j]!.x, doors[i]!.y - doors[j]!.y)).toBeGreaterThanOrEqual(2 * r);
      }
    }
  });

  it('finds the door under a point', () => {
    const doors = layoutDoors(0, 0, 10, [{ key: 'e', x: 100, y: 0 }]);
    expect(doorAt(doors, 10 * DOOR_RING, 1, 10 * DOOR_SIZE)).toBe('e');
    expect(doorAt(doors, 0, 0, 10 * DOOR_SIZE)).toBeNull();
  });
});

describe('focusFrame', () => {
  it('centres the hex in the free area left of a right panel', () => {
    const insets = { top: 0, right: 200, bottom: 0 };
    const f = focusFrame(0, 0, 10, [], 1000, 600, insets);
    // Screen x of the hex = W/2 + (0 - cx) * scale = centre of the free 800 px.
    expect(500 + (0 - f.cx) * f.scale).toBeCloseTo(400, 6);
    expect(300 + (0 - f.cy) * f.scale).toBeCloseTo(300, 6);
  });

  it('centres the hex above a bottom sheet, below the app bar', () => {
    const insets = { top: 48, right: 0, bottom: 200 };
    const f = focusFrame(50, 50, 10, [], 900, 600, insets);
    expect(300 + (50 - f.cy) * f.scale).toBeCloseTo(48 + (600 - 248) / 2, 6);
  });

  it('fits the doors and never zooms past the camera range', () => {
    const doors = layoutDoors(0, 0, 64, [{ key: 'e', x: 500, y: 0 }]);
    const bare = focusFrame(0, 0, 64, [], 700, 500, { top: 48, right: 296, bottom: 0 });
    const withDoor = focusFrame(0, 0, 64, doors, 700, 500, { top: 48, right: 296, bottom: 0 });
    expect(withDoor.scale).toBeLessThan(bare.scale);
    expect(focusFrame(0, 0, 1, [], 1440, 900, { top: 0, right: 0, bottom: 0 }).scale).toBe(FOCUS_MAX_SCALE);
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

describe('focusTapResult', () => {
  it('plain map: a hex selects, empty space deselects', () => {
    expect(focusTapResult(null, null, 'a')).toEqual({ kind: 'select', key: 'a' });
    expect(focusTapResult(null, null, null)).toEqual({ kind: 'deselect' });
  });

  it('in focus: a door hops, the focused hex does nothing, anything else backs out', () => {
    expect(focusTapResult('a', 'b', null)).toEqual({ kind: 'select', key: 'b' });
    expect(focusTapResult('a', null, 'a')).toEqual({ kind: 'none' });
    expect(focusTapResult('a', null, 'c')).toEqual({ kind: 'deselect' });
    expect(focusTapResult('a', null, null)).toEqual({ kind: 'deselect' });
  });
});
