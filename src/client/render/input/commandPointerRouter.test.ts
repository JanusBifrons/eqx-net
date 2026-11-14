import { describe, it, expect } from 'vitest';
import {
  CommandPointerRouter,
  HOLD_THRESHOLD_MS,
  type RouterPointerEvent,
} from './commandPointerRouter.js';

function ev(
  type: RouterPointerEvent['type'],
  x: number,
  y: number,
  timeMs: number,
  o: Partial<RouterPointerEvent> = {},
): RouterPointerEvent {
  return {
    type, x, y, timeMs, pointerId: 1, button: 0, buttons: 1,
    shiftKey: false, pointerType: 'mouse', ...o,
  };
}
const kinds = (a: { kind: string }[]): string[] => a.map((x) => x.kind);

describe('CommandPointerRouter — mouse', () => {
  it('left quick click = tapSelect, no camera', () => {
    const r = new CommandPointerRouter();
    expect(r.handle(ev('pointerdown', 10, 10, 0))).toEqual([]);
    expect(r.handle(ev('pointermove', 12, 11, 20))).toEqual([]);
    expect(r.handle(ev('pointerup', 12, 11, 50))).toEqual([
      { kind: 'tapSelect', x: 12, y: 11, additive: false },
    ]);
  });

  it('left slow stationary click is not a tap', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 10, 10, 0));
    expect(r.handle(ev('pointerup', 10, 10, 400))).toEqual([]);
  });

  it('shift-click is additive', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 10, 10, 0, { shiftKey: true }));
    expect(r.handle(ev('pointerup', 10, 10, 50, { shiftKey: true }))).toEqual([
      { kind: 'tapSelect', x: 10, y: 10, additive: true },
    ]);
  });

  it('left drag >= 6 px = box start/update/end, never camera', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 0, 0, 0));
    expect(r.handle(ev('pointermove', 3, 0, 10))).toEqual([]);
    expect(r.handle(ev('pointermove', 10, 5, 20))).toEqual([
      { kind: 'boxStart', x0: 0, y0: 0, x1: 10, y1: 5 },
    ]);
    expect(r.handle(ev('pointermove', 50, 40, 30))).toEqual([
      { kind: 'boxUpdate', x0: 0, y0: 0, x1: 50, y1: 40 },
    ]);
    expect(r.handle(ev('pointerup', 60, 45, 900))).toEqual([
      { kind: 'boxEnd', x0: 0, y0: 0, x1: 60, y1: 45, additive: false },
    ]);
  });

  it('shift box is additive', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 0, 0, 0, { shiftKey: true }));
    r.handle(ev('pointermove', 20, 20, 10, { shiftKey: true }));
    const out = r.handle(ev('pointerup', 20, 20, 20, { shiftKey: true }));
    expect(out).toEqual([{ kind: 'boxEnd', x0: 0, y0: 0, x1: 20, y1: 20, additive: true }]);
  });

  it('box then cancel = boxCancel', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 0, 0, 0));
    r.handle(ev('pointermove', 20, 20, 10));
    expect(r.handle(ev('pointercancel', 20, 20, 20))).toEqual([{ kind: 'boxCancel' }]);
  });

  it('right click without moving = order on release', () => {
    const r = new CommandPointerRouter();
    expect(r.handle(ev('pointerdown', 5, 5, 0, { button: 2, buttons: 2 }))).toEqual([]);
    expect(r.handle(ev('pointerup', 7, 6, 900, { button: 2, buttons: 0 }))).toEqual([
      { kind: 'order', x: 7, y: 6 },
    ]);
  });

  it('right drag >= 6 px is ignored, even if it comes back', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 5, 5, 0, { button: 2 }));
    expect(r.handle(ev('pointermove', 30, 5, 10, { button: 2 }))).toEqual([]);
    expect(r.handle(ev('pointerup', 5, 5, 20, { button: 2 }))).toEqual([]);
  });

  it('middle drag passes through to camera', () => {
    const r = new CommandPointerRouter();
    const d = ev('pointerdown', 0, 0, 0, { button: 1, buttons: 4 });
    const m = ev('pointermove', 40, 0, 10, { button: -1, buttons: 4 });
    const u = ev('pointerup', 40, 0, 20, { button: 1, buttons: 0 });
    expect(r.handle(d)).toEqual([{ kind: 'camera', ev: d }]);
    expect(r.handle(m)).toEqual([{ kind: 'camera', ev: m }]);
    expect(r.handle(u)).toEqual([{ kind: 'camera', ev: u }]);
    // next left click works normally again
    r.handle(ev('pointerdown', 1, 1, 100));
    expect(kinds(r.handle(ev('pointerup', 1, 1, 120)))).toEqual(['tapSelect']);
  });

  it('hover moves pass through to camera', () => {
    const r = new CommandPointerRouter();
    const m = ev('pointermove', 3, 3, 0, { buttons: 0 });
    expect(r.handle(m)).toEqual([{ kind: 'camera', ev: m }]);
  });
});

describe('CommandPointerRouter — touch', () => {
  const t = (type: RouterPointerEvent['type'], x: number, y: number, ms: number, id = 1) =>
    ev(type, x, y, ms, { pointerType: 'touch', pointerId: id });

  it('quick tap = tapSelect', () => {
    const r = new CommandPointerRouter();
    expect(r.handle(t('pointerdown', 10, 10, 0))).toEqual([]);
    expect(r.handle(t('pointerup', 11, 10, 100))).toEqual([
      { kind: 'tapSelect', x: 11, y: 10, additive: false },
    ]);
  });

  it('early drag = camera pan for the rest of the gesture (deferred down replayed)', () => {
    const r = new CommandPointerRouter();
    const d = t('pointerdown', 0, 0, 0);
    r.handle(d);
    const m1 = t('pointermove', 20, 0, 50);
    expect(r.handle(m1)).toEqual([{ kind: 'camera', ev: d }, { kind: 'camera', ev: m1 }]);
    // still camera even after the hold time elapses
    const m2 = t('pointermove', 40, 0, HOLD_THRESHOLD_MS + 100);
    expect(r.handle(m2)).toEqual([{ kind: 'camera', ev: m2 }]);
    const u = t('pointerup', 40, 0, HOLD_THRESHOLD_MS + 200);
    expect(r.handle(u)).toEqual([{ kind: 'camera', ev: u }]);
  });

  it('hold >= 500 ms then drag = box', () => {
    const r = new CommandPointerRouter();
    r.handle(t('pointerdown', 0, 0, 0));
    expect(r.handle(t('pointermove', 2, 0, 300))).toEqual([]); // jitter
    expect(r.handle(t('pointermove', 30, 30, HOLD_THRESHOLD_MS))).toEqual([
      { kind: 'boxStart', x0: 0, y0: 0, x1: 30, y1: 30 },
    ]);
    expect(kinds(r.handle(t('pointermove', 50, 50, 700)))).toEqual(['boxUpdate']);
    expect(r.handle(t('pointerup', 50, 50, 800))).toEqual([
      { kind: 'boxEnd', x0: 0, y0: 0, x1: 50, y1: 50, additive: false },
    ]);
  });

  it('long press without moving does nothing', () => {
    const r = new CommandPointerRouter();
    r.handle(t('pointerdown', 0, 0, 0));
    expect(r.handle(t('pointerup', 0, 0, 900))).toEqual([]);
  });

  it('second pointer during a box cancels it and pinches the camera', () => {
    const r = new CommandPointerRouter();
    r.handle(t('pointerdown', 0, 0, 0));
    r.handle(t('pointermove', 30, 30, 600));
    const d2 = t('pointerdown', 100, 100, 650, 2);
    expect(r.handle(d2)).toEqual([{ kind: 'boxCancel' }, { kind: 'camera', ev: d2 }]);
    const m2 = t('pointermove', 120, 120, 660, 2);
    expect(r.handle(m2)).toEqual([{ kind: 'camera', ev: m2 }]);
    // primary pointer was never handed to the camera: its events are dropped
    expect(r.handle(t('pointermove', 35, 35, 670))).toEqual([]);
    expect(r.handle(t('pointerup', 35, 35, 680))).toEqual([]);
    const u2 = t('pointerup', 120, 120, 690, 2);
    expect(r.handle(u2)).toEqual([{ kind: 'camera', ev: u2 }]);
    // back to idle: a fresh tap selects
    r.handle(t('pointerdown', 5, 5, 1000));
    expect(kinds(r.handle(t('pointerup', 5, 5, 1050)))).toEqual(['tapSelect']);
  });

  it('second pointer before intent replays first down and pinches', () => {
    const r = new CommandPointerRouter();
    const d1 = t('pointerdown', 0, 0, 0);
    r.handle(d1);
    const d2 = t('pointerdown', 100, 0, 30, 2);
    expect(r.handle(d2)).toEqual([{ kind: 'camera', ev: d1 }, { kind: 'camera', ev: d2 }]);
    const m1 = t('pointermove', 1, 0, 40);
    expect(r.handle(m1)).toEqual([{ kind: 'camera', ev: m1 }]);
    const u1 = t('pointerup', 1, 0, 50);
    expect(r.handle(u1)).toEqual([{ kind: 'camera', ev: u1 }]); // no tapSelect
  });
});

describe('CommandPointerRouter — enabled flag', () => {
  it('disabled passes every event through unchanged', () => {
    const r = new CommandPointerRouter(false);
    const seq = [
      ev('pointerdown', 0, 0, 0),
      ev('pointermove', 50, 0, 10),
      ev('pointerup', 50, 0, 20),
      ev('pointerdown', 0, 0, 30, { button: 2 }),
      ev('pointerup', 0, 0, 40, { button: 2 }),
    ];
    for (const e of seq) expect(r.handle(e)).toEqual([{ kind: 'camera', ev: e }]);
  });

  it('disabling mid-box emits boxCancel and resets', () => {
    const r = new CommandPointerRouter();
    r.handle(ev('pointerdown', 0, 0, 0));
    r.handle(ev('pointermove', 20, 20, 10));
    expect(r.setEnabled(false)).toEqual([{ kind: 'boxCancel' }]);
    expect(r.enabled).toBe(false);
    expect(r.setEnabled(true)).toEqual([]);
    r.handle(ev('pointerdown', 0, 0, 100));
    expect(kinds(r.handle(ev('pointerup', 0, 0, 120)))).toEqual(['tapSelect']);
  });
});
