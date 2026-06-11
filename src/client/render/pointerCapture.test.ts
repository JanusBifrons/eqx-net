/**
 * Pointer-capture helper (playtest 2026-06-10 Issue 9 — desktop build-drag).
 * Locks: pointerdown captures; pointerup/cancel release (only when held);
 * pointermove is inert; throws are swallowed (capture is best-effort).
 */
import { describe, it, expect, vi } from 'vitest';
import { setCanvasPointerCapture } from './pointerCapture.js';

function mockCanvas(opts: { has?: boolean; throwOnSet?: boolean } = {}) {
  return {
    setPointerCapture: vi.fn(() => {
      if (opts.throwOnSet) throw new Error('invalid pointer id');
    }),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => opts.has ?? true),
  };
}

describe('setCanvasPointerCapture', () => {
  it('captures the pointer on pointerdown', () => {
    const c = mockCanvas();
    setCanvasPointerCapture(c, 'pointerdown', 7);
    expect(c.setPointerCapture).toHaveBeenCalledWith(7);
    expect(c.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('releases the captured pointer on pointerup', () => {
    const c = mockCanvas({ has: true });
    setCanvasPointerCapture(c, 'pointerup', 7);
    expect(c.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('releases on pointercancel', () => {
    const c = mockCanvas({ has: true });
    setCanvasPointerCapture(c, 'pointercancel', 3);
    expect(c.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('does not release a pointer it never captured', () => {
    const c = mockCanvas({ has: false });
    setCanvasPointerCapture(c, 'pointerup', 7);
    expect(c.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('is inert on pointermove (capture persists across moves)', () => {
    const c = mockCanvas();
    setCanvasPointerCapture(c, 'pointermove', 7);
    expect(c.setPointerCapture).not.toHaveBeenCalled();
    expect(c.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('swallows a setPointerCapture throw (best-effort, never fatal)', () => {
    const c = mockCanvas({ throwOnSet: true });
    expect(() => setCanvasPointerCapture(c, 'pointerdown', 7)).not.toThrow();
  });
});
