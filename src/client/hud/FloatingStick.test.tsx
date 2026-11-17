/**
 * Two thumbs landing together on the touch sticks are a pinch, not two
 * sticks: neither stick drives, and both fingers go to the world canvas so
 * the camera's own pinch-zoom handles them. A thumb that joins later (fly,
 * THEN lock) still drives its stick as before.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingStick } from './FloatingStick';
import { PINCH_WINDOW_MS, resetStickPinch } from './stickPinch';

let now = 1000;

function down(el: Element, pointerId: number, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
function move(el: Element, pointerId: number, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
function up(el: Element, pointerId: number, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

function setup(): {
  left: Element;
  right: Element;
  canvasEvents: string[];
  leftMove: ReturnType<typeof vi.fn>;
  leftEnd: ReturnType<typeof vi.fn>;
  rightMove: ReturnType<typeof vi.fn>;
  rightEnd: ReturnType<typeof vi.fn>;
} {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const canvasEvents: string[] = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    canvas.addEventListener(t, (e) => canvasEvents.push(`${t}:${(e as PointerEvent).pointerId}`));
  }
  const leftMove = vi.fn();
  const leftEnd = vi.fn();
  const rightMove = vi.fn();
  const rightEnd = vi.fn();
  const r = render(
    <>
      <FloatingStick id="l" zone={{ left: 0 }} home={{ left: 10, bottom: 10 }} color="#fff" onMove={leftMove} onEnd={leftEnd} />
      <FloatingStick id="r" zone={{ right: 0 }} home={{ right: 10, bottom: 10 }} color="#fff" onMove={rightMove} onEnd={rightEnd} />
    </>,
  );
  return {
    left: r.getByTestId('l-zone'),
    right: r.getByTestId('r-zone'),
    canvasEvents,
    leftMove,
    leftEnd,
    rightMove,
    rightEnd,
  };
}

describe('FloatingStick two-finger pinch', () => {
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    resetStickPinch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('two thumbs placed together drive neither stick and reach the canvas as a pinch', () => {
    const s = setup();
    act(() => {
      down(s.left, 1, 100, 400);
      now += PINCH_WINDOW_MS - 20;
      down(s.right, 2, 700, 400);
    });
    // The first stick was switched off again (no tap), the second never started.
    expect(s.leftEnd).toHaveBeenCalledWith(false);
    s.leftMove.mockClear();
    act(() => {
      move(s.left, 1, 80, 400);
      move(s.right, 2, 720, 400);
    });
    expect(s.leftMove).not.toHaveBeenCalled();
    expect(s.rightMove).not.toHaveBeenCalled();
    expect(s.canvasEvents).toEqual(['pointerdown:1', 'pointerdown:2', 'pointermove:1', 'pointermove:2']);
    act(() => {
      up(s.left, 1, 80, 400);
      up(s.right, 2, 720, 400);
    });
    expect(s.canvasEvents.slice(-2)).toEqual(['pointerup:1', 'pointerup:2']);
    expect(s.rightEnd).not.toHaveBeenCalled();
  });

  it('two fingers placed together on the same side are a pinch too', () => {
    const s = setup();
    act(() => {
      down(s.left, 1, 100, 400);
      now += 30;
      down(s.left, 2, 200, 300);
      move(s.left, 2, 230, 280);
    });
    expect(s.leftEnd).toHaveBeenCalledWith(false);
    expect(s.canvasEvents).toEqual(['pointerdown:1', 'pointerdown:2', 'pointermove:2']);
  });

  it('a thumb that joins later still drives its own stick (fly, then lock)', () => {
    const s = setup();
    act(() => {
      down(s.left, 1, 100, 400);
      now += PINCH_WINDOW_MS + 200;
      down(s.right, 2, 700, 400);
      move(s.right, 2, 730, 400);
    });
    expect(s.leftEnd).not.toHaveBeenCalled();
    expect(s.rightMove).toHaveBeenCalled();
    expect(s.canvasEvents).toEqual([]);
  });

  it('after a pinch ends, a fresh single touch drives the stick again', () => {
    const s = setup();
    act(() => {
      down(s.left, 1, 100, 400);
      down(s.right, 2, 700, 400);
      up(s.left, 1, 100, 400);
      up(s.right, 2, 700, 400);
      now += 1000;
      down(s.left, 3, 100, 400);
    });
    s.leftMove.mockClear();
    act(() => move(s.left, 3, 130, 400));
    expect(s.leftMove).toHaveBeenCalled();
  });
});

/**
 * A quick tap in a thumb zone is a tap on the world, not a stick nudge: the
 * zones cover most of a phone screen, so a capital's "tap to set course" and
 * "tap a ship" must still reach the canvas there (showcase
 * player-capital-sector 2026-11-17: the course tap lit the lock stick instead).
 */
describe('FloatingStick tap passes through to the world', () => {
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    resetStickPinch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('a quick tap in a stick zone reaches the canvas as a tap at the touch point', () => {
    const s = setup();
    const seen: string[] = [];
    const canvas = document.querySelector('canvas')!;
    canvas.addEventListener('pointerup', (e) => seen.push(`${e.clientX},${e.clientY}`));
    act(() => {
      down(s.right, 1, 700, 300);
      now += 80;
      up(s.right, 1, 702, 301);
    });
    expect(s.canvasEvents).toEqual(['pointerdown:1', 'pointerup:1']);
    expect(seen).toEqual(['700,300']);
    expect(s.rightEnd).toHaveBeenCalledWith(true);
  });

  it('a drag drives the stick and never reaches the canvas', () => {
    const s = setup();
    act(() => {
      down(s.right, 1, 700, 300);
      move(s.right, 1, 740, 300);
      now += 80;
      up(s.right, 1, 740, 300);
    });
    expect(s.canvasEvents).toEqual([]);
    expect(s.rightEnd).toHaveBeenCalledWith(false);
  });

  it('a long press without moving is not a tap', () => {
    const s = setup();
    act(() => {
      down(s.left, 1, 100, 400);
      now += 600;
      up(s.left, 1, 100, 400);
    });
    expect(s.canvasEvents).toEqual([]);
  });
});

describe('FloatingStick dark backing (readable over bright rock)', () => {
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    resetStickPinch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('the backing is not faded with the resting ring and follows it everywhere', () => {
    const s = setup();
    const home = document.querySelector<HTMLElement>('[data-testid="l-home"]')!;
    const back = document.querySelector<HTMLElement>('[data-testid="l-backing"]')!;
    // At rest the ring fades; the backing under it does not, or bright rock washes it out.
    expect(Number(home.style.opacity)).toBeLessThan(1);
    expect(back.style.opacity).toBe('');
    expect(back.style.transform).toBe(home.style.transform);
    act(() => {
      down(s.left, 1, 200, 400);
      move(s.left, 1, 230, 400);
    });
    expect(back.style.transform).toBe(home.style.transform);
    act(() => {
      now += 500;
      up(s.left, 1, 230, 400);
    });
    expect(back.style.transform).toBe(home.style.transform);
  });
});
