// @vitest-environment jsdom
/**
 * Pinch fingers are forwarded to the world canvas on every move. Finding that
 * canvas with `document.elementsFromPoint` forces a layout, which on a phone's
 * main-thread renderer stuttered pinch-zoom: resolve it once per finger (at
 * its pointerdown) and reuse it until the finger lifts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardPinchPointer, forwardTapToWorld, resetStickPinch } from './stickPinch';

describe('stickPinch canvas lookup', () => {
  let canvas: HTMLCanvasElement;
  let events: string[];
  let elementsFromPoint: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStickPinch();
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    events = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      canvas.addEventListener(t, (e) => events.push(`${t}:${(e as PointerEvent).pointerId}`));
    }
    elementsFromPoint = vi.fn(() => [canvas]);
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = elementsFromPoint;
  });
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    document.body.innerHTML = '';
  });

  it('a two-finger pinch with many moves does one lookup per finger', () => {
    forwardPinchPointer('pointerdown', 1, 100, 400);
    forwardPinchPointer('pointerdown', 2, 700, 400);
    for (let i = 0; i < 60; i++) {
      forwardPinchPointer('pointermove', 1, 100 - i, 400);
      forwardPinchPointer('pointermove', 2, 700 + i, 400);
    }
    forwardPinchPointer('pointerup', 1, 40, 400);
    forwardPinchPointer('pointercancel', 2, 760, 400);
    expect(elementsFromPoint).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.startsWith('pointermove'))).toHaveLength(120);
    expect(events.slice(-2)).toEqual(['pointerup:1', 'pointercancel:2']);
  });

  it('a lifted finger forgets its canvas; the next press looks again', () => {
    forwardPinchPointer('pointerdown', 1, 100, 400);
    forwardPinchPointer('pointerup', 1, 100, 400);
    forwardPinchPointer('pointerdown', 1, 100, 400);
    forwardPinchPointer('pointermove', 1, 110, 400);
    expect(elementsFromPoint).toHaveBeenCalledTimes(2);
  });

  it('a tap through to the world looks up the canvas once', () => {
    forwardTapToWorld(5, 300, 300);
    expect(elementsFromPoint).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['pointerdown:5', 'pointerup:5']);
  });

  it('a canvas swapped out mid-pinch is looked up again', () => {
    forwardPinchPointer('pointerdown', 1, 100, 400);
    canvas.remove();
    const next = document.createElement('canvas');
    document.body.appendChild(next);
    const got: string[] = [];
    next.addEventListener('pointermove', () => got.push('move'));
    elementsFromPoint.mockImplementation(() => [next]);
    forwardPinchPointer('pointermove', 1, 110, 400);
    expect(got).toEqual(['move']);
    expect(elementsFromPoint).toHaveBeenCalledTimes(2);
  });
});
