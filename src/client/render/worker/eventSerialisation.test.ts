/**
 * Lock: pointer/wheel serialisers forward coordinates in CSS (logical)
 * pixels with NO devicePixelRatio scaling.
 *
 * This is load-bearing for the worker camera frame (plan: zazzy-engelbart,
 * Phase 1): BOOT/RESIZE send CSS px and the Camera's `setScreenSize` is CSS
 * px, so the forwarded pointer/wheel `offset*` must also be CSS px or the
 * zoom/pinch pivot drifts by the DPR factor on high-DPR devices. A prior
 * version multiplied by `window.devicePixelRatio`; this test fails if that
 * multiply is ever reintroduced.
 *
 * The serialisers are pure field-copies (no `window` access), so a plain
 * object cast to the DOM event type exercises them under node env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serialisePointerEvent, serialiseWheelEvent } from './eventSerialisation.js';

// Force a non-1 DPR so a stray `* dpr` would visibly change the output.
const g = globalThis as unknown as { window?: { devicePixelRatio?: number } };
let hadWindow = false;
let prevDpr: number | undefined;

beforeEach(() => {
  hadWindow = 'window' in g && g.window !== undefined;
  if (!hadWindow) g.window = { devicePixelRatio: 3 };
  else {
    prevDpr = g.window!.devicePixelRatio;
    g.window!.devicePixelRatio = 3;
  }
});

afterEach(() => {
  if (!hadWindow) delete g.window;
  else g.window!.devicePixelRatio = prevDpr;
});

const pointer = {
  type: 'pointerdown',
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  buttons: 1,
  clientX: 100,
  clientY: 200,
  offsetX: 80,
  offsetY: 180,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isPrimary: true,
  pressure: 0.5,
  width: 1,
  height: 1,
  twist: 0,
  tiltX: 0,
  tiltY: 0,
} as unknown as PointerEvent;

const wheel = {
  deltaX: 0,
  deltaY: 100,
  deltaZ: 0,
  deltaMode: 0,
  clientX: 100,
  clientY: 200,
  offsetX: 80,
  offsetY: 180,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
} as unknown as WheelEvent;

describe('eventSerialisation — CSS-px coordinate frame (no DPR scaling)', () => {
  it('serialisePointerEvent passes offset/client coords through unscaled', () => {
    const s = serialisePointerEvent(pointer);
    expect(s.offsetX).toBe(80);
    expect(s.offsetY).toBe(180);
    expect(s.clientX).toBe(100);
    expect(s.clientY).toBe(200);
  });

  it('serialiseWheelEvent passes offset/client coords through unscaled', () => {
    const s = serialiseWheelEvent(wheel);
    expect(s.offsetX).toBe(80);
    expect(s.offsetY).toBe(180);
    expect(s.clientX).toBe(100);
    expect(s.clientY).toBe(200);
    expect(s.deltaY).toBe(100);
  });
});
